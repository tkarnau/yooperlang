# Bootstrap pipeline contracts

Status: DESIGN / NORTH-STAR. This pins the data shape that crosses each layer
boundary in the self-hosting (yoop) compiler, so the yoop and JS implementations
can deviate INTERNALLY without losing a shared target. A "contract" here is the
boundary shape + the invariants that must hold + the error channel. Internals
(data structures, pass count, single vs multi-pass, throw vs Result) are free to
differ as long as the boundary holds.

Style note: ASCII only, no em-dashes, no fancy tables, per repo convention.

References: JS reference impl under src/; bootstrap under bootstrap/src/.
Companion: plans/ownership-and-typestate-redesign.md (the advisory ownership
model the bootstrap should follow).

---

## The pipeline

    entry.yoop
      -> [module graph]        (resolve imports, order modules)
      -> lex                   per module:  source bytes -> Token[]
      -> parse                 per module:  Token[]      -> AST (PROGRAM)
      -> typecheck             whole program: AST -> Typechecked AST + types
      -> [IR / bytecode]       OPTIONAL - JS has none today; bootstrap may add
      -> codegen               Typechecked AST (+ registry) -> LLVM IR text
      -> clang                 .ll + runtime C -> executable

The layering is sound; keep these boundaries clean. The point of this doc is
that each arrow above has a NAMED, CONCRETE shape, and we hold those shapes
stable even as the two implementations drift.

---

## Cross-cutting decisions (read first - these shape every boundary)

The JS impl leans on two things yoop does NOT have: open objects you can stamp
arbitrary fields onto, and reference-shared mutable nodes. yoop is nominal,
closed, and value-semantic. Three decisions follow, and they matter more than
any single layer.

### D1. AST representation: arena + integer node ids (RECOMMENDED)

JS represents the AST as a tree of open objects: `{ kind, sourceLoc, ...any }`,
children held by reference, fields added on demand. None of that ports.

Recommended yoop shape: a flat arena.

    type NodeId = usize;                 // index into the arena (0 = sentinel/none)

    type Ast {
      nodes: Vec<AstNode>,               // every node, owned in one place
      root:  NodeId,                     // the PROGRAM node
    }

    type AstNode {
      kind:      ASTNodeKind,
      sourceLoc: SourceLocation,
      // kind-specific payload: see D1a
    }

Children are referenced by `NodeId` (indices), never by nested ownership. This
is the key move for a value-semantic language: it sidesteps recursive struct
ownership entirely (no node "contains" another node; it names one), makes the
whole AST one owned `Vec`, and - crucially - gives decoration for free (D2).
A whole module's AST is one value you can pass, dump, and diff.

Why not a tree of nested structs/variants: yoop structs are values, so a nested
tree would deep-copy on every pass and every child access; and a recursive
variant with 80+ cases is unwieldy to thread through value semantics. The arena
is the standard data-oriented answer and it is what self-hosting in a
value-language wants.

#### D1a. Per-kind payload: fat node vs payload variant

Two viable ways to carry the kind-specific fields inside `AstNode`:

- Fat node: one struct with every possible child slot as a `NodeId` (0 when
  unused) plus the few scalar fields (name spans, operator tags, literal
  values). Closest 1:1 port of the JS object; easiest to move parser/checker
  logic over; cost is a wide struct with many unused slots.
- Payload variant: `payload: AstPayload` where `AstPayload` is a variant with
  one case per node kind carrying exactly that kind's `NodeId`s/scalars.
  Tighter and type-safe per kind; cost is a large variant and more ceremony
  threading it.

RECOMMENDATION: start with the fat node (port fidelity - the JS parser and
typechecker read/write named fields directly, and a fat node maps straight
across). Revisit a payload variant only if the fat node becomes unmanageable.
Decide this ONCE and write it down; it is the single highest-churn choice.

### D2. Decoration (resolvedType etc): parallel side tables, not in-place stamps

JS stamps `resolvedType`, `calleeMangledName`, `genericInstantiation`,
`castTargetType`, comptime values, etc. onto nodes in place. yoop value
semantics make in-place mutation across a pass boundary impractical, and we want
the parser's AST to be an immutable input to typecheck anyway.

With the arena (D1), decoration is just parallel arrays indexed by `NodeId`:

    type TypedAst {
      ast:           Ast,                       // the parser's output, unchanged
      resolvedTypes: Vec<TypeId>,               // indexed by NodeId (0 = none)
      // sparse maps for the rarer annotations:
      genericInstances: Map<NodeId, GenericInstantiation>,
      calleeMangled:    Map<NodeId, string>,
      // ...one slot/table per JS stamped field, added as needed
    }

