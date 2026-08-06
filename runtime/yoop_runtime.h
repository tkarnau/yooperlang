// Yooperlang runtime - C ABI exposed to LLVM IR emitted by jsyoopcodegen.
// See plans/phase-6-3-prelude.md and plans/runtime-design.md.
#ifndef YOOP_RUNTIME_H
#define YOOP_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque platform types. Concrete layout in yoop_runtime.c.
typedef struct yoop_mutex  yoop_mutex_t;
typedef struct yoop_cond   yoop_cond_t;
typedef struct yoop_thread yoop_thread_t;

// init / shutdown - both idempotent.
void yoop_runtime_init(void);
void yoop_runtime_shutdown(void);

// scheduling
void yoop_task_submit(void* handle, void (*thunk)(void*));
void yoop_task_wait(void* handle);

// Phase 10.F: bounded wait. Returns 0 when the handle's state flipped to
// "done" before `deadline_ns` (a monotonic-clock nanosecond reading from
// yoop_now_ns), 1 when the deadline elapsed first, 2 when an external
// `yoop_task_cancel` was observed before either. Does not dispatch
// queued tasks on the calling thread - see runtime/yoop_runtime.c for
// the rationale.
int yoop_task_wait_until_ns(void* handle, uint64_t deadline_ns);

// Phase 10.F.2: external cancellation. Atomically sets the cancel byte
// in the handle's prefix (offset 9 - reuses one of the existing pad
// bytes between `state` and `refcount`, so no ABI/layout change) and
// broadcasts queue_cv so any wait_until parked on the handle wakes
// immediately and observes the cancellation.
//
// Cancellation is cooperative on the task-body side: the worker thread
// still runs the body to natural completion. The semantics this
// primitive provides is "abandon-the-wait": the caller can stop
// waiting for the result and treat the handle as done-from-its-side.
// In-body polling (Phase 10.F.2.b) will give task bodies a way to
// observe the same flag and exit early.
void yoop_task_cancel(void* handle);

// Phase 10.F: monotonic clock reading in nanoseconds, suitable for
// computing wait_until deadlines (`now_ns() + duration_ns`).
//
// This is genuinely monotonic on every platform now (CLOCK_MONOTONIC on
// Linux and macOS, QueryPerformanceCounter on Windows). It used to read
// CLOCK_REALTIME, which meant an NTP step moved every in-flight
// deadline; every timed wait in the runtime shares this clock via
// yoop_cv_wait_until, so the two can't drift apart. Use yoop_wall_ns if
// you actually want a timestamp rather than a deadline base.
uint64_t yoop_now_ns(void);

// Wall-clock reading in nanoseconds since the Unix epoch. NOT usable as
// a deadline base - it can step backwards. Use yoop_now_ns for that.
uint64_t yoop_wall_ns(void);

// pooled lifecycle
void* yoop_task_alloc(size_t size);
void  yoop_task_retain(void* handle);
void  yoop_task_release(void* handle);

// Called from per-task thunks after the result has been stored: flips state to
// 1, broadcasts the condvar, and (for pooled handles) drops the worker's
// implicit reference.
void yoop_handle_signal_done(void* handle);

// ----- async task scheduling ----------------------------------------------
//
// A task body is an LLVM coroutine. The thunk STARTS it (handing it the
// task's own result slot) and stores the handle at handle offset 32;
// everything after that is resume-driven, so a task that blocks on I/O
// gives its worker thread back instead of holding it.
//
// The coroutine trampolines are emitted by CODEGEN, because they wrap
// LLVM intrinsics that C cannot call. The runtime receives them as
// function pointers rather than linking against them by name: the C
// runtime has to stay linkable on its own (the runtime/tests/ programs
// build it with no generated IR at all), and a direct call would make
// every one of those an undefined symbol.
//
// main installs them right after yoop_runtime_init. When they are absent
// - a pure-C program, or yoop code with no task in it - a task is
// treated as finishing in one step, which is exactly the pre-async
// behavior.
typedef void (*yoop_coro_fn)(void* coro);
typedef int  (*yoop_coro_pred)(void* coro);
void yoop_runtime_set_coro_ops(yoop_coro_fn resume,
                               yoop_coro_fn destroy,
                               yoop_coro_pred done);

