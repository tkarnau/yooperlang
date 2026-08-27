// Which compiler the editor talks to, for a given folder.
//
// This is the one decision in the VS Code extension that is silently wrong
// when it is wrong. Every other mistake in there is loud - the server does not
// start, the log says so - but pointing a folder at the wrong compiler
// produces answers, and they look exactly like right ones. The failure it is
// really guarding is one direction in particular: the extension is normally
// symlinked out of the compiler checkout, so anything that resolves by "where
// am I installed from" hands every Yoop project on the machine the
// in-development compiler and the in-development std.
//
// The extension is not loaded by VS Code here, so `vscode` and the language
// client are stubbed. What is under test is a pure function of a directory
// layout and a settings object, which is exactly what makes it testable at all.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import Module from "node:module";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, "..");
const EXE = process.platform === "win32" ? "yoopiler_boot.exe" : "yoopiler_boot";

// What `vscode.workspace.getConfiguration` hands back, swapped per test.
let settings = {};

const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (key) => settings[key] || "" }),
    workspaceFolders: [],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getWorkspaceFolder: () => undefined,
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showErrorMessage() {},
    showWarningMessage() {},
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    activeTextEditor: undefined,
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  debug: {
    registerDebugConfigurationProvider: () => ({ dispose() {} }),
    registerDebugAdapterDescriptorFactory: () => ({ dispose() {} }),
  },
  StatusBarAlignment: { Right: 2 },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
};

// `vscode` only exists inside the editor, and the language client drags it in.
// Both are replaced before the extension is required.
const STUBS = new Map([
  ["vscode", vscodeStub],
  ["vscode-languageclient/node", { LanguageClient: class {}, TransportKind: { stdio: 1 } }],
]);
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (STUBS.has(request)) return STUBS.get(request);
  return realLoad.call(this, request, parent, isMain);
};

const { __test } = require_(path.join(REPO, "editors", "vscode", "extension.js"));
const { resolveServer, findCompilerCheckout, serverKey, serverSpawn } = __test;

Module._load = realLoad;

