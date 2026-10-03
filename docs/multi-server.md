# Multiple servers

One panel, many servers. Server 1 ("local") runs the panel and hosts sites; additional **workers** run
the identical stack minus the panel container — Traefik v3 with its own ACME certificates on :80/:443,
MariaDB 11.4 on an internal network, postfix, one Docker container per site. A site is fully local to
its server (files under `/srv`, database, outbound mail, TLS), so servers stay independent: one going
down affects only its own sites, and the panel going down affects only management.

## SSH transport and trust

The panel reaches workers over SSH (port 22 unless you register another — the provisioner keeps
whatever port sshd listens on open in the firewall) and nothing else. At first boot it generates an ed25519
key (`/srv/panel/ssh/id_ed25519`); the public half is shown under **Servers → Add server** and at
`GET /api/servers/ssh-public-key`. The remote Docker API rides a pooled SSH connection; host commands
run as the `wpl7-panel` user that `setup.sh` creates (member of `docker`, passwordless sudo).

The same key also sits in **root's** `authorized_keys` on every server (the main one included) for
the panel's web terminal, which opens an interactive root shell over a dedicated SSH connection on
whichever server the terminal's **Connect to** picker names — the panel's own host or any worker.
`/terminal` reopens the one used last; `/servers/:id/terminal` is the direct link, and the address bar
always names the machine the keystrokes go to.
`setup.sh` installs it; the panel also self-heals a missing line at terminal-open time (via sudo on
workers, via docker.sock on its own host).

Be clear-eyed about what that key is: **root-equivalent on every server that trusts it** (the `docker`
group alone is root-equivalent, so the sudo grant and the root `authorized_keys` line add convenience,
not privilege). Protect `/srv/panel` like root credentials. To revoke a single worker, delete the
panel's line from **both** `~wpl7-panel/.ssh/authorized_keys` and `/root/.ssh/authorized_keys` on that
server — the panel will report it unreachable. (On the main server that's a lock the panel holds the
key to: while it keeps docker.sock, it can reinstall its line.)

Host keys are pinned on first connect (trust-on-first-use) and the pin is re-read from the database on
every reconnect, so the second connection onwards is genuinely verified. A changed host key makes every operation
against that server fail loudly rather than connect; after a legitimate OS reinstall, clear the pin
with `PATCH /api/servers/:id {"retrustHostKey": true}` (works for server 1 too — the terminal pins its
host key the same way).

One job runs at a time per server; a site move occupies both its source and its target server. Other
jobs simply queue behind it.

## Adding a server

Both paths end in the same place: a verified worker the panel manages over SSH.

### Blank VPS (panel-driven, recommended)

Prerequisite: a **fresh Ubuntu 26.04** VPS whose root `authorized_keys` contains the panel's SSH key —
add the key to your VPS provider account *before* creating the VPS so it gets baked in. Then
**Servers → Add server → "Blank VPS (auto-provision)"** (or `POST /api/servers` with `provision: true`;
`acmeEmail` required). The provisioning job:

1. pushes the panel's baked copy of the provision bundle to `/opt/wpl7`,
2. writes `.wpl7-install` — the panel's own version, image tag, channel and registry. A worker
   has no checkout and no release of its own, and `setup.sh` refuses image mode without a
   version rather than inventing one, so this is the only way the machine can know what to
   pull. It is rewritten on every run, which is what makes **Update** on a worker mean "match
   the panel". A panel compiled from a checkout has no published image to hand anyone, so its
   workers are given build mode instead and compile their site images from the pushed
   Dockerfile — there is no panel container on a worker to build, and nothing there derives a
   panel version,
3. runs `setup.sh --role=worker --non-interactive`: Docker, UFW 22/80/443, the `/srv` layout,
   the `wpl7-wordpress` images, the stack via the `docker-compose.worker.yml` overlay (no panel
   container), and the `wpl7-panel` user,
4. verifies the result exactly like manual registration below,
5. syncs the plugin-catalog zips.

The DNS provider token is passed to `setup.sh` on **stdin** (`--dns-token-stdin`), never on the command
line, so it can't leak via the process list. Each worker's `deploy/.env` gets its own random
`MARIADB_ROOT_PASSWORD`; the panel never stores remote database credentials — admin operations run via
`docker exec` into that server's `wpl7-mariadb`, which reads the password from its own environment.

### Already provisioned (manual)

Run the provisioner yourself on the new server, then register:

```bash
./provision/setup.sh --role=worker --dev-domain=dev.example.com --acme-email=you@example.com \
  --panel-key='ssh-ed25519 AAAA… panel' \
  --dns-provider=cloudflare --dns-token-stdin <<<"$CF_TOKEN"     # token via stdin, for the wildcard cert
```

