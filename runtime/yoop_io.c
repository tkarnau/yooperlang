// Phase 8.F.2 - I/O multiplexer for the Yooperlang runtime.
//
// One dedicated pthread (the "I/O thread") runs a kqueue (macOS) or
// epoll (Linux) loop. yoop_io_wait_readable / wait_writable register a
// one-shot interest for the given fd, park the calling thread on a
// park token (Phase 8.F.1 primitive), and the I/O thread unparks them
// when the fd becomes ready. See plans/phase-8-f-2-multiplexer.md.
//
// IOCP / Windows backend is not implemented; the public API would still
// work, but the body returns ENOSYS for now.

#include "yoop_runtime.h"
#include "yoop_platform.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>

#ifdef _WIN32
  // <unistd.h> does not exist in the MSVC CRT. The pieces this file uses
  // from it are split across <io.h> (_open/_read/_close) and <direct.h>
  // (_mkdir/_fullpath), and the POSIX spellings are the underscore-free
  // deprecated aliases, so the code below names the underscore forms
  // explicitly rather than relying on those.
  //
  // Header order is load-bearing: <winsock2.h> must come before <windows.h>,
  // or <windows.h> pulls in the original <winsock.h> and the two sets of
  // declarations collide. WIN32_LEAN_AND_MEAN enforces that from our side.
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  #include <direct.h>
  #include <io.h>
  #include <lmcons.h>
  // Link directives live in the source so the flags do not have to be
  // threaded through runtimeBuild.js and every out-of-tree caller that
  // compiles these files by hand. ws2_32 for the sockets the multiplexer
  // waits on; advapi32 for GetUserName, which backs yoop_io_user_name.
  #pragma comment(lib, "ws2_32.lib")
  #pragma comment(lib, "advapi32.lib")
#else
  #include <unistd.h>
  #include <sys/socket.h>
  #include <grp.h>
  #include <pwd.h>
#endif

// Create a single directory with standard 0755 permissions. The mode bits
// are computed from the POSIX S_* symbols (the headers resolve them to the
// right per-platform mode_t value), so yoop callers never hand-mirror a
// numeric mode - the same philosophy as the yoop_net.c constant helpers.
// Returns mkdir()'s rc: 0 on success, -1 with errno set. EEXIST is left for
// the caller to interpret (std/fs.mkdir_p treats it as benign).
int yoop_io_mkdir(const char* path) {
#ifdef _WIN32
    // Windows mkdir takes no mode argument.
    return _mkdir(path);
#else
    return mkdir(path, S_IRWXU | S_IRGRP | S_IXGRP | S_IROTH | S_IXOTH);
#endif
}

// Portable stat shim. MSVC's CRT has no S_ISREG/S_ISDIR macros (it spells
// the same test `st_mode & _S_IFMT`), and its plain `stat` truncates sizes
// past 2GB - `_stat64` is the one that does not. Both platforms end up with
// the same three names, so the callers below stay free of #ifdefs.
#ifdef _WIN32
  typedef struct _stat64 yoop_stat_t;
  #define yoop_stat(p, s) _stat64((p), (s))
  #define YOOP_ISREG(m)   (((m) & _S_IFMT) == _S_IFREG)
  #define YOOP_ISDIR(m)   (((m) & _S_IFMT) == _S_IFDIR)
#else
  typedef struct stat yoop_stat_t;
  #define yoop_stat(p, s) stat((p), (s))
  #define YOOP_ISREG(m)   S_ISREG(m)
  #define YOOP_ISDIR(m)   S_ISDIR(m)
#endif

// 1 if `path` names an existing filesystem entry (of any type), 0 otherwise.
// A 0 result also covers "stat failed" (e.g. a missing parent component).
int yoop_io_exists(const char* path) {
    yoop_stat_t st;
    return yoop_stat(path, &st) == 0 ? 1 : 0;
}

// Canonicalize `path` to an absolute, symlink-resolved path. On success
// writes a freshly malloc'd nul-terminated string into *out (caller owns it)
// and returns 0; on failure returns -1 with errno set and leaves *out alone.
// Passing NULL as realpath's resolved_path makes libc allocate a PATH_MAX-safe
// buffer for us - NEVER hand realpath a fixed/foreign buffer, it overruns it.
// Note: realpath requires `path` to exist and always yields an ABSOLUTE path.
int yoop_io_normalize_real_path(const char* path, char** out) {
#ifdef _WIN32
    // _fullpath is the Windows analogue and has the same malloc-for-me
    // contract when handed a NULL buffer. It differs from realpath in one
    // way that matters: it does NOT require the path to exist and does not
    // resolve symlinks/junctions. Existence is re-checked here so callers
    // keep the "-1 means no such path" behavior they rely on; unresolved
    // reparse points are an accepted divergence (Win32 has no cheap
    // equivalent short of opening the file).
    char* resolved = _fullpath(NULL, path, 0);
    if (!resolved) return -1;
    yoop_stat_t st;
    if (yoop_stat(resolved, &st) != 0) { free(resolved); errno = ENOENT; return -1; }
    *out = resolved;
    return 0;
#else
    char* resolved = realpath(path, NULL);
    if (!resolved) return -1;
    *out = resolved;
    return 0;
#endif
}

// Size in bytes of the regular file at `path`, or -1 if it doesn't exist,
// isn't a regular file, or stat() otherwise fails. Returning -1 (rather than
// a fallible struct) keeps the yoop side a single int64 read; callers test
// `< 0`.
int64_t yoop_io_file_size(const char* path) {
    yoop_stat_t st;
    if (yoop_stat(path, &st) != 0) return -1;
    if (!YOOP_ISREG(st.st_mode)) return -1;
    return (int64_t)st.st_size;
}

// ----- directory listing -------------------------------------------------
//
// A thin opendir/readdir/closedir wrapper plus a combined stat helper, so a
// yoop caller can walk a tree without hand-mirroring the platform-specific
// `struct dirent` layout (it differs across macOS/Linux and is a footgun to
// decode in yoop). Modeled after the yoop_io_mkdir / yoop_io_file_size
// pattern: a few POSIX-y helpers the std/example layer wraps in safe exports.
//
// dirent is POSIX; the Windows branch below implements the same contract over
// FindFirstFile/FindNextFile. The two differ in what they can report rather
// than in shape - see the notes there on symlinks and on uid/gid.

#ifndef _WIN32
#include <dirent.h>

// Open `path` for iteration. Returns an opaque DIR* (as void*) or NULL on
// failure (errno set). The yoop side treats it as `unsafe_ptr`.
void* yoop_io_opendir(const char* path) {
    return (void*)opendir(path);
}

