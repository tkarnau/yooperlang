// Yooperlang VS Code extension entry point.
//
// Two things wired up here:
// 1. LSP client - launches src/lsp/server.js as a Node child process over
//    stdio for diagnostics, hover, etc.
// 2. Debug adapter - registers the `yoop` debug type and delegates to the
//    system `lldb-dap` binary. The configuration provider compiles the .yoop
//    entry file with yoopiler before launch, then rewrites `program` from
//    the source path to the compiled binary path that lldb-dap expects.
// 3. The `@inspect` substrate panel - a read-only side view of the LLVM IR or
//    assembly a marked function compiles to. See substratePanel.js.

const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const substratePanel = require("./substratePanel");

let client;
let channel;

function log(...args) {
  if (channel) channel.appendLine(args.join(" "));
}

function activate(context) {
  channel = vscode.window.createOutputChannel("Yoopiler (extension)");
  context.subscriptions.push(channel);
  log("Yoopiler extension activating");

  // <repo>/editors/vscode/extension.js -> repo root is two levels up. Resolve
  // realpath first so a symlinked install under ~/.vscode/extensions doesn't
  // walk us out of the repo when joining `..`.
  const extDir = fs.realpathSync(__dirname);
  const repoRoot = path.resolve(extDir, "..", "..");
  const standaloneBin = findStandaloneBinary(extDir);
  if (standaloneBin) log("standalone yoopiler binary =", standaloneBin);

  startLspClient(context, repoRoot, standaloneBin);
  registerDebugger(context, repoRoot, standaloneBin);
  // Passed as a getter rather than a value: the client is created inside
  // startLspClient and starts asynchronously, so the panel has to read it at
  // command time rather than capture it at activation.
  substratePanel.register(context, () => client, log);
}

// Locate a packaged yoopiler binary, which lets this extension work with no
// repo checkout and no Node install. Two sources, in order:
//
//   1. The `yoopiler.binaryPath` setting, if the user set one.
//   2. A sibling binary, for the copy of this extension shipped inside a
//      distribution: <dist>/editor/vscode/ next to <dist>/bin/yoopiler_alpha.
//
// Returns null when neither is found, in which case we fall back to driving
// the repo's JS directly through Node (the checkout workflow).
function findStandaloneBinary(extDir) {
  const configured = vscode.workspace
    .getConfiguration("yoopiler")
    .get("binaryPath");
  if (configured && configured.length > 0) {
    if (fs.existsSync(configured)) return configured;
    vscode.window.showWarningMessage(
      `yoopiler.binaryPath is set to "${configured}" but nothing is there. Falling back to the repo checkout.`,
    );
  }
  const exe = process.platform === "win32" ? "yoopiler_alpha.exe" : "yoopiler_alpha";
  const sibling = path.resolve(extDir, "..", "..", "bin", exe);
  return fs.existsSync(sibling) ? sibling : null;
}

function startLspClient(context, repoRoot, standaloneBin) {
  try {
    const serverModule = path.join(repoRoot, "src", "lsp", "server.js");

    // Prefer the repo's server.js when it exists (edits to the compiler show
    // up without a rebuild); otherwise drive the packaged binary's `--lsp`
    // mode, which serves the identical protocol from the bundled compiler.
    let serverOptions;
    if (fs.existsSync(serverModule)) {
      log("lsp serverModule =", serverModule);
      serverOptions = {
        run: { module: serverModule, transport: TransportKind.stdio },
        debug: {
          module: serverModule,
          transport: TransportKind.stdio,
          options: { execArgv: ["--inspect=6009"] },
        },
      };
    } else if (standaloneBin) {
      log("lsp via standalone binary =", standaloneBin, "--lsp");
      const spawn = {
        command: standaloneBin,
        args: ["--lsp"],
        transport: TransportKind.stdio,
      };
      serverOptions = { run: spawn, debug: spawn };
    } else {
      const msg =
        `Yoopiler LSP: no language server found. Looked for ${serverModule} ` +
        `and a packaged binary. Set "yoopiler.binaryPath" to your yoopiler_alpha binary.`;
      log(msg);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const clientOptions = {
      documentSelector: [{ scheme: "file", language: "yoop" }],
      synchronize: {},
    };

    client = new LanguageClient(
      "yoopilerLsp",
      "Yoopiler LSP",
      serverOptions,
      clientOptions,
    );

    client.start().then(
      () => log("Yoopiler LSP client started"),
      (err) => {
        log("Yoopiler LSP client failed to start:", err && err.stack ? err.stack : String(err));
        vscode.window.showErrorMessage(`Yoopiler LSP failed to start: ${err && err.message ? err.message : err}`);
      },
    );

    context.subscriptions.push({
      dispose: () => {
        if (client) client.stop();
      },
    });
  } catch (err) {
    log("activate() threw:", err && err.stack ? err.stack : String(err));
    vscode.window.showErrorMessage(`Yoopiler extension failed to activate: ${err && err.message ? err.message : err}`);
  }
}

function registerDebugger(context, repoRoot, standaloneBin) {
  const provider = new YoopConfigurationProvider(repoRoot, standaloneBin);
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
  constructor(repoRoot, standaloneBin) {
    this.repoRoot = repoRoot;
    this.standaloneBin = standaloneBin;
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
        // Three ways to reach a compiler, most explicit first: a launch-config
        // override, the repo's yoopiler.js run under Node, or a packaged
        // binary invoked directly (no Node involved).
        const override = config.yoopilerPath
          ? path.resolve(folder?.uri?.fsPath ?? process.cwd(), config.yoopilerPath)
          : null;
        const repoScript = path.join(this.repoRoot, "src", "yoopiler.js");
        let compiler = null;
        if (override) {
          compiler = { path: override, viaNode: override.endsWith(".js") };
        } else if (fs.existsSync(repoScript)) {
          compiler = { path: repoScript, viaNode: true };
        } else if (this.standaloneBin) {
          compiler = { path: this.standaloneBin, viaNode: false };
        }
        if (!compiler || !fs.existsSync(compiler.path)) {
          vscode.window.showErrorMessage(
            `No yoopiler found (looked at ${override ?? repoScript}). Set "yoopilerPath" in your launch config or "yoopiler.binaryPath" in settings.`,
          );
          return undefined;
        }
        log(`compiling ${yoopFile} via ${compiler.path}`);
        const ok = await runYoopiler(compiler, yoopFile);
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
function runYoopiler(compiler, entryAbs) {
  return new Promise((resolve) => {
    const [cmd, args] = compiler.viaNode
      ? [process.execPath, [compiler.path, entryAbs]]
      : [compiler.path, [entryAbs]];
    const proc = cp.spawn(cmd, args, {
      cwd: path.dirname(entryAbs),
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
  if (!client) return undefined;
  return client.stop();
}

module.exports = { activate, deactivate };
