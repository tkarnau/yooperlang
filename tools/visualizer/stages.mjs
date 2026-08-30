// The stage implementations behind POST /api/stage/run. Each one REALLY runs
// the compiler (or a tool built from it) at the moment the player asks, and
// normalizes the artifact into the shape SCHEMA.md pins down. Nothing here is
// cached across sessions except the dump_tokens binary, which is a build
// artifact like any other.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseIr, splitFunctions } from "./ir_parse.mjs";
import { typecheckViaLsp } from "./lsp_client.mjs";

const OUTPUT_CAP = 64 * 1024;

export function runCmd(cmd, args, { env, timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    proc.stdout.on("data", (d) => { if (stdout.length < OUTPUT_CAP * 4) stdout += d; });
    proc.stderr.on("data", (d) => { if (stderr.length < OUTPUT_CAP * 4) stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, wallMs: Date.now() - started, timedOut });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), wallMs: Date.now() - started, timedOut });
    });
  });
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function posToLineCol(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: pos - starts[lo] + 1 };
}

function clip(s) {
  if (s.length <= OUTPUT_CAP) return { text: s, truncated: false };
  return { text: s.slice(0, OUTPUT_CAP), truncated: true };
}

export function makeStages(ctx) {
  // ctx: { repoRoot, compiler, env, filePath, workDir }
  const stem = path.basename(ctx.filePath).replace(/\.yoop$/, "");
  const outBin = path.join(ctx.workDir, stem);
  const relToRepo = (p) => path.relative(ctx.repoRoot, p);
  const scrub = (s) => s.split(ctx.repoRoot + path.sep).join("");

  const readEntry = () => fs.readFileSync(ctx.filePath, "utf8");

  async function ensureDumpTokens() {
    const src = path.join(ctx.repoRoot, "bootstrap", "tools", "dump_tokens.yoop");
    const bin = path.join(ctx.workDir, "dump_tokens");
    const fresh = fs.existsSync(bin) &&
      fs.statSync(bin).mtimeMs > fs.statSync(src).mtimeMs;
    if (fresh) return bin;
    const r = await runCmd(ctx.compiler, [src, "-o", bin], { env: ctx.env });
    if (r.code !== 0) throw new Error(`building dump_tokens failed:\n${scrub(r.stderr)}`);
    return bin;
  }

  // Token tags name keywords outright (FUNCTION, CONST); the coarse color
  // bucket comes from the token's own first character in the source, which
  // needs no table of tag names.
  function bucketOf(tag, text) {
    if (tag === "IDENT") return "ident";
    if (tag === "EOF") return "other";
    const c = text[0] || "";
    if (/[0-9]/.test(c)) return "num";
    if (c === '"' || c === "'" || c === "`") return "str";
    if (/[A-Za-z_]/.test(c)) return "kw";
    return "punct";
  }

  const stages = {
    async source() {
      const text = readEntry();
      return {
        path: relToRepo(ctx.filePath),
        text,
        lines: text.split("\n").length,
        bytes: Buffer.byteLength(text),
      };
    },

    async lex() {
      const tool = await ensureDumpTokens();
      const r = await runCmd(tool, [ctx.filePath], { env: ctx.env });
      if (r.code !== 0) throw new Error(`dump_tokens failed:\n${scrub(r.stderr)}`);
      const text = readEntry();
      const starts = lineStarts(text);
      const tokens = [];
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)/);
        if (!m) continue;
        const [, tag, posStr, lenStr] = m;
        const pos = Number(posStr);
        const len = Number(lenStr);
        const tokText = text.slice(pos, pos + len);
        const { line: ln, col } = posToLineCol(starts, pos);
        tokens.push({ kind: bucketOf(tag, tokText), tag, text: tokText, pos, len, line: ln, col });
      }
      return { tokens };
    },

    async parse() {
      const astPath = path.join(ctx.workDir, `${stem}.ast.json`);
      const r = await runCmd(ctx.compiler, [ctx.filePath, "--dump-ast-json", astPath], { env: ctx.env });
      if (r.code !== 0) throw new Error(`parse failed:\n${scrub(r.stderr)}`);
      const dump = JSON.parse(fs.readFileSync(astPath, "utf8"));
      let nodeCount = 0;
      let maxDepth = 0;
      const normalize = (node, depth) => {
        nodeCount += 1;
        if (depth > maxDepth) maxDepth = depth;
        const out = {
          id: node.id,
          kind: node.kind,
          label: labelFor(node, dump.source),
          slot: node.label && node.label !== "undefined" ? node.label : "",
          span: node.loc
            ? { pos: node.loc.pos, length: node.loc.length, line: node.loc.line, col: node.loc.column + 1 }
            : null,
          children: (node.children || []).map((c) => normalize(c, depth + 1)),
        };
        return out;
      };
      return { ast: normalize(dump.ast, 0), nodeCount, maxDepth };
    },

    async modules() {
      return scanModules(ctx);
    },

    async typecheck() {
      try {
        return await typecheckViaLsp({
          compiler: ctx.compiler,
          env: ctx.env,
          filePath: ctx.filePath,
          text: readEntry(),
        });
      } catch (err) {
        // The LSP route gives symbols and types; a plain compile still gives
        // the verdict and the diagnostics when that route is unavailable.
        const r = await runCmd(ctx.compiler, [ctx.filePath, "-o", outBin, "--emit-ir"], { env: ctx.env });
        const diagnostics = [];
        for (const line of r.stderr.split("\n")) {
          const m = line.match(/^\[(error|warn)\] .*?:(\d+):(\d+): (.*)$/);
          if (m) {
            diagnostics.push({
              line: Number(m[2]),
              col: Number(m[3]),
              message: m[4],
              severity: m[1] === "error" ? "error" : "warning",
            });
          }
        }
        return { ok: r.code === 0, diagnostics, decls: [], lspError: String(err.message || err) };
      }
    },

    async codegen() {
      const r = await runCmd(ctx.compiler, [ctx.filePath, "-o", outBin, "--emit-ir"], { env: ctx.env });
      if (r.code !== 0) throw new Error(`codegen failed:\n${scrub(r.stderr)}`);
      const irPath = `${outBin}.ll`;
      const irText = fs.readFileSync(irPath, "utf8");
      const { user, std } = splitFunctions(parseIr(irText), stem);
      let instBudget = 8000;
      let truncated = false;
      for (const f of user) {
        for (const b of f.blocks) {
          if (instBudget <= 0) {
            b.instructions = [];
            truncated = true;
            continue;
          }
          if (b.instructions.length > instBudget) {
            b.instructions = b.instructions.slice(0, instBudget);
            truncated = true;
          }
          instBudget -= b.instructions.length;
        }
      }
      return {
        irPath,
        irBytes: Buffer.byteLength(irText),
        irLines: irText.split("\n").length,
        functions: user,
        truncated,
        stdFunctionCount: std.length,
        stdFunctions: std.slice(0, 400).map((f) => ({
          name: f.name,
          blocks: f.blocks.length,
          instructions: f.blocks.reduce((n, b) => n + b.instructions.length, 0),
        })),
      };
    },

    async link() {
      const r = await runCmd(ctx.compiler, [ctx.filePath, "-o", outBin], { env: ctx.env });
      if (r.code !== 0) throw new Error(`compile+link failed:\n${scrub(r.stderr)}`);
      return {
        outPath: outBin,
        sizeBytes: fs.statSync(outBin).size,
        wallMs: r.wallMs,
      };
    },

    async run() {
      if (!fs.existsSync(outBin)) throw new Error("nothing to run: the link stage has not produced a binary");
      const r = await runCmd(outBin, [], { env: ctx.env, timeoutMs: 20000, cwd: ctx.workDir });
      const so = clip(r.stdout);
      const se = clip(scrub(r.stderr));
      return {
        stdout: so.text,
        stderr: se.text,
        truncated: so.truncated || se.truncated,
        exitCode: r.timedOut ? null : r.code,
        timedOut: r.timedOut,
        wallMs: r.wallMs,
      };
    },
  };

  return stages;
}