// Return the next entry name in the directory stream, skipping "." and "..",
// or the empty string "" once the stream is exhausted (so the yoop caller can
// test `name.len == 0` rather than reach for a null string). The returned
// pointer is BORROWED - it lives inside the DIR stream and is invalidated by
// the next readdir / closedir, so the yoop caller must copy it (e.g.
// string_concat) before the next call.
const char* yoop_io_readdir(void* d) {
    if (!d) return "";
    struct dirent* e;
    while ((e = readdir((DIR*)d)) != NULL) {
        const char* n = e->d_name;
        if (n[0] == '.' && (n[1] == '\0' || (n[1] == '.' && n[2] == '\0'))) {
            continue;  // skip "." and ".."
        }
        return n;
    }
    return "";
}

void yoop_io_closedir(void* d) {
    if (d) closedir((DIR*)d);
}

// Combined "what is this and how big" probe in a single lstat (one syscall
// per entry instead of two). Writes 1 into *is_dir for a directory, else 0,
// and returns:
//   * a regular file's byte size,
//   * 0 for a directory (its aggregate is summed by the walker),
//   * 0 for anything else (symlink/socket/fifo - counted as a 0-size leaf),
//   * -1 if the lstat itself failed (then *is_dir is 0).
// lstat (not stat) so symlinks are NOT followed: that avoids both infinite
// recursion through symlink cycles and double-counting linked trees - a
// symlinked directory reads as a non-dir leaf and is never descended into.
int64_t yoop_io_stat2(const char* path, int32_t* is_dir) {
    struct stat st;
    if (lstat(path, &st) != 0) {
        if (is_dir) *is_dir = 0;
        return -1;
    }
    if (S_ISDIR(st.st_mode)) {
        if (is_dir) *is_dir = 1;
        return 0;
    }
    if (is_dir) *is_dir = 0;
    if (S_ISREG(st.st_mode)) return (int64_t)st.st_size;
    return 0;
}

