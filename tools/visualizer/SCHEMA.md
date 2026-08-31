# Visualizer data contract

The driver (`visualize.mjs`) runs the real compiler and normalizes its
artifacts into the shapes below. The viewer (`viewer/`) renders ONLY these
shapes and never sees raw compiler output. That split is the point: the
compiler's dump formats can change without touching a line of Three.js.

## HTTP API

The driver serves the viewer and a small JSON API on localhost.

- `GET /` and `GET /viewer/*` - static viewer files.
- `GET /vendor/three.module.js` - three.js from the tool's node_modules.
- `GET /api/session` - what this session is about:

      {
        "file": "examples/pass/hello.yoop",
        "compiler": "/abs/path/yoopiler_boot",
        "compilerKind": "dev" | "seed" | "env",
        "stages": ["source", "lex", "parse", "modules", "typecheck",
                   "codegen", "link", "run"]
      }

- `POST /api/stage/run` with body `{"stage": "<name>"}` - REALLY runs that
  stage's compiler invocation, right then. This is the debugger feel: a
  stage does not exist until the player pulls its lever. Response:

      { "stage": "parse", "ok": true, "durationMs": 812, "data": { ... } }

  or `{ "ok": false, "error": "...", "stderr": "..." }`. Stages must be run
  in order; the driver refuses an out-of-order request with a message the
  viewer shows in the HUD.

## Per-stage `data` shapes

### source

    { "path": "...", "text": "...", "lines": 42, "bytes": 812 }

### lex

    { "tokens": [ { "kind": "kw", "tag": "FUNCTION", "text": "function",
                    "pos": 33, "len": 8, "line": 4, "col": 1 } ] }

`kind` is a coarse bucket the viewer colors by: `kw`, `ident`, `num`,
`str`, `punct`, `other`. `tag` is the lexer's own tag name, verbatim.
`pos`/`len` are byte offsets into the source text.

### parse

    { "ast": Node, "nodeCount": 123, "maxDepth": 9 }

    Node = {
      "id": 7,                     // unique, preorder
      "kind": "FUNCTION_DECL",     // compiler's node kind, verbatim
      "label": "main",             // short human name, may be ""
      "slot": "functionBody",      // parent slot name, "" for list children
      "span": { "pos": 98, "length": 4, "line": 4, "col": 11 } | null,
      "children": [Node, ...]
    }

The span points at the node's introducing token (that is what the dump
carries), not the construct's full extent.

### modules

    {
      "nodes": [ { "id": "std/vec", "name": "vec", "root": "std",
                   "files": 3, "loc": 812 } ],
      "edges": [ { "from": "main", "to": "std/vec" } ]
    }

`root` is one of `main` (the entry file's module), `std`, `modules`,
`local`.

### typecheck

    {
      "ok": true,
      "diagnostics": [ { "line": 3, "col": 5, "message": "...",
                         "severity": "error" | "warning" } ],
      "decls": [ { "name": "main", "kind": "fn", "type": "() -> i32",
                   "line": 3 } ]
    }

The data comes from a real `--lsp` session (didOpen, publishDiagnostics,
documentSymbol, then hover per symbol for the `type` strings); `decls` is
best-effort and may be `[]`. If the LSP route fails the driver falls back
to compiling and scraping stderr diagnostics, and says so in `lspError`.

### codegen

    {
      "irPath": "/abs/out.ll",
      "irBytes": 48213,
      "irLines": 923,
      "truncated": false,
      "functions": [
        {
          "name": "main",
          "blocks": [
            {
              "label": "entry",
              "instructions": [ { "text": "%1 = add i32 %a, %b",
                                  "op": "add",
                                  "src": { "line": 21, "col": 9 } } ],
              "succ": ["then", "else"]   // labels this block branches to
            }
          ]
        }
      ],
      "stdFunctionCount": 27,
      "stdFunctions": [ { "name": "vec_vecPush", "blocks": 4,
                          "instructions": 61 } ]
    }

`functions` is the ENTRY FILE's functions (`main` plus `<stem>_*`); the std
prelude the module links against is summarized in `stdFunctions` (capped at
400). Only defined functions, not declarations. `succ` is parsed from the
terminator's `label %name` operands; `ret` yields `[]`. `src` is the
`!dbg` provenance the compiler emits, present on most instructions; debug
intrinsic calls are dropped. Instructions across all entry functions are
capped at 8000 (`truncated` says whether the cap bit).

### link

    { "outPath": "/abs/prog", "sizeBytes": 51234, "wallMs": 640 }

`wallMs` is the whole compile-and-link invocation, not clang alone; the
compiler shells out to clang internally and does not time it separately.

### run

    { "stdout": "...", "stderr": "...", "exitCode": 0, "wallMs": 12,
      "timedOut": false, "truncated": false }

stdout/stderr are truncated to 64 KiB. A program that outlives the 20s
deadline is killed: `timedOut` true, `exitCode` null.
