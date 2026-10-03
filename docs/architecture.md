# Architecture

```
Internet ──▶ Traefik v3 (:80/:443, Let's Encrypt, Docker-label routing)
              ├─▶ wp-<slug>   one per site: wpl7-wordpress:php8.x (wordpress:apache + msmtp + wp-cli)
              └─▶ wpl7-panel   Node/TS API + React UI (admin domain)
wp-<slug>, panel ──▶ wpl7-mariadb (mariadb:11.4, per-site DB + user)     wpl7_db network (internal)
wp-<slug> ──mail()──▶ wpl7-mail (postfix queue, alias "mail") ──DKIM──▶ wpl7-dkim ──▶ smarthost or direct MX
wpl7-panel ──▶ /var/run/docker.sock (container lifecycle) + /srv (files, backups)

Each wp-<slug> lives on its own network with Traefik, the relay and MariaDB — never with
another site, and never with the panel. See Networks below.
```

## Multiple servers

The diagram above is one server; a fleet is N of them under the panel on server 1. Workers run the
identical stack minus the panel (`docker-compose.worker.yml` overlay), and every site is fully local
to its server — files, database, mail, certificates. The panel reaches workers over **SSH only**
(pooled connection carrying both the remote Docker API and host commands as the `wpl7-panel` user),
with host keys pinned on first use. A `servers` table plus `sites.server_id` track placement; jobs
are serialized per server, and a site move occupies both its lanes. Provisioning and updates push the
panel's own baked bundle and re-run the idempotent `setup.sh`, so worker stacks are always at the
panel's revision. See docs/multi-server.md.

## Networks

| Network | internal | Members |
|---|---|---|
| `wpl7_proxy` | no | traefik, panel, mail, dkim — **no sites** |
| `wpl7_db` | yes | mariadb (alias `mariadb`), panel — **no sites** |
| `wpl7_site_<slug>` | yes | one site + traefik + mail (alias `mail`) + mariadb (alias `mariadb`) |
| `wpl7_egress` | no, ICC off | every site container — outbound internet only |
| `wpl7_ftp` | yes | the FTP gateway + the FTP file server of each site with logins (docs/ftp.md) |
| `wpl7_ftp_edge` | no, ICC off | the FTP gateway alone — the bridge its published ports are bound to |

The two FTP networks, and the containers on them, exist on a server only while one of its sites
has an FTP login; the panel creates and removes them (`services/ftp.ts`).

Fixed names matter: the panel creates site containers through the Docker API (outside compose) and
attaches them to these networks by name.

**Why one network per site.** Docker isolates *between* networks, not within them: on a shared
bridge every site container can open TCP to every other one. A single compromised site could
therefore reach its neighbours' Apache directly — bypassing Traefik, its TLS and its middlewares —
and reach the panel's port as well. Each site now gets `wpl7_site_<slug>`, whose only other members
are the infrastructure it must talk to. The aliases are repeated per endpoint because endpoints
created through the API do not inherit compose's; without them `WORDPRESS_DB_HOST=mariadb` and
msmtp's `host mail` stop resolving.

That network is `internal`, so it carries no route off the host — but WordPress needs the internet
for updates and wp.org plugin installs. `wpl7_egress` provides it and is shared, which would hand
back the lateral reach it just removed except that it is created with
`com.docker.network.bridge.enable_icc=false`: the kernel drops container-to-container traffic on
that bridge while leaving the route out intact.

**The compose problem.** Traefik, MariaDB and the relay are recreated by `docker compose up`, from a
file that knows nothing about networks created later — so a redeploy silently drops those endpoints
and with them every site's routing, database and mail (`HTTP 504` on every host). The panel repairs
the attachments at boot and every 60 seconds (`reconcileSiteNetworks`), at a cost of three container
inspections per server per tick regardless of site count.

**Density.** One bridge and one `/24` from Docker's address pool per site, plus an interface on
Traefik, MariaDB and the relay each. Comfortable into the dozens; past ~100 sites per server,
raise `default-address-pools` in `provision/daemon.json` and expect the host's bridge and iptables
tables to get large.

