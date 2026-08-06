// Yooperlang runtime - small socket helpers whose underlying constants
// differ across platforms (SOL_SOCKET and SO_REUSEADDR have different
// numeric values on Linux vs macOS, even though their behavior is the
// same). Centralizing in C lets the headers resolve the right numbers
// per platform without yoop having to hand-mirror them.
//
// Intentionally tiny: just enough to keep std/net/* pure-yoop on the
// surface. Anything more involved should grow into its own translation
// unit alongside this one.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
  // Winsock's headers are order-sensitive: <winsock2.h> must precede
  // <windows.h>, and WIN32_LEAN_AND_MEAN keeps the ancient <winsock.h>
  // (whose definitions conflict) from being pulled in behind our back.
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  // Ask the linker for the Winsock import library from inside the source,
  // so the flag does not have to be threaded through runtimeBuild.js and
  // every out-of-tree caller that compiles these files by hand.
  #pragma comment(lib, "ws2_32.lib")
#else
  #include <arpa/inet.h>
  #include <netdb.h>
  #include <sys/socket.h>
  #include <unistd.h>
#endif

#include <errno.h>

#include "yoop_runtime.h"
#include "yoop_platform.h"

// ----- Winsock lifecycle ---------------------------------------------------
//
// Unlike BSD sockets, Winsock has to be explicitly started before the first
// socket call in a process, and every entry point below (plus every shim in
// yoop_sock.c) can be the first one reached. Rather than order the call sites
// or lean on yoop_runtime_init - which a program that only resolves a
// hostname never reaches - each entry point calls this, and InitOnce makes
// the repeat calls free and thread-safe.
//
// There is deliberately no matching WSACleanup: the counterpart teardown
// would have to be ordered after the last socket in the process is closed,
// which nothing here can know, and Windows reclaims the Winsock allocation at
// process exit regardless. Skipping it trades a leak that cannot outlive the
// process for the crash class where one thread cleans up under another.
#ifdef _WIN32
static INIT_ONCE yoop_wsa_once = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK yoop_wsa_start(PINIT_ONCE o, PVOID p, PVOID* ctx) {
    (void)o; (void)p; (void)ctx;
    WSADATA d;
    return WSAStartup(MAKEWORD(2, 2), &d) == 0 ? TRUE : FALSE;
}

void yoop_net_startup(void) {
    (void)InitOnceExecuteOnce(&yoop_wsa_once, yoop_wsa_start, NULL, NULL);
}
#else
void yoop_net_startup(void) { /* BSD sockets need no per-process setup */ }
#endif

// ----- POSIX-shaped socket calls -------------------------------------------
//
// std/net/socket_ffi.yoop used to extern socket/bind/listen/accept/connect/
// send/recv/close straight out of libc. That works on POSIX, where a socket
// IS a file descriptor and failures land in errno, and breaks on Windows in
// three separate ways:
//
//   * socket() returns a SOCKET (a 64-bit unsigned handle), not an int, and
//     signals failure with INVALID_SOCKET rather than -1;
//   * a SOCKET is not a CRT file descriptor, so close() is the wrong call -
//     it must be closesocket(), and CRT close() on a socket handle fails;
//   * failures are reported via WSAGetLastError, so errno is left stale and
//     every `errno.message(errno.get())` in std/net printed nonsense.
//
// Rather than teach the yoop layer about any of that, these shims present the
// POSIX shape - int descriptors, -1 on failure, errno set - on both
// platforms. On POSIX they compile to a direct call and nothing else.
//
// On the int-vs-SOCKET question: Windows socket handles are kernel handle
// values that fit in 32 bits, and INVALID_SOCKET truncates to -1, so the
// round trip through int is sound. This is the same assumption libuv and curl
// make, and the cast is confined to this file.

int yoop_sock_socket(int domain, int type, int proto) {
#ifdef _WIN32
    yoop_net_startup();
    SOCKET s = socket(domain, type, proto);
    if (s == INVALID_SOCKET) return yoop_sock_fail();
    return (int)s;
#else
    return socket(domain, type, proto);
#endif
}

int yoop_sock_bind(int fd, const void* addr, int len) {
#ifdef _WIN32
    if (bind((SOCKET)fd, (const struct sockaddr*)addr, len) == SOCKET_ERROR) {
        return yoop_sock_fail();
    }
    return 0;
#else
    return bind(fd, (const struct sockaddr*)addr, (socklen_t)len);
#endif
}

int yoop_sock_listen(int fd, int backlog) {
#ifdef _WIN32
    if (listen((SOCKET)fd, backlog) == SOCKET_ERROR) return yoop_sock_fail();
    return 0;
#else
    return listen(fd, backlog);
#endif
}

