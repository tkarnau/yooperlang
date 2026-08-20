# counter_server

A small HTTP API in Yooperlang, built to be stress tested in a container.
One endpoint increments a counter and reports the average requests per
second over the last minute.

This is a proof of concept, not a product. It exists to find out what the
language and its stdlib do under sustained concurrent load, and it found
several things (see "What this shook out").

## Endpoints

- `GET /count` - records a hit, returns the JSON below
- `GET /stats` - the same JSON, records nothing
- `GET /healthz` - `{"status":"ok"}`
- anything else - 404 naming the requested path

`/stats` deliberately does not count itself, so polling it during a run
does not inflate what you are measuring.

```json
{
  "count": 20000,
  "rps": 1538.54,
  "windowSeconds": 13,
  "uptimeSeconds": 12,
  "connectionsOpen": 1,
  "connectionsTotal": 20008,
  "workers": 2,
  "cpus": 14,
  "rssBytes": 23359488
}
```

`count` is exact. It is a single atomic add, so it is correct no matter how
many worker threads are answering requests, and after a load test it should
equal the generator's completed-request total exactly. A gap means requests
that never reached a handler.

## Run it

Locally, from the repository root, where `node scripts/seed.mjs` prints the path
of a compiler:

```sh
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) examples/playground/counter_server/main.yoop -o counter_server
./counter_server                # 0.0.0.0:8080, one worker per core
./counter_server 9000           # port
./counter_server 9000 4         # port, worker count
```

In Docker, from the repo root. [Dockerfile](Dockerfile) builds the program with
a compiler that is not in this tree, so this path does not work as written; the
local build above does:

```sh
DF=examples/playground/counter_server/Dockerfile
docker build -f "$DF" -t counter_server .
docker run -d -p 8080:8080 --cpus=2 --memory=256m counter_server 8080 2
```

That builds the default `slim` (distroless) image. `--target full` gets you
a shell and a working HEALTHCHECK at 4x the size; see "Deploying" below.

Or with compose, which sets the CPU limit and worker count together:

```sh
docker compose -f examples/playground/counter_server/docker-compose.yml up --build
```

## Deploying to a cloud box

Nothing here is provider-specific; it is an ordinary Linux container. Two
images come out of the same Dockerfile:

- default (`slim`): distroless, 8.1MB over the wire, no shell, no
  HEALTHCHECK
- `--target full`: bookworm-slim plus curl, 31.6MB, self-reporting
  HEALTHCHECK and a shell for `docker exec`

### The architecture trap

**If you are on an Apple Silicon Mac and your server is x86, a plain
`docker build` produces an arm64 image.** `docker load` on the server
accepts it without complaint and the container then dies with
`exec format error`. Always pass `--platform`:

- Hetzner **CX / CPX / CCX** (Intel/AMD) -> `--platform linux/amd64`
- Hetzner **CAX** (Ampere ARM) -> `--platform linux/arm64`
- AWS **t4g / m6g / c6g / c7g** (Graviton) -> `--platform linux/arm64`
- AWS **t3 / m5 / c5** (Intel/AMD) -> `--platform linux/amd64`

Docker Desktop runs the x86 build under Rosetta, so cross-building costs
seconds rather than the minutes QEMU would. Graviton is arm64, so from an
Apple Silicon Mac that one is native.

### One command

```sh
cd examples/playground/counter_server

./deploy.sh root@YOUR_IP                # x86 box, 2 workers, port 8080
./deploy.sh root@YOUR_IP arm64 4        # ARM box, 4 workers
./deploy.sh root@YOUR_IP amd64 2 80     # publish on port 80
```

It builds for the right platform, pipes the image over ssh, restarts the
container with a restart policy and an fd limit, waits for `/healthz`, and
prints `/stats`. The server needs Docker and nothing else:

```sh
ssh root@YOUR_IP 'curl -fsSL https://get.docker.com | sh'
```

Three environment overrides exist for hosts that are not root-over-plain-ssh:

