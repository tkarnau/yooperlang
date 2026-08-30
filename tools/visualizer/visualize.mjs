#!/usr/bin/env node
// The interactive compilation explorer. Point it at a .yoop file and it
// serves a 3D world on localhost where each pipeline stage - lex, parse,
// module graph, typecheck, codegen, link, run - is a district that stays
// dark until the player walks up and pulls its lever, which runs the REAL
// compiler for that stage right then. A toy on purpose; the artifacts in it
// are not.
//
//   node tools/visualizer/visualize.mjs examples/pass/hello.yoop
//   node tools/visualizer/visualize.mjs file.yoop --port 7177 --no-open
//   node tools/visualizer/visualize.mjs file.yoop --compiler /path/yoopiler_boot
//
// Compiler resolution, first hit wins: --compiler, $YOOP_BOOT_COMPILER, the
// dev build (build/dev/bin/yoopiler_boot), the seed. Same philosophy as the
// editor extension: prefer the compiler built from this tree, fall back to a
// release rather than to nothing.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seedCompiler, seedEnv } from "../../scripts/seed.mjs";
import { makeStages } from "./stages.mjs";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolRoot, "..", "..");

const STAGE_ORDER = ["source", "lex", "parse", "modules", "typecheck", "codegen", "link", "run"];

function parseArgs(argv) {
  const opts = { port: 7177, open: true, compiler: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--no-open") opts.open = false;
    else if (a === "--compiler") opts.compiler = argv[++i];
    else if (a.startsWith("--")) fail(`unknown flag ${a}`);
    else if (opts.file) fail("exactly one input file");
    else opts.file = a;
  }
  if (!opts.file) fail("usage: node tools/visualizer/visualize.mjs <file.yoop> [--port N] [--no-open] [--compiler PATH]");
  return opts;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function resolveCompiler(flag) {
  if (flag) return { compiler: path.resolve(flag), compilerKind: "env" };
  if (process.env.YOOP_BOOT_COMPILER) {
    return { compiler: process.env.YOOP_BOOT_COMPILER, compilerKind: "env" };
  }
  const dev = path.join(repoRoot, "build", "dev", "bin", "yoopiler_boot");
  if (fs.existsSync(dev)) return { compiler: dev, compilerKind: "dev" };
  return { compiler: seedCompiler(), compilerKind: "seed" };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveFile(res, absPath) {
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(absPath)] || "application/octet-stream",
    // The viewer is edited live; a cached module is a lie about the tree.
    "Cache-Control": "no-cache",
  });
  res.end(fs.readFileSync(absPath));
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) fail(`${opts.file} does not exist`);
  const { compiler, compilerKind } = resolveCompiler(opts.compiler);
  const workDir = path.join(repoRoot, "build", "visualizer",
    path.basename(filePath).replace(/\.yoop$/, ""));
  fs.mkdirSync(workDir, { recursive: true });

  const ctx = { repoRoot, compiler, env: seedEnv(), filePath, workDir };
  const stages = makeStages(ctx);
  // What has run so far, kept so a browser refresh restores the world.
  const results = {};
  let running = null;

  const session = {
    file: path.relative(repoRoot, filePath),
    compiler,
    compilerKind,
    stages: STAGE_ORDER,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return serveFile(res, path.join(toolRoot, "viewer", "index.html"));
      }
      if (req.method === "GET" && url.pathname.startsWith("/viewer/")) {
        const rel = path.normalize(url.pathname.slice("/viewer/".length));
        if (rel.startsWith("..")) return void res.writeHead(403).end();
        return serveFile(res, path.join(toolRoot, "viewer", rel));
      }
      // three.module.js pulls in ./three.core.js relatively, so both live
      // under /vendor/.
      if (req.method === "GET" && (url.pathname === "/vendor/three.module.js" || url.pathname === "/vendor/three.core.js")) {
        return serveFile(res, path.join(toolRoot, "node_modules", "three", "build", path.basename(url.pathname)));
      }
      if (req.method === "GET" && url.pathname.startsWith("/vendor/addons/")) {
        const rel = path.normalize(url.pathname.slice("/vendor/addons/".length));
        if (rel.startsWith("..")) return void res.writeHead(403).end();
        return serveFile(res, path.join(toolRoot, "node_modules", "three", "examples", "jsm", rel));
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        return json(res, 200, session);
      }
      if (req.method === "GET" && url.pathname === "/api/scene") {
        return json(res, 200, { session, results });
      }
      if (req.method === "DELETE" && url.pathname === "/api/scene") {
        for (const k of Object.keys(results)) delete results[k];
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/stage/run") {
        const { stage } = await readBody(req);
        const idx = STAGE_ORDER.indexOf(stage);
        if (idx < 0) return json(res, 400, { ok: false, error: `unknown stage ${stage}` });
        const missing = STAGE_ORDER.slice(0, idx).filter((s) => !results[s]);
        if (missing.length > 0) {
          return json(res, 409, {
            ok: false,
            error: `${stage} needs ${missing.join(", ")} first - a pipeline is walked in order`,
          });
        }
        if (running) return json(res, 409, { ok: false, error: `${running} is still running` });
        running = stage;
        const started = Date.now();
        try {
          const data = await stages[stage]();
          const durationMs = Date.now() - started;
          results[stage] = { stage, ok: true, durationMs, data };
          console.error(`[stage] ${stage}: ok in ${durationMs}ms`);
          return json(res, 200, results[stage]);
        } catch (err) {
          console.error(`[stage] ${stage}: FAILED - ${err.message}`);
          return json(res, 200, { stage, ok: false, durationMs: Date.now() - started, error: String(err.message || err) });
        } finally {
          running = null;
        }
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      json(res, 500, { ok: false, error: String(err.message || err) });
    }
  });

  server.listen(opts.port, "127.0.0.1", () => {
    const addr = `http://127.0.0.1:${opts.port}/`;
    console.error(`yoop visualizer: ${session.file}`);
    console.error(`compiler (${compilerKind}): ${compiler}`);
    console.error(`world at ${addr} - Ctrl-C to stop`);
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [addr], { stdio: "ignore", detached: false }).on("error", () => {});
    }
  });
}

main();