then **Servers → Add server → "Already provisioned"**. Registration verifies before keeping anything:
SSH + sudo, Docker, `wpl7-traefik` and `wpl7-mariadb` running (mail is optional), the `/srv` directories,
a MariaDB health check, `wpl7-wordpress` image presence (informational), public-IP auto-detection
(*failure to detect fails the registration* — pass `publicIp` explicitly then), and wildcard-DNS
resolution (informational). Failure returns `502` with the check list and saves nothing, so fix and
retry.

Auto-detection reads the source address of the default route, which on a NATed host is a private
address. That is accepted (LAN fleets are legitimate) but the check says so explicitly and the panel
logs a warning — DNS records and the move-forwarding proxy are built from this value, so set the real
address on the server's page (**Edit settings**, or `PATCH /api/servers/:id`) if the machine is
behind NAT.

## The server page

**Servers → (a server)** is one machine end to end: its status and last error, what the panel knows
about it (role, SSH target, public IP, dev domain, DNS provider, pinned host key, backup location),
what the machine says about itself (OS, kernel, CPU, memory, uptime, Docker — one cached round trip,
`GET /api/servers/:id/info`), live load/memory/disk charts, and the sites it runs, each linking to its
own page. The actions that belong to a whole machine live there too: terminal, re-verify, backup
storage, edit settings, update the stack, remove.

For server 1 the system reading is taken over the panel's read-only host shell rather than from inside
the container, so `os` is the machine's Ubuntu, not the panel image's Debian.

### Updating workers

Workers run whatever bundle the panel shipped them. Upgrading the fleet is therefore: update the panel
first (server 1: `git pull` + `setup.sh`, see docs/operations.md), then **Update** on each server page
(`POST /api/servers/:id/update`). That re-pushes the current bundle and re-runs the idempotent
`setup.sh` — safe to run anytime, and also how a failed provision is retried. Worker stacks always
match the panel's own revision.

## DNS

One dev domain serves the whole fleet. The `*.<devDomain>` wildcard record points at the **wildcard
server** (server 1 by default; the `dns.wildcardServerId` setting is a manual DB edit for now). Sites
created on any *other* server get an explicit `<slug>.<devDomain>` A record → that server's IP (a
specific record beats the wildcard; TTL 300, unproxied), created at site creation, re-pointed on a
move, deleted with the site.

Record automation needs `DNS_PROVIDER=cloudflare` + `CF_DNS_API_TOKEN` in `deploy/.env` — the same
token the DNS-01 wildcard-cert overlay uses; scope **Zone → DNS → Edit** on the relevant zones.
Cloudflare is the only provider the panel manages records with for now; with any other setup the panel
still works — it warns and tells you exactly which record to create by hand. Every server issues its
own `*.<devDomain>` wildcard certificate via DNS-01 (provisioning injects the token into each worker's
`.env`); custom domains use per-host HTTP-01 on whichever server hosts the site. Record tables:
docs/dns.md.

## Moving a site

**Site page → "Move server"** or `POST /api/sites/:slug/move {"targetServerId": N}`. Hostnames never
change, so there is no URL rewriting — a move is copy + cutover + DNS:

1. **Preflight on the target**: reachable, MariaDB healthy, leftovers of a previous failed attempt
   removed, free disk ≥ 2.5× the site's size (a warning if size can't be determined), PHP image
   present or built.
2. **Quiesce the source** — the `quiesce` option: `maintenance` (default for live sites) shows
   WordPress's maintenance page during the copy so no writes can be lost; `stop` takes the container
   hard offline; `none` (default for dev sites) keeps serving, but **changes made during the copy are
   lost**.
3. **Snapshot** on the source (backup type `move`, kept like a manual backup), then a **streamed
   copy** source → panel → target, sha256-verified, progress logged every 256 MiB. The staged copy is
   registered as a second `move` backup on the target — the site arrives with a backup at its new home.
4. **Restore + probe** on the target: database created and imported, files laid down, container created
   with target-appropriate Traefik labels, then probed. The probe goes through the target's Traefik with
   the site's own `Host` header (and over HTTPS unless `TLS_MODE=none`), so it fails if the router did
   not pick the hostname up. A failed probe rolls the target back completely; the source resumes
   untouched. A site that was **stopped** before the move is started only for this probe and stopped
   again before cutover, so it arrives in the state it left in.
5. **Cutover**: the site's registry row flips to the new server (atomically, together with a pending
   cleanup record), the dev A record is re-pointed — custom-domain records too when their zone is in
   the Cloudflare account; otherwise the job log and the site page list the exact A records to update,
   with the new IP.
6. **The forwarding window** (every moved site): the source Traefik gets a file-provider config
   (`/srv/traefik/dynamic/move-<slug>.yml`) that keeps terminating TLS with its still-valid
   certificate — the wildcard one for pure dev hostnames — and forwards requests for **all** of the
   site's hostnames to the target: zero downtime and no lost writes while DNS propagates, and hostnames
   whose records were not (or could not be) updated keep working until someone fixes them. The old copy
   is never torn down inside the move: resolvers hand out the old address for a while after any record
   change, managed or not.