This makes "Typechecked AST" a real, separate contract (AST + decoration), not a
mutated version of the parse output. It also keeps the parse AST reusable and
diffable. Use a dense `Vec` for the universal annotation (resolvedType) and
sparse `Map<NodeId, T>` for the occasional ones.

### D3. Error channel: Result + diagnostics, never exceptions

yoop has no exceptions; it has `Result` and `?`. So the JS "lexer/parser throw,
typechecker accumulates" split becomes uniform:

    type Diagnostic {
      message:   string,
      sourceLoc: SourceLocation,
      severity:  Severity,            // Error | Warning (Note later)
    }

Per-layer contract: produce the output AND a `Vec<Diagnostic>` (or a
`Result<Output, Vec<Diagnostic>>`). Lex/parse may still "fail fast" (return the
first diagnostic and stop) - that is an internal choice; the BOUNDARY is always
"output-or-diagnostics," so a caller treats every layer the same way.

Note (ownership redesign): diagnostics are how the compiler talks to the user;
they are NOT the kind/obligation system. The bootstrap follows the advisory
ownership model - layers pass owned `Vec`s (tokens, nodes) to the next layer and
the consumer owns them; no `propagates` ceremony is required to hand data across
a boundary.

---

## Layer-by-layer contracts

For each: producer, input, output shape, invariants, error channel, JS
reference, current bootstrap status.

### Layer 0: Module graph / driver

- Producer: loadModuleGraph(entryPath)
- Input: entry path (string)
- Output:
  type Module {
  id: string, // stable: basename + hash; used for mangling
  absPath: string,
  src: Vec<uint8>, // or string; the exact source bytes
  ast: Ast, // filled after parse
  imports: Vec<NodeId>, // IMPORT_DECL nodes, with resolved targets
  }
  type ModuleGraph {
  modules: Vec<Module>, // topo-ordered, leaves first; entry is IN this list
  entryIndex: usize, // index of the entry module in `modules` (NOT a copy - a
                     // duplicated `entry: Module` value would double-own its AST)
  autoLoadModuleIds: Map<string, string>, // std autoloads -> module id
  }
- Invariants: cycle-free; topological order (a module appears after its
  imports); `id` is stable and the sole basis for cross-module symbol
  mangling (`<id>__<symbol>`).
- Error channel: Result (import cycle, file IO, parse failure of a member).
- JS ref: src/jsyoopdriver/moduleGraph.js, moduleId.js.
- Bootstrap status: STARTED - bootstrap/src/source_graph/module_graph.yoop
  has Module + loadModule (returns a Result-shaped LoadResult).

### Layer 1: Lex

- Producer: tokenize(src)
- Input: source bytes (Vec<uint8>) or string
- Output: Vec<Token>
  type Token { // already defined in lexer.yoop
  tag: TokenTags,
  start: usize, // byte offset into src
  length: int, // byte span; text = src[start .. start+length]
  intVal: uint64, // int/char literals (codepoint for char)
  negated: bool, // the sign doesn't live in the value, so we can support literals with magnitudes larger than int64 max
  floatVal: float64, // float literals
  }
- Invariants: flat stream terminated by an `EOF` token; spans are byte offsets
  into the EXACT source handed in; numeric and char values carried in
  intVal/floatVal; string and template literals returned RAW (quotes included
  for strings; `${...}` interpolation is parsed later, in the parser); block
  comments nest and are skipped; underscore digit separators and 0x/0b/0o
  bases handled.
- Error channel: Vec<Diagnostic> (or Result<Vec<Token>, Diagnostic>). JS
  throws on first error; bootstrap returns it. Boundary shape identical.
- JS ref: src/jsyooplexer/lexer.js (Token: { tag, start, length, intVal?,
  floatVal? }).
- Bootstrap status: IN PROGRESS - lexer.yoop, Token + TokenTags defined;
  tokenScanList/keywordList in contracts.yoop mirror the JS tables.

### Layer 2: Parse

- Producer: parse(tokens) (or parse(src) driving the lexer)
- Input: Vec<Token> for one module
- Output: Ast (arena, root = a PROGRAM node) - see D1
- Invariants: every node carries a real `sourceLoc` (diagnostics depend on
  it); every `kind` is a member of ASTNodeKind; the tree shape mirrors the JS
  parser node-for-node (same kinds, same child roles) so a dumped AST can be
  diffed against the JS dump; reserved-for-later keywords are recognized and
  rejected with an explicit "not yet supported" rather than mis-parsed;
  `>>` split into two `gt` for nested type applications (parser-side, lexer
  unchanged).
