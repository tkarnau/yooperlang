// Phase 8.F.2: yoop_io_wait_readable on a pipe.
//
// Spawn a thread that sleeps ~10ms then writes one byte to the pipe;
// main calls yoop_io_wait_readable on the read end and verifies it
// returns 0 and the byte is then readable.

#include "../yoop_runtime.h"

#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct writer_args { int fd; };

static void* writer(void* p) {
    struct writer_args* a = (struct writer_args*)p;
    yoop_sleep_ms(10);
    char c = 'Z';
    ssize_t w = write(a->fd, &c, 1);
    (void)w;
    return NULL;
}

int main(void) {
    yoop_runtime_init();

    int fds[2];
    if (pipe(fds) != 0) {
        perror("pipe");
        return 1;
    }
    int rfd = fds[0], wfd = fds[1];

    pthread_t th;
    struct writer_args args = { .fd = wfd };
    pthread_create(&th, NULL, writer, &args);

    int rc = yoop_io_wait_readable(rfd);
    if (rc != 0) {
        fprintf(stderr, "io_wait_readable rc=%d errno=%d (%s)\n",
                rc, yoop_errno_get(), yoop_errno_message(yoop_errno_get()));
        return 1;
    }

    char got = 0;
    ssize_t n = read(rfd, &got, 1);
    if (n != 1 || got != 'Z') {
        fprintf(stderr, "read: n=%zd got='%c'\n", n, got);
        return 1;
    }
    pthread_join(th, NULL);
    close(rfd);
    close(wfd);

    yoop_runtime_shutdown();
    printf("io_pipe: ok\n");
    return 0;
}
