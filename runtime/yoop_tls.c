// yoop_tls.c - the OpenSSL shim backing std/tls.
//
// WHAT THIS IS AND IS NOT. Every byte of cryptography and every byte of
// protocol here belongs to OpenSSL. This file owns exactly two things:
//
//   1. A small, stable surface - about a dozen calls - so the yoop side never
//      sees an `SSL*`, an `SSL_CTX*`, a `BIO*`, or OpenSSL's per-thread error
//      queue. Same reason std/net reaches sockets through yoop_net.c rather
//      than libc: the shim presents one shape, and the platform (or the
//      backend) can change underneath it.
//   2. Moving ciphertext between OpenSSL and the caller, WITHOUT letting
//      OpenSSL touch the socket.
//
// THE MEMORY-BIO DESIGN, AND WHY IT IS FORCED. The obvious approach is
// SSL_set_fd and let OpenSSL do its own I/O. On a non-blocking socket that
// means reacting to SSL_ERROR_WANT_WRITE, which means "wait until the socket
// is writable" - and runtime/yoop_io_internal.h states that write-readiness
// CANNOT BE EXPRESSED on IOCP at all (a zero-byte WSASend completes whether or
// not there is room). Any design that puts "wait until writable" in the shared
// contract is unimplementable on Windows.
//
// So OpenSSL reads and writes two memory BIOs and never sees a file
// descriptor. The caller does all socket I/O through the runtime's portable
// OPERATION layer (recv/send begin+end), which already works on kqueue, epoll,
// and IOCP.
//
//     ssl  <-- rbio  <--  yoop_tls_push()   <-- ciphertext recv'd from socket
//     ssl  --> wbio  -->  yoop_tls_pull()   --> ciphertext to send to socket
//
// THE CALLER'S LOOP is the same for handshake, read, and write:
//
//     loop {
//         status = op()
//         drain: while (n = pull(buf)) send(buf, n)      // always, first
//         if status == OK            -> done
//         if status == WANT_READ     -> n = recv(buf); push(buf, n); continue
//         otherwise                  -> error
//     }
//
// Draining BEFORE reacting to WANT_READ matters: mid-handshake OpenSSL often
// owes the peer a flight AND wants a reply, and a loop that waits for the
// reply first deadlocks.
//
// See plans/tls.md for the full design discussion.

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509v3.h>

// Status codes shared with std/tls/ffi.yoop. Non-negative results from the
// data calls are byte counts, so every status is negative.
#define YOOP_TLS_OK          0
#define YOOP_TLS_WANT_READ  -1
#define YOOP_TLS_WANT_WRITE -2
#define YOOP_TLS_ERROR      -3
#define YOOP_TLS_CLOSED     -4

typedef struct {
    SSL* ssl;
    BIO* rbio;   // ciphertext IN  (we write, OpenSSL reads)
    BIO* wbio;   // ciphertext OUT (OpenSSL writes, we read)
} YoopTls;

// OpenSSL's error queue is per-thread, and so is this. A caller reads it
// immediately after a failing call, which is the only time it is meaningful.
static _Thread_local char yoop_tls_err[512];

static void tls_clear_error(void) {
    yoop_tls_err[0] = '\0';
}

// Snapshot the top of OpenSSL's error queue into the thread-local buffer, and
// DRAIN the rest. Leaving entries behind is a classic OpenSSL bug: the next
// unrelated call reports a stale failure that already happened.
static void tls_capture_error(const char* prefix) {
    unsigned long e = ERR_get_error();
    if (e == 0) {
        snprintf(yoop_tls_err, sizeof(yoop_tls_err), "%s", prefix);
    } else {
        char buf[256];
        ERR_error_string_n(e, buf, sizeof(buf));
        snprintf(yoop_tls_err, sizeof(yoop_tls_err), "%s: %s", prefix, buf);
    }
    while (ERR_get_error() != 0) { }
}

const char* yoop_tls_last_error(void) {
    return yoop_tls_err;
}

// ---- context --------------------------------------------------------------

// A client SSL_CTX with a TLS 1.2 floor.
//
// The floor is not configurable on purpose: everything below 1.2 is broken in
// ways that are not worth exposing a knob for, and a caller who genuinely
// needs to talk to such a peer has a bigger problem than this API.
void* yoop_tls_ctx_new_client(void) {
    tls_clear_error();
    const SSL_METHOD* method = TLS_client_method();
    SSL_CTX* ctx = SSL_CTX_new(method);
    if (!ctx) {
        tls_capture_error("SSL_CTX_new");
        return NULL;
    }
    if (SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION) != 1) {
        tls_capture_error("set_min_proto_version");
        SSL_CTX_free(ctx);
        return NULL;
    }
    // Verification is ON by default and the caller has to disable it
    // explicitly. A TLS client that connects anyway when verification fails is
    // worse than no TLS, because programs get written against a guarantee that
    // is not there.
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    return ctx;
}

void yoop_tls_ctx_free(void* ctx) {
    if (ctx) SSL_CTX_free((SSL_CTX*)ctx);
}

