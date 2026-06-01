(function () {
    "use strict";

    const KEYWORDS = new Set([
        "function", "type", "trait", "kind", "vtable", "enum", "union",
        "let", "const", "discard", "return", "if", "else", "while", "for", "in",
        "switch", "case", "default", "break", "continue",
        "import", "export", "from", "as",
        "true", "false", "null",
        "ref", "task", "wait", "implements", "provides", "restricts",
        "propagates", "layout", "align",
        "disposable", "scoped", "pooled", "joined", "batchable",
        "extern", "library",
    ]);

    const PRIMITIVES = new Set([
        "int8", "int16", "int32", "int64",
        "uint8", "uint16", "uint32", "uint64",
        "float32", "float64",
        "bool", "byte", "string", "void", "char",
    ]);

    function escapeHtml(s) {
        return s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function highlightYoop(src) {
        const out = [];
        let i = 0;
        const n = src.length;

        while (i < n) {
            const c = src[i];

            // line comment
            if (c === "/" && src[i + 1] === "/") {
                let j = i;
                while (j < n && src[j] !== "\n") j++;
                out.push('<span class="tok-comment">' + escapeHtml(src.slice(i, j)) + "</span>");
                i = j;
                continue;
            }

            // block comment (single level - good enough for highlighting)
            if (c === "/" && src[i + 1] === "*") {
                let j = i + 2;
                while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
                j = Math.min(n, j + 2);
                out.push('<span class="tok-comment">' + escapeHtml(src.slice(i, j)) + "</span>");
                i = j;
                continue;
            }

            // string literal "..."
            if (c === '"') {
                let j = i + 1;
                while (j < n && src[j] !== '"') {
                    if (src[j] === "\\" && j + 1 < n) j += 2;
                    else j++;
                }
                j = Math.min(n, j + 1);
                out.push('<span class="tok-str">' + escapeHtml(src.slice(i, j)) + "</span>");
                i = j;
                continue;
            }

            // template literal `...${expr}...`
            if (c === "`") {
                let j = i + 1;
                let buf = "`";
                while (j < n && src[j] !== "`") {
                    if (src[j] === "$" && src[j + 1] === "{") {
                        // flush template chunk
                        out.push('<span class="tok-tmpl">' + escapeHtml(buf) + "</span>");
                        buf = "";
                        // find matching brace
                        let depth = 1;
                        let k = j + 2;
                        while (k < n && depth > 0) {
                            if (src[k] === "{") depth++;
                            else if (src[k] === "}") depth--;
                            if (depth > 0) k++;
                        }
                        out.push('<span class="tok-tmpl">${</span>');
                        out.push(highlightYoop(src.slice(j + 2, k)));
                        out.push('<span class="tok-tmpl">}</span>');
                        j = k + 1;
                        continue;
                    }
                    if (src[j] === "\\" && j + 1 < n) {
                        buf += src[j] + src[j + 1];
                        j += 2;
                    } else {
                        buf += src[j];
                        j++;
                    }
                }
                if (j < n) { buf += "`"; j++; }
                if (buf.length) out.push('<span class="tok-tmpl">' + escapeHtml(buf) + "</span>");
                i = j;
                continue;
            }

            // number literal
            if (/[0-9]/.test(c)) {
                let j = i;
                while (j < n && /[0-9a-fA-FxXbBoO_.]/.test(src[j])) j++;
                out.push('<span class="tok-num">' + escapeHtml(src.slice(i, j)) + "</span>");
                i = j;
                continue;
            }

            // identifier / keyword
            if (/[A-Za-z_]/.test(c)) {
                let j = i;
                while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
                const word = src.slice(i, j);

                let cls = null;
                if (KEYWORDS.has(word)) {
                    cls = "tok-kw";
                } else if (PRIMITIVES.has(word)) {
                    cls = "tok-type";
                } else if (src[j] === "(") {
                    cls = "tok-fn";
                } else if (/^[A-Z]/.test(word)) {
                    cls = "tok-type";
                }

                if (cls) out.push('<span class="' + cls + '">' + escapeHtml(word) + "</span>");
                else out.push(escapeHtml(word));
                i = j;
                continue;
            }

            // everything else (punctuation, whitespace)
            out.push(escapeHtml(c));
            i++;
        }

        return out.join("");
    }

    function apply() {
        const blocks = document.querySelectorAll("pre code.yoop");
        blocks.forEach((el) => {
            // decode the HTML-escaped text the author wrote in the source
            const raw = el.textContent;
            el.innerHTML = highlightYoop(raw);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply);
    } else {
        apply();
    }
})();
