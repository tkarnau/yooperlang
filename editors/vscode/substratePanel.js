// The `@inspect` side panel: a read-only view of the LLVM IR or assembly a
// marked function compiled to, opened beside the source and kept in sync with
// the cursor.
//
// Hover already answers "what did THIS line become" in a popup. The panel
// answers the question a popup cannot: "where does this line sit in the whole
// function". So it shows the entire `define` (or the whole asm body) and
// highlights the rows belonging to whatever line the cursor is on - move the
// cursor in the source and the highlight tracks it.
//
// The content is served through a TextDocumentContentProvider on a custom
// scheme rather than written to a temp file. That gets read-only for free, and
// keeps IR that was never on disk from looking like a file the user should
// save or check in.

const vscode = require("vscode");

const SCHEME = "yoop-substrate";

// Highlight for the rows the cursor's source line produced. A background wash
// plus a gutter-side border, both from the theme, so it stays legible in light
// and dark without hardcoding a color.
const HIGHLIGHT = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
  borderColor: new vscode.ThemeColor("editorCursor.foreground"),
  borderWidth: "0 0 0 2px",
  borderStyle: "solid",
  isWholeLine: true,
});

// One open panel. A second `yoop.showSubstrate` replaces it rather than piling
// up editors - the panel is a lens on the current cursor, not a document you
// collect.
let openPanel = null; // { uri, sourceUri, declLine, mode, content, highlight }

class SubstrateContentProvider {
  constructor() {
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.onDidChangeEmitter.event;
  }

  provideTextDocumentContent(uri) {
    if (openPanel && uri.toString() === openPanel.uri.toString()) {
      return openPanel.content;
    }
    return "";
  }

  refresh(uri) {
    this.onDidChangeEmitter.fire(uri);
  }
}

// Ask the server for a function's substrate. Returns the response, or a
// synthetic error object if the request itself failed.
async function fetchSubstrate(client, { sourceUri, declLine, mode, focusLine }) {
  try {
    const result = await client.sendRequest("yoop/substrate", {
      textDocument: { uri: sourceUri.toString() },
      declLine,
      mode,
      focusLine,
    });
    return result ?? { error: "no response from the language server" };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

// The virtual document URI for one (function, mode) pair. The path carries a
// readable name and an extension VSCode can syntax-highlight, and the query
// disambiguates so two functions never collide.
function panelUri(name, mode, sourceUri, declLine) {
  const ext = mode === "asm" ? "s" : "ll";
  return vscode.Uri.parse(
    `${SCHEME}:${name}.${ext}?src=${encodeURIComponent(sourceUri.toString())}&line=${declLine}&mode=${mode}`,
  );
}

// The 1-based source line the cursor is on in `sourceUri`, or null if that
// document is not currently visible.
function cursorLineFor(sourceUri) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === sourceUri.toString()) {
      return editor.selection.active.line + 1;
    }
  }
  return null;
}

// Paint the highlight onto whichever editor is showing the panel.
function applyHighlight(rows) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== SCHEME) continue;
    if (!openPanel || editor.document.uri.toString() !== openPanel.uri.toString()) {
      continue;
    }
    const ranges = (rows ?? [])
      .filter((r) => r >= 0 && r < editor.document.lineCount)
      .map((r) => editor.document.lineAt(r).range);
    editor.setDecorations(HIGHLIGHT, ranges);
    // Keep the first highlighted row on screen. `revealRange` is a no-op when
    // it is already visible, so this does not fight the user's scrolling.
    if (ranges.length > 0) {
      editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
}

function register(context, getClient, log) {
  const provider = new SubstrateContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
  );
  context.subscriptions.push(HIGHLIGHT);

  // Invoked by the code lens the server puts above each `@inspect`ed function,
  // and available from the command palette against the cursor's function.
  context.subscriptions.push(
    vscode.commands.registerCommand("yoop.showSubstrate", async (args) => {
      const client = getClient();
      if (!client) {
        vscode.window.showErrorMessage("Yoopiler LSP is not running.");
        return;
      }
      if (!args || args.declLine == null) {
        vscode.window.showErrorMessage(
          "Yoopiler: no @inspect function here. Put the cursor inside a function marked with @inspect(ir) or @inspect(asm).",
        );
        return;
      }
      const sourceUri = vscode.Uri.parse(args.uri);
      const focusLine = cursorLineFor(sourceUri);
      const result = await fetchSubstrate(client, {
        sourceUri,
        declLine: args.declLine,
        mode: args.mode,
        focusLine,
      });
      if (result.error) {
        vscode.window.showWarningMessage(`@inspect: ${result.error}`);
        return;
      }

      const uri = panelUri(args.name ?? result.name ?? "function", args.mode, sourceUri, args.declLine);
      openPanel = {
        uri,
        sourceUri,
        declLine: args.declLine,
        mode: args.mode,
        name: args.name ?? result.name,
        content: result.text,
        highlight: result.highlight ?? [],
      };
      provider.refresh(uri);

      const doc = await vscode.workspace.openTextDocument(uri);
      // The `.ll` / `.s` extension is usually enough, but set the language
      // explicitly so highlighting works even without an LLVM extension
      // installed that claims those extensions.
      await vscode.languages.setTextDocumentLanguage(
        doc,
        args.mode === "asm" ? "asm" : "llvm",
      ).then(undefined, () => {
        // Neither language id is guaranteed to be registered. Plain text is a
        // fine fallback and not worth an error popup.
      });
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
      });
      applyHighlight(openPanel.highlight);
      log(`substrate panel: ${args.mode} for ${openPanel.name} (line ${args.declLine})`);
    }),
  );

  // Track the cursor: as it moves through the marked function, re-highlight.
  // Only fires work when a panel is actually open on that source file, so this
  // costs nothing in the normal case.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (event) => {
      if (!openPanel) return;
      if (event.textEditor.document.uri.toString() !== openPanel.sourceUri.toString()) {
        return;
      }
      const client = getClient();
      if (!client) return;
      const focusLine = event.selections[0].active.line + 1;
      const result = await fetchSubstrate(client, {
        sourceUri: openPanel.sourceUri,
        declLine: openPanel.declLine,
        mode: openPanel.mode,
        focusLine,
      });
      if (result.error) return;
      // The function's own text can change under an edit, so refresh content
      // as well as the highlight rather than assuming only rows moved.
      if (result.text !== openPanel.content) {
        openPanel.content = result.text;
        provider.refresh(openPanel.uri);
      }
      openPanel.highlight = result.highlight ?? [];
      applyHighlight(openPanel.highlight);
    }),
  );

  // Drop the panel when its editor closes so a stale one is not refreshed
  // forever in the background.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (openPanel && doc.uri.toString() === openPanel.uri.toString()) {
        openPanel = null;
      }
    }),
  );
}

module.exports = { register, SCHEME };
