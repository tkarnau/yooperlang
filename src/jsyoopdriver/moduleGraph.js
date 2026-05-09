import fs from "node:fs";
import path from "node:path";

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import { moduleIdFor } from "./moduleId.js";

// Loads the full module graph starting at entryAbsPath.
// Returns { entry: Module, modules: [Module] } where modules is topo-sorted
// leaves-first (so each module's dependencies appear before it).
//
// Each Module:
//   id: string               — stable module identifier
//   absPath: string          — canonicalized absolute path
//   src: string              — file contents
//   ast: ProgramNode
//   imports: [IMPORT_DECL]   — decls with resolvedAbsPath/resolvedModuleId set
export function loadModuleGraph(entryAbsPath) {
  const byPath = new Map(); // absPath -> Module
  const onStack = new Set(); // for cycle detection
  const order = []; // post-order (leaves first)

  loadOne(entryAbsPath);
  return { entry: byPath.get(entryAbsPath), modules: order };

  function loadOne(absPath) {
    if (onStack.has(absPath)) {
      throw new Error(`import cycle detected involving ${absPath}`);
    }
    if (byPath.has(absPath)) return byPath.get(absPath);
    onStack.add(absPath);

    const src = fs.readFileSync(absPath, "utf8");
    const ast = parse(src);
    const id = moduleIdFor(absPath);
    const mod = { id, absPath, src, ast, imports: [] };
    byPath.set(absPath, mod);

    for (const decl of ast.body) {
      if (decl.kind !== ASTNodeKind.IMPORT_DECL) break; // imports-first rule
      const sourcePath = decl.sourcePath;
      if (!sourcePath.endsWith(".yoop")) {
        throw new Error(`import path "${sourcePath}" must end in .yoop`);
      }
      if (
        !sourcePath.startsWith("./") &&
        !sourcePath.startsWith("../") &&
        !path.isAbsolute(sourcePath)
      ) {
        throw new Error(
          `import path "${sourcePath}" must be relative (./...) or absolute`,
        );
      }
      const resolved = path.resolve(path.dirname(absPath), sourcePath);
      let resolvedAbs;
      try {
        resolvedAbs = fs.realpathSync(resolved);
      } catch {
        throw new Error(
          `cannot resolve import "${sourcePath}" from ${absPath}: file not found`,
        );
      }
      const child = loadOne(resolvedAbs);
      decl.resolvedAbsPath = resolvedAbs;
      decl.resolvedModuleId = child.id;
      mod.imports.push(decl);
    }

    onStack.delete(absPath);
    order.push(mod);
    return mod;
  }
}