// Copy a C string into a fresh malloc'd one. The yoop side treats every
// string as owned-and-leaked, so the helpers below hand back allocations
// rather than pointers into a static or libc-owned buffer.
static char* yoop_io_dup(const char* s) {
    size_t n = strlen(s);
    char* out = (char*)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

// The long-listing sibling of yoop_io_stat2: everything an `ls -l` row needs
// from one lstat. Writes the entry kind into *kind (0 file, 1 dir, 2 symlink,
// 3 other - derived from the S_IS* macros so yoop never mirrors platform type
// bits), the portable 0777 permission mask into *perm, hard-link count into
// *nlink, owner/group ids into *uid/*gid, and mtime seconds into *mtime.
// Returns the byte size, or -1 if the lstat failed (out params are zeroed
// first, so a failed probe reads as an empty "other"). All out params are
// required.
int64_t yoop_io_stat_meta(const char* path, int32_t* kind, int32_t* perm,
                          int32_t* nlink, int32_t* uid, int32_t* gid,
                          int64_t* mtime) {
    struct stat st;
    *kind = 3; *perm = 0; *nlink = 0; *uid = 0; *gid = 0; *mtime = 0;
    if (lstat(path, &st) != 0) return -1;
    if (S_ISREG(st.st_mode))      *kind = 0;
    else if (S_ISDIR(st.st_mode)) *kind = 1;
    else if (S_ISLNK(st.st_mode)) *kind = 2;
    *perm  = (int32_t)(st.st_mode & 0777);
    *nlink = (int32_t)st.st_nlink;
    *uid   = (int32_t)st.st_uid;
    *gid   = (int32_t)st.st_gid;
    *mtime = (int64_t)st.st_mtime;
    return (int64_t)st.st_size;
}

// Owner / group name for an id, falling back to the id in decimal when the
// passwd / group database has no entry for it (the same thing ls does).
// Caller owns the returned string.
char* yoop_io_user_name(int32_t uid) {
    struct passwd* pw = getpwuid((uid_t)uid);
    if (pw && pw->pw_name) return yoop_io_dup(pw->pw_name);
    char buf[32];
    snprintf(buf, sizeof(buf), "%d", (int)uid);
    return yoop_io_dup(buf);
}

char* yoop_io_group_name(int32_t gid) {
    struct group* gr = getgrgid((gid_t)gid);
    if (gr && gr->gr_name) return yoop_io_dup(gr->gr_name);
    char buf[32];
    snprintf(buf, sizeof(buf), "%d", (int)gid);
    return yoop_io_dup(buf);
}

// Local-time rendering of a unix timestamp in ls's two shapes: "Mon DD HH:MM"
// for anything inside the last six months, "Mon DD  YYYY" for older entries
// (and for anything implausibly far in the future). Caller owns the result.
char* yoop_io_time_string(int64_t epoch) {
    time_t t = (time_t)epoch;
    struct tm* lt = localtime(&t);
    if (!lt) return yoop_io_dup("");
    double age = difftime(time(NULL), t);
    const char* form = (age > 15552000.0 || age < -3600.0) ? "%b %e  %Y" : "%b %e %H:%M";
    char buf[64];
    if (strftime(buf, sizeof(buf), form, lt) == 0) buf[0] = '\0';
    return yoop_io_dup(buf);
}

#else  // _WIN32: the FindFirstFile backend.

// Copy a C string into a fresh malloc'd one. The yoop side treats every
// string as owned-and-leaked, so the helpers below hand back allocations
// rather than pointers into a static or libc-owned buffer.
static char* yoop_io_dup(const char* s) {
    size_t n = strlen(s);
    char* out = (char*)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

// Win32's directory iteration differs from POSIX's in a way the wrapper has to
// absorb: FindFirstFile takes a WILDCARD PATTERN rather than a directory, and
// it returns the first entry along with the handle - whereas opendir returns a
// bare handle and the first name arrives from the following readdir. So the
// handle here carries a "the first entry is already loaded" flag, and the
// first yoop_io_readdir consumes that instead of calling FindNextFile.
typedef struct yoop_win_dir {
    HANDLE           h;
    WIN32_FIND_DATAA data;
    int              pending;  // data holds an entry not yet returned
} yoop_win_dir;

void* yoop_io_opendir(const char* path) {
    size_t n = strlen(path);
    // +3 covers a possible separator, the '*', and the terminator.
    char* pattern = (char*)malloc(n + 3);
    if (!pattern) { errno = ENOMEM; return NULL; }
    memcpy(pattern, path, n);
    size_t at = n;
    if (at > 0 && path[at - 1] != '\\' && path[at - 1] != '/') pattern[at++] = '\\';
    pattern[at++] = '*';
    pattern[at]   = '\0';

    yoop_win_dir* d = (yoop_win_dir*)malloc(sizeof(yoop_win_dir));
    if (!d) { free(pattern); errno = ENOMEM; return NULL; }
    d->h = FindFirstFileA(pattern, &d->data);
    free(pattern);
    if (d->h == INVALID_HANDLE_VALUE) {
        free(d);
        errno = ENOENT;
        return NULL;
    }
    d->pending = 1;
    return (void*)d;
}

// Same contract as the POSIX branch: the next entry name, skipping "." and
// "..", or "" once exhausted. The pointer is BORROWED - it points into the
// handle's find-data and is invalidated by the next readdir / closedir.
const char* yoop_io_readdir(void* dv) {
    if (!dv) return "";
    yoop_win_dir* d = (yoop_win_dir*)dv;
    for (;;) {
        if (!d->pending) {
            if (!FindNextFileA(d->h, &d->data)) return "";
        }
        d->pending = 0;
        const char* n = d->data.cFileName;
        if (n[0] == '.' && (n[1] == '\0' || (n[1] == '.' && n[2] == '\0'))) {
            continue;  // skip "." and ".."
        }
        return n;
    }
}

void yoop_io_closedir(void* dv) {
    if (!dv) return;
    yoop_win_dir* d = (yoop_win_dir*)dv;
    if (d->h != INVALID_HANDLE_VALUE) FindClose(d->h);
    free(d);
}

// _stat64 rather than lstat: Win32 has no lstat, and _stat64 follows reparse
// points. The consequence is that a directory symlink/junction reads as a
// directory here where POSIX would report a symlink leaf - so a walker can in
// principle descend one. Directory junctions are rare enough, and the
// alternative (GetFileAttributes + FILE_ATTRIBUTE_REPARSE_POINT on every
// entry) costs a second call per entry; noted rather than paid for.
int64_t yoop_io_stat2(const char* path, int32_t* is_dir) {
    yoop_stat_t st;
    if (yoop_stat(path, &st) != 0) {
        if (is_dir) *is_dir = 0;
        return -1;
    }
    if (YOOP_ISDIR(st.st_mode)) {
        if (is_dir) *is_dir = 1;
        return 0;
    }
    if (is_dir) *is_dir = 0;
    if (YOOP_ISREG(st.st_mode)) return (int64_t)st.st_size;
    return 0;
}
// Same contract as the POSIX branch, with three fields Windows has no real
// answer for. NTFS has no POSIX uid/gid (ownership is a SID, which does not
// fit an int32), so both report 0 and the name helpers below render that as
// the current user rather than inventing a number. The permission mask is
// what the CRT synthesizes from the read-only attribute - Windows ACLs do not
// reduce to 0777 - so it is indicative, not authoritative.
int64_t yoop_io_stat_meta(const char* path, int32_t* kind, int32_t* perm,
                          int32_t* nlink, int32_t* uid, int32_t* gid,
                          int64_t* mtime) {
    yoop_stat_t st;
    *kind = 3; *perm = 0; *nlink = 0; *uid = 0; *gid = 0; *mtime = 0;
    if (yoop_stat(path, &st) != 0) return -1;
    if (YOOP_ISREG(st.st_mode))      *kind = 0;
    else if (YOOP_ISDIR(st.st_mode)) *kind = 1;
    // No symlink case: _stat64 follows reparse points, so *kind is never 2
    // here. See the note on yoop_io_stat2.
    *perm  = (int32_t)(st.st_mode & 0777);
    *nlink = (int32_t)st.st_nlink;
    *mtime = (int64_t)st.st_mtime;
    return (int64_t)st.st_size;
}

// There is no passwd/group database to consult. GetUserName is the closest
// truthful answer for the owner of anything this process can stat in the
// common case; the group has no analogue at all and reports empty, which the
// listing layer already renders as a blank column.
char* yoop_io_user_name(int32_t uid) {
    (void)uid;
    char  buf[256];
    DWORD n = (DWORD)sizeof(buf);
    if (GetUserNameA(buf, &n) && n > 0) return yoop_io_dup(buf);
    return yoop_io_dup("");
}

char* yoop_io_group_name(int32_t gid) { (void)gid; return yoop_io_dup(""); }

// Local-time rendering of a unix timestamp in ls's two shapes: "Mon DD HH:MM"
// for anything inside the last six months, "Mon DD  YYYY" for older entries.
// %e is a POSIX strftime extension the MSVC CRT does not implement (it would
// emit nothing), so the day is formatted by hand and spliced in.
char* yoop_io_time_string(int64_t epoch) {
    time_t t = (time_t)epoch;
    struct tm lt;
    if (localtime_s(&lt, &t) != 0) return yoop_io_dup("");
    double age = difftime(time(NULL), t);
    char stamp[32];
    if (age > 15552000.0 || age < -3600.0) {
        if (strftime(stamp, sizeof(stamp), "%b", &lt) == 0) return yoop_io_dup("");
        char out[64];
        snprintf(out, sizeof(out), "%s %2d  %d",
                 stamp, lt.tm_mday, lt.tm_year + 1900);
        return yoop_io_dup(out);
    }
    if (strftime(stamp, sizeof(stamp), "%b", &lt) == 0) return yoop_io_dup("");
    char out[64];
    snprintf(out, sizeof(out), "%s %2d %02d:%02d",
             stamp, lt.tm_mday, lt.tm_hour, lt.tm_min);
    return yoop_io_dup(out);
}

#endif

// ----- backend selection ---------------------------------------------------
//
// Three backends, one set of semantics. Everything below the backend-specific
// helpers (the registration table, io_deliver, io_wait_common, io_arm_common,
// the shutdown drain) is shared, because the contract the rest of the runtime
// depends on is not "epoll" or "kqueue" - it is "register a one-shot interest
// in a descriptor, and deliver exactly once under io_mu".
//
// Windows uses WSAPoll rather than IOCP, and that is a deliberate choice worth
// recording. IOCP is a COMPLETION port: you start an operation and are told
// when it finished. Every layer above this file - std/net, std/http, the
// ffi*Async helpers - is written against READINESS: "try the syscall, and on
// EWOULDBLOCK arm an interest and suspend". WSAPoll is a readiness primitive
// and so drops into the same slot kqueue and epoll occupy, leaving the whole
// yoop-level I/O stack unchanged. Switching to IOCP would mean rewriting that
// stack in Yoop as well, for a scalability win this project has no evidence of
// needing yet. If that day comes, this is the only C file that has to change.
//
// The one real consequence: WSAPoll accepts SOCKETS only, so on Windows the
// multiplexer does not work on pipes or files. POSIX pipes are pollable and
// the runtime's own tests used them; those now use a socketpair on both
// platforms (see yoop_socketpair below).
#ifdef _WIN32
  #define YOOP_IO_WSAPOLL 1
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
  #define YOOP_IO_KQUEUE 1
  #include <pthread.h>
  #include <sys/event.h>
  #include <sys/time.h>
#elif defined(__linux__)
  #define YOOP_IO_EPOLL 1
  #include <pthread.h>
  #include <sys/epoll.h>
#else
  #error "Unsupported platform - add a yoop_io.c backend"
#endif

// ----- descriptor operations that differ by backend ------------------------
//
// On POSIX a socket IS a file descriptor, so read/write/close apply. Winsock
// keeps sockets in a separate namespace from CRT file descriptors: they must
// be closed with closesocket and transferred with recv/send, and - the part
// that bites hardest - they report failures through WSAGetLastError rather
// than errno. The whole yoop layer reads errno (via yoop_errno_get), so the
// bridge has to happen here, at the point of the call.
#ifdef _WIN32

  #define YOOP_CLOSE_SOCK(fd)        closesocket((SOCKET)(fd))
  #define YOOP_READ_SOCK(fd, b, n)   recv((SOCKET)(fd), (char*)(b), (int)(n), 0)
  #define YOOP_WRITE_SOCK(fd, b, n)  send((SOCKET)(fd), (const char*)(b), (int)(n), 0)
#else
  #define YOOP_CLOSE_SOCK(fd)        close(fd)
  #define YOOP_READ_SOCK(fd, b, n)   read((fd), (b), (n))
  #define YOOP_WRITE_SOCK(fd, b, n)  write((fd), (b), (n))
#endif

// A connected pair of descriptors, used both for the multiplexer's own wakeup
// channel and by the runtime's C tests.
//
// POSIX has pipe(); Windows has _pipe() but its handles are not selectable, so
// the multiplexer could never wait on one. Building the pair out of loopback
// TCP sockets gives something WSAPoll accepts, which is why this is a
// socketpair on Windows rather than a pipe. The listener is bound to
// 127.0.0.1:0 (an ephemeral port), accepted once, and closed immediately, so
// nothing is reachable from off-machine.
//
// Returns 0 on success and fills fds[0] (read end) and fds[1] (write end), or
// -1 with errno set.
int yoop_socketpair(int fds[2]) {
#ifdef _WIN32
    yoop_net_startup();

    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return yoop_sock_fail();

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port        = 0;

    int addrlen = (int)sizeof(addr);
    if (bind(listener, (struct sockaddr*)&addr, addrlen) == SOCKET_ERROR ||
        listen(listener, 1) == SOCKET_ERROR ||
        getsockname(listener, (struct sockaddr*)&addr, &addrlen) == SOCKET_ERROR) {
        int saved = WSAGetLastError();
        closesocket(listener);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }

    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) {
        int saved = WSAGetLastError();
        closesocket(listener);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }
    // Blocking connect to our own listener: the backlog is already open, so
    // this completes without a round trip that could stall.
    if (connect(client, (struct sockaddr*)&addr, addrlen) == SOCKET_ERROR) {
        int saved = WSAGetLastError();
        closesocket(client);
        closesocket(listener);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }
    SOCKET server = accept(listener, NULL, NULL);
    closesocket(listener);
    if (server == INVALID_SOCKET) {
        int saved = WSAGetLastError();
        closesocket(client);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }
    fds[0] = (int)server;
    fds[1] = (int)client;
    return 0;
#else
    return pipe(fds);
#endif
}

// Per-wait state. Lives on the caller's stack. The multiplexer only
// ever reaches it through the registration table below, and only while
// holding io_mu - which is what lets a waiter abandon (on a timeout or
// a cancellation) and reclaim its frame without racing the I/O thread.
typedef struct yoop_io_wait {
    yoop_park_token_t token;
    int               result_errno; // 0 on ready, else errno
    int               fired;        // multiplexer delivered a wake (io_mu)
} yoop_io_wait_t;

// One live registration. Registrations are identified by a monotonically
// increasing sequence number rather than by the address of the wait
// struct: a stack frame can be reused by the next waiter at the very
// same address, and a stale event carrying that address would then be
// misdelivered to an unrelated wait. Sequence numbers are never reused,
// so a stale event simply fails to find its entry and is dropped.
typedef struct yoop_io_reg {
    uint64_t            seq;
    int                 fd;
    int                 want_write;
    // Exactly one of these is set. `w` means a thread is PARKED on this
    // fd (the blocking flavor): delivery unparks it. `task` means a
    // coroutine ARMED it and then suspended (the async flavor): delivery
    // pushes the task back onto the run queue instead, so no thread was
    // tied up waiting in the first place.
    yoop_io_wait_t*     w;
    void*               task;
    struct yoop_io_reg* next;
} yoop_io_reg;

// Multiplexer state.
//
// io_init_mu guards startup/shutdown; io_mu guards the registration
// table and the fired/unpark handshake. The pair used to be a
// pthread_once_t, which could not be reset - so an init after a
// shutdown left the multiplexer permanently dead (the TODO at the
// bottom of yoop_io_shutdown). A plain flag under a mutex restarts
// cleanly.
// io_init_mu has to exist before any thread can call in, and a Win32
// CRITICAL_SECTION cannot be initialized statically the way a pthread mutex
// can. InitOnceExecuteOnce closes that gap; it is the same shape
// yoop_runtime.c uses for its own init lock, for the same reason.
#ifdef _WIN32
  static INIT_ONCE        io_init_once = INIT_ONCE_STATIC_INIT;
  static CRITICAL_SECTION io_init_cs;
  static BOOL CALLBACK io_init_cb(PINIT_ONCE o, PVOID p, PVOID* c) {
      (void)o; (void)p; (void)c;
      InitializeCriticalSection(&io_init_cs);
      return TRUE;
  }
  static void io_init_lock(void) {
      InitOnceExecuteOnce(&io_init_once, io_init_cb, NULL, NULL);
      EnterCriticalSection(&io_init_cs);
  }
  static void io_init_unlock(void) { LeaveCriticalSection(&io_init_cs); }
#else
  static pthread_mutex_t io_init_mu = PTHREAD_MUTEX_INITIALIZER;
  static void io_init_lock(void)   { pthread_mutex_lock(&io_init_mu); }
  static void io_init_unlock(void) { pthread_mutex_unlock(&io_init_mu); }
#endif

static int             io_started   = 0;
static yoop_thread_t   io_thread;
static int             io_shutdown_w = -1; // write end of the wakeup pair
static int             io_shutdown_r = -1; // read  end

// Set (under io_mu) by yoop_io_shutdown before it pokes the wakeup channel.
//
// On kqueue/epoll a byte on that channel can only mean "shut down", because
// registrations reach the kernel directly and never need to disturb the loop.
// The WSAPoll backend also uses it to say "rebuild your array", so there the
// two cases have to be told apart - hence an explicit flag rather than
// treating any wakeup as terminal.
static int io_stopping = 0;

static yoop_mutex_t io_mu;
static int          io_mu_ready = 0;   // io_mu is never destroyed (see below)
static yoop_io_reg* io_regs     = NULL;
static uint64_t     io_seq_next = 1;   // 0 is the wakeup-channel sentinel

#ifdef YOOP_IO_KQUEUE
static int io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
static int io_ep = -1;
#endif

// ---- registration table (all callers hold io_mu) --------------------------

static yoop_io_reg* reg_find_seq_locked(uint64_t seq) {
    for (yoop_io_reg* r = io_regs; r; r = r->next) {
        if (r->seq == seq) return r;
    }
    return NULL;
}

static int reg_fd_taken_locked(int fd, int want_write) {
    for (yoop_io_reg* r = io_regs; r; r = r->next) {
        if (r->fd == fd && r->want_write == want_write) return 1;
    }
    return 0;
}

static void reg_remove_locked(yoop_io_reg* target) {
    yoop_io_reg** link = &io_regs;
    while (*link) {
        if (*link == target) { *link = target->next; free(target); return; }
        link = &(*link)->next;
    }
}

#ifdef YOOP_IO_WSAPOLL
// Nudge the I/O thread so it rebuilds its poll array.
//
// kqueue and epoll hold the interest set inside the kernel, so adding a
// registration takes effect against a poll that is already blocked. WSAPoll
// instead takes the whole array as an argument on each call, so a thread
// already inside WSAPoll is working from a snapshot and cannot see a new
// entry. Writing one byte to the wakeup socket returns it to the top of the
// loop, where it rebuilds from the current table.
//
// Safe to call with io_mu held: it touches only the wakeup socket.
static void io_wake_poll(void) {
    if (io_shutdown_w < 0) return;
    char b = 'w';
    (void)YOOP_WRITE_SOCK(io_shutdown_w, &b, 1);
}
#endif

// Drop a still-armed interest from the kernel's set. Failures are
// ignored on purpose: the fd may already have been closed by the
// caller, or the event may have been consumed one-shot before we got
// here. Either way there is nothing left to disarm.
static void io_deregister(int fd, int want_write) {
#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    EV_SET(&ev, fd, want_write ? EVFILT_WRITE : EVFILT_READ, EV_DELETE, 0, 0, NULL);
    (void)kevent(io_kq, &ev, 1, NULL, 0, NULL);
#endif
#ifdef YOOP_IO_EPOLL
    (void)want_write;
    (void)epoll_ctl(io_ep, EPOLL_CTL_DEL, fd, NULL);
#endif
#ifdef YOOP_IO_WSAPOLL
    // There is no kernel-side set to remove from: the caller has already
    // taken the entry out of io_regs under io_mu, and the next rebuild simply
    // will not include it. All that is left is to make that rebuild happen,
    // so the I/O thread stops polling a descriptor the caller may be about to
    // close.
    (void)fd; (void)want_write;
    io_wake_poll();
#endif
}

// Drain the wakeup channel so the next read sees fresh bytes.
static void drain_self_pipe(int fd) {
    char buf[64];
    while (YOOP_READ_SOCK(fd, buf, sizeof(buf)) > 0) { /* keep going */ }
}

// Deliver one readiness (or error) event to whichever wait registered
// `seq`. Returns with the waiter unparked, or does nothing at all if
// the registration is gone - which is exactly what happens when the
// waiter abandoned on a timeout or a cancellation.
//
// The whole body runs under io_mu, and `fired` is set before the
// unpark. That is the contract the abandon path relies on: a waiter
// that takes io_mu and sees fired == 0 knows the multiplexer can never
// reach its stack frame again once it removes the entry.
static void io_deliver(uint64_t seq, int err) {
    void* wake_task = NULL;
    yoop_mutex_lock(&io_mu);
    yoop_io_reg* r = reg_find_seq_locked(seq);
    if (r) {
        if (r->task) {
            // Async flavor: hand the task back to the scheduler. Deferred
            // until after the unlock - make_runnable takes the queue lock
            // and there is no reason to hold both.
            wake_task = r->task;
        } else {
            r->w->result_errno = err;
            r->w->fired        = 1;
            yoop_unpark(&r->w->token);
        }
        reg_remove_locked(r);
    }
    yoop_mutex_unlock(&io_mu);
    if (wake_task) yoop_task_make_runnable(wake_task);
}

#if defined(YOOP_IO_EPOLL) || defined(YOOP_IO_WSAPOLL)
// Pull the real error off a socket that reported EPOLLERR/EPOLLHUP (or
// POLLERR/POLLHUP). Both only tell you "something went wrong"; SO_ERROR is
// where the actual code lives. Reporting a blanket EIO (which is what this
// used to do) turns every connection refused / reset into the same
// uninformative message. kqueue needs no equivalent - EV_ERROR already
// carries the errno in ev->data.
static int io_socket_error(int fd, int fallback) {
    int err = 0;
#ifdef _WIN32
    int len = (int)sizeof(err);
    if (getsockopt((SOCKET)fd, SOL_SOCKET, SO_ERROR, (char*)&err, &len) == 0 && err != 0) {
        return yoop_wsa_to_errno(err);
    }
#else
    socklen_t len = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err != 0) {
        return err;
    }
#endif
    return fallback;
}
#endif

