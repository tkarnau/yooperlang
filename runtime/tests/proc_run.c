// yoop_proc_run: a program run from an argv ARRAY, with no shell in between.
//
// The property under test is the one the compiler's link step depends on: an
// argument reaches the child as exactly the bytes the caller put in the array.
// Shell metacharacters (`;`, `|`, `$(...)`, backticks, quotes) are the case
// that matters, because a library name copied out of a source file used to be
// spliced into a `system()` string, where every one of them meant something.
//
// The child is `sh` comparing "$1" to "$2": if anything between this process
// and the child had interpreted the argument, the two would no longer be
// equal. `sh` is the OBSERVER here, not the transport - it receives the bytes
// through execve like any other program would.
//
// The exit-code contract is pinned too, in both directions: a plain exit code
// comes back as itself, a signal death as 128 + the signal, and a program that
// does not exist as -1 with errno set - the shape the compiler turns into
// "clang is not on PATH" instead of a mysterious exit 127.

#include "../yoop_runtime.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

static int run(const char* const* argv, size_t argc) {
    return yoop_proc_run(argv, argc);
}

int main(void) {
    yoop_runtime_init();

    // An empty array is a caller bug, refused rather than exec'd.
    if (run(NULL, 0) != -1) {
        fprintf(stderr, "proc_run: an empty argv was not refused\n");
        return 1;
    }

#ifdef _WIN32
    {
        const char* argv[] = { "cmd", "/c", "exit 3" };
        int rc = run(argv, 3);
        if (rc != 3) {
            fprintf(stderr, "proc_run: cmd /c exit 3 gave %d\n", rc);
            return 1;
        }
    }
    {
        const char* argv[] = { "yoop-definitely-not-a-program-3f9a" };
        errno = 0;
        int rc = run(argv, 1);
        if (rc != -1 || errno != ENOENT) {
            fprintf(stderr, "proc_run: a missing program gave %d, errno %d\n", rc, errno);
            return 1;
        }
    }
    printf("proc_run: ok\n");
    return 0;
#else
    // A plain exit code comes back as itself.
    {
        const char* argv[] = { "sh", "-c", "exit 3" };
        int rc = run(argv, 3);
        if (rc != 3) {
            fprintf(stderr, "proc_run: sh -c 'exit 3' gave %d\n", rc);
            return 1;
        }
    }

    // The point of the file. Every character a shell would act on, delivered
    // as data: the child sees "$1" equal to "$2" only if both arrived intact.
    {
        const char* hostile = "m; rm -rf / | cat $(id) `id` \"quoted\" 'single' & echo";
        const char* argv[] = { "sh", "-c", "[ \"$1\" = \"$2\" ]", "sh", hostile, hostile };
        int rc = run(argv, 6);
        if (rc != 0) {
            fprintf(stderr, "proc_run: a metacharacter argument did not arrive intact (rc %d)\n", rc);
            return 1;
        }
    }

    // And the observer really observes: two different strings compare unequal,
    // so the test above is not passing vacuously.
    {
        const char* argv[] = { "sh", "-c", "[ \"$1\" = \"$2\" ]", "sh", "a;b", "a" };
        int rc = run(argv, 6);
        if (rc != 1) {
            fprintf(stderr, "proc_run: the control comparison gave %d, wanted 1\n", rc);
            return 1;
        }
    }

    // A `-l`-shaped argument is one argument. This is the exact shape the link
    // step emits: `-lm; rm -rf ~` must be a single (unsatisfiable) library
    // name, never a name followed by a command.
    {
        const char* argv[] = { "sh", "-c", "[ \"$#\" = 1 ]", "sh", "-lm; rm -rf ~" };
        int rc = run(argv, 5);
        if (rc != 0) {
            fprintf(stderr, "proc_run: a -l argument was split (rc %d)\n", rc);
            return 1;
        }
    }

    // A signal death is 128 + the signal, which is what a shell would report
    // and what a test runner can tell apart from a failure count.
    {
        const char* argv[] = { "sh", "-c", "kill -9 $$" };
        int rc = run(argv, 3);
        if (rc != 128 + 9) {
            fprintf(stderr, "proc_run: a SIGKILLed child gave %d, wanted 137\n", rc);
            return 1;
        }
    }

    // A program that does not exist is -1 with errno, not a child that exited
    // 127 - so the caller can say "not on PATH" rather than "exit 127".
    {
        const char* argv[] = { "yoop-definitely-not-a-program-3f9a" };
        errno = 0;
        int rc = run(argv, 1);
        if (rc != -1 || errno != ENOENT) {
            fprintf(stderr, "proc_run: a missing program gave %d, errno %d\n", rc, errno);
            return 1;
        }
    }

    printf("proc_run: ok\n");
    return 0;
#endif
}