- `SSH_OPTS` - extra ssh flags, e.g. `-i ~/.ssh/key.pem`
- `DOCKER_SUDO=sudo` - when the remote user is not in the `docker` group
- `PUBLIC_HOST` - the address to poll, when the ssh target is a config alias

### AWS EC2 (t4g and friends)

Graviton is arm64, so from an Apple Silicon Mac the build is native.

```sh
# Amazon Linux 2023
ssh -i key.pem ec2-user@YOUR_IP \
    'sudo dnf install -y docker && sudo systemctl enable --now docker'

# Ubuntu
ssh -i key.pem ubuntu@YOUR_IP 'curl -fsSL https://get.docker.com | sudo sh'

cd examples/playground/counter_server
SSH_OPTS="-i key.pem" DOCKER_SUDO=sudo \
    ./deploy.sh ec2-user@YOUR_IP arm64 2 80
```

Drop `DOCKER_SUDO` once you have run `sudo usermod -aG docker $USER` **and
reconnected** - group membership does not apply to the session that granted
it, which is the usual reason the second deploy still needs sudo.

Then add an inbound rule for your port to the instance's **security group**.
That is the AWS equivalent of Hetzner's Cloud Firewall and it denies inbound
by default.

### t4g is burstable, which will distort a stress test

This is worth understanding before you read any number off a `t4g.small`.
T-series instances are not "2 vCPUs you can use". They earn CPU credits at a
fixed rate and spend them when they exceed a **baseline** (20% per vCPU for
`t4g.small`). A sustained load test spends credits far faster than it earns
them, and then one of two things happens:

- **standard mode** - you get throttled to baseline. Throughput falls off a
  cliff mid-run, which looks exactly like a server problem and is not one.
- **unlimited mode** - you are billed for surplus credits instead of being
  throttled. T4g **defaults to unlimited**, so a long run can quietly cost
  money rather than visibly slowing down.

Neither is what you want when the question is "how fast is the server". So:

- Keep runs **short** (30 to 60 seconds) and watch for the cliff. If
  throughput is flat for the whole run, you stayed inside your credit
  balance and the number is real.
- Watch `CPUCreditBalance` in CloudWatch alongside the run.
- Decide the mode deliberately rather than inheriting it. Standard mode caps
  the bill; unlimited mode caps the surprise.
- When you want a number you can quote, use a **non-burstable** instance -
  `c7g.medium` is the same Graviton family with no credit system. Not free
  tier, but it is cents per hour and you can terminate it afterwards.

On free tier eligibility: AWS restructured its free tier during 2025 and the
`t4g.small` free-trial promotion has been extended more than once. Check the
Billing console for what your account actually has rather than trusting any
write-up, this one included.

`t4g.small`'s 2 GiB of RAM is not a concern either way - the server sits
around 25MB resident under load.

### The same thing by hand

```sh
DF=examples/playground/counter_server/Dockerfile
docker build --platform linux/amd64 -f "$DF" -t counter_server .
docker save counter_server | ssh root@YOUR_IP 'docker load'
ssh root@YOUR_IP 'docker run -d --restart unless-stopped -p 80:8080 \
    --cpus=2 --memory=256m --ulimit nofile=65535:65535 \
    counter_server 8080 2'
```

`docker save | ssh docker load` avoids standing up a registry. At 8.1MB
that is quick enough to repeat; move to GHCR or Hetzner's registry when you
want rollbacks or more than one box.

Three things to get right:

- **Pass the worker count explicitly.** `--cpus=2` does not change what
  `cpuCount()` reports, so the default would spawn one worker per HOST core
  to contend over two cores' worth of quota.
- **Open the port.** Hetzner Cloud Firewall defaults to blocking inbound,
  and so does `ufw` if you enabled it.
- **Raise the fd limit** if you plan to push past a few thousand concurrent
  connections. A parked connection here costs a coroutine frame rather than
  a thread, so file descriptors run out well before memory does. The
  compose file sets `nofile` to 65535; the `docker run` line above does not.

