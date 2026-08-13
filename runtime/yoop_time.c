// yoop_time.c - the calendar, backing std/time.yoop.
//
// The wall clock itself (yoop_wall_ns) lives in yoop_runtime.c next to the
// monotonic clock it must never be confused with. What is here is the part
// that needs libc's calendar: turning a Unix second into year/month/day, which
// means leap years, leap seconds' absence, and the local timezone database.
// None of that is worth reimplementing in yoop.
//
// Everything is passed out through int32 pointers rather than a struct, so
// there is no struct layout to agree on across the FFI boundary - the same
// shape yoop_io_stat_meta uses.
//
// `localtime` / `gmtime` return a pointer to a SHARED static buffer and are
// not thread-safe. The reentrant forms are used instead: localtime_r/gmtime_r
// on POSIX, localtime_s/gmtime_s on Windows (which take their arguments in
// the opposite order, hence the split).

#include <stdint.h>
#include <stddef.h>
#include <time.h>

// Break `epoch` (Unix seconds) into calendar fields. `utc` selects UTC over
// local time. Returns 1 on success, 0 when the conversion failed (an epoch
// outside what the platform's time_t can represent).
//
// Fields come out in the form a human writes them, not the form `struct tm`
// stores them: month is 1-12 rather than 0-11, and year is the full year
// rather than an offset from 1900. Converting here means every caller does not
// have to remember to.
//
// `utc_offset_minutes` is the offset of the returned time from UTC, which is
// what an ISO-8601 rendering needs for its suffix. Always 0 when `utc` is set.
int32_t yoop_time_parts(
    int64_t epoch,
    int32_t utc,
    int32_t* year,
    int32_t* month,
    int32_t* day,
    int32_t* hour,
    int32_t* minute,
    int32_t* second,
    int32_t* weekday,
    int32_t* yearday,
    int32_t* utc_offset_minutes
) {
    time_t t = (time_t)epoch;
    struct tm parts;

#ifdef _WIN32
    if (utc) {
        if (gmtime_s(&parts, &t) != 0) return 0;
    } else {
        if (localtime_s(&parts, &t) != 0) return 0;
    }
#else
    if (utc) {
        if (gmtime_r(&t, &parts) == NULL) return 0;
    } else {
        if (localtime_r(&t, &parts) == NULL) return 0;
    }
#endif

    if (year)    *year    = (int32_t)parts.tm_year + 1900;
    if (month)   *month   = (int32_t)parts.tm_mon + 1;
    if (day)     *day     = (int32_t)parts.tm_mday;
    if (hour)    *hour    = (int32_t)parts.tm_hour;
    if (minute)  *minute  = (int32_t)parts.tm_min;
    if (second)  *second  = (int32_t)parts.tm_sec;
    if (weekday) *weekday = (int32_t)parts.tm_wday;   // 0 = Sunday
    if (yearday) *yearday = (int32_t)parts.tm_yday;   // 0-based

    if (utc_offset_minutes) {
        if (utc) {
            *utc_offset_minutes = 0;
        } else {
#ifdef _WIN32
            // No tm_gmtoff in the MSVC CRT. Recover the offset by converting
            // the same instant both ways and differencing: _mkgmtime reads a
            // tm as UTC, mktime reads it as local, so the gap between them on
            // the same fields IS the offset. `tm_isdst = -1` lets mktime work
            // out whether daylight saving was in effect, which is the whole
            // reason this cannot be a fixed number per machine.
            struct tm local_copy = parts;
            local_copy.tm_isdst = -1;
            time_t as_local = mktime(&local_copy);
            struct tm utc_copy = parts;
            time_t as_utc = _mkgmtime(&utc_copy);
            if (as_local == (time_t)-1 || as_utc == (time_t)-1) {
                *utc_offset_minutes = 0;
            } else {
                *utc_offset_minutes = (int32_t)((int64_t)(as_utc - as_local) / 60);
            }
#else
            *utc_offset_minutes = (int32_t)(parts.tm_gmtoff / 60);
#endif
        }
    }
    return 1;
}