int yoop_sock_accept(int fd, void* addr, int* len) {
#ifdef _WIN32
    SOCKET s = accept((SOCKET)fd, (struct sockaddr*)addr, len);
    if (s == INVALID_SOCKET) return yoop_sock_fail();
    return (int)s;
#else
    socklen_t sl = len ? (socklen_t)*len : 0;
    int rc = accept(fd, (struct sockaddr*)addr, len ? &sl : NULL);
    if (len) *len = (int)sl;
    return rc;
#endif
}

int yoop_sock_connect(int fd, const void* addr, int len) {
#ifdef _WIN32
    if (connect((SOCKET)fd, (const struct sockaddr*)addr, len) == SOCKET_ERROR) {
        return yoop_sock_fail();
    }
    return 0;
#else
    return connect(fd, (const struct sockaddr*)addr, (socklen_t)len);
#endif
}

// send/recv take an `int` length on Windows and a size_t on POSIX. The clamp
// keeps a caller's size_t from wrapping negative on the Windows side; a short
// transfer is already part of the contract, so callers loop regardless.
int64_t yoop_sock_send(int fd, const void* buf, size_t n, int flags) {
#ifdef _WIN32
    int chunk = n > 0x7FFFFFFF ? 0x7FFFFFFF : (int)n;
    int rc = send((SOCKET)fd, (const char*)buf, chunk, flags);
    if (rc == SOCKET_ERROR) return yoop_sock_fail();
    return rc;
#else
    return (int64_t)send(fd, buf, n, flags);
#endif
}

int64_t yoop_sock_recv(int fd, void* buf, size_t n, int flags) {
#ifdef _WIN32
    int chunk = n > 0x7FFFFFFF ? 0x7FFFFFFF : (int)n;
    int rc = recv((SOCKET)fd, (char*)buf, chunk, flags);
    if (rc == SOCKET_ERROR) return yoop_sock_fail();
    return rc;
#else
    return (int64_t)recv(fd, buf, n, flags);
#endif
}

int yoop_sock_close(int fd) {
    // Tell the multiplexer first. On IOCP it caches which sockets are bound to
    // the completion port, and Windows recycles handle VALUES - so a stale
    // entry makes the next socket with the same value look already-bound, and
    // its operations then never complete. That is a hang, not a leak.
    yoop_io_closing(fd);
#ifdef _WIN32
    if (closesocket((SOCKET)fd) == SOCKET_ERROR) return yoop_sock_fail();
    return 0;
#else
    return close(fd);
#endif
}

// htons and inet_addr are pure conversions and cannot fail in a way errno
// would carry, but they live in ws2_32 on Windows and so still need Winsock
// started before the first call.
uint16_t yoop_sock_htons(uint16_t v) {
#ifdef _WIN32
    yoop_net_startup();
#endif
    return htons(v);
}

// Returns the address in NETWORK byte order, or INADDR_NONE (0xFFFFFFFF) on
// invalid input - inet_addr's contract, which std/net checks against directly.
// Windows marks inet_addr deprecated in favor of inet_pton, so that is what is
// called there; the sentinel is reproduced by hand since inet_pton signals
// failure through its return value instead. The "255.255.255.255" ambiguity is
// inherent to the sentinel and is unchanged from the POSIX path (std/net
// documents it and does not bind to the broadcast address).
uint32_t yoop_sock_inet_addr(const char* s) {
#ifdef _WIN32
    yoop_net_startup();
    struct in_addr a;
    if (inet_pton(AF_INET, s, &a) != 1) return 0xFFFFFFFFu;
    return (uint32_t)a.s_addr;
#else
    return (uint32_t)inet_addr(s);
#endif
}

// Enable SO_REUSEADDR on `fd` so the kernel allows re-bind() of an
// address still in TIME_WAIT. Returns the setsockopt() rc (0 on success,
// -1 on error with errno set), matching the convention every other
// libc-shaped helper in std/net uses.
int yoop_net_set_reuseaddr(int fd) {
    int one = 1;
#ifdef _WIN32
    // Winsock types optval as `const char*` and the descriptor as SOCKET.
    // Note the semantics differ from POSIX: Windows SO_REUSEADDR permits
    // *hijacking* a live listener, so it is deliberately NOT the analogue of
    // the POSIX TIME_WAIT escape hatch. Windows already allows re-bind after
    // TIME_WAIT by default, which is the behavior std/net actually wants, so
    // the correct port is to do nothing and report success.
    (void)fd; (void)one;
    return 0;
#else
    return setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#endif
}

// Resolve `name` (hostname or numeric IPv4) to a dotted-quad string.
// Returns a malloc'd string the caller is expected to leak (matches the
// heap-string convention in yoop_format.c). On failure returns a
// malloc'd empty string "" so yoop callers can check `.len == 0`.
const char* yoop_net_resolve_ipv4(const char* name) {
    yoop_net_startup();
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