- Error channel: Vec<Diagnostic>. JS aborts on first parse error; bootstrap
  may do the same (boundary still output-or-diagnostics).
- JS ref: src/contracts.js (ASTNodeKind + ASTNode), src/jsyooparser/parser.js
  (PROGRAM root: { kind, sourceLoc, body, allowsUnsafe }).
- Bootstrap status: NOT STARTED - ASTNodeKind enum + ASTNode/SourceLocation
  shells exist in contracts.yoop; the arena (D1) and parser are the next
  build.

### Layer 3: Typecheck

- Producer: typecheckProgram(modules)
- Input: parsed modules (Ast per module + the import graph)
- Output: TypedAst per module (D2) + the program-level type state:
  type TypedProgram {
  modules: Vec<TypedAst>,
  moduleScopes: Vec<ModuleScope>, // one per module, indexed by ModuleId
  types: Vec<Type>, // interned; referenced everywhere by TypeId
  symbols: Vec<Symbol>, // interned; referenced by SymbolId
  registry: InstantiationRegistry, // monomorphized generics
  diagnostics: Vec<Diagnostic>,
  }
  The `Type` and `Symbol` variants are DEFINED CONCRETELY in
  bootstrap/src/contracts.yoop - read those, not a sketch here. Two design
  moves diverge from the JS impl internally (sanctioned - only this BOUNDARY
  shape is a contract, per the deviation policy below):

  1. Types are INTERNED in one arena (`types: Vec<Type>`); every inner type
     reference is a `TypeId` (index), never a nested Type value. This
     sidesteps recursive value ownership AND replaces the JS "mutate a shared
     shell in place across passes" pattern (StructType.fields, TraitType.methods,
     TypeParamType.bounds) with "pass A inserts a shell, pass C re-sets the arena
     slot." NominalDecl.populated is the shell/filled bit that stands in for JS's
     `fields: null`. Type equality is `id == id`; reserve low TypeIds for the
     Void / Untyped* / Error singletons.

  2. One symbol table per module, NOT thirteen. A ModuleScope is a
     `Map<string, SymbolId>` whose value is a `Symbol` variant; the JS split
     across structTable / traitTable / variantTable / enum/union/vtable / the
     generic\* tables / importedNames collapses into one namespace. Lookup is one
     get + one match; redeclaration is one `has`. Imports are name bindings into
     the shared `symbols` arena (Symbol.Imported / Symbol.Namespace), so
     cross-module resolution is one hop with no per-module table branching.
     KindType is a Symbol (Symbol.Kind -> a KindId), NOT a Type case: a kind is a
     decl, not a value's type.

  ModuleScope carries the module id (the mangling basis), its name map, its
  export set, and allowsUnsafe. The InstantiationRegistry is unchanged from the
  JS design: keyed by (declId, argTypeIds), caching monomorphic
  Struct/Func/Trait/Variant instances.
- Invariants (the load-bearing ones for codegen):
  - every node that reaches codegen has a concrete resolvedType (a real
    TypeId, not the infer-later sentinel and not an error type);
  - NO TypeParamType reaches codegen - generic bodies are monomorphized into
    the registry first;
  - generic decls live ONLY in the generic\* tables; concrete tables hold
    only monomorphic types;
  - variant ordinals are stable 0-indexed in declaration order (ABI);
  - diagnostics are accumulated, never thrown.
- Error channel: Vec<Diagnostic> (accumulate; do not stop at first).
- JS ref: src/jsyooptypecheck/typecheck.js (passes A/B/C/D), types.js,
  instantiate.js. typecheckProgram returns { modules, errors, moduleEnv,
  programState: { registry, ... } }.
- Bootstrap status: NOT STARTED.

### Layer 4: IR / bytecode (OPTIONAL - the main planned deviation point)

- JS impl: NONE. codegen is single-pass AST -> LLVM IR text, no intermediate
  form.
- The bootstrap MAY insert a typed IR / SSA / bytecode layer here (the user
  has flagged this as a likely deviation). If it does, that is fine - it is
  exactly the kind of internal divergence this doc exists to absorb. To keep
  it absorbable, hold the codegen INPUT contract stable regardless of whether
  an IR exists (see Layer 5): "everything has a concrete type + a mangled
  symbol scheme." Then codegen can consume EITHER the TypedAst directly (JS
  style) OR a lowered IR (bootstrap style) without the rest of the pipeline
  caring.
