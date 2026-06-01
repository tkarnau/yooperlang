// Yooperlang runtime - small socket helpers whose underlying constants
// differ across platforms (SOL_SOCKET and SO_REUSEADDR have different
// numeric values on Linux vs macOS, even though their behavior is the
// same). Centralizing in C lets the headers resolve the right numbers
// per platform without yoop having to hand-mirror them.
//
// Intentionally tiny: just enough to keep std/net/* pure-yoop on the
// surface. Anything more involved should grow into its own translation
// unit alongside this one.

#include <arpa/inet.h>
#include <netdb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

// Enable SO_REUSEADDR on `fd` so the kernel allows re-bind() of an
// address still in TIME_WAIT. Returns the setsockopt() rc (0 on success,
// -1 on error with errno set), matching the convention every other
// libc-shaped helper in std/net uses.
int yoop_net_set_reuseaddr(int fd) {
    int one = 1;
    return setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
}

// Resolve `name` (hostname or numeric IPv4) to a dotted-quad string.
// Returns a malloc'd string the caller is expected to leak (matches the
// heap-string convention in yoop_format.c). On failure returns a
// malloc'd empty string "" so yoop callers can check `.len == 0`.
const char* yoop_net_resolve_ipv4(const char* name) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo* res = NULL;
    int rc = getaddrinfo(name, NULL, &hints, &res);
    if (rc != 0 || res == NULL) {
        char* empty = (char*)malloc(1);
        empty[0] = '\0';
        return empty;
    }

    char buf[INET_ADDRSTRLEN];
    buf[0] = '\0';
    struct sockaddr_in* sin = (struct sockaddr_in*)res->ai_addr;
    const char* ok = inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof(buf));
    freeaddrinfo(res);

    if (ok == NULL) {
        char* empty = (char*)malloc(1);
        empty[0] = '\0';
        return empty;
    }
    size_t n = strlen(buf);
    char* out = (char*)malloc(n + 1);
    memcpy(out, buf, n + 1);
    return out;
}

// Wall-clock hour in local time (0-23). Uses localtime(); not thread
// safe in the strict POSIX sense but in practice the platforms we
// target serialize through TLS or a global lock and this helper is
// only ever called from short demo paths.
int32_t yoop_local_hour(void) {
    time_t now = time(NULL);
    struct tm* lt = localtime(&now);
    if (lt == NULL) return 0;
    return (int32_t)lt->tm_hour;
}

// Wall-clock minute in local time (0-59).
int32_t yoop_local_minute(void) {
    time_t now = time(NULL);
    struct tm* lt = localtime(&now);
    if (lt == NULL) return 0;
    return (int32_t)lt->tm_min;
}
