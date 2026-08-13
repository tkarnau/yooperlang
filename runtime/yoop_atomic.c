// yoop_atomic.c - the smallest set of atomic integer operations, backing
// std/core/atomic.yoop.
//
// WHY THIS EXISTS. Yoop already lets several tasks reach the same mutable
// storage: a module-level `let` is visible from every task, and an
// `unsafe_ptr<int32>` can be handed to one as a parameter. What it does not
// have is any way to make an update to that storage safe. `n = n + 1` from two
// workers is a load, an add, and a store, and two of those interleaved lose a
// count - which for a CONNECTION COUNTER means the number drifts up until the
// server refuses everything, or drifts down until the limit stops limiting.
//
// std/http's concurrent accept loop is the first caller: the loop increments,
// and every connection task decrements from whichever worker it finished on.
//
// DELIBERATELY TINY. This is not a concurrency toolkit - no compare-exchange,
// no fences, no atomic pointers, no memory-order parameter. Every operation
// here is sequentially consistent, which is the ordering that needs no
// argument about correctness and costs nothing that matters at the rate a
// server accepts connections. Widen it when something concrete needs more,
// not before.
//
// The `__atomic_*` builtins rather than C11 <stdatomic.h>: they take a PLAIN
// pointer, so the yoop side can pass an `unsafe_ptr<int32>` straight through
// with no cast into an `_Atomic` type it has no way to spell. clang provides
// them on every target this repo builds for, including the MSVC one.

#include <stdint.h>

// Add `delta` and return the NEW value, so a caller can use the result to
// decide (`if (add(p, 1) > limit)`) without a second racy read.
int32_t yoop_atomic_add_i32(int32_t* p, int32_t delta) {
    if (!p) return 0;
    return __atomic_add_fetch(p, delta, __ATOMIC_SEQ_CST);
}

int32_t yoop_atomic_load_i32(int32_t* p) {
    if (!p) return 0;
    return __atomic_load_n(p, __ATOMIC_SEQ_CST);
}

void yoop_atomic_store_i32(int32_t* p, int32_t v) {
    if (!p) return;
    __atomic_store_n(p, v, __ATOMIC_SEQ_CST);
}

// Raise `*p` to `v` if `v` is larger, and report what it ended up as. The
// read-modify-write is a CAS loop because a plain "load, compare, store" can
// lose a concurrent raise between the load and the store.
//
// This is what a high-water mark needs (`peak` connections seen), which is the
// one statistic that cannot be reconstructed after the fact from counters.
int32_t yoop_atomic_max_i32(int32_t* p, int32_t v) {
    if (!p) return 0;
    int32_t seen = __atomic_load_n(p, __ATOMIC_SEQ_CST);
    while (v > seen) {
        // On failure `seen` is updated with the current value, so the loop
        // re-tests against what is actually there.
        if (__atomic_compare_exchange_n(p, &seen, v, 0,
                                        __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
            return v;
        }
    }
    return seen;
}