static void io_thread_main(void* arg) {
    (void)arg;
#ifdef YOOP_IO_KQUEUE
    struct kevent events[64];
    for (;;) {
        int n = kevent(io_kq, NULL, 0, events, 64, NULL);
        if (n < 0) {
            if (errno == EINTR) continue;
            // Fatal - exit the loop. The runtime is shutting down.
            break;
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct kevent* ev = &events[i];
            uint64_t seq = (uint64_t)(uintptr_t)ev->udata;
            // Self-pipe shutdown wake: seq 0 is the reserved sentinel.
            if (seq == 0 && (int)ev->ident == io_shutdown_r) {
                drain_self_pipe(io_shutdown_r);
                should_exit = 1;
                continue;
            }
            if (seq == 0) continue;
            io_deliver(seq, (ev->flags & EV_ERROR) ? (int)ev->data : 0);
        }
        if (should_exit) break;
    }
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event events[64];
    for (;;) {
        int n = epoll_wait(io_ep, events, 64, -1);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct epoll_event* ev = &events[i];
            uint64_t seq = ev->data.u64;
            if (seq == 0) {
                // Self-pipe wake.
                drain_self_pipe(io_shutdown_r);
                should_exit = 1;
                continue;
            }
            int err = 0;
            if (ev->events & (EPOLLERR | EPOLLHUP)) {
                // Look up the fd through the table so SO_ERROR can be
                // read - epoll's payload carries the seq, not the fd.
                int fd = -1;
                yoop_mutex_lock(&io_mu);
                yoop_io_reg* r = reg_find_seq_locked(seq);
                if (r) fd = r->fd;
                yoop_mutex_unlock(&io_mu);
                err = (fd >= 0) ? io_socket_error(fd, EIO) : EIO;
            }
            io_deliver(seq, err);
        }
        if (should_exit) break;
    }
