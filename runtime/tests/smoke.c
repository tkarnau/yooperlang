// init + shutdown round-trip with zero submitted work.
#include "../yoop_runtime.h"

int main(void) {
    yoop_runtime_init();
    yoop_runtime_shutdown();
    // Round-trip a second time to exercise idempotence + reinit.
    yoop_runtime_init();
    yoop_runtime_shutdown();
    return 0;
}
