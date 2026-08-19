// Detects recursive struct definitions that would have infinite size at
// codegen. A struct that directly or transitively contains itself by
// value is rejected; going through a `ref` breaks the cycle.

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
    // `fields` is null on a SHELL - pass A registers every struct name with
    // fields:null and pass C fills them in, so a struct referenced before its
    // own fields have been resolved arrives here unpopulated. Walking it threw
    // `fieldType.fields is not iterable`, which is a compiler CRASH on ordinary
    // code: a plain forward reference in one file (`type A { b: B }` above
    // `type B`) was enough, and modules-as-directories makes it unavoidable
    // because sibling files have no declaration order to fix it with.
    //
    // Returning false for a shell does not weaken detection. The check compares
    // struct NAMES, so for any cycle the LAST member whose fields get resolved
    // sees every other member populated and still closes the loop back to its
    // own name. Only the earlier members of the cycle skip the walk.
    for (const field of fieldType.fields ?? []) {
      if (detectRecursiveField(structName, field.type, visited)) {
        return true;
      }
    }
  }
  return false;
}