#endif
#ifdef YOOP_IO_WSAPOLL
    // WSAPoll takes the interest set as an argument rather than holding it in
    // the kernel, so each pass snapshots the registration table into an array.
    // Slot 0 is always the wakeup socket, which is how a newly registered
    // interest (or a shutdown) gets this loop to rebuild rather than sitting
    // in a poll that predates it.
    WSAPOLLFD*  pfds = NULL;
    uint64_t*   seqs = NULL;   // parallel array: pfds[i] belongs to seqs[i]
    int         cap  = 0;

    for (;;) {
        // --- snapshot the table under io_mu, poll outside it ---------------
        yoop_mutex_lock(&io_mu);
        int count = 1; // slot 0 = wakeup socket
        for (yoop_io_reg* r = io_regs; r; r = r->next) count++;
        if (count > cap) {
            int ncap = count < 16 ? 16 : count * 2;
            WSAPOLLFD* np = (WSAPOLLFD*)realloc(pfds, sizeof(WSAPOLLFD) * (size_t)ncap);
            uint64_t*  ns = (uint64_t*)realloc(seqs, sizeof(uint64_t) * (size_t)ncap);
            if (!np || !ns) {
                // Out of memory while growing. Keep whatever we had rather
                // than losing the loop entirely; the next pass retries, and
                // in the meantime the already-registered waits still work.
                if (np) pfds = np;
                if (ns) seqs = ns;
                yoop_mutex_unlock(&io_mu);
                continue;
            }
            pfds = np; seqs = ns; cap = ncap;
        }
        pfds[0].fd      = (SOCKET)io_shutdown_r;
        pfds[0].events  = POLLRDNORM;
        pfds[0].revents = 0;
        seqs[0]         = 0; // reserved wakeup sentinel
        int i = 1;
        for (yoop_io_reg* r = io_regs; r && i < count; r = r->next, i++) {
            pfds[i].fd      = (SOCKET)r->fd;
            pfds[i].events  = (SHORT)(r->want_write ? POLLWRNORM : POLLRDNORM);
            pfds[i].revents = 0;
            seqs[i]         = r->seq;
        }
        int nfds = i;
        yoop_mutex_unlock(&io_mu);

        int n = WSAPoll(pfds, (ULONG)nfds, -1);
        if (n < 0) {
            if (WSAGetLastError() == WSAEINTR) continue;
            break;
        }
        if (n == 0) continue;

        int should_exit = 0;
        for (int k = 0; k < nfds; k++) {
            SHORT re = pfds[k].revents;
            if (!re) continue;
            if (k == 0) {
                // Wakeup channel: either a shutdown request or a "rebuild
                // now" nudge. Both are handled by draining and looping; the
                // shutdown flag is what distinguishes them.
                drain_self_pipe(io_shutdown_r);
                yoop_mutex_lock(&io_mu);
                should_exit = io_stopping;
                yoop_mutex_unlock(&io_mu);
                continue;
            }
            int err = 0;
            if (re & (POLLERR | POLLHUP | POLLNVAL)) {
                // POLLNVAL means the descriptor was closed out from under us;
                // there is no SO_ERROR to read in that case.
                err = (re & POLLNVAL) ? EBADF : io_socket_error((int)pfds[k].fd, EIO);
            }
            io_deliver(seqs[k], err);
        }
        if (should_exit) break;
    }
    free(pfds);
    free(seqs);
