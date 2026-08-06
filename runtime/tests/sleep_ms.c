// Phase 8.F.3: yoop_sleep_ms timing.

#include "../yoop_runtime.h"

#include <stdio.h>

// yoop_now_ns is the runtime's own monotonic clock and is exactly the one
// yoop_sleep_ms measures against, so this reads the same base the code under
// test does. It also replaces a direct clock_gettime(CLOCK_MONOTONIC) call,
// which does not exist in the MSVC CRT.
static double monotonic_ms(void) {
    return (double)yoop_now_ns() / 1e6;
}

int main(void) {
    yoop_runtime_init();

    double t0 = monotonic_ms();
    int rc = yoop_sleep_ms(50);
    double dt = monotonic_ms() - t0;

    if (rc != 0) {
        fprintf(stderr, "sleep_ms: rc=%d (expected 0)\n", rc);
        return 1;
    }
    if (dt < 45.0 || dt > 500.0) {
        // Lower bound: 45ms (some clock skew tolerance).
        // Upper bound: 500ms (loose for CI noise).
        fprintf(stderr, "sleep_ms: elapsed=%.2fms out of range\n", dt);
        return 1;
    }

    yoop_runtime_shutdown();
    printf("sleep_ms: ok (~%.0fms)\n", dt);
    return 0;
}
