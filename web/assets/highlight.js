/* A small Yooperlang syntax highlighter.
 *
 * It is a hand-written scanner rather than a regex pile because the language
 * has two things regexes handle badly: template literals with nested `${...}`
 * expressions, and char literals, where the single quote is reserved
 * exclusively for one Unicode scalar.
 *
 * Exposed as window.YoopHL:
 *   YoopHL.scan(src)      -> [{ type, text }]        token list
 *   YoopHL.render(src)    -> HTML string
 *   YoopHL.stripComments(src) -> source with comment tokens removed
 *
 * KINDS get their own color on purpose. A kind prefix is the one piece of
 * syntax that is genuinely unlike the languages this one borrows from, and it
 * reads as a modifier rather than a keyword, so it should not look like one.
 */
(function () {
  "use strict";

  const KEYWORDS = new Set([
    "function", "type", "trait", "kind", "vtable", "enum", "variant", "union",
    "let", "const", "return", "if", "else", "while", "for", "in", "switch",
    "case", "default", "break", "continue", "import", "export", "from", "as",
    "module", "true", "false", "null", "ref", "wait", "implements", "provides",
    "requires", "restricts", "propagates", "contains", "layout", "align",
    "extern", "library", "appliesTo", "ownsBlock", "mustCall", "mustNotShare",
    "mustNotEscape", "forbids", "refcounted", "pausable", "conferred",
    "restrictive", "clearedBy", "appliedBy", "enumerable", "signature",
    "beforeScopeEnd", "beforeAny", "afterAny", "abi", "errno", "pure", "unsafe",
  ]);

  // Kinds shipped by std, plus the ones the tour and the docs invent. None of
  // these is a reserved word - they are ordinary identifiers naming a kind
  // declaration, which is a point the site makes more than once.
  const KINDS = new Set([
    "disposable", "ephemeral", "scoped", "pooled", "joined", "batchable",
    "task", "async", "test", "suite", "owned", "cleared", "transaction",
    "describing", "it",
  ]);

  const PRIMITIVES = new Set([
    "int8", "int16", "int32", "int64", "int",
    "uint8", "uint16", "uint32", "uint64",
    "usize", "isize", "uintptr",
    "float32", "float64", "float",
    "bool", "byte", "string", "void", "char", "unsafe_ptr",
    "c_int", "c_uint", "c_long", "c_ulong", "c_short", "c_ushort",
    "c_size_t", "c_ssize_t",
  ]);

  const IDENT_START = /[A-Za-z_$]/;
  const IDENT_PART = /[A-Za-z0-9_$]/;
  const DIGIT = /[0-9]/;

  function scan(src) {
    const out = [];
    let i = 0;
    const n = src.length;

    const push = (type, text) => {
      if (text) out.push({ type, text });
    };

    while (i < n) {
      const c = src[i];

      // whitespace
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        let j = i;
        while (j < n && /[ \t\r\n]/.test(src[j])) j++;
        push("ws", src.slice(i, j));
        i = j;
        continue;
      }

      // line comment
      if (c === "/" && src[i + 1] === "/") {
        let j = i;
        while (j < n && src[j] !== "\n") j++;
        push("comment", src.slice(i, j));
        i = j;
        continue;
      }

      // block comment
      if (c === "/" && src[i + 1] === "*") {
        let j = i + 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j = Math.min(n, j + 2);
        push("comment", src.slice(i, j));
        i = j;
        continue;
      }

      // string literal
      if (c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        j = Math.min(n, j + 1);
        push("str", src.slice(i, j));
        i = j;
        continue;
      }

      // char literal: exactly one scalar, so a short bounded scan
      if (c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== "'" && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        j = Math.min(n, j + 1);
        push("char", src.slice(i, j));
        i = j;
        continue;
      }

      // template literal, with real recursion through `${ ... }`
      if (c === "`") {
        let j = i + 1;
        let chunk = "`";
        while (j < n && src[j] !== "`") {
          if (src[j] === "$" && src[j + 1] === "{") {
            push("tmpl", chunk);
            chunk = "";
            let depth = 1;
            let k = j + 2;
            while (k < n && depth > 0) {
              if (src[k] === "{") depth++;
              else if (src[k] === "}") depth--;
              if (depth > 0) k++;
            }
            push("tmpl", "${");
            for (const inner of scan(src.slice(j + 2, k))) out.push(inner);
            push("tmpl", "}");
            j = k + 1;
            continue;
          }
          if (src[j] === "\\" && j + 1 < n) {
            chunk += src[j] + src[j + 1];
            j += 2;
          } else {
            chunk += src[j];
            j++;
          }
        }
        if (j < n) {
          chunk += "`";
          j++;
        }
        push("tmpl", chunk);
        i = j;
        continue;
      }

      // attribute: @derive(display), @precompile
      if (c === "@" && IDENT_START.test(src[i + 1] || "")) {
        let j = i + 1;
        while (j < n && IDENT_PART.test(src[j])) j++;
        push("attr", src.slice(i, j));
        i = j;
        continue;
      }

      // number
      if (DIGIT.test(c)) {
        let j = i;
        while (j < n && /[0-9a-fA-FxXbBoO_.]/.test(src[j])) {
          // 0..n is a range, not a float: stop before the second dot.
          if (src[j] === "." && src[j + 1] === ".") break;
          j++;
        }
        // exponent
        if (/[eE]/.test(src[j] || "") && /[-+0-9]/.test(src[j + 1] || "")) {
          j += 2;
          while (j < n && DIGIT.test(src[j])) j++;
        }
        push("num", src.slice(i, j));
        i = j;
        continue;
      }

      // identifier or keyword
      if (IDENT_START.test(c)) {
        let j = i;
        while (j < n && IDENT_PART.test(src[j])) j++;
        const word = src.slice(i, j);

        let k = j;
        while (k < n && /[ \t]/.test(src[k])) k++;
        const nextChar = src[k] || "";

        let type = "ident";
        if (KEYWORDS.has(word)) type = "kw";
        else if (KINDS.has(word)) type = "kind";
        else if (PRIMITIVES.has(word)) type = "type";
        else if (nextChar === "(" && src[j] === "(") type = "fn";
        else if (/^[A-Z]/.test(word)) type = "type";

        push(type, word);
        i = j;
        continue;
      }

      // everything else is punctuation, one run at a time
      let j = i;
      while (j < n && /[^\w\s"'`@]/.test(src[j]) && !(src[j] === "/" && /[/*]/.test(src[j + 1] || ""))) {
        j++;
      }
      if (j === i) j = i + 1;
      push("punct", src.slice(i, j));
      i = j;
    }

    return out;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const CLASS_FOR = {
    comment: "tok-comment",
    str: "tok-str",
    char: "tok-str",
    tmpl: "tok-tmpl",
    num: "tok-num",
    kw: "tok-kw",
    kind: "tok-kind",
    type: "tok-type",
    fn: "tok-fn",
    attr: "tok-attr",
    punct: "tok-punct",
  };

  function render(src) {
    let html = "";
    for (const tok of scan(src)) {
      const cls = CLASS_FOR[tok.type];
      html += cls
        ? '<span class="' + cls + '">' + escapeHtml(tok.text) + "</span>"
        : escapeHtml(tok.text);
    }
    return html;
  }

  // Drop comments, then drop the lines that had nothing else on them. Used by
  // the "hide comments" toggle: the tour files carry more prose than code, and
  // sometimes you want to see the program.
  function stripComments(src) {
    let out = "";
    for (const tok of scan(src)) {
      out += tok.type === "comment" ? "" : tok.text;
    }
    return out
      .split("\n")
      .filter((line, idx, lines) => {
        if (line.trim() !== "") return true;
        // collapse runs of blank lines left behind by removed comments
        return idx > 0 && lines[idx - 1].trim() !== "";
      })
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n")
      .trimEnd();
  }

  /* --------------------------------------------------------------- LLVM */

  // A deliberately small LLVM IR highlighter. The IR panes are a centerpiece
  // of this site, and unstyled they read as a wall. Five colors is enough to
  // find the shape: what is defined, what is called, what is a register.
  const LLVM_KEYWORDS = new Set([
    "define", "declare", "call", "ret", "br", "switch", "alloca", "store",
    "load", "getelementptr", "inbounds", "private", "unnamed_addr", "constant",
    "align", "type", "global", "internal", "void", "label", "to", "phi",
    "icmp", "fcmp", "select", "unreachable", "tail", "musttail", "nounwind",
    "sext", "zext", "trunc", "bitcast", "add", "sub", "mul", "sdiv", "udiv",
    "srem", "urem", "and", "or", "xor", "shl", "lshr", "ashr", "eq", "ne",
    "slt", "sgt", "sle", "sge", "ult", "ugt", "ule", "uge", "metadata",
  ]);

  function renderLlvm(src) {
    const pattern = /(;[^\n]*)|(c?"(?:[^"\\]|\\.)*")|(@[\w.$]+|%[\w.$]+)|(\b(?:i1|i8|i16|i32|i64|ptr|float|double)\b)|(\b\d+\b)|([A-Za-z_][\w.]*)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = pattern.exec(src))) {
      out += escapeHtml(src.slice(last, m.index));
      last = pattern.lastIndex;
      const text = escapeHtml(m[0]);
      if (m[1]) out += '<span class="tok-comment">' + text + "</span>";
      else if (m[2]) out += '<span class="tok-str">' + text + "</span>";
      else if (m[3]) {
        out += '<span class="' + (m[0][0] === "@" ? "tok-fn" : "tok-kind") + '">' + text + "</span>";
      } else if (m[4]) out += '<span class="tok-type">' + text + "</span>";
      else if (m[5]) out += '<span class="tok-num">' + text + "</span>";
      else if (m[6] && LLVM_KEYWORDS.has(m[6])) out += '<span class="tok-kw">' + text + "</span>";
      else out += text;
    }
    out += escapeHtml(src.slice(last));
    return out;
  }

  window.YoopHL = { scan, render, renderLlvm, stripComments, escapeHtml };
})();