// A short human name for an AST node. `fields.name` covers most; the dump
// omits a string-pool slot whose id is 0 (the file's first interned string,
// typically the first import's path), so an IMPORT_DECL with no `text` gets
// its path sliced back out of the source line instead.
function labelFor(node, source) {
  const f = node.fields || {};
  if (f.name) return f.name;
  if (f.text !== undefined) return f.text;
  if (node.kind === "IMPORT_DECL" && node.loc) {
    const lineEnd = source.indexOf("\n", node.loc.pos);
    const line = source.slice(node.loc.pos, lineEnd < 0 ? undefined : lineEnd);
    const m = line.match(/from\s*"([^"]+)"/);
    if (m) return m[1];
  }
  if (f.operator) return f.operator;
  if (f.intVal !== undefined) return f.intVal;
  return "";
}

// The module dependency graph, reconstructed by scanning `import ... from
// "..."` out of source text and resolving the paths the way the loader does:
// std/-rooted paths against the std root, relative paths against the
// importing file, an extensionless path as a DIRECTORY module (all its .yoop
// files except tests). The compiler has no graph dump; for a map on a wall,
// a source scan is the honest cheap substitute.
const IMPORT_RE = /(?:^|\n)\s*import\b[^;]*?\bfrom\s*"([^"]+)"/g;

