// Yooperlang runtime - argv and environment access.
//
// Yoop user `main` is the C entry point, so the user's `function main():
// int32` is the literal `int main(void)` — argc/argv never reach yoop.
// These helpers grab them after the fact via platform-specific globals:
//
//   macOS:  _NSGetArgc() / _NSGetArgv() from <crt_externs.h> are safe to
//           call from anywhere after dyld load.
//   Linux:  parse /proc/self/cmdline on first call and cache the result.
//   Windows: __argc / __argv, the CRT globals the startup code fills in
//           before main - the direct analogue of the macOS pair.
//   Other:  return 0 / "".
//
// The returned strings are owned by libc / the cached buffer; callers
// must treat them as borrowed for the process lifetime.

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __APPLE__
  #include <crt_externs.h>
#endif

#ifdef __linux__
  // Cache parsed /proc/self/cmdline. argv strings are nul-separated in
  // that file, which is convenient -- we point into the buffer directly.
  static int     g_linux_argc      = -1;
  static char**  g_linux_argv      = NULL;
  static char*   g_linux_argv_buf  = NULL;

  static void load_linux_args(void) {
      if (g_linux_argc != -1) return;
      g_linux_argc = 0;
      FILE* f = fopen("/proc/self/cmdline", "rb");
      if (!f) return;
      size_t cap = 4096;
      size_t len = 0;
      char* buf = (char*)malloc(cap);
      if (!buf) { fclose(f); return; }
      for (;;) {
          if (len == cap) {
              cap *= 2;
              char* nb = (char*)realloc(buf, cap);
              if (!nb) { free(buf); fclose(f); return; }
              buf = nb;
          }
          size_t n = fread(buf + len, 1, cap - len, f);
          if (n == 0) break;
          len += n;
      }
      fclose(f);
      // Count nul-terminators -> argc.
      int n = 0;
      for (size_t i = 0; i < len; i++) {
          if (buf[i] == '\0') n++;
      }
      char** av = (char**)malloc(sizeof(char*) * (size_t)(n + 1));
      if (!av) { free(buf); return; }
      int idx = 0;
      size_t start = 0;
      for (size_t i = 0; i < len; i++) {
          if (buf[i] == '\0') {
              av[idx++] = buf + start;
              start = i + 1;
          }
      }
      av[idx] = NULL;
      g_linux_argv_buf = buf;
      g_linux_argv = av;
      g_linux_argc = n;
  }
#endif

int32_t yoop_argc(void) {
#ifdef __APPLE__
    int* p = _NSGetArgc();
    return p ? (int32_t)*p : 0;
#elif defined(__linux__)
    load_linux_args();
    return (int32_t)(g_linux_argc < 0 ? 0 : g_linux_argc);
#elif defined(_WIN32)
    return (int32_t)__argc;
#else
    return 0;
#endif
}

// Switch stdout to line-buffered mode so progress prints from tools
// survive a crash even when stdout is redirected to a file or pipe.
// Default behaviour under libc is line-buffered for TTYs and fully
// buffered otherwise; this just pins line-buffered always.
//
// The MSVC CRT has no line buffering: it accepts _IOLBF and then treats
// it as _IOFBF, and it rejects a size of 0 outright - so the POSIX
// spelling below is a silent no-op on Windows, and a program that
// crashed after printing lost everything it had "printed". Unbuffered is
// the closest thing the CRT offers, and it satisfies the contract this
// function actually makes (a completed print is visible). It costs a
// write syscall per printf, which is the right trade for a call a
// program makes explicitly to get progress output it can trust.
void yoop_stdout_linebuf(void) {
#ifdef _WIN32
    setvbuf(stdout, NULL, _IONBF, 0);
#else
    setvbuf(stdout, NULL, _IOLBF, 0);
#endif
}

// Returns a borrowed pointer to argv[i] as a nul-terminated C string,
// or "" on out-of-range / unsupported platform. Never returns NULL so
// the yoop side can `string` it without a null check.
const char* yoop_argv(int32_t i) {
#ifdef __APPLE__
    int* ac = _NSGetArgc();
    char*** av = _NSGetArgv();
    if (!ac || !av || !*av) return "";
    if (i < 0 || i >= *ac) return "";
    return (*av)[i];
#elif defined(__linux__)
    load_linux_args();
    if (i < 0 || i >= g_linux_argc || !g_linux_argv) return "";
    return g_linux_argv[i];
#elif defined(_WIN32)
    // __argv is the narrow (ANSI) vector, which is what the rest of the
    // runtime's string handling expects. It is NULL only in a program built
    // against the wide entry point (wmain), which codegen never emits.
    if (!__argv) return "";
    if (i < 0 || i >= __argc) return "";
    return __argv[i];
#else
    (void)i;
    return "";
#endif
}

// ---- environment ----------------------------------------------------------
//
// Same contract as yoop_argv: a borrowed, never-NULL, nul-terminated C string.
// `getenv` returns NULL for an unset variable, and a yoop `string` is a bare
// `char*`, so handing that NULL through would make `.len` a null deref at the
// first use. Collapsing it to "" here is what keeps the yoop side free of
// null checks - and `yoop_env_has` is how a caller tells "unset" apart from
// "set to the empty string", which "" alone cannot express.
//
// Lifetime: POSIX `getenv` returns a pointer into `environ`, which stays valid
// until something calls setenv/putenv. Yoop exposes no way to do that, so
// "borrowed for the process lifetime" is accurate today. If a setenv ever
// lands, this comment is the thing that has to change first.

const char* yoop_getenv(const char* name) {
    if (!name) return "";
    const char* v = getenv(name);
    return v ? v : "";
}

// 1 when `name` is present in the environment at all, including when its value
// is the empty string. 0 otherwise.
int32_t yoop_env_has(const char* name) {
    if (!name) return 0;
    return getenv(name) ? 1 : 0;
}
