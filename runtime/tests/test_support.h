// Portability shims for the runtime's C-level tests.
//
// These tests are the only place in the tree that spawned threads and made
// pipes by calling POSIX directly, which is what kept them from building on
// Windows at all. Everything they actually need already exists in the runtime
// proper - yoop_platform.h has the thread primitives, yoop_io.c has the
// socketpair - so this header is a thin naming layer over those rather than a
// second implementation.
//
// Two things are deliberately NOT pipes here:
//
//   The multiplexer's Windows backend is WSAPoll, which accepts sockets only;
//   a Windows pipe handle cannot be waited on. So a test that hands a
//   descriptor to yoop_io_wait_readable has to get it from yoop_socketpair.
//   On POSIX that is still pipe(), so the tests exercise the same thing they
//   always did there.
//
//   Reads and writes go through test_pair_read/write rather than read/write,
//   because on Windows the pair are sockets and live in a different namespace
//   from CRT file descriptors - read() on a SOCKET fails.

#ifndef YOOP_TEST_SUPPORT_H
#define YOOP_TEST_SUPPORT_H

#include "../yoop_platform.h"
#include "../yoop_runtime.h"

#include <stddef.h>
#include <stdint.h>

// ----- threads -------------------------------------------------------------

typedef yoop_thread_t test_thread_t;

// Body signature is void(void*) on both platforms - see yoop_platform.h for
// why neither native signature could be used directly.
static inline int test_thread_spawn(test_thread_t* t, yoop_thread_fn fn, void* arg) {
    return yoop_thread_spawn(t, fn, arg);
}

static inline void test_thread_join(test_thread_t* t) {
    yoop_thread_join(t);
}

// ----- a descriptor pair the multiplexer can wait on -----------------------

static inline int test_pair(int fds[2]) {
    return yoop_socketpair(fds);
}

static inline int64_t test_pair_read(int fd, void* buf, size_t n) {
    return yoop_socketpair_read(fd, buf, n);
}

static inline int64_t test_pair_write(int fd, const void* buf, size_t n) {
    return yoop_socketpair_write(fd, buf, n);
}

static inline int test_pair_close(int fd) {
    return yoop_socketpair_close(fd);
}

// ----- sleeping ------------------------------------------------------------
//
// usleep is POSIX-only; yoop_sleep_ms is the runtime's own portable sleep and
// is already linked into every one of these tests.
static inline void test_sleep_ms(int ms) {
    (void)yoop_sleep_ms((uint64_t)ms);
}

#endif // YOOP_TEST_SUPPORT_H
