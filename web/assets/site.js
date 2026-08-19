/* Shared site behavior: theme, code blocks, scrollspy, search.
 *
 * Everything here is progressive. A page renders and reads fine with this file
 * missing; what it adds is the copy button, the hide-comments toggle, the
 * highlighted tokens, the sidebar highlight, and the search dialog.
 *
 * Exposed as window.YoopSite for the per-page scripts (tour, pipeline, std) to
 * build the same widgets the static pages get.
 */
(function () {
  "use strict";

  const HL = window.YoopHL;

  /* ------------------------------------------------------------- helpers */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function icon(paths) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = paths;
    return svg;
  }

  async function copyText(text, button) {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "copied";
    } catch {
      // Clipboard access is denied on file:// in some browsers. Select the
      // text instead of pretending it worked.
      button.textContent = "press cmd+c";
      const range = document.createRange();
      const body = button.closest(".code")?.querySelector("code");
      if (body) {
        range.selectNodeContents(body);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1600);
  }

  /* ---------------------------------------------------------- code blocks */

  // Build the standard code figure: a header bar with the file name and the
  // tools, and a highlighted body. `source` is raw Yoop text.
  function codeBlock(source, options) {
    const opts = options || {};
    const lang = opts.lang || "yoop";
    const fig = el("figure", {
      class: "code" + (opts.scroll ? " code-scroll" : "") + (opts.tall ? " code-tall" : ""),
    });

    const tools = el("div", { class: "code-tools" });
    const head = el("div", { class: "code-head" }, [
      el("span", { class: "code-name", text: opts.name || "" }),
      tools,
    ]);

    const codeEl = el("code", { class: "language-" + lang });
    const body = el("div", { class: "code-body" }, [el("pre", null, [codeEl])]);

    let showComments = true;
    const paint = () => {
      const text = showComments || lang !== "yoop" ? source : HL.stripComments(source);
      if (!HL) codeEl.innerHTML = escapeText(text);
      else if (lang === "yoop") codeEl.innerHTML = HL.render(text);
      else if (lang === "llvm") codeEl.innerHTML = HL.renderLlvm(text);
      else codeEl.innerHTML = escapeText(text);
    };

    const hasComments = lang === "yoop" && /(^|\s)\/\//.test(source);
    if (hasComments && opts.commentToggle !== false) {
      const btn = el("button", {
        class: "code-tool",
        type: "button",
        "aria-pressed": "false",
        text: "hide comments",
      });
      btn.addEventListener("click", () => {
        showComments = !showComments;
        btn.setAttribute("aria-pressed", String(!showComments));
        btn.textContent = showComments ? "hide comments" : "show comments";
        paint();
      });
      tools.appendChild(btn);
    }

    if (opts.copy !== false) {
      const btn = el("button", { class: "code-tool", type: "button", text: "copy" });
      btn.addEventListener("click", () => copyText(showComments ? source : HL.stripComments(source), btn));
      tools.appendChild(btn);
    }

    for (const extra of opts.extraTools || []) tools.appendChild(extra);

    paint();
    if (opts.name || tools.children.length) fig.appendChild(head);
    fig.appendChild(body);
    return fig;
  }

  function escapeText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // A terminal pane: program output, a compiler diagnostic, a harness run.
  function termBlock(text, options) {
    const opts = options || {};
    const cls = ["term", opts.bad ? "term-bad" : "term-ok"].join(" ");
    const head = el("div", { class: "term-head" }, [
      el("span", { text: opts.label || "output" }),
    ]);
    if (typeof opts.exitCode === "number") {
      head.appendChild(
        el("span", {
          class: "exit-tag " + (opts.exitCode === 0 ? "exit-0" : "exit-n"),
          text: "exit " + opts.exitCode,
        }),
      );
    }
    return el("div", { class: cls }, [head, el("div", { class: "term-body", text: text })]);
  }

  // Upgrade the hand-written <pre><code class="yoop"> blocks in the static
  // pages to the same widget the generated pages build.
  function enhanceStaticCode(root) {
    const blocks = (root || document).querySelectorAll("pre > code.yoop, pre > code.language-yoop");
    blocks.forEach((codeEl) => {
      // Blocks this module built already have the widget around them; only
      // the hand-written ones in the page source need upgrading.
      if (codeEl.closest("figure.code")) return;
      const pre = codeEl.parentElement;
      const source = codeEl.textContent.replace(/\s+$/, "");
      const fig = codeBlock(source, {
        name: pre.dataset.file || codeEl.dataset.file || "",
        commentToggle: false,
        copy: pre.dataset.copy !== "false",
        scroll: pre.dataset.scroll === "true",
      });
      pre.replaceWith(fig);
    });

    // Plain (non-yoop) blocks still get highlighting-free treatment plus copy.
    (root || document).querySelectorAll("pre > code.shell, pre > code.text").forEach((codeEl) => {
      if (codeEl.closest("figure.code")) return;
      const pre = codeEl.parentElement;
      const fig = codeBlock(codeEl.textContent.replace(/\s+$/, ""), {
        lang: codeEl.classList.contains("shell") ? "shell" : "text",
        name: pre.dataset.file || "",
      });
      pre.replaceWith(fig);
    });
  }

  /* ---------------------------------------------------------------- theme */

  function initTheme() {
    const stored = localStorage.getItem("yoop-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
    const btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const current =
        document.documentElement.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
      const next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("yoop-theme", next);
    });
  }

  /* ------------------------------------------------------------ scrollspy */

  function initScrollspy() {
    const links = Array.from(document.querySelectorAll(".side a[href^='#']"));
    if (!links.length) return;
    const targets = links
      .map((a) => {
        const target = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
        return target ? { a, target } : null;
      })
      .filter(Boolean);
    if (!targets.length) return;

    const setActive = (a) => {
      links.forEach((other) => other.classList.toggle("active", other === a));
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const hit = targets.find((t) => t.target === visible.target);
        if (hit) setActive(hit.a);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );

    targets.forEach((t) => observer.observe(t.target));
  }

  /* --------------------------------------------------------------- search */

  function initSearch() {
    const trigger = document.querySelector(".search-trigger");
    if (!trigger) return;

    const input = el("input", {
      type: "search",
      class: "search-input",
      placeholder: "Search the language, the standard library, the tour",
      "aria-label": "Search",
      autocomplete: "off",
    });
    const results = el("ul", { class: "search-results" });
    const dialog = el("dialog", { class: "search-dialog" }, [
      el("div", { class: "search-box" }, [input, results]),
    ]);
    document.body.appendChild(dialog);

    const entries = () => {
      const data = window.YOOP_DATA || {};
      const out = [];
      for (const item of data.search?.entries || []) out.push(item);
      return out;
    };

    let items = [];
    let cursor = 0;

    const score = (entry, needle) => {
      const title = entry.title.toLowerCase();
      if (title === needle) return 0;
      if (title.startsWith(needle)) return 1;
      if (title.includes(needle)) return 2;
      if ((entry.text || "").toLowerCase().includes(needle)) return 4;
      return -1;
    };

    const paint = () => {
      const needle = input.value.trim().toLowerCase();
      results.innerHTML = "";
      if (!needle) {
        results.appendChild(
          el("li", { class: "search-empty", text: "Type to search. Esc closes." }),
        );
        items = [];
        return;
      }
      items = entries()
        .map((entry) => ({ entry, rank: score(entry, needle) }))
        .filter((r) => r.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.entry.title.length - b.entry.title.length)
        .slice(0, 24)
        .map((r) => r.entry);

      if (!items.length) {
        results.appendChild(el("li", { class: "search-empty", text: "Nothing matches that." }));
        return;
      }
      cursor = 0;
      items.forEach((entry, idx) => {
        const li = el("li", { class: "search-hit" + (idx === 0 ? " sel" : "") }, [
          el("a", { href: entry.href }, [
            el("span", { class: "search-hit-title", text: entry.title }),
            el("span", { class: "search-hit-where", text: entry.where }),
          ]),
        ]);
        results.appendChild(li);
      });
    };

    const move = (delta) => {
      const hits = results.querySelectorAll(".search-hit");
      if (!hits.length) return;
      cursor = (cursor + delta + hits.length) % hits.length;
      hits.forEach((li, idx) => li.classList.toggle("sel", idx === cursor));
      hits[cursor].scrollIntoView({ block: "nearest" });
    };

    const open = () => {
      input.value = "";
      paint();
      dialog.showModal();
      input.focus();
    };

    trigger.addEventListener("click", open);
    input.addEventListener("input", paint);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter") {
        const sel = results.querySelector(".search-hit.sel a");
        if (sel) {
          event.preventDefault();
          window.location.href = sel.getAttribute("href");
        }
      }
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dialog.open ? dialog.close() : open();
      } else if (event.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        event.preventDefault();
        open();
      }
    });
  }

  /* ----------------------------------------------------------------- init */

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(() => {
    initTheme();
    enhanceStaticCode(document);
    initScrollspy();
    initSearch();
  });

  window.YoopSite = { el, icon, codeBlock, termBlock, copyText, escapeText, enhanceStaticCode };
})();