#endif
}

// Start the I/O thread. Caller holds io_init_mu; no-op if already up.
static void io_start_locked(void) {
    if (io_started) return;

    // io_mu guards the registration table and outlives every
    // start/shutdown cycle. It is deliberately never destroyed: a
    // waiter woken by shutdown still has to take it on its way out, and
    // destroying a mutex someone is about to lock is UB. One
    // process-lifetime mutex is a fair price.
    if (!io_mu_ready) { yoop_mutex_init(&io_mu); io_mu_ready = 1; }

#ifdef YOOP_IO_KQUEUE
    io_kq = kqueue();
    if (io_kq < 0) return;
#endif
#ifdef YOOP_IO_EPOLL
    io_ep = epoll_create1(EPOLL_CLOEXEC);
    if (io_ep < 0) return;
#endif

    // Wakeup channel. A pipe on POSIX; a loopback socketpair on Windows,
    // because WSAPoll cannot wait on a pipe handle.
    int fds[2];
    if (yoop_socketpair(fds) != 0) {
#ifdef YOOP_IO_KQUEUE
        close(io_kq); io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
        close(io_ep); io_ep = -1;
#endif
        return;
    }
    io_shutdown_r = fds[0];
    io_shutdown_w = fds[1];
    io_stopping   = 0;
    // Non-blocking so drain_self_pipe doesn't hang.
    yoop_io_set_nonblocking(io_shutdown_r);

#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    // seq 0 is the reserved shutdown sentinel.
    EV_SET(&ev, io_shutdown_r, EVFILT_READ, EV_ADD, 0, 0, NULL);
    kevent(io_kq, &ev, 1, NULL, 0, NULL);
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.u64 = 0; // shutdown sentinel
    epoll_ctl(io_ep, EPOLL_CTL_ADD, io_shutdown_r, &ev);
#endif
    // WSAPOLL needs no registration step: the wakeup socket is slot 0 of
    // every array the loop builds.

    if (yoop_thread_spawn(&io_thread, io_thread_main, NULL) != 0) {
        YOOP_CLOSE_SOCK(io_shutdown_r); io_shutdown_r = -1;
        YOOP_CLOSE_SOCK(io_shutdown_w); io_shutdown_w = -1;
#ifdef YOOP_IO_KQUEUE
        close(io_kq); io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
        close(io_ep); io_ep = -1;
#endif
        return;
    }
    io_started = 1;
}

