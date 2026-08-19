// Tests for the completion provider's BUILTIN half.
//
// The scope-walking half (locals, params, module decls, imports) is covered
// end-to-end through the server in server.test.js, which drives real documents.
// What has no coverage there is the hardcoded `PRIM_TYPES` list: it is the
// one part of the LSP that restates a fact the typechecker already owns, and
// a comment saying "kept in sync" is not a mechanism.
//
// Drift there is easy to miss. The C-portable integer aliases (`c_int`,
// `c_size_t`, `c_ssize_t`, ...) are what every `extern "C"` block in std, the
// bootstrap and the examples is written in - so a missing name makes
// completion go quiet in exactly the position where a C signature is being
// typed, which is the position least likely to be remembered from memory.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { primTypeFromName } from "../jsyooptypecheck/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read the list out of the source rather than exporting it. The list is an
// implementation detail of the module, and a test that forced it to be public
// would be changing the code to suit the test.
function offeredPrimTypes() {
  const src = fs.readFileSync(path.join(here, "completion.js"), "utf8");
  const block = src.match(/const PRIM_TYPES = \[([\s\S]*?)\];/);
  assert.ok(block, "expected a PRIM_TYPES array literal in completion.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// Every spelling the typechecker resolves to a primitive. `primTypeFromName`
// is the authority - it runs the name through `canonicalize`, which is where
// `int`/`float` and the whole C_ALIASES_LP64 table live - but it answers about
// ONE name at a time and the table behind it is not exported. So the candidate
// set is written out here and filtered through it: a name that stops being a
// primitive drops out of `expected` on its own, and a name that is added to
// the language has to be added here, which is a line in a test rather than a
// silent gap in the editor.
const CANDIDATES = [
  "int8", "int16", "int32", "int64",
  "uint8", "uint16", "uint32", "uint64",
  "usize", "isize", "int",
  "float32", "float64", "float",
  "bool", "char", "string", "void",
  "c_short", "c_ushort", "c_int", "c_uint",
  "c_long", "c_ulong", "c_size_t", "c_ssize_t",
  // Plausible-but-not-real spellings, so this list is also a check that the
  // filter below is doing something rather than passing everything through.
  "byte", "rune", "uint", "c_float", "c_double",
];

describe("completion builtins", () => {
  it("offers every name the typechecker accepts as a primitive", () => {
    const expected = CANDIDATES.filter((n) => primTypeFromName(n) !== null);
    const offered = new Set(offeredPrimTypes());
    const missing = expected.filter((n) => !offered.has(n));
    assert.deepEqual(missing, [], `primitives missing from completion: ${missing.join(", ")}`);
  });

  it("offers nothing the typechecker would reject", () => {
    const bogus = offeredPrimTypes().filter((n) => primTypeFromName(n) === null);
    assert.deepEqual(bogus, [], `completion offers non-primitives: ${bogus.join(", ")}`);
  });

  // Guards the guard: if `primTypeFromName` ever started answering "yes" to
  // everything, both assertions above would pass vacuously.
  it("the candidate list really does contain non-primitives", () => {
    const rejected = CANDIDATES.filter((n) => primTypeFromName(n) === null);
    assert.ok(rejected.length > 0, "expected some candidates to be rejected");
  });
});
