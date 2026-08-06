// Platform shims shared by the runtime's translation units.
//
// These used to live as `static inline` definitions inside
// yoop_runtime.c, which was fine while it was the only file that
// needed a mutex. yoop_cancel.c needs the same primitives (a mutex, a
// condvar, and a timed wait that agrees with yoop_now_ns), so they move
// here rather than getting a second, subtly different copy.
//
// Everything is `static inline` - each TU gets its own copy and there
// is nothing to link. The concrete `struct yoop_mutex` / `yoop_cond` /
// `yoop_thread` layouts are private to the runtime; the public header
// only ever names them through pointers.
#ifndef YOOP_PLATFORM_H
#define YOOP_PLATFORM_H

#include "yoop_runtime.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#ifdef _WIN32
  // Header order is load-bearing and belongs here rather than in each TU.
  //
  // <windows.h> pulls in the original <winsock.h> unless WIN32_LEAN_AND_MEAN
  // is set, and <winsock.h> and <winsock2.h> declare the same types
  // incompatibly - so a file that includes this header and then reaches for
  // <winsock2.h> gets a wall of "redefinition of 'sockaddr'". Establishing
  // the order once, in the header every runtime TU already includes, is what
  // keeps that from being a trap each new file has to remember.
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  struct yoop_mutex  { CRITICAL_SECTION cs; };
  struct yoop_cond   { CONDITION_VARIABLE cv; };
  struct yoop_thread { HANDLE h; };

  static inline void yoop_mutex_init(yoop_mutex_t* m)    { InitializeCriticalSection(&m->cs); }
  static inline void yoop_mutex_destroy(yoop_mutex_t* m) { DeleteCriticalSection(&m->cs); }
  static inline void yoop_mutex_lock(yoop_mutex_t* m)    { EnterCriticalSection(&m->cs); }
  static inline void yoop_mutex_unlock(yoop_mutex_t* m)  { LeaveCriticalSection(&m->cs); }

  static inline void yoop_cond_init(yoop_cond_t* c)      { InitializeConditionVariable(&c->cv); }
  static inline void yoop_cond_destroy(yoop_cond_t* c)   { (void)c; }
  static inline void yoop_cond_wait(yoop_cond_t* c, yoop_mutex_t* m) {
      SleepConditionVariableCS(&c->cv, &m->cs, INFINITE);
  }
  static inline void yoop_cond_signal(yoop_cond_t* c)    { WakeConditionVariable(&c->cv); }
  static inline void yoop_cond_broadcast(yoop_cond_t* c) { WakeAllConditionVariable(&c->cv); }

  static inline int yoop_cpu_count(void) {
      SYSTEM_INFO si; GetSystemInfo(&si);
      return (int)si.dwNumberOfProcessors;
  }
#else
  #include <pthread.h>
  #include <unistd.h>
  struct yoop_mutex  { pthread_mutex_t m; };
  struct yoop_cond   { pthread_cond_t  c; };
  struct yoop_thread { pthread_t       t; };

  static inline void yoop_mutex_init(yoop_mutex_t* m)    { pthread_mutex_init(&m->m, NULL); }
  static inline void yoop_mutex_destroy(yoop_mutex_t* m) { pthread_mutex_destroy(&m->m); }
  static inline void yoop_mutex_lock(yoop_mutex_t* m)    { pthread_mutex_lock(&m->m); }
  static inline void yoop_mutex_unlock(yoop_mutex_t* m)  { pthread_mutex_unlock(&m->m); }

  // Linux can retarget a condvar's clock, and we want CLOCK_MONOTONIC so
  // an NTP step can't move a deadline. macOS has no
  // pthread_condattr_setclock, but it does have a RELATIVE timedwait,
  // which sidesteps the clock question entirely - see
  // yoop_cv_wait_until_locked below.
  static inline void yoop_cond_init(yoop_cond_t* c) {
  #if defined(__linux__)
      pthread_condattr_t attrs;
      pthread_condattr_init(&attrs);
      pthread_condattr_setclock(&attrs, CLOCK_MONOTONIC);
      pthread_cond_init(&c->c, &attrs);
      pthread_condattr_destroy(&attrs);
  #else
      pthread_cond_init(&c->c, NULL);
  #endif
  }
  static inline void yoop_cond_destroy(yoop_cond_t* c)   { pthread_cond_destroy(&c->c); }
  static inline void yoop_cond_wait(yoop_cond_t* c, yoop_mutex_t* m) {
      pthread_cond_wait(&c->c, &m->m);
  }
  static inline void yoop_cond_signal(yoop_cond_t* c)    { pthread_cond_signal(&c->c); }
  static inline void yoop_cond_broadcast(yoop_cond_t* c) { pthread_cond_broadcast(&c->c); }

  static inline int yoop_cpu_count(void) {
      long n = sysconf(_SC_NPROCESSORS_ONLN);
      return (n > 0) ? (int)n : 1;
  }
