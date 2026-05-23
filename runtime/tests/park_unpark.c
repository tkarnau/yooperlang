// Phase 8.F.1: exercise yoop_park_token_t round-trips.
//
// Three cases:
//   1. unpark-then-park (pending-wake path).
//   2. park-then-unpark across two threads.
//   3. burst: 200 park/unpark pairs from concurrent threads.

#include "../yoop_runtime.h"

#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

// Case 2 + 3 worker: sleep briefly, then unpark.
static void* unpark_after_delay(void* arg) {
    yoop_park_token_t* t = (yoop_park_token_t*)arg;
    usleep(2000); // 2ms
    yoop_unpark(t);
    return NULL;
}

int main(void) {
    yoop_runtime_init();

    // Case 1: pre-armed unpark.
    {
        yoop_park_token_t t;
        yoop_park_token_init(&t);
        yoop_unpark(&t);
        // Should return immediately.
        yoop_park(&t);
        yoop_park_token_destroy(&t);
    }

    // Case 2: another thread unparks us.
    {
        yoop_park_token_t t;
        yoop_park_token_init(&t);
        pthread_t th;
        pthread_create(&th, NULL, unpark_after_delay, &t);
        yoop_park(&t);
        pthread_join(th, NULL);
        yoop_park_token_destroy(&t);
    }

    // Case 3: 200 rounds; each iteration the worker unparks after a small
    // delay, main parks. Stresses the state-machine transitions.
    {
        for (int i = 0; i < 200; i++) {
            yoop_park_token_t t;
            yoop_park_token_init(&t);
            pthread_t th;
            pthread_create(&th, NULL, unpark_after_delay, &t);
            yoop_park(&t);
            pthread_join(th, NULL);
            yoop_park_token_destroy(&t);
        }
    }

    yoop_runtime_shutdown();
    printf("park_unpark: ok\n");
    return 0;
}