describe("the editor picks a compiler per folder", () => {
  let work;
  let checkout;
  let project;

  // Two folders of the kind a machine with this compiler on it really has: the
  // compiler's own checkout, and a program written in Yoop. Built out of the
  // markers the extension looks for rather than by copying the real tree, so
  // the test says what those markers ARE.
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-ext-"));
    checkout = path.join(work, "yooperlang");
    project = path.join(work, "my-yoop-app");

    fs.mkdirSync(path.join(checkout, "bootstrap", "src"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "bootstrap", "src", "main.yoop"), "");
    fs.mkdirSync(path.join(checkout, "std", "core"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "bootstrap", "src", "lsp"), { recursive: true });

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "main.yoop"), "");
  });

  after(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  const devBin = () => path.join(checkout, "build", "dev", "bin", EXE);
  const seedBin = () =>
    path.join(checkout, ".seed", "0.2.0", `yoopiler-boot-0.2.0-${process.platform}`, "bin", EXE);

  function writeBinary(p) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
  }

  it("knows a compiler checkout from a project written in Yoop", () => {
    assert.equal(findCompilerCheckout(checkout), checkout);
    assert.equal(findCompilerCheckout(project), null);
    // From a directory INSIDE it, which is how a folder is usually opened when
    // you are working on one layer of the compiler.
    assert.equal(findCompilerCheckout(path.join(checkout, "bootstrap", "src", "lsp")), checkout);
  });

  it("serves a checkout from its own build, against its own std", () => {
    settings = {};
    writeBinary(devBin());
    const server = resolveServer(checkout);
    assert.equal(server.mode, "dev");
    assert.equal(server.command, devBin());
    // FORCED, not merely defaulted. A compiler finds its std beside itself, and
    // one built into build/dev/bin has nothing beside it - without these the
    // server reports "standard library not found" on every line of every file.
    assert.equal(server.env.YOOP_STD_ROOT, path.join(checkout, "std"));
    assert.equal(server.env.YOOP_RUNTIME_ROOT, path.join(checkout, "runtime"));
  });

  it("falls back to the seed when the checkout has no build yet", () => {
    settings = {};
    fs.rmSync(path.join(checkout, "build"), { recursive: true, force: true });
    writeBinary(seedBin());
    const server = resolveServer(checkout);
    assert.equal(server.mode, "dev");
    assert.equal(server.command, seedBin());
    // A fresh clone gets a working server rather than an error, and is told
    // what it is getting: the previous release's answers, not this tree's.
    assert.match(server.why, /seed/i);
    assert.match(server.why, /npm run setup/);
  });

  it("says what to do when a checkout has neither", () => {
    settings = {};
    fs.rmSync(path.join(checkout, ".seed"), { recursive: true, force: true });
    const server = resolveServer(checkout);
    assert.equal(server.command, null);
    assert.match(server.why, /npm run setup/);
  });

  // THE REGRESSION THIS FILE EXISTS FOR. This extension normally lives inside
  // the compiler checkout, so resolving by install location hands a side
  // project the half-built compiler and the in-development std - quietly, and
  // for as long as nobody notices their program stopped agreeing with the
  // language it is written in.
  it("does not force a checkout's std onto a project that is not one", () => {
    settings = {};
    const server = resolveServer(project);
    assert.equal(server.mode, "stable");
    assert.deepEqual(
      server.env,
      {},
      "a released compiler was handed a std it was never built against",
    );
  });

  it("uses the released compiler a project points at", () => {
    const released = path.join(work, "installed", "bin", EXE);
    writeBinary(released);
    settings = { binaryPath: released };
    const server = resolveServer(project);
    assert.equal(server.mode, "stable");
    assert.equal(server.command, released);
    assert.deepEqual(server.env, {});
  });

  it("keeps the two settings apart", () => {
    // `binaryPath` is for a project and `devBinaryPath` is for a checkout, and
    // neither reaches the other. One setting for both would mean choosing which
    // of the two kinds of folder to get wrong.
    const released = path.join(work, "installed", "bin", EXE);
    const custom = path.join(work, "custom", "bin", EXE);
    writeBinary(custom);
    settings = { binaryPath: released, devBinaryPath: custom };
    assert.equal(resolveServer(project).command, released);
    assert.equal(resolveServer(checkout).command, custom);
  });

  it("gives the two folders different servers", () => {
    const released = path.join(work, "installed", "bin", EXE);
    const custom = path.join(work, "custom", "bin", EXE);
    settings = { binaryPath: released, devBinaryPath: custom };
    // The key is what decides whether two folders share a process. These two
    // must not, which is the whole point of resolving per folder.
    assert.notEqual(serverKey(resolveServer(checkout)), serverKey(resolveServer(project)));
    // And two folders inside the same checkout must, or a compiler with
    // several folders open runs a server per folder for no reason.
    assert.equal(
      serverKey(resolveServer(checkout)),
      serverKey(resolveServer(path.join(checkout, "bootstrap", "src", "lsp"))),
    );
  });

  it("lets an explicit std root win in a checkout", () => {
    const custom = path.join(work, "custom", "bin", EXE);
    const otherStd = path.join(work, "elsewhere", "std");
    settings = { devBinaryPath: custom, stdRoot: otherStd };
    const server = resolveServer(checkout);
    assert.equal(server.env.YOOP_STD_ROOT, otherStd);
    // The one that was NOT overridden still comes from the checkout.
    assert.equal(server.env.YOOP_RUNTIME_ROOT, path.join(checkout, "runtime"));
  });
});

// How the server is LAUNCHED, as opposed to which binary is chosen.
//
// This is a short list and it looks like it could not be wrong, but it was:
// naming a transport kind makes vscode-languageclient append an argument of
// its own, and the compiler exits 2 on an argument it does not know. The
// server then dies before the handshake, so every symptom is a client-side
// connection error and none of them name the flag that caused it.
//
// src/lsp.test.js spawns `--lsp` directly, so it cannot see a wrong argument
// list here; this is the only thing asserting what the editor really passes.
describe("the editor launches the server the way the compiler expects", () => {
  const server = { command: "/somewhere/yoopiler_boot", env: { YOOP_STD_ROOT: "/somewhere/std" } };

  it("passes the compiler exactly the flag it documents", () => {
    // Every flag here has to appear in the compiler's usage text. `--lsp` is
    // the whole of it: the server takes no options, and an extra one is fatal
    // rather than ignored.
    assert.deepEqual(serverSpawn(server).args, ["--lsp"]);
  });

  it("names no transport kind", () => {
    // The client turns a transport kind into a command-line flag (`--stdio`
    // for stdio) for a server that parses one. Leaving it undefined takes the
    // same spawn-and-use-the-pipes path without the flag.
    assert.ok(!("transport" in serverSpawn(server)));
  });

  it("hands the server its std roots on top of the ambient environment", () => {
    // The environment is how a checkout's server is aimed at that checkout's
    // std. Losing PATH along the way would break the clang the compiler shells
    // out to, so it is an overlay rather than a replacement.
    const env = serverSpawn(server).options.env;
    assert.equal(env.YOOP_STD_ROOT, "/somewhere/std");
    assert.equal(env.PATH, process.env.PATH);
  });
});