## Stress testing

```sh
cd examples/playground/counter_server

./stress.sh                          # localhost:8080, 30s, 50 connections
./stress.sh http://YOUR_IP 60 200    # url, seconds, connections
```

The script prefers `oha`, `wrk`, `bombardier` or `hey` and falls back to
`ab`. That order matters: **`ab` speaks HTTP/1.0**, so it opens a fresh
connection per request and spends much of the run on connection setup.
Install one of the others before drawing conclusions:

```sh
brew install oha          # macOS
apt-get install -y wrk    # Debian/Ubuntu
```

### Where you run the generator decides what you measure

The generator is a CLIENT. It goes on whatever machine drives the load,
never in the image, and the choice of machine changes the meaning of the
number more than any flag does:

- **Your laptop, over the internet, to the server.** Measures the path, not
  the server. At a 100ms round trip, 200 connections tops out near 2k req/s
  no matter how fast the server is. Fine as a smoke test, worthless as a
  throughput figure.
- **On the server itself, against `localhost`.** Removes the network, but
  the generator now competes for the same vCPUs as the thing it is
  measuring, so the result is a floor rather than a ceiling. Still useful
  for confirming concurrency works under real load.
- **A second box in the same datacenter.** The only one of the three that
  measures the server. Same-location private networking, no CPU contention;
  a throwaway instance for the duration of the test is cheap.

Whichever you pick, `count` in `/stats` should exactly equal the
generator's completed-request total. That is the check that says the number
is real.

Measured on an M-series laptop, for calibration rather than as a claim:

- native, 50 connections, `ab` (no keep-alive): about 35k req/s
- in Docker with `--cpus=2`, same load: about 16k req/s
- single keep-alive connection via `curl`: about 17k req/s, generator-bound

## How the rate window works

A 60-slot ring, one slot per second, indexed by `second % 60`. Each slot
records which second it is holding, so a slot whose second has rolled over
is reset the first time it is touched. There is no background timer and no
sweep; the cost is one modulo and two atomic adds per request.

`windowSeconds` is how much history the average actually covers. Before the
server has been up a full minute it is the uptime, not 60, because dividing
a 10-second-old server's hits by 60 reports a rate six times too low right
when you are watching a load test ramp.

Two deliberate imprecisions, both bounded:

- The per-second slots are not exact. Two workers crossing a second
  boundary together can both reset a slot and drop one sample. That is at
  most one sample per boundary, so at most about 60 out of however many
  requests a minute holds, and it only ever perturbs `rps`. Making it exact
  would cost a compare-and-swap on the hot path of a number that is an
  estimate by construction. (`counterCas` in `std/runtime.yoop` is there if
  you want it.)
- A burst confined to one second leaves the window all at once rather than
  decaying, because it lives in one slot. Finer granularity means more
  slots, not a different algorithm.

## Design notes

**A task per connection, not `http.serve`.** `std/http`'s `serve` awaits
each connection to completion before accepting the next. One client that
opens a keep-alive connection and goes idle stalls every other client, and
every load generator opens N keep-alive connections, so a stress test
against it would measure one connection. `acceptLoop` in `main.yoop` spawns
a task per connection instead. Each task suspends rather than parking its
worker, so a worker interleaves many connections.

**Worker threads share memory; this is not Node's `cluster`.** Node forks
processes with private heaps and makes you do IPC. Yoop's pool is threads
in one address space, so the route table and the metrics struct are
genuinely shared and there is no per-worker duplication, but a plain
`counter += 1` from two workers loses updates. `std/runtime.yoop`'s
`Counter` is an atomic cell for exactly that; `Metrics` uses it.

**Pool size is chosen in source.** `rt.setWorkerCount(n)` at the top of
`main`, before the first task spawns the pool. It overrides
`YOOP_NUM_WORKERS`.

**`cpuCount()` inside a container reports the HOST's cores.** `--cpus=2` on
a 16-core box still reports 16, so the default of one worker per core would
spawn 16 workers to contend over two cores' worth of quota. Pass the worker
count explicitly whenever you cap CPU. The `cpus` field in `/stats` is the
raw number so you can see the discrepancy.

