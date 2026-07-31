// Cancellation tokens: flags, deadlines, linking, and the blocking
// helpers. See plans/cancellation-and-io-deadlines.md.

#include "../yoop_runtime.h"

#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define MS 1000000ULL

static void test_flag(void) {
    yoop_cancel_t* t = yoop_cancel_new();
    assert(t);
    assert(yoop_cancel_requested(t) == 0);
    yoop_cancel_request(t);
    assert(yoop_cancel_requested(t) == 1);
    // Idempotent.
    yoop_cancel_request(t);
    assert(yoop_cancel_requested(t) == 1);
    yoop_cancel_release(t);
    printf("  flag ok\n");
}

// A null token is "no token": never cancelled, no deadline. Every
// cancel-aware call takes NULL so call sites don't need to branch.
static void test_null_token(void) {
    assert(yoop_cancel_requested(NULL) == 0);
    assert(yoop_cancel_deadline_ns(NULL) == 0);
    assert(yoop_cancel_effective_deadline(NULL, 1234) == 1234);
    yoop_cancel_retain(NULL);
    yoop_cancel_release(NULL);
    yoop_cancel_request(NULL);
    printf("  null-token ok\n");
}

static void test_deadline(void) {
    uint64_t start = yoop_now_ns();
    yoop_cancel_t* t = yoop_cancel_new_deadline(start + 40 * MS);
    assert(yoop_cancel_requested(t) == 0);

    // A deadline fires without anyone waking anything: `requested`
    // consults the clock directly, which is why there is no timer
    // thread in the design.
    yoop_sleep_ms(60);
    assert(yoop_cancel_requested(t) == 1);
    yoop_cancel_release(t);

    // A deadline already in the past reads as requested immediately.
    yoop_cancel_t* past = yoop_cancel_new_deadline(1);
    assert(yoop_cancel_requested(past) == 1);
    yoop_cancel_release(past);
    printf("  deadline ok\n");
}

static void test_effective_deadline(void) {
    yoop_cancel_t* t = yoop_cancel_new_deadline(500);
    // 0 means "none" on either side; otherwise the earlier one wins.
    assert(yoop_cancel_effective_deadline(t, 0)    == 500);
    assert(yoop_cancel_effective_deadline(t, 900)  == 500);
    assert(yoop_cancel_effective_deadline(t, 100)  == 100);
    yoop_cancel_set_deadline_ns(t, 0);
    assert(yoop_cancel_effective_deadline(t, 900)  == 900);
    assert(yoop_cancel_effective_deadline(t, 0)    == 0);
    yoop_cancel_release(t);
    printf("  effective-deadline ok\n");
}

static void test_link(void) {
    yoop_cancel_t* parent = yoop_cancel_new();
    yoop_cancel_t* a = yoop_cancel_new();
    yoop_cancel_t* b = yoop_cancel_new();
    yoop_cancel_t* grandchild = yoop_cancel_new();

    assert(yoop_cancel_link(a, parent) == 0);
    assert(yoop_cancel_link(b, parent) == 0);
    assert(yoop_cancel_link(grandchild, a) == 0);

    // Self-link and null args are rejected.
    assert(yoop_cancel_link(a, a) == -1);
    assert(yoop_cancel_link(NULL, parent) == -1);
    assert(yoop_cancel_link(a, NULL) == -1);
    // One parent per token.
    assert(yoop_cancel_link(a, b) == -1);

    assert(yoop_cancel_requested(a) == 0);
    yoop_cancel_request(parent);
    assert(yoop_cancel_requested(a) == 1);
    assert(yoop_cancel_requested(b) == 1);
    assert(yoop_cancel_requested(grandchild) == 1);

    // Linking to an already-cancelled parent cancels immediately.
    yoop_cancel_t* late = yoop_cancel_new();
    assert(yoop_cancel_link(late, parent) == 0);
    assert(yoop_cancel_requested(late) == 1);

    yoop_cancel_release(late);
    yoop_cancel_release(grandchild);
    yoop_cancel_release(b);
    yoop_cancel_release(a);
    yoop_cancel_release(parent);
    printf("  link ok\n");
}

// Children must be safe to drop before the parent, and the parent safe
// to drop before the child - the child retains the parent, so the
// second order still frees exactly once.
static void test_link_release_orders(void) {
    yoop_cancel_t* p1 = yoop_cancel_new();
    yoop_cancel_t* c1 = yoop_cancel_new();
    yoop_cancel_link(c1, p1);
    yoop_cancel_release(c1);
    yoop_cancel_request(p1);   // must not touch the freed child
    yoop_cancel_release(p1);

    yoop_cancel_t* p2 = yoop_cancel_new();
    yoop_cancel_t* c2 = yoop_cancel_new();
    yoop_cancel_link(c2, p2);
    yoop_cancel_release(p2);   // child still holds a ref
    assert(yoop_cancel_requested(c2) == 0);
    yoop_cancel_release(c2);
    printf("  link-release-orders ok\n");
}

