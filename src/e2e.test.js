// End-to-end tests: compile a .yoop fixture all the way to a binary, run it,
// compare stdout/exit code. Each fixture has its own it() with the
// expectation written inline - no comment parsing, no sidecar files.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Every child this file starts goes through here: deadline on all of them,
// process-TREE kills so a compiler's clang or a driver's test binary cannot
// survive its parent, and a tracked set that an interrupted run takes down.
import { runProc, trackChild, stopChild } from "./testProc.js";

import { parse } from "./jsyooparser/parser.js";
import { typecheckSource, typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { compileSource, compileEntry } from "./jsyoopcodegen/codegen.js";
import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { runAttributePass } from "./jsyoopattributes/pass.js";
import { runComptimePass } from "./jsyoopinterp/comptimePass.js";
import {
  RUNTIME_C,
  RUNTIME_SOURCES,
  glueSourcesForLinkFlags,
  runtimeLinkFlags,
} from "./runtimeBuild.js";
import {
  EXE_SUFFIX,
  clangEnv,
  librarySearchArgs,
  lowerLinkFlag,
  prebuiltRuntimeObjects,
  resolveClang,
  windowsClangArgs,
} from "./toolchain.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

// How many e2e tests run at once.
//
// node:test runs test FILES in parallel but every test WITHIN a file
// sequentially, so this one file was serializing ~356 compile-and-run cycles
// while the other 25 files finished almost immediately. The helpers below are
// async precisely so this can overlap: a test waiting on clang yields to
// another instead of blocking the event loop.
//
// Safe because the tests share nothing - each mkdtemps its own build dir, and
// the two fixtures that LISTEN bind port 0 and read the kernel-assigned port
// back out of TcpListener.boundPort rather than agreeing on a fixed number.
//
// Measured, full suite, 24-core Windows box, interleaved to cancel drift:
//
//     concurrency 1  : 90s, 89s
//     concurrency 8  : 48s
//     concurrency 12 : 59s, 42s
//
// Worth recording HOW this number was arrived at, because a first attempt got
// it backwards. Before the debug-info change below, the same A/B showed no
// benefit at all (196-246s at every setting) and this defaulted to 1. That
// measurement was not wrong, it was measuring a different constraint: profiling
// showed 12 concurrent clang processes holding total CPU at 9% on a 24-core
// box, i.e. the suite was I/O-bound, and adding parallelism to a saturated
// disk does nothing. Once runFixtureEntry stopped writing 13.5MB of unread
// debug info per fixture, the workload became CPU-bound and the same knob
// started paying. If this ever looks useless again, profile before concluding
// it is - the answer may be that something else is saturating first.
const E2E_CONCURRENCY = Number(process.env.YOOP_E2E_CONCURRENCY)
  || Math.max(2, Math.min(12, Math.floor(os.cpus().length / 2)));

// Why the DWARF-via-lldb tests below cannot run here, or null if they can.
//
// Two separate reasons, and keeping them distinct matters because a skip that
// names the wrong cause is worse than no skip at all. On Windows the probe
// itself was broken (`which` is a POSIX command; the Windows equivalent is
// `where`), so those tests reported "lldb not on PATH" even with lldb.exe
// installed - masking the real reason, which is that clang drives the MSVC
// target with -gcodeview and therefore emits CodeView rather than DWARF.
// Getting a debugger working on Windows is deferred; see the porting notes.
// Memoized: this used to re-probe on every DWARF test, which is three `which`
// processes per run for an answer that cannot change mid-suite.
let dwarfSkipMemo;
function dwarfSkipReason() {
  if (dwarfSkipMemo !== undefined) return dwarfSkipMemo;
  if (process.platform === "win32") {
    dwarfSkipMemo = "debug info on the MSVC target is CodeView, not DWARF";
    return dwarfSkipMemo;
  }
  const probe = spawnSync("which", ["lldb"], {
    encoding: "utf8",
    timeout: 10000,
    killSignal: "SIGKILL",
  });
  dwarfSkipMemo = probe.status === 0 ? null : "lldb not on PATH";
  return dwarfSkipMemo;
}

// How long a compiled fixture gets to run before it is treated as hung. These
// programs print a few lines and exit; the ones that could genuinely wedge are
// the concurrency-runtime fixtures (task / wait_until / cancel) and the two
// that bind a socket, and for those a bounded kill is the difference between a
// named failure and a process still running an hour later.
const RUN_TIMEOUT_MS = Number(process.env.YOOP_E2E_RUN_TIMEOUT_MS) || 30000;

// clang gets its own, longer deadline: a cold link on a loaded machine is slow,
// but it is not five minutes slow, and clang had NO deadline at all before -
// one wedged link used to sit on a core until the machine was rebooted.
const CLANG_TIMEOUT_MS = Number(process.env.YOOP_E2E_CLANG_TIMEOUT_MS) || 180000;

// Compile a file with clang, asynchronously. Rejects with clang's stderr
// attached so a compile failure reads the way execFileSync's throw did.
async function runClangAsync(args) {
  const r = await runProc(resolveClang(), args, {
    env: clangEnv(),
    timeout: CLANG_TIMEOUT_MS,
  });
  if (r.code === 0) return;
  const how = r.timedOut ? `never finished (killed after ${CLANG_TIMEOUT_MS}ms)` : `exited ${r.code}`;
  const err = new Error(`clang ${how}\n${r.stderr}`);
  err.stderr = r.stderr;
  throw err;
}

async function runFixture(relPath, opts = {}) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  // Single-file fixtures that import from `std/` (e.g. for intrinsics)
  // need the module-graph resolver - fall back to compileEntry in that
  // case. Otherwise compileSource keeps the test path lean.
  const usesImport = /^\s*import(\s|\.)/m.test(src);
  let ir, extraLinkFlags = [];
  if (usesImport) {
    const result = compileEntry(path.join(repoRoot, relPath), { trackHeap: !!opts.trackHeap });
    ir = result.ir;
    extraLinkFlags = result.linkFlags ?? [];
  } else {
    ir = compileSource(src);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_e2e_"));
  const llPath = path.join(tmpDir, "out.ll");
  const binPath = path.join(tmpDir, "out" + EXE_SUFFIX);
  fs.writeFileSync(llPath, ir);
  const clangArgs = [
    llPath,
    ...prebuiltRuntimeObjects(RUNTIME_SOURCES),
    // Same two hooks the real driver applies to a program's own `extern "C"
    // from library` names, so a fixture that reaches for an external library
    // can never link here and fail under yoopiler (or the reverse).
    ...glueSourcesForLinkFlags(extraLinkFlags),
    "-o",
    binPath,
    ...librarySearchArgs(),
    ...runtimeLinkFlags().flatMap(lowerLinkFlag),
    ...extraLinkFlags.flatMap(lowerLinkFlag),
    ...windowsClangArgs(),
  ];
  await runClangAsync(clangArgs);
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const result = await runProc(binPath, [], { env, timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

// Variant of runFixture that stages an asset file alongside the binary and
// runs the binary with cwd set to that staging dir, so the yoop program can
// `fopen` the asset by relative path.
async function runFixtureWithAsset(yoopRelPath, assetRelPath, assetDestName) {
  const src = fs.readFileSync(path.join(repoRoot, yoopRelPath), "utf8");
  const ir = compileSource(src);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_e2e_"));
  const llPath = path.join(tmpDir, "out.ll");
  const binPath = path.join(tmpDir, "out" + EXE_SUFFIX);
  fs.writeFileSync(llPath, ir);
  fs.copyFileSync(
    path.join(repoRoot, assetRelPath),
    path.join(tmpDir, assetDestName),
  );
  const clangArgs = [
    llPath,
    ...prebuiltRuntimeObjects(RUNTIME_SOURCES),
    "-o",
    binPath,
    ...runtimeLinkFlags().flatMap(lowerLinkFlag),
    ...windowsClangArgs(),
  ];
  await runClangAsync(clangArgs);
  const result = await runProc(binPath, [], { cwd: tmpDir, timeout: RUN_TIMEOUT_MS });
  return { stdout: result.stdout, exitCode: result.status };
}

describe("e2e: pass fixtures compile, run, and produce expected output", { concurrency: E2E_CONCURRENCY }, () => {
  it("hello.yoop prints greeting + arithmetic + pow result", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/hello.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "Hello, World!\nx is 9\nsum: 10, doubled: 18\npow: 3 to the 5th is 243\n",
    );
  });

  it("type_alias.yoop: transparent `type X = Y` aliases resolve through to the underlying type", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/type_alias.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=7 b=7 first=7 len=3\nx=3 y=4 n=9\n");
  });

  it("type_inference.yoop: let/const bindings infer their type from the initializer", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/type_inference.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "str is world\ncount is 54, flag is 1\npoint is 3,4\n",
    );
  });

  it("printf_format.yoop: explicit %-directives in a format string are not doubled", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/printf_format.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "x=10\nx=10 y=20\nname=Tom x=10\ntemplate x is 10\nTom\n",
    );
  });

  it("char_literals.yoop: single-quoted chars pin like untyped ints and match in switch patterns", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/char_literals.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "slashes: 2\nnewline=10 cp=65\n1230\n");
  });

  it("parens_basic.yoop groups subexpressions and composes with postfix ops", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/parens_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=20\nb=20\nc=20\ne=99 f=200\n");
  });

  it("generic_call_struct_lit.yoop: struct literals get target type from generic arg position", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_call_struct_lit.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "v[0]=(1,2)\n" +
        "v[1]=(3,4)\n" +
        "v[2]=(5,6)\n",
    );
  });

  it("generic_quicksort.yoop: trait-bounded generic fn dispatches a generic trait method through a type param", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_quicksort.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "1 2 3 5 5 7 9 \n");
  });

  it("keyword_field_names.yoop: reserved keywords accepted in name-only positions", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/keyword_field_names.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "p.type=7 p.kind=3\n" +
        "t==Tag.kind\n" +
        "type variant, kind=42\n",
    );
  });

  it("enum_eq.yoop: `==` / `!=` on enums lower to tag comparison", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/enum_eq.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "Red==Red\n" +
        "Red!=Green\n" +
        "Circle(5)==Circle(99) (tag-only)\n" +
        "Circle!=Square\n",
    );
  });

  // The property that breaks SILENTLY: one `import` added to std/http and
  // suddenly every program that speaks HTTP needs OpenSSL installed to build.
  // Link flags are collected program-wide, which is why std/tls and std/https
  // are separate modules (plans/tls.md D4) - and why this is worth asserting
  // rather than trusting.
  //
  // Needs no clang: it inspects what the driver WOULD hand the linker.
  it("plain HTTP does not drag in OpenSSL; https:// does", () => {
    const plain = compileEntry(path.join(repoRoot, "examples/pass/hello_server/main.yoop"));
    assert.deepEqual(
      plain.linkFlags,
      [],
      "a plain HTTP program must not link OpenSSL",
    );
    assert.deepEqual(
      glueSourcesForLinkFlags(plain.linkFlags),
      [],
      "a plain HTTP program must not compile the TLS shim",
    );

    const secure = compileEntry(path.join(repoRoot, "examples/pass/https_client/main.yoop"));
    assert.ok(
      secure.linkFlags.includes("ssl"),
      `expected an https program to name ssl, got: ${secure.linkFlags.join(",")}`,
    );
    assert.ok(
      glueSourcesForLinkFlags(secure.linkFlags).some((p) => p.endsWith("yoop_tls.c")),
      "expected an https program to compile the TLS shim",
    );
  });

  it("https_client: a real TLS handshake, three refusals, and https:// through the client", async (t) => {
    // plans/tls.md phase 1. The peer is a NODE HTTPS server: a TLS client
    // tested only against itself proves almost nothing, and the value is
    // handshaking with an implementation that rejects us if we get it wrong.
    //
    // The three REFUSALS matter more than the connection. A handshake
    // succeeding says little; a client that cannot be made to refuse has no
    // security property at all - which is the same lesson the conferred-kind
    // gate taught (yooperdoom-takeaways 0.1).
    const skip = tlsSkipReason();
    if (skip) {
      t.skip(`TLS: ${skip}`);
      return;
    }
    const server = await startTlsServer();
    try {
      const ca = path.join(repoRoot, "examples/pass/https_client/testdata/ca.pem");
      const { stdout, exitCode } = await runFixtureEntry(
        "examples/pass/https_client/main.yoop",
        { args: [String(server.port), ca] },
      );
      assert.equal(exitCode, 0);
      assert.equal(
        stdout,
        // Trusting the right CA: connects AND round-trips a request, so the
        // data path is covered and not just the handshake.
        "verified   connected body=tls-hello:/hi\n" +
          // The throwaway CA is not in the system roots.
          "no CA      refused\n" +
          // Valid certificate, wrong host. Chain verification alone does NOT
          // close this - it needs the hostname/IP check.
          "wrong name refused\n" +
          // ...and the escape hatch is what opens the gate, nothing else.
          "verify off connected\n" +
          // The payoff: an `https://` URL through the ORDINARY client, with
          // no TLS at the call site. std/http takes Reader/Writer (phase 0)
          // and TlsStream implements Readable/Writable (phase 1), so
          // std/https is only where the two meet.
          "client     200 tls-hello:/hi\n" +
          "done\n",
      );
    } finally {
      server.stop();
    }
  });

  it("http_no_socket: a full HTTP exchange over in-memory Reader/Writer", async () => {
    // plans/tls.md phase 0. std/http used to name TcpStream in every
    // signature; it now takes the erased Reader/Writer vtables, so anything
    // implementing Readable/Writable can drive it - which is what will let a
    // TlsStream slot in with no other change.
    //
    // Useful on its own merits too: a server test with no port, no timing and
    // no cleanup, that can hand the server bytes no real client would send.
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_no_socket/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "get  served=1 bytes=110\n" +
        "get  status=HTTP/1.1 200 OK\n" +
        "get  body=path:/hello\n" +
        "post served=1 bytes=109\n" +
        "post status=HTTP/1.1 200 OK\n" +
        "post body=echo:hullo\n" +
        // The chunked decoder runs on the same path as the socket server,
        // with no socket to frame it: 3/abc + 2/de.
        "chunk served=1 bytes=109\n" +
        "chunk status=HTTP/1.1 200 OK\n" +
        "chunk body=echo:abcde\n" +
        // Malformed input answers 400 rather than falling over.
        "bad  served=1 bytes=148\n" +
        "bad  status=HTTP/1.1 400 Bad Request\n" +
        'bad  body=400 Bad Request: header line has no ":"\n' +
        "\n" +
        "done\n",
    );
  });

  it("http_concurrent: serveConcurrent overlaps connections, holds its cap, and 503s over it", async () => {
    // `peak=2` is the assertion that matters: two connections were being
    // handled at the same instant. Under `serve`, which awaits each
    // connection to completion before accepting the next, it is 1 by
    // construction no matter the timing.
    //
    // The refusals are made deterministic by the fixture (two holders take
    // both slots and sleep past the point where the late clients connect),
    // so `rejected=2` is not a timing coincidence.
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_concurrent/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "peak=2\n" +
        "withinCap=1\n" +
        "rejected=2\n" +
        // The clients and the server agree about how many were refused.
        "refusedSeen=1\n" +
        "accepted+rejected=4\n" +
        // Every connection task decremented its slot on the way out.
        "drained=1\n",
    );
  });

  it("http_proxy: a handler forwards through the HTTP client (async Handler.handle)", async () => {
    // The program that could not be written before. `Handler.handle` was
    // synchronous while `client.send` is async, so a handler could not call
    // the client - which rules out every sidecar, gateway, and load balancer,
    // since a proxy is a handler whose body is a client call.
    //
    // `via=origin` is the assertion that matters: that header was set by the
    // ORIGIN, and the client never connected to the origin.
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_proxy/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "get  200 origin-hello via=origin proxied=yes\n" +
        "post 200 origin-echo:payload via=origin proxied=yes\n" +
        "done\n",
    );
  });

  it("http_chunked: decodes chunked bodies in both directions, and rejects bad framing", async () => {
    // The peer here is a RAW socket writing canned bytes, because a real HTTP
    // server cannot produce the cases that matter - a bad hex size, a missing
    // CRLF after the data, both framings at once. The client and server halves
    // are the real std/http ones.
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_chunked/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      'simple  ok  "hello world"\n' +
        // Uppercase hex size, chunk extensions, and a trailer field.
        'extras  ok  "abcdefghijklmnopqrstuvwxyz"\n' +
        // 40 chunks of 4 bytes across many reads: the incremental path, where
        // the decoder resumes mid-body without re-walking or double-copying.
        "many    ok  len=160\n" +
        "badsize err 400 chunk size is not hexadecimal\n" +
        "nocrlf  err 400 chunk data is not followed by CRLF\n" +
        // RFC 9112: the request-smuggling ambiguity, rejected.
        "both    err 400 message has both Transfer-Encoding and Content-Length\n" +
        // The receiving direction: our server decoding a chunked request body
        // that arrived across two writes.
        'request ok  "got:chunked-body!"\n' +
        "done\n",
    );
  });

  it("time_calendar.yoop: wall clock + calendar, checked against fixed epochs", async () => {
    // Reproducible with `new Date(epoch * 1000).toISOString()`. Assertions are
    // UTC-only on purpose: local rendering depends on the machine's timezone.
    const { stdout, exitCode } = await runFixture("examples/pass/time_calendar.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "epoch  1970-01-01T00:00:00Z\n" +
        "before 1969-12-31T23:59:59Z\n" +
        "recent 2025-08-12T12:00:00Z\n" +
        "leapday 2024-02-29T00:00:00Z\n" +
        "nyeve   2024-12-31T23:59:59Z\n" +
        "nyday   2025-01-01T00:00:00Z\n" +
        "date  2025-08-12\n" +
        "time  12:00:00\n" +
        "stamp 20250812-120000\n" +
        "names Tue Aug\n" +
        "parts 2025 8 12 12 0 0\n" +
        "wday 2 yday 223 offset 0\n" +
        "display 2025-08-12T12:00:00Z\n" +
        "local ok=1\n" +
        "now ahead=1\n" +
        "ms consistent=1\n",
    );
  });

  it("sha256_hmac.yoop matches the FIPS 180-4 / RFC 4231 vectors", async () => {
    // Every expected value below is reproducible with one line of Node:
    //   crypto.createHash("sha256").update(x).digest("hex")
    //   crypto.createHmac("sha256", k).update(m).digest("hex")
    // A hash tested only against itself is not tested.
    const { stdout, exitCode } = await runFixture("examples/pass/sha256_hmac.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "empty  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
        "abc    ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n" +
        "len56  248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1\n" +
        "1000a  41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3\n" +
        // The streaming path, fed one byte at a time, must agree with the
        // one-shot above - that is what checks the partial-block bookkeeping.
        "stream 41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3\n" +
        "hmacfox f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8\n" +
        "rfc1    b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7\n" +
        "rfc2    5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843\n" +
        // 131-byte key: longer than the 64-byte BLOCK, so HMAC hashes it
        // first. Using the 32-byte digest size here instead is the classic
        // bug, and it produces a stable MAC that disagrees with everyone.
        "longkey 60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54\n" +
        "ct same=1\n" +
        "ct diff=0\n",
    );
  });

  it("base64_roundtrip.yoop: RFC 4648 vectors, both alphabets, binary round-trip", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/base64_roundtrip.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "enc  -> \n" +
        "enc f -> Zg==\n" +
        "enc fo -> Zm8=\n" +
        "enc foo -> Zm9v\n" +
        "enc foob -> Zm9vYg==\n" +
        "enc fooba -> Zm9vYmE=\n" +
        "enc foobar -> Zm9vYmFy\n" +
        "dec Zg== -> f (1)\n" +
        "dec Zm9vYmE= -> fooba (5)\n" +
        "dec Zm9vYmFy -> foobar (6)\n" +
        "dec Zm9vYmE -> fooba (5)\n" +
        "dec Zm9v\nYmFy -> foobar (6)\n" +
        "url ->>>??? -> Pj4-Pz8_\n" +
        "std ->>>??? -> Pj4+Pz8/\n" +
        "dec Pj4-Pz8_ -> >>>??? (6)\n" +
        "dec Pj4+Pz8/ -> >>>??? (6)\n" +
        "dec !!!! -> ERR base64: invalid character\n" +
        "dec Z -> ERR base64: truncated input\n" +
        "dec Zg==Zg== -> ERR base64: data after padding\n" +
        "binary encoded len=344 predicted=344\n" +
        "binary roundtrip 1 (256 bytes)\n",
    );
  });

  it("short_circuit.yoop: `&&` / `||` do not evaluate the right side needlessly", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/short_circuit.yoop");
    assert.equal(exitCode, 0);
    // The "ran N side(s)" lines are the assertion that matters. A bitwise
    // lowering produces the same VALUES and would pass a value-only test.
    assert.equal(
      stdout,
      "false && _ ran 1 side(s)\n" +
        "true || _ taken\n" +
        "true || _ ran 1 side(s)\n" +
        "true && true taken\n" +
        "true && _ ran 2 side(s)\n" +
        "null guard ok\n" +
        "bounds guard ok\n" +
        "underflow guard ok\n" +
        "or guard ok\n" +
        "nested=1\n" +
        "loop guard ok, steps=1\n",
    );
  });

  it("contextual_keywords.yoop: demoted keywords work as fields, params, and locals", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/contextual_keywords.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "fields: 1 2 3 4 5 6\n" +
        "more:   7 8 9 10 11 12\n" +
        "sum=78\n" +
        "locals: 42 43\n",
    );
  });

  it("disposable_rebind.yoop: `let disposable` rebinds, and nothing leaks doing it", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/disposable_rebind.yoop",
    );
    assert.equal(exitCode, 0);
    // The `live=0` lines are the assertion that matters: every value handed
    // over in the rebinding loop was disposed, not just the last one.
    assert.equal(
      stdout,
      "const form: id=1 live=1\n" +
        "after const scope: live=0\n" +
        "let form: id=99 live=1\n" +
        "after let scope: live=0\n",
    );
  });

  it("arena_exhausted.yoop: an exhausted allocator names itself instead of segfaulting", async () => {
    const { stdout, stderr, exitCode } = await runFixture(
      "examples/pass/arena_exhausted.yoop",
    );
    assert.equal(exitCode, 1);
    // The whole point: buffered stdout is flushed before the process dies, so
    // everything printed up to the failing allocation survives to locate it.
    // This used to come back as `output: [null, null, null]` with SIGSEGV.
    assert.equal(stdout, "this line must survive the abort\n");
    assert.match(stderr, /^yoop: allocation failed: wanted 4096 bytes \(align 8\)/);
    assert.match(stderr, /arena exhausted: capacity 1024, 0 used, 1024 free/);
  });

  it("untyped_literal_pinning.yoop: compound literal expressions never reach codegen unpinned", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/untyped_literal_pinning.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "int32 rhs\n" +
        "int32 lhs\n" +
        "uint8 ok\n" +
        "int64 ok\n" +
        "float32 ok\n" +
        "both untyped int\n" +
        "both untyped float\n" +
        "done\n",
    );
  });

  it("env_vars.yoop: get / has / getOr, and unset vs explicitly-empty", async () => {
    // YOOP_E2E_UNSET_VAR is deliberately absent: runFixture merges opts.env
    // over process.env, so a variable can be added but not removed here.
    const { stdout, exitCode } = await runFixture("examples/pass/env_vars.yoop", {
      env: { YOOP_E2E_SET: "hello", YOOP_E2E_EMPTY: "" },
    });
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "set=[hello] has=yes\n" +
        "empty=[] has=yes\n" +
        "missing=[] has=no len=0\n" +
        "orSet=[hello]\n" +
        "orEmpty=[]\n" +
        "orMissing=[fallback]\n",
    );
  });

  it("bool_eq.yoop: `==` / `!=` work on two bools", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/bool_eq.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "t!=f\n" +
        "t==t\n" +
        "f==f\n" +
        "t==true\n" +
        "!(t==f)\n" +
        "agree(f,f)\n" +
        "same=1 diff=0\n",
    );
  });

  it("operators_full.yoop covers bitwise + shift + ~ + compound-assign", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/operators_full.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "a=136 b=238 c=102 d=51\n" +
        "lo=1024 hi=16\n" +
        "p=14 q=20\n" +
        "mix=6\n" +
        "x=6\n" +
        "pt=(15,60)\n" +
        "xs=1,102,2,4\n",
    );
  });

  it("forin_basic.yoop walks arrays of every supported element type", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/forin_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "sum=100\n" +
        "trues=3\n" +
        "sumX=6 sumY=60\n" +
        "early=40\n" +
        "zero=0\n",
    );
  });

  it("forin_iterable.yoop walks a user-defined Iterable<T> via for-in", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/forin_iterable.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "n=0\nn=1\nn=2\nn=3\n" +
        "c.cur=0\n" +
        "sum=10\n" +
        "k=0\nk=1\nk=2\n",
    );
  });

  it("for_let_counter.yoop declares and scopes its own counter", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/for_let_counter.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "xs[0]=10\nxs[1]=20\nxs[2]=30\nxs[3]=40\n" +
        "j=0\nj=3\nj=6\nj=9\n" +
        "k=3\nk=2\nk=1\n" +
        "inner i=0\ninner i=1\n" +
        "outer i=99\n" +
        "nested a=10\nnested a=11\nnested a=10\nnested a=11\n" +
        "m=0\nm=2\n" +
        "n=0\nn=1\n" +
        "n after=2\n",
    );
  });

  it("range_basic.yoop walks `a..b` and treats a Range as a value", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/range_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "xs[0]=10\nxs[1]=20\nxs[2]=30\nxs[3]=40\n" +
        "mid 1\nmid 2\n" +
        "count=3\n" +
        "a0\na1\na2\n" +
        "b0\nb1\nb2\n" +
        "sum=3\n" +
        "e0\ne1\n" +
        "k0\nk1\n",
    );
  });

  it("vec_iter.yoop walks a Vec through vecIter without an index", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/vec_iter.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "x=10\nx=20\nx=30\n" +
        "sum=60\n" +
        "len=3 cap=4\n" +
        "pre=10\n" +
        "done\n",
    );
  });

  it("fn_ptr_field: generic KeyOps<K> with function-pointer fields + indirect call", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/fn_ptr_field.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "h=42 same=1 diff=0\n");
  });

  // Phase 10.E: cross-shape `?` propagation via `Into<T>`. IoError -> AppError
  // conversion fires on the failure branch; the `tag=7` proves the
  // user-written `into` method ran rather than a raw bit-copy of the
  // operand's Err payload.
  it("qmark_cross_shape_into: `?` calls Into.into to convert between Err payload types", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/qmark_cross_shape_into.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "happy sum=7\nsad err code=-7 tag=7\n");
  });

  // Phase 10.E.2: `expr? "context"` on `string` Err payloads. Both literal
  // forms (plain + interpolated template) prefix the propagated error, and
  // contexts stack as the error passes through each `?`. The interleaved
  // "(formatting context...)" line proves the context expression is emitted
  // inside the failure branch: it appears only for the sad call, and before
  // that call's own output line.
  it("qmark_context_string: `?` with a context string prefixes a string Err payload", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/qmark_context_string.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      'plain happy: ok 5\n' +
        'plain sad: err "reading count: negative input"\n' +
        'template happy: ok 5\n' +
        "  (formatting context for tag 9)\n" +
        'template sad: err "reading field 9: negative input"\n' +
        'nested sad: err "loading config: reading count: negative input"\n',
    );
  });

  // Phase 10.E.2: a structured Err payload routes the context through a
  // `WithContext<T>` impl. Same-shape (ParseError -> ParseError) preserves
  // the untouched `line` field, which a blind string concat could not do;
  // cross-shape (IoError -> AppError) shows one impl covering both the
  // conversion and the context, with no separate `Into<AppError>`.
  it("qmark_context_with_context: `?` context routes through WithContext.withContext", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/qmark_context_with_context.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "same ok 6\n" +
        'same err "field -1: not a number" line=12\n' +
        "cross ok 7\n" +
        'cross err "loading header (io 5)" code=5\n',
    );
  });

  // Phase 10.E.3: `expr? e { ... }` handles the failure at the `?` instead of
  // propagating it. `handled` returns a plain int32 - bare `?` is rejected in
  // a function with a non-fallible return type, so those two lines only exist
  // because the handler form drops that requirement. `summed=60` is the
  // even indices (0+20+40) with the odd ones skipped via `continue`, which
  // proves a non-return terminator satisfies the divergence rule.
  it("qmark_handler_block: `? e { ... }` handles the Err at the call site", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/qmark_handler_block.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "handled(2)=20\n" +
        "  handler saw: odd index\n" +
        "handled(3)=-1\n" +
        "  skipping 1 (odd index)\n" +
        "  skipping 3 (odd index)\n" +
        "summed=60\n" +
        "viaSwitch(1)=-2\n",
    );
  });

  // Phase 10.E.3: a non-void function that can fall off the end is now a
  // diagnostic. Before this it compiled and trapped at runtime (codegen
  // emits `unreachable`), so the failure arrived as a bare SIGTRAP with no
  // source location. All three shapes must be caught, not just the first.
  it("missing_return: a function that can fall off the end is rejected", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/missing_return.yoop");
    for (const fn of ["noElse", "oneArm", "loopOnly"]) {
      assert.ok(
        errors.some((e) =>
          new RegExp(`"${fn}".*not every path returns a value`).test(e.message),
        ),
        `expected a missing-return error for "${fn}", got: ${errors.map((e) => e.message).join(" | ")}`,
      );
    }
  });

  // Phase 10.F: `waitUntil(h, deadline_ns): WaitResult<T>` covers Done +
  // Timeout. The fast task completes well inside its 1s deadline; the slow
  // task sleeps 200ms past its 50ms deadline so Timeout fires deterministically.
  it("wait_until_smoke: waitUntil returns Done before the deadline and Timeout after it", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/wait_until_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fast done=49\nlazy timed out\n");
  });

  // Phase 10.F.2: external cancellation via `cancel(h)`. A second pooled
  // task fires the cancel mid-wait; the main thread's waitUntil (with a
  // 1s deadline that's not the path-of-success) observes WaitResult.Cancelled.
  it("cancel_smoke: cancel(h) makes waitUntil return WaitResult.Cancelled", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/cancel_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "cancelled as expected\n");
  });

  // Cancellation tokens: the explicit-value form. Covers the deadline
  // path (TimedOut, not Cancelled - the two reasons stay distinct), an
  // explicit cross-thread cancel waking a parked sleep, parent/child
  // cascade, a child with its own shorter budget, and the null `none()`
  // token being a working no-op.
  it("cancel_token_smoke: deadlines, explicit cancel, child tokens, and none()", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/cancel_token_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "deadline: timed out\ndeadline: expired\nmanual: cancelled\nmanual: flagged\n" +
        "child: cancelled with parent\nchild2: timed out\nparent2: still live\nnone: ready\n",
    );
  });

  // Bounded socket I/O. Every std/net call used to park on the
  // multiplexer with no way out; these give up on a deadline instead.
  // The accept-with-no-client and read-from-a-silent-peer cases are the
  // two shapes that used to wedge a thread permanently.
  it("io_timeout_smoke: accept and read give up on a deadline instead of parking forever", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/io_timeout_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "accept: timed out\naccept: connected\nread: timed out\n" +
        "write: sent 3\nclient read: 3\n",
    );
  });

  // Cancelling a thread parked INSIDE the multiplexer - the case the
  // runtime could not express at all before. The accept has no deadline,
  // so the cancellation is the only path out of the loop.
  //
  // The "ambient" line is the regression guard for the trait path: a
  // token attached to the STREAM (via tcpSetToken) has to reach a plain
  // `Readable.read`. A structural is-this-the-none-token check is what
  // makes that work - testing "has the token fired yet" instead makes a
  // live deadline-less token look absent, which silently routes back to
  // the uninterruptible ffiRecv and hangs this test forever.
  it("io_cancel_smoke: a cancel token unparks an accept blocked in the multiplexer", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/io_cancel_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "loop: shutdown requested\nloop: exited after 0 connections\n" +
        "post: still cancelled\nambient: cancelled\n",
    );
  });

  // async/await: `async` functions lower to LLVM switched-resume
  // coroutines, and a task body is implicitly async. Covers composition
  // (an async fn awaiting another), mixing async and ordinary calls in
  // one body, and a loop whose locals cross the await.
  it("async_await_smoke: async functions compose and are driven by the task scheduler", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/async_await_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "compute=15\nmixed=20\nlooping=20\n");
  });

  // The payoff: a suspended task releases its worker thread. Pinned to
  // ONE worker, so if suspension did not actually free the thread the
  // single worker would park inside the first read and this would hang
  // rather than fail. The suspend also happens two frames below the task
  // body, which is the propagation the coloring rules exist to make safe.
  //
  // The two "woke" lines race, so only their multiset is asserted.
  it("async_yield_smoke: two tasks park on I/O simultaneously with a single worker thread", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/async_yield_smoke.yoop", {
      env: { YOOP_NUM_WORKERS: "1" },
    });
    assert.equal(exitCode, 0);
    const lines = stdout.trim().split("\n");
    assert.equal(lines[0], "both parked");
    assert.deepEqual(
      lines.slice(1, 3).sort(),
      ["reader 1 woke", "reader 2 woke"],
    );
    assert.equal(lines[3], "total bytes=2");
  });

  // The ambient allocator belongs to the TASK, not to the worker thread that
  // happens to be running it. Run at two worker counts on purpose: the
  // "resumed" line catches a task resuming into another worker's allocator at
  // any count, while the "neighbor" line only exercises the leak-into-a-
  // neighbor path when a worker (rather than main's re-entrant `wait`
  // dispatch) picks the neighbor up. See plans/async-allocator-context.md.
  const asyncArenaExpected =
    "parked\nneighbor: arena used=0\nresumed: arena used=64\na=1 b=0\n";

  for (const workers of ["1", "4"]) {
    it(`async_arena_context: the allocator context follows a task across a suspend (${workers} worker(s))`, async () => {
      const { stdout, exitCode } = await runFixtureEntry(
        "examples/pass/async_arena_context.yoop",
        { env: { YOOP_NUM_WORKERS: workers } },
      );
      assert.equal(exitCode, 0);
      assert.equal(stdout, asyncArenaExpected);
    });
  }

  // The same context bug with no async code in user source: `wait` drains the
  // run queue on the CALLING thread, so a plain function holding an arena used
  // to run an unrelated task inside its own region. Pinned to one worker with
  // that worker parked in a blocking sleep, so main is guaranteed to be the
  // thread that dispatches the task.
  it("arena_sync_wait: a task dispatched re-entrantly by `wait` does not inherit the waiter's arena", async () => {
    const { stdout, exitCode } = await runFixtureEntry(
      "examples/pass/arena_sync_wait.yoop",
      { env: { YOOP_NUM_WORKERS: "1" } },
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "main: after own alloc used=128\ntask: arena used=128\n" +
        "main: after task used=128 rc=0\nhog rc=0\n",
    );
  });

  // Stage 4: temp storage rides the same per-task record. Same one-worker +
  // blocking-hog setup as arena_sync_wait, so main is guaranteed to dispatch
  // the task itself - held per-thread the task would see main's arena with 64
  // bytes already spent (576) and its resetTemp would leave main reading 0.
  it("task_temp_isolation: a task's temp arena is its own, and its resetTemp spares the caller's", async () => {
    const { stdout, exitCode } = await runFixtureEntry(
      "examples/pass/task_temp_isolation.yoop",
      { env: { YOOP_NUM_WORKERS: "1" } },
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "main: temp used=64\ntask: temp used=512\n" +
        "main: after task used=64 rc=0\nhog rc=0\n",
    );
  });

  // A task joining other tasks without holding a worker. Pinned to ONE
  // worker on purpose: `joiner` is itself a task waiting on two more, so a
  // blocking join would hold the single worker while the tasks it waits for
  // sit unstarted in the queue. That is a deadlock, so a regression here
  // shows up as a timeout rather than a wrong answer.
  it("task_await_join: awaitTask suspends the joiner instead of blocking its worker", async () => {
    const { stdout, exitCode } = await runFixtureEntry(
      "examples/pass/task_await_join.yoop",
      { env: { YOOP_NUM_WORKERS: "1" } },
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "joiner=42\nfanOut=6\nalreadyDone=100\n");
  });

  // The end of the async story: std/net and std/http are async top to
  // bottom, so an HTTP server plus three concurrent clients - four tasks
  // all doing socket I/O - multiplex onto ONE worker thread.
  //
  // Pinned to YOOP_NUM_WORKERS=1 on purpose. Under blocking I/O this
  // deadlocks rather than fails: the single worker parks inside the
  // server's accept() and no client ever gets a turn. So a regression
  // here shows up as a timeout, which is the signal we want.
  it("async_server_smoke: an HTTP server and 3 concurrent clients share a single worker", async () => {
    const { stdout, exitCode } = await runFixtureEntry(
      "examples/pass/async_server_smoke/main.yoop",
      { env: { YOOP_NUM_WORKERS: "1" }, timeoutMs: 30000 },
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "served=3 ok=3\n");
  });

  it("alloca_uniqueness: repeated payload-binding names and shadowing scope-restore", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/alloca_uniqueness.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "total=112 mode=19\n");
  });

  it("arena_context: malloc default + bump arena installed as the current allocator", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/arena_context.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "mallocOk=1 distinct=1 reused=1 used=128 afterReset=0\n");
  });

  it("arena_scope: disposable arenaScope installs+tears down a region; temp allocator resets", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/arena_scope.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "scopeUsed=128 tempReused=1\n");
  });

  it("arena_vec: a Vec created inside an arena scope draws its storage from the arena", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/arena_vec.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "sum=60 len=5\narenaGotData=1\n");
  });

  it("arena_request_loop: per-request arena reset keeps peak memory bounded across requests", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/arena_request_loop.yoop");
    assert.equal(exitCode, 0);
    // 5 requests summed (5*45=225); peak is ONE request's footprint, not 5x.
    assert.equal(stdout, "totalSum=225 peakUsed=96\n");
  });

  it("generic_trait_cross_module: an imported generic trait's method is callable via the qualified form", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/generic_trait_cross_module/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "unwrapped 7\n");
  });

  it("clearance_namespaced_sink: a laundered value flows into a sink called through its namespace", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/clearance_namespaced_sink/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "ran query\n");
  });

  it("map_smoke: Map<string, int32> via stringKeyOps covers insert/get/remove/grow", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/map_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "fresh: a=0 b=0 c=0 len=3\n" +
        "overwrite: ow=1 len=3\n" +
        "get: alpha=1 beta=22 zeta=-1\n" +
        "contains: alpha=1 zeta=0\n" +
        "remove: alpha=1 xeno=0 len=2\n" +
        "after-remove get alpha=-1\n" +
        "grown len=14 k05=50 k10=100\n",
    );
  });

  it("map_int32_keys: Map<int32, string> via int32KeyOps covers get/remove/contains", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/map_int32_keys.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "len=3\n" +
        "get 2 -> beta\n" +
        "get 99 -> <none>\n" +
        "removed 2 -> 1 len=2\n" +
        "contains 3 -> 1\n",
    );
  });

  it("set_smoke: Set<string> insert/contains/remove with dup detection", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/set_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "insert: a=0 b=0 a2=1 len=2\n" +
        "contains: alpha=1 zeta=0\n" +
        "remove: beta=1 zeta=0 len=1\n",
    );
  });

  it("deque_smoke: Deque<int32> push/pop both ends, growth, empty-pop returns None", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/deque_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "len=4 at0=1 at3=20\n" +
        "pop_front=1 pop_back=20 len=2\n" +
        "grown len=22 at0=5 at10=108\n" +
        "empty pop=-42\n",
    );
  });

  it("mapIter: for entry in mapIter(ref m) walks occupied slots via Iterable<MapEntry>", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/map_iter.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "keys_sum=10 vals_sum=1000\n");
  });

  it("display_templates: Display trait wires into template literal interpolations", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/display_templates.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "p=Point x=3\naddr=127.0.0.1 port=8080\ninferred=127.0.0.1\ndirect=127.0.0.1\n",
    );
  });

  it("debug_smoke: assert(true, ...) is a no-op; normal-path codegen unaffected", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/debug_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "assert ok\n");
  });

  it("log_smoke: std/log writes [info]/[warn]/[error] lines to stderr", async () => {
    const { stdout, stderr, exitCode } = await runFixtureEntry("examples/pass/log_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "done\n");
    assert.equal(
      stderr,
      "[info] booting\n[warn] config missing - using defaults\n[error] one item dropped\n",
    );
  });

  it("format_smoke: std/core/format renders ints, bools, and floats", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/format_smoke.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "0\n7\n12345\n-42\n0\n255\ntrue\nfalse\n1.5\n0\n",
    );
  });

  it("template_to_string: interpolated template literals work as plain strings", async () => {
    const { stdout, stderr, exitCode } = await runFixtureEntry(
      "examples/pass/template_to_string.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stderr,
      "[info] hello world\n[info] count=7 ratio=1.5 ok=true\n",
    );
    assert.equal(stdout, "count is 7\n");
  });

  it("panic_smoke: panic(msg) exits 1 after writing 'panic: ...' to stderr", async () => {
    const { stdout, stderr, exitCode } = await runFixtureEntry("examples/pass/panic_smoke.yoop");
    assert.equal(exitCode, 1);
    assert.equal(stdout, "before panic\n");
    assert.equal(stderr, "panic: intentional\n");
  });

  it("slice_basic.yoop slices arrays in all four forms and shares storage", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/slice_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "mid.len=3 mid[0]=20 mid[1]=30 mid[2]=40\n" +
        "tail.len=3 tail[0]=40 tail[2]=60\n" +
        "head.len=3 head[0]=10 head[2]=30\n" +
        "all.len=6\n" +
        "xs[1]=99\n",
    );
  });

  it("int_literal.yoop prints decoded hex/bin/dec/negative literals", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/int_literal.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=255 b=10 c=1000000 d=-7\n");
  });

  it("float_literal.yoop prints decimal/negative/scientific floats", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/float_literal.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "x=3.140000 y=-0.500000 z=100.000000\n");
  });

  it("range_check.yoop sums two int8 values that fit in range", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/range_check.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=100, b=27, c=127\n");
  });

  it("struct_basic.yoop creates a Point struct and prints the distance square", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/struct_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "distance_sq = 25\n");
  });

  it("struct_field_write.yoop mutates a struct field through a chain of assignments", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/struct_field_write.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "c.value = 20\n");
  });

  it("struct_return.yoop returns a struct from a function and reads its fields", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/struct_return.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=7 b=11\n");
  });

  it("struct_nested.yoop initializes nested struct literals and chains field access", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/struct_nested.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a.inner.v = 42\n");
  });

  it("refs_basic.yoop passes a ref param and writes through it", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/refs_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "x = 42\n");
  });

  it("refs_swap.yoop swaps two values through ref params", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/refs_swap.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "x=10 y=5\n");
  });

  it("arrays_basic.yoop creates an int32[] literal, reads len and elements, writes an element", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/arrays_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len=3 first=10 last=30\nxs[1]=99\n");
  });

  it("arrays_loop.yoop iterates an array with a for-loop and sums elements", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/arrays_loop.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "sum = 15\n");
  });

  it("heap_alloc_int.yoop allocates an int32[] on the heap, indexes it, frees it", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/heap_alloc_int.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "buf[0]=0 buf[2]=20 buf[4]=40 len=5\n");
  });

  it("heap_alloc_struct.yoop allocates a heap buffer of structs and round-trips fields", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/heap_alloc_struct.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "p[0]=(1, 2.500000) p[2]=(5, 6.500000)\n");
  });

  it("track_heap_basic.yoop: --track-heap counts alloc/free bytes and dumps net via atexit", async () => {
    const { stdout, stderr, exitCode } = await runFixture(
      "examples/pass/track_heap_basic.yoop",
      { trackHeap: true },
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "done\n");
    // 5 * 4 = 20 bytes int32[] (freed); 3 * 8 = 24 bytes Pair[] (leaked).
    // Pair is two int32s with no padding so sizeof = 8.
    assert.match(
      stderr,
      /\[yoop-diag\] heap: 44 bytes allocated in 2 calls; 20 bytes freed in 1 calls; net 24 bytes/,
    );
  });

  it("heap_alloc_int.yoop without --track-heap emits no diag line", async () => {
    const { stderr } = await runFixture("examples/pass/heap_alloc_int.yoop");
    assert.equal(stderr ?? "", "");
  });

  it("dynarray_push.yoop pushes through a grow boundary in user-defined DynArray<int32>", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/dynarray_push.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len=10 cap=16 sum=55\n");
  });

  it("generic_disposable_propagates.yoop: DynArray<T> implements Disposable with propagates auto-injects dispose", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_disposable_propagates.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len=3 arr[2]=30\ndisposing(3)\n");
  });

  it("propagates_manual_dispose.yoop: a plain `let` of a propagating type passes when the user discharges the obligation manually", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/propagates_manual_dispose.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "using(7)\ndisposed(7)\n");
  });

  it("propagates_dispose_both_branches.yoop: dispose in BOTH arms of an if/else satisfies a plain `let` binding", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/propagates_dispose_both_branches.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposed(7)\n");
  });

  // Ownership redesign (2026-06-17): kindCheck now walks SWITCH_STATEMENT, so a
  // `disposable`-keyword binding inside a `case` arm gets its auto-cleanup
  // injected at the arm-block end. dispose fires before "after", proving the
  // arm body's implicitCleanups were populated and emitted.
  it("disposable_in_switch_arm.yoop: a `disposable` binding inside a switch arm fires cleanup at arm end", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/disposable_in_switch_arm.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "using(1)\ndisposed(1)\nafter\n");
  });

  // Yoopstore-papercut #11: a returned struct/variant literal that moves a
  // propagating binding into a field transfers the obligation - dispose fires
  // exactly once, at the caller.
  it("propagates_return_struct_literal.yoop: returning a struct literal transfers the inner obligation", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/propagates_return_struct_literal.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "using(7)\ndisposed-inner(42)\n");
  });

  it("propagates_return_variant_literal.yoop: returning a variant constructor transfers the inner obligation", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/propagates_return_variant_literal.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "made-box\ndisposed-inner(99)\n");
  });

  it("for_break_continue.yoop: break exits loop early, continue skips even values", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/for_break_continue.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "sum = 10\nodd = 25\n");
  });

  it("casts.yoop: widening int cast, int-to-float, float-to-float casts", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/casts.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "b=100 d=100\nc=100.000000\ne=100.000000\n");
  });

  // ---- 7.1 generics ----

  it("generic_box.yoop: monomorphic Box<int32> field access", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_box.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "b=42\n");
  });

  it("generic_identity.yoop: generic function identity<T> inferred from arg", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_identity.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "m=100\n");
  });

  it("generics_overview.yoop exercises generic structs, fns, traits", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generics_overview.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "bi=42\nbf=3.500000\nid_i=100 id_f=3.500000\nu=42\np.first=10 p.second.value=20\ncell=99\n",
    );
  });

  // ---- 7.2 trait bounds ----

  it("generic_bound_basic.yoop: call trait method via bounded T", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_bound_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "v=42\n");
  });

  it("generic_bound_struct.yoop: bounded type param on a generic struct", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_bound_struct.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "tag\n");
  });

  it("generic_bounds_overview.yoop: full 7.2 showcase (incl. generic-calls-generic)", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/generic_bounds_overview.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "IntBox\nnamed\nIntBox\nIntBox\n");
  });

  // ---- 9.J trait extends + multi-bound type params ----

  it("trait_extends.yoop: a struct impl of a child trait covers parent methods", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/trait_extends.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "greet=5 shout=50 parent_greet=5\n");
  });

  it("trait_extends_generic_bound.yoop: child impl satisfies a parent bound on a generic fn", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/trait_extends_generic_bound.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "legs=4\n");
  });

  it("multiple_trait_bounds.yoop: <T implements (A, B)> dispatches both bounds inside the body", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/multiple_trait_bounds.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "summary=18\n");
  });

  // ---- 7.5 sum types, unions, switch / pattern matching ----

  it("switch_int.yoop: literal-only switch with multi-pattern arms + default", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/switch_int.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "classify(0)=0\nclassify(2)=1\nclassify(10)=10\nclassify(99)=-1\n",
    );
  });

  it("switch_bool.yoop: bool exhaustive switch (no default required)", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/switch_bool.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "label(true)=1\nlabel(false)=0\n");
  });

  it("enum_basic.yoop: payload + no-payload variants, switch destructuring", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/enum_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a is A\nb.x=42\n");
  });

  // Phase 13.A: a struct declared before a variant that mentions it back
  // through `Variant.Inner { kids: Struct[] }` used to capture the
  // empty-variants shell when the typechecker resolved its field types.
  // `sizeOfType(Struct)` then ran on the stale shell and undersized the
  // struct; `heapAlloc<Struct>(n)` allocated half the bytes LLVM expects
  // and writes corrupted the heap. The fix makes pass C mutate the shell
  // in place. Would fail to run cleanly under the old typechecker.
  it("variant_struct_forward_ref.yoop: struct captures variant shell before its variants populate", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/variant_struct_forward_ref.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "total=110 kids=5\n");
  });

  // Phase 13.B: variant decls accept `implements Trait propagates<K>` and
  // interleave method bodies with variant cases, exactly like struct
  // decls. Auto-cleanup at scope end dispatches through the variant's
  // own dispose; cleanup order is LIFO (Empty fires before Buffer).
  it("variant_implements_trait.yoop: variant implements Disposable + propagates<disposable> with auto-cleanup", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/variant_implements_trait.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "built filled\nbuilt empty\ndispose Empty\ndispose Buffer len=3\nafter outer scope\n",
    );
  });

  // Phase 12: value enums - the new `enum` keyword as a nominal primitive alias.
  it("value_enum_basic.yoop: int32-backed enum with switch + equality", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/value_enum_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "red\ngreen\nblue\neq works\nneq works\n");
  });

  it("value_enum_flags.yoop: bitwise operators on int-backed enum (SDL-style flags)", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/value_enum_flags.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "has sweet\nhas bitter\nmask matches sweet+sour combo\ncleared sweet bit\n",
    );
  });

  it("value_enum_explicit_int.yoop: enum<int64> with explicit + auto-incremented cases", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/value_enum_explicit_int.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "z=Zero\nbig > zero\nauto increments to 19\n");
  });

  it("value_enum_string.yoop: enum<string> with named string constants and equality", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/value_enum_string.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "asc\nnot desc\n");
  });

  it("value_enum_template.yoop: value enums interpolate as their underlying primitive", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/value_enum_template.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "level=warn color=2\nfirst=info count=1\n");
  });

  it("value_enum_to_string.yoop: value enum in a string-producing template literal", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/value_enum_to_string.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "level=error color=1\nRed Str Val: R\n");
  });

  it("enum_showcase.yoop: 4-variant enum, switch with payload destructuring + rename", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/enum_showcase.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "circle r=2\nrect 3x4\nsquare s=5\nempty\n");
  });

  // Phase 9.H: `?` propagates over enums with Ok/Err variants.
  it("fallible_enum_qmark.yoop: '?' on a Result-shaped enum propagates Err and unwraps Ok", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/fallible_enum_qmark.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "happy sum=7\nsad err=-7\n");
  });

  // Phase 10.A: generic enum Result<T, E> instantiates per (T, E) pair, and
  // the Phase 9.H structural `?` recognizer fires on the instantiated shape.
  it("generic_enum_result.yoop: Result<int32, int32> participates in switch + ? propagation", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_enum_result.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "happy sum=7\nsad err=-7\n");
  });

  // Phase 10.A: generic enum with a no-payload variant. Exercises the
  // FIELD_ACCESS → VARIANT_CONSTRUCTOR pinning path for `Maybe.None` in
  // return position.
  it("generic_enum_option_like.yoop: Maybe<T> with Some/None over int32", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/generic_enum_option_like.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "m1=Some(3)\nm2=None\n");
  });

  // Phase 9.G: heterogeneous handler list via vtable. Three different impl
  // types ({Const, AddOffset, Scale}) all answer the same Handler trait,
  // and a single fan_out function dispatches across the mixed array - the
  // canonical motivating case (would have needed monomorphized generics or
  // unsafe-pointer fields pre-9.G).
  it("vtable_handlers.yoop: heterogeneous handler list dispatches through a vtable", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/vtable_handlers.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "req=10 sum=145\nreq=7  sum=133\nscale-only=33\n");
  });

  // Phase 10.K: `VTableName.fromFn(f1, ...)` builds a vtable from named
  // functions (ctx-null + ctx-dropping shim), with no per-predicate struct.
  // Exercises a heterogeneous array mixing fromFn and from(ref struct) values
  // through one vtable type, plus a two-method vtable to pin slot ordering.
  it("vtable_fromfn.yoop: fromFn builds vtables from named functions", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/vtable_fromfn.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "matches=6\nseven-is-digit\nlo=20 hi=11\n");
  });

  // Phase 10.K: a function-pointer parameter is callable directly by name
  // (`pred(ch)`), and a bare top-level function name materializes as the
  // argument - the lightest higher-order form, no vtable/struct/ctx.
  it("fn_pointer_param.yoop: a function passed as an argument is called indirectly", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/fn_pointer_param.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "digits=3\nuppers=2\nagain=2\n");
  });

  // Phase 10.K: an array of function pointers - element type spelled with a
  // parenthesized function-value type `((p: T) => R)[]`. Names materialize
  // into the slots, the loop variable is called directly. No vtable/struct.
  it("fn_pointer_array.yoop: an array of function pointers scans via indirect calls", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/fn_pointer_array.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "aF3: ok end=3\na_3: ok end=3\n_a3: err leading underscore\naFxy: ok end=2\n");
  });

  // Phase 9.I: a nested-wait chain deeper than the worker count must complete.
  // Pre-9.I, YOOP_NUM_WORKERS=1 plus an inner `wait` deadlocked the lone
  // worker; the suspendable-wait path drains the queue on the calling thread
  // instead of pthread_cond_wait'ing.
  it("suspendable_wait.yoop: nested task waits complete under YOOP_NUM_WORKERS=1", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/suspendable_wait.yoop", {
      env: { YOOP_NUM_WORKERS: "1" },
      timeoutMs: 10000,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "chain=18\n");
  });

  it("union_rgba.yoop: untagged union, read via two field aliases, write through one updates the other", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/union_rgba.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "r=221 g=204 b=187 a=170\nafter-write b=187\n");
  });

  it("unsafe_ptr_basic.yoop: address-of, deref read/write, null compare", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/unsafe_ptr_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "v=42 x=99\nisnull=0 nb=1\n");
  });

  it("unsafe_ptr_arithmetic.yoop: malloc + GEP + bitcast + ptr<->int round-trip", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/unsafe_ptr_arithmetic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "diff=3\nsame=1\n");
  });

  // Yoopstore-papercut #3: bare `unsafe_ptr` (no `<T>`) is the opaque
  // C-pointer handle. fopen/fclose round-trip + implicit decay + cast.
  it("unsafe_ptr_opaque.yoop: bare unsafe_ptr round-trips through fopen/fclose and casts", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/unsafe_ptr_opaque.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "opened=0 nz=1 v=7\n");
  });

  // Both of these mirror POSIX's `struct timespec` and call clock_gettime,
  // neither of which exists on Windows: the MSVC CRT has no clock_gettime,
  // and `struct timespec` is not layout-compatible across the three targets
  // anyway (tv_nsec is a 4-byte long on Windows and an 8-byte long on
  // Linux/macOS), so one yoop struct cannot mirror it without conditional
  // compilation the language does not have.
  //
  // The compiler features they cover - `c_*` type aliases in an extern
  // signature and a C-ABI struct passed by pointer - are still exercised on
  // Windows through std/net, where SockAddrIn is a `layout { abi "C"; }`
  // struct handed to yoop_sock_bind/connect (see http_client_loopback).
  const posixLibc = process.platform === "win32";

  it("clock_gettime.yoop: C aliases in extern signature, struct ptr round-trip via libc", async (t) => {
    if (posixLibc) { t.skip("clock_gettime is POSIX-only"); return; }
    const { stdout, exitCode } = await runFixture("examples/pass/clock_gettime.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "plausible=1 nsec_ok=1\n");
  });

  it("clock_gettime_layout.yoop: layout { abi \"C\"; } on a C-mirroring struct compiles + runs", async (t) => {
    if (posixLibc) { t.skip("clock_gettime is POSIX-only"); return; }
    const { stdout, exitCode } = await runFixture("examples/pass/clock_gettime_layout.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "ok=1\n");
  });

  it("buffer_interop.yoop: xs.ptr + unsafe_ptr.toArray round-trip a malloc'd buffer through memcmp", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/buffer_interop.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "view.len=8 expect.len=8 matched=1\n");
  });

  it("errno_open.yoop: open of a nonexistent path returns -1, errno = ENOENT, message resolves", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/errno_open.yoop");
    assert.equal(exitCode, 0);
    assert.match(stdout, /fd=-1 saw_failure=1 code=2 saw_enoent=1 msg=No such file/);
  });

  it("module_counter.yoop: module-level let mutates across tick() calls; const reads as expected", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/module_counter.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "ticked: a=1 b=2 c=3 now=3\n");
  });

  it("module_level_mutable_array.yoop: a mutable module-level array literal is writable and unmerged; a module-level intrinsic initializer compiles", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/module_level_mutable_array.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "counters=0,10,20,30\nalsoZeros=0,0,0,0\nscratch=100,101,102,103\nfrozen=7,7\n",
    );
  });

  it("runtime_introspect.yoop: std/runtime pool sizing, atomic counters across threads, and process introspection", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/runtime_introspect.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "cpus>0: 1\nsetWorkerCount(2): 1 workers=2\ncounter=5000\n" +
        "afterSet+Sub=60\ncas first=1 second=0 observed=61\nrss>0: 1\nmonotonic: 1\n",
    );
  });

  it("ref_forwarding.yoop: a bare `ref T` binding passed to a `ref T` param forwards the pointer instead of derefing", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/ref_forwarding.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "direct=1 explicit=2 bare=3 field=4 viaTask=14\n");
  });

  it("concurrent_pipe.yoop: a task parks inside the multiplexer, wakes when bytes arrive, sleepMs delays the producer", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/concurrent_pipe.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "got=88\n");
  });

  it("language_showcase.yoop reads a file via libc and reports byte/line/word/most-common-letter counts", async () => {
    const { stdout, exitCode } = await runFixtureWithAsset(
      "examples/pass/language_showcase.yoop",
      "examples/pass/language_showcase.txt",
      "language_showcase.txt",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "bytes: 44\nlines: 2\nwords: 9\nmost common letter: 'o' (4 times)\n",
    );
  });

  // Clearance kinds (marker polarity + static two-bound check): a conferred
  // `cleared` capability earned via `launder`, and a restrictive `tainted`
  // hazard that must pass through a transition before reaching a plain slot.
  it("clearance_marker.yoop launders tainted bytes and feeds a cleared sink", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/clearance_marker.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a: safe\nb: safe\n");
  });

  // chat-agent-papercut #3: `contains` was a global keyword (kind-clause
  // word) blocking it as an ordinary function name. Now contextual.
  it("contains_as_function_name.yoop accepts `contains` as an ordinary fn name", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/contains_as_function_name.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "yes\n");
  });

});

