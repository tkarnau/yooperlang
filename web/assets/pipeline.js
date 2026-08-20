/* The pipeline explorer.
 *
 * Five stages over one program, with the source pane cross-linked to whatever
 * the current stage produced: hover a token and the characters it came from
 * light up, hover an AST node and the same thing happens with its span.
 *
 * The linking works because every dump in web/data/pipeline.data.js carries
 * byte offsets, and the syntax highlighter hands back tokens in source order,
 * so a span in the DOM knows exactly which byte range it covers.
 */
(function () {
  "use strict";

  const S = window.YoopSite;
  const HL = window.YoopHL;
  const data = (window.YOOP_DATA || {}).pipeline;
  if (!S) return;
  const { el, codeBlock, termBlock } = S;

  const STAGES = [
    { id: "source", label: "Source", sub: "what you wrote" },
    { id: "lex", label: "Lex", sub: "tagged spans" },
    { id: "parse", label: "Parse", sub: "a tree" },
    { id: "codegen", label: "Codegen", sub: "LLVM IR" },
    { id: "run", label: "Run", sub: "it prints" },
  ];

  const view = document.getElementById("stage-view");
  const rail = document.getElementById("stage-rail");
  const tabs = document.getElementById("sample-tabs");
  const blurb = document.getElementById("sample-blurb");

  if (!data || !data.samples || !data.samples.length) {
    if (view) {
      view.innerHTML =
        '<p class="muted">Generated dumps are missing. Run <code>npm run gen:web</code> to build them.</p>';
    }
    return;
  }

  let current = data.samples[0];
  let stage = "source";

  /* ---------------------------------------------------------- source view */

  // A source pane whose spans know their byte range, so any stage can ask it
  // to light up an arbitrary [pos, pos + len) window.
  function makeSourceView(source, options) {
    const opts = options || {};
    const code = el("code", { class: "src-view" });
    let offset = 0;
    const spans = [];

    for (const tok of HL.scan(source)) {
      const span = el("span", {
        class: tok.type === "ws" || tok.type === "ident" ? "" : "tok-" + normalizeType(tok.type),
        text: tok.text,
      });
      span.dataset.start = String(offset);
      span.dataset.end = String(offset + tok.text.length);
      offset += tok.text.length;
      spans.push(span);
      code.appendChild(span);
    }

    const body = el("div", { class: "code-body" }, [el("pre", null, [code])]);
    const fig = el("figure", { class: "code code-tall src-pane" }, [
      el("div", { class: "code-head" }, [
        el("span", { class: "code-name", text: opts.name || "" }),
        el("span", { class: "code-tools muted small", text: opts.hint || "" }),
      ]),
      body,
    ]);

    let lit = [];
    const clear = () => {
      lit.forEach((s) => s.classList.remove("src-hit"));
      lit = [];
    };
    const highlight = (pos, len, scroll) => {
      clear();
      const end = pos + Math.max(len, 1);
      lit = spans.filter((s) => Number(s.dataset.start) < end && Number(s.dataset.end) > pos);
      lit.forEach((s) => s.classList.add("src-hit"));
      if (scroll && lit.length) {
        const rect = lit[0].getBoundingClientRect();
        const paneRect = body.getBoundingClientRect();
        if (rect.top < paneRect.top || rect.bottom > paneRect.bottom) {
          lit[0].scrollIntoView({ block: "center" });
        }
      }
    };

    const onHoverRange = (fn) => {
      code.addEventListener("mousemove", (event) => {
        const span = event.target.closest("span[data-start]");
        if (!span) return;
        fn(Number(span.dataset.start), Number(span.dataset.end));
      });
      code.addEventListener("mouseleave", () => fn(null, null));
    };

    return { element: fig, highlight, clear, onHoverRange };
  }

  function normalizeType(type) {
    if (type === "char") return "str";
    return type;
  }

  /* ------------------------------------------------------------- stage: 1 */

  function stageSource(sample) {
    const wrap = el("div");
    wrap.appendChild(codeBlock(sample.source, { name: sample.file, scroll: true }));
    wrap.appendChild(
      factRow([
        [countLines(sample.source), "lines"],
        [sample.source.length, "bytes"],
        [sample.tokens.length, "tokens after lexing"],
      ]),
    );
    return wrap;
  }

  /* ------------------------------------------------------------- stage: 2 */

  const TAG_GROUP = {
    kw: /^(FUNCTION|RETURN|IF|ELSE|WHILE|FOR|IN|SWITCH|CASE|DEFAULT|BREAK|CONTINUE|LET|CONST|TYPE|TRAIT|KIND|IMPORT|EXPORT|FROM|AS|REF|WAIT|IMPLEMENTS|EXTERN|ENUM|VARIANT|UNION|VTABLE|MODULE|TRUE|FALSE|NULL)$/,
    lit: /LITERAL$/,
    ident: /^IDENT$/,
    punct: /^(LPAREN|RPAREN|LCURLY|RCURLY|LBRACKET|RBRACKET|COLON|SEMICOLON|COMMA|DOT|ARROW|EQUALS|QUESTION)$/,
  };

  function tagClass(tag) {
    if (TAG_GROUP.kw.test(tag)) return "tok-kw";
    if (TAG_GROUP.lit.test(tag)) return "tok-num";
    if (TAG_GROUP.ident.test(tag)) return "tok-type";
    if (TAG_GROUP.punct.test(tag)) return "tok-punct";
    return "";
  }

  function stageLex(sample) {
    const src = makeSourceView(sample.source, {
      name: sample.file,
      hint: "hover either side",
    });

    const list = el("div", { class: "token-list" });
    const rows = [];

    sample.tokens.forEach((tok, idx) => {
      const row = el("div", { class: "token-row" }, [
        el("span", { class: "token-idx", text: String(idx) }),
        el("span", { class: "token-tag " + tagClass(tok.tag), text: tok.tag }),
        el("span", {
          class: "token-text",
          // The EOF token has zero length, so it has no text to show.
          text: JSON.stringify(sample.source.substr(tok.pos, tok.len)).slice(1, -1) || "(eof)",
        }),
        el("span", { class: "token-pos", text: `@${tok.pos}+${tok.len}` }),
      ]);
      row.addEventListener("mouseenter", () => {
        src.highlight(tok.pos, tok.len, true);
        markRow(row);
      });
      rows.push({ row, tok });
      list.appendChild(row);
    });

    let marked = null;
    function markRow(row) {
      if (marked) marked.classList.remove("hit");
      marked = row || null;
      if (marked) marked.classList.add("hit");
    }

    src.onHoverRange((start, end) => {
      if (start === null) {
        src.clear();
        markRow(null);
        return;
      }
      const hit = rows.find((r) => r.tok.pos < end && r.tok.pos + r.tok.len > start);
      if (!hit) return;
      src.highlight(hit.tok.pos, hit.tok.len, false);
      markRow(hit.row);
      const rect = hit.row.getBoundingClientRect();
      const paneRect = list.getBoundingClientRect();
      if (rect.top < paneRect.top || rect.bottom > paneRect.bottom) {
        hit.row.scrollIntoView({ block: "center" });
      }
    });

    const right = el("div", { class: "pane-col" }, [
      el("div", { class: "pane-head" }, [
        el("strong", { text: `${sample.tokens.length} tokens` }),
        el("span", {
          class: "muted small",
          text: "tag, text, byte offset and length - exactly what --dump-tokens prints",
        }),
      ]),
      list,
    ]);

    return el("div", { class: "two-pane" }, [src.element, right]);
  }

  /* ------------------------------------------------------------- stage: 3 */

  // Node fields are raw compiler state, and a couple of them are nested
  // objects that would drown the row. Keep the shape, drop the ceremony.
  function summarizeFields(fields) {
    if (!fields) return "";
    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === false || value === null || value === undefined) continue;
      let text;
      if (typeof value === "string" || typeof value === "number" || value === true) {
        text = String(value);
      } else if (value && typeof value === "object") {
        if (typeof value.name === "string") text = value.name;
        else if (typeof value.line === "number") text = `line ${value.line}`;
        else continue;
      } else {
        continue;
      }
      parts.push(`${key}: ${text}`);
    }
    return parts.length ? `{ ${parts.join(", ")} }` : "";
  }

  function stageParse(sample) {
    const src = makeSourceView(sample.source, {
      name: sample.file,
      hint: "hover a node",
    });

    const tree = el("div", { class: "ast-tree" });
    let count = 0;

    function renderNode(node) {
      count++;
      const details = el("details", { open: true });
      const summary = el("summary", { class: "ast-row" });

      if (node.kind === "GROUP") {
        summary.appendChild(el("span", { class: "ast-label", text: (node.label || "group") + ":" }));
        summary.appendChild(
          el("span", { class: "ast-fields", text: `${(node.children || []).length} node(s)` }),
        );
      } else {
        if (node.label) {
          summary.appendChild(el("span", { class: "ast-label", text: node.label + ":" }));
        }
        summary.appendChild(el("span", { class: "ast-kind", text: node.kind }));
        const fields = summarizeFields(node.fields);
        if (fields) summary.appendChild(el("span", { class: "ast-fields", text: fields }));
      }

      if (node.loc) {
        summary.dataset.pos = String(node.loc.pos);
        summary.dataset.len = String(node.loc.length || 0);
        summary.addEventListener("mouseenter", () => {
          src.highlight(node.loc.pos, node.loc.length || 1, true);
        });
      }

      details.appendChild(summary);
      const children = node.children || [];
      if (children.length) {
        const kids = el("div", { class: "ast-children" });
        for (const child of children) kids.appendChild(renderNode(child));
        details.appendChild(kids);
      } else {
        details.classList.add("leaf");
      }
      return details;
    }

    tree.appendChild(renderNode(sample.ast));
    tree.addEventListener("mouseleave", () => src.clear());

    const right = el("div", { class: "pane-col" }, [
      el("div", { class: "pane-head" }, [
        el("strong", { text: `${count} nodes` }),
        el("span", {
          class: "muted small",
          text: "the tree --dump-ast-json writes; braces and semicolons became structure",
        }),
      ]),
      tree,
    ]);

    return el("div", { class: "two-pane" }, [src.element, right]);
  }

  /* ------------------------------------------------------------- stage: 4 */

  function stageCodegen(sample) {
    const wrap = el("div");
    wrap.appendChild(
      el("p", {
        class: "lede",
        text:
          "LLVM IR as text, straight from --keep-ir. Only this module's own definitions are " +
          "shown: a hello world links the whole standard-library prelude, and the rest of " +
          "that file is code nobody in this program wrote.",
      }),
    );
    wrap.appendChild(
      codeBlock(sample.ir.text, {
        name: "yooper_out.ll (this module's definitions)",
        lang: "llvm",
        tall: true,
      }),
    );
    wrap.appendChild(
      factRow([
        [sample.ir.shownLines, "lines shown"],
        [sample.ir.totalLines, "lines in the whole .ll"],
        [
          Math.round((1 - sample.ir.shownLines / sample.ir.totalLines) * 100) + "%",
          "of it is the std prelude",
        ],
      ]),
    );
    wrap.appendChild(
      el("p", { class: "muted small" }, [
        "Debug metadata references were stripped for readability. Everything else is verbatim, " +
          "including the mangled names: a symbol carries its module id so two modules can both " +
          "declare a ",
        el("code", { text: "main" }),
        "-adjacent helper without colliding at link time.",
      ]),
    );
    return wrap;
  }

  /* ------------------------------------------------------------- stage: 5 */

  function stageRun(sample) {
    const wrap = el("div");
    const base = sample.file.replace(/^.*\//, "").replace(/\.yoop$/, "");
    wrap.appendChild(
      codeBlock(
        `yoopiler_boot ${sample.file}\n./${sample.file.replace(/\.yoop$/, "")}`,
        { lang: "shell", name: "terminal" },
      ),
    );
    wrap.appendChild(
      termBlock(sample.output, { label: `./${base}`, exitCode: sample.exitCode }),
    );
    wrap.appendChild(
      el("p", { class: "muted small" }, [
        "The executable lands next to the source with the extension stripped, and it is an " +
          "ordinary native binary: no runtime to install, no VM, nothing to ship alongside it " +
          "except the C libraries your ",
        el("code", { text: "extern" }),
        " blocks asked for.",
      ]),
    );
    return wrap;
  }

  /* ---------------------------------------------------------------- shell */

  function factRow(pairs) {
    return el(
      "p",
      { class: "hero-facts" },
      pairs.map(([value, label]) =>
        el("span", null, [el("b", { text: String(value) }), " " + label]),
      ),
    );
  }

  function countLines(text) {
    return text.split("\n").length;
  }

  const RENDER = {
    source: stageSource,
    lex: stageLex,
    parse: stageParse,
    codegen: stageCodegen,
    run: stageRun,
  };

  // Both the program and the stage live in the query string, so any view of
  // this page is a link you can hand to somebody.
  function syncUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("sample", current.id);
    url.searchParams.set("stage", stage);
    history.replaceState(null, "", url);
  }

  function paint() {
    // tabs
    tabs.innerHTML = "";
    for (const sample of data.samples) {
      const tab = el("button", {
        class: "tab",
        type: "button",
        role: "tab",
        "aria-selected": String(sample.id === current.id),
        text: sample.title,
      });
      tab.addEventListener("click", () => {
        current = sample;
        syncUrl();
        paint();
      });
      tabs.appendChild(tab);
    }
    blurb.textContent = current.blurb;

    // stage rail
    rail.innerHTML = "";
    STAGES.forEach((s, idx) => {
      const item = el("li", { class: "stage-step" + (s.id === stage ? " on" : "") });
      const btn = el("button", { class: "stage-btn", type: "button" }, [
        el("span", { class: "stage-num", text: String(idx + 1) }),
        el("span", { class: "stage-label", text: s.label }),
        el("span", { class: "stage-sub", text: s.sub }),
      ]);
      btn.addEventListener("click", () => {
        stage = s.id;
        syncUrl();
        paint();
      });
      item.appendChild(btn);
      rail.appendChild(item);
    });

    // stage body
    view.innerHTML = "";
    view.appendChild(RENDER[stage](current));
  }

  const params = new URLSearchParams(window.location.search);
  const requested = params.get("sample");
  if (requested) {
    const hit = data.samples.find((s) => s.id === requested);
    if (hit) current = hit;
  }
  const requestedStage = params.get("stage");
  if (requestedStage && STAGES.some((s) => s.id === requestedStage)) stage = requestedStage;

  paint();

  // Left and right arrows walk the stages, which is the natural thing to try.
  document.addEventListener("keydown", (event) => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const idx = STAGES.findIndex((s) => s.id === stage);
    if (event.key === "ArrowRight" && idx < STAGES.length - 1) {
      stage = STAGES[idx + 1].id;
      syncUrl();
      paint();
    } else if (event.key === "ArrowLeft" && idx > 0) {
      stage = STAGES[idx - 1].id;
      syncUrl();
      paint();
    }
  });
})();