// Trust roots. A NULL/empty `ca_file` means "use OpenSSL's compiled-in default
// paths", which is right on Linux and right on macOS when OpenSSL was
// installed the normal way. It finds nothing on Windows - see plans/tls.md D5,
// where the system-store bridge is phase 3. Failing to find roots surfaces
// later as a verification failure, which is the correct direction to fail.
int32_t yoop_tls_ctx_load_verify(void* ctxv, const char* ca_file) {
    tls_clear_error();
    SSL_CTX* ctx = (SSL_CTX*)ctxv;
    if (!ctx) return -1;
    if (ca_file && ca_file[0] != '\0') {
        if (SSL_CTX_load_verify_locations(ctx, ca_file, NULL) != 1) {
            tls_capture_error("load_verify_locations");
            return -1;
        }
        return 0;
    }
    if (SSL_CTX_set_default_verify_paths(ctx) != 1) {
        tls_capture_error("set_default_verify_paths");
        return -1;
    }
    return 0;
}

// `verify` of 0 turns peer verification OFF for this context. The yoop side
// spells the knob `dangerouslyDisableVerification` so it cannot be typed by
// accident.
void yoop_tls_ctx_set_verify(void* ctxv, int32_t verify) {
    if (!ctxv) return;
    SSL_CTX_set_verify((SSL_CTX*)ctxv, verify ? SSL_VERIFY_PEER : SSL_VERIFY_NONE, NULL);
}

// ---- one connection -------------------------------------------------------

// `host` drives three separate things, and all three matter:
//   * SNI, so a shared host or CDN answers with the right certificate at all.
//   * The hostname CHECK. OpenSSL does NOT verify that the certificate matches
//     the host unless asked - chain verification alone is the classic hole,
//     because a valid certificate for another domain would sail through.
//   * ALPN advertises http/1.1, which some servers now require.
void* yoop_tls_new(void* ctxv, const char* host, int32_t check_hostname) {
    tls_clear_error();
    SSL_CTX* ctx = (SSL_CTX*)ctxv;
    if (!ctx) return NULL;

    YoopTls* c = (YoopTls*)calloc(1, sizeof(YoopTls));
    if (!c) { snprintf(yoop_tls_err, sizeof(yoop_tls_err), "out of memory"); return NULL; }

    c->ssl = SSL_new(ctx);
    if (!c->ssl) { tls_capture_error("SSL_new"); free(c); return NULL; }

    c->rbio = BIO_new(BIO_s_mem());
    c->wbio = BIO_new(BIO_s_mem());
    if (!c->rbio || !c->wbio) {
        tls_capture_error("BIO_new");
        if (c->rbio) BIO_free(c->rbio);
        if (c->wbio) BIO_free(c->wbio);
        SSL_free(c->ssl);
        free(c);
        return NULL;
    }
    // SSL_set_bio takes ownership of both BIOs; SSL_free releases them.
    SSL_set_bio(c->ssl, c->rbio, c->wbio);
    SSL_set_connect_state(c->ssl);

    if (host && host[0] != '\0') {
        // An IP literal and a DNS name are checked against DIFFERENT parts of
        // the certificate (iPAddress vs dNSName in the SAN), and using the
        // wrong one silently fails to match.
        //
        // Detection is side-effect free on purpose. Using
        // X509_VERIFY_PARAM_set1_ip_asc as the test is tempting - it succeeds
        // only for a textual IP - but then the constraint is already set, and
        // undoing it for the verification-off path means passing NULL, which
        // that function dereferences. a2i_IPADDRESS just parses.
        ASN1_OCTET_STRING* parsed_ip = a2i_IPADDRESS(host);
        int is_ip = (parsed_ip != NULL);
        if (parsed_ip) ASN1_OCTET_STRING_free(parsed_ip);

        if (!is_ip) {
            // SNI carries NAMES. RFC 6066 forbids sending an IP literal in
            // it, and a server that gets one may reject the handshake.
            SSL_set_tlsext_host_name(c->ssl, host);
        }

        // The constraint is only ever SET when it is going to be enforced, so
        // there is nothing to undo when verification is off.
        if (check_hostname) {
            SSL_set_hostflags(c->ssl, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
            int ok = is_ip
                ? X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(c->ssl), host)
                : SSL_set1_host(c->ssl, host);
            if (ok != 1) {
                tls_capture_error(is_ip ? "set1_ip_asc" : "SSL_set1_host");
                SSL_free(c->ssl);
                free(c);
                return NULL;
            }
        }
    }

    static const unsigned char alpn[] = { 8, 'h','t','t','p','/','1','.','1' };
    SSL_set_alpn_protos(c->ssl, alpn, sizeof(alpn));
    return c;
}

void yoop_tls_free(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (!c) return;
    if (c->ssl) SSL_free(c->ssl);   // frees rbio and wbio too
    free(c);
}

