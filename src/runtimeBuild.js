// Shared knowledge of where the C runtime lives and what platform flags it
// needs. Used by yoopiler.js (the user-facing driver) and the e2e tests so
// they stay in lockstep.

import path from "path";

import { RUNTIME_DIR as runtimeDir } from "./install_root.js";
import { wantsOpenGL } from "./toolchain.js";

// Primary runtime translation unit. Kept as a single string for backwards
// compatibility with call sites that don't know about extra runtime files
// (e.g. older e2e helpers that pass a single -c arg).
export const RUNTIME_C = path.resolve(runtimeDir, "yoop_runtime.c");

// Phase 8.F.2: the I/O multiplexer lives in its own translation unit so
// programs that don't use it still link cleanly. Callers that need full
// runtime functionality should compile every entry in this list.
// yoop_net.c (Library Phase B): a couple of platform-dependent socket
// helpers (SOL_SOCKET / SO_REUSEADDR constants differ Linux vs macOS).
export const RUNTIME_SOURCES = [
  RUNTIME_C,
  // The I/O multiplexer: a platform-neutral core plus one event engine per
  // platform, in the shape of Go's netpoll_{kqueue,epoll,windows}.go. Only one
  // engine compiles to anything on a given host - each is wrapped in its own
  // #ifdef - so all three can sit in the list unconditionally. See
  // runtime/yoop_io_internal.h for why they are split rather than abstracted.
  path.resolve(runtimeDir, "yoop_io.c"),
  path.resolve(runtimeDir, "yoop_io_kqueue.c"),
  path.resolve(runtimeDir, "yoop_io_epoll.c"),
  path.resolve(runtimeDir, "yoop_io_windows.c"),
  // Filesystem + directory helpers (mkdir/stat/realpath/dirent). Split out of
  // yoop_io.c, which was carrying two unrelated concerns.
  path.resolve(runtimeDir, "yoop_fs.c"),
  path.resolve(runtimeDir, "yoop_net.c"),
  // Phase 10.D: panic/unreachable + log_info/warn/error helpers.
  path.resolve(runtimeDir, "yoop_debug.c"),
  // yoop_float_to_string - backs std/core/format.yoop's float shim.
  path.resolve(runtimeDir, "yoop_format.c"),
  // yoop_argc / yoop_argv - argv access for programs whose user main
  // wants CLI args. Platform-specific under the hood.
  path.resolve(runtimeDir, "yoop_args.c"),
  // Arena/context allocators backing std/core/alloc.yoop: the per-thread
  // current-allocator slot and the bump arena.
  path.resolve(runtimeDir, "yoop_alloc.c"),
  // Cancellation tokens backing std/core/cancel.yoop: the cancelled
  // flag, the deadline, and the waiter list the multiplexer parks on.
  path.resolve(runtimeDir, "yoop_cancel.c"),
];

export function runtimeLinkFlags() {
  return process.platform === "win32" ? [] : ["pthread"];
}

// Extra C translation units a program needs because of the libraries IT names
// - as opposed to RUNTIME_SOURCES, which every program gets.
//
// Today there is exactly one: on Windows, OpenGL past version 1.1 is not
// exported by opengl32.dll and has to be resolved at run time against the
// current context. runtime/yoop_gl_win32.c is the forwarding shim that does
// that (read its header comment for why linking GLEW/glad instead does not
// work here). Compiling it into every program would be wasted objects and
// would collide with a user who links their own loader, so it rides on the
// program's own `framework:OpenGL` / `opengl32` declaration.
//
// `linkFlagNames` is the raw set codegen collected from `extern "C" from
// library "X"` blocks, before lowerLinkFlag turns them into clang arguments.
export function glueSourcesForLinkFlags(linkFlagNames) {
  if (process.platform !== "win32") return [];
  if (!wantsOpenGL(linkFlagNames)) return [];
  return [path.resolve(runtimeDir, "yoop_gl_win32.c")];
}
