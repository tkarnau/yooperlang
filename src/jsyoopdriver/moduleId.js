import crypto from "node:crypto";
import path from "node:path";

// Returns a stable, LLVM-symbol-safe identifier for a module: basename + short
// hash of the absolute path. Stable per-path, distinct across paths.
export function moduleIdFor(absPath) {
  const base = path.basename(absPath, ".yoop").replace(/[^a-zA-Z0-9_]/g, "_");
  const hash = crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 8);
  return `${base}_${hash}`;
}
