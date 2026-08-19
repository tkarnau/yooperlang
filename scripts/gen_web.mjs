// Regenerate the data files the web site reads.
//
//     npm run gen:web
//
// The site under web/ is static - no framework, no bundler, no CDN. What it
// does have is DATA: real token streams, real ASTs, real LLVM IR, real program
// output, and real compiler diagnostics, all produced by actually running the
// compiler in this repo. This script is what produces them, and it is the
// reason a page can show "here is what the compiler says" without anyone
// retyping it by hand.
//
// Everything it writes lands in web/data/*.data.js as an assignment onto one
// global (`window.YOOP_DATA`). Plain .js rather than .json on purpose: a
// double-clicked file:// page cannot fetch() a sibling JSON file, and the site
// is meant to work from a checkout with no server at all.
//
// Requires clang on PATH, like every other compile in this repo.

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "web");
const dataRoot = path.join(webRoot, "data");
const yoopiler = path.join(repoRoot, "src/yoopiler.js");

const COMPILE_TIMEOUT_MS = Number(process.env.YOOP_WEB_COMPILE_TIMEOUT_MS ?? 120000);
const RUN_TIMEOUT_MS = Number(process.env.YOOP_WEB_RUN_TIMEOUT_MS ?? 20000);

// ---------------------------------------------------------------------------
// What gets generated. Editing these three tables is how the site grows.
// ---------------------------------------------------------------------------

// The guided tour. Source of truth is examples/tour/, which is a maintained,
// compiling corpus - the site never re-types those programs.
const TOUR = [
  { id: "hello" },
  { id: "functions" },
  { id: "strings" },
  { id: "traits" },
  { id: "kinds" },
];

// The pipeline explorer. Small programs only: every stage of these is shown in
// full, so a 400-line input would drown the page.
const PIPELINE = [
  {
    id: "hello",
    title: "Hello",
    file: "examples/tour/hello.yoop",
    blurb: "The smallest program there is. Six tokens of structure, one call, one exit code.",
  },
  {
    id: "fibonacci",
    title: "A loop and a template literal",
    file: "examples/intro/fibonacci.yoop",
    blurb:
      "A while loop and `${...}` interpolation. Watch the template literal turn into a printf format string plus arguments.",
  },
  {
    id: "traits",
    title: "A trait and a bound",
    file: "examples/tour/traits.yoop",
    blurb:
      "Generics monomorphize: one `announce` in the source becomes one machine function per concrete type, which you can find by name in the IR.",
  },
  {
    id: "kinds",
    title: "A kind that injects code",
    file: "examples/tour/kinds.yoop",
    blurb:
      "The payoff sample. `disposable` on a binding makes the compiler place `dispose` calls on every exit path - find them in the IR.",
  },
];