### Finalize

A moved site leaves a **pending cleanup** on the source: the forwarding config and the old copy. The
nightly housekeeping job (04:00) finalizes it automatically once every hostname resolves *only* to the
target IP (no old address in the answer, no AAAA records — those the panel cannot verify) *and* the
move is at least 24 h old; or do it immediately from the banner on the site page /
`POST /api/sites/:slug/move/finalize`. Deleting a site finalizes any pending cleanup first; if that
fails the site is kept (marked `error`, name reserved) so a later site re-using the name can never
inherit a stale cleanup. Finalize also refuses to touch anything a site that now lives on the source
server owns.

Until a cleanup is finalized the **source server cannot be removed** (`DELETE /api/servers/:id` returns
409 and names the sites): removing it would strand the parked container, database and files with nothing
left that knows how to clean them up.

If DNS management is off, the job log warns that the dev hostname still points at the old server —
create the A record before finalizing, or the dev URL breaks when the source copy goes away.

### Failure and recovery

The source is never touched destructively before the target probe passes. A failed or interrupted move
(including a panel restart mid-move — boot reconciliation marks the job failed) is recovered by simply
**running the move again**: preflight removes the target leftovers. If the panel itself is gone and you
need to clean a half-copied target by hand, on the target server:

```bash
docker rm -f wp-<slug>
docker exec wpl7-mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "DROP DATABASE \`wp_<slug>\`"'
rm -rf /srv/sites/<slug>
# the site's network outlives its container; Traefik, the relay and MariaDB are still attached
for c in wpl7-traefik wpl7-mail wpl7-mariadb; do docker network disconnect -f wpl7_site_<slug> $c; done
docker network rm wpl7_site_<slug>
```

(DB name uses underscores where the slug has dashes.)

### Mail

A move registers the site's relay login on the target before its container starts, and the panel
pushes every site's login and the sender-authorization map to **every** server — so a moved site can
authenticate the moment it lands, with no credential shuffle in the move path (same reasoning as the
DKIM keys). Each server runs its own postfix, so a move changes the site's outbound IP. Smarthost mode
(`SMTP_RELAYHOST` — recommended for fleets) is unaffected. In direct-MX mode, put **all** fleet IPs in
each sending domain's SPF record up front (`v=spf1 ip4:<ip1> ip4:<ip2> ~all`) so moves never require
SPF edits, and give every server its own `MAIL_HOSTNAME` with matching reverse DNS (docs/dns.md).

### FTP and SFTP

A site's FTP logins follow it: every server's gateway can take any site's logins, and the move
brings them up on the target once it is over (FTP is paused for the length of the move, so no
upload lands on the old copy - docs/ftp.md). What changes for the client is the server: a new host
address, and a new SSH host key and FTPS certificate to trust on the first connection.

## Backups across servers

A backup lives on the server where it was taken (`serverId` on the row) and stays there when the site
moves. Download streams from whichever server holds it. Removing a dead server that still has backup
rows needs `DELETE /api/servers/:id?force=true`, which drops the records (any files on the server are
left untouched).

**Where** each server keeps them is per server (`servers.backup_root`): disks differ per machine, and
a worker takes any absolute path the moment it is saved — the panel reaches its filesystem over SSH as
root. Only the panel's own server needs a compose change first
(docs/backup-restore.md#choosing-where-backups-are-stored).

**Offsite copies** run on the server that holds the backup, so one destination covers the whole fleet
and nothing streams through the panel. Each server pulls the pinned `rclone/rclone` image the first
time it uploads.

**Restoring a backup whose site has since moved** used to be impossible. It still is for a backup that
exists only locally on the old server — but one with an offsite copy can be **fetched back** onto the
site's current server, after which the ordinary restore works.

## Plugin zips

Uploaded plugin zips live on server 1 and are synced to workers automatically: pushed when a server is
added and whenever a zip is uploaded, and ensured lazily before any install that needs them.

## Known limits

- **Cross-server restore** works only via an offsite copy: **Fetch back** brings the backup onto the
  site's current server. A purely local backup on the old server still has to be downloaded by hand,
  or the site moved back.
- **Let's Encrypt duplicate-certificate limit**: every server requests the same `*.<devDomain>`
  wildcard, and LE issues at most 5 certificates per week for an identical name set. Adding ≤5 servers
  per week is fine; renewals spread out naturally.
- **`SRV_ROOT` must be identical fleet-wide** (default `/srv`), and `TLS_MODE` should be uniform.
  Neither is enforced by code — the registration `srv` check catches most `SRV_ROOT` mismatches.
- The **wildcard server** defaults to server 1; changing `dns.wildcardServerId` is a manual DB edit.
