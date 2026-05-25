// Yooperlang runtime - small socket helpers whose underlying constants
// differ across platforms (SOL_SOCKET and SO_REUSEADDR have different
// numeric values on Linux vs macOS, even though their behavior is the
// same). Centralizing in C lets the headers resolve the right numbers
// per platform without yoop having to hand-mirror them.
//
// Intentionally tiny: just enough to keep std/net/* pure-yoop on the
// surface. Anything more involved should grow into its own translation
// unit alongside this one.

#include <sys/socket.h>

// Enable SO_REUSEADDR on `fd` so the kernel allows re-bind() of an
// address still in TIME_WAIT. Returns the setsockopt() rc (0 on success,
// -1 on error with errno set), matching the convention every other
// libc-shaped helper in std/net uses.
int yoop_net_set_reuseaddr(int fd) {
    int one = 1;
    return setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
}
