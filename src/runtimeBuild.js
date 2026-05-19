// Shared knowledge of where the C runtime lives and what platform flags it
// needs. Used by yoopiler.js (the user-facing driver) and the e2e tests so
// they stay in lockstep.

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

export const RUNTIME_C = path.resolve(
  path.dirname(__filename),
  "..",
  "runtime",
  "yoop_runtime.c",
);

export function runtimeLinkFlags() {
  return process.platform === "win32" ? [] : ["pthread"];
}
