# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's
[security advisories](https://github.com/MyriadClient/myriad-api/security/advisories/new) for this repository. We'll
answer within a few days and credit you in the fix unless you'd rather we didn't.

## How the API protects players

- **No cookies, and accounts only for invite-only addons.** A share is public to anyone with its code; only its
  publisher can delete it. Signing in (optional, from the game) proves a Minecraft account through Mojang's
  `hasJoined` check, so no password or Mojang token ever reaches the API. A session is a 256-bit token kept only as its
  SHA-256 hash, sent as a bearer token by the game (never a cookie), ended after 30 days unused or on sign-out.
- **Invite codes are made by the developer's tool and never sent**: the API keeps only their hash. Developer requests
  are signed with a key the listing names, valid for five minutes and only once. Redeeming is rate-limited and every
  failure answers the same.
- **Invite-only jars have no public address.** The API fetches them from the developer's private repository with a
  token for that repository alone, checks they're exactly the jar the listing key signed, and hands them only to
  accounts with a grant.
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
