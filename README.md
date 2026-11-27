# Myriad API

The web API behind [Myriad](https://myriadclient.dev/): shared configs and the Myriad Library. A small TypeScript
service (Hono on Node 24, SQLite through Node's built-in `node:sqlite`), deployed on Coolify at
`https://api.myriadclient.dev`.

## Endpoints (v1)

| | |
|---|---|
| `POST /v1/configs` | Publish a shared config (the JSON a Myriad client builds, `ConfigShare` format 1). `201 {code, url, deleteKey}`. Anonymous, limited per address (10 an hour, 50 a day by default), 256 KiB at most. |
| `GET /v1/configs/:code` | The shared config with that code (`myriad_` and six letters or digits). Open to any origin, so the website can show it. |
| `DELETE /v1/configs/:code` | With `Authorization: Bearer <deleteKey>`: deletes it. Only the publisher has the key (the client keeps it); the server stores its hash. |
| `GET /health` | `{ok: true}` |

The server rebuilds every share from a whitelist (unknown fields dropped, types checked, lengths capped, colours hex
only) and never stores a value for a setting the client marked protected. See [SECURITY.md](SECURITY.md) for how the
API protects players, and how to report a problem.

## Running

```bash
npm install
npm run dev        # http://localhost:3000, database in data/myriad.db
npm test
```

A Myriad dev client talks to it with `-Dmyriad.api=http://localhost:3000` (and `-Dmyriad.site=http://localhost:3001`
for links to a local website).

## Deploying (Coolify)

A Dockerfile application from this repository, with a persistent volume at `/data`, the domain
`api.myriadclient.dev`, and port 3000. Environment (all optional):

| | |
|---|---|
| `SITE_URL` | the website, for share links (`https://myriadclient.dev`) |
| `UPLOADS_PER_HOUR`, `UPLOADS_PER_DAY` | publishing limits per client (10, 50) |
| `GLOBAL_UPLOADS_PER_HOUR` | publishing ceiling for everyone together (2000) |
| `READS_PER_MINUTE`, `MISSES_PER_MINUTE` | fetches per client, and how many may be codes that don't exist (120, 20) |
| `DELETES_PER_HOUR` | delete attempts per client (30) |
| `MAX_SHARE_BYTES` | largest share (262144) |
| `TRUSTED_PROXIES` | proxies in front that append to `X-Forwarded-For` (1 for Coolify's Traefik; 0 when nothing is in front) |

`TRUSTED_PROXIES` must match the deployment: too high and clients can forge their address past the limits, too low
and every client shares the proxy's. **Behind Cloudflare's proxy (orange cloud) and Coolify's Traefik, set it to 2.**
Then also allow only Cloudflare's addresses to reach the server directly (a firewall rule, or a Cloudflare Tunnel):
a request that skips Cloudflare could otherwise put an address of its choosing in the second-to-last place.

The API keeps a daily copy of its database in `/data/backups` (the last seven). That guards against bad writes, not
against losing the server: copy `/data/backups` off the server too.

## The Myriad Library

The Library (`src/library/`) lists addons Myriad has checked, for the client's Browse button and the website. The API
never signs a listing or a version: the maintainer's listing key and the public builder's version key do, and the API
accepts them only when the right key, certified by Myriad's root keys, signed them. It signs only the index (which
listings and versions are current) with the index key, every hour and on each change.

| | |
|---|---|
| `GET /v1/index.json` | the signed index (ETag, `max-age=300`) |
| `GET /v1/library/addons[/:id[/icon.png]]` | listings for the website |
| `POST /v1/github/webhook` | the Myriad Library GitHub App's events (HMAC checked, each delivery once) |
| `/v1/library/builds/:id[/started\|/result\|/source-token]` | the builders, each with its own token |
| `/v1/library/pending`, `/submissions/:id/accept\|reject`, `/approvals`, `/listings/:id/pause` | the maintainer (admin token; approvals carry their own signatures) |

Each part is off until its settings are set (tokens are given as SHA-256 hex hashes, so the server never holds them):

| | |
|---|---|
| `LIBRARY_INDEX_KEY` | `ed25519-private:...`, the index key (its certificate is posted to `/approvals`) |
| `LIBRARY_ADMIN_TOKEN_SHA256` | the maintainer's token, hashed |
| `LIBRARY_BUILDER_OPEN_TOKEN_SHA256`, `LIBRARY_BUILDER_CLOSED_TOKEN_SHA256` | the two builders' tokens, hashed |
| `GITHUB_WEBHOOK_SECRET` | the Library App's webhook secret |
| (none for the Library App) | its key lives only in the private builder; the API keeps no key to developers' repositories |
| `GITHUB_DISPATCH_APP_ID`, `GITHUB_DISPATCH_PRIVATE_KEY`, `GITHUB_DISPATCH_INSTALLATION_ID` | the private App that starts builder runs |
| `LIBRARY_BUILDER_OPEN_REPO`, `LIBRARY_BUILDER_CLOSED_REPO` | `MyriadClient/myriad-builder`, `MyriadClient/myriad-builder-private` |
| `MYRIAD_OWNER_ID` | GitHub's number for the MyriadClient organisation (its repositories may use Myriad's reserved ids) |
| `WEBSITE_DEPLOY_HOOK`, `WEBSITE_DEPLOY_TOKEN` | rebuild the website when listings change (at most every ten minutes) |
| `LIBRARY_SUBMISSIONS_PER_DAY` | releases one installation may submit a day (20) |
