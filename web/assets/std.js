/* The standard library browser.
 *
 * Renders web/data/std.data.js, which scripts/gen_web.mjs builds by reading
 * every .yoop file under std/ and pulling out each `export` declaration with
 * the comment block above it. Nothing here is hand-maintained, which is the
 * point: the page cannot describe a function the library does not have.
 */
(function () {
  "use strict";

  const S = window.YoopSite;
  const HL = window.YoopHL;
  const data = (window.YOOP_DATA || {}).std;
  if (!S) return;
  const { el } = S;

  const GITHUB = "https://github.com/tkarnau/yooperlang/blob/main/";

  const nav = document.getElementById("std-nav");
  const main = document.getElementById("std-main");
  const filterInput = document.getElementById("std-filter");
  const countLabel = document.getElementById("std-count");

  if (!data) {
    main.innerHTML =
      '<p class="muted">Generated data is missing. Run <code>npm run gen:web</code>.</p>';
    return;
  }

  const AREA_TITLES = {
    std: "Top level",
    "std/core": "std/core",
    "std/collections": "std/collections",
  };

  /* ------------------------------------------------------------ rendering */

  // Doc comments are plain text with backticks and blank-line paragraphs.
  // Render the paragraphs, and let `code` spans through.
  function docToNodes(doc) {
    const out = [];
    for (const para of doc.split(/\n\s*\n/)) {
      const text = para.replace(/\n/g, " ").trim();
      if (!text) continue;
      const p = el("p", { class: "std-doc" });
      const parts = text.split(/`([^`]+)`/);
      parts.forEach((part, idx) => {
        if (!part) return;
        p.appendChild(idx % 2 ? el("code", { text: part }) : document.createTextNode(part));
      });
      out.push(p);
    }
    return out;
  }

  function exportNode(exp, mod) {
    const wrap = el("div", { class: "std-export", id: `${mod.importPath}.${exp.name}` });

    const sig = el("pre", { class: "std-sig" }, [
      el("code", { html: HL.render(exp.signature) }),
    ]);

    const head = el("div", { class: "std-export-head" }, [
      el("span", { class: "pill pill-" + exp.kind, text: exp.kind }),
      el("span", { class: "std-name", text: exp.name }),
      el("a", {
        class: "std-src",
        href: `${GITHUB}${exp.file}#L${exp.line}`,
        target: "_blank",
        rel: "noopener",
        text: exp.file.split("/").pop() + ":" + exp.line,
      }),
    ]);

    wrap.appendChild(head);
    wrap.appendChild(sig);
    if (exp.doc) docToNodes(exp.doc).forEach((node) => wrap.appendChild(node));

    if (exp.shape && exp.shape.split("\n").length > 1) {
      const details = el("details", { class: "std-shape" });
      details.appendChild(el("summary", { text: "declaration" }));
      details.appendChild(
        el("pre", { class: "std-shape-body" }, [el("code", { html: HL.render(exp.shape) })]),
      );
      wrap.appendChild(details);
    }

    // Searchable haystack, computed once.
    wrap.dataset.haystack = (
      exp.name +
      " " +
      exp.signature +
      " " +
      exp.kind +
      " " +
      mod.importPath +
      " " +
      (exp.doc || "")
    ).toLowerCase();

    return wrap;
  }

  function moduleNode(mod) {
    const section = el("section", { class: "std-module", id: mod.importPath });

    const head = el("div", { class: "std-module-head" }, [
      el("h2", { id: mod.importPath + "-h", text: mod.importPath }),
      el("span", {
        class: "pill",
        text: mod.isDirectoryModule ? `directory module, ${mod.files.length} files` : "single file",
      }),
    ]);
    section.appendChild(head);

    const importLine = mod.isDirectoryModule
      ? `import * as ${mod.name} from "${mod.importPath}";`
      : `import * as ${mod.name} from "${mod.importPath}";`;
    section.appendChild(
      el("pre", { class: "std-import" }, [el("code", { html: HL.render(importLine) })]),
    );

    if (mod.doc) docToNodes(mod.doc).forEach((node) => section.appendChild(node));

    const list = el("div", { class: "std-exports" });
    for (const exp of mod.exports) list.appendChild(exportNode(exp, mod));
    section.appendChild(list);

    return section;
  }

  /* ---------------------------------------------------------------- build */

  for (const area of data.areas) {
    const heading = el("h2", { text: AREA_TITLES[area.path] || area.path });
    const list = el("ul");
    for (const importPath of area.modules) {
      list.appendChild(
        el("li", null, [
          el("a", { href: "#" + importPath, text: importPath.replace(/^std\//, "") }),
        ]),
      );
    }
    nav.appendChild(heading);
    nav.appendChild(list);
  }

  const sections = [];
  for (const area of data.areas) {
    const intro = el("section", { class: "std-area" }, [
      el("h2", { id: "area-" + area.path.replace(/\//g, "-"), text: AREA_TITLES[area.path] || area.path }),
      area.blurb ? el("p", { class: "lede", text: area.blurb }) : null,
    ]);
    main.appendChild(intro);
    for (const importPath of area.modules) {
      const mod = data.modules.find((m) => m.importPath === importPath);
      const node = moduleNode(mod);
      sections.push({ node, mod });
      main.appendChild(node);
    }
  }

  countLabel.textContent = `${data.counts.modules} modules, ${data.counts.exports} exports`;

  /* --------------------------------------------------------------- filter */

  function applyFilter() {
    const needle = filterInput.value.trim().toLowerCase();
    if (!needle) {
      sections.forEach(({ node }) => {
        node.hidden = false;
        node.querySelectorAll(".std-export").forEach((e) => (e.hidden = false));
      });
      document.querySelectorAll(".std-area").forEach((a) => (a.hidden = false));
      countLabel.textContent = `${data.counts.modules} modules, ${data.counts.exports} exports`;
      return;
    }

    let shownExports = 0;
    let shownModules = 0;
    sections.forEach(({ node, mod }) => {
      const moduleHit = mod.importPath.toLowerCase().includes(needle);
      let any = false;
      node.querySelectorAll(".std-export").forEach((e) => {
        const hit = moduleHit || e.dataset.haystack.includes(needle);
        e.hidden = !hit;
        if (hit) {
          any = true;
          shownExports++;
        }
      });
      node.hidden = !any;
      if (any) shownModules++;
    });

    // Hide an area heading when nothing under it survived.
    document.querySelectorAll(".std-area").forEach((areaNode) => {
      let sibling = areaNode.nextElementSibling;
      let any = false;
      while (sibling && sibling.classList.contains("std-module")) {
        if (!sibling.hidden) any = true;
        sibling = sibling.nextElementSibling;
      }
      areaNode.hidden = !any;
    });

    countLabel.textContent = `${shownExports} exports in ${shownModules} modules`;
  }

  filterInput.addEventListener("input", applyFilter);

  // A deep link from search lands on a module; open it and make it obvious.
  if (window.location.hash) {
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target) {
      target.scrollIntoView();
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 1600);
    }
  }
})();