- If/when introduced, pin its shape then:
  type IrModule { funcs: Vec<IrFunc>, ... }
  type IrFunc { name: string (mangled), params, body: Vec<IrInst>, ... }
  type IrInst { ...typed instructions referencing TypeId + registry... }
  Until then this layer is a documented hole, not a requirement.

### Layer 5: Codegen

- Producer: codegenProgram(typedProgram) (or codegen over an IrModule)
- Input: TypedProgram (modules + moduleEnvs + registry) OR an IrModule
- Output:
  type CodegenOutput {
  ir: string, // complete LLVM IR text (-> /tmp/\*.ll)
  linkFlags: Vec<string>, // library names from extern blocks
  }
- Invariants / what codegen is allowed to assume (this IS the contract that
  lets Layer 4 vary): every node/instruction has a concrete resolvedType;
  multi-module symbols are mangled `<moduleId>__<symbol>` (and generic
  instances `<moduleId>__<name>__<arg>__<arg>`); one LLVM definition per
  registry instance; codegen does ZERO type-checking and must be total on a
  well-formed typed input (a crash here is a typecheck bug, not user error).
- Error channel: none expected on clean input; internal-error on malformed
  input (mirrors JS - codegen assumes a clean AST).
- JS ref: src/jsyoopcodegen/codegen.js (compileEntry, codegenProgram); returns
  { ir, linkFlags }.
- Bootstrap status: NOT STARTED.

### Layer 6: Link

- Producer: shell out to clang
- Input: the .ll path + the runtime C sources + linkFlags
- Output: executable
- Invariants: identical across both impls - both shell out to clang with the
  runtime from runtimeBuild.js and the accumulated `-l` flags. This layer does
  not deviate.
- JS ref: src/yoopiler.js clang invocation, src/runtimeBuild.js.

---

## Deviation policy (what is a contract vs an implementation detail)

CONTRACT (must match across both implementations):

- the boundary shapes above (Token, Ast/AstNode, TypedAst, TypedProgram,
  CodegenOutput) and their invariants;
- the MEANING of every TokenTags member, every ASTNodeKind, every Type
  variant - the two enums must stay in lockstep (bootstrap mirrors src/);
- the symbol mangling scheme and the ABI (variant ordinals, struct layout,
  enum tag widths) - codegen output must be link-compatible;
- diagnostics carry a sourceLoc into the original source.

FREE TO DIFFER (internal):

- data structures within a pass, number of passes, single vs multi-pass
  codegen;
- throw vs Result mechanics (the boundary is always output-or-diagnostics);
- whether an IR/bytecode layer (Layer 4) exists;
- caching, interning, arena vs tree (though arena is recommended), fat node
  vs payload variant (D1a).

The test of a good boundary: a yoop layer can consume the JS layer's output (and
vice versa), so you can swap one layer at a time and cross-check.

---

## Cross-checking strategy (how to build this with confidence)

Self-hosting is safest when each layer is verified against the JS reference at
its boundary BEFORE moving up:

1. Give every boundary a deterministic, serializable dump (token dump, AST
   dump - the JS side already has AST dumping per the git history; mirror its
   format in yoop).
2. For the same input source, assert `yoop_layer_dump == js_layer_dump`:
   - lex: identical token streams (tag, span, literal values);
   - parse: identical AST dumps;
   - typecheck: identical resolved-type annotations + diagnostics;
   - codegen: identical (or behaviorally equivalent) .ll, then identical
     program output.
3. Only once a layer matches do you build the next on top of it.

This turns "rewrite a compiler in itself" into a sequence of small, checkable
diffs, and it is the concrete payoff of pinning these contracts.

---

## Recommended build order

Bottom-up, cross-checking against JS at each boundary:

1. Lock D1/D2/D3 (arena, side-table decoration, Result+Diagnostic). Write the
   `Ast` arena + `AstNode` fat-node shape into contracts.yoop.
2. Finish the lexer (Layer 1) and diff its token stream against the JS lexer.
3. Build the parser (Layer 2) onto the arena; diff AST dumps.
4. Build typecheck (Layer 3): the Type interning model + ModuleEnv + registry;
   diff resolved types + diagnostics. This is the largest layer.
5. Codegen (Layer 5) straight from the TypedAst (skip Layer 4 initially, as JS
   does); diff the .ll and run the binary.
6. Only then consider an IR/bytecode layer (Layer 4) if a pass or an
   optimization wants one - by then the codegen input contract is proven, so
   inserting it is a contained change.

Module graph (Layer 0) spans the whole thing and is already underway; keep it as
the outer driver that feeds source into the per-module lex/parse and collects
modules for the whole-program typecheck + codegen.