void yoop_io_shutdown(void) {
    io_init_lock();
    if (!io_started) { io_init_unlock(); return; }

    // Announce the stop BEFORE poking the channel. The WSAPoll backend also
    // uses that channel for ordinary "rebuild your array" nudges, so the flag
    // - not the byte - is what tells the loop to exit. Published under io_mu
    // so the I/O thread's read of it is ordered against this write.
    yoop_mutex_lock(&io_mu);
    io_stopping = 1;
    yoop_mutex_unlock(&io_mu);

    // Wake the I/O thread by writing one byte to the wakeup channel.
    char b = 'x';
    (void)YOOP_WRITE_SOCK(io_shutdown_w, &b, 1);
    yoop_thread_join(&io_thread);

    // Release anyone still parked. Without this a thread waiting on an
    // fd that never becomes ready would block past runtime shutdown
    // with nothing left running to wake it. ESHUTDOWN surfaces as an
    // ordinary I/O error to the caller.
    yoop_mutex_lock(&io_mu);
    while (io_regs) {
        yoop_io_reg* r = io_regs;
        if (r->task) {
            // Let the task run again so it can observe the failure and
            // unwind, rather than stranding it forever.
            void* t = r->task;
            io_regs = r->next;
            free(r);
            yoop_mutex_unlock(&io_mu);
            yoop_task_make_runnable(t);
            yoop_mutex_lock(&io_mu);
            continue;
        }
        r->w->result_errno = ESHUTDOWN;
        r->w->fired        = 1;
        yoop_unpark(&r->w->token);
        io_regs = r->next;
        free(r);
    }
    yoop_mutex_unlock(&io_mu);

#ifdef YOOP_IO_KQUEUE
    if (io_kq >= 0) { close(io_kq); io_kq = -1; }
#endif
#ifdef YOOP_IO_EPOLL
    if (io_ep >= 0) { close(io_ep); io_ep = -1; }
#endif
    if (io_shutdown_r >= 0) { YOOP_CLOSE_SOCK(io_shutdown_r); io_shutdown_r = -1; }
    if (io_shutdown_w >= 0) { YOOP_CLOSE_SOCK(io_shutdown_w); io_shutdown_w = -1; }
    io_started  = 0;
    io_stopping = 0;
    io_init_unlock();
    // Restartable: io_started is a plain flag under io_init_mu, so a
    // later yoop_runtime_init spins the multiplexer back up. (The old
    // pthread_once guard made the second init a silent no-op.)
}

static int io_ensure_started(void) {
    io_init_lock();
    if (!io_started) io_start_locked();
    int ok = io_started;
    io_init_unlock();
    return ok;
}

// Arm a one-shot interest in `fd` carrying `seq`. Returns 0 on success,
// -1 with errno set.
static int io_register(int fd, int want_write, uint64_t seq) {
#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    int filter = want_write ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&ev, fd, filter, EV_ADD | EV_ONESHOT, 0, 0, (void*)(uintptr_t)seq);
    return kevent(io_kq, &ev, 1, NULL, 0, NULL) < 0 ? -1 : 0;
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event ev;
    ev.events   = (unsigned)(want_write ? EPOLLOUT : EPOLLIN) | EPOLLONESHOT;
    ev.data.u64 = seq;
    if (epoll_ctl(io_ep, EPOLL_CTL_ADD, fd, &ev) == 0) return 0;
    // A stale disarmed registration from an earlier wait on this fd can
    // linger; MOD re-arms it. This is safe here in a way it was NOT
    // before, because the table above already proved no OTHER waiter
    // currently owns this (fd, direction) - which is precisely the case
    // where MOD used to silently steal the first waiter's wakeup.
    if (errno == EEXIST) {
        return epoll_ctl(io_ep, EPOLL_CTL_MOD, fd, &ev) < 0 ? -1 : 0;
    }
    return -1;
#endif
#ifdef YOOP_IO_WSAPOLL
    // The caller has already linked the entry into io_regs under io_mu, and
    // that table IS the interest set here - there is no kernel-side object to
    // create. One-shot semantics come for free: io_deliver removes the entry,
    // so the next rebuild drops it. All that remains is to make the I/O
    // thread rebuild now rather than after its current WSAPoll returns.
    (void)fd; (void)want_write; (void)seq;
    io_wake_poll();
    return 0;
#endif
}

