// Yooperlang VS Code extension entry point.
//
// Two things wired up here:
// 1. LSP client - launches `yoopiler_boot --lsp` over stdio. The server is the
//    COMPILER, so what it reports is what a build reports.
// 2. Debug adapter - registers the `yoop` debug type and delegates to the
//    system `lldb-dap` binary. The configuration provider compiles the .yoop
//    entry file with yoopiler before launch, then rewrites `program` from
//    the source path to the compiled binary path that lldb-dap expects.

const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

// One entry per RUNNING server, keyed by what makes two of them the same. See
// resolveServer() for why there can be more than one.
const clients = new Map();
let channel;
let status;

// This file's own directory, resolved through any symlink. An install under
// ~/.vscode/extensions is normally a symlink into a checkout, and joining `..`
// against the link rather than its target walks out of the tree.
//
// Module scope rather than set in activate(), because `findReleaseCompiler`
// reads it and nothing should depend on activate() having run first.
const extDir = fs.realpathSync(__dirname);

function log(...args) {
  if (channel) channel.appendLine(args.join(" "));
}

function activate(context) {
  channel = vscode.window.createOutputChannel("Yoopiler (extension)");
  context.subscriptions.push(channel);
  log("Yoopiler extension activating");

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "yoopiler.showLog";
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("yoopiler.showLog", () => channel.show(true)),
    // Rebuilding the compiler leaves a running server that is the OLD binary,
    // because a server is spawned once and held. This is the alternative to
    // reloading the whole window for it.
    vscode.commands.registerCommand("yoopiler.restartServer", async () => {
      log("restarting language servers on request");
      await stopAllClients();
      syncClients(context);
    }),
  );

  syncClients(context);

  context.subscriptions.push(
    // A folder added or removed can change which compiler serves what, so the
    // set of servers is recomputed rather than left as it was at startup.
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncClients(context)),
    // Every setting this reads is a server setting, so a change to one means
    // the server it describes has to be replaced.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yoopiler")) {
        log("yoopiler settings changed, restarting language servers");
        stopAllClients().then(() => syncClients(context));
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    { dispose: () => stopAllClients() },
  );

  registerDebugger(context, extDir);
}

// ----- which compiler serves which folder ------------------------------------

/*
  TWO MODES, and the folder you have open is what picks between them.

  A machine that has this compiler on it has two completely different kinds of
  Yoop folder on it, and they want opposite things from a language server:

    THE COMPILER'S OWN CHECKOUT wants the compiler built from THAT TREE, reading
    THAT TREE's std and C runtime. Anything else is answering questions about a
    language other than the one you are editing.

    ANY OTHER YOOP PROJECT wants a RELEASED compiler and the std packaged with
    it. Pointing it at a checkout means your side project breaks every time you
    break the compiler, which is most of the time - that is what working on a
    compiler is.

  So resolution is per WORKSPACE FOLDER and not per extension install. Doing it
  by install is the trap it looks like it is not: this extension is normally
  symlinked out of the compiler checkout, so "where am I installed from" answers
  "the compiler checkout" for every folder on the machine - and every side
  project silently gets the half-built compiler and the in-development std.

  Folders that resolve to the same command and environment SHARE a server;
  folders that do not each get their own. One window with both kinds of folder
  in it therefore runs two, which is the point.
*/

// The markers that say a directory is a compiler checkout rather than a project
// written in Yoop. All three, because any one of them alone is something an
// ordinary project could plausibly have - a `std` directory most of all.
const CHECKOUT_MARKERS = [
  path.join("bootstrap", "src", "main.yoop"),
  path.join("std", "core"),
  "runtime",
];