static void* canceller(void* p) {
    yoop_cancel_t* t = (yoop_cancel_t*)p;
    yoop_sleep_ms(30);
    yoop_cancel_request(t);
    return NULL;
}

static void test_sleep_interrupted(void) {
    yoop_cancel_t* t = yoop_cancel_new();
    pthread_t th;
    pthread_create(&th, NULL, canceller, t);

    uint64_t start = yoop_now_ns();
    int rc = yoop_cancel_sleep_ns(t, 2000 * MS);
    uint64_t elapsed = yoop_now_ns() - start;

    pthread_join(th, NULL);
    assert(rc == YOOP_WAIT_CANCELLED);
    // Woken by the cancel at ~30ms, nowhere near the 2s sleep.
    assert(elapsed < 1000 * MS);
    yoop_cancel_release(t);
    printf("  sleep-interrupted ok (%llums)\n",
           (unsigned long long)(elapsed / MS));
}

static void test_sleep_completes(void) {
    yoop_cancel_t* t = yoop_cancel_new();
    uint64_t start = yoop_now_ns();
    int rc = yoop_cancel_sleep_ns(t, 40 * MS);
    uint64_t elapsed = yoop_now_ns() - start;
    assert(rc == YOOP_WAIT_READY);
    assert(elapsed >= 35 * MS);
    yoop_cancel_release(t);
    printf("  sleep-completes ok\n");
}

// A token's own deadline ends a sleep early - but reports TIMEDOUT,
// not CANCELLED. Running out of time and being cancelled are different
// events and the caller usually handles them differently.
static void test_sleep_hits_token_deadline(void) {
    yoop_cancel_t* t = yoop_cancel_new_deadline(yoop_now_ns() + 30 * MS);
    uint64_t start = yoop_now_ns();
    int rc = yoop_cancel_sleep_ns(t, 2000 * MS);
    uint64_t elapsed = yoop_now_ns() - start;
    assert(rc == YOOP_WAIT_TIMEDOUT);
    assert(elapsed < 1000 * MS);
    yoop_cancel_release(t);
    printf("  sleep-token-deadline ok\n");
}

// yoop_cancel_flagged separates the two reasons a token is "requested".
static void test_flagged_vs_requested(void) {
    yoop_cancel_t* d = yoop_cancel_new_deadline(1); // already elapsed
    assert(yoop_cancel_requested(d) == 1);
    assert(yoop_cancel_flagged(d)   == 0);
    yoop_cancel_request(d);
    assert(yoop_cancel_flagged(d)   == 1);
    yoop_cancel_release(d);
    assert(yoop_cancel_flagged(NULL) == 0);
    printf("  flagged-vs-requested ok\n");
}

static void test_wait(void) {
    // Caller's deadline wins when nothing cancels.
    yoop_cancel_t* t = yoop_cancel_new();
    uint64_t start = yoop_now_ns();
    int rc = yoop_cancel_wait(t, yoop_now_ns() + 30 * MS);
    assert(rc == YOOP_WAIT_TIMEDOUT);
    assert(yoop_now_ns() - start >= 25 * MS);

    // Cancellation wins when it arrives first.
    pthread_t th;
    pthread_create(&th, NULL, canceller, t);
    rc = yoop_cancel_wait(t, yoop_now_ns() + 5000 * MS);
    pthread_join(th, NULL);
    assert(rc == YOOP_WAIT_CANCELLED);

    yoop_cancel_release(t);
    printf("  wait ok\n");
}

// Shortening a deadline after a thread has already parked must take
// effect - that is what the wake in set_deadline_ns is for.
static void* deadline_shortener(void* p) {
    yoop_cancel_t* t = (yoop_cancel_t*)p;
    yoop_sleep_ms(30);
    yoop_cancel_set_deadline_ns(t, yoop_now_ns() + 1);
    return NULL;
}

static void test_deadline_shortened_while_parked(void) {
    yoop_cancel_t* t = yoop_cancel_new();
    pthread_t th;
    pthread_create(&th, NULL, deadline_shortener, t);
    uint64_t start = yoop_now_ns();
    int rc = yoop_cancel_sleep_ns(t, 3000 * MS);
    uint64_t elapsed = yoop_now_ns() - start;
    pthread_join(th, NULL);
    // Shortening the deadline is a time budget change, so the sleep
    // ends as TIMEDOUT rather than CANCELLED.
    assert(rc == YOOP_WAIT_TIMEDOUT);
    assert(elapsed < 1500 * MS);
    yoop_cancel_release(t);
    printf("  deadline-shortened-while-parked ok\n");
}

int main(void) {
    yoop_runtime_init();
    printf("[cancel_token]\n");
    test_flag();
    test_null_token();
    test_deadline();
    test_effective_deadline();
    test_link();
    test_link_release_orders();
    test_sleep_completes();
    test_sleep_interrupted();
    test_sleep_hits_token_deadline();
    test_flagged_vs_requested();
    test_wait();
    test_deadline_shortened_while_parked();
    yoop_runtime_shutdown();
    printf("cancel_token: ok\n");
    return 0;
}