// The one wait implementation. Returns YOOP_WAIT_READY / TIMEDOUT /
// CANCELLED, or -1 with errno set.
static int io_wait_common(int fd, int want_write,
                          yoop_cancel_t* ct, uint64_t deadline_ns) {
    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

    // The token's own deadline and the caller's both apply; whichever
    // lands first wins. This is what makes "this request gets 5
    // seconds total" work without threading a deadline through every
    // intermediate call.
    uint64_t deadline = yoop_cancel_effective_deadline(ct, deadline_ns);

    // Cheap pre-checks so an already-cancelled token or an already-past
    // deadline never touches the kernel. An elapsed token deadline is a
    // TIMEDOUT, not a CANCELLED - only an explicit request is a
    // cancellation (see yoop_cancel_flagged).
    if (yoop_cancel_flagged(ct))                       return YOOP_WAIT_CANCELLED;
    if (deadline != 0 && yoop_now_ns() >= deadline)    return YOOP_WAIT_TIMEDOUT;

    yoop_io_wait_t w;
    yoop_park_token_init(&w.token);
    w.result_errno = 0;
    w.fired        = 0;

    // Claim the (fd, direction) slot before touching the kernel. Only
    // one waiter per pair: epoll's MOD and kqueue's EV_SET both
    // overwrite the stored payload, so a second concurrent registration
    // used to strand the first waiter forever with no wakeup coming.
    yoop_mutex_lock(&io_mu);
    if (reg_fd_taken_locked(fd, want_write)) {
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = EAGAIN;
        return -1;
    }
    yoop_io_reg* reg = (yoop_io_reg*)malloc(sizeof(yoop_io_reg));
    if (!reg) {
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = ENOMEM;
        return -1;
    }
    uint64_t seq = io_seq_next++;
    reg->seq        = seq;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->w          = &w;
    reg->task       = NULL;
    reg->next       = io_regs;
    io_regs         = reg;

    if (io_register(fd, want_write, seq) < 0) {
        int saved = errno;
        reg_remove_locked(reg);
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = saved;
        return -1;
    }
    yoop_mutex_unlock(&io_mu);

    // Ask the token to unpark us on cancellation. A token cancelled
    // between the pre-check above and here reports it here instead.
    yoop_cancel_waiter_t cw;
    int registered_with_token = 0;
    if (yoop_cancel_add_waiter(ct, &cw, &w.token) == 0) {
        registered_with_token = (ct != NULL);
    }

    int outcome;
    for (;;) {
        int timed_out = yoop_park_until(&w.token, deadline);

        yoop_mutex_lock(&io_mu);
        if (w.fired) {
            // The multiplexer already delivered (and removed the entry)
            // while holding io_mu, so it is provably done with `w`.
            yoop_mutex_unlock(&io_mu);
            outcome = (w.result_errno != 0) ? -1 : YOOP_WAIT_READY;
            break;
        }
        // Not fired: we still own the registration, so tearing it down
        // under io_mu guarantees the multiplexer can never reach this
        // stack frame again.
        if (yoop_cancel_flagged(ct)) {
            io_deregister(fd, want_write);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            outcome = YOOP_WAIT_CANCELLED;
            break;
        }
        if (timed_out || (deadline != 0 && yoop_now_ns() >= deadline)) {
            io_deregister(fd, want_write);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            outcome = YOOP_WAIT_TIMEDOUT;
            break;
        }
        // Spurious wake (e.g. a deadline change nudged the token).
        // Nothing decided yet - go back to parking.
        yoop_mutex_unlock(&io_mu);
    }

    // Deregister from the token BEFORE the park token dies: once this
    // returns, yoop_cancel_request can no longer unpark `w.token`.
    if (registered_with_token) yoop_cancel_remove_waiter(ct, &cw);

    int saved_errno = w.result_errno;
    yoop_park_token_destroy(&w.token);
    if (outcome == -1) errno = saved_errno;
    return outcome;
}

int yoop_io_wait_readable(int fd) {
    int rc = io_wait_common(fd, 0, NULL, 0);
    // The legacy two-arg form has no deadline and no token, so READY
    // and error are the only reachable outcomes.
    return rc == YOOP_WAIT_READY ? 0 : -1;
}

int yoop_io_wait_writable(int fd) {
    int rc = io_wait_common(fd, 1, NULL, 0);
    return rc == YOOP_WAIT_READY ? 0 : -1;
}

int yoop_io_wait_readable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns) {
    return io_wait_common(fd, 0, ct, deadline_ns);
}

// ----- async arming --------------------------------------------------------
//
// The whole point of the async runtime: register interest and RETURN,
// rather than parking the thread. The caller suspends its coroutine
// immediately afterwards, which releases the worker; delivery pushes the
// task back onto the run queue.
static int io_arm_common(int fd, int want_write) {
    void* task = yoop_current_task();
    if (!task) {
        // Not running on a worker (e.g. called straight from main). There
        // would be nothing to make runnable, so refuse rather than let
        // the caller suspend into a hole it can never come back from -
        // the yoop side falls back to the blocking wait on a 1.
        return 1;
    }
    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

    yoop_mutex_lock(&io_mu);
    if (reg_fd_taken_locked(fd, want_write)) {
        yoop_mutex_unlock(&io_mu);
        errno = EAGAIN;
        return -1;
    }
    yoop_io_reg* reg = (yoop_io_reg*)malloc(sizeof(yoop_io_reg));
    if (!reg) {
        yoop_mutex_unlock(&io_mu);
        errno = ENOMEM;
        return -1;
    }
    uint64_t seq = io_seq_next++;
    reg->seq        = seq;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->w          = NULL;
    reg->task       = task;
    reg->next       = io_regs;
    io_regs         = reg;

    if (io_register(fd, want_write, seq) < 0) {
        int saved = errno;
        reg_remove_locked(reg);
        yoop_mutex_unlock(&io_mu);
        errno = saved;
        return -1;
    }
    yoop_mutex_unlock(&io_mu);
    return 0;
}

int yoop_io_arm_readable(int fd) { return io_arm_common(fd, 0); }
int yoop_io_arm_writable(int fd) { return io_arm_common(fd, 1); }

// Is this errno the "try again later" code? EAGAIN and EWOULDBLOCK are
// the same value on Linux and macOS but are not required to be, and
// neither has a stable numeric value across platforms - so the test
// lives here rather than as a mirrored constant in yoop.
int yoop_io_would_block(int e) {
    if (e == EAGAIN || e == EWOULDBLOCK || e == EINPROGRESS) return 1;
#ifdef _WIN32
    // Winsock codes can still reach here from a call site that read
    // WSAGetLastError directly rather than going through sock_fail.
    if (e == WSAEWOULDBLOCK || e == WSAEINPROGRESS) return 1;
#endif
    return 0;
}

int yoop_io_set_nonblocking(int fd) {
#ifdef _WIN32
    // Winsock has no fcntl; FIONBIO is the one way to set the mode, and it is
    // write-only (there is no "get" to preserve other flags, which is fine -
    // blocking mode is the only flag this touches).
    u_long on = 1;
    if (ioctlsocket((SOCKET)fd, FIONBIO, &on) == SOCKET_ERROR) return yoop_sock_fail();
    return 0;
#else
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
#endif
}

int yoop_io_wait_writable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns) {
    return io_wait_common(fd, 1, ct, deadline_ns);
}

// ----- yoop_socketpair descriptor operations -------------------------------
//
// Exported so callers outside this file (notably the C tests under
// runtime/tests/) can work with a pair without having to know whether it is
// made of pipe fds or sockets.

int yoop_socketpair_close(int fd) {
    return YOOP_CLOSE_SOCK(fd);
}

int64_t yoop_socketpair_read(int fd, void* buf, size_t n) {
    return (int64_t)YOOP_READ_SOCK(fd, buf, n);
}

int64_t yoop_socketpair_write(int fd, const void* buf, size_t n) {
    return (int64_t)YOOP_WRITE_SOCK(fd, buf, n);
}
