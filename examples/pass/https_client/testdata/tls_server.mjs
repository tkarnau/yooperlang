// A throwaway HTTPS server for the std/tls fixture.
//
// The peer is NODE on purpose. A TLS client tested only against itself proves
// almost nothing - the whole value is handshaking against an independent
// implementation that will reject us if we get the protocol wrong. Node is
// already required to run the test suite, so this costs no new dependency.
//
// Binds port 0 and prints the assigned port on stdout as `PORT <n>`, the same
// way the socket fixtures avoid agreeing on a fixed number and can therefore
// run concurrently.
//
// Usage:  node tls_server.mjs [requestsBeforeExit]

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const limit = Number(process.argv[2] ?? 0);

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(here, "server.key")),
    cert: fs.readFileSync(path.join(here, "server.pem")),
    // TLS 1.2 floor, matching what the shim asks for.
    minVersion: "TLSv1.2",
    ALPNProtocols: ["http/1.1"],
  },
  (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const payload =
        req.method === "POST" ? `tls-echo:${body}` : `tls-hello:${req.url}`;
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "close",
      });
      res.end(payload);
      served += 1;
      if (limit > 0 && served >= limit) {
        // Give the response time onto the wire before tearing down.
        setTimeout(() => server.close(() => process.exit(0)), 50);
      }
    });
  },
);

let served = 0;

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});

// A handshake the client got wrong should not take the whole suite down with
// an unhandled error event.
server.on("tlsClientError", (err) => {
  process.stderr.write(`tlsClientError: ${err.message}\n`);
});
