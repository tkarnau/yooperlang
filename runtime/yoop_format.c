// yoop_format.c — runtime helper backing std/core/format.yoop.
//
// Float-to-string is the only formatter that bottoms out in C; the
// integer/bool versions are pure yoop. The returned buffer is malloc'd
// and leaked, matching the existing string-allocation convention in
// std/core/strings.yoop (heap strings have no kind / cleanup story
// yet).

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *yoop_float_to_string(double x) {
    char tmp[64];
    int n = snprintf(tmp, sizeof(tmp), "%g", x);
    if (n < 0) n = 0;
    if ((size_t)n >= sizeof(tmp)) n = (int)sizeof(tmp) - 1;
    char *out = (char *)malloc((size_t)n + 1);
    memcpy(out, tmp, (size_t)n);
    out[n] = '\0';
    return out;
}
