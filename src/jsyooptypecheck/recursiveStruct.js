// Detects recursive struct definitions that would have infinite size at
// codegen. Until ref types are introduced (Phase 4), a struct that
// directly or transitively contains itself by value is rejected.

import { typeKinds } from "./types.js";

export function detectRecursiveField(structName, fieldType, visited = new Set()) {
  if (fieldType.kind === typeKinds.struct) {
    if (fieldType.name === structName) {
      return true;
    }
    // already visited this struct via another path; don't loop forever.
    if (visited.has(fieldType.name)) {
      return false;
    }
    visited.add(fieldType.name);
    for (const field of fieldType.fields) {
      if (detectRecursiveField(structName, field.type, visited)) {
        return true;
      }
    }
  }
  return false;
}
