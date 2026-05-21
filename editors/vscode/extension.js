// Yooperlang VS Code extension entry point.
//
// Launches the LSP server (src/lsp/server.js in the repo) as a child Node
// process over stdio and wires it to the standard vscode-languageclient.

const path = require("path");
const fs = require("fs");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;
let channel;

function log(...args) {
  if (channel) channel.appendLine(args.join(" "));
}

function activate(context) {
  channel = vscode.window.createOutputChannel("Yoopiler LSP (extension)");
  context.subscriptions.push(channel);
  log("Yoopiler extension activating");

  try {
    // The server lives at <repo>/src/lsp/server.js. The extension lives at
    // <repo>/editors/vscode/. When installed via a symlink under
    // ~/.vscode/extensions, `__dirname` is the symlink path — joining `..`
    // against it would walk out of ~/.vscode instead of out of the repo.
    // Resolve the real directory first so the server path is repo-anchored.
    const extDir = fs.realpathSync(__dirname);
    const serverModule = path.join(extDir, "..", "..", "src", "lsp", "server.js");
    log("extDir =", extDir);
    log("serverModule =", serverModule);

    if (!fs.existsSync(serverModule)) {
      const msg = `Yoopiler LSP: server file not found at ${serverModule}`;
      log(msg);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const serverOptions = {
      run: { module: serverModule, transport: TransportKind.stdio },
      debug: {
        module: serverModule,
        transport: TransportKind.stdio,
        options: { execArgv: ["--inspect=6009"] },
      },
    };

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

function deactivate() {
  if (!client) return undefined;
  return client.stop();
}

module.exports = { activate, deactivate };