## Naming (all derived from the site slug, `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)

| Thing | Pattern | Example (`my-blog`) |
|---|---|---|
| Container | `wp-<slug>` | `wp-my-blog` |
| DB name & user | `wp_<slug with - → _>` | `wp_my_blog` |
| Traefik router/service | `wp-<slug>` | |
| Canonical-redirect middleware | `wp-<slug>-canonical` | |

Every managed container carries labels `wpl7.managed=true`, `wpl7.site=<slug>`, `wpl7.role=wordpress`,
`wpl7.php=<version>`, plus `traefik.docker.network=wpl7_site_<slug>` so Traefik — which is attached to
many networks — routes to the right endpoint rather than the egress one, where traffic is dropped.

| Thing | Pattern | Example (`my-blog`) |
|---|---|---|
| Site network | `wpl7_site_<slug>` | `wpl7_site_my-blog` |
| Mail relay login | `<slug>@wpl7` | `my-blog@wpl7` |
| FTP file server | `wpl7-ftp-<slug>` (labels `wpl7.role=ftp-files`, `wpl7.site=<slug>`) | `wpl7-ftp-my-blog` |

One FTP gateway per server, `wpl7-ftp` (label `wpl7.role=ftp-gateway`). Both kinds of FTP container
also carry `wpl7.spec`, a hash of everything they were created from: the panel recreates one whose
spec no longer matches.

## Filesystem (`SRV_ROOT`, default `/srv`)

```
/srv/sites/<slug>/wordpress/         bind → /var/www/html (uid/gid 33:33)
  …/wp-content/mu-plugins/wpl7-login.php   panel-managed drop-in (one-click login), written in the container
  …/.wpl7-upload-<id>.part / .wpl7-edit.*  Web FTP's temporary files (docs/web-ftp.md), never listed as content
/srv/sites/<slug>/config/uploads.ini bind → /usr/local/etc/php/conf.d/zz-site.ini:ro
/srv/sites/<slug>/config/msmtprc     bind → /etc/msmtprc:ro (this site's own relay login)
/srv/sites/<slug>/config/security-apache.conf  bind → /etc/apache2/conf-enabled/zz-wpl7-security.conf:ro
/srv/sites/<slug>/config/security/   bind → /etc/wpl7:ro - wp-config-extra.php (docs/security.md)
/srv/sites/<slug>/quarantine/        files moved out of the site (0700, uid 33); mounted into no site
/srv/sites/<slug>/site.json          panel-written manifest (disaster-recovery aid)
/srv/backups/<slug>/<ts>/            db.sql.gz + files.tar.gz + manifest.json + sha256sums
/srv/backups/panel/<ts>/             panel.db.gz + manifest.json + sha256sums (server 1 only)
/srv/plugins/                        uploaded plugin zips (mounted ro into every site)
/srv/mysql/                          MariaDB data
/srv/mail/policy/sender_login        which SASL login owns which sender domain
/srv/mail/policy/sasl_block          logins the relay currently refuses (abuse guard)
/srv/mail/sasl/sasldb2               the relay's credential database (one login per site)
/srv/mail/sasl2/smtpd.conf           bind → /etc/sasl2/smtpd.conf (Cyrus SASL config)
/srv/wpl7-ftp/gateway/               FTP gateway: sftpgo.json, users.json (argon2 hashes), host keys, certificate - 0600, uid 60021
/srv/wpl7-ftp/sites/<slug>/          that site's FTP file server: config, its one login, host key - 0600, uid 33
/srv/traefik/acme*.json              ACME material (chmod 600)
/srv/traefik/dynamic/                Traefik file-provider configs: move forwarding (move-<slug>.yml),
                                     each site's protection (sec-<slug>.yml), blocked addresses (wpl7-blocked.yml)
/srv/wpl7-firewall/                  the network layer's rules (wpl7.nft) and status, root only
/srv/wpl7-scan/<scan-id>/            a malware scan's input while it runs: the checksums it is handed
/srv/panel/panel.db                  panel state (SQLite, chmod 600)
/srv/panel/ssh/id_ed25519            the panel's fleet SSH key (server 1 only)
```

