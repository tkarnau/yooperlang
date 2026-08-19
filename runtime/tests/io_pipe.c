// yoop_io_wait_readable on a descriptor pair.
//
// Spawn a thread that sleeps ~10ms then writes one byte to the pair;
// main calls yoop_io_wait_readable on the read end and verifies it
// returns 0 and the byte is then readable.
//
// The pair comes from yoop_socketpair rather than pipe() so the same test
// runs on Windows, where the multiplexer is WSAPoll-based and can only wait
// on sockets. On POSIX yoop_socketpair is still pipe(), so nothing about what
// this test covers there has changed.

#include "../yoop_runtime.h"
#include "test_support.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct writer_args { int fd; };

static void writer(void* p) {
    struct writer_args* a = (struct writer_args*)p;
    test_sleep_ms(10);
    char c = 'Z';
    int64_t w = test_pair_write(a->fd, &c, 1);
    (void)w;
}

int main(void) {
    yoop_runtime_init();

    int fds[2];
    if (test_pair(fds) != 0) {
        perror("socketpair");
        return 1;
    }
    int rfd = fds[0], wfd = fds[1];

    test_thread_t th;
    struct writer_args args = { wfd };
    test_thread_spawn(&th, writer, &args);

    int rc = yoop_io_wait_readable(rfd);
    if (rc != 0) {
        fprintf(stderr, "io_wait_readable rc=%d errno=%d (%s)\n",
                rc, yoop_errno_get(), yoop_errno_message(yoop_errno_get()));
        return 1;
    }

    char got = 0;
    int64_t n = test_pair_read(rfd, &got, 1);
    if (n != 1 || got != 'Z') {
        fprintf(stderr, "read: n=%lld got='%c'\n", (long long)n, got);
        return 1;
    }
    test_thread_join(&th);
    test_pair_close(rfd);
    test_pair_close(wfd);

    yoop_runtime_shutdown();
    printf("io_pipe: ok\n");
    return 0;
}