// Called at the end of every task step - the initial start and each
// later resume. Decides whether the coroutine reached its final suspend
// (result is in the slot: signal completion and destroy the frame) or
// merely suspended (leave it parked; whatever suspended it registered a
// wakeup). This is the single place that distinction is made.
void yoop_task_settle(void* handle);

// Push a suspended task back onto the run queue. Called by whatever
// resolved the thing the task was waiting on - the I/O multiplexer on
// readiness, a timer on expiry. Safe from any thread.
void yoop_task_make_runnable(void* handle);

// The task currently executing on this thread, or NULL when the calling
// thread is not running one (e.g. main). Set by the worker around each
// step, so a suspend primitive deep in a call chain can register a
// wakeup against the right task without threading a handle through every
// intermediate signature.
void* yoop_current_task(void);

// Stack-handle cleanup helper. For stack-allocated handles, codegen calls this
// at scope exit to release the mutex/cond pair allocated by yoop_task_submit.
void yoop_task_free_sync_pair(void* handle);

// Phase 8.D - errno bridge. Thread-local read/write of the platform's errno
// lvalue (macOS __error(), glibc/musl __errno_location(), Windows _errno),
// plus a thin strerror wrapper. Kept in the runtime so yoop codegen does
// not have to know the platform-specific symbol for errno's TLS slot.
int yoop_errno_get(void);
void yoop_errno_set(int v);
const char* yoop_errno_message(int c);

// ----- Phase 8.F.1 - Concurrency primitives -------------------------------
//
// A park token is a single-thread synchronization primitive. The owning
// thread (the "parker") calls yoop_park() to block; another thread
// (typically the multiplexer or timer thread) calls yoop_unpark() to
// release it. Unpark-before-park is supported: the wake is remembered
// until the next park consumes it.
//
// Ownership rules:
//   - Exactly one thread calls yoop_park on a given token.
//   - Any number of threads may call yoop_unpark.
//   - Destroying a token while it might be parked or unparked is UB.
//     Callers must ensure all in-flight unpark() calls have completed
//     before destroy().
//
// State machine:
//   0 = idle           : park will block; unpark transitions to 1
//   1 = pending wake   : park returns immediately, transitions back to 0
//   2 = parking        : a yoop_park is blocked on cv; unpark signals it
//
// Internal layout (do not access fields directly):
typedef struct yoop_park_token {
    struct yoop_mutex* mu;   // allocated by init, freed by destroy
    struct yoop_cond*  cv;
    int                state;
} yoop_park_token_t;

void yoop_park_token_init(yoop_park_token_t* t);
void yoop_park_token_destroy(yoop_park_token_t* t);
void yoop_park(yoop_park_token_t* t);
void yoop_unpark(yoop_park_token_t* t);

// Timed sibling of yoop_park. Blocks until unparked or until the
// monotonic reading `deadline_ns` (from yoop_now_ns) elapses. Returns 0
// when an unpark was consumed, 1 when the deadline elapsed first.
// A deadline of 0 means "no deadline" and is identical to yoop_park.
//
// On a 1 return the token is left in the idle state, so a later unpark
// from a racing thread is remembered as a pending wake rather than
// lost - callers that abandon a wait must still prove no unpark is
// in flight before destroying the token (see yoop_io.c's fired/io_mu
// handshake for the pattern).
int yoop_park_until(yoop_park_token_t* t, uint64_t deadline_ns);

// ----- Cancellation tokens (runtime/yoop_cancel.c) -------------------------
//
// A cancellation token is a refcounted, thread-safe object carrying a
// cancelled flag, an optional deadline, and a list of parked threads to
// wake. It is the unit of "stop waiting" for everything in the runtime
// that can block: I/O waits, sleeps, and task waits.
//
// Tokens are explicit values - nothing is implicitly attached to a task
// or a thread. Pass one down a call chain and every nested blocking
// call inherits both the cancellation and the deadline.
//
// Outcome codes, shared by every cancel-aware blocking call:
//   0 = the thing you waited for happened
//   1 = the deadline elapsed first
//   2 = the token was cancelled first
//  -1 = error, errno set
#define YOOP_WAIT_READY     0
#define YOOP_WAIT_TIMEDOUT  1
#define YOOP_WAIT_CANCELLED 2