// Break-it cards. Each names a program under examples/fail/ that is SUPPOSED
// to fail, so the diagnostic below it is whatever the compiler really said.
const BREAKS = [
  {
    id: "missing_return",
    episode: "functions",
    title: "Leave a path with no return",
    file: "examples/fail/missing_return.yoop",
    note: "The rule is divergence, not \"the last statement is a return\". An `if` covers a path only when it has an `else` and both arms diverge, and a conditional loop covers nothing because it may never run.",
  },
  {
    id: "counter_int32_vs_usize",
    episode: "functions",
    title: "Compare an int32 against a length",
    file: "examples/fail/counter_int32_vs_usize.yoop",
    note: "Lengths and indices are usize; an unannotated literal is int32. No implicit widening means the most ordinary loop in programming is where the rule bites first. In a `for` head the counter takes its type from the CONDITION instead.",
  },
  {
    id: "struct_literal_no_target",
    episode: "traits",
    title: "Let a struct literal type itself",
    file: "examples/fail/struct_literal_no_target.yoop",
    note: "A struct literal has no name in it, so it has no type of its own. Inference flows initializer to binding, and it will not run backwards guessing which struct you meant.",
  },
  {
    id: "method_call_sugar",
    episode: "traits",
    title: "Call a trait method with a dot",
    file: "examples/fail/traits_method_call_sugar.yoop",
    note: "The call is `Greeter.greet(ref g)`, always. Note the fix-it below is out of date: it points at the bare `greet(ref g)` form, which is itself rejected, with a better message that names the trait for you.",
  },
  {
    id: "generic_bound_unsatisfied",
    episode: "traits",
    title: "Pass a type that misses the bound",
    file: "examples/fail/generic_bound_unsatisfied.yoop",
    note: "Bounds are checked at the call, against the concrete type. Monomorphization means there is no runtime dispatch to fall back on.",
  },
  {
    id: "kind_requires_trait",
    episode: "kinds",
    title: "Ask for cleanup a type cannot do",
    file: "examples/fail/binding_missing_trait.yoop",
    note: "`requires Disposable` in the kind declaration is what makes a kind a contract rather than a naming convention.",
  },
  {
    id: "scoped_escape_return",
    episode: "kinds",
    title: "Return a value that must not escape",
    file: "examples/fail/scoped_escape_return.yoop",
    note: "`mustNotEscape scope` is a clause with real teeth: it is enforced, and it is also what lets the compiler keep the binding in a stack slot.",
  },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The local calendar date, not UTC: a site regenerated at 8pm should not be
// stamped tomorrow.
function localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function log(msg) {
  process.stdout.write(`gen:web ${msg}\n`);
}

// One child process, with both streams captured and a deadline, and a
// non-zero exit treated as data rather than as an exception: most of what this
// script wants IS the output of a failing compile.
//
// spawnSync rather than execFileSync because execFileSync hands back stdout
// only, and this script cares which stream a line went to - the logging
// program in the tour prints to stderr on purpose.
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: opts.timeout ?? COMPILE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${cmd} ${args.join(" ")} was killed with ${result.signal}: deadline?`);
  }

  return {
    code: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readIfPresent(rel) {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

// clang's target-triple warning is noise on every single compile and says
// nothing about the program. Drop it so the site's "what the compiler printed"
// panes are actually about the program.
function stripToolchainNoise(text) {
  return text
    .split("\n")
    .filter(
      (line) =>
        !/overriding the module target triple/.test(line) &&
        !/^\d+ warnings? generated\.$/.test(line.trim()),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Absolute paths in a diagnostic are this machine's, not the reader's.
function relativizePaths(text) {
  return text.split(repoRoot + path.sep).join("").split(repoRoot).join(".");
}

// ---------------------------------------------------------------------------
// Compiling one program: tokens, AST, IR, and what it prints when it runs
// ---------------------------------------------------------------------------

function dumpTokens(file) {
  const { stdout } = run(process.execPath, [yoopiler, "--dump-tokens", file]);
  const tokens = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "IDENT 331 4" or "INTLITERAL 398 1 int=0"
    const m = /^(\S+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(trimmed);
    if (!m) continue;
    const tok = { tag: m[1], pos: Number(m[2]), len: Number(m[3]) };
    if (m[4]) tok.value = m[4];
    tokens.push(tok);
  }
  return tokens;
}

function dumpAst(file, tmpDir) {
  const out = path.join(tmpDir, "ast.json");
  const res = run(process.execPath, [yoopiler, "--dump-ast-json", out, file]);
  if (!fs.existsSync(out)) {
    throw new Error(`AST dump produced nothing for ${file}: ${res.stderr || res.stdout}`);
  }
  const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
  fs.rmSync(out, { force: true });
  return parsed.ast;
}

// Pull out only the definitions this module contributed, plus `main`. A hello
// world links the whole std prelude, so the full .ll is ~4300 lines of code
// nobody wrote and nobody wants to read.
function excerptIr(irText, moduleBase) {
  const lines = irText.split("\n");
  const kept = [];
  const ownsSymbol = (sym) =>
    sym === "main" || sym.startsWith(`${moduleBase}_`) || sym.startsWith(`.str_${moduleBase}_`);

  // Module-owned string constants, which is where the literals live.
  for (const line of lines) {
    const g = /^@(\.str_[A-Za-z0-9_]+)\s*=/.exec(line);
    if (g && ownsSymbol(g[1])) kept.push(line);
  }
  if (kept.length) kept.push("");

  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      const d = /^define\s+.*?@"?([A-Za-z0-9_.$]+)"?\s*\(/.exec(line);
      if (d && ownsSymbol(d[1])) {
        inBlock = true;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
    if (line === "}") {
      inBlock = false;
      kept.push("");
    }
  }

  // Debug-info references are one `!dbg !981` per instruction and carry no
  // meaning without the metadata table, which is not shown. The
  // llvm.dbg.declare calls go with them: they name a source variable for a
  // debugger and emit no code.
  const cleaned = kept
    .filter((line) => !/call void @llvm\.dbg\.declare/.test(line))
    .map((line) => line.replace(/,?\s*!dbg !\d+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, totalLines: lines.length, shownLines: cleaned.split("\n").length };
}

function compileAndRun(file, tmpDir, { wantIr = false } = {}) {
  const base = path.basename(file, ".yoop");
  const binPath = path.join(tmpDir, base);
  const args = [yoopiler, file, "-o", binPath];
  if (wantIr) args.splice(2, 0, "--keep-ir");

  const compile = run(process.execPath, args);
  const compileOutput = stripToolchainNoise(relativizePaths(compile.stdout + compile.stderr));

  if (compile.code !== 0 || !fs.existsSync(binPath)) {
    return { compiled: false, diagnostic: compileOutput, exitCode: compile.code };
  }

  let ir = null;
  if (wantIr) {
    const m = /llvm IR written to (\S+\.ll)/.exec(compile.stdout);
    if (m && fs.existsSync(m[1])) {
      ir = excerptIr(fs.readFileSync(m[1], "utf8"), base);
      fs.rmSync(path.dirname(m[1]), { recursive: true, force: true });
    }
  }

  const ran = run(binPath, [], { timeout: RUN_TIMEOUT_MS });
  fs.rmSync(binPath, { force: true });

  // stdout and stderr stay apart: `log.info` writes to stderr, and a page that
  // glued the two together would quietly misrepresent where a line came from.
  return {
    compiled: true,
    ir,
    output: ran.stdout.replace(/\s+$/, ""),
    stderr: ran.stderr.replace(/\s+$/, ""),
    exitCode: ran.code,
  };
}

// ---------------------------------------------------------------------------
// std: read the library's own source, not a summary of it
// ---------------------------------------------------------------------------

const MODULE_BLURBS = {
  std: "Single-file modules that sit at the top of the library: the clock, the filesystem, the environment, logging, assertions, and the test harness.",
  "std/core": "The pieces every other module is built out of: allocation, strings, text, vectors, the foundational traits and kinds.",
  "std/collections": "Hash map, hash set, and a ring-buffer deque, generic over their element types.",
  "std/net": "TCP sockets over a runtime shim that presents the POSIX shape on every platform.",
  "std/http": "An HTTP/1.1 server and client. A Handler trait with vtable dispatch, a router with :param and * patterns, keep-alive.",
  "std/crypto": "SHA-256 and HMAC-SHA-256, in pure yoop with no FFI.",
  "std/db": "SQLite: connections, prepared statements, and a transaction kind that commits or rolls back at the end of its block.",
  "std/encoding": "RFC 4648 base64, standard and URL-safe.",
  "std/tls": "TLS over a TcpStream, via OpenSSL.",
  "std/https": "The HTTP client, over TLS.",
};

function walkYoopFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkYoopFiles(abs, out);
    else if (entry.name.endsWith(".yoop") && !entry.name.endsWith(".test.yoop")) out.push(abs);
  }
  return out;
}

// A file is a member of a DIRECTORY module when it declares `module <name>;`.
function moduleDeclOf(source) {
  const m = /^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/m.exec(source);
  return m ? m[1] : null;
}

function leadingDoc(lines, declIndex) {
  const doc = [];
  for (let i = declIndex - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("//")) {
      doc.unshift(line.replace(/^\/\/ ?/, ""));
      continue;
    }
    break;
  }
  // An attribute line (@derive(display)) sits between the doc and the decl.
  while (doc.length && doc[doc.length - 1].startsWith("@")) doc.pop();
  return doc.join("\n").trim();
}

// The declaration line, joined across wraps, ending at the `{` or `;` that
// closes the signature. Bodies are not included; a signature is the API.
function signatureAt(lines, index) {
  const parts = [];
  for (let i = index; i < Math.min(lines.length, index + 12); i++) {
    const line = lines[i];
    parts.push(line.trim());
    const joined = parts.join(" ");
    // Stop at the first brace or semicolon that is not inside a string.
    if (/[{;]/.test(line.replace(/"[^"]*"/g, ""))) {
      return joined
        .replace(/\s*\{[\s\S]*$/, "")
        .replace(/;\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// For a type / trait / variant, the shape IS the documentation, so keep the
// whole braced body (fields and method signatures, bodies elided).
function declarationBlock(lines, index) {
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = index; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") depth--;
    }
    if (started && depth <= 0) break;
    if (out.length > 60) {
      out.push("  // ...");
      break;
    }
  }
  return out.join("\n").replace(/\s+$/, "");
}

const EXPORT_KINDS = {
  function: "function",
  task: "task",
  async: "function",
  type: "type",
  trait: "trait",
  kind: "kind",
  enum: "enum",
  variant: "variant",
  union: "union",
  const: "const",
  vtable: "vtable",
};

const SHAPE_DECLS = new Set(["type", "trait", "kind", "enum", "variant", "union", "vtable"]);

function collectExports(absFile, relFile) {
  const source = fs.readFileSync(absFile, "utf8");
  const lines = source.split("\n");
  const exports = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^export\s+(?:(async|task|pure)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      line,
    );
    if (!m) continue;

    const modifier = m[1] ?? null;
    let keyword = m[2];
    let name = m[3];
    // `export async function f(...)` - the keyword we want is the second word.
    if (keyword === "function" || keyword === "task") {
      // already right
    } else if (!EXPORT_KINDS[keyword]) {
      continue;
    }
    if (modifier && keyword !== "function") {
      // `export task fetch(...)` parses as keyword=task name=fetch already.
    }

    const kind = EXPORT_KINDS[keyword] ?? (modifier ? EXPORT_KINDS[modifier] : null);
    if (!kind) continue;

    exports.push({
      name,
      kind: modifier === "task" || keyword === "task" ? "task" : kind,
      signature: signatureAt(lines, i),
      doc: leadingDoc(lines, i),
      shape: SHAPE_DECLS.has(keyword) ? declarationBlock(lines, i) : null,
      file: relFile,
      line: i + 1,
    });
  }
  return exports;
}

function moduleHeaderDoc(absFile) {
  const lines = fs.readFileSync(absFile, "utf8").split("\n");
  const doc = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("//")) {
      doc.push(t.replace(/^\/\/ ?/, ""));
      continue;
    }
    if (t === "") {
      if (doc.length) break;
      continue;
    }
    break;
  }
  // Drop the "std/core/vec.yoop - " filename prefix the headers open with.
  if (doc.length) doc[0] = doc[0].replace(/^std\/[\w/.]+\s*-\s*/, "");
  return doc.join("\n").trim();
}

function buildStdData() {
  const stdRoot = path.join(repoRoot, "std");
  const files = walkYoopFiles(stdRoot).sort();

  // Group files into modules. A directory whose files declare `module x;` is
  // one module; every other .yoop file is a module on its own.
  const byModule = new Map();
  for (const abs of files) {
    const rel = path.relative(repoRoot, abs);
    const source = fs.readFileSync(abs, "utf8");
    const decl = moduleDeclOf(source);
    const importPath = decl ? path.relative(repoRoot, path.dirname(abs)) : rel;
    if (!byModule.has(importPath)) byModule.set(importPath, []);
    byModule.get(importPath).push({ abs, rel, isDirectoryModule: Boolean(decl) });
  }

  const modules = [];
  for (const [importPath, members] of [...byModule.entries()].sort()) {
    const isDir = members[0].isDirectoryModule;
    const exports = [];
    for (const member of members) exports.push(...collectExports(member.abs, member.rel));

    // std/core/vec.yoop groups under std/core; std/log.yoop is a top-level
    // module and groups under plain std with its single-file siblings.
    const segments = importPath.split("/");
    const area = segments.length > 2 ? segments.slice(0, 2).join("/") : "std";
    modules.push({
      importPath,
      name: path.basename(importPath, ".yoop"),
      area,
      isDirectoryModule: isDir,
      files: members.map((m) => m.rel),
      doc: moduleHeaderDoc(members[0].abs),
      exports: exports.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  const areas = [];
  for (const mod of modules) {
    let area = areas.find((a) => a.path === mod.area);
    if (!area) {
      area = { path: mod.area, blurb: MODULE_BLURBS[mod.area] ?? "", modules: [] };
      areas.push(area);
    }
    area.modules.push(mod.importPath);
  }

  // The flat top-level modules (std/log.yoop and friends) read best as a
  // closing group rather than interleaved where "std/debug.yoop" happens to
  // sort.
  areas.sort((a, b) => (a.path === "std") - (b.path === "std") || a.path.localeCompare(b.path));

  return {
    areas,
    modules,
    counts: {
      modules: modules.length,
      exports: modules.reduce((n, m) => n + m.exports.length, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// The three data builds
// ---------------------------------------------------------------------------

function buildTourData(tmpDir) {
  const episodes = [];
  for (const entry of TOUR) {
    const rel = `examples/tour/${entry.id}.yoop`;
    const abs = path.join(repoRoot, rel);
    const source = fs.readFileSync(abs, "utf8");
    log(`tour ${entry.id}`);
    const result = compileAndRun(rel, tmpDir);
    if (!result.compiled) {
      throw new Error(`tour program ${entry.id} does not compile:\n${result.diagnostic}`);
    }
    episodes.push({
      id: entry.id,
      num: episodes.length + 1,
      file: rel,
      source,
      output: result.output,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  return { episodes };
}

function buildBreakData(tmpDir) {
  const cards = [];
  for (const entry of BREAKS) {
    const abs = path.join(repoRoot, entry.file);
    if (!fs.existsSync(abs)) {
      throw new Error(`break-it card "${entry.id}" names ${entry.file}, which does not exist`);
    }
    log(`break ${entry.id}`);
    const result = compileAndRun(entry.file, tmpDir);
    if (result.compiled) {
      throw new Error(
        `break-it card "${entry.id}" names ${entry.file}, but that program COMPILED. ` +
          `A card is only honest if the diagnostic under it is real.`,
      );
    }
    cards.push({
      id: entry.id,
      episode: entry.episode,
      title: entry.title,
      note: entry.note,
      file: entry.file,
      source: fs.readFileSync(abs, "utf8"),
      diagnostic: result.diagnostic,
    });
  }
  return cards;
}

function buildPipelineData(tmpDir) {
  const samples = [];
  for (const entry of PIPELINE) {
    log(`pipeline ${entry.id}`);
    const abs = path.join(repoRoot, entry.file);
    const source = fs.readFileSync(abs, "utf8");
    const tokens = dumpTokens(entry.file);
    const ast = dumpAst(entry.file, tmpDir);
    const result = compileAndRun(entry.file, tmpDir, { wantIr: true });
    if (!result.compiled) {
      throw new Error(`pipeline sample ${entry.id} does not compile:\n${result.diagnostic}`);
    }
    samples.push({
      id: entry.id,
      title: entry.title,
      blurb: entry.blurb,
      file: entry.file,
      source,
      tokens,
      ast,
      ir: result.ir,
      output: result.output,
      exitCode: result.exitCode,
    });
  }
  return samples;
}

function buildStatusData() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  const countFiles = (dir, filter) => {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return 0;
    return walkYoopFiles(abs).filter(filter ?? (() => true)).length;
  };

  const lineCount = (dir) => {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return 0;
    let total = 0;
    for (const file of walkYoopFiles(abs)) {
      total += fs.readFileSync(file, "utf8").split("\n").length;
    }
    return total;
  };

  let commit = null;
  let commitDate = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    commitDate = execSync("git log -1 --format=%cs", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    // A tarball checkout has no git; the site just shows one fewer fact.
  }

  return {
    version: pkg.version,
    commit,
    commitDate,
    generatedAt: localDate(),
    stdModules: null, // filled in by the caller from the std build
    bootstrapFiles: countFiles("bootstrap/src"),
    bootstrapLines: lineCount("bootstrap/src"),
    exampleProgramsPass: fs.readdirSync(path.join(repoRoot, "examples/pass")).length,
    exampleProgramsFail: fs.readdirSync(path.join(repoRoot, "examples/fail")).length,
    specLines: readIfPresent("SPEC.md")?.split("\n").length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The landing page's one-word-of-difference demo
// ---------------------------------------------------------------------------

// Pull one brace-balanced block out of `text`, starting at the line that
// matches `startRe`. Works on Yoop source and on LLVM IR, which both close a
// body with a `}` in column zero or at the same nesting level.
function blockAt(text, startRe) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => startRe.test(line));
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") depth--;
    }
    if (seen && depth <= 0) break;
  }
  return out.join("\n");
}

// The landing page shows two functions that differ by one word, and the IR
// emitted for each. Everything comes out of the kinds pipeline sample, so the
// page cannot drift from what the compiler does.
function buildHomeData(pipelineSamples) {
  const sample = pipelineSamples.find((s) => s.id === "kinds");
  if (!sample) throw new Error("home data needs the `kinds` pipeline sample");

  const pick = (fnName) => {
    const source = blockAt(sample.source, new RegExp(`^function ${fnName}\\(`));
    const ir = blockAt(sample.ir.text, new RegExp(`^define .*__${fnName}\\(`));
    if (!source || !ir) throw new Error(`home data: could not find ${fnName} in the kinds sample`);
    return { source, ir };
  };

  return {
    file: sample.file,
    plain: pick("plain"),
    kinded: pick("kinded"),
    output: sample.output,
  };
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

// Every heading on every page, every std export, every tour episode. Built by
// reading the pages themselves, so a section added to the reference shows up in
// search the next time this runs and never needs a second list maintained.
function buildSearchData(std, tour) {
  const entries = [];
  const seen = new Set();

  const add = (entry) => {
    const key = `${entry.href}|${entry.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  const pages = fs
    .readdirSync(webRoot)
    .filter((name) => name.endsWith(".html"))
    .sort();

  for (const page of pages) {
    const html = fs.readFileSync(path.join(webRoot, page), "utf8");
    const titleMatch = /<title>([^<]+)<\/title>/.exec(html);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s*\|.*$/, "").trim() : page;

    // Sections carry their id either on the heading or on the wrapper.
    const headingRe = /<(h2|h3)[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = headingRe.exec(html))) {
      const text = m[3]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      add({ title: text, where: pageTitle, href: `${page}#${m[2]}` });
    }
  }

  for (const mod of std.modules) {
    add({
      title: mod.importPath,
      where: "Standard library",
      href: `std.html#${encodeURIComponent(mod.importPath)}`,
      text: mod.doc.slice(0, 200),
    });
    for (const exp of mod.exports) {
      add({
        title: exp.name,
        where: `${exp.kind} in ${mod.importPath}`,
        href: `std.html#${encodeURIComponent(mod.importPath)}`,
        text: exp.signature,
      });
    }
  }

  for (const ep of tour.episodes) {
    add({
      title: `${ep.num}. ${ep.id}`,
      where: "The tour",
      href: `tour.html#${ep.id}`,
      text: ep.source.slice(0, 300),
    });
  }

  return { entries };
}

// ---------------------------------------------------------------------------
// Write it out
// ---------------------------------------------------------------------------

function writeData(name, value) {
  const file = path.join(dataRoot, `${name}.data.js`);
  const body =
    `// GENERATED by scripts/gen_web.mjs - do not edit by hand.\n` +
    `// Regenerate with: npm run gen:web\n` +
    `window.YOOP_DATA = window.YOOP_DATA || {};\n` +
    `window.YOOP_DATA.${name} = ${JSON.stringify(value, null, 1)};\n`;
  fs.writeFileSync(file, body);
  const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
  log(`wrote web/data/${name}.data.js (${kb} KB)`);
}

function main() {
  if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_genweb_"));

  try {
    const std = buildStdData();
    log(`std: ${std.counts.modules} modules, ${std.counts.exports} exports`);
    writeData("std", std);

    const tour = buildTourData(tmpDir);
    tour.breaks = buildBreakData(tmpDir);
    writeData("tour", tour);

    const pipeline = buildPipelineData(tmpDir);
    writeData("pipeline", { samples: pipeline });
    writeData("home", buildHomeData(pipeline));

    const status = buildStatusData();
    status.stdModules = std.counts.modules;
    status.stdExports = std.counts.exports;
    writeData("status", status);

    // Last, because it reads the pages, and the pages are what the rest of
    // this run's data feeds.
    writeData("search", buildSearchData(std, tour));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  log("done");
}

main();