#endif

// The one timed-wait primitive every blocking path in the runtime goes
// through. `deadline_ns` is an absolute reading from yoop_now_ns (the
// monotonic clock); 0 means "no deadline, wait indefinitely".
//
// Returns 0 when the condvar was signalled (or woke spuriously - the
// caller must re-check its predicate either way) and 1 when the
// deadline elapsed.
//
// Keeping this in one place is what stops the deadline clock and the
// condvar clock from drifting apart, which is the bug class that made
// the pre-existing CLOCK_REALTIME deadlines unreliable.
static inline int yoop_cv_wait_until_locked(yoop_cond_t* c, yoop_mutex_t* m,
                                            uint64_t deadline_ns) {
    if (deadline_ns == 0) {
        yoop_cond_wait(c, m);
        return 0;
    }
#ifdef _WIN32
    // Loop until the ABSOLUTE deadline has genuinely passed by the monotonic
    // clock, rather than trusting a single ERROR_TIMEOUT.
    //
    // SleepConditionVariableCS takes a RELATIVE timeout measured against the
    // system tick, and that tick is 15.6ms by default - so it can report a
    // timeout up to one tick BEFORE the deadline has elapsed by
    // QueryPerformanceCounter (what yoop_now_ns reads). Callers treat a 1
    // return as "the deadline passed" and stop waiting, so a single early
    // report surfaces as a wait that gave up early.
    //
    // Observed as a ~15% flake on the FIRST timed wait in a process, which is
    // the tell: once anything raises the system timer resolution the tick
    // shrinks and the early return stops happening. A 50ms wait came back in
    // 39ms - almost exactly one default tick short.
    //
    // Re-checking the clock costs nothing in the common case (the deadline has
    // passed, and the loop exits on the first test) and makes every timed wait
    // in the runtime honor its deadline, since this is the one primitive they
    // all go through.
    for (;;) {
        uint64_t now = yoop_now_ns();
        if (now >= deadline_ns) return 1;
        DWORD ms = (DWORD)((deadline_ns - now + 999999ULL) / 1000000ULL);
        if (SleepConditionVariableCS(&c->cv, &m->cs, ms)) return 0;  // signalled
        if (GetLastError() != ERROR_TIMEOUT) return 0;               // spurious
        // Reported a timeout: go round and let the clock decide.
    }
#elif defined(__linux__)
    // The condvar was created against CLOCK_MONOTONIC, so the absolute
    // deadline can be handed over directly.
    struct timespec ts;
    ts.tv_sec  = (time_t)(deadline_ns / 1000000000ULL);
    ts.tv_nsec = (long)  (deadline_ns % 1000000000ULL);
    int rc = pthread_cond_timedwait(&c->c, &m->m, &ts);
    return rc == ETIMEDOUT ? 1 : 0;
#else
    // macOS / BSD: convert to a relative wait so the condvar's
    // CLOCK_REALTIME base never enters the picture.
    uint64_t now = yoop_now_ns();
    struct timespec rel;
    if (now >= deadline_ns) {
        rel.tv_sec = 0;
        rel.tv_nsec = 0;
    } else {
        uint64_t d = deadline_ns - now;
        rel.tv_sec  = (time_t)(d / 1000000000ULL);
        rel.tv_nsec = (long)  (d % 1000000000ULL);
    }
    int rc = pthread_cond_timedwait_relative_np(&c->c, &m->m, &rel);
    return rc == ETIMEDOUT ? 1 : 0;
#endif
}

// ----- threads -------------------------------------------------------------
//
// A spawn/join pair over the platform thread type. The runtime's worker pool
// had its own private copy of this (spawn_worker / join_worker in
// yoop_runtime.c, which predate this header); the C-level tests under
// runtime/tests/ needed the same two operations and were calling pthread
// directly, which is exactly the thing this header exists to stop.
//
// The thread body is typed `void (*)(void*)` rather than either platform's
// native signature - neither pthread's `void* (*)(void*)` nor Win32's
// `DWORD (WINAPI *)(LPVOID)` is expressible on the other side, and no caller
// in the tree uses the return value. A trampoline adapts it per platform.
typedef void (*yoop_thread_fn)(void*);

typedef struct yoop_thread_start {
    yoop_thread_fn fn;
    void*          arg;
} yoop_thread_start;

#ifdef _WIN32
static DWORD WINAPI yoop_thread_trampoline(LPVOID p) {
    yoop_thread_start* s = (yoop_thread_start*)p;
    yoop_thread_fn fn = s->fn;
    void* arg = s->arg;
    free(s);
    fn(arg);
    return 0;
}

// Returns 0 on success, -1 on failure.
static inline int yoop_thread_spawn(yoop_thread_t* t, yoop_thread_fn fn, void* arg) {
    yoop_thread_start* s = (yoop_thread_start*)malloc(sizeof(*s));
    if (!s) return -1;
    s->fn = fn; s->arg = arg;
    t->h = CreateThread(NULL, 0, yoop_thread_trampoline, s, 0, NULL);
    if (!t->h) { free(s); return -1; }
    return 0;
}