typedef struct yoop_cancel yoop_cancel_t;

// new: refcount 1, not cancelled, no deadline.
// new_deadline: same, with an absolute yoop_now_ns deadline (0 = none).
yoop_cancel_t* yoop_cancel_new(void);
yoop_cancel_t* yoop_cancel_new_deadline(uint64_t deadline_ns);

void yoop_cancel_retain(yoop_cancel_t* t);
void yoop_cancel_release(yoop_cancel_t* t);

// Set the cancelled flag, wake every parked waiter, and cascade to
// every linked child. Idempotent; safe from any thread.
void yoop_cancel_request(yoop_cancel_t* t);

// 1 if cancelled OR the deadline has elapsed, else 0. A null token is
// never cancelled (so callers can pass NULL for "no token" without
// branching). This is the "should I stop?" predicate - it deliberately
// does not say WHY.
int yoop_cancel_requested(yoop_cancel_t* t);

// 1 only if someone explicitly called yoop_cancel_request; an elapsed
// deadline does NOT count.
//
// The split exists because the two reasons deserve different outcomes.
// A call that was doing work (an I/O wait, a sleep) reports
// YOOP_WAIT_TIMEDOUT when it ran out of time and YOOP_WAIT_CANCELLED
// when someone asked it to stop - "you ran out of time" and "you were
// cancelled" lead to different handling at the call site, and folding
// a token deadline into "cancelled" loses that.
//
// yoop_cancel_wait is the one exception: it OBSERVES a token rather
// than doing work, so a token that fires for either reason is
// YOOP_WAIT_CANCELLED there and YOOP_WAIT_TIMEDOUT is reserved for the
// caller's own deadline winning the race.
int yoop_cancel_flagged(yoop_cancel_t* t);

// The token's absolute deadline, or 0 for none.
uint64_t yoop_cancel_deadline_ns(yoop_cancel_t* t);

// Install/replace the deadline. Passing a deadline already in the past
// makes the token immediately "requested".
void yoop_cancel_set_deadline_ns(yoop_cancel_t* t, uint64_t deadline_ns);

// Cancel `child` whenever `parent` is cancelled. The child retains the
// parent, so the parent outlives the link. Returns 0 on success, -1 if
// either argument is null or they are the same token. If the parent is
// already cancelled the child is cancelled immediately.
//
// Links must form a tree - linking a token into its own ancestry is
// caller error and will spin the cascade.
int yoop_cancel_link(yoop_cancel_t* child, yoop_cancel_t* parent);

// Sleep for `ns`, waking early if the token fires. Returns
// YOOP_WAIT_READY when the full duration elapsed, YOOP_WAIT_CANCELLED
// on an explicit cancel, YOOP_WAIT_TIMEDOUT when the token's own
// deadline cut the sleep short.
int yoop_cancel_sleep_ns(yoop_cancel_t* t, uint64_t ns);

// Block until the token is cancelled, its own deadline elapses, or the
// caller's `deadline_ns` elapses (0 = no caller deadline). Returns
// YOOP_WAIT_CANCELLED when the token fired, YOOP_WAIT_TIMEDOUT when the
// caller's deadline won.
int yoop_cancel_wait(yoop_cancel_t* t, uint64_t deadline_ns);

// ----- waiter registration (internal; used by yoop_io.c) -------------------
//
// Splice a park token onto a cancel token's wake list so a cancel
// request unparks it. The waiter node is caller-allocated (typically on
// the parking thread's stack) and must be removed before that storage
// dies.
//
// add_waiter returns 1 if the token was ALREADY cancelled - in that
// case the node is NOT registered and the caller must not remove it.
typedef struct yoop_cancel_waiter {
    yoop_park_token_t*         token;
    struct yoop_cancel_waiter* next;
    struct yoop_cancel_waiter* prev;
} yoop_cancel_waiter_t;

