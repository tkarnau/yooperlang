// Cancellation tokens for the Yooperlang runtime.
//
// A token bundles three things:
//
//   * a cancelled flag, settable from any thread,
//   * an optional absolute deadline (on the yoop_now_ns monotonic
//     clock), and
//   * a list of parked threads to wake when either fires.
//
// Tokens are explicit values. Nothing is implicitly attached to a task
// or a thread - you create one and pass it down the call chain, and
// every nested blocking call inherits both the cancellation and the
// deadline. That is what makes them work for plain functions and not
// just task bodies.
//
// There is deliberately NO timer thread. A deadline fires because every
// blocking call folds the token's deadline into its own via
// yoop_cancel_effective_deadline and hands the result to a timed wait.
// Nothing has to be woken on a schedule, so there is no timer wheel to
// keep consistent and no extra thread to shut down.
//
// Lock ordering: a parent's mutex may be taken before a child's, never
// the reverse. In practice the cascade in yoop_cancel_request drops the
// parent's lock before touching any child at all, so the only ordering
// that matters is cancel-mutex before park-token mutex (via yoop_unpark).

#include "yoop_runtime.h"
#include "yoop_platform.h"

#include <stdatomic.h>
#include <stdlib.h>

struct yoop_cancel {
    yoop_mutex_t mu;
    yoop_cond_t  cv;              // woken on cancel / deadline change

    _Atomic int32_t  refcount;
    _Atomic uint8_t  cancelled;
    _Atomic uint64_t deadline_ns; // 0 = none

    yoop_cancel_waiter_t* waiters; // parked threads, guarded by mu

    // Child links. A child retains its parent, so the parent always
    // outlives the link. The parent's list holds BORROWED pointers -
    // see try_retain_locked for how the cascade avoids resurrecting a
    // child that is already being destroyed.
    struct yoop_cancel* parent;
    struct yoop_cancel* child_head;
    struct yoop_cancel* sibling_next;
    struct yoop_cancel* sibling_prev;
};

// Whichever deadline comes first, treating 0 as "none".
static uint64_t min_deadline(uint64_t a, uint64_t b) {
    if (a == 0) return b;
    if (b == 0) return a;
    return a < b ? a : b;
}

// ---- lifecycle ------------------------------------------------------------

yoop_cancel_t* yoop_cancel_new_deadline(uint64_t deadline_ns) {
    yoop_cancel_t* t = (yoop_cancel_t*)calloc(1, sizeof(yoop_cancel_t));
    if (!t) return NULL;
    yoop_mutex_init(&t->mu);
    yoop_cond_init(&t->cv);
    atomic_store_explicit(&t->refcount, 1, memory_order_release);
    atomic_store_explicit(&t->cancelled, 0, memory_order_release);
    atomic_store_explicit(&t->deadline_ns, deadline_ns, memory_order_release);
    return t;
}

yoop_cancel_t* yoop_cancel_new(void) {
    return yoop_cancel_new_deadline(0);
}

void yoop_cancel_retain(yoop_cancel_t* t) {
    if (!t) return;
    atomic_fetch_add_explicit(&t->refcount, 1, memory_order_acq_rel);
}

// Bump the refcount only if the object is still alive. Returns 0 when
// the previous count was already 0, meaning some other thread has
// committed to destroying it and the pointer must not be used.
//
// The undo decrement is safe: the destroyer stopped consulting the
// count the moment its own decrement returned 1, so pushing the value
// back to 0 cannot confuse it. Callers must hold the lock that also
// guards the destroyer's unlink step (the parent's mutex), which is
// what keeps the memory alive across this whole dance.
static int try_retain(yoop_cancel_t* t) {
    int32_t prev = atomic_fetch_add_explicit(&t->refcount, 1, memory_order_acq_rel);
    if (prev <= 0) {
        atomic_fetch_sub_explicit(&t->refcount, 1, memory_order_acq_rel);
        return 0;
    }
    return 1;
}

// Unlink `t` from its parent's child list. Caller must hold p->mu.
static void unlink_from_parent_locked(yoop_cancel_t* p, yoop_cancel_t* t) {
    if (t->sibling_prev) t->sibling_prev->sibling_next = t->sibling_next;
    else if (p->child_head == t) p->child_head = t->sibling_next;
    if (t->sibling_next) t->sibling_next->sibling_prev = t->sibling_prev;
    t->sibling_prev = NULL;
    t->sibling_next = NULL;
}

