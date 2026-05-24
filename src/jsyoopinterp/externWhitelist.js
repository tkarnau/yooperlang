// Phase 11.D: comptime-allowed extern functions.
//
// The interpreter cannot call into real libc / OS extern functions at
// compile time — the user's program is being compiled, not run; the
// runtime doesn't exist yet. For *pure* externs whose behavior is
// trivially modeled in JS, we maintain a whitelist of implementations
// the comptime interpreter substitutes in at call sites. Anything
// outside this list surfaces as a comptime fallback (silent in the
// opportunistic module-init path; hard error under `@precompile`).
//
// Each entry's `impl` takes:
//   args      — wrapped values for each positional argument
//   sourceLoc — call-site source location (for error reporting)
//   returnType— the call's resolved yoop return type
// and returns a wrapped value of `returnType`. The implementation is
// responsible for unwrapping its JS payloads and producing a sensible
// JS result; the interpreter routes any thrown ComptimeError up to
// the comptime pass, which surfaces it (or silently falls back per
// the call mode).

import { typeKinds, isFloatPrim, isIntPrim } from "../jsyooptypecheck/types.js";
import { coerceNumeric } from "./values.js";
import { ComptimeError } from "./diagnostics.js";

// Wrap a raw JS value as a typed result for the given returnType.
// Centralizes the JS-number / BigInt / string / bool dispatch so impl
// functions stay simple ("return Math.sqrt(x.v)" etc.).
function wrapAs(returnType, raw) {
  if (returnType.kind === typeKinds.prim) {
    const name = returnType.name;
    if (name === "bool") return { ty: returnType, v: !!raw };
    if (name === "string") return { ty: returnType, v: String(raw) };
    if (isFloatPrim(name) || isIntPrim(name)) {
      return { ty: returnType, v: coerceNumeric(returnType, raw) };
    }
  }
  // Fallback: store the raw value as-is. Callers that hit this with
  // a non-primitive return type probably want a real impl rather than
  // this catch-all; ComptimeError makes that obvious early.
  throw new ComptimeError(
    `comptime: extern whitelist can't wrap result of type ${returnType.kind}/${returnType.name ?? ""}`,
    null,
  );
}

// Whitelist entries. Keyed on the extern name as declared in source —
// for libc we use the canonical libc name; for yoop runtime intrinsics
// we use the `yoop_*` name. Adding an entry is a one-line PR.
const WHITELIST = new Map();

// ── string-shaped pure libc helpers ─────────────────────────────────

WHITELIST.set("strlen", {
  impl(args, _loc, returnType) {
    const s = args[0]?.v ?? "";
    return wrapAs(returnType, String(s).length);
  },
});

WHITELIST.set("strcmp", {
  impl(args, _loc, returnType) {
    const a = String(args[0]?.v ?? "");
    const b = String(args[1]?.v ?? "");
    const cmp = a < b ? -1 : a > b ? 1 : 0;
    return wrapAs(returnType, cmp);
  },
});

// ── math.h ─────────────────────────────────────────────────────────

WHITELIST.set("sqrt", {
  impl(args, _loc, returnType) {
    const x = Number(args[0]?.v ?? 0);
    return wrapAs(returnType, Math.sqrt(x));
  },
});

WHITELIST.set("pow", {
  impl(args, _loc, returnType) {
    const x = Number(args[0]?.v ?? 0);
    const y = Number(args[1]?.v ?? 0);
    return wrapAs(returnType, Math.pow(x, y));
  },
});

WHITELIST.set("floor", {
  impl(args, _loc, returnType) {
    return wrapAs(returnType, Math.floor(Number(args[0]?.v ?? 0)));
  },
});

WHITELIST.set("ceil", {
  impl(args, _loc, returnType) {
    return wrapAs(returnType, Math.ceil(Number(args[0]?.v ?? 0)));
  },
});

WHITELIST.set("fabs", {
  impl(args, _loc, returnType) {
    return wrapAs(returnType, Math.abs(Number(args[0]?.v ?? 0)));
  },
});

WHITELIST.set("abs", {
  impl(args, _loc, returnType) {
    const v = args[0]?.v;
    if (typeof v === "bigint") {
      return wrapAs(returnType, v < 0n ? -v : v);
    }
    return wrapAs(returnType, Math.abs(Number(v ?? 0)));
  },
});

WHITELIST.set("labs", {
  impl(args, _loc, returnType) {
    const v = args[0]?.v;
    if (typeof v === "bigint") {
      return wrapAs(returnType, v < 0n ? -v : v);
    }
    return wrapAs(returnType, Math.abs(Number(v ?? 0)));
  },
});

// ── yoop runtime intrinsics that are comptime-safe ─────────────────

WHITELIST.set("yoop_now_ns", {
  impl(_args, _loc, returnType) {
    // Use the host's wall clock. Determinism caveats apply — once
    // we have a "deterministic comptime" flag we should reject
    // calls to yoop_now_ns under it.
    return wrapAs(returnType, BigInt(Math.floor(Date.now() * 1_000_000)));
  },
});

WHITELIST.set("yoop_errno_get", {
  impl(_args, _loc, returnType) {
    // No syscalls happen at comptime, so errno is always zero.
    return wrapAs(returnType, 0);
  },
});

WHITELIST.set("yoop_runtime_init", {
  impl(_args, _loc, _returnType) {
    // Runtime never starts at comptime — the call is a no-op.
    return null;
  },
});

WHITELIST.set("yoop_runtime_shutdown", {
  impl(_args, _loc, _returnType) {
    return null;
  },
});

export function lookupExtern(name) {
  return WHITELIST.get(name) ?? null;
}

export function knownExternNames() {
  return [...WHITELIST.keys()];
}