int  yoop_cancel_add_waiter(yoop_cancel_t* t, yoop_cancel_waiter_t* w,
                            yoop_park_token_t* park);
void yoop_cancel_remove_waiter(yoop_cancel_t* t, yoop_cancel_waiter_t* w);

// Combine a caller-supplied deadline with the token's own, returning
// whichever comes first (0 from either side means "no deadline").
uint64_t yoop_cancel_effective_deadline(yoop_cancel_t* t, uint64_t deadline_ns);

// ----- Phase 8.F.3 - Timers ------------------------------------------------
//
// Block the calling thread for `ns` nanoseconds (or `ms` milliseconds).
// Returns 0 on the timer firing, -1 on error with errno set. The clock
// is monotonic on Linux (CLOCK_MONOTONIC via pthread_condattr_setclock),
// and CLOCK_REALTIME on macOS (where pthread_condattr_setclock isn't
// available). Both are monotonic-enough for sleep-for-duration uses.
int yoop_sleep_ns(uint64_t ns);
int yoop_sleep_ms(uint64_t ms);

// ----- --track-heap diagnostics --------------------------------------------
//
// Counter ABI used by `--track-heap` builds. yoop_diag_record_alloc and
// yoop_diag_record_free are emitted by codegen alongside each heap_alloc /
// heap_free intrinsic; yoop_diag_dump is called from main immediately
// before yoop_runtime_shutdown. The bytes argument is the malloc/free
// byte size (count * sizeof(elem)), not the element count.
void yoop_diag_record_alloc(uint64_t bytes);
void yoop_diag_record_free(uint64_t bytes);
void yoop_diag_dump(void);

// ----- Phase 8.F.2 - I/O multiplexer (forward declarations) ----------------
// Implemented in runtime/yoop_io.c. Declared here so callers don't need
// a second header. Lazy init on first call; shutdown is hooked into
// yoop_runtime_shutdown if init ran.
// Park until `fd` is ready. Return 0 on ready, -1 on error with errno
// set. These block indefinitely - prefer the _ex forms below for
// anything that should be abandonable.
int yoop_io_wait_readable(int fd);
int yoop_io_wait_writable(int fd);

// Deadline- and cancellation-aware readiness wait. `ct` may be NULL for
// "no token"; `deadline_ns` may be 0 for "no deadline" (the token's own
// deadline, if any, still applies). Returns one of the YOOP_WAIT_*
// codes: READY, TIMEDOUT, CANCELLED, or -1 with errno set.
//
// Only ONE waiter per (fd, direction) is permitted. A second concurrent
// registration fails with -1 / EAGAIN rather than silently displacing
// the first - epoll's MOD and kqueue's EV_SET both overwrite the stored
// user pointer, which used to strand the original waiter forever.
int yoop_io_wait_readable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns);
int yoop_io_wait_writable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns);

// ----- async (non-blocking) readiness -------------------------------------
//
// The async counterpart of the wait_* calls above. Instead of parking the
// calling thread, this ARMS a one-shot interest in `fd` and returns
// immediately; when the fd becomes ready the multiplexer calls
// yoop_task_make_runnable on the task that armed it.
//
// The caller is expected to `await suspendNow()` right after a successful
// arm, so the pattern in yoop is:
//
//     let rc = armReadable(fd);      // 0 = armed, will be woken
//     if (rc != 0) { return rc; }
//     await conc.suspendNow();       // worker goes free here
//
// Returns 0 when armed, -1 with errno set on failure, and 1 when there is
// no current task to wake (called off a worker thread) - in which case
// the caller must fall back to the blocking wait_* form rather than
// suspend, because nothing would ever resume it.
int yoop_io_arm_readable(int fd);
int yoop_io_arm_writable(int fd);

// Put `fd` into non-blocking mode. Async reads and writes are
// "try the syscall, and if it would block, arm and suspend", which only
// works if the syscall actually returns EAGAIN instead of sleeping.
// Returns 0 on success, -1 with errno set.
//
// A runtime helper rather than an fcntl mirror in yoop because F_GETFL /
// F_SETFL / O_NONBLOCK are platform-specific values.
int yoop_io_set_nonblocking(int fd);

