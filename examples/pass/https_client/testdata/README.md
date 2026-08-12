# Throwaway TLS test material

**These are test fixtures. The private keys here protect nothing and are
committed on purpose. Never use them for anything else.**

A checked-in private key is normally a bad smell, and it is worth saying
plainly why it is not one here: nothing authenticates with these, they are
trusted only by a test that explicitly points at `ca.pem`, and they exist so
the TLS suite can run offline with no network and no key generation at test
time. If you find yourself copying one of these files anywhere, stop.

## What is here

- `ca.pem` / `ca.key` - a self-signed CA. The fixture passes `ca.pem` to
  `tlsConfigWithCaFile`, which is the only reason the server is trusted.
- `server.pem` / `server.key` - a leaf issued by that CA, for
  `DNS:localhost` and `IP:127.0.0.1`. Both SANs matter: the fixture dials
  `127.0.0.1`, and an IP is checked against the iPAddress SAN rather than
  the dNSName one.
- `tls_server.mjs` - a Node HTTPS server using the leaf. Binds port 0 and
  prints `PORT <n>`, so the test can run concurrently with everything else.

The peer is Node rather than another copy of our own client on purpose: a TLS
client tested only against itself proves almost nothing.

## Expiry

Both certificates are dated 100 years out, so this does not become a
mysterious CI failure in a year. If they ever do need reissuing, from this
directory:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem \
  -days 36500 -subj "/CN=yoop-test-ca" \
  -addext "basicConstraints=critical,CA:TRUE"

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
  -subj "/CN=localhost"

printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.pem -days 36500 -extfile ext.cnf
rm -f server.csr ca.srl ext.cnf
```
