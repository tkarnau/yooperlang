// yoop_debug.c — runtime helpers for std/debug + std/log.
//
// These are deliberately tiny. Each takes a NUL-terminated message and
// writes to stderr. `panic` and `unreachable` exit(1) after printing;
// `log_*` returns normally. Keeping the formatting in C (rather than
// composing in yoop) means yoop callers don't need any string-concat
// machinery to get reasonable diagnostics.
//
// Release-mode `assert` gating happens at codegen time (env var
// `YOOP_RELEASE`); see std/debug.yoop. There's no runtime flag here —
// the C side is the same in both modes.

#include <stdio.h>
#include <stdlib.h>

void yoop_panic(const char *msg) {
    // Flush stdout first so any buffered prior output appears in order
    // relative to the panic line (and not after the stderr line).
    fflush(stdout);
    fprintf(stderr, "panic: %s\n", msg);
    fflush(stderr);
    exit(1);
}

void yoop_unreachable(const char *msg) {
    fflush(stdout);
    fprintf(stderr, "unreachable: %s\n", msg);
    fflush(stderr);
    exit(1);
}

void yoop_log_info(const char *msg) {
    fprintf(stderr, "[info] %s\n", msg);
    fflush(stderr);
}

void yoop_log_warn(const char *msg) {
    fprintf(stderr, "[warn] %s\n", msg);
    fflush(stderr);
}

void yoop_log_error(const char *msg) {
    fprintf(stderr, "[error] %s\n", msg);
    fflush(stderr);
}
