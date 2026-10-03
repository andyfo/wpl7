# Local development (macOS + Docker Desktop)

Everything — including the dev-subdomain + go-live flow and outbound mail — is exercisable locally.
`*.localtest.me` publicly resolves to 127.0.0.1, so no /etc/hosts editing is ever needed.

## Full stack in Docker

```bash
cd deploy
cp .env.example .env
```

Set in `.env`:

```
TLS_MODE=none
SRV_ROOT=/Users/<you>/wpl7-dev/srv        # macOS cannot use /srv
PANEL_DOMAIN=panel.localtest.me
DEV_DOMAIN=dev.localtest.me
MARIADB_ROOT_PASSWORD=devroot
PANEL_SESSION_SECRET=$(openssl rand -hex 24)
PANEL_ADMIN_PASSWORD=devdevdevdev
```

Then:

```bash
mkdir -p $SRV_ROOT
docker build --build-arg PHP_TAG=php8.3 -t wpl7-wordpress:php8.3 wordpress-image   # pre-build (optional; panel builds on demand)
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.build.yml up -d --build
```

`docker-compose.build.yml` is what puts `build:` on the panel service. The base file pulls
the released image, because that is what a server does; locally you want the code in front
of you, so the overlay is not optional here. On a server `provision/compose.sh` adds it for
you whenever `.env` says `WPL7_SOURCE=build`.

- **Panel**: <http://localhost:3000> (dev mode bypasses Traefik for the panel)
- **Sites**: `http://<name>.dev.localtest.me` (through Traefik on port 80)
- **Mail**: Mailpit replaces postfix and catches every `wp_mail()` — UI at <http://mail.localtest.me>.
  Mailpit speaks no milter protocol, so the DKIM signer is switched off locally and the panel's
  Mail page has no traffic to show (it parses postfix's log). Signing, the traffic view and the
  queue are production-only; the deliverability checks work anywhere, since they read public DNS.
  Sites still authenticate with their own login (Mailpit is configured to accept any), but it
  enforces nothing — **sender authorization is production-only too**, and the panel logs one line
  saying so at boot. To exercise it, run the real `boky/postfix` relay instead of the dev override.
- **Networks**: each site gets `wpl7_site_<name>` and cannot reach any other site or the panel, exactly
  as in production. `docker network ls | grep wpl7_` after creating a couple of sites; a redeployed
  Traefik is re-attached by the panel within a minute (docs/architecture.md → Networks).
- Go-live rehearsal: use any `*.localtest.me` name as the "production" domain, e.g. `myshop.localtest.me`.

**Ports 80/3000 already taken** (LocalWP, another dev server…)? Add the third override, which remaps
the edge to :8177 and the panel to :3177:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.build.yml -f docker-compose.ports.yml up -d
```

Panel: <http://localhost:3177>. Site URLs are still generated portless, so browse sites either via
`http://<name>.dev.localtest.me:8177` (WordPress may canonical-redirect to the portless URL) or with an
explicit Host header: `curl -H 'Host: <name>.dev.localtest.me' http://127.0.0.1:8177/`.

Enable VirtioFS in Docker Desktop for acceptable bind-mount performance.

## Panel code development (fast iteration, no panel container)

```bash
cd panel
npm install
npm run dev        # tsx watch on :3000 + Vite dev server on :5173 (proxies /api)
npm test           # vitest suite (no Docker needed)
npm run typecheck
```

Point the dev panel at the dockerized traefik/mariadb/mail by exporting the same env the compose file
sets (`SRV_ROOT`, `TLS_MODE=none`, `DEV_DOMAIN=dev.localtest.me`, `MARIADB_ROOT_PASSWORD=devroot`, …) —
but note MariaDB is on an internal network by design; for direct-from-host DB access add a temporary
port publish to the mariadb service in a local override. The test suite plus the dockerized panel cover
most workflows without that.

## Exercising offsite backups locally

Offsite copies talk to a real endpoint, so the way to try them is to run one. MinIO gives you S3 on
your own machine:

```bash
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=wpl7 -e MINIO_ROOT_PASSWORD=wpl7-dev-secret \
  minio/minio server /data --console-address ':9001'
docker run --rm --network host --entrypoint sh minio/mc -c \
  'mc alias set local http://127.0.0.1:9000 wpl7 wpl7-dev-secret && mc mb -p local/wpl7-backups'
```

Then in the panel, **Backups → Storage → Add remote destination → S3-compatible storage**:

| Field | Value |
|---|---|
| Vendor | MinIO / other |
| Endpoint | `http://host.docker.internal:9000` (the rclone container has to reach it, not your browser) |
| Access key ID / Secret | `wpl7` / `wpl7-dev-secret` |
| Bucket | `wpl7-backups` |

**Test connection** should show four green checks. Then walk the whole path: take a manual backup and
watch the `backup.offsite` job on the Jobs page, set the site's local retention to 1 and run the
maintenance tick so the older backup becomes *offsite only*, **Fetch back** one of those, and restore
it. `mc ls -r local/wpl7-backups` shows the remote tree at every step.

For FTP/FTPS, `docker run -d -p 21:21 -p 21000-21010:21000-21010 -e FTP_USER=wpl7 -e FTP_PASS=wpl7
garethflowers/ftp-server` is the smallest thing that works; point the destination at
`host.docker.internal` with TLS set to **None** (a local test server has no certificate) and confirm
the form warns you that plain FTP is cleartext.

## Multi-server locally

Single-server local dev is unchanged — everything above works as before. Exercising the multi-server
features (add server, move site) needs a second machine, because a worker is a real host reached over
SSH: use a Lima/Multipass VM or a throwaway VPS, run `provision/setup.sh --role=worker` on it yourself,
and register it via **Servers → Add server → "Already provisioned"** (the manual path in
docs/multi-server.md). The panel-driven "Blank VPS" path assumes a fresh Ubuntu 26.04 image, so it is
easiest to rehearse on a disposable cloud VM.

## Testing real ACME (staging)

On a throwaway cloud VM with real DNS: `TLS_MODE=staging`, `ACME_RESOLVER=letsencrypt-staging` in
`.env`, run `provision/setup.sh`, create a site, check the staging cert issues, then flip both values to
production. Never point production LE at a box you are still rebuilding repeatedly.