// Multi-file fixture: compile entry path through full module graph pipeline.
async function runFixtureEntry(relPath, opts = {}) {
  const entryAbs = path.join(repoRoot, relPath);
  const { ir, linkFlags } = compileEntry(entryAbs, { trackHeap: !!opts.trackHeap });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_e2e_"));
  const llPath = path.join(tmpDir, "out.ll");
  const binPath = path.join(tmpDir, "out" + EXE_SUFFIX);
  fs.writeFileSync(llPath, ir);
  const allLinkFlags = [...linkFlags, ...runtimeLinkFlags()];
  // -g is OPT-IN (opts.debug), not the default, and that is a measured choice.
  //
  // It used to be unconditional, to "mirror the production yoopiler.js
  // invocation". But almost every test here asserts on the program's STDOUT,
  // which debug info cannot affect, and the tests that check DWARF *shape*
  // inspect the IR string - which codegen produces before clang ever runs. The
  // only tests that need a debug-info-bearing BINARY are the lldb ones, and
  // they ask for it explicitly.
  //
  // What it cost to carry it everywhere, measured on Windows: ~100ms of the
  // ~415ms link (25%), and 13.5MB written per fixture instead of 250KB - the
  // .pdb is 8MB and the incremental-link .ilk another 4.7MB. Across ~200
  // fixtures that is roughly 3.4GB of disk traffic per suite run. Profiling
  // showed this workload is I/O-bound, not CPU-bound (12 concurrent clangs
  // held total CPU at 9% on a 24-core box), so bytes written is the thing that
  // actually costs wall time here.
  //
  // -O0 stays unconditional: it keeps each statement's line info distinct and
  // matches what users get.
  const clangArgs = [
    llPath,
    ...prebuiltRuntimeObjects(RUNTIME_SOURCES),
    // The same two hooks runFixture and the real driver apply, so a fixture
    // that names an external library links here exactly as it would under
    // yoopiler. Missing them was invisible until a fixture actually named
    // one: std/tls asks for OpenSSL, and without these the link fails with
    // `library 'ssl' not found` even though the driver builds it fine.
    ...glueSourcesForLinkFlags(linkFlags ?? []),
    ...(opts.debug ? ["-g"] : []),
    "-O0",
    "-o",
    binPath,
    ...librarySearchArgs(),
    ...allLinkFlags.flatMap(lowerLinkFlag),
    ...windowsClangArgs(),
  ];
  await runClangAsync(clangArgs);
  // `env` mirrors runFixture's option - needed by fixtures that pin
  // YOOP_NUM_WORKERS to prove a scheduling property.
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  // `args` reaches the fixture through std/env's argAt. Used by fixtures that
  // have to be told something the test discovered at run time - a port a
  // helper server bound, a path to a generated file.
  const result = await runProc(binPath, opts.args ?? [], {
    env,
    timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    binPath,
  };
}

// Why the TLS tests cannot run here, or null if they can.
//
// std/tls links OpenSSL, which is a real external dependency rather than
// something the repo vendors. A contributor without it should get a skipped
// test naming the reason, not a wall of unresolved symbols - the same
// arrangement dwarfSkipReason makes for lldb.
let tlsSkipMemo;
function tlsSkipReason() {
  if (tlsSkipMemo !== undefined) return tlsSkipMemo;
  const probe = `#include <openssl/ssl.h>\nint main(void){ return TLS_client_method() ? 0 : 1; }\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_tlsprobe_"));
  const src = path.join(dir, "probe.c");
  fs.writeFileSync(src, probe);
  const out = path.join(dir, "probe" + EXE_SUFFIX);
  const res = spawnSync(
    resolveClang(),
    [src, "-o", out, ...librarySearchArgs(), ...lowerLinkFlag("ssl"), ...windowsClangArgs()],
    { encoding: "utf8", env: clangEnv(), timeout: CLANG_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  tlsSkipMemo = res.status === 0 ? null : "OpenSSL headers/libraries not found";
  return tlsSkipMemo;
}

// Start the throwaway Node HTTPS server and wait for it to report its port.
// Binds port 0 so this cannot collide with anything, which is what lets the
// e2e suite keep running tests concurrently.
// It is TRACKED (see src/testProc.js): this is the one child in the file that
// deliberately outlives the call that started it, so it is the one that most
// needs a run-interrupted-by-Ctrl-C to still take it down. Its stderr is
// drained too - a helper nobody reads from blocks on a full pipe.
function startTlsServer() {
  const script = path.join(repoRoot, "examples/pass/https_client/testdata/tls_server.mjs");
  const child = trackChild(process.execPath, [script]);
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      stopChild(child);
      reject(new Error("tls_server.mjs did not report a port in time"));
    }, 15000);
    child.stderr.on("data", () => {});
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/^PORT (\d+)/m);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), stop: () => stopChild(child) });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); stopChild(child); reject(e); });
    // The server exiting on its own is still a failure to report a port, and
    // without this the promise would sit unsettled until the suite gave up.
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      stopChild(child);
      reject(new Error(`tls_server.mjs exited (code ${code}, signal ${signal}) before reporting a port`));
    });
  });
}

// Typecheck a multi-file fixture (entry + imports) and return errors.
function typecheckFixtureEntry(relPath) {
  const entryAbs = path.join(repoRoot, relPath);
  const { modules } = loadModuleGraph(entryAbs);
  return typecheckProgram(modules);
}

function typecheckFixture(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  return typecheckSource(src);
}

// Phase 7.5: single-file fixture typechecked through the multi-module pipeline
// (which has the full pass A/B/C with enum / union / generics wired). The
// legacy `typecheckSource` only supports the structs+functions subset.
function typecheckFixtureProgram(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  const mod = { id: "fixture", ast: parse(src) };
  return typecheckProgram([mod]);
}

function parseFixture(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  return parse(src);
}

describe("e2e: multi-file pass fixtures compile and produce expected output", { concurrency: E2E_CONCURRENCY }, () => {
  it("imports_basic: named import + call", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/imports_basic/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "9 = 9\n");
  });

  it("imports_namespace: import * as + dotted call", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/imports_namespace/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "5 = 5\n");
  });

  // Regression: a Display-bound generic whose T is inferred from a struct
  // reached only through an imported instantiation (elem type of a Vec<T>
  // field). The captured elem type is a pass-A shell with empty
  // implementsTraits/methods; the call-site bound check and the registry
  // boundChecker must re-canonicalize it before checking.
  it("generic_bound_imported_shell: bound check canonicalizes imported struct shells", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/generic_bound_imported_shell/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "(1, 2)\n");
  });

  it("nested_generic_trailing_comma: `Vec<Map<K, V>>,` parses", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/nested_generic_trailing_comma.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "blocks=1 a=1\n");
  });

  // Regression: pass C used to REPLACE the enum/union table entry rather than
  // fill the pass-A shell in place. Files inside one module have no dependency
  // order, so the sibling that sorts first resolved both types while they were
  // still shells and kept holding them - the enum arrived with a null
  // `underlying` ("cannot switch over enum Color") and the union with empty
  // fields ("union Bits has no field asInt"). The fixture's filenames are load
  // bearing: aa_uses.yoop must sort before zz_decls.yoop.
  it("dir_module_shell_order: enum/union shells are filled in place, not replaced", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/dir_module_shell_order/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "green\nbits=42\n");
  });
});

// Phase 13.C: @derive(display) - pre-typecheck expansion generates the
// Display.toString method from a struct's field annotations. Fixtures run
// through runFixtureEntry (compileEntry): the expansion needs the driver's
// module graph with std/core/traits.yoop autoloaded.
describe("e2e: Phase 13.C @derive(display)", { concurrency: E2E_CONCURRENCY }, () => {
  it("derive_display_basic: derived toString via explicit printf format arg", async () => {
    // Also the regression test for the printf lowering fix: a template
    // literal VALUE arg after an explicit format literal fills the %s
    // instead of contributing a doubled directive.
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "p=Point { x: 3, y: 4 }\n");
  });

  it("derive_display_nested: derived structs recurse through Display dispatch", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_nested.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "Line { a: Point { x: 1, y: 2 }, b: Point { x: 3, y: 4 }, label: diag }\n",
    );
  });

  it("derive_display_array_vec: array + Vec loops, fn placeholder, empty variants", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_array_vec.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "Bag { xs: [1, 2, 3], v: [7, 8], m: [{ key: t, value: 9 }, { key: u, value: 10 }], cb: <fn> }\nBag { xs: [], v: [], m: [], cb: <fn> }\n",
    );
  });

  it("derive_display_mixed: hand-written Display field + pre-listed implements clause", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_mixed.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "Wrapper { inner: manual(9), tag: 5 } Listed { n: 6 }\n");
  });

  it("derive_display_empty: zero-field type prints Name { }", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_empty.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "Empty { }\n");
  });

  it("derive_display_cross_module: derived export interpolated from another module", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_cross_module/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "Pt { x: 10, y: 20 }\n");
  });

  it("derive_manual_to_string: deriving over a manual toString is an error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/derive_manual_to_string.yoop");
    assert.ok(
      errors.some((e) => /already defines "toString"/.test(e.message)),
      `expected the derive clash error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("derive_on_generic: generic type decls are rejected", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/derive_on_generic.yoop");
    assert.ok(
      errors.some((e) => /generic type "Pair" is not yet supported/.test(e.message)),
      `expected the generic derive error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("derive_on_alias: type aliases are rejected", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/derive_on_alias.yoop");
    assert.ok(
      errors.some((e) => /cannot apply to type alias "NodeId"/.test(e.message)),
      `expected the alias derive error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 13.D: variants derive too. The generated body is an arm-per-case
  // switch; per-case control comes from composition (a payload type declared
  // outside the variant with its own Display impl), not hand-written methods.
  it("derive_display_variant: arm-per-case switch, payload Display dispatch, collections, bound generic", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/derive_display_variant.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "Shape.Circle { c: <1,2>, r: 5 }\n" +
        "Shape.Named { label: hi }\n" +
        "Shape.Bytes { xs: [1, 2, 3] }\n" +
        "Shape.Many { v: [7, 8], tag: 9 }\n" +
        "Envelope { body: Shape.Dot, seq: 42 }\n",
    );
  });

  it("derive_variant_manual_to_string: deriving over a manual variant toString is an error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/derive_variant_manual_to_string.yoop");
    assert.ok(
      errors.some((e) => /variant "Shape" already defines "toString"/.test(e.message)),
      `expected the variant clash error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("derive_on_generic_variant: generic variants are rejected (needs registry method substitution)", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/derive_on_generic_variant.yoop");
    assert.ok(
      errors.some((e) => /generic variant "Maybe" is not yet supported/.test(e.message)),
      `expected the generic variant error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // The generated body is not user-written, so a non-printable field must
  // name the field and the fixes rather than complaining about a template
  // literal the user never typed. Covers the struct and variant paths - the
  // variant one resolves a pattern-bound local back to its field name.
  it("derive_nonprintable_field: diagnostic names the field, not the synthetic template", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/derive_nonprintable_field.yoop");
    const messages = errors.map((e) => e.message).join(" | ");
    assert.ok(
      errors.some((e) =>
        /@derive\(display\) on "Holder" cannot print field "p" of type struct Plain/.test(e.message),
      ),
      `expected the struct-field derive diagnostic, got: ${messages}`,
    );
    assert.ok(
      errors.some((e) =>
        /@derive\(display\) on "Boxed" cannot print field "p" of type struct Plain/.test(e.message),
      ),
      `expected the variant-payload derive diagnostic, got: ${messages}`,
    );
    assert.ok(
      !/template literal interpolation must be/.test(messages),
      `derived bodies must not surface the raw template wording: ${messages}`,
    );
  });

  it("derive parse-stage rejections: deferred names, unknown names, wrong target", () => {
    assert.throws(
      () => parse(`@derive(eq)\ntype P {\n  x: int32,\n}\n`),
      /@derive\(eq\) is not yet supported/,
    );
    assert.throws(
      () => parse(`@derive(banana)\ntype P {\n  x: int32,\n}\n`),
      /unknown derive "banana"/,
    );
    assert.throws(
      () => parse(`@derive(display)\nlet x: int32 = 1;\n`),
      /only applies to a struct 'type' or 'variant' declaration/,
    );
  });

  it("imports_renamed: import { x as y }", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/imports_renamed/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "16 = 16\n");
  });

  // Yoopstore-papercut #9: `import * as ns, { Type } from "..."` binds the
  // namespace and a named type from a two-axis module in one line.
  it("imports_combined: combined namespace + named import on one line", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/imports_combined/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "area=20\n");
  });

  it("imports_struct: exported struct + cross-module fallible flow", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/imports_struct/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len = 43\n");
  });

  it("module_state_cross: imported `let` is readable, `bump()` mutates it across calls", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/module_state_cross/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "step=5 a=5 b=10 snapshot=10\n");
  });

  it("extern_printf: explicit printf via extern block", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/extern_printf/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "hello\n");
  });

  it("extern_library: -lm link flag + cos(0) = 1", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/extern_library/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "cos(0) = 1.000000\n");
  });

  it("imports_diamond: diamond dep loads each module exactly once", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/imports_diamond/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=42 b=42\n");
  });

  // Phase 9.B: bool[] arrays
  it("bool_array: bool[] literal/index/heapAlloc/Vec paths all work", async () => {
    const { stdout, exitCode } = await runFixtureEntry(
      "examples/pass/bool_array.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "flags.len=4 flags[0]=1 flags[1]=0\n" +
        "flags[1]=1\n" +
        "zero is true\n" +
        "three is false\n" +
        "count=3\n" +
        "heap=1,0,1\n" +
        "vec=1,0,1 vlen=3\n",
    );
  });

  // Phase 9.C: std/ import root
  it("std_root_import: `std/...` paths resolve against the repo std/ dir", async () => {
    const { stdout, exitCode } = await runFixtureEntry(
      "examples/pass/std_root_import.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "total=60\n");
  });

  it("side_effect_import: side-effect-only import succeeds", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/side_effect_import/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "init loaded\n");
  });

  it("export_c: export \"C\" function emits unmangled symbol", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/export_c/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "add_one(5) = 6\n");
  });

  it("traits_disposable: impl of a Disposable trait with a dispose method", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_disposable/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=7\n");
  });

  it("traits_multi_impl: one type implementing two traits", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_multi_impl/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "closing fd=7\ndisposing fd=7\nrc=7 is_open=0\n");
  });

  it("traits_two_types_one_trait: two distinct types implementing the same trait", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_two_types_one_trait/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "file fd=1\nsocket sock=99\n");
  });

  it("traits_self_field: method body reads multiple fields and returns a value", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_self_field/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "encoded=304\n");
  });

  it("traits_self_call_other_method: method body invokes another method on the same type", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_self_call_other_method/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "closing fd=42\ndisposed via close (rc=42)\n");
  });

  it("traits_cross_module: trait declared in one module, implemented in another, called in main", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_cross_module/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=13\n");
  });

  it("traits_recursive_method: trait method calls itself recursively", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_recursive_method/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "n=3\nn=2\nn=1\n");
  });

  // Phase 7.4: cross-trait same-name impl - one method body, two emitted
  // LLVM symbols, each callable via its respective trait qualifier.
  it("traits_cross_trait_same_name: one impl satisfies two traits with the same method name", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_cross_trait_same_name/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "bot=7\nbot=7\n");
  });

  // Phase 7.4: trait method name == free function name now coexist cleanly.
  it("traits_method_name_collides_with_fn: free fn and trait method share a name", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_method_name_collides_with_fn/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "free flush 42\nflushing 3\n");
  });

  it("disposable_basic: two implicit-block bindings fire cleanup in LIFO order at function return", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_basic/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "working\ndisposing fd=2\ndisposing fd=1\n");
  });

  it("disposable_explicit_block: trailing-block binding fires cleanup at its `}`", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_explicit_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "inside block\ndisposing fd=7\nafter block\n");
  });

  it("disposable_return: cleanup fires on every explicit return path", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_return/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=9\ndisposing fd=9\nr1=1 r2=0\n");
  });

  it("disposable_qmark: cleanup fires before `?`-induced early return on the failure path", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_qmark/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=5\nok r1=5 err=''\ndisposing fd=5\nfail r2=0 err='boom'\n");
  });

  it("disposable_lifo_three: three implicit-block bindings dispose in reverse declaration order", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_lifo_three/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=3\ndisposing fd=2\ndisposing fd=1\n");
  });

  it("disposable_nested_block: implicit and explicit blocks interleave with correct LIFO scoping", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_nested_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "inside\ndisposing fd=3\ndisposing fd=2\noutside\ndisposing fd=1\n");
  });

  it("disposable_let_explicit: `let disposable` allows mutation and still fires cleanup", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_let_explicit/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=99\n");
  });

  it("disposable_multi_requires: kind with two requires resolves a mustCall method from one of them", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/disposable_multi_requires/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=11\n");
  });

  // region kinds (`appliesTo region`): anonymous block-owning bindings with no
  // visible name, plus type inference on a named block-owning binding.
  it("region_kind_block: anonymous explicit/implicit region blocks + inferred named binding fire cleanup correctly", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/region_kind_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      // explicit block: dispose at `}`
      "push 1\ninside\npop 1\nafter\n" +
        // implicit blocks: LIFO at scope end
        "push 1\npush 2\nbody\npop 2\npop 1\n" +
        // named binding, type inferred from the initializer
        "push 5\nuse 5\npop 5\n",
    );
  });

  // phase 6.2: scoped kind and escape analysis
  it("scoped_basic: scoped kind with mustNotEscape, kind-prefixed param, dispose fires at scope end", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/scoped_basic/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fd=1\ndisposing fd=1\n");
  });

  it("scoped_param_only: plain let binding may be passed ref to a scoped parameter", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/scoped_param_only/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fd=7\n");
  });

  it("scoped_lifo_with_disposable: scoped and disposable interleaved dispose in LIFO order", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/scoped_lifo_with_disposable/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=2\ndisposing fd=1\n");
  });

  it("scoped_field_access_ok: returning a primitive field of a scoped binding is not an escape", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/scoped_field_access_ok/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fd=9\ndisposing fd=9\n");
  });

  it("scoped_nested_block: trailing-block form of scoped kind fires dispose at inner block end", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/scoped_nested_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "inside\ndisposing fd=5\nafter\n");
  });

  it("kind_tracked_parse: mustNotShare acrossScopes parses and does not break mustCall pipeline", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/kind_tracked_parse/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "drop 1\n");
  });

  it("kind_forbids_parse: forbids io globalState parses and stores categories without enforcement", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/kind_forbids_parse/main.yoop");
    assert.equal(errors.length, 0, `expected no errors, got: ${errors.map((e) => e.message).join(" | ")}`);
  });

  // ---- 6.3-prelude: C runtime linked + init/shutdown injection ----

  it("runtime_linked: trivial program links the C runtime and exits cleanly via init/shutdown", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/runtime_linked/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "hello\n");
  });

  it("runtime_qmark_in_main: `?`-induced early return in main flows through yoop_runtime_shutdown", async () => {
    const { stdout } = await runFixtureEntry("examples/pass/runtime_qmark_in_main/main.yoop");
    // First call succeeds (`got 42`); second call fails and propagates via `?`
    // - the unreachable printf never fires. Shutdown is injected at every ret,
    // including the qmark-fail branch.
    assert.equal(stdout, "got 42\n");
  });

  it("runtime_disposable_in_main: dispose() fires before yoop_runtime_shutdown before ret", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/runtime_disposable_in_main/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "work\ndisposing 7\n");
  });

  it("runtime_linked: emitted IR contains the runtime declares + init/shutdown around main", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/runtime_linked/main.yoop"));
    assert.match(ir, /declare void @yoop_runtime_init\(\)/);
    assert.match(ir, /declare void @yoop_runtime_shutdown\(\)/);
    // init is the first instruction of main's entry block. The `define` line
    // may carry a `!dbg !N` (DWARF subprogram attachment).
    assert.match(ir, /define i32 @main\(\)(?: !dbg !\d+)?\s*\{\s*entry:\s*\n\s*call void @yoop_runtime_init\(\)/);
    // shutdown immediately before main's `ret`. Each instruction may carry
    // a trailing `, !dbg !N`.
    assert.match(ir, /call void @yoop_runtime_shutdown\(\)(?:, !dbg !\d+)?\s*\n\s*ret i32/);
  });

  it("runtime_disposable_in_main: emitted IR orders cleanup → shutdown → ret", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/runtime_disposable_in_main/main.yoop"));
    // dispose call, then shutdown, then ret - in that order, with no other
    // instructions between them.
    assert.match(
      ir,
      /call void @[^\s(]+__H__Disposable__dispose\(ptr %a\)(?:, !dbg !\d+)?\s*\n\s*call void @yoop_runtime_shutdown\(\)(?:, !dbg !\d+)?\s*\n\s*ret i32 0/,
    );
  });

  it("dwarf: emitted IR carries required DWARF metadata for lldb backtraces", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/runtime_linked/main.yoop"));
    // Required named metadata - without these clang silently strips DI.
    assert.match(ir, /!llvm\.dbg\.cu = !\{!\d+(?:, !\d+)*\}/);
    assert.match(ir, /!llvm\.module\.flags = !\{[^}]+\}/);
    assert.match(ir, /!\d+ = !\{i32 \d+, !"Dwarf Version", i32 \d+\}/);
    assert.match(ir, /!\d+ = !\{i32 \d+, !"Debug Info Version", i32 \d+\}/);
    // Per-module DIFile + DICompileUnit pointing at the .yoop entry file.
    assert.match(ir, /!DIFile\(filename: "main\.yoop", directory: "[^"]*runtime_linked"\)/);
    assert.match(ir, /distinct !DICompileUnit\(language: DW_LANG_C99[^)]*emissionKind: FullDebug\)/);
    // `main` has a DISubprogram and the define line is tagged with !dbg.
    assert.match(ir, /distinct !DISubprogram\(name: "main", linkageName: "main"/);
    assert.match(ir, /define i32 @main\(\) !dbg !\d+/);
    // At least one DILocation node was emitted for an instruction in main.
    assert.match(ir, /!\d+ = !DILocation\(line: \d+, column: \d+, scope: !\d+\)/);
  });

  // Requires `lldb` on PATH. On systems without it (or where DWARF was
  // stripped at link time), the assertions confirm that DI survived clang and
  // is consumable by an actual debugger - not just that the IR text looks
  // right. We use `image lookup` (no process attach) so this works in CI
  // without debugger-attach permissions.
  it("dwarf: lldb resolves main to its .yoop source file and line", async (t) => {
    const skip = dwarfSkipReason();
    if (skip) { t.skip(skip); return; }
    // lldb needs real debug info in the binary, so this one opts into -g.
    const { binPath } = await runFixtureEntry("examples/pass/runtime_linked/main.yoop", { debug: true });
    // Through runProc, not spawnSync: `--batch` runs the DEBUGGEE as a
    // grandchild, and only a tree kill can reach one of those if lldb wedges.
    // spawnSync could not have killed it, and had no deadline either.
    const out = await runProc(
      "lldb",
      ["-o", "image lookup -n main -v", "-o", "quit", "--batch", binPath],
      { timeout: RUN_TIMEOUT_MS },
    );
    const text = (out.stdout ?? "") + (out.stderr ?? "");
    assert.match(text, /main\.yoop/, `lldb output had no .yoop reference:\n${text}`);
    assert.match(text, /CompileUnit:.*main\.yoop/, `lldb did not surface a CompileUnit for main.yoop:\n${text}`);
    assert.match(text, /LineEntry:.*main\.yoop:\d+/, `lldb did not surface a LineEntry mapping main to a .yoop line:\n${text}`);
  });

  it("dwarf: locals of every aggregate shape get a typed llvm.dbg.declare", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/dwarf_locals/main.yoop"));
    // Struct: a DICompositeType with one DW_TAG_member per field.
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_structure_type, name: "Point", size: 64/);
    assert.match(ir, /!DIDerivedType\(tag: DW_TAG_member, name: "y",[^)]*offset: 32\)/);
    // string: typedef over char* so a debugger prints the text, not an address.
    assert.match(ir, /!DIDerivedType\(tag: DW_TAG_typedef, name: "string", baseType: !\d+\)/);
    assert.match(ir, /!DIBasicType\(name: "char", size: 8, encoding: DW_ATE_signed_char\)/);
    // Array: the `{ ptr, i64 }` fat pointer, with `data` typed as elem*.
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_structure_type, name: "int32\[\]", size: 128/);
    assert.match(ir, /!DIDerivedType\(tag: DW_TAG_member, name: "len",[^)]*offset: 64\)/);
    // Variant: tag described as an enumeration, payload as a union of cases.
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_enumeration_type, name: "Shape\.tag"/);
    assert.match(ir, /!DIEnumerator\(name: "Rect", value: 1\)/);
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_union_type, name: "Shape\.payload"/);
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_structure_type, name: "Shape\.Rect"/);
    // ref param: a pointer whose baseType is the pointee's composite type.
    assert.match(ir, /!DIDerivedType\(tag: DW_TAG_pointer_type, baseType: !\d+, size: 64\)/);
    // Every one of these locals gets a dbg.declare against its alloca slot.
    for (const name of ["pt", "who", "nums", "shape", "flag", "d", "p"]) {
      assert.match(
        ir,
        new RegExp(`!DILocalVariable\\(name: "${name}"`),
        `no DILocalVariable emitted for "${name}"`,
      );
    }
    // The subprogram carries a real signature (return + params), not `!{}`.
    assert.match(ir, /!DISubroutineType\(types: !\{!\d+, !\d+\}\)/);
  });

  // The IR assertions above prove the metadata is shaped right; this one
  // proves it survives clang and that a debugger can actually READ the values
  // (the whole point - previously `frame variable` showed nothing but prims).
  it("dwarf: lldb reads struct / string / array / variant locals by value", async (t) => {
    const skip = dwarfSkipReason();
    if (skip) { t.skip(skip); return; }
    // lldb needs real debug info in the binary, so this one opts into -g.
    const { binPath } = await runFixtureEntry("examples/pass/dwarf_locals/main.yoop", { debug: true });
    const out = await runProc(
      "lldb",
      [
        "-o", "breakpoint set --file main.yoop --line 38",
        "-o", "run",
        "-o", "frame variable",
        "-o", "p who.name",
        "-o", "p nums.data[2]",
        "-o", "p shape.payload.Rect.h",
        "-o", "quit",
        "--batch",
        binPath,
      ],
      { timeout: RUN_TIMEOUT_MS },
    );
    const text = (out.stdout ?? "") + (out.stderr ?? "");
    // Struct fields are walked, not shown as an opaque blob.
    assert.match(text, /\(Point\) pt = \{\s*\n\s*x = 3\s*\n\s*y = 4/, text);
    // `string` gets the C-string summary.
    assert.match(text, /\(string\).*"tom"/, text);
    // Arrays expose data + len, and the data pointer is element-typed.
    assert.match(text, /\(int32\[\]\) nums = \{[\s\S]*?len = 3/, text);
    assert.match(text, /\(int\) 30/, text);
    // Variant tag prints its case NAME, and the active payload is reachable.
    assert.match(text, /tag = Rect/, text);
    assert.match(text, /\(int\) 9/, text);
  });

  // Regression: llvm derives the DWARF `prologue_end` marker from the first
  // non-meta instruction carrying a !dbg. When the parameter stores carried
  // one, a function breakpoint (`b <name>`, what VS Code's function
  // breakpoints use) landed BEFORE the arguments reached their stack slots and
  // the variables pane showed garbage.
  it("dwarf: a function breakpoint stops after the parameter stores", async (t) => {
    const skip = dwarfSkipReason();
    if (skip) { t.skip(skip); return; }
    // lldb needs real debug info in the binary, so this one opts into -g.
    const { binPath } = await runFixtureEntry("examples/pass/dwarf_locals/main.yoop", { debug: true });
    const out = await runProc(
      "lldb",
      ["-o", "b manhattan", "-o", "run", "-o", "p *p", "-o", "quit", "--batch", binPath],
      { timeout: RUN_TIMEOUT_MS },
    );
    const text = (out.stdout ?? "") + (out.stderr ?? "");
    assert.match(text, /\(Point\) \{\s*\n\s*x = 3\s*\n\s*y = 4/, text);
  });

  // ---- 6.3 sugar: task / joined / pooled / wait ----

  it("task_three_forms: immediate, joined, pooled work end-to-end in the same main", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/task_three_forms/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=9\nd=16\nh=25\n");
  });

  // ---- 6.4 propagation: cross-module kind import + struct propagates ----

  it("propagates_full: end-to-end propagates<disposable> + propagates<Task> across modules", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/propagates_full/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "n=25\nclosed fd=7\n");
  });

  it("propagates_full: emitted IR shows propagated dispose + release at scope exit", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/propagates_full/main.yoop"));
    // Propagated release on `j.work` - GEP into Job then yoop_task_release.
    assert.match(ir, /call void @yoop_task_release\(/);
    // Pooled-to-pooled retain on h2 -> h3 transfer.
    assert.match(ir, /call void @yoop_task_retain\(/);
    // Propagated dispose call to the imported FileHandle's dispose method.
    assert.match(ir, /call void @[^\s(]+__FileHandle__Disposable__dispose\(/);
  });

  it("task_three_forms: emitted IR has thunk + submit + wait + release/free_sync_pair", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/task_three_forms/main.yoop"));
    // The per-task thunk is emitted.
    assert.match(ir, /define void @[^\s(]+__compute__thunk\(ptr %ts\)/);
    // The task struct is declared.
    assert.match(ir, /%Task_[^ ]+__compute = type/);
    // submit + wait + free_sync_pair appear for the immediate path.
    assert.match(ir, /call void @yoop_task_submit\(/);
    assert.match(ir, /call void @yoop_task_wait\(/);
    assert.match(ir, /call void @yoop_task_free_sync_pair\(/);
    // pooled path: alloc + release.
    assert.match(ir, /call ptr @yoop_task_alloc\(/);
    assert.match(ir, /call void @yoop_task_release\(/);
  });

  // ---- 6.5: layout / composition / parameterized kinds ----

  it("layout_compose: type-level aligned + composed scoped_alt fires dispose at scope exit", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/layout_compose/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "v.x=1.000000 h.x=5.000000\nbye vec4\n");
  });

  it("layout_compose: emitted IR has align 32 on both Vec4 allocas", () => {
    const { ir } = compileEntry(path.join(repoRoot, "examples/pass/layout_compose/main.yoop"));
    // Both `v` (type-level) and `h` (composed scoped_alt has no layout, so
    // alignment comes from the type's aligned(32) prefix) get align 32.
    const vMatches = ir.match(/%v = alloca[^\n]+align 32/g) ?? [];
    const hMatches = ir.match(/%h = alloca[^\n]+align 32/g) ?? [];
    assert.ok(vMatches.length >= 1, `expected %v alloca with align 32`);
    assert.ok(hMatches.length >= 1, `expected %h alloca with align 32`);
  });

  it("kind_compose_inline: inline `{ ... }` operand contributes mustNotEscape and triggers dispose at scope exit", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/kind_compose_inline/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "h.x=1.000000\nbye vec3\n");
  });

  // Phase 8.H: byte / string / Vec primitives and the parse_request_line
  // smoke test. Each fixture imports from std/core/* and exercises the new
  // intrinsics (arraySlice / stringAsBytes / stringFromBytesUnchecked)
  // through their pure-yoop wrappers.

  it("bytes_smoke: bytesEq + bytesIndexOf + bytesStartsWith + bytesSlice", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/bytes_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "eq(a,b)=1 eq(a,c)=0\nidx_l=2\nstarts=1\nsub.len=3 sub[0]=101 sub[1]=108 sub[2]=108\n",
    );
  });

  it("strings_smoke: stringEq + starts_with + index_of + slice + concat + concat_all + from_bytes round-trip", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/strings_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "eq_match=1 eq_diff=0\nstarts_with_Hello=1\nidx_of_World=7\nslice=World err=\ncat=foobar\nall=a-b-c\nfb=Hi err=\n",
    );
  });

  it("vec_smoke: Vec<int32> push/get/set/clear with disposable auto-cleanup", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/vec_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "len=4 cap=4\nv[2]=30\nv[0]=99\nafter_clear len=0 cap=4\n",
    );
  });

  // Yoopstore-papercut #4: bulk Vec fill (vecFromArray + vecExtendFrom).
  it("vecExtendFrom: vecFromArray copies and vecExtendFrom grows once", async () => {
    const { stdout, stderr, exitCode } = await runFixture("examples/pass/vec_extend_from.yoop", { trackHeap: true });
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "from_array len=3 cap=3 sum=60\nextend len=5 cap=5 last=50\nempty len=3 cap=3 first=10\n",
    );
    assert.match(stderr, /net 0 bytes/);
  });

  // Yoopstore-papercut #5: owned Bytes buffer with copy / seal constructors.
  // trackHeap asserts the from_vec seal doesn't double-free or leak the
  // transferred buffer.
  it("bytes_owned: bytesFromArray + bytesFromVec seal + transfer-up dispose", async () => {
    const { stdout, stderr, exitCode } = await runFixture("examples/pass/bytes_owned.yoop", { trackHeap: true });
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "from_array len=3 [9 8 7]\nfrom_vec len=3 [1 2 3]\n",
    );
    assert.match(stderr, /net 0 bytes/);
  });

  // std/core/text.yoop: the owned growable string. Three things a bare
  // `string` cannot do - own its storage, grow, and be indexed by codepoint.
  // trackHeap is the point of the fixture as much as stdout is: every Text
  // here is reclaimed by the injected `disposable` cleanup, where a raw
  // string built by stringConcat is both leaked AND invisible to the
  // counter (it mallocs directly rather than through ctxAlloc).
  it("text_basics: Text builds, grows, borrows, and walks codepoints", async () => {
    const { stdout, stderr, exitCode } = await runFixture("examples/pass/text_basics.yoop", { trackHeap: true });
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "build [hello, world] len=12\n" +
        "grow len=1000 viewLen=1000\n" +
        "utf8 bytes=10 chars=4\n" +
        "chars 65 233 8364 128512\n" +
        "charAt1=233 offsetOfChar3=6\n" +
        "replaceChar bytes=8 chars=4\n" +
        "subChars bytes=5 chars=2\n" +
        "subBytes rejected\n" +
        "query 1 1 1 1 4\n" +
        "replaceAll [a==b==c==d]\n" +
        "upper [MIXED CASE]\n" +
        "trim [padded]\n" +
        "join [one, two, three]\n" +
        "padStart [0007]\n" +
        "reuse [reused] len=6\n" +
        "display [reused]\n" +
        "parseInt -1234\n" +
        "parseInt rejected\n",
    );
    assert.match(stderr, /net 0 bytes/);
  });

  // `Text` is container-owned like `Vec`: it captures the allocator current
  // at construction and frees back into it. A Text built inside an arena
  // scope therefore comes OUT of the arena and needs no per-value dispose,
  // which is the shape a per-request reset depends on.
  it("text_arena: a Text built in an arena scope draws from the arena", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/text_arena.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "before 0\n[arena-backed text, grown past its initial capacity]\nafter nonzero\n",
    );
  });

  // Yoopstore-papercut #2 follow-ups: std/fs exists() / fileSize() via a
  // stat runtime helper, plus real errno reasons in failure messages.
  it("fs_metadata: exists/fileSize report state and errno surfaces the real reason", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/fs_metadata.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout.split("\n")[0], "before=0 after=1 size=5 missing=-1 werr.len=0");
    assert.match(stdout, /delete_missing="std\/fs: remove\(.*\) failed: No such file or directory"/);
  });

  // Regression: a non-void function ending in an exhaustive variant switch
  // whose arms all return must not emit an unterminated switch_end block.
  it("switch_exhaustive_diverge: all-returning exhaustive switch tail terminates cleanly", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/switch_exhaustive_diverge.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "r=1 g=2 b=3\nred=red blue=other\n");
  });

  it("parse_request_line: pure-yoop HTTP/1.1 request-line parser using only std/core/bytes + std/core/strings", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/parse_request_line/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "method=GET path=/path version=HTTP/1.1 err=\nbad.err=parse_request_line: missing CR\n",
    );
  });

  // Library Phase A: foundational traits exported from std/core/traits.yoop.
  it("traits_readable_writable: in-memory MemBuffer implements (Readable, Writable) - round-trips bytes", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/traits_readable_writable/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "wrote=2 read=2 bytes=72,73\n");
  });

  // HTTP/1.1 request-head parser: request line, header block, target split
  // into path + query, and the malformed-request rejections. No sockets;
  // pure parse over a literal buffer.
  it("http_parse_smoke: parseRequestHead extracts the head and rejects bad ones", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_parse_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "method=GET path=/hello version=HTTP/1.1 cl=0 host=localhost\n" +
      "query name=yoop\n" +
      "bad-method : 501 unsupported method \"BREW\"\n" +
      "bad-version: 505 unsupported HTTP version \"HTTP/9.9\"\n" +
      "bad-length : 400 Content-Length is not a number\n" +
      // A chunked head parses now; the framing is the read loop's job, and
      // examples/pass/http_chunked covers the decoding itself.
      "chunked    : accepted chunked=1\n" +
      // Both framings at once is the request-smuggling shape, still refused.
      "both-framings: 400 message has both Transfer-Encoding and Content-Length\n" +
      "encoded-sep: 400 decoding request path \"/a%2Fb\": encoded path separator is not allowed\n",
    );
  });

  // The hello-world HTTP server compiles end-to-end. Running it binds to
  // localhost:18080 (out of scope for the test harness), so this verifies
  // the build.
  it("hello_server: builds end-to-end (server requires manual curl test)", () => {
    const { ir, linkFlags } = compileEntry(
      path.join(repoRoot, "examples/pass/hello_server/main.yoop"),
    );
    // The serve loop takes the erased Dispatcher, so there is exactly one
    // copy of it and the handler is reached through the vtable.
    assert.match(ir, /%vtable\..*__Dispatcher = type/);
    // serveConnection is async now, so it has the coroutine ABI: returns
    // `ptr` (the handle), takes a trailing result slot, and carries
    // presplitcoroutine. That is what lets a connection suspend on a
    // read and hand its worker thread back.
    //
    // The prefix is `http_` rather than `server_`: std/http is a DIRECTORY
    // MODULE, so all seven of its source files mangle against one module id
    // derived from the directory. Same for the router assertions below.
    assert.match(ir, /define ptr @http_.*__serveConnection\(.*ptr %__ret\) presplitcoroutine/);
    // The handler is ASYNC too now, and this assertion is the inverse of what
    // it used to be. Async used to stop at the I/O boundary deliberately, to
    // bound how far the colour spread - but `client.send` is async, so a
    // synchronous handler could not call the HTTP client, which made a PROXY
    // unwritable. See examples/pass/http_proxy.
    //
    // A handler that does no I/O (this one) pays one frame allocation and
    // never suspends: an async function with no await runs straight through
    // on its first step.
    const handlerDefine = ir
      .split("\n")
      .find((l) => l.startsWith("define") && l.includes("__HelloHandler__Handler__handle("));
    assert.ok(handlerDefine, "handler define not found");
    assert.ok(
      handlerDefine.includes("presplitcoroutine"),
      `handler should carry the coroutine ABI, got: ${handlerDefine}`,
    );
    // The TCP layer reaches the multiplexer through the async arming path.
    assert.match(ir, /declare i32 @yoop_io_arm_readable/);
    // And the coroutine trampolines are installed for the scheduler.
    assert.match(ir, /call void @yoop_runtime_set_coro_ops/);
    // The socket-family externs are declared. These name the runtime's
    // yoop_sock_* shims rather than libc directly: a Windows socket is a
    // SOCKET handle rather than a file descriptor and reports errors through
    // WSAGetLastError, so std/net goes through C wrappers that present the
    // POSIX shape on every platform (see runtime/yoop_net.c).
    assert.match(ir, /declare i32 @yoop_sock_socket\(/);
    assert.match(ir, /declare i32 @yoop_sock_bind\(/);
    assert.match(ir, /declare i32 @yoop_sock_listen\(/);
    // Accept is NOT among them: it goes through the operation API rather than
    // a readiness wait plus a bare accept(). A completion port cannot report
    // that a listening socket became readable (a zero-byte WSARecv on a
    // listener fails with WSAENOTCONN), so awaiting a connection is AcceptEx
    // there and accept-then-arm on POSIX - one call either way.
    assert.match(ir, /declare i64 @yoop_iop_accept_begin\(/);
    assert.match(ir, /declare i64 @yoop_iop_accept_wait\(/);
  });

  // Phase 10.I: `vtable Reader for Readable` round-trips through a
  // type-erased in-memory cursor.
  it("reader_vtable_smoke: Reader.from(ref MemReader) then Readable.read through the vtable", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/reader_vtable_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "n=3 bytes=72,73,33\n");
  });

  // Phase 10.I: pure URL parser - no sockets.
  it("uri_parse_smoke: parseUri handles http/https/ipv6 + error cases", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/uri_parse_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "plain     scheme=http host=example.com port=80 target=/\n" +
      "with-port scheme=http host=example.com port=8080 target=/foo\n" +
      "https     scheme=https host=api.example.com port=443 target=/v1?x=1\n" +
      "ipv6      scheme=http host=::1 port=18080 target=/\n" +
      "no-host   err=parseUri: empty authority\n" +
      "no-scheme err=parseUri: missing \"://\"\n" +
      "bad-port  err=parseUri: trailing garbage in port\n",
    );
  });

  // Pure exercise of std/http/url.yoop plus the router's path matcher: target
  // splitting, percent coding, urlencoded parsing, and pattern matching are
  // all functions over strings, so this runs with no sockets.
  it("http_url_smoke: target splitting, percent coding, and route patterns", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_url_smoke/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "target /todos/7?done=true&note=a%20b+c&flag#frag -> path=/todos/7 pairs=3 done=[true] note=[a b c] flag=[]\n" +
      "target /todos -> path=/todos pairs=0\n" +
      "segments=2 [a] [b-c]\n" +
      "encode=a%20b%2Fc%3Fd%3De\n" +
      "match /todos vs /todos -> hit\n" +
      "match /todos vs /todos/ -> hit\n" +
      "match /todos/:id vs /todos/42 -> hit id=42\n" +
      "match /todos/:id vs /todos -> miss\n" +
      "match /todos/:id vs /todos/42/notes -> miss\n" +
      "match /static/* vs /static/css/app.css -> hit rest=css/app.css\n" +
      "match /static/* vs /static -> hit rest=\n" +
      "decodePath rejected: 400 encoded path separator is not allowed\n",
    );
  });

  // Layout regressions. Each of these used to corrupt memory rather than fail
  // to compile: a variant nested in a variant payload was sized without its
  // payload floor + pad, a vtable had no size case at all (so a Vec of structs
  // holding one overran its buffer), and a module-level const string reached
  // the binary with its escape sequences undecoded.
  it("variant_layout: nested variant payload, vtable in a Vec, const escapes", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/variant_layout/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "code=7 message=payload survived the round trip\n" +
      "entries=6 total=150 last=slot5\n" +
      "greetingLen=5\n",
    );
  });

  // The http_router example exercises std/http/router.yoop. Building
  // requires that the `Dispatcher` vtable type-checks and that a Router
  // whose route entries carry a vtable field instantiates cleanly.
  // Running binds a port + needs curl - manual test.
  it("http_router: builds end-to-end (manual curl test against /hello + /greet/:name)", () => {
    const { ir } = compileEntry(
      path.join(repoRoot, "examples/pass/http_router/main.yoop"),
    );
    // The Dispatcher vtable must materialize in the IR.
    assert.match(ir, /%vtable\..*__Dispatcher/);
    // The Router implements Handler, so it has its own trait-method define
    // and reaches the route table's dispatchers through the same vtable.
    assert.match(ir, /define .*@http_.*__Router__Handler__handle/);
    assert.match(ir, /define .*@http_.*__matchPath/);
  });

  // Phase 10.I: end-to-end client+server in one process. A background
  // task serves one request; the main thread issues an http_get and
  // prints the response body.
  it("http_client_loopback: in-process server task + client GET/POST round-trip", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/http_client_loopback/main.yoop");
    assert.equal(exitCode, 0);
    // The two task threads can interleave their stdout writes, so these are
    // contains-checks rather than an exact-output comparison.
    assert.ok(
      stdout.includes("status=200 body=ping-pong"),
      `expected GET response in stdout, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("status=200 body=echo:hello"),
      `expected POST echo in stdout, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("server done served=2"),
      `expected server-done in stdout, got: ${stdout}`,
    );
  });
});