void yoop_cancel_release(yoop_cancel_t* t) {
    if (!t) return;
    int32_t prev = atomic_fetch_sub_explicit(&t->refcount, 1, memory_order_acq_rel);
    if (prev != 1) return;

    // Refcount is now 0 and we own the teardown. Detach from the parent
    // before freeing so a concurrent cascade can never reach us: the
    // cascade walks the child list under the parent's lock, and we take
    // that same lock here.
    yoop_cancel_t* p = t->parent;
    if (p) {
        yoop_mutex_lock(&p->mu);
        unlink_from_parent_locked(p, t);
        yoop_mutex_unlock(&p->mu);
        t->parent = NULL;
        yoop_cancel_release(p);
    }

    yoop_cond_destroy(&t->cv);
    yoop_mutex_destroy(&t->mu);
    free(t);
}

// ---- state ----------------------------------------------------------------

uint64_t yoop_cancel_deadline_ns(yoop_cancel_t* t) {
    if (!t) return 0;
    return atomic_load_explicit(&t->deadline_ns, memory_order_acquire);
}

uint64_t yoop_cancel_effective_deadline(yoop_cancel_t* t, uint64_t deadline_ns) {
    return min_deadline(deadline_ns, yoop_cancel_deadline_ns(t));
}

// A null token is never cancelled, so callers can pass NULL for "no
// token" without branching at every site.
int yoop_cancel_requested(yoop_cancel_t* t) {
    if (!t) return 0;
    if (atomic_load_explicit(&t->cancelled, memory_order_acquire)) return 1;
    uint64_t d = atomic_load_explicit(&t->deadline_ns, memory_order_acquire);
    if (d != 0 && yoop_now_ns() >= d) return 1;
    return 0;
}

int yoop_cancel_flagged(yoop_cancel_t* t) {
    if (!t) return 0;
    return atomic_load_explicit(&t->cancelled, memory_order_acquire) ? 1 : 0;
}

// Has the token's own deadline elapsed? (Independent of the flag.)
static int deadline_elapsed(yoop_cancel_t* t) {
    uint64_t d = atomic_load_explicit(&t->deadline_ns, memory_order_acquire);
    return (d != 0 && yoop_now_ns() >= d) ? 1 : 0;
}

// Wake everything parked on this token. Caller must hold t->mu.
//
// yoop_unpark is called under the lock on purpose: a waiter that wants
// to deregister has to take the same lock, so once
// yoop_cancel_remove_waiter returns, no unpark can still be in flight
// against that waiter's storage.
static void wake_waiters_locked(yoop_cancel_t* t) {
    for (yoop_cancel_waiter_t* w = t->waiters; w; w = w->next) {
        yoop_unpark(w->token);
    }
    yoop_cond_broadcast(&t->cv);
}

void yoop_cancel_request(yoop_cancel_t* t) {
    if (!t) return;

    yoop_mutex_lock(&t->mu);
    atomic_store_explicit(&t->cancelled, 1, memory_order_release);
    wake_waiters_locked(t);

    // Snapshot the children while holding the lock, retaining each so
    // it cannot be freed out from under the cascade. Children that are
    // mid-destruction fail try_retain and are skipped - they are on
    // their way out anyway and nothing can still be waiting on them.
    int n = 0;
    for (yoop_cancel_t* c = t->child_head; c; c = c->sibling_next) n++;
    yoop_cancel_t** kids = NULL;
    int count = 0;
    if (n > 0) {
        kids = (yoop_cancel_t**)malloc(sizeof(yoop_cancel_t*) * (size_t)n);
        if (kids) {
            for (yoop_cancel_t* c = t->child_head; c; c = c->sibling_next) {
                if (try_retain(c)) kids[count++] = c;
            }
        }
    }
    yoop_mutex_unlock(&t->mu);

    // Cascade with the parent's lock dropped, so a deep chain never
    // holds more than one token's mutex at a time.
    for (int i = 0; i < count; i++) {
        yoop_cancel_request(kids[i]);
        yoop_cancel_release(kids[i]);
    }
    free(kids);
}

void yoop_cancel_set_deadline_ns(yoop_cancel_t* t, uint64_t deadline_ns) {
    if (!t) return;
    yoop_mutex_lock(&t->mu);
    atomic_store_explicit(&t->deadline_ns, deadline_ns, memory_order_release);
    // Wake every waiter so it recomputes its effective deadline. Threads
    // that parked before this call baked the OLD deadline into their
    // timed wait; without the nudge, shortening a deadline would not
    // take effect until the original one elapsed. Every cancel-aware
    // wait loops on its predicate, so a spurious wake just re-parks.
    wake_waiters_locked(t);
    yoop_mutex_unlock(&t->mu);
}

