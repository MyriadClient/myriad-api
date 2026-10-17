# Myriad API

The web API behind [Myriad](https://myriadclient.dev/): shared configs for now, accounts later. A small TypeScript
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
and every client shares the proxy's.
