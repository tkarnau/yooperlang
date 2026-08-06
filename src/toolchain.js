// Shared knowledge of how to invoke the host C toolchain.
//
// Three call sites shell out to clang - the user-facing driver
// (src/yoopiler.js), the e2e suite (src/e2e.test.js) and the C runtime suite
// (src/runtimeC.test.js) - and on Windows "invoke clang" is materially more
// than the string "clang". Keeping that knowledge here is what stops the
// tests from passing on a machine where the real driver fails, or vice versa.
//
// The Windows story, in short: clang targets `*-pc-windows-msvc` and drives
// MSVC's link.exe, which only exists inside a Visual Studio install and is not
// on PATH outside a "Developer Command Prompt". So the toolchain is located
// rather than assumed, and the located directory is prepended to PATH for the
// clang child only - the user's own environment is never modified.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

// Locate the clang binary. `YOOP_CLANG` wins if set (and is a hard error if it
// points at nothing, since that's explicit user intent). On Windows we keep
// the historical Program Files probe as a fallback, but PATH is consulted
// first everywhere now, so an LLVM installed anywhere else just works.
export function resolveClang() {
  const override = process.env.YOOP_CLANG;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`YOOP_CLANG points at a file that does not exist: ${override}`);
    }
    return override;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("clang", ["--version"], { stdio: "ignore" });
      return "clang";
    } catch {
      const fallback = "C:\\Program Files\\LLVM\\bin\\clang.exe";
      if (fs.existsSync(fallback)) return fallback;
      return "clang";
    }
  }
  return "clang";
}

// Windows only: find the directory holding MSVC's link.exe.
//
// vswhere.exe ships with every VS 2017+ installer at a fixed location, so it
// is the supported way to find the install root without hard-coding an edition
// or a toolset version. Returns null when nothing is found, which callers turn
// into an actionable "install the C++ build tools" message rather than letting
// clang fail with a bare "unable to execute command".
//
// `-fuse-ld=link` (see windowsClangArgs) names MSVC's link.exe deliberately
// rather than LLVM's lld-link: lld-link is absent from some LLVM packages and
// broken in others, whereas link.exe is present whenever the MSVC headers and
// import libraries clang needs are also present.
let cachedMsvcBinDir; // undefined = not probed, null = probed and not found
export function msvcLinkerDir() {
  if (cachedMsvcBinDir !== undefined) return cachedMsvcBinDir;
  cachedMsvcBinDir = null;
  if (process.platform !== "win32") return cachedMsvcBinDir;

  // Already on PATH (e.g. running inside a Developer Command Prompt).
  try {
    execFileSync("where", ["link.exe"], { stdio: "ignore" });
    return cachedMsvcBinDir;
  } catch {
    /* not on PATH - go find it */
  }

  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!fs.existsSync(vswhere)) return cachedMsvcBinDir;

  let root;
  try {
    root = execFileSync(
      vswhere,
      ["-latest", "-products", "*", "-property", "installationPath"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return cachedMsvcBinDir;
  }
  if (!root) return cachedMsvcBinDir;

  // The toolset version is not knowable up front (it changes with every VS
  // update), so read the directory rather than guessing. Newest wins.
  const msvcRoot = path.join(root, "VC", "Tools", "MSVC");
  let versions;
  try {
    versions = fs.readdirSync(msvcRoot).sort();
  } catch {
    return cachedMsvcBinDir;
  }
  const hostArch = process.arch === "arm64" ? "Hostarm64" : "Hostx64";
  const targetArch = process.arch === "arm64" ? "arm64" : "x64";
  for (const v of versions.reverse()) {
    const dir = path.join(msvcRoot, v, "bin", hostArch, targetArch);
    if (fs.existsSync(path.join(dir, "link.exe"))) {
      cachedMsvcBinDir = dir;
      return cachedMsvcBinDir;
    }
  }
  return cachedMsvcBinDir;
}

// Environment for the clang child process, with the MSVC linker added on
// Windows. Returns process.env unchanged everywhere else.
export function clangEnv(extra) {
  const base = process.env;
  const dir = msvcLinkerDir();
  const merged = dir
    ? { ...base, PATH: `${dir}${path.delimiter}${base.PATH || ""}` }
    : base;
  return extra ? { ...merged, ...extra } : merged;
}

// Extra clang flags every Windows compile needs. Empty on other platforms.
//
// The two warning suppressions are about noise, not correctness: the MSVC CRT
// marks the whole POSIX-named surface (getenv, strerror, localtime, ...)
// deprecated in favor of its _s variants, and codegen's module triple carries
// no MSVC version suffix so it never exactly matches clang's default. Both
// warnings name runtime internals that no user of the compiler can act on.
export function windowsClangArgs() {
  if (process.platform !== "win32") return [];
  return ["-D_CRT_SECURE_NO_WARNINGS", "-Wno-override-module", "-fuse-ld=link"];
}

// Windows will not CreateProcess a file whose name has no extension - it
// appends ".exe" and looks for that - so a binary built for immediate
// execution needs the suffix baked into its -o path.
export const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

// Turn one yoop-level link flag name into the clang arguments for it.
//
// `extern "C" from library "m"` and friends name a library the way a POSIX
// developer would. Two of those names do not exist as separate libraries on
// Windows and must be dropped rather than passed through, or the link fails
// on a library the platform simply does not have:
//
//   m       - the math functions are in the MSVC CRT, there is no libm.
//   pthread - the runtime uses the Win32 primitives (see yoop_platform.h).
//
// `framework:X` is an Apple linker concept and is meaningless anywhere else.
// Every other name lowers to `-lNAME`, which clang maps to `NAME.lib` when
// driving the MSVC linker, so ordinary third-party libraries still work.
const WINDOWS_IMPLICIT_LIBS = new Set(["m", "pthread"]);
export function lowerLinkFlag(name) {
  if (name.startsWith("framework:")) {
    if (process.platform !== "darwin") return [];
    return ["-framework", name.slice("framework:".length)];
  }
  if (process.platform === "win32" && WINDOWS_IMPLICIT_LIBS.has(name)) return [];
  return [`-l${name}`];
}

// Shared "the link step failed" hint. Returns null when there is nothing
// useful to add, so callers can append conditionally.
export function toolchainHint() {
  if (process.platform !== "win32" || msvcLinkerDir() !== null) return null;
  return (
    `note: no MSVC linker (link.exe) was found.\n` +
    `  clang targets x86_64-pc-windows-msvc here and needs the Visual Studio\n` +
    `  build tools to link. Install "Desktop development with C++" (the free\n` +
    `  Build Tools package is enough), or run from a Developer Command Prompt.`
  );
}