// The checkout `startDir` is inside, or null. Walks up, so opening
// `bootstrap/src/lsp/` as the folder still finds it.
function findCompilerCheckout(startDir) {
  let dir = startDir;
  for (;;) {
    if (CHECKOUT_MARKERS.every((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/*
  What server one folder should get: the command, the environment, and why.

  `why` is not decoration. Which compiler is answering is the single most
  confusing thing about running two of them, so every path through here records
  the reason in one sentence, and it is what the status bar tooltip and the log
  both show.
*/
function resolveServer(folderPath, scopeUri) {
  const cfg = vscode.workspace.getConfiguration("yoopiler", scopeUri);
  const stdOverride = cfg.get("stdRoot");
  const runtimeOverride = cfg.get("runtimeRoot");
  const checkout = findCompilerCheckout(folderPath);

  if (checkout) {
    const dev = findDevCompiler(cfg, checkout);
    return {
      mode: "dev",
      checkout,
      command: dev.path,
      // Forced, not merely defaulted. A compiler finds its std beside itself,
      // and one built out of a checkout has nothing beside it - so without
      // these the server reports "standard library not found" on every line.
      env: {
        YOOP_STD_ROOT: stdOverride || path.join(checkout, "std"),
        YOOP_RUNTIME_ROOT: runtimeOverride || path.join(checkout, "runtime"),
      },
      why: dev.why,
    };
  }

  // Not a checkout: a project written in Yoop. Its compiler brings its own std,
  // and forcing one on it is how a released compiler gets handed a std it was
  // never built against.
  const env = {};
  if (stdOverride) env.YOOP_STD_ROOT = stdOverride;
  if (runtimeOverride) env.YOOP_RUNTIME_ROOT = runtimeOverride;
  const rel = findReleaseCompiler(cfg);
  return { mode: "stable", checkout: null, command: rel.path, env, why: rel.why };
}

/*
  The compiler to use INSIDE a checkout, in order.

  The seed is the fallback that matters. A fresh clone has no build yet, and a
  language server that says "no compiler" until you have run a build is one you
  turn off. The seed is a real compiler for the previous release, so it is
  right about nearly everything and wrong only about whatever the tree changed
  since - which the log says out loud.
*/
function findDevCompiler(cfg, checkout) {
  const configured = cfg.get("devBinaryPath");
  if (configured) {
    if (fs.existsSync(configured)) {
      return { path: configured, why: `yoopiler.devBinaryPath` };
    }
    return {
      path: null,
      why: `yoopiler.devBinaryPath is set to "${configured}", and nothing is there`,
    };
  }

  const exe = process.platform === "win32" ? "yoopiler_boot.exe" : "yoopiler_boot";
  const built = path.join(checkout, "build", "dev", "bin", exe);
  if (fs.existsSync(built)) {
    return { path: built, why: "the compiler built from this checkout (npm run setup)" };
  }

  const seed = findSeedBinary(path.join(checkout, ".seed"), exe);
  if (seed) {
    return {
      path: seed,
      why: "the bootstrap SEED - this checkout has no build yet, so answers are the "
        + "previous release's. Run `npm run setup` to build this tree's compiler",
    };
  }
  return {
    path: null,
    why: "this checkout has neither a build nor a seed - run `npm run setup`",
  };
}

// The compiler to use OUTSIDE a checkout, in order: what the user set, the copy
// shipped beside this extension inside a distribution, then PATH.
function findReleaseCompiler(cfg) {
  const configured = cfg.get("binaryPath");
  if (configured) {
    if (fs.existsSync(configured)) return { path: configured, why: "yoopiler.binaryPath" };
    return {
      path: null,
      why: `yoopiler.binaryPath is set to "${configured}", and nothing is there`,
    };
  }

  const exe = process.platform === "win32" ? "yoopiler_boot.exe" : "yoopiler_boot";
  const sibling = path.resolve(extDir, "..", "..", "bin", exe);
  if (fs.existsSync(sibling)) {
    return { path: sibling, why: "the compiler shipped beside this extension" };
  }

  const onPath = findOnPath(exe);
  if (onPath) return { path: onPath, why: `${exe} on PATH` };

  return {
    path: null,
    why: "no released compiler found - set yoopiler.binaryPath, or put yoopiler_boot on PATH",
  };
}

// The first `yoopiler_boot` under a `.seed` cache, whose layout is
// `.seed/<version>/yoopiler-boot-<version>-<platform>/bin/`. Searched rather
// than constructed so a cache holding more than one version still answers.
function findSeedBinary(seedRoot, exe) {
  let entries;
  try {
    entries = fs.readdirSync(seedRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(seedRoot, e.name);
    const direct = path.join(full, "bin", exe);
    if (fs.existsSync(direct)) return direct;
    const nested = findSeedBinary(full, exe);
    if (nested) return nested;
  }
  return null;
}

function findOnPath(exe) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, exe);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // Not there, or not readable. Either way it is not the compiler.
    }
  }
  return null;
}

// Two folders share a server exactly when they would spawn the same process
// with the same environment. Anything else and they get one each.
function serverKey(server) {
  return `${server.command}\u0000${JSON.stringify(server.env)}`;
}

// ----- the servers -----------------------------------------------------------

/*
  Bring the running servers into line with the folders that are open.

  Recomputed from scratch on every trigger rather than patched: the inputs are a
  folder list and a settings object, both small, and a diff of two maps is
  easier to be right about than a sequence of edits to one.
*/
function syncClients(context) {
  const wanted = new Map();
  const folders = vscode.workspace.workspaceFolders || [];

  if (folders.length === 0) {
    // No folder open, so there is nothing to resolve FROM. This is the loose
    // file case, and the extension's own location is the only hint available.
    const server = resolveServer(path.resolve(extDir, "..", ".."), undefined);
    wanted.set(serverKey(server), {
      server,
      selector: [{ scheme: "file", language: "yoop" }],
      names: ["(no folder open)"],
    });
  }

  for (const folder of folders) {
    const server = resolveServer(folder.uri.fsPath, folder.uri);
    const key = serverKey(server);
    const filter = {
      scheme: "file",
      language: "yoop",
      pattern: new vscode.RelativePattern(folder, "**/*.yoop"),
    };
    const existing = wanted.get(key);
    if (existing) {
      existing.selector.push(filter);
      existing.names.push(folder.name);
    } else {
      wanted.set(key, { server, selector: [filter], names: [folder.name] });
    }
  }

  for (const [key, entry] of [...clients]) {
    if (!wanted.has(key)) {
      log("stopping the server for", entry.server.command);
      entry.client.stop().catch(() => {});
      clients.delete(key);
    }
  }

  for (const [key, want] of wanted) {
    if (!clients.has(key)) startClient(context, key, want);
  }

  updateStatus();
}

function startClient(context, key, want) {
  const { server, selector, names } = want;
  if (!server.command) {
    log(`no compiler for ${names.join(", ")}: ${server.why}`);
    vscode.window.showErrorMessage(`Yoopiler: ${server.why}`);
    return;
  }

  log(`server for ${names.join(", ")} [${server.mode}]`);
  log(`  binary  ${server.command}`);
  log(`  because ${server.why}`);
  if (server.env.YOOP_STD_ROOT) {
    log(`  std     ${server.env.YOOP_STD_ROOT}`);
    log(`  runtime ${server.env.YOOP_RUNTIME_ROOT}`);
  } else {
    log("  std     left to the binary to find beside itself");
  }

  const spawn = {
    command: server.command,
    args: ["--lsp"],
    transport: TransportKind.stdio,
    options: { env: { ...process.env, ...server.env } },
  };
  const client = new LanguageClient(
    "yoopilerLsp",
    `Yoopiler LSP (${server.mode})`,
    { run: spawn, debug: spawn },
    { documentSelector: selector, synchronize: {} },
  );
  clients.set(key, { client, server });
  client.start().then(
    () => log(`  started`),
    (err) => {
      log("  failed to start:", err && err.stack ? err.stack : String(err));
      vscode.window.showErrorMessage(
        `Yoopiler LSP failed to start: ${err && err.message ? err.message : err}`,
      );
      clients.delete(key);
    },
  );
  context.subscriptions.push({ dispose: () => client.stop().catch(() => {}) });
}

function stopAllClients() {
  const stopping = [...clients.values()].map((e) => e.client.stop().catch(() => {}));
  clients.clear();
  return Promise.all(stopping);
}

// Which compiler is answering for the file in front of you. The one thing that
// is genuinely confusing about running several, so it gets a permanent place
// rather than a line in a log nobody opens.
function updateStatus() {
  if (!status) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "yoop") {
    status.hide();
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const from = folder ? folder.uri.fsPath : path.dirname(editor.document.uri.fsPath);
  const server = resolveServer(from, folder && folder.uri);
  if (!server.command) {
    status.text = "$(warning) Yoop: no compiler";
    status.tooltip = server.why;
  } else {
    status.text = server.mode === "dev" ? "$(tools) Yoop: dev" : "$(package) Yoop: release";
    status.tooltip =
      `${server.command}\n${server.why}` +
      (server.env.YOOP_STD_ROOT ? `\nstd: ${server.env.YOOP_STD_ROOT}` : "");
  }
  status.show();
}

function registerDebugger(context, extensionDir) {
  const provider = new YoopConfigurationProvider(extensionDir);
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("yoop", provider),
  );

  const factory = new YoopDebugAdapterDescriptorFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("yoop", factory),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("yoopiler.debugCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "yoop") {
        vscode.window.showErrorMessage("Open a .yoop file before invoking 'Debug Current File'.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      await vscode.debug.startDebugging(folder, {
        type: "yoop",
        request: "launch",
        name: `Debug ${path.basename(editor.document.fileName)}`,
        program: editor.document.uri.fsPath,
      });
    }),
  );
}

