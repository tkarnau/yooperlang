import crypto from "node:crypto";
import path from "node:path";

// Returns a stable, LLVM-symbol-safe identifier for a module: basename + short
// hash of the absolute path. Stable per-path, distinct across paths.
export function moduleIdFor(absPath) {
  const base = path.basename(absPath, ".yoop").replace(/[^a-zA-Z0-9_]/g, "_");
  const hash = crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 8);
  return `${base}_${hash}`;
}

// modules-as-directories: the id for a DIRECTORY module - every source file in
// the directory shares it, so it is what the typecheck env is keyed by and what
// symbols mangle against.
//
// Hashed from the resolved DIRECTORY path, because identity is the path and the
// declared `module <name>;` is only a label (see plans/modules-as-directories.md:
// two directories may declare the same name and remain two distinct modules).
// The label supplies the readable prefix so a mangled symbol still says which
// module it came from; the hash is what makes it unique.
export function directoryModuleIdFor(dirAbsPath, declaredName) {
  const base = (declaredName ?? path.basename(dirAbsPath)).replace(
    /[^a-zA-Z0-9_]/g,
    "_",
  );
  const hash = crypto
    .createHash("sha1")
    .update(dirAbsPath)
    .digest("hex")
    .slice(0, 8);
  return `${base}_${hash}`;
}
