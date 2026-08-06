// Yooperlang runtime - filesystem and directory helpers.
//
// Split out of yoop_io.c, which had accumulated two unrelated jobs: the I/O
// multiplexer and a pile of stat/mkdir/dirent wrappers. Nothing here touches
// the poller, and the poller does not call anything here - the two only ever
// shared a file, not a concern.
//
// The per-platform split inside this file is the dirent/FindFirstFile one:
// POSIX gets opendir/readdir/lstat, Windows gets FindFirstFile/_stat64. That
// divide is narrow enough to live behind a single #if rather than earning its
// own translation unit the way the poller backends do.

#include "yoop_runtime.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>

#ifdef _WIN32
  // <unistd.h> does not exist in the MSVC CRT. The pieces this file uses from
  // it are split across <io.h> and <direct.h> (_mkdir / _fullpath), and the
  // POSIX spellings are the deprecated underscore-free aliases, so the code
  // below names the underscore forms explicitly.
  //
  // Header order is load-bearing even here: <windows.h> pulls in the legacy
  // <winsock.h> unless WIN32_LEAN_AND_MEAN is set, and that conflicts with
  // the <winsock2.h> other TUs include. See yoop_platform.h.
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <windows.h>
  #include <direct.h>
  #include <io.h>
  #include <lmcons.h>
  // GetUserName, which backs yoop_io_user_name. Declared in the source so the
  // flag does not have to be threaded through runtimeBuild.js.
  #pragma comment(lib, "advapi32.lib")
#else
  #include <unistd.h>
  #include <dirent.h>
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