function scanModules(ctx) {
  const stdRoot = ctx.env.YOOP_STD_ROOT || path.join(ctx.repoRoot, "std");
  const nodes = new Map();
  const edges = [];
  const edgeSeen = new Set();

  const rootOf = (absPath, isEntry) => {
    if (isEntry) return "main";
    const rel = path.relative(ctx.repoRoot, absPath);
    if (rel.startsWith("std" + path.sep) || absPath.startsWith(stdRoot + path.sep)) return "std";
    if (rel.startsWith("modules" + path.sep)) return "modules";
    return "local";
  };

  const filesOf = (absPath) => {
    const st = fs.existsSync(absPath) ? fs.statSync(absPath) : null;
    if (st?.isFile()) return [absPath];
    if (st?.isDirectory()) {
      return fs.readdirSync(absPath)
        .filter((f) => f.endsWith(".yoop") && !f.endsWith(".test.yoop"))
        .map((f) => path.join(absPath, f));
    }
    return [];
  };

  const resolveImport = (spec, fromDir) => {
    const base = spec.startsWith(".")
      ? path.resolve(fromDir, spec)
      : spec.startsWith("std/")
        ? path.resolve(stdRoot, spec.slice(4))
        : path.resolve(ctx.repoRoot, spec);
    if (fs.existsSync(base)) return base;
    if (!spec.endsWith(".yoop") && fs.existsSync(`${base}.yoop`)) return `${base}.yoop`;
    return null;
  };

  const visit = (absPath, isEntry) => {
    const id = path.relative(ctx.repoRoot, absPath);
    if (nodes.has(id)) return id;
    const files = filesOf(absPath);
    let loc = 0;
    for (const f of files) {
      try { loc += fs.readFileSync(f, "utf8").split("\n").length; } catch { /* unreadable file counts 0 lines */ }
    }
    nodes.set(id, {
      id,
      name: path.basename(absPath).replace(/\.yoop$/, ""),
      root: rootOf(absPath, isEntry),
      files: files.length,
      loc,
    });
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const m of text.matchAll(IMPORT_RE)) {
        const target = resolveImport(m[1], path.dirname(f));
        if (!target) continue;
        const targetId = visit(target, false);
        const key = `${id} -> ${targetId}`;
        if (!edgeSeen.has(key) && targetId !== id) {
          edgeSeen.add(key);
          edges.push({ from: id, to: targetId });
        }
      }
    }
    return id;
  };

  visit(path.resolve(ctx.filePath), true);
  return { nodes: [...nodes.values()], edges };
}