// A batch of papercuts found porting DOOM (the yooperdoom spikes). Each was a
// VALID program the compiler wrongly rejected, and each failed somewhere other
// than the line the user wrote - an LLVM verifier error, a codegen throw, or a
// diagnostic naming the wrong thing - so all of them cost far more than the
// one-line fix suggests. The extern-from-a-sibling-file case is with the other
// directory-module tests below; the conferred-kind one, which failed OPEN and
// is the serious member of the set, is in the fail-fixture block.
describe("e2e: porting papercuts", { concurrency: E2E_CONCURRENCY }, () => {
  it("codegen_name_and_literal_papercuts: untyped-literal interpolation + emitter-reserved local names", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/codegen_name_and_literal_papercuts.yoop",
    );
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /intdiv=-3/); // was: llvmType: unhandled kind "untypedInt"
    assert.match(stdout, /nested=-9/); // unary over binary, both still untyped
    assert.match(stdout, /shifted=16/);
    assert.match(stdout, /fdiv=3\.5/);
    assert.match(stdout, /bare=7/);
    assert.match(stdout, /cmp=1 fcmp=1/); // comparison of two untyped operands
    // was: "multiple definition of local value named 't0'"
    assert.match(stdout, /names=42 1 2 3 4 3/);
  });

  it("fnptr_ref_param: a named fn with a `ref` param materializes as a function value", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/fnptr_ref_param.yoop");
    assert.strictEqual(exitCode, 0);
    // 1 + 10 + 1 + 1 + 10 + 1 across local, field, two array slots and a vtable
    assert.match(stdout, /v=24/);
  });

  it("elem_field_assign: `arr[i].field = v` works, plain and compound", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/elem_field_assign.yoop");
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /f0=6 f1=7 c1=9/);
  });

  it("ref_in_struct_field: a `ref T` binding stores into a `ref T` field, and the field traverses", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/ref_in_struct_field.yoop");
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /v=8 id=3 ownerv=8/);
    assert.match(stdout, /after=42/); // write through the ref field reaches the original
  });

  it("enum_array: an array of a value enum compiles, and two value enums stay distinct", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/enum_array.yoop");
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /total=3 first=0/); // was: arrayElemLlvmName: unsupported elem type
    assert.match(stdout, /elem1=C/);
    assert.match(stdout, /veclen=2 v0=1/); // the same elem type through Vec<K>
    // The second value enum in one program - the instantiation-key collision.
    assert.match(stdout, /n0=alpha same=1/);
  });

  // A direct field write on a const binding is still rejected - only a chain
  // that passes THROUGH an index escapes the root binding's mutability, the
  // same way plain `arr[i] = v` always has.
  it("const_field_assign: a direct field write on a const binding is still an error", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/const_field_assign.yoop");
    assert.ok(
      errors.some((e) => /cannot assign to field of const "p"/.test(e.message)),
      `expected a const-field error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });
});

// Declaration order must not decide whether a program compiles or what it does.
// Every type in the fixture is USED above the line that declares it. All four
// shapes shared one root cause - a reference resolving against a pass-A shell
// that pass C had not filled yet - and they failed in four different ways,
// including a compiler CRASH and (across the files of a directory module) a
// SILENT MISCOMPILE. See plans/modules-as-directories.md.
describe("e2e: declaration order independence", { concurrency: E2E_CONCURRENCY }, () => {
  it("decl_order_independence: struct field, variant payload, and generic arg all resolve when declared later", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/decl_order_independence.yoop",
    );
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /holder=7/); // concrete field -> later struct (was a crash)
    assert.match(stdout, /boxed=9/); // variant payload -> later struct
    assert.match(stdout, /carrier=11/); // concrete field -> later generic
    assert.match(stdout, /wrapped=7/); // variant payload -> later generic
  });

  it("parse_error_in_import: a syntax error in an imported module blames THAT file", () => {
    assert.throws(
      () =>
        loadModuleGraph(
          path.join(repoRoot, "examples/fail/parse_error_in_import/main.yoop"),
        ),
      (err) => {
        assert.ok(err.isParseError, "expected a parse error");
        // The point of the fix: the failing FILE is stamped on the throw, so the
        // driver stops rendering every parse error against the entry file.
        // Either separator: srcPath comes from path.join, so it is
        // backslash-separated on Windows.
        assert.match(err.srcPath ?? "", /parse_error_in_import[\\/]lib\.yoop$/);
        assert.match(err.srcText ?? "", /export function ok/);
        return true;
      },
    );
  });
});

// modules-as-directories: a module is either one source file (no header) or a
// DIRECTORY of source files that each declare `module <name>;`. See
// plans/modules-as-directories.md.
describe("e2e: directory modules", { concurrency: E2E_CONCURRENCY }, () => {
  it("dir_module: two source files form one module and share a namespace", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/dir_module/main.yoop");
    assert.strictEqual(exitCode, 0);
    // areaOf/doubledArea live in area.yoop; Point and the PRIVATE `doubled`
    // live in point.yoop. area.yoop imports neither - siblings in a module see
    // each other's declarations, exported or not, with no import.
    assert.match(stdout, /area=12/);
    assert.match(stdout, /doubledArea=24/);
    assert.match(stdout, /stretched=6,8/);
    // Both files declare a module-level const with an unfoldable initializer,
    // so both really go through a runtime module-init. 4 + 8 proves both ran.
    assert.match(stdout, /scratchCaps=12/);
  });

  // A module's semantics must not depend on the alphabetical spelling of its
  // filenames. This fixture's impl file is deliberately named so it sorts BEFORE
  // the file declaring the trait, the generic, and the type the kind governs.
  // Pass C used to be module-major (every sub-stage per source file), so an impl
  // could be validated against a still-empty trait method map and this failed
  // with "'self' can only be used inside a trait method body". Pass C is now
  // group-major / stage-minor: every file of a module completes a stage before
  // the next stage starts for any of them.
  it("dir_module_order: a trait/generic/kind used from an EARLIER-sorting sibling file", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/dir_module_order/main.yoop",
    );
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /greet=40/); // trait impl + trait-qualified dispatch
    assert.match(stdout, /boxed=4/); // generic declared in the later file
    assert.match(stdout, /cleanup=70/); // kind-governed binding, auto-dispose
  });

  it("dir_module: both source files mangle against ONE module id", () => {
    const { ir } = compileEntry(
      path.join(repoRoot, "examples/pass/dir_module/main.yoop"),
    );
    // areaOf (area.yoop) and stretched (point.yoop) are different FILES but one
    // module, so they carry the same mangling prefix. That prefix is derived
    // from the directory, and the declared name supplies its readable part.
    const areaOf = ir.match(/@(shapes_[0-9a-f]+)__areaOf\(/);
    const stretched = ir.match(/@(shapes_[0-9a-f]+)__stretched\(/);
    assert.ok(areaOf, "expected an areaOf define mangled under a shapes_* module id");
    assert.ok(stretched, "expected a stretched define mangled under a shapes_* module id");
    assert.strictEqual(areaOf[1], stretched[1]);
    // The module-init symbol is per SOURCE FILE, because one define per module
    // would be an LLVM redefinition when two files both have module-level decls.
    const inits = [...ir.matchAll(/define internal void @(\S*?__module_init\S*)\(\)/g)]
      .map((m) => m[1])
      .filter((s) => s.startsWith("shapes_"));
    assert.strictEqual(inits.length, 2, `expected 2 shapes module inits, got ${inits.join(", ")}`);
    assert.strictEqual(new Set(inits).size, 2, "the two inits must have distinct symbols");
  });

  // An `extern "C"` decl (and an `export "C"` fn) is a DECLARATION, so every
  // file of a directory module may call it - but codegen decided "unmangled C
  // symbol or `<moduleId>__` mangled one" from the file it was emitting, so a
  // sibling's call named a symbol nothing defines. Passed typecheck AND IR
  // generation; only clang caught it.
  it("extern_sibling_call: an extern C symbol called from a sibling file keeps its unmangled name", async () => {
    const { stdout, exitCode } = await runFixture(
      "examples/pass/extern_sibling_call/main.yoop",
    );
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /from the declaring file/);
    assert.match(stdout, /from a sibling file/);
    assert.match(stdout, /from a C-exported function/);
  });

  it("extern_sibling_call: the sibling's call site emits @puts, not a mangled symbol", () => {
    const { ir } = compileEntry(
      path.join(repoRoot, "examples/pass/extern_sibling_call/main.yoop"),
    );
    assert.ok(/call i32 @puts\(/.test(ir), "expected an unmangled @puts call");
    assert.ok(
      !/@plat_[0-9a-f]+__puts/.test(ir),
      "an extern must never be mangled under the module id",
    );
  });
});

describe("e2e: multi-file fail fixtures produce the right errors", { concurrency: E2E_CONCURRENCY }, () => {
  // A half-opted-in directory is an error rather than a silently-split module.
  // This is what catches a file added later by someone who did not notice the
  // directory had a `module` header.
  it("dir_module_mixed: a source file without the module header is rejected", () => {
    assert.throws(
      () =>
        loadModuleGraph(
          path.join(repoRoot, "examples/fail/dir_module_mixed/main.yoop"),
        ),
      /b\.yoop is in module directory .* but has no `module m;` header/,
    );
  });

  // The module is the unit, so one of its source files cannot be imported on
  // its own. The error names the form that works instead of quietly pulling in
  // the whole directory.
  it("dir_module_file_import: importing one source file of a module is rejected", () => {
    assert.throws(
      () =>
        loadModuleGraph(
          path.join(repoRoot, "examples/fail/dir_module_file_import/main.yoop"),
        ),
      /names one source file of module "m" - import the module itself instead/,
    );
  });

  it("import_no_yoop_ext.yoop: import path must end in .yoop", () => {
    const entryAbs = path.join(repoRoot, "examples/fail/import_no_yoop_ext.yoop");
    assert.throws(
      () => loadModuleGraph(entryAbs),
      /must end in \.yoop/,
    );
  });

  it("extern_unsupported_abi.yoop: extern \"Rust\" is rejected at parse time", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/extern_unsupported_abi.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /unsupported extern ABI "Rust"/);
  });

  it("std_named_value_import.yoop: importing a std/ value by name is rejected with a fix-it", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/std_named_value_import.yoop");
    assert.ok(
      errors.some((e) => /imports of value "info" from "std\/log\.yoop" must use the namespace form/.test(e.message)),
      `expected std named-value import error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("import_after_decl.yoop: import after non-import decl is a parse error", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/import_after_decl.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /imports must come before other declarations/);
  });

  it("import_unknown_export: importing a non-exported name is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/import_unknown_export/main.yoop");
    assert.ok(
      errors.some((e) => /has no export "nope"/.test(e.message)),
      `expected no-export error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("import_collision: re-importing the same local name is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/import_collision/main.yoop");
    assert.ok(
      errors.some((e) => /collides with an existing declaration/.test(e.message)),
      `expected collision error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("import_cycle: cyclic imports are detected at graph-load time", () => {
    const entryAbs = path.join(repoRoot, "examples/fail/import_cycle/a.yoop");
    assert.throws(
      () => loadModuleGraph(entryAbs),
      /import cycle detected/,
    );
  });

  it("namespace_private: accessing a private export via namespace is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/namespace_private/main.yoop");
    assert.ok(
      errors.some((e) => /has no export "private_fn"/.test(e.message)),
      `expected namespace-private error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("vec_no_disposable: binding Vec<T> without `disposable` is advisory, not an error (ownership redesign)", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/vec_no_disposable/main.yoop");
    assert.equal(
      errors.length,
      0,
      `expected clean typecheck under the advisory model, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 10.E: cross-shape `?` is only accepted when the operand's Err type
  // implements `Into<RetErr>` for the enclosing return's Err type. Without
  // that impl the typechecker rejects with a fix-it pointing at the trait.
  it("qmark_cross_shape_no_into: `?` between mismatched Err payloads without an Into<T> impl is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/qmark_cross_shape_no_into.yoop");
    assert.ok(
      errors.some((e) => /no `Into<struct AppError>` impl on struct IoError/.test(e.message)),
      `expected missing-Into error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 10.E.2: a context string on a `?` whose Err payload is a struct
  // with no `WithContext<RetErr>` impl is rejected, with the impl to add
  // spelled out in source-writable form.
  it("qmark_context_no_impl: `?` context on a payload with no WithContext impl is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/qmark_context_no_impl.yoop");
    assert.ok(
      errors.some((e) =>
        /needs a `WithContext<ParseError>` impl on struct ParseError/.test(e.message),
      ),
      `expected missing-WithContext error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 10.K: `VTableName.fromFn(...)` arguments must match the method slot
  // signature. A return-type mismatch (int32 where the slot wants bool) is
  // rejected at typecheck.
  it("vtable_fromfn_sig_mismatch: a fromFn arg whose signature differs from the method slot is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/vtable_fromfn_sig_mismatch.yoop");
    assert.ok(
      errors.some((e) => /fromFn.*argument 1.*does not match method "test"/.test(e.message)),
      `expected fromFn signature-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });
});

// Phase 11.B: opportunistic module-init folding. The comptime pass
// tries to evaluate each module-level let/const initializer; on success
// codegen emits the literal value as the LLVM @global initial and
// skips the runtime module_init for that decl. Failures are silent
// (existing programs unaffected).
describe("e2e: Phase 11.B opportunistic module-init folding", { concurrency: E2E_CONCURRENCY }, () => {
  it("comptime_enum_fold.yoop: enum variant + switch + payload-bindings fold via the comptime interpreter", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/comptime_enum_fold.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "AREAS C=96 S=50 T=0\nCLASS 0=100 2=20 99=-1\n",
    );
  });

  it("comptime_enum_fold.yoop: consumer area_doubled/classify fold to literal i32 globals", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/comptime_enum_fold.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    // The function-call results fold even though the enum producers
    // themselves stay at zeroinitializer (enum payload-as-bytes
    // constant encoding isn't wired yet - runtime module_init still
    // constructs the enum globals).
    assert.match(ir, /C_AREA = internal global i32 96,/);
    assert.match(ir, /S_AREA = internal global i32 50,/);
    assert.match(ir, /T_AREA = internal global i32 0,/);
    assert.match(ir, /CLASS_0 = internal global i32 100,/);
    assert.match(ir, /CLASS_2 = internal global i32 20,/);
    assert.match(ir, /CLASS_99 = internal global i32 -1,/);
  });

  it("module_init_folded.yoop: int/bool/string/struct/array/ops fold and print expected values", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/module_init_folded.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "SUM=5\n" +
        "PRODUCT=14\n" +
        "DIFFERENCE=-3\n" +
        "FLAG\n" +
        "GREETING=yoop\n" +
        "ORIGIN=(3,4)\n" +
        "NUMS=10,20,30 len=3\n" +
        "MASK=254 SHIFTED=1024 NEGATED=-16\n" +
        "EQ\n" +
        "HIGH_BIT\n" +
        "ORIGIN_X=3 NUMS_FIRST=10 NUMS_LEN=3\n" +
        "SQUARED=36 NESTED=16\n" +
        "FACT_5=120 FACT_8=40320 ABS_DIFF=7\n" +
        "CAST_F=42.000000 CAST_U8=255\n" +
        "BUILT=(17,42) BUMPED_SUM=140\n" +
        "BUMPED_PT=(4,6)\n" +
        "FORIN_SUM=15\n",
    );
  });

  it("module_init_folded.yoop: IR has literal-initialized globals and no module_init function", () => {
    // Re-emit the IR and inspect - the load-bearing claim is that the
    // fold actually happened, not just that the runtime produced the
    // same number. (A regression that fell back to runtime init would
    // still print the right number but defeat the whole feature.)
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/module_init_folded.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    // Each folded global appears with its literal value, not zeroinitializer.
    assert.match(ir, /SUM = internal global i32 5,/);
    assert.match(ir, /PRODUCT = internal global i32 14,/);
    assert.match(ir, /DIFFERENCE = internal global i32 -3,/);
    assert.match(ir, /FLAG = internal global i1 1,/);
    // String folds emit a pointer-to-aux-global; the aux global's name
    // is freshly minted by emitRawStringGlobal so it's not stable
    // across runs - match by shape (`ptr @<str-sym>`) rather than
    // exact name.
    assert.match(ir, /GREETING = internal global ptr @\.str_[^,]+,/);
    // Struct fold: declared-order normalization means the
    // out-of-source-order `{ y: 4, x: 3 }` lands as `{i32 3, i32 4}`
    // in the LLVM aggregate constant (x first, then y).
    assert.match(
      ir,
      /ORIGIN = internal global %struct\.[^ ]+ \{ i32 3, i32 4 \},/,
    );
    // Array fold: the global is a fat-pointer `{ ptr @<backing>, i64 N }`
    // pointing at a private `[N x i32]` backing constant.
    assert.match(
      ir,
      /@\.arr_[^ ]+ = private unnamed_addr constant \[3 x i32\] \[i32 10, i32 20, i32 30\],/,
    );
    assert.match(
      ir,
      /NUMS = internal global %yoop_array\.int32 \{ ptr @\.arr_[^,]+, i64 3 \},/,
    );
    // Bitwise/shift/cmp/logical/unary fold: each as a literal global.
    assert.match(ir, /MASK = internal global i32 254,/);
    assert.match(ir, /SHIFTED = internal global i32 1024,/);
    assert.match(ir, /NEGATED = internal global i32 -16,/);
    assert.match(ir, /EQ_FLAG = internal global i1 1,/);
    assert.match(ir, /HAS_HIGH_BIT = internal global i1 1,/);
    // Field / index / array.len reads fold to literal primitive globals.
    assert.match(ir, /ORIGIN_X = internal global i32 3,/);
    assert.match(ir, /NUMS_FIRST = internal global i32 10,/);
    assert.match(ir, /NUMS_LEN = internal global i64 3,/);
    // Direct-call fold + nested call fold.
    assert.match(ir, /SQUARED = internal global i32 36,/);
    assert.match(ir, /NESTED = internal global i32 16,/);
    // Locals + control flow folds: while-loop factorial, if/else branch.
    assert.match(ir, /FACT_5 = internal global i32 120,/);
    assert.match(ir, /FACT_8 = internal global i32 40320,/);
    assert.match(ir, /ABS_DIFF = internal global i32 7,/);
    // Cast fold: int32 → float32 lands with the LLVM-required
    // decimal point, int32 → uint8 truncates.
    assert.match(ir, /CAST_F = internal global float 42\.0,/);
    assert.match(ir, /CAST_U8 = internal global i8 255,/);
    // Field-store + index-store folds: the local mutation flows
    // through to the final returned struct/value and lands as the
    // global's literal init.
    assert.match(ir, /BUILT = internal global %struct\.[^ ]+ \{ i32 17, i32 42 \},/);
    assert.match(ir, /BUMPED_SUM = internal global i32 140,/);
    // Ref-param mutation fold: the callee mutated the caller's
    // binding through `ref p`, and the resulting struct survives
    // out of the fold.
    assert.match(ir, /BUMPED_PT = internal global %struct\.[^ ]+ \{ i32 4, i32 6 \},/);
    // for-in fold: the iterating function returns 1+2+3+4+5 = 15.
    assert.match(ir, /FORIN_SUM = internal global i32 15,/);
    // No module_init function gets emitted since every decl folded.
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });
});

// Phase 11.A: `@`-attribute syntax + registry skeleton. Phase 11.C
// wires `@precompile`'s comptimePhase to the interpreter - init-form
// folds become hard errors when the comptime evaluator can't honor
// the user's directive, and the block form is reserved for a later
// sub-phase with a clear "not yet supported" diagnostic.
describe("e2e: Phase 11.A `@`-attribute parsing + registry dispatch", { concurrency: E2E_CONCURRENCY }, () => {
  it("at_unknown_attribute.yoop: unknown `@foo` errors with a Levenshtein 'did you mean' hint", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/at_unknown_attribute.yoop"),
      "utf8",
    );
    assert.throws(
      () => parse(src),
      /unknown attribute @precompil\. Did you mean @precompile\?/,
    );
  });

  it("at_precompile_block.yoop: block form executes at comptime and commits writes to module-level @globals", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_block.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "SQUARES=0,1,4,9,16,25,36,49\nSUM=140\nTIP=(140,-140)\n",
    );
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_block.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    // SUM is a primitive - the block-written value lands directly
    // as the LLVM @global's initial value.
    assert.match(ir, /SUM = internal global i32 140,/);
    // TIP is a struct - the block-written struct literal becomes
    // the @global aggregate initializer (named-struct form).
    assert.match(ir, /TIP = internal global %[^ ]+ \{ i32 140, i32 -140 \},/);
    // No module_init function should be emitted: every module-level
    // let either pre-folded to its default or was overwritten by
    // the block, so codegen has nothing left for runtime init.
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_printf.yoop: comptime printf writes to stderr with a `[comptime]` prefix and the block's computed values land in the @global", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_printf.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "RESULT=42\n");
    // The comptime printf path runs during compileSource → capture
    // stderr and assert the `[comptime]` line appeared with the
    // expected interpolations resolved by the template-lowerer.
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_printf.yoop"),
      "utf8",
    );
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    let ir;
    try { ir = compileSource(src); } finally { process.stderr.write = origWrite; }
    assert.match(captured, /\[comptime\] computed RESULT=42 \(a=6 b=7\)\n/);
    assert.match(ir, /RESULT = internal global i32 42,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_log.yoop: a @precompile block can call std/log; namespace calls resolve and the sinks print at comptime", async () => {
    // The comptime log output is written to the parent process's stderr
    // during compileEntry (inside runFixtureEntry), so capture it around
    // that call. The compiled binary's own stdout/stderr come back
    // through spawnSync and are unaffected by the capture.
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    let result;
    try {
      result = await runFixtureEntry("examples/pass/at_precompile_log.yoop");
    } finally {
      process.stderr.write = origWrite;
    }
    // Comptime: all three levels printed with the `[comptime] [<level>]`
    // banner, and the folded module-level binding was interpolated.
    assert.match(captured, /\[comptime\] \[info\] precompile: starting setup\n/);
    assert.match(captured, /\[comptime\] \[warn\] precompile: configured 6 slots\n/);
    assert.match(captured, /\[comptime\] \[error\] precompile: nothing actually wrong, just exercising the sink\n/);
    // Runtime: the program runs normally - log.info goes to stderr,
    // printf goes to stdout, and the comptime-folded READY shows 6.
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "READY=6\n");
    assert.equal(result.stderr, "[info] runtime: program started\n");
  });

  it("at_precompile_block_unfoldable.yoop: block form hitting a non-whitelisted extern surfaces as a hard build error", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/at_precompile_block_unfoldable.yoop"),
      "utf8",
    );
    const ast = parse(src);
    const mod = { id: "fixture", absPath: "fixture", src, ast };
    const { errors: tcErrors } = typecheckProgram([mod]);
    assert.equal(tcErrors.length, 0, `unexpected typecheck errors: ${tcErrors.map((e) => e.message).join(" | ")}`);
    runComptimePass([mod]);
    const attrErrors = [];
    runAttributePass([mod], attrErrors);
    assert.ok(
      attrErrors.some((e) => /@precompile \{ \.\.\. \} block failed to evaluate/.test(e.message)),
      `expected block-fold-failure error, got: ${attrErrors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("at_precompile_unfoldable.yoop: init form whose RHS can't be folded surfaces as a hard build error", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/at_precompile_unfoldable.yoop"),
      "utf8",
    );
    const ast = parse(src);
    const mod = { id: "fixture", absPath: "fixture", src, ast };
    const { errors: tcErrors } = typecheckProgram([mod]);
    assert.equal(tcErrors.length, 0, `unexpected typecheck errors: ${tcErrors.map((e) => e.message).join(" | ")}`);
    // Comptime pass first (so the @precompile handler can read the
    // unfolded state), then attribute pass.
    runComptimePass([mod]);
    const attrErrors = [];
    runAttributePass([mod], attrErrors);
    assert.ok(
      attrErrors.some((e) => /@precompile fold failed for 'HOME'/.test(e.message)),
      `expected fold-failure error, got: ${attrErrors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("at_precompile_dispose.yoop: disposable-kind CLEANUP_CALL dispatches the trait method through the interpreter", async () => {
    // Multi-module fixture (imports std/core/kinds for disposable + Disposable).
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/at_precompile_dispose.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "R_FIVE=6 R_HUNDRED=100\n");
    const entryAbs = path.join(repoRoot, "examples/pass/at_precompile_dispose.yoop");
    const { ir } = compileEntry(entryAbs);
    assert.match(ir, /R_FIVE = internal global i32 6,/);
    assert.match(ir, /R_HUNDRED = internal global i32 100,/);
    // The folded inits don't need a module_init function for these
    // decls (every initializer evaluated at fold time). The std/core
    // module may have its own module_init for things it initializes
    // at runtime, but the entry-module's @precompile decls don't.
    assert.doesNotMatch(
      ir,
      /define internal void @at_precompile_dispose_[0-9a-f]+__module_init\(\)/,
    );
  });

  it("at_precompile_qmark_into.yoop: cross-shape `?` propagation calls Into.into in the err branch at fold time", async () => {
    // Multi-module fixture (imports std/core/types + std/core/traits)
    // so it must go through the full module-graph compile path.
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/at_precompile_qmark_into.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "HAPPY=7 SAD=63\n");
    const entryAbs = path.join(repoRoot, "examples/pass/at_precompile_qmark_into.yoop");
    const { ir } = compileEntry(entryAbs);
    assert.match(ir, /HAPPY = internal global i32 7,/);
    // SAD = (0 - (-7)) * 10 - tag = 70 - 7 = 63. The tag=7 proves
    // Into.into ran (a bit-copy of the source IoError{-7} would
    // leave tag at 0 and the result would be 70).
    assert.match(ir, /SAD = internal global i32 63,/);
    assert.doesNotMatch(
      ir,
      /define internal void @at_precompile_qmark_into_[0-9a-f]+__module_init\(\)/,
    );
  });

  it("at_precompile_vtable.yoop: vtable construct + indirect dispatch fold through the trait method resolver", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_vtable.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "DBL=35 ADD=107\n");
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_vtable.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    assert.match(ir, /DBL = internal global i32 35,/);
    assert.match(ir, /ADD = internal global i32 107,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_qmark.yoop: `?` propagation over Result-shaped enums folds Ok-path + Err-path", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_qmark.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "GOOD=13 BAD=0\n");
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_qmark.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    assert.match(ir, /GOOD = internal global i32 13,/);
    assert.match(ir, /BAD = internal global i32 0,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  // Phase 10.E.2 at comptime. Multi-module fixture (imports std/core/types +
  // std/core/traits) so it goes through the module-graph compile path.
  // CONCAT_CMP=0 means the string-payload path built exactly
  // "step -1: boom"; TRAIT_SCORE=500 means WithContext.withContext ran with
  // both the receiver (code 5) and an intact context string (strcmp 0);
  // TRAIT_OK=7 means the context never ran on the success path.
  it("at_precompile_qmark_context.yoop: `?` context strings fold at comptime (concat + WithContext)", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/at_precompile_qmark_context.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "CONCAT_CMP=0 TRAIT_SCORE=500 TRAIT_OK=7\n");
    const entryAbs = path.join(repoRoot, "examples/pass/at_precompile_qmark_context.yoop");
    const { ir } = compileEntry(entryAbs);
    assert.match(ir, /CONCAT_CMP = internal global i32 0,/);
    assert.match(ir, /TRAIT_SCORE = internal global i32 500,/);
    assert.match(ir, /TRAIT_OK = internal global i32 7,/);
    assert.doesNotMatch(
      ir,
      /define internal void @at_precompile_qmark_context_[0-9a-f]+__module_init\(\)/,
    );
  });

  it("at_precompile_tasks.yoop: task fns execute synchronously inline at comptime (immediate / joined+wait / pooled+wait)", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_tasks.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "IMM=50 JOIN=66 POOL=84 MULTI=42\n");
    // compileEntry, not compileSource: the concurrency kinds live in
    // std/core/kinds.yoop now, so this fixture needs the module graph (which
    // autoloads it). The legacy single-module path has no std at all.
    const { ir } = compileEntry(
      path.join(repoRoot, "examples/pass/at_precompile_tasks.yoop"),
    );
    assert.match(ir, /IMM = internal global i32 50,/);
    assert.match(ir, /JOIN = internal global i32 66,/);
    assert.match(ir, /POOL = internal global i32 84,/);
    assert.match(ir, /MULTI = internal global i32 42,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_generics.yoop: generic function instantiations fold via the registry's substituted AST + interpreter", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_generics.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "A=99 C=7 W=10\n");
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_generics.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    assert.match(ir, /A = internal global i32 99,/);
    assert.match(ir, /C = internal global i32 7,/);
    assert.match(ir, /W = internal global i32 10,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_traits.yoop: trait method calls dispatch through the interpreter + cache at fold time", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_traits.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "RECT_AREA=28\nRECT_PERIM=22\nSQR_AREA=81\nTOTAL=19\n",
    );
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_traits.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    assert.match(ir, /RECT_AREA = internal global i32 28,/);
    assert.match(ir, /RECT_PERIM = internal global i32 22,/);
    assert.match(ir, /SQR_AREA = internal global i32 81,/);
    assert.match(ir, /TOTAL = internal global i32 19,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_externs.yoop: whitelisted libc externs (sqrt/pow/floor/strlen/strcmp) fold under @precompile", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_externs.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "ROOT_2=1.414214\nHYPOT=5.000000\nFLOOR_PI=3.000000\nNAME_LEN=12\nCMP_EQ=0 CMP_LT=-1\n",
    );
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_externs.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    // sqrt(2) folded as the literal double; libc's printf converts
    // it to "1.414214" at runtime, but the IR carries the full
    // double precision.
    assert.match(ir, /ROOT_2 = internal global double 1\.4142135623730951,/);
    // sqrt(3^2 + 4^2) = 5 (LLVM uses `5` for `5.0`-equivalent
    // because Number.toString() drops a trailing `.0` we re-add).
    assert.match(ir, /HYPOT = internal global double 5\.0,/);
    assert.match(ir, /FLOOR_PI = internal global double 3\.0,/);
    assert.match(ir, /NAME_LEN = internal global i64 12,/);
    assert.match(ir, /CMP_EQ = internal global i32 0,/);
    assert.match(ir, /CMP_LT = internal global i32 -1,/);
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });

  it("at_precompile_basic.yoop: init-form folds run end-to-end with literal globals + no module_init", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/at_precompile_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "SQR_7=49 FACT_6=720\nTBL=1,4,9,16,25\n");
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/pass/at_precompile_basic.yoop"),
      "utf8",
    );
    const ir = compileSource(src);
    assert.match(ir, /SQR_7 = internal global i32 49,/);
    assert.match(ir, /FACT_6 = internal global i32 720,/);
    assert.match(
      ir,
      /TBL = internal global %yoop_array\.int32 \{ ptr @\.arr_[^,]+, i64 5 \},/,
    );
    assert.doesNotMatch(ir, /define internal void @[^ ]*__module_init\(\)/);
  });
});

describe("e2e: fail fixtures fail at the right stage with the right message", { concurrency: E2E_CONCURRENCY }, () => {
  it("parse_bad_suffix.yoop throws a parse-time error about a missing semicolon", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/parse_bad_suffix.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /expected semicolon/);
  });

  it("type_alias_unknown_target.yoop rejects a type alias whose RHS names an unknown type", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/type_alias_unknown_target.yoop");
    assert.ok(
      errors.some((e) => /type alias "Foo" references an unknown type or is cyclic/.test(e.message)),
      `expected unknown-alias-target error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("type_alias_cyclic.yoop rejects a cyclic alias chain instead of looping", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/type_alias_cyclic.yoop");
    assert.ok(
      errors.some((e) => /type alias "A" references an unknown type or is cyclic/.test(e.message)),
      `expected cyclic-alias error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("type_alias_generic.yoop rejects a generic type alias with no spurious follow-on error", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/type_alias_generic.yoop");
    assert.ok(
      errors.some((e) => /generic type aliases are not yet supported/.test(e.message)),
      `expected generic-alias error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
    assert.ok(
      !errors.some((e) => /references an unknown type or is cyclic/.test(e.message)),
      `did not expect a follow-on resolve error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("ref_return.yoop rejects a function whose return type is ref T", () => {
    const { errors } = typecheckFixture("examples/fail/ref_return.yoop");
    assert.ok(
      errors.some((e) => /may not return 'ref T'/.test(e.message)),
      `expected ref-return error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("break_outside_loop.yoop rejects break used outside any loop", () => {
    const { errors } = typecheckFixture("examples/fail/break_outside_loop.yoop");
    assert.ok(
      errors.some((e) => /'break' is not inside a loop/.test(e.message)),
      `expected break-outside-loop error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("continue_outside_loop.yoop rejects continue used outside any loop", () => {
    const { errors } = typecheckFixture("examples/fail/continue_outside_loop.yoop");
    assert.ok(
      errors.some((e) => /'continue' is not inside a loop/.test(e.message)),
      `expected continue-outside-loop error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("forin_non_array.yoop rejects 'for ... in' on non-array, non-iterable RHS", () => {
    const { errors } = typecheckFixture("examples/fail/forin_non_array.yoop");
    assert.ok(
      errors.some((e) => /requires an array or a type implementing Iterable<T>/.test(e.message)),
      `expected for-in non-iterable error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("forin_non_iterable_struct.yoop rejects 'for ... in' on a struct lacking Iterable<T>", () => {
    const { errors } = typecheckFixture("examples/fail/forin_non_iterable_struct.yoop");
    assert.ok(
      errors.some((e) => /is not iterable.*Iterable<T>/.test(e.message)),
      `expected non-iterable-struct error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("template_no_display.yoop rejects template interpolation of a non-Display struct", () => {
    const { errors } = typecheckFixture("examples/fail/template_no_display.yoop");
    assert.ok(
      errors.some((e) => /implement Display/.test(e.message)),
      `expected Display-hint error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 10.A: bare `GenericEnum.Variant { ... }` outside a pinning context
  // is unrepresentable - surface the diagnostic at the construction site.
  it("generic_enum_unpinned.yoop rejects unpinned generic-enum variant constructor", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/generic_enum_unpinned.yoop");
    assert.ok(
      errors.some((e) =>
        /cannot determine type arguments for generic variant "Result"/.test(e.message),
      ),
      `expected unpinned-generic-enum error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 10.A: arity mismatch on a generic-enum type annotation should fail
  // type resolution rather than partial-applying or silently ignoring args.
  it("generic_enum_arity.yoop rejects `Result<int32>` (missing E arg)", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/generic_enum_arity.yoop");
    assert.ok(
      errors.some((e) => /unknown type "Result<int32>"/.test(e.message)),
      `expected arity-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("array_elem_type_mismatch.yoop rejects array literal with wrong element type", () => {
    const { errors } = typecheckFixture("examples/fail/array_elem_type_mismatch.yoop");
    assert.ok(
      errors.some((e) => /element 2 has type/.test(e.message)),
      `expected element-type-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("ref_nonlvalue.yoop rejects taking a ref of a non-lvalue expression", () => {
    const { errors } = typecheckFixture("examples/fail/ref_nonlvalue.yoop");
    assert.ok(
      errors.some((e) => /non-lvalue/.test(e.message)),
      `expected non-lvalue error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("cast_nonnumeric.yoop rejects casting a non-numeric type", () => {
    const { errors } = typecheckFixture("examples/fail/cast_nonnumeric.yoop");
    assert.ok(
      errors.some((e) => /cannot cast/.test(e.message)),
      `expected cannot-cast error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_missing_method.yoop rejects impl that omits a required trait method", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_missing_method.yoop");
    assert.ok(
      errors.some((e) => /missing method "dispose"/.test(e.message)),
      `expected missing-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_wrong_signature_return.yoop rejects impl method with wrong return type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_wrong_signature_return.yoop");
    assert.ok(
      errors.some((e) => /method "dispose" on type "T" has signature/.test(e.message)),
      `expected signature-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_wrong_signature_param.yoop rejects impl method with extra parameter", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_wrong_signature_param.yoop");
    assert.ok(
      errors.some((e) => /method "dispose" on type "T" has signature/.test(e.message)),
      `expected signature-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 7.4: these two scenarios are no longer errors - cross-trait same-
  // name impls and trait-method/free-function name collisions are both
  // allowed, because every trait call site qualifies through the trait name.
  // The old fail-fixtures stay on disk as ground truth that they typecheck
  // cleanly now.
  it("traits_collision_two_traits.yoop now typechecks cleanly (Phase 7.4 lifted the restriction)", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_collision_two_traits.yoop");
    assert.deepEqual(
      errors,
      [],
      `expected no errors, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_collision_with_function.yoop now typechecks cleanly (Phase 7.4 lifted the restriction)", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_collision_with_function.yoop");
    assert.deepEqual(
      errors,
      [],
      `expected no errors, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 7.4: bare-form trait method call is rejected with a hint at the
  // qualified form.
  it("traits_bare_form_call.yoop rejects bare 'dispose(ref h)' and hints at Disposable.dispose", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_bare_form_call.yoop");
    assert.ok(
      errors.some((e) => /unknown function "dispose".*Disposable\.dispose/.test(e.message)),
      `expected bare-form rejection with hint, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // modules-as-directories: a module's source files share its DECLARATIONS but
  // not its IMPORTS. Without this, a file could use `vec` because a sibling
  // imported it, and reading a file's head would no longer tell you what it
  // depends on - which is the locality the whole feature exists to recover.
  it("dir_module_import_leak: using a name only a SIBLING file imported is rejected", () => {
    const { errors } = typecheckFixtureEntry(
      "examples/fail/dir_module_import_leak/main.yoop",
    );
    const leaks = errors.filter((e) => /is not imported by this file/.test(e.message));
    // Both the namespace (`vec`) and the named type (`Vec`) are caught.
    assert.strictEqual(leaks.length, 2, leaks.map((e) => e.message).join("\n"));
    assert.ok(
      leaks.every((e) => /imported by a\.yoop/.test(e.message)),
      "each error should name the sibling that did import it",
    );
    // Reported against b.yoop, not the entry or the sibling.
    assert.ok(
      leaks.every((e) => /b\.yoop$/.test(e.srcPath ?? "")),
      `expected b.yoop, got ${leaks.map((e) => e.srcPath).join(", ")}`,
    );
  });

  it("traits_self_outside.yoop rejects 'self' used outside a method body", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_self_outside.yoop");
    assert.ok(
      errors.some((e) => /'self' can only be used inside a trait method body/.test(e.message)),
      `expected self-outside-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_extra_method.yoop rejects impl method not required by any trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_extra_method.yoop");
    assert.ok(
      errors.some((e) => /declares method "extra", but no implemented trait requires it/.test(e.message)),
      `expected extra-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_ref_self_by_value.yoop rejects trait method signature missing 'ref'", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_ref_self_by_value.yoop"),
      "utf8",
    );
    assert.throws(
      () => parse(src),
      /trait method "dispose" must take 'ref self' as its first parameter/,
    );
  });

  it("traits_method_no_implements.yoop rejects methods on a type without implements", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_method_no_implements.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /methods are only allowed inside an 'implements' block/);
  });

  it("traits_unknown_trait.yoop rejects implementing an undefined trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_unknown_trait.yoop");
    assert.ok(
      errors.some((e) => /implements unknown trait "Foo"/.test(e.message)),
      `expected unknown-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_default_body_in_trait.yoop rejects a method body inside a trait declaration", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_default_body_in_trait.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /expected semicolon, got lcurly/);
  });

  // Phase 9.J: `extends` is supported; the SCC rejection is the new failure case.
  it("traits_extends_cycle.yoop rejects a cycle in the extends graph", () => {
    const { errors } = typecheckFixtureProgram(
      "examples/fail/traits_extends_cycle.yoop",
    );
    assert.ok(
      errors.some((e) => /cyclic extends chain/.test(e.message)),
      `expected cyclic extends chain error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_method_call_sugar.yoop rejects method-call syntax on a trait method", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_method_call_sugar.yoop");
    assert.ok(
      errors.some((e) => /method-call form.*is not supported/.test(e.message)),
      `expected method-call-sugar error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_redeclared_method.yoop rejects duplicate method in impl block", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_redeclared_method.yoop");
    assert.ok(
      errors.some((e) => /duplicate method "dispose" in type "T"/.test(e.message)),
      `expected duplicate-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_self_assignment_wrong_type.yoop rejects wrong-type assignment to a self field", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_self_assignment_wrong_type.yoop");
    assert.ok(
      errors.some((e) => /cannot assign/.test(e.message)),
      `expected type-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_unknown_trait.yoop rejects a kind requires clause referencing an undeclared trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_unknown_trait.yoop");
    assert.ok(
      errors.some((e) => /unknown trait 'NotATrait'/.test(e.message)),
      `expected unknown-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_mustcall_no_requires.yoop rejects a mustCall clause with no `requires`", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_mustcall_no_requires.yoop");
    assert.ok(
      errors.some((e) => /mustCall requires at least one 'requires' clause/.test(e.message)),
      `expected mustCall-no-requires error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_mustcall_method_not_in_trait.yoop rejects a mustCall method missing from required traits", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_mustcall_method_not_in_trait.yoop");
    assert.ok(
      errors.some((e) => /no required trait declares this method/.test(e.message)),
      `expected method-not-in-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_unknown_kind.yoop rejects a binding prefixed by an undeclared kind", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_unknown_kind.yoop");
    assert.ok(
      errors.some((e) => /unknown kind "notAKind"/.test(e.message)),
      `expected unknown-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_missing_trait.yoop rejects a kind-prefixed binding whose type lacks a required trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_missing_trait.yoop");
    assert.ok(
      errors.some((e) => /does not implement "Disposable"/.test(e.message)),
      `expected missing-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_non_struct.yoop rejects a kind-prefixed binding with a non-struct type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_non_struct.yoop");
    assert.ok(
      // Phase 13.B: error wording now includes "or variant".
      errors.some((e) => /can only apply to struct or variant values/.test(e.message)),
      `expected non-struct-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_trailing_block_no_ownsblock.yoop rejects a trailing-block binding under a kind without ownsBlock", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_trailing_block_no_ownsblock.yoop");
    assert.ok(
      errors.some((e) => /does not declare ownsBlock/.test(e.message)),
      `expected no-ownsBlock error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // testing-via-kinds: `appliesTo function` now parses (it backs the `suite`
  // kind in std/test.yoop), but a function kind marks a DECLARATION, so it
  // cannot also name a value site.
  it("kind_appliesto_function.yoop rejects appliesTo function mixed with a value site", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_appliesto_function.yoop");
    assert.ok(
      errors.some((e) => /applies to a function and to 'binding'/.test(e.message)),
      `expected function-plus-value-site error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // phase 6.2 parser rejections

  it("kind_appliesto_duplicate.yoop rejects duplicate appliesTo site", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_appliesto_duplicate.yoop"),
      /duplicate appliesTo site 'binding'/,
    );
  });

  it("kind_appliesto_empty.yoop rejects empty appliesTo list", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_appliesto_empty.yoop"),
      /appliesTo requires at least one site/,
    );
  });

  it("kind_mustnotescape_function.yoop rejects mustNotEscape function", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_mustnotescape_function.yoop"),
      /mustNotEscape function not yet supported/,
    );
  });

  // Phase 9.J: `mustNotShare acrossThreads` is now a real language feature.
  // The fail fixture asserts a binding carrying the kind cannot flow into a
  // task spawn site.
  it("kind_mustnotshare_acrossthreads.yoop rejects passing a thread-local binding into a task spawn", () => {
    const { errors } = typecheckFixtureProgram(
      "examples/fail/kind_mustnotshare_acrossthreads.yoop",
    );
    assert.ok(
      errors.some((e) => /mustNotShare acrossThreads/.test(e.message)),
      `expected mustNotShare acrossThreads error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_forbids_unknown.yoop rejects unrecognized forbids category", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_forbids_unknown.yoop"),
      /unrecognized forbids category 'memory'/,
    );
  });

  it("kind_forbids_empty.yoop rejects empty forbids list", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_forbids_empty.yoop"),
      /forbids requires at least one category/,
    );
  });

  it("kind_duplicate_mustnotescape.yoop rejects duplicate mustNotEscape clause", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_duplicate_mustnotescape.yoop");
    assert.ok(
      errors.some((e) => /duplicate mustNotEscape clause/.test(e.message)),
      `expected duplicate-mustNotEscape error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("param_two_kinds.yoop rejects a parameter with two kind prefixes", () => {
    assert.throws(
      () => parseFixture("examples/fail/param_two_kinds.yoop"),
      /a parameter may carry at most one kind prefix/,
    );
  });

  it("param_kind_not_applies.yoop rejects a kind on a parameter when appliesTo excludes parameter", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/param_kind_not_applies.yoop");
    assert.ok(
      errors.some((e) => /does not apply to parameters/.test(e.message)),
      `expected param-applicability error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_kind_not_applies.yoop rejects a kind on a binding when appliesTo excludes binding", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_kind_not_applies.yoop");
    assert.ok(
      errors.some((e) => /does not apply to bindings/.test(e.message)),
      `expected binding-applicability error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("field_with_kind.yoop rejects a kind-prefixed struct field without propagates", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/field_with_kind.yoop");
    assert.ok(
      errors.some((e) => /carries kind 'scoped' but enclosing struct .* does not propagate it/.test(e.message)),
      `expected propagates-missing error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Ownership redesign (2026-06-17, plans/ownership-and-typestate-redesign.md):
  // `propagates<K>` obligations are ADVISORY, not enforced. The five fixtures
  // below were formerly examples/fail cases asserting hard errors; they now
  // typecheck cleanly and live in examples/pass. These tests guard that the
  // relaxation holds (no obligation error is produced).
  it("propagates_return_not_declared.yoop: returning a propagating type without propagates<K> is no longer an error", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/propagates_return_not_declared.yoop");
    assert.equal(errors.length, 0,
      `expected clean typecheck, got: ${errors.map((e) => e.message).join(" | ")}`);
  });

  it("propagates_return_struct_literal_not_declared.yoop: moved-binding literal return without propagates<K> is no longer an error", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/propagates_return_struct_literal_not_declared.yoop");
    assert.equal(errors.length, 0,
      `expected clean typecheck, got: ${errors.map((e) => e.message).join(" | ")}`);
  });

  it("propagates_binding_missing_kind.yoop: an un-disposed binding of a propagating type is no longer an error", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/propagates_binding_missing_kind.yoop");
    assert.equal(errors.length, 0,
      `expected clean typecheck, got: ${errors.map((e) => e.message).join(" | ")}`);
  });

  it("propagates_struct_literal_missing_kind.yoop: an un-disposed struct-literal binding is no longer an error", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/propagates_struct_literal_missing_kind.yoop");
    assert.equal(errors.length, 0,
      `expected clean typecheck, got: ${errors.map((e) => e.message).join(" | ")}`);
  });

  it("propagates_dispose_only_then.yoop: a manual dispose in only one if/else arm is no longer an error", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/propagates_dispose_only_then.yoop");
    assert.equal(errors.length, 0,
      `expected clean typecheck, got: ${errors.map((e) => e.message).join(" | ")}`);
  });

  it("scoped_escape_return.yoop rejects returning a scoped binding", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/scoped_escape_return.yoop");
    assert.ok(
      errors.some((e) => /forbids escape via return/.test(e.message)),
      `expected escape-return error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("scoped_escape_pass_unscoped.yoop rejects passing a scoped ref to a non-scoped parameter", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/scoped_escape_pass_unscoped.yoop");
    assert.ok(
      errors.some((e) => /does not declare 'scoped' or 'mustNotEscape scope' kind/.test(e.message)),
      `expected escape-pass-unscoped error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("scoped_alias.yoop rejects aliasing a scoped binding under a plain name", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/scoped_alias.yoop");
    assert.ok(
      errors.some((e) => /cannot alias a scoped binding/.test(e.message)),
      `expected scoped-alias error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // ---- phase 6.3 task fail fixtures ----
  it("task_on_main.yoop rejects `task main`", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/task_on_main.yoop");
    assert.ok(
      errors.some((e) => /task cannot be applied to main/.test(e.message)),
      `expected task-on-main error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("task_void_return.yoop rejects a void-returning task fn", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/task_void_return.yoop");
    assert.ok(
      errors.some((e) => /task function "noop" cannot return void/.test(e.message)),
      `expected void-task error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("wait_non_task.yoop rejects wait on a non-Task operand", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/wait_non_task.yoop");
    assert.ok(
      errors.some((e) => /wait requires a Task<T> operand/.test(e.message)),
      `expected wait-non-task error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("wait_in_task_body.yoop rejects wait inside a task fn body, pointing at await", async () => {
    const { errors } = typecheckFixtureEntry("examples/fail/wait_in_task_body.yoop");
    assert.ok(
      errors.some((e) => /wait is not allowed inside a task body/.test(e.message)),
      `expected wait-in-task error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
    // The diagnostic has to name the alternative - `await` is the in-task
    // form now, and the old message promised a "future phase" that has
    // since landed.
    assert.ok(
      errors.some((e) => /use "await f\(\.\.\.\)"/.test(e.message)),
      `expected the await fix-it, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("joined_no_task_rhs.yoop rejects joined binding without a task call RHS", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/joined_no_task_rhs.yoop");
    assert.ok(
      errors.some((e) => /joined binding "d" requires a task call RHS/.test(e.message)),
      `expected joined-no-task error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("pooled_no_task_rhs.yoop rejects pooled binding without a task call RHS", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/pooled_no_task_rhs.yoop");
    assert.ok(
      errors.some((e) => /pooled binding "h" requires a task call RHS/.test(e.message)),
      `expected pooled-no-task error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // ---- phase 6.4 fail fixtures ----
  it("propagates_missing.yoop rejects a kind-bearing field without propagates", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/propagates_missing.yoop");
    assert.ok(
      errors.some((e) => /carries kind 'disposable' but enclosing struct 'S' does not propagate it/.test(e.message)),
      `expected propagates-missing error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("propagates_unknown_kind.yoop rejects propagates with an unresolved kind name", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/propagates_unknown_kind.yoop");
    assert.ok(
      errors.some((e) => /unknown kind 'bogus'/.test(e.message)),
      `expected unknown-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("contains_deferred.yoop rejects contains<K> as not yet supported", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/contains_deferred.yoop");
    assert.ok(
      errors.some((e) => /contains not yet supported \(phase 6\.5 or later\)/.test(e.message)),
      `expected contains-deferred error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("cross_module_kind_unexported rejects importing a non-exported kind", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/cross_module_kind_unexported/main.yoop");
    assert.ok(
      errors.some((e) => /has no export "disposable"/.test(e.message)),
      `expected unexported-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // ---- phase 6.5: layout / composition / parameterized kinds ----

  it("kind_compose_contradiction.yoop rejects two align values in composition", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_compose_contradiction.yoop");
    assert.ok(
      errors.some((e) => /composition contradiction.*align 32 vs align 64/.test(e.message)),
      `expected align-contradiction error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_compose_no_common_site.yoop rejects composition with no overlap in appliesTo", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_compose_no_common_site.yoop");
    assert.ok(
      errors.some((e) => /composition has no common application site/.test(e.message)),
      `expected no-common-site error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_compose_inline_appliesto.yoop rejects an inline kind body that declares appliesTo", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_compose_inline_appliesto.yoop"),
      /inline kind body in composition cannot declare 'appliesTo'/,
    );
  });

  it("kind_param_wrong_type.yoop rejects an unsupported kind-parameter type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_param_wrong_type.yoop");
    assert.ok(
      errors.some((e) => /kind parameter type 'string' not yet supported/.test(e.message)),
      `expected unsupported-param-type error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_app_arg_mismatch.yoop rejects a kind use that omits required args", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_app_arg_mismatch.yoop");
    assert.ok(
      errors.some((e) => /kind 'aligned' expects 1 argument\(s\)/.test(e.message)),
      `expected arg-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_app_non_constant.yoop rejects a non-constant kind argument", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_app_non_constant.yoop");
    assert.ok(
      errors.some((e) => /kind argument must be a constant in phase 6\.5/.test(e.message)),
      `expected non-constant-arg error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("restricts_deferred.yoop rejects `restricts iteration` as deferred", () => {
    assert.throws(
      () => parseFixture("examples/fail/restricts_deferred.yoop"),
      /iteration restrictions deferred until for-in iteration lands \(phase 7\)/,
    );
  });

  it("type_prefix_kind_not_appliesto_type.yoop rejects a type prefix whose kind lacks appliesTo type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/type_prefix_kind_not_appliesto_type.yoop");
    assert.ok(
      errors.some((e) => /kind 'only_binding' does not apply to types/.test(e.message)),
      `expected appliesTo-type error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("layout_unknown_subclause.yoop rejects an unknown layout sub-clause", () => {
    assert.throws(
      () => parseFixture("examples/fail/layout_unknown_subclause.yoop"),
      /layout sub-clause 'packing' deferred/,
    );
  });

  it("nested_composition.yoop rejects parenthesized composition operands", () => {
    assert.throws(
      () => parseFixture("examples/fail/nested_composition.yoop"),
      /expected ident/i,
    );
  });

  // ---- 7.2 trait-bound fail fixtures ----

  it("generic_bound_unsatisfied.yoop rejects calling a bounded generic with a non-impl type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/generic_bound_unsatisfied.yoop");
    assert.ok(
      errors.some((e) => /does not satisfy bound.*does not implement trait "Display"/.test(e.message)),
      `expected unsatisfied-bound error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("generic_bound_unknown_trait.yoop rejects an unknown trait in a bound", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/generic_bound_unknown_trait.yoop");
    assert.ok(
      errors.some((e) => /unknown trait "DoesNotExist" in bound/.test(e.message)),
      `expected unknown-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("generic_bound_method_missing.yoop rejects calling a method not on the bound", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/generic_bound_method_missing.yoop");
    assert.ok(
      errors.some((e) => /unknown function "other"/.test(e.message)),
      `expected unknown-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // ---- 7.5 sum types and unions ----

  it("enum_switch_non_exhaustive.yoop rejects an enum switch that omits a variant without default", () => {
    const { errors } = typecheckFixtureProgram(
      "examples/fail/enum_switch_non_exhaustive.yoop",
    );
    assert.ok(
      errors.some((e) =>
        /not exhaustive.*missing variants: C/.test(e.message),
      ),
      `expected non-exhaustive enum switch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("enum_unknown_variant.yoop rejects E.NotThere", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/enum_unknown_variant.yoop");
    assert.ok(
      errors.some((e) => /has no case "NotThere"/.test(e.message)),
      `expected unknown-case error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Phase 12: value-enum failure cases.
  it("value_enum_forward_ref.yoop rejects forward reference to a later case", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/value_enum_forward_ref.yoop");
    assert.ok(
      errors.some((e) => /does not name a prior case/.test(e.message)),
      `expected forward-ref error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("value_enum_string_no_value.yoop rejects a string-backed case without a literal", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/value_enum_string_no_value.yoop");
    assert.ok(
      errors.some((e) => /requires an explicit string value/.test(e.message)),
      `expected missing-string-value error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("value_enum_open_switch_no_default.yoop rejects an open enum switch without default", () => {
    const { errors } = typecheckFixtureProgram(
      "examples/fail/value_enum_open_switch_no_default.yoop",
    );
    assert.ok(
      errors.some((e) => /switch over open enum .* requires a 'default'/.test(e.message)),
      `expected open-enum default error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("value_enum_string_switch.yoop rejects a switch over a string-backed enum", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/value_enum_string_switch.yoop");
    assert.ok(
      errors.some((e) => /switch requires an integer-backed enum/.test(e.message)),
      `expected string-backed-switch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("value_enum_unrelated_compare.yoop rejects comparing two different value enums", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/value_enum_unrelated_compare.yoop");
    assert.ok(
      errors.length >= 1,
      `expected at least one error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("value_enum_shift_oob.yoop rejects an out-of-range shift amount", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/value_enum_shift_oob.yoop");
    assert.ok(
      errors.some((e) => /shift amount .* out of range/.test(e.message)),
      `expected shift-OOB error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("union_multi_field.yoop rejects a union literal with more than one field", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/union_multi_field.yoop");
    assert.ok(
      errors.some((e) => /exactly one field/.test(e.message)),
      `expected multi-field union error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("unsafe_ptr_no_import.yoop rejects unsafe_ptr without import.unsafe", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/unsafe_ptr_no_import.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(
      errors.some((e) => /'import\.unsafe;'/.test(e.message)),
      `expected unsafe-gating error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("unsafe_ptr_deref_non_ptr.yoop rejects '*' on a non-pointer", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/unsafe_ptr_deref_non_ptr.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(
      errors.some((e) => /cannot deref non-pointer type/.test(e.message)),
      `expected non-pointer deref error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Yoopstore-papercut #3: opaque `unsafe_ptr` (no `<T>`) ergonomics.
  it("unsafe_ptr_opaque_deref.yoop rejects '*' on opaque unsafe_ptr", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/unsafe_ptr_opaque_deref.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(
      errors.some((e) => /cannot deref opaque unsafe_ptr/.test(e.message)),
      `expected opaque-deref error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("unsafe_ptr_opaque_to_typed.yoop rejects implicit opaque -> typed assignment", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/unsafe_ptr_opaque_to_typed.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(
      errors.some((e) => /cannot assign unsafe_ptr to unsafe_ptr<int32>/.test(e.message)),
      `expected opaque->typed assignment error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("unsafe_ptr_opaque_arith.yoop rejects pointer arithmetic on opaque unsafe_ptr", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/unsafe_ptr_opaque_arith.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(errors.length > 0, "expected at least one error");
  });

  it("unsafe_ptr_opaque_no_import.yoop gates bare unsafe_ptr behind import.unsafe", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/unsafe_ptr_opaque_no_import.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(
      errors.some((e) => /'unsafe_ptr<T>' requires 'import\.unsafe;'/.test(e.message)),
      `expected import.unsafe gating error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("layout_abi_bad_value.yoop rejects abi values other than \"C\"", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/layout_abi_bad_value.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /abi "Rust" is not a supported ABI marker/);
  });

  it("array_ptr_no_import.yoop rejects xs.ptr without import.unsafe", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/array_ptr_no_import.yoop"),
      "utf8",
    );
    const { errors } = typecheckSource(src);
    assert.ok(
      errors.some((e) => /'\.ptr' on an array requires 'import\.unsafe;'/.test(e.message)),
      `expected array-ptr gating error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("module_const_write.yoop rejects assignment to a module-level const", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/module_const_write.yoop");
    assert.ok(
      errors.some((e) => /cannot assign to const "PI"/.test(e.message)),
      `expected const-write error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("module_state_cross_write rejects writing an imported `let` from another module", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/module_state_cross_write/main.yoop");
    assert.ok(
      errors.some((e) => /assignment from outside its module is not permitted/.test(e.message)),
      `expected cross-module-write error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // ---- Clearance kinds (marker polarity + static two-bound check) ----
  it("clearance_unlaundered_sink.yoop rejects a plain value into a `cleared` (conferred) sink", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_unlaundered_sink.yoop");
    assert.ok(
      errors.some((e) => /parameter 'value' of 'sink' requires kind 'cleared'/.test(e.message)),
      `expected conferred-required error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("clearance_restrictive_leak.yoop rejects a `tainted` value flowing into a plain slot", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_restrictive_leak.yoop");
    assert.ok(
      errors.some((e) => /forbids kind 'tainted' but the value carries it/.test(e.message)),
      `expected restrictive-forbidden error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("clearance_namespaced_sink rejects an un-cleared value into a sink called through its namespace", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/clearance_namespaced_sink/main.yoop");
    assert.ok(
      errors.some((e) => /parameter 'sql' of 'db\.runQuery' requires kind 'cleared'/.test(e.message)),
      `expected cross-module namespaced-sink conferred error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // The serious one from the DOOM port: a conferred kind failing OPEN. The
  // sink lives in a SIBLING FILE of a directory module, and kindFlow's
  // cross-module function index was rebuilt per source file while keyed by
  // MODULE id - so the last file emitted for a module erased its siblings'
  // entries, `crossModuleCallee` returned null, and the argument check just
  // stopped running. No error, no warning; an untested gate and a working
  // gate were indistinguishable.
  it("clearance_sibling_file_sink rejects a forged capability when the sink is in a sibling file", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/clearance_sibling_file_sink/main.yoop");
    assert.ok(
      errors.some((e) => /parameter 'v' of 'sink' requires kind 'cleared'/.test(e.message)),
      `expected sibling-file conferred error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("clearance_marker_and_mustcall.yoop rejects a kind declaring both a marker polarity and mustCall", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_marker_and_mustcall.yoop");
    assert.ok(
      errors.some((e) => /declares a marker polarity .* and 'mustCall'/.test(e.message)),
      `expected marker+mustCall error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("clearance_forge.yoop rejects forging a conferred kind via a binding annotation", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_forge.yoop");
    assert.ok(
      errors.some((e) => /binding 'c' requires kind 'cleared'/.test(e.message)),
      `expected forge-binding error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("clearance_fake_launder.yoop rejects a free-function stripper (must be a trait impl method)", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_fake_launder.yoop");
    assert.ok(
      errors.some((e) => /would strip kind 'tainted'.*only an impl method of trait 'Cleansable'.*a free function is not authorized/.test(e.message)),
      `expected fake-launder error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("clearance_fake_confer.yoop rejects a free-function conferrer (must be a trait impl method)", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_fake_confer.yoop");
    assert.ok(
      errors.some((e) => /would confer kind 'cleared'.*only an impl method of trait 'Cleansable'.*a free function is not authorized/.test(e.message)),
      `expected fake-confer error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // S1 + S2 (plans/strings-ownership-and-ergonomics.md): the `owned` marker
  // kind, and the conferred-passthrough rule that makes it usable.
  //
  // No trackHeap assertion here on purpose: a string's storage comes from a
  // direct @malloc rather than through ctxAlloc, so the counter sees the
  // frees and not the allocations. Routing that through the context is S4.
  it("owned_string.yoop: passthrough, plain-slot flow, and strFree", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/owned_string.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "built [hello, world]\n" +
        "forwarded [hello, world]\n" +
        "borrowed [hello, world] eq=1\n" +
        "pad [0007] [longer]\n" +
        "raw [hi]\n",
    );
  });

  it("owned_free_literal.yoop rejects freeing a literal and a marker-dropping binding", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/owned_free_literal.yoop");
    const hits = errors.filter((e) =>
      /parameter 's' of 'str.strFree' requires kind 'owned'/.test(e.message),
    );
    assert.equal(
      hits.length,
      2,
      `expected both strFree calls rejected, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("owned_forge.yoop rejects minting `owned` from a literal, incl. one forged path", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/owned_forge.yoop");
    assert.ok(
      errors.some((e) => /function 'fake' would confer conferred kind 'owned'/.test(e.message)),
      `expected fake-forge error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
    // The mixed-path case is the one passthrough must NOT let through:
    // laundered on one branch, forged on the other.
    assert.ok(
      errors.some((e) => /function 'sneaky' would confer conferred kind 'owned'/.test(e.message)),
      `expected mixed-path forge error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // Markers traversing generic type arguments and switch-case payload
  // bindings. A fallible constructor hands its owned value back inside a
  // `Result`, so the marker has to be kept per-POSITION and then handed to
  // the right payload binding when a `switch` destructures it.
  it("owned_payload.yoop: markers survive Result<owned T, E> and its destructuring", async () => {
    const { stdout, exitCode } = await runFixture("examples/pass/owned_payload.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "slice [hello]\ntail [world]\nheld [held!]\n");
  });

  it("owned_payload_forge.yoop rejects every route into a payload position", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/owned_payload_forge.yoop");
    const msgs = errors.map((e) => e.message).join(" | ");
    // Forged into a generic type argument, and into a concrete payload field.
    assert.ok(
      errors.some((e) => /payload field 'value' requires kind 'owned'/.test(e.message)),
      `expected generic type-argument forge rejected, got: ${msgs}`,
    );
    assert.ok(
      errors.some((e) => /payload field 'text' requires kind 'owned'/.test(e.message)),
      `expected concrete payload-field forge rejected, got: ${msgs}`,
    );
    // The Err payload is a plain string, so freeing it is not allowed, and a
    // violation inside a switch ARM is caught at all - kindFlow read
    // `stmt.value`/`stmt.cases`, which a SWITCH_STATEMENT does not have, so
    // arm bodies used to go unwalked entirely.
    const sinkHits = errors.filter((e) =>
      /parameter 's' of 'str.strFree' requires kind 'owned'/.test(e.message),
    );
    assert.equal(sinkHits.length, 2, `expected both in-arm sinks rejected, got: ${msgs}`);
  });

  it("disposable_const_assign.yoop rejects both rebinding and field assignment on a bare `disposable`", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/disposable_const_assign.yoop");
    const msgs = errors.map((e) => e.message).join(" | ");
    assert.ok(
      errors.some((e) => /cannot assign to field of const "b"/.test(e.message)),
      `expected field-assign rejection, got: ${msgs}`,
    );
    assert.ok(
      errors.some((e) => /cannot assign to const "b"/.test(e.message)),
      `expected rebind rejection, got: ${msgs}`,
    );
  });

  it("clearance_clearedby_on_conferred.yoop rejects clearedBy on a non-restrictive kind", () => {
    const { errors } = typecheckFixtureProgram("examples/fail/clearance_clearedby_on_conferred.yoop");
    assert.ok(
      errors.some((e) => /clearedBy only applies to restrictive marker kinds/.test(e.message)),
      `expected clearedBy-polarity error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });
});

// testing-via-kinds: the test harness. These drive the driver itself as a
// subprocess rather than calling compileEntry, because the thing under test IS
// the driver's --test mode: discovery, the synthetic entry module, the
// temp-dir executable, and the exit code. See plans/testing-via-kinds.md.
describe("e2e: --test mode runs *.test.yoop suites through std/test.yoop", { concurrency: E2E_CONCURRENCY }, () => {
  // These are the deepest process trees in the suite and the ones most worth
  // getting right: node runs the driver, the driver runs clang, and then the
  // driver RUNS THE COMPILED TEST BINARY with inherited stdio. spawnSync's
  // `timeout` killed the node in the middle of that and left the other two
  // running - and because the binary still held the inherited pipe, spawnSync
  // itself did not even return. runProc kills the whole group instead.
  async function runTestMode(relDir, extraArgs = []) {
    const result = await runDriver([
      "--test", path.join(repoRoot, relDir), ...extraArgs,
    ]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
  }

  function runDriver(args) {
    return runProc(process.execPath, [path.join(repoRoot, "src/yoopiler.js"), ...args], {
      cwd: repoRoot,
      timeout: 120000,
    });
  }

  it("runs every suite in a passing test module and exits 0", async () => {
    const { stdout, exitCode } = await runTestMode("examples/testing/pass");
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}\n${stdout}`);
    // TAP: one line per case, in declaration order, grouped by suite.
    assert.match(stdout, /# strange_add\.test\.yoop:addsStrangelyWhenFirstIsTwoModFive/);
    assert.match(stdout, /^ok 1 - adds an extra 1 when a % 5 == 2$/m);
    assert.match(stdout, /^ok 2 - still adds the extra 1 at 7$/m);
    assert.match(stdout, /^ok 3 - adds plainly when a % 5 is not 2$/m);
    assert.match(stdout, /^1\.\.3$/m);
    assert.match(stdout, /# 3 passed, 0 failed/);
  });

  it("reports the detail string on failure and exits with the failure count", async () => {
    const { stdout, exitCode } = await runTestMode("examples/testing/fail");
    assert.equal(exitCode, 2, `expected exit 2 (two failures), got ${exitCode}\n${stdout}`);
    assert.match(stdout, /^ok 1 - passes$/m);
    assert.match(stdout, /^not ok 2 - fails with detail$/m);
    // `detail` is reported only on failure, indented under its case.
    assert.match(stdout, /^ {4}n was 2, which is not 10$/m);
    assert.match(stdout, /^not ok 3 - fails with no detail$/m);
    // ...and a case that set no detail gets no blank indented line.
    assert.doesNotMatch(stdout, /^ {4}$/m);
    assert.match(stdout, /# 1 passed, 2 failed/);
  });

  it("filters suites by a name substring passed after the path", async () => {
    const { stdout, exitCode } = await runTestMode("examples/testing/pass", ["addsPlainly"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /^ok 1 - adds plainly when a % 5 is not 2$/m);
    assert.doesNotMatch(stdout, /adds an extra 1/);
    assert.match(stdout, /# 1 passed, 0 failed/);
  });

  it("leaves no executable behind in the source tree", async () => {
    await runTestMode("examples/testing/pass");
    const strays = fs
      .readdirSync(path.join(repoRoot, "examples/testing/pass"))
      .filter((f) => !f.endsWith(".yoop"));
    assert.deepEqual(strays, [], `--test left files behind: ${strays.join(", ")}`);
  });

  it("runs a single test file directly, with no --test flag (the import.test; payoff)", async () => {
    // A test module has no `main`, so without the in-file flag this would be a
    // compile error rather than a test run.
    const result = await runDriver([
      path.join(repoRoot, "examples/testing/pass/strange_add.test.yoop"),
    ]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);
    assert.match(result.stdout, /# 3 passed, 0 failed/);
  });

  it("rejects a *.test.yoop that forgot import.test;", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_testmode_"));
    fs.writeFileSync(
      path.join(tmp, "unflagged.test.yoop"),
      'import { suite } from "std/test.yoop";\nsuite function nope(): void {}\n',
    );
    const result = await runDriver(["--test", tmp]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not declare 'import\.test;'/);
  });

  it("reports a suite signature mismatch at the suite, not inside generated code", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_testmode_"));
    fs.writeFileSync(
      path.join(tmp, "badsig.test.yoop"),
      'import.test;\nimport { suite } from "std/test.yoop";\nsuite function nope(n: int32): void {}\n',
    );
    const result = await runDriver(["--test", tmp]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /carries kind 'suite' and must match/);
    // The generated entry's cascade must be suppressed - a diagnostic pointing
    // into source the user never wrote is worse than no diagnostic.
    assert.doesNotMatch(result.stderr, /yoopiler_generated_test_entry/);
    assert.match(result.stderr, /typecheck failed \(1 error\)/);
  });

  it("rejects a kind prefix whose kind is not enumerable into \"suites\"", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_testmode_"));
    fs.writeFileSync(
      path.join(tmp, "wrongkind.test.yoop"),
      'import.test;\nimport { disposable } from "std/core/kinds.yoop";\ndisposable function nope(): void {}\n',
    );
    const result = await runDriver(["--test", tmp]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot prefix a function declaration/);
  });

  // modules-folder: a module's tests ship inside the module directory.
  // `*.test.yoop` is excluded from a directory module's source files, so the
  // test file is its own module and imports the module under test by the same
  // "modules/math" path a consumer writes.
  it("runs a module's own tests from inside its modules/ directory", async () => {
    const { stdout, exitCode } = await runTestMode("examples/modules_demo");
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}\n${stdout}`);
    assert.match(stdout, /^ok 1 - mean of 1 and 2 rounds up to 2$/m);
    assert.match(stdout, /^ok 5 - snapping rounds each component to the nearest 10$/m);
    assert.match(stdout, /# 5 passed, 0 failed/);
  });
});

// modules-folder: the program-owned `modules/` import root, end to end.
// Unit coverage for the resolution rules themselves is in
// src/jsyoopdriver/moduleGraph.test.js; this is the "does a real program built
// this way compile, link and run" check. See plans/modules-folder.md.
describe("e2e: std/core/bytes lastIndexOfSeq", { concurrency: E2E_CONCURRENCY }, () => {
  // The loop condition was inverted, so the body never ran and every call
  // reported "not found". It failed SILENTLY - fs.dirName returned its own
  // input, i.e. a wrong answer with no error attached and a parent-walk that
  // never terminates.
  it("strings_last_index_of: finds the LAST match, incl. offset 0 and the tail", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/pass/strings_last_index_of.yoop");
    assert.equal(exitCode, 0);
    assert.match(stdout, /^last=5 first=0$/m);
    assert.match(stdout, /^atZero=0$/m);
    assert.match(stdout, /^multi=5 tail=5$/m);
    assert.match(stdout, /^absent=9 tooLong=2$/m);
    assert.match(stdout, /^dir=\/a\/bb parent=\/a$/m);
    // Documented, not desired: no separator means dirName returns its input.
    assert.match(stdout, /^noParent=\[plain\]$/m);
  });
});

describe("e2e: modules/ import root", { concurrency: E2E_CONCURRENCY }, () => {
  it("modules_demo: program uses modules/math, which uses modules/rounding", async () => {
    const { stdout, exitCode } = await runFixtureEntry("examples/modules_demo/main.yoop");
    assert.equal(exitCode, 0);
    assert.match(stdout, /^add:       \(13, 24\)$/m);
    assert.match(stdout, /^dot:       110$/m);
    assert.match(stdout, /^manhattan: 23$/m);
    // The subdependency doing real work: math delegates to rounding, so 13 and
    // 27 snap to 10 and 30 rather than truncating to 10 and 20.
    assert.match(stdout, /^snap:      \(10, 30\)$/m);
    assert.match(stdout, /^gcd:       6$/m);
    assert.match(stdout, /^lcm:       12$/m);
    assert.match(stdout, /^clamp:     10$/m);
    // Same story: mean([1, 2]) rounds to 2 instead of truncating to 1.
    assert.match(stdout, /^mean:      2$/m);
  });
});