// Map an OpenSSL return into the status vocabulary above.
static int32_t tls_status(YoopTls* c, int rc, const char* what) {
    int err = SSL_get_error(c->ssl, rc);
    switch (err) {
        case SSL_ERROR_NONE:            return YOOP_TLS_OK;
        case SSL_ERROR_WANT_READ:       return YOOP_TLS_WANT_READ;
        case SSL_ERROR_WANT_WRITE:      return YOOP_TLS_WANT_WRITE;
        case SSL_ERROR_ZERO_RETURN:     return YOOP_TLS_CLOSED;
        case SSL_ERROR_SYSCALL:
            // With memory BIOs there is no syscall; this means the peer went
            // away mid-record. Report it as closed rather than as an error
            // with an empty queue, which reads as "unknown failure".
            if (ERR_peek_error() == 0) {
                snprintf(yoop_tls_err, sizeof(yoop_tls_err),
                         "%s: peer closed the connection unexpectedly", what);
                return YOOP_TLS_CLOSED;
            }
            tls_capture_error(what);
            return YOOP_TLS_ERROR;
        default:
            tls_capture_error(what);
            return YOOP_TLS_ERROR;
    }
}

int32_t yoop_tls_handshake(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (!c) return YOOP_TLS_ERROR;
    tls_clear_error();
    int rc = SSL_do_handshake(c->ssl);
    if (rc == 1) return YOOP_TLS_OK;
    return tls_status(c, rc, "handshake");
}

// Plaintext out of the session. Returns the byte count, or a negative status.
int64_t yoop_tls_read(void* cv, void* buf, size_t n) {
    YoopTls* c = (YoopTls*)cv;
    if (!c || !buf) return YOOP_TLS_ERROR;
    if (n == 0) return 0;
    tls_clear_error();
    int rc = SSL_read(c->ssl, buf, (int)(n > INT32_MAX ? INT32_MAX : n));
    if (rc > 0) return (int64_t)rc;
    return (int64_t)tls_status(c, rc, "read");
}

// Plaintext into the session. The ciphertext lands in wbio; the caller still
// has to pull it and put it on the socket.
int64_t yoop_tls_write(void* cv, const void* buf, size_t n) {
    YoopTls* c = (YoopTls*)cv;
    if (!c || !buf) return YOOP_TLS_ERROR;
    if (n == 0) return 0;
    tls_clear_error();
    int rc = SSL_write(c->ssl, buf, (int)(n > INT32_MAX ? INT32_MAX : n));
    if (rc > 0) return (int64_t)rc;
    return (int64_t)tls_status(c, rc, "write");
}

// ---- ciphertext movement --------------------------------------------------

// Take ciphertext OUT of wbio, for the caller to send. 0 means nothing
// pending, which is the normal case between records.
int64_t yoop_tls_pull(void* cv, void* buf, size_t n) {
    YoopTls* c = (YoopTls*)cv;
    if (!c || !buf || n == 0) return 0;
    int rc = BIO_read(c->wbio, buf, (int)(n > INT32_MAX ? INT32_MAX : n));
    if (rc <= 0) return 0;   // BIO_should_retry on an empty mem BIO: nothing pending
    return (int64_t)rc;
}

// Put ciphertext the caller recv'd INTO rbio.
int64_t yoop_tls_push(void* cv, const void* buf, size_t n) {
    YoopTls* c = (YoopTls*)cv;
    if (!c || !buf || n == 0) return 0;
    int rc = BIO_write(c->rbio, buf, (int)(n > INT32_MAX ? INT32_MAX : n));
    if (rc <= 0) {
        snprintf(yoop_tls_err, sizeof(yoop_tls_err), "push: memory BIO refused %zu bytes", n);
        return YOOP_TLS_ERROR;
    }
    return (int64_t)rc;
}

// Tell rbio the peer is gone, so SSL_read reports a clean end instead of
// waiting for a record that will never arrive.
void yoop_tls_push_eof(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (c) BIO_set_mem_eof_return(c->rbio, 0);
}

// Begin a close_notify. The caller pulls whatever this produced and sends it;
// waiting for the peer's reply is optional and this does not.
int32_t yoop_tls_shutdown(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (!c) return YOOP_TLS_ERROR;
    tls_clear_error();
    int rc = SSL_shutdown(c->ssl);
    if (rc >= 0) return YOOP_TLS_OK;
    return tls_status(c, rc, "shutdown");
}

// ---- introspection --------------------------------------------------------

// 0 when the certificate chain verified. Non-zero is an X509_V_ERR_* code, and
// the string form is what a user can act on.
int64_t yoop_tls_verify_result(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (!c) return -1;
    return (int64_t)SSL_get_verify_result(c->ssl);
}

const char* yoop_tls_verify_error_string(int64_t code) {
    return X509_verify_cert_error_string((long)code);
}

// The negotiated protocol version, e.g. "TLSv1.3". Useful in a log line and in
// a test that wants to prove a real handshake happened.
const char* yoop_tls_version(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (!c) return "";
    return SSL_get_version(c->ssl);
}

const char* yoop_tls_cipher(void* cv) {
    YoopTls* c = (YoopTls*)cv;
    if (!c) return "";
    const SSL_CIPHER* ch = SSL_get_current_cipher(c->ssl);
    return ch ? SSL_CIPHER_get_name(ch) : "";
}