// Resolves a debug configuration: fills in defaults for F5-from-editor, then
// (in the substituted-variables pass) compiles the .yoop file and rewrites
// `program` to point at the resulting binary so lldb-dap launches it.
class YoopConfigurationProvider {
  // No binary is captured here. Which compiler to build with is the same
  // question the language server answers, and it has the same answer - so it
  // is asked per launch, against the folder being launched from.
  constructor(extensionDir) {
    this.extensionDir = extensionDir;
  }

  // First pass: VSCode hasn't substituted ${...} variables yet. If the user
  // pressed F5 with no launch.json entry, synthesize one from the active
  // editor.
  resolveDebugConfiguration(_folder, config) {
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === "yoop") {
        return {
          type: "yoop",
          request: "launch",
          name: `Debug ${path.basename(editor.document.fileName)}`,
          program: editor.document.uri.fsPath,
          stopOnEntry: false,
        };
      }
    }
    return config;
  }

  // Second pass: ${file}, ${workspaceFolder} etc. are resolved. Compile the
  // .yoop entry file with yoopiler, then swap `program` from the .yoop source
  // path to the compiled binary that lldb-dap will launch.
  async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    try {
      if (!config.program) {
        vscode.window.showErrorMessage("Yoopiler debug: `program` is required.");
        return undefined;
      }
      const yoopFile = path.resolve(folder?.uri?.fsPath ?? process.cwd(), config.program);
      if (!yoopFile.endsWith(".yoop")) {
        vscode.window.showErrorMessage(`Yoopiler debug: \`program\` must be a .yoop file, got ${yoopFile}`);
        return undefined;
      }

      // yoopiler runs every input through fs.realpathSync, so DWARF carries
      // the canonical path. If the user opened the file via a symlinked
      // path (common case: /tmp -> /private/tmp on macOS, or workspace
      // symlinks on Linux), the breakpoints VSCode sends use the symlink
      // path and lldb-dap will refuse to verify them. Map both directions.
      let realYoopFile = yoopFile;
      try { realYoopFile = fs.realpathSync(yoopFile); } catch (_e) { /* file may not exist yet */ }
      const sourceMap = Array.isArray(config.sourceMap) ? [...config.sourceMap] : [];
      if (realYoopFile !== yoopFile) {
        sourceMap.push([path.dirname(realYoopFile), path.dirname(yoopFile)]);
      }

      const binPath = yoopFile.replace(/\.yoop$/, "");
      if (!config.skipBuild) {
        // Which compiler, and with what std: the same question the language
        // server answers, so it gets the same answer. Debugging a program with
        // one compiler while the squiggles came from another is a difference
        // nobody would think to look for.
        //
        // A launch-config `yoopilerPath` still wins, because it is the most
        // explicit thing anyone can say.
        const override = config.yoopilerPath
          ? path.resolve(folder?.uri?.fsPath ?? process.cwd(), config.yoopilerPath)
          : null;
        const from = folder?.uri?.fsPath ?? path.dirname(yoopFile);
        const server = resolveServer(from, folder?.uri);
        const compiler = override
          ? { path: override, viaNode: override.endsWith(".js") }
          : { path: server.command, viaNode: false };
        if (!compiler.path || !fs.existsSync(compiler.path)) {
          vscode.window.showErrorMessage(
            override
              ? `No yoopiler at ${override} - check "yoopilerPath" in your launch config.`
              : `Yoopiler debug: ${server.why}`,
          );
          return undefined;
        }
        log(`compiling ${yoopFile} via ${compiler.path}`);
        const ok = await runYoopiler(compiler, yoopFile, override ? {} : server.env);
        if (!ok) {
          vscode.window.showErrorMessage("Yoopiler compile failed - see the Yoopiler output channel.");
          return undefined;
        }
      }
      if (!fs.existsSync(binPath)) {
        vscode.window.showErrorMessage(`Expected compiled binary at ${binPath} after build. Did the compile succeed?`);
        return undefined;
      }

      // lldb-dap reads these keys from the launch config: program (binary),
      // args, cwd, env, stopOnEntry, sourceMap. Replace `program` with the
      // built binary.
      return {
        ...config,
        program: binPath,
        args: Array.isArray(config.args) ? config.args : [],
        cwd: config.cwd || path.dirname(binPath),
        env: config.env || {},
        stopOnEntry: Boolean(config.stopOnEntry),
        sourceMap: sourceMap.length > 0 ? sourceMap : undefined,
      };
    } catch (err) {
      log("resolveDebugConfigurationWithSubstitutedVariables threw:", err && err.stack ? err.stack : String(err));
      vscode.window.showErrorMessage(`Yoopiler debug setup failed: ${err && err.message ? err.message : err}`);
      return undefined;
    }
  }
}

