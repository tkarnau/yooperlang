// Comptime-allowed extern functions.
//
// The interpreter cannot call into real libc / OS extern functions at
// compile time - the user's program is being compiled, not run; the
// runtime doesn't exist yet. For *pure* externs whose behavior is
// trivially modeled in JS, we maintain a whitelist of implementations
// the comptime interpreter substitutes in at call sites. Anything
// outside this list surfaces as a comptime fallback (silent in the
// opportunistic module-init path; hard error under `@precompile`).
//
// Each entry's `impl` takes:
//   args      - wrapped values for each positional argument
//   sourceLoc - call-site source location (for error reporting)
//   returnType- the call's resolved yoop return type
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

// Whitelist entries. Keyed on the extern name as declared in source -
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
    // Use the host's wall clock. Determinism caveats apply - once
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
    // Runtime never starts at comptime - the call is a no-op.
    return null;
  },
});

WHITELIST.set("yoop_runtime_shutdown", {
  impl(_args, _loc, _returnType) {
    return null;
  },
});

// ── std/log sinks ──────────────────────────────────────────────────
// `std/log`'s `info` / `warn` / `error` forward to these runtime
// helpers, which at runtime write a `[info]` / `[warn]` / `[error]`
// prefixed, newline-terminated line to stderr. At comptime there's no
// runtime, so we mirror that behavior directly in JS - writing to
// `process.stderr` with the same severity prefix plus the `[comptime]`
// banner so a `@precompile { log.info(...) }` block's output is
// visibly distinct from the compiled program's own log lines. The
// single string argument has already been lowered to a register (the
// template-literal case is folded to one string before the call), so
// each impl just unwraps `args[0]`. Return type is `void` - the impls
// return null and the interpreter discards it.
function makeLogSink(level) {
  return {
    impl(args, _loc, _returnType) {
      const msg = String(args[0]?.v ?? "");
      if (typeof process !== "undefined" && process.stderr) {
        process.stderr.write(`[comptime] [${level}] ${msg}\n`);
      }
      return null;
    },
  };
}

WHITELIST.set("yoop_log_info", makeLogSink("info"));
WHITELIST.set("yoop_log_warn", makeLogSink("warn"));
WHITELIST.set("yoop_log_error", makeLogSink("error"));

// Comptime printf. Writes to stderr with a
// `[comptime] ` prefix so debug output from a `@precompile { ... }`
// block doesn't intermingle with the compiler's own diagnostics or
// the compiled program's stdout. Format-spec strings ("%d\n", "%s")
// are *not* parsed at comptime - every printable arg goes through
// `stringifyForTemplate`'s rules and is concatenated. The intended
// idiom is template-literal printf:
//
//     printf(`x=${x} y=${y}\n`);
//
// where the TEMPLATE_LITERAL has already been lowered to a single
// string register by the time printf sees its arg. Legacy
// `printf("%d\n", x)` lands here too - each arg gets concatenated
// with the literal `%d` left in place, so the output is approximate
// but functional; the format spec is not parsed.
WHITELIST.set("printf", {
  impl(args, _loc, returnType) {
    let out = "";
    for (const a of args) {
      out += stringifyArgForPrintf(a);
    }
    // Use process.stderr.write directly so the comptime banner
    // prefixes only the first line (the rest of the message can
    // span lines via a trailing \n). The Node runtime is the only
    // thing executing here.
    if (typeof process !== "undefined" && process.stderr) {
      process.stderr.write(`[comptime] ${out}`);
    }
    // Return the number of "characters written" - printf semantics.
    // returnType is int32; coerceNumeric handles the wrap.
    return wrapAs(returnType, out.length);
  },
});

// Permissive arg formatter for the printf whitelist. Mirrors
// stringifyForTemplate in interp.js but lives here so the whitelist
// file is self-contained.
function stringifyArgForPrintf(wrapped) {
  if (wrapped == null) return "<null>";
  const v = wrapped.v;
  const ty = wrapped.ty;
  if (ty?.kind === typeKinds.prim) {
    if (ty.name === "string") return String(v);
    if (ty.name === "bool") return v ? "true" : "false";
    if (isFloatPrim(ty.name)) return Number(v).toFixed(6);
    if (typeof v === "bigint") return v.toString();
    return String(v | 0);
  }
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "<value>";
}

export function lookupExtern(name) {
  return WHITELIST.get(name) ?? null;
}

export function knownExternNames() {
  return [...WHITELIST.keys()];
}
