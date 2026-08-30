// yoop_proc_*: spawn a child over line pipes, round-trip a line, watch it
// live and die.
//
// The child is `cat`, because it is the identity function over lines: what
// comes back IS what went in, so the assertion needs no protocol. The kill
// half then proves a plugin host can always wind its renderer down - a stuck
// child must never turn the compiler's exit into a hang.
//
// On Windows the whole surface is stubbed to failure; this test just asserts
// the stubs answer the documented way, so the contract is pinned there too.

#include "../yoop_runtime.h"

#include <stdio.h>
#include <string.h>

int main(void) {
    yoop_runtime_init();

#ifdef _WIN32
    if (yoop_proc_spawn("cat") != -1) {
        fprintf(stderr, "proc_spawn: the Windows stub did not refuse\n");
        return 1;
    }
    printf("proc_spawn: ok (stubbed)\n");
    return 0;
#else
    int64_t h = yoop_proc_spawn("cat");
    if (h < 0) {
        fprintf(stderr, "proc_spawn: spawn failed\n");
        return 1;
    }
    if (yoop_proc_alive(h) != 1) {
        fprintf(stderr, "proc_spawn: cat is not alive after spawn\n");
        return 1;
    }

    if (yoop_proc_write_line(h, "hello through the pipe") != 0) {
        fprintf(stderr, "proc_spawn: write failed\n");
        return 1;
    }
    const char* echoed = yoop_proc_read_line(h);
    if (strcmp(echoed, "hello through the pipe") != 0) {
        fprintf(stderr, "proc_spawn: got \"%s\" back\n", echoed);
        return 1;
    }

    // A second round-trip must not alias the first line's storage - the
    // comptime evaluator keeps both strings alive at once.
    if (yoop_proc_write_line(h, "second") != 0) {
        fprintf(stderr, "proc_spawn: second write failed\n");
        return 1;
    }
    const char* second = yoop_proc_read_line(h);
    if (strcmp(second, "second") != 0 || strcmp(echoed, "hello through the pipe") != 0) {
        fprintf(stderr, "proc_spawn: lines aliased (\"%s\", \"%s\")\n", echoed, second);
        return 1;
    }

    // The blob frame: header, payload verbatim (its newline intact), closing
    // newline. Through cat, that is three lines to read back.
    if (yoop_proc_write_blob(h, "ir", "line1\nline2") != 0) {
        fprintf(stderr, "proc_spawn: blob write failed\n");
        return 1;
    }
    if (strcmp(yoop_proc_read_line(h), "blob ir 11") != 0 ||
        strcmp(yoop_proc_read_line(h), "line1") != 0 ||
        strcmp(yoop_proc_read_line(h), "line2") != 0) {
        fprintf(stderr, "proc_spawn: the blob frame came back wrong\n");
        return 1;
    }

    if (yoop_proc_kill(h) != 0) {
        fprintf(stderr, "proc_spawn: kill failed\n");
        return 1;
    }
    if (yoop_proc_alive(h) != 0) {
        fprintf(stderr, "proc_spawn: alive after kill\n");
        return 1;
    }
    // The handle is dead now: every call must answer the bad-handle way
    // rather than touch a recycled slot.
    if (yoop_proc_write_line(h, "x") != -1 || strcmp(yoop_proc_read_line(h), "") != 0) {
        fprintf(stderr, "proc_spawn: a dead handle still answered\n");
        return 1;
    }

    printf("proc_spawn: ok\n");
    return 0;
#endif
}
