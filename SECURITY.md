# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's
[security advisories](https://github.com/MyriadClient/myriad-api/security/advisories/new) for this repository. We'll
answer within a few days and credit you in the fix unless you'd rather we didn't.

## How the API protects players

- **No accounts, no cookies.** Nothing can be done in a visitor's name, so there's nothing to forge. A share is public
  to anyone with its code; only its publisher can delete it.
- **Delete keys** are 192 random bits, given to the publisher once. The server stores only their SHA-256 hash and
  compares in constant time.
- **No addresses stored.** Client addresses are used, in memory only, for rate limits, and forgotten.
- **Private settings never reach the server**: Myriad leaves out every setting an addon marks `protect()` before
  uploading. The server also drops any value sent for a setting marked protected.
- **Strict input.** A share is rebuilt from a whitelist: unknown fields are dropped, every field is type-checked and
  capped in length, nesting is limited, and colours (which the website uses in styles) must be hex, so a share can't
  make a viewer's browser load anything.
- **Limits** per client on publishing (and on publish attempts), reading, guessing codes, and deleting, plus a ceiling
  on publishing for everyone together. Behind the proxy, the client's address is the one the proxy appended to
  X-Forwarded-For; anything the client wrote there is ignored. IPv6 clients are limited per /64.
- **Hardening.** Security headers on every response (`default-src 'none'`, `nosniff`, no framing), generic errors
  (no stack traces), 10-second request timeouts, prepared SQL statements, and a container that runs as an
  unprivileged user that can write only the database volume.