// Run the compiler and stream output to the extension log channel. Resolves
// to true on exit code 0. `compiler.viaNode` distinguishes a .js entry (run
// under VS Code's own Node) from a packaged binary (exec'd directly).
function runYoopiler(compiler, entryAbs, env = {}) {
  return new Promise((resolve) => {
    const [cmd, args] = compiler.viaNode
      ? [process.execPath, [compiler.path, entryAbs]]
      : [compiler.path, [entryAbs]];
    const proc = cp.spawn(cmd, args, {
      cwd: path.dirname(entryAbs),
      // The std and runtime roots, for the same reason the server gets them: a
      // compiler built out of a checkout has nothing packaged beside it.
      env: { ...process.env, ...env },
    });
    proc.stdout.on("data", (d) => log(`yoopiler: ${d.toString().trimEnd()}`));
    proc.stderr.on("data", (d) => log(`yoopiler!: ${d.toString().trimEnd()}`));
    proc.on("error", (err) => {
      log(`yoopiler spawn error: ${err.message}`);
      resolve(false);
    });
    proc.on("exit", (code) => {
      log(`yoopiler exited with code ${code}`);
      resolve(code === 0);
    });
  });
}

class YoopDebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(session, _executable) {
    const override = session.configuration.lldbDapPath;
    const lldbDap = override && override.length > 0 ? override : findLldbDap();
    if (!lldbDap) {
      vscode.window.showErrorMessage(
        "lldb-dap not found. On macOS run `xcode-select --install`, or set `lldbDapPath` in your launch config to point at an lldb-dap binary.",
      );
      return null;
    }
    log(`using lldb-dap at ${lldbDap}`);
    return new vscode.DebugAdapterExecutable(lldbDap, [], {});
  }
}

