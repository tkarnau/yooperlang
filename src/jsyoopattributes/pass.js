// Post-typecheck attribute dispatch pass.
//
// Walks every module's AST, finds ATTRIBUTE nodes, looks up their
// handler in the registry, and runs the `comptimePhase` callback. All
// per-attribute behavior lives in the registry handlers; this pass only
// finds the nodes and dispatches.

import { ASTNodeKind } from "../contracts.js";
import { getAttributeHandler } from "./registry.js";

// Collects all ATTRIBUTE nodes reachable from any module's body.
// Includes attributes inside function bodies (block statements).
function collectAttributes(modules) {
  const out = [];
  for (const mod of modules) {
    walkNode(mod.ast, mod, out);
  }
  return out;
}

function walkNode(node, mod, out) {
  if (node == null || typeof node !== "object") return;
  if (node.kind === ASTNodeKind.ATTRIBUTE) {
    out.push({ node, moduleId: mod.id });
  }
  // Recurse into common container fields. We do this generically rather
  // than enumerate every AST node kind - the cost of a few extra
  // traversals on non-container fields is negligible vs the maintenance
  // burden of an exhaustive switch.
  for (const key of [
    "body", "decl", "fn", "target", "thenBody", "elseBody",
    "trueBranch", "falseBranch", "arms", "cases",
  ]) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walkNode(c, mod, out);
    } else if (child && typeof child === "object" && child.kind) {
      walkNode(child, mod, out);
    }
  }
}

// Runs the attribute pass. Mutates `errors` in place with any
// per-attribute diagnostics; returns nothing. The caller (driver) is
// responsible for surfacing errors before invoking codegen.
export function runAttributePass(modules, errors) {
  const collected = collectAttributes(modules);
  for (const { node, moduleId } of collected) {
    const handler = getAttributeHandler(node.name);
    if (!handler) {
      // Parser already validated registry membership; if we got here
      // with an unknown name something is internally inconsistent.
      errors.push({
        moduleId,
        sourceLoc: node.sourceLoc,
        message: `internal: attribute @${node.name} has no registry entry (parser should have rejected it)`,
      });
      continue;
    }
    if (handler.comptimePhase) {
      handler.comptimePhase(node, {
        error(targetNode, message) {
          errors.push({
            moduleId,
            sourceLoc: targetNode?.sourceLoc ?? node.sourceLoc,
            message,
          });
        },
      });
    }
  }
}