The panel container mounts `/srv` at the **identical path**: every path it computes is simultaneously a
valid host path, so bind mounts it passes to the Docker API always resolve (sibling-container rule).

The backup tree is the one part that can live elsewhere: each server has its own **backup location**
(`servers.backup_root`, default `${SRV_ROOT}/backups`), set in the panel. Worker servers accept any
absolute path immediately — the panel reaches their filesystem over SSH as root. Server 1 additionally
needs the directory mounted into the panel container at the identical path, which only compose can do:
`BACKUP_ROOT` in `.env` plus `deploy/docker-compose.backup-root.yml`, included automatically by
`provision/compose.sh`. Every backup row records the root it was written under, so a location change
never orphans what is already there — and so `rm -rf` on a backup can be checked against the root that
actually produced it (see [docs/backup-restore.md](backup-restore.md)).

## Site containers

Image `wpl7-wordpress:php<X.Y>` = official `wordpress:php<X.Y>-apache` + msmtp/msmtp-mta (PHP `mail()`
works) + wp-cli. Built locally from `deploy/wordpress-image/` (setup.sh pre-builds all offered versions;
the panel rebuilds on demand). WP-CLI operations run via `docker exec -u 33:33` inside the site container,
so PHP version and mail config always match the site.

Key env on each site container: `WORDPRESS_DB_*` (generated wp-config.php reads them at runtime) and
`WORDPRESS_CONFIG_EXTRA` containing the X-Forwarded-Proto→HTTPS fix (prevents redirect loops behind
Traefik's TLS termination), `DISABLE_WP_CRON` (the panel runs `wp cron event run --due-now` per site
every 5 minutes instead), and a `require_once` of `/etc/wpl7/wp-config-extra.php` - the site's protection
from inside (docs/security.md#inside-the-container), mounted read-only from a folder the panel rewrites
whole, so a change needs no new container. Its Apache side is the other read-only mount,
`zz-wpl7-security.conf`, rewritten in place (a single-file mount keeps its inode) and applied with
`apache2ctl -t` and a graceful reload. A container carries the label `wpl7.hardening=1` once it has
both; one without it is rebuilt by a `site.reconcile` the panel queues itself.

New sites lose WordPress's bundled plugins (Akismet, Hello Dolly) right after `core install`, and gain
one must-use plugin the panel maintains itself: `wpl7-login.php`, which spends the single-use tokens
behind **Log in to WordPress** (docs/site-lifecycle.md). It lives in the site directory rather than the
image because `/var/www/html` is a bind mount — the image's copy would be shadowed by it. The panel
writes it, and the license constants drop-in, from inside the container (below), owned by `www-data`.

### Site files: always from inside the container

Whatever opens individual files in a site's folder — the Files tab (docs/web-ftp.md), its API, the
panel's own drop-ins — does it with `docker exec` inside the site's container: as `www-data`, or as
root *in the container* for the two jobs that need it (handing root-owned files back, writing the
drop-ins). Whole-folder copies — backups, restores, moves — are still `tar` on the host, which stores
a symlink as a link and never follows one. The reason is symlinks: a compromised site can plant
one pointing at `/srv/sites/<another-site>/…` or at the panel's database. On the host, where the
panel is root and every site's files are uid 33, following it crosses the boundary; inside the
site's mount namespace, the same link resolves to nothing the site could not already reach. Docker's
archive API (`docker cp`) is not used for the same reason: it runs as root in the daemon and has had
symlink-race escapes of its own.

Root in the container is still a privilege the site must not be able to borrow — `www-data` owns the
tree and can swap any folder on the way for a link to `/etc`. So both root operations enter their
folder physically (`cd -P`, then `pwd -P` has to be exactly the expected path), change ownership only
of `.` or with `-h`, and the drop-in's actual write drops to `www-data` (`setpriv`) before it touches a
file.

FTP and SFTP logins (docs/ftp.md) keep the same rule by another road, since a session is
long-lived and cannot be an exec per file. Each site with logins gets its own SFTPGo **file server**
container: uid 33, a read-only root, no capabilities, and exactly one bind mount of site files -
its own folder - on an internal network. The public **gateway** container holds no site files at
all; each login's storage is SFTP to its own site's file server, with a key that file server alone
accepts and a host key the gateway pins. SFTPGo confines paths in userspace (resolve, then open),
which a site racing symlink swaps could in principle beat - but inside a file server there is no
other site to reach. Taking a login away rotates that site's gateway key, which recreates only its
file server: SFTPGo leaves a session open when its login changes, and a session holding the old key
is refused its next file. The gateway writes every upload under a temporary name and renames it into
place once complete; a file being replaced stays where it is until then. Upstream SFTPGo moves that
file aside for the whole transfer, so WPL7 runs its own build with that changed
(`deploy/sftpgo-image`).

The mechanics are in `panel/src/services/siteFiles.ts`: fixed shell scripts that take every path as a
positional argument, write through a temporary file and one rename (so nothing is ever half
written), refuse what the site's user may not do, and speak one exit code per refusal. Bodies are read
whole before an exec starts, so a slow client never holds one - or, on a remote server, one of its
eight SSH channels - open.

### Containment

A site container is built to be survivable when — not if — the WordPress inside it is compromised:

| | |
|---|---|
| Networks | its own + egress only; it cannot address another site or the panel |
| Capabilities | Docker's defaults minus `NET_RAW MKNOD SYS_CHROOT AUDIT_WRITE SETFCAP SETPCAP`. `NET_RAW` is the one that matters: with it, root in the container can forge packets and poison ARP caches on the bridges it shares |
| `no-new-privileges` | set, so the setuid binaries Debian ships (`su`, `mount`, `passwd`) cannot be used to escalate. wp-cli is unaffected — its uid comes from `docker exec -u 33:33`, which the daemon applies |
| CPU / memory / pids | per-site ceilings from Settings (default 2 cores, 512 MB, 512 pids), so one site cannot take the box down for its neighbours |
| Mail | its own SASL login; the relay refuses any sender domain owned by another site (docs/mail.md) |

These are applied when the container is **built** — except the CPU, memory and pids ceilings,
which saving them in Settings also changes on every existing site container in place
(`server.applySiteLimits`, one job per server, no restart). The one change Docker cannot make to
a live container is lifting a CPU cap, so setting CPU to 0 recreates each site instead (a site
busy with another job right then, once that job has run). Sites created before the rest of this
policy catch up via **Recreate container** (`site.reconcile`).

## Security

The whole of it is docs/security.md; the moving parts:

| Part | Where it runs | How |
|---|---|---|
| Site protection | Traefik on the site's server | one file per site, `sec-<slug>.yml`, with routers above the site's own label router - which stays as the fallback, so a missing or refused file only means the site is served as before. Written by `services/security.ts` when it changes, never otherwise: a rewrite resets every rate limiter |
| The visitor's own address | the panel | read from `ClientAddr` in Traefik's JSON access log, and from `Cf-Connecting-Ip`, `True-Client-Ip` or `Fastly-Client-Ip` only when the connection comes from a trusted proxy's ranges (`lib/clientIp.ts`). Traefik overwrites `ClientHost` from `X-Forwarded-For`, which anyone can send |
| Attack detection | the panel | sliding-window counters per address (IPv6 by /64) over every server's access log, read each minute with the visitor statistics (`services/attackDetector.ts`). Rebuilt from the last ten minutes of log after a restart |
| Blocked addresses | every server | `table inet wpl7` in nftables, at `prerouting` priority -310 - ahead of Docker's own forwarding - with allow sets first, then permanent and timed block sets; drops only `tcp dport {80, 443}`. Loaded by `wpl7-firewall` (`nft -c`, then one transaction), which refuses a file that touches any other table. Visitors behind a trusted proxy are refused by Traefik instead (`wpl7-blocked.yml`). The panel reaches server 1's host through `HostShell` and a worker over SSH with sudo (`servers/hostPort.ts`) |
| Malware scans | throwaway containers on the site's server | `--network none`, every capability dropped, `no-new-privileges`, a read-only root with a tmpfs, one CPU, a memory and pid ceiling, uid 33, and exactly one site's files mounted read-only. The check runs in the site's own image; AMWScan in its pinned image. Output is JSON lines, at most 500 findings, under the 1 MiB an exec or SSH read may return |
| Quarantine | a throwaway container as uid 33 | the site's files and its `quarantine/` folder mounted, nothing else: no path through a link is followed, the hash is checked before and after the copy |

## TLS

Traefik resolvers: `letsencrypt` (HTTP-01), `letsencrypt-staging` (testing), and — when `DNS_PROVIDER`
is configured (compose overlay `docker-compose.dns.yml`) — `letsencrypt-dns` issuing one wildcard cert
for `*.<DEV_DOMAIN>`, plus its `letsencrypt-dns-staging` twin. Pure dev-domain sites share the wildcard;
custom-domain sites always use HTTP-01. `ACME_RESOLVER` selects the CA for *all* of them: setting it to
`letsencrypt-staging` also switches the wildcard to the staging DNS-01 resolver, so nothing hits the
production CA. Note that `TLS_MODE` only chooses http vs https — it does not pick the CA.
Without a DNS provider each dev subdomain gets its own HTTP-01 cert (counts against Let's Encrypt's
50 certs/week per registered domain).

## Panel internals

Single Node 22 process: Fastify 5 REST API (+ per-admin accounts with session auth for the UI, each
optionally behind a TOTP second factor; Bearer API keys for external tools) serving the built React app; SQLite
(better-sqlite3 + drizzle) for state; a job queue executes
all Docker/MariaDB mutations — serialized per server (one running job each; a move occupies both its
source and target lanes) — writing step logs the UI polls. A job may instead take a **named lane**
(`jobs.lane`), orthogonal to the server lanes: offsite uploads run in `offsite:<serverId>`, so at most
one upload per server is in flight while that server's site operations carry on beside it; commands run
in a site (`wp.cli`, `site.shell`, `wp.rest`) take `exec:<serverId>` the same way, and the nightly housekeeping its
own `housekeeping` lane. Each job records how it was queued (`origin`, `created_by`, `schedule_id`):
the request's admin or API key, or the schedule, travels to `JobWorker.enqueue` in an
`AsyncLocalStorage` context (`src/jobs/actor.ts`) that a Fastify `onRoute` hook opens around every API
handler, so no enqueue call site passes it along. Everything recurring - scheduled backups, the nightly
housekeeping job, monitoring probes, WP cron ticks, the offsite reconciler, the WordPress inventory
scan and the custom schedules of `schedules` - goes through one runner in `src/jobs/schedulers.ts`,
which is where a pause holds, one run per task at a time is enforced and each run is recorded
(docs/jobs.md).

**Access levels and MCP.** Every endpoint in `shared/apiDocs.ts` — the catalog the API keys → Docs
tab renders, and a test checks against the route table — names the level it needs (Read only, Manage,
Full), and the auth gate (`src/plugins/auth.ts`) holds every request to it, deciding on the *matched*
route pattern, never the raw URL. The **MCP server** (`POST /mcp`, docs/mcp.md) is one more client of
the API rather than a second implementation of it: a tool call runs `app.inject()` into an `/api`
route inside an `AsyncLocalStorage` context naming the caller, its level and the tool
(`src/mcp/call.ts`), and the gate's `onRequest` hook reads that context — before the body is parsed
and before the public-route shortcut — to refuse an endpoint MCP may never reach, one that belongs to
another tool, or a level too low. No token or header carries the context, so nothing arriving from the
network can pass for a tool call. Validation, rate limits, the maintenance lock, job attribution
(origin `mcp`) and the activity log then apply unchanged. The OAuth sign-in apps like claude.ai use
(`src/services/oauth.ts`, `src/routes/oauth.ts`) is the panel's own authorization server, gated by
a connection window an admin opens; its approval page is a page of the app (`/oauth/authorize`),
because the strict session cookie is not sent on a navigation arriving from another site.

**Offsite copies** run [rclone](https://rclone.org) through the same ephemeral-container mechanism
database imports use (`DockerPort.runEphemeral`), on the server that holds the backup: the backup
directory is bind-mounted read-only, credentials arrive as environment variables of a container that
lives for one transfer, and the data goes straight from that machine to the destination. One binary
covers S3 and every S3-compatible vendor, SFTP, FTP/FTPS and WebDAV, so there is one integration
rather than one per provider, and a worker needs nothing installed. Which copies should exist is
reconciled every minute from `backup_copies` rather than triggered on backup creation, so a restart
mid-upload, a new destination and a re-enabled one all catch up by themselves.

The **WordPress inventory** is a third reconstructed view, and the only one that costs a `docker
exec`: `wp plugin list` deletes WordPress's update transient and re-asks api.wordpress.org, so it
takes seconds per site and cannot run on a page load. A scan job writes `site_wp_status` and
`site_wp_components` every `wpScanIntervalHours` (default 6), after every WordPress job, and on
demand; the site page and the fleet-wide bulk page read only SQLite. That job is deliberately
lane-less — read-only work must not park a server's queue — and it skips sites that already have a
job in flight. Installed versions are matched against `vuln_feed`, a per-slug cache of
wpvulnerability.net (24 h TTL, ~200 slugs for a whole fleet, matched locally with a port of PHP's
`version_compare` in `lib/wpVersions.ts`), so a newly published advisory changes every site's verdict
without re-reading a container. A bulk run is one `wp.bulkTask` job per site sharing a `batches` row,
which is what keeps the existing per-site and per-server guarantees. See docs/updates.md.

Two views are reconstructed from container logs on a one-minute tick rather than stored as they
happen: **mail traffic** from each server's postfix relay, and **visitor statistics** from each
server's Traefik access log (`--accesslog.format=json`, read back with `docker logs --since`).
Traefik is the only place that sees every request for every site with the real client address —
inside a site container, Apache records the proxy's address for every visitor on the box.

Visitor statistics are stored as hourly counters, never as a request log. A visitor is a truncated
hash of address + user agent under a salt that is regenerated nightly and mixed with the site slug,
so the same person is a new id the next day and one customer's numbers cannot be joined against
another's. Crawlers and the panel's own uptime probe are excluded by user agent and counted
separately, by name. Retention defaults to 90 days (`trafficRetentionDays`).

Two dimensions sit outside that anonymous core. **Countries** are resolved at ingest from the
regional internet registries' delegation files — public data, no licence key, downloaded weekly to
`SRV_ROOT/panel/geoip` and queried by local binary search, so no address leaves the box. The tables
are held as typed arrays (~6 MB for 330k ranges, against ~100 MB as objects) and the cache is read
straight into them, because the panel restarts on every deploy beside MariaDB and every site. Only
the two-letter code is stored, on the visitor row, which makes "visitors per country" a
`count(distinct visitor)` rather than a request count. **Client addresses** are the one piece of
personal data here: `site_traffic_ips` answers "who is hammering this site", which no anonymised
counter can, so it carries its own short retention (`trafficIpRetentionDays`, default 7 days) and
`trafficStoreIps` switches it off and deletes what was stored.

Per-site **CPU** is a percentage of one core, derived by differencing the container's cumulative CPU
counter against the panel's own previous reading — not by Docker's one-shot percentage, which
compares two samples a second apart. Because every scheduler ticks on a multiple of a minute from the
same start, that second reliably contained the panel's own uptime probe (and, every fifth tick, its
wp-cron run), so an idle site read ~30% instead of ~0.3%.

The web terminal (**Terminal** in the UI, `GET /api/servers/:id/terminal` as a WebSocket) bridges
xterm.js in the browser to a dedicated per-session SSH connection that logs in as `root` with the
panel's key — deliberately not the pooled connection, whose channels site operations ride on.
Server 1 is reached at `host.docker.internal` (compose maps it to the host gateway; a routing-table
fallback covers panel containers created before that mapping), workers at their `sshHost`. Sessions
are capped at 10, idle-closed after 30 minutes, and outside the job queue — an open shell never
blocks site operations.
