// Shared knowledge of where the C runtime lives and what platform flags it
// needs. Used by yoopiler.js (the user-facing driver) and the e2e tests so
// they stay in lockstep.

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const runtimeDir = path.resolve(path.dirname(__filename), "..", "runtime");

// Primary runtime translation unit. Kept as a single string for backwards
// compatibility with call sites that don't know about extra runtime files
// (e.g. older e2e helpers that pass a single -c arg).
export const RUNTIME_C = path.resolve(runtimeDir, "yoop_runtime.c");

// Phase 8.F.2: the I/O multiplexer lives in its own translation unit so
// programs that don't use it still link cleanly. Callers that need full
// runtime functionality should compile every entry in this list.
export const RUNTIME_SOURCES = [
  RUNTIME_C,
  path.resolve(runtimeDir, "yoop_io.c"),
];

export function runtimeLinkFlags() {
  return process.platform === "win32" ? [] : ["pthread"];
}