**One worker is a real choice.** Tasks still multiplex over it through the
async I/O path, so thousands of concurrent connections still work, and
every shared counter stops needing synchronization. Try `./counter_server
8080 1` against the stress script before assuming more threads is faster.

## Compiler and stdlib notes

Six things this program leans on, and what goes wrong without them.

**Three codegen properties, each with a regression fixture under
`examples/pass/`:**

1. A mutable module-level array literal must not get a read-only backing
   buffer. With the fat pointer behind `let xs: int32[] = [0, 0, 0];`
   pointing at a `private unnamed_addr constant`, the first `xs[i] = v`
   segfaults with no diagnostic. `emitRawArrayGlobal` emits `private global`
   for a `LET_DECL` and keeps the merged read-only form for `CONST_DECL`,
   where it is correct. (`unnamed_addr` is the second half: it lets the
   linker merge two same-valued buffers, so two independent mutable arrays
   would alias.)
2. A module-level binding initialized by a generic intrinsic call.
   `let xs: T[] = intr.heapAlloc(n);` at module scope reaches
   `lowerFunction` with a null AST and takes down the whole compile with a
   `TypeError` unless the folder declines. A compiler intrinsic has no yoop
   body to fold, so `genericInstanceResolver` declines and the decl falls
   back to the runtime-init path.
   (`module_level_mutable_array.yoop` covers both.)
3. A `ref T` binding passed BARE to a `ref T` parameter has to forward the
   pointer, not pass the pointee by value. Otherwise the callee reads the
   struct's first field as an address: a silent segfault with no diagnostic.
   The typechecker allows the bare spelling on purpose (an FFI handle in
   `let w: ref Window` reaches the next call without a redundant `ref w`)
   and marks the argument `passRefBinding`; both expression emitters in
   codegen check that flag before the ordinary auto-deref path. It matters
   here: `acceptLoop` hands a `ref Metrics` to a task.
   (`ref_forwarding.yoop`.)

**One papercut, called out and not fixed:** a local named `t0` collides with
codegen's `%tN` temporary namespace and fails at the LLVM level with
"multiple definition of local value named 't0'". It is a compile-time error
rather than a miscompile, and the fix is a mangling change with a wide blast
radius, so it is called out in `runtime_introspect.yoop` and left alone.

**One `std/http` limitation, documented and worked around:** `serve` is
serial, as described above. `serveConnection` is exported so a caller can
write its own concurrent accept loop. Making `serve` itself spawn tasks
would be the real fix, and it is a much larger change.

**One runtime helper that is easy to miss:** `yoop_stdout_linebuf` in
`runtime/yoop_args.c`. Without it stdout is fully buffered when it is a
pipe, which is what it is under `docker logs`, so a server's startup banner
sits in a 4KB buffer and the container looks hung. Exposed as
`rt.lineBufferStdout()`.

## What this uses from `std/runtime.yoop`

- `cpuCount()`, `workerCount()`, `setWorkerCount(n)` - pool sizing from
  source rather than only from `YOOP_NUM_WORKERS`
- `Counter` plus `counterInc` / `counterAdd` / `counterSub` / `counterGet` /
  `counterSet` / `counterCas` - atomic 64-bit cells, laid out inline in
  whatever struct owns the thing being counted
- `rssBytes()` - resident memory, the number a container limit is enforced
  against (0 on Windows, which would need PSAPI linked)
- `monotonicNs()`, `lineBufferStdout()`

## Known limits

- No TLS. Put it behind a reverse proxy if it needs to be public.
- No graceful shutdown. `SIGTERM` kills in-flight connections.
- `/stats` is unauthenticated and exposes RSS and connection counts.
- The counter is in memory only. A restart resets it.
- The 404 fallback echoes the requested path back, which is fine here and
  is a reflected-content decision worth revisiting for anything real.