static inline void yoop_thread_join(yoop_thread_t* t) {
    if (!t->h) return;
    WaitForSingleObject(t->h, INFINITE);
    CloseHandle(t->h);
    t->h = NULL;
}
#else
static void* yoop_thread_trampoline(void* p) {
    yoop_thread_start* s = (yoop_thread_start*)p;
    yoop_thread_fn fn = s->fn;
    void* arg = s->arg;
    free(s);
    fn(arg);
    return NULL;
}

static inline int yoop_thread_spawn(yoop_thread_t* t, yoop_thread_fn fn, void* arg) {
    yoop_thread_start* s = (yoop_thread_start*)malloc(sizeof(*s));
    if (!s) return -1;
    s->fn = fn; s->arg = arg;
    if (pthread_create(&t->t, NULL, yoop_thread_trampoline, s) != 0) {
        free(s);
        return -1;
    }
    return 0;
}

static inline void yoop_thread_join(yoop_thread_t* t) {
    pthread_join(t->t, NULL);
}
#endif

// ----- Winsock error bridging ----------------------------------------------
//
// Winsock reports failures through WSAGetLastError, not errno. Everything
// above the C runtime - std/net, std/http, every `errno.message(errno.get())`
// in yoop - reads errno, so the translation has to happen at each call site
// that touches a socket. Both yoop_io.c and yoop_net.c need it, hence here.
#ifdef _WIN32

// The MSVC CRT's <errno.h> carries most of the POSIX supplemental codes but
// not ESHUTDOWN, which the multiplexer reports to anyone still parked when it
// is torn down. ECONNABORTED is the nearest code it does define, and being a
// real errno it renders as "software caused connection abort" rather than
// "Unknown error". Must precede the mapping below, which uses it.
#ifndef ESHUTDOWN
  #define ESHUTDOWN ECONNABORTED
#endif

// Map the Winsock codes the runtime can actually observe onto their errno
// equivalents, so a "would block" test or an error string means the same
// thing on every platform. Anything unlisted keeps its WSA value, which
// prints as an unknown error rather than being misreported as something else.
static inline int yoop_wsa_to_errno(int w) {
    switch (w) {
        case WSAEWOULDBLOCK:    return EAGAIN;
        case WSAEINPROGRESS:    return EINPROGRESS;
        case WSAEALREADY:       return EALREADY;
        case WSAENOTSOCK:       return ENOTSOCK;
        case WSAEADDRINUSE:     return EADDRINUSE;
        case WSAEADDRNOTAVAIL:  return EADDRNOTAVAIL;
        case WSAECONNREFUSED:   return ECONNREFUSED;
        case WSAECONNRESET:     return ECONNRESET;
        case WSAECONNABORTED:   return ECONNABORTED;
        case WSAENOTCONN:       return ENOTCONN;
        case WSAETIMEDOUT:      return ETIMEDOUT;
        case WSAEHOSTUNREACH:   return EHOSTUNREACH;
        case WSAENETUNREACH:    return ENETUNREACH;
        case WSAENETDOWN:       return ENETDOWN;
        case WSAEINTR:          return EINTR;
        case WSAEINVAL:         return EINVAL;
        case WSAEMFILE:         return EMFILE;
        case WSAEACCES:         return EACCES;
        case WSAEFAULT:         return EFAULT;
        case WSAESHUTDOWN:      return ESHUTDOWN;
        case WSAEMSGSIZE:       return EMSGSIZE;
        case WSAEISCONN:        return EISCONN;
        default:                return w;
    }
}

// Publish the last Winsock error as errno and return -1, so a Winsock call
// site can `return yoop_sock_fail();` and read exactly like its POSIX twin.
static inline int yoop_sock_fail(void) {
    errno = yoop_wsa_to_errno(WSAGetLastError());
    return -1;
}

#endif // _WIN32

// Allocate + initialize a mutex/cond pair on the heap. Returns NULL on
// allocation failure. Paired with yoop_cond_free / yoop_mutex_free.
static inline yoop_mutex_t* yoop_mutex_new(void) {
    yoop_mutex_t* m = (yoop_mutex_t*)malloc(sizeof(yoop_mutex_t));
    if (m) yoop_mutex_init(m);
    return m;
}

static inline yoop_cond_t* yoop_cond_new(void) {
    yoop_cond_t* c = (yoop_cond_t*)malloc(sizeof(yoop_cond_t));
    if (c) yoop_cond_init(c);
    return c;
}

static inline void yoop_mutex_free(yoop_mutex_t* m) {
    if (m) { yoop_mutex_destroy(m); free(m); }
}

static inline void yoop_cond_free(yoop_cond_t* c) {
    if (c) { yoop_cond_destroy(c); free(c); }
}

#endif // YOOP_PLATFORM_H
