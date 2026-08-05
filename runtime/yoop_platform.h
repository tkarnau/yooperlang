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
    uint64_t now = yoop_now_ns();
    DWORD ms = now >= deadline_ns
        ? 0
        : (DWORD)((deadline_ns - now + 999999ULL) / 1000000ULL);
    BOOL ok = SleepConditionVariableCS(&c->cv, &m->cs, ms);
    if (ok) return 0;
    return GetLastError() == ERROR_TIMEOUT ? 1 : 0;
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