// 1 if `e` is the "would block, try again" errno. EAGAIN/EWOULDBLOCK
// have no portable numeric value, so this is resolved in C.
int yoop_io_would_block(int e);

void yoop_io_shutdown(void);

// Perform any one-time per-process socket-library setup. A no-op with BSD
// sockets; on Windows it runs WSAStartup, which must precede the first socket
// call in the process. Idempotent and safe to call from any thread, so every
// entry point that can be the first to touch a socket just calls it.
void yoop_net_startup(void);

// Create a connected pair of descriptors: fds[0] is the read end, fds[1] the
// write end. Returns 0, or -1 with errno set.
//
// This is pipe() on POSIX and a loopback TCP socketpair on Windows, because
// Windows pipe handles cannot be waited on by the multiplexer (WSAPoll accepts
// sockets only). Anything that needs a descriptor the multiplexer can wait on
// must come from here rather than from pipe() directly.
int yoop_socketpair(int fds[2]);

// Close / read / write a descriptor obtained from yoop_socketpair. On POSIX
// these are close/read/write; on Windows the pair are sockets and need
// closesocket/recv/send, which are a different namespace from CRT fds.
int     yoop_socketpair_close(int fd);
int64_t yoop_socketpair_read(int fd, void* buf, size_t n);
int64_t yoop_socketpair_write(int fd, const void* buf, size_t n);

// ----- POSIX-shaped socket calls -------------------------------------------
//
// These present the BSD-sockets shape - int descriptors, -1 on failure, errno
// set - on every platform, so std/net/socket_ffi.yoop can stay free of
// platform conditionals. On POSIX each is a direct passthrough; on Windows
// each bridges Winsock's SOCKET handles and WSAGetLastError reporting. See
// the block comment in yoop_net.c for why the yoop layer cannot call libc
// directly here.
int     yoop_sock_socket(int domain, int type, int proto);
int     yoop_sock_bind(int fd, const void* addr, int len);
int     yoop_sock_listen(int fd, int backlog);
int     yoop_sock_accept(int fd, void* addr, int* len);
int     yoop_sock_connect(int fd, const void* addr, int len);
int64_t yoop_sock_send(int fd, const void* buf, size_t n, int flags);
int64_t yoop_sock_recv(int fd, void* buf, size_t n, int flags);
int     yoop_sock_close(int fd);
uint16_t yoop_sock_htons(uint16_t v);
uint32_t yoop_sock_inet_addr(const char* s);

// Create a directory with standard 0755 permissions (mode computed from
// POSIX S_* symbols per platform). Returns mkdir()'s rc.
int yoop_io_mkdir(const char* path);

// 1 if `path` exists (any type), 0 otherwise.
int yoop_io_exists(const char* path);

// Size in bytes of the regular file at `path`, or -1 on error.
int64_t yoop_io_file_size(const char* path);

// Canonicalize `path` into a freshly malloc'd absolute path stored in *out
// (caller owns it). Returns 0 on success, -1 with errno set on failure.
int yoop_io_normalize_real_path(const char* path, char** out);

// Directory iteration. opendir returns NULL on failure; readdir returns the
// next name (skipping "." and ".."), or "" when the stream is exhausted, in a
// buffer borrowed from the stream. Backed by dirent; a no-op on Windows.
void* yoop_io_opendir(const char* path);
const char* yoop_io_readdir(void* d);
void yoop_io_closedir(void* d);

// Metadata for one path from a single lstat. Returns the byte size, or -1 on
// failure. See runtime/yoop_io.c for the out-param contract.
int64_t yoop_io_stat2(const char* path, int32_t* is_dir);
int64_t yoop_io_stat_meta(const char* path, int32_t* kind, int32_t* perm,
                          int32_t* nlink, int32_t* uid, int32_t* gid,
                          int64_t* mtime);

// Owner/group names and an ls-style local timestamp. Caller owns the results.
char* yoop_io_user_name(int32_t uid);
char* yoop_io_group_name(int32_t gid);
char* yoop_io_time_string(int64_t epoch);

#ifdef __cplusplus
}
#endif

#endif