// Locate lldb-dap. Order: explicit env var, `xcrun --find` on macOS, common
// install paths, then a PATH lookup. Returns null if nothing usable is found.
function findLldbDap() {
  if (process.env.LLDB_DAP_PATH && fs.existsSync(process.env.LLDB_DAP_PATH)) {
    return process.env.LLDB_DAP_PATH;
  }
  if (process.platform === "darwin") {
    const xcrun = spawnCaptured("xcrun", ["--find", "lldb-dap"]);
    if (xcrun.status === 0) {
      const found = xcrun.stdout.trim();
      if (found && fs.existsSync(found)) return found;
    }
    const fallbackPaths = [
      "/Library/Developer/CommandLineTools/usr/bin/lldb-dap",
      "/usr/local/opt/llvm/bin/lldb-dap",
      "/opt/homebrew/opt/llvm/bin/lldb-dap",
    ];
    for (const p of fallbackPaths) if (fs.existsSync(p)) return p;
  }
  const which = process.platform === "win32" ? "where" : "which";
  const lookup = spawnCaptured(which, ["lldb-dap"]);
  if (lookup.status === 0) {
    const found = lookup.stdout.split(/\r?\n/)[0]?.trim();
    if (found && fs.existsSync(found)) return found;
  }
  return null;
}

function spawnCaptured(cmd, args) {
  try {
    const res = cp.spawnSync(cmd, args, { encoding: "utf8" });
    return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (_err) {
    return { status: 1, stdout: "", stderr: "" };
  }
}

function deactivate() {
  return stopAllClients();
}

module.exports = {
  activate,
  deactivate,
  // A NAMED TEST SEAM, and the only reason anything below activate() is
  // exported. Which compiler serves which folder is the one decision in this
  // file that is silently wrong when it is wrong - you get answers, they are
  // just from the wrong compiler - so it is checked in src/extension.test.js
  // rather than left to be noticed. Nothing at runtime reads this.
  __test: { resolveServer, findCompilerCheckout, serverKey },
};