int yoop_cancel_link(yoop_cancel_t* child, yoop_cancel_t* parent) {
    if (!child || !parent || child == parent) return -1;
    if (child->parent) return -1; // one parent per token

    yoop_mutex_lock(&parent->mu);
    int already = atomic_load_explicit(&parent->cancelled, memory_order_acquire);
    if (!already) {
        child->parent       = parent;
        child->sibling_prev = NULL;
        child->sibling_next = parent->child_head;
        if (parent->child_head) parent->child_head->sibling_prev = child;
        parent->child_head = child;
    }
    yoop_mutex_unlock(&parent->mu);

    if (already) {
        // Parent was cancelled before (or exactly as) we linked. Rather
        // than attach to something already fired, cancel the child
        // outright - the observable result is the same and the child
        // never enters the parent's list.
        yoop_cancel_request(child);
        return 0;
    }
    yoop_cancel_retain(parent);
    return 0;
}

// ---- waiter registration --------------------------------------------------

int yoop_cancel_add_waiter(yoop_cancel_t* t, yoop_cancel_waiter_t* w,
                           yoop_park_token_t* park) {
    if (!t) return 0; // no token: nothing to register, nothing to remove
    yoop_mutex_lock(&t->mu);
    if (atomic_load_explicit(&t->cancelled, memory_order_acquire)) {
        yoop_mutex_unlock(&t->mu);
        return 1;
    }
    w->token = park;
    w->prev  = NULL;
    w->next  = t->waiters;
    if (t->waiters) t->waiters->prev = w;
    t->waiters = w;
    yoop_mutex_unlock(&t->mu);
    return 0;
}

void yoop_cancel_remove_waiter(yoop_cancel_t* t, yoop_cancel_waiter_t* w) {
    if (!t) return;
    yoop_mutex_lock(&t->mu);
    if (w->prev) w->prev->next = w->next;
    else if (t->waiters == w) t->waiters = w->next;
    if (w->next) w->next->prev = w->prev;
    w->prev = NULL;
    w->next = NULL;
    yoop_mutex_unlock(&t->mu);
}

// ---- blocking helpers -----------------------------------------------------

int yoop_cancel_sleep_ns(yoop_cancel_t* t, uint64_t ns) {
    uint64_t sleep_deadline = yoop_now_ns() + ns;
    if (!t) {
        yoop_sleep_ns(ns);
        return YOOP_WAIT_READY;
    }

    yoop_mutex_lock(&t->mu);
    for (;;) {
        // An explicit cancel and an elapsed token deadline both end the
        // sleep, but they are reported differently - see the note on
        // yoop_cancel_flagged.
        if (yoop_cancel_flagged(t)) {
            yoop_mutex_unlock(&t->mu);
            return YOOP_WAIT_CANCELLED;
        }
        if (deadline_elapsed(t)) {
            yoop_mutex_unlock(&t->mu);
            return YOOP_WAIT_TIMEDOUT;
        }
        if (yoop_now_ns() >= sleep_deadline) {
            yoop_mutex_unlock(&t->mu);
            return YOOP_WAIT_READY;
        }
        uint64_t eff = min_deadline(sleep_deadline,
                                    atomic_load_explicit(&t->deadline_ns,
                                                         memory_order_acquire));
        yoop_cv_wait_until_locked(&t->cv, &t->mu, eff);
    }
}

int yoop_cancel_wait(yoop_cancel_t* t, uint64_t deadline_ns) {
    if (!t) {
        // Nothing can ever cancel: the caller's deadline is the only
        // possible outcome. No deadline means this would block forever,
        // which is caller error - report a timeout instead of hanging.
        if (deadline_ns == 0) return YOOP_WAIT_TIMEDOUT;
        uint64_t now = yoop_now_ns();
        if (now < deadline_ns) yoop_sleep_ns(deadline_ns - now);
        return YOOP_WAIT_TIMEDOUT;
    }

    yoop_mutex_lock(&t->mu);
    for (;;) {
        if (yoop_cancel_requested(t)) {
            yoop_mutex_unlock(&t->mu);
            return YOOP_WAIT_CANCELLED;
        }
        if (deadline_ns != 0 && yoop_now_ns() >= deadline_ns) {
            yoop_mutex_unlock(&t->mu);
            return YOOP_WAIT_TIMEDOUT;
        }
        uint64_t eff = min_deadline(deadline_ns,
                                    atomic_load_explicit(&t->deadline_ns,
                                                         memory_order_acquire));
        yoop_cv_wait_until_locked(&t->cv, &t->mu, eff);
    }
}
