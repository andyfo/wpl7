# Operations

Looking for what a particular script does or which flag to pass?
[scripts.md](scripts.md) is the reference — this page is the *why* behind it.

## Deploying, and working on the code

Everything about getting *changes* onto a server — push-to-deploy with GitHub Actions,
getting a clone onto a box, and editing on the box itself — moved to
[development.md](development.md). This page is about running an install, not building one.

To move an install to a newer version, see [updating.md](updating.md).

## Applying a change to this install

To move to a newer **version**, use [updating.md](updating.md) — the Update button, or
`./provision/update.sh --to=<version>`. This section is about the other thing: applying a
configuration change you just made.

```bash
cd /opt/wpl7
sudo ./provision/setup.sh     # needs root: apt, ufw, /etc/docker, images, compose up
```

`setup.sh` is idempotent and **never overwrites an existing `.env`**, which is exactly what
makes it the way to apply an edit to that file. It always runs as root: it installs packages,
writes `/etc/docker/daemon.json`, configures UFW and creates `/srv`.

On an install that builds its panel from a checkout (`WPL7_SOURCE=build`), a `git pull` comes
first — **as the checkout owner, not root**, because a root `git pull` writes root-owned files
that the owner can no longer edit. (`setup.sh` repairs that at the end if it happens, but
pulling as the owner avoids the detour.) Getting a clone onto a box in the first place is
[development.md](development.md#getting-the-code-onto-a-server).

To apply a change without re-running the whole provisioner (no apt, no ufw), rebuild just
what changed — `provision/compose.sh` is a wrapper that always passes this install's
`.env` and overlays, so a rebuild can't silently reconfigure the stack:

```bash
./provision/compose.sh up -d --build panel   # panel code changed
./provision/compose.sh ps
./provision/compose.sh logs -f panel
```

`live-restore` is enabled in the Docker daemon, so hosted sites keep serving while dockerd itself
restarts. Site containers use `restart: unless-stopped` — after a server reboot everything that was
running comes back automatically; sites you stopped stay stopped.

Recreating Traefik, MariaDB or the relay detaches them from every per-site network — compose does
not know those exist — so sites return `504` until the panel's reconciler re-attaches them, at boot
and every 60 seconds. Nothing to do but wait a minute; `docker logs wpl7-panel | grep "Site networks"`
confirms it happened.

### Re-applying the container policy

Container-level policy (networks, capability drops, resource ceilings, the mail credential) applies
when a container is built, so existing sites keep the old one until recreated.

**After an update this happens by itself.** The panel queues one `site.reconcile` per site as part of
its post-update job, which is the whole reason that job exists
([updating.md](updating.md#what-the-panel-does-afterwards)). By hand, when you want a pass for some
other reason:

```bash
curl -X POST -H "Authorization: Bearer $WPL7_API_KEY" \
  https://panel.example.com/api/sites/reconcile-all
```

or **Recreate container** on each site's Overview tab. One job per site, serialized per server,
each rolling back on its own if the recreated container does not answer. Until a site has been
reconciled its outbound mail is refused (`553 … not logged in`), because it has no relay credential.

### Migrating an install from ceo-server

The product was called `ceo-server` until 0.2.0, and the rename went all the way down:
containers, networks, labels, the compose project, the checkout path, the Linux users, the
relay's SASL realm, the one-click-login drop-in. An install from before it migrates once,
and `setup.sh` drives the whole thing — it runs
[`migrate-rename.sh`](scripts.md#migrate-renamesh) by itself the moment it finds a container
called `ceo-panel`.

```bash
cd /opt/ceo-server
git remote set-url origin git@github.com:<owner>/wpl7.git   # GitHub redirects, but be explicit
git pull --ff-only                                                # as the checkout owner
sudo ./provision/setup.sh                                         # detects the old stack and migrates
```

What it costs: the sites on the box stop answering for roughly a minute, between Traefik
stopping and the new stack coming up. Nothing under `/srv/sites`, `/srv/mysql` or
`/srv/backups` is touched, site containers are never stopped, and the panel's database is
snapshotted to `/srv/panel/panel.db.pre-wpl7` before anything changes.

Site containers are left on their old networks and labels on purpose — recreating one is a
job with a rollback, not a step in a teardown script. The new panel notices on boot and
queues one **`site.reconcile`** per site, which moves it to `wpl7_site_<slug>`, relabels it,
mints its `@wpl7` relay credential and drops the old network. Watch them on the Jobs page.
Until a site's job has run it keeps its old credential: both logins exist, with the same
password, and the relay's sender map names both as owners, so no site stops sending mail
part-way through.

Check the migration in this order:

- `docker ps` shows five `wpl7-*` containers and nothing called `ceo-*`
- every site answers again, and the Jobs page has one green `site.reconcile` per site
- **Mail → Send a test message** still arrives, signed — existing DKIM keys keep the
  selector `ceo`, because it is published in your customers' DNS and only new keys use
  `wpl7`
- **Log in to WordPress** on a site (the drop-in is rewritten under its new name on the
  first use, and the old one deleted)
- an API key minted before the rename still authenticates; its `cak_` prefix stays valid

Then finish the two steps the script cannot do for you, both printed at the end of its run:
rotate the CI key so its forced command points at the new path
(`ci-access.sh --repo=<owner>/wpl7 --user=<owner> --rotate`), and change the remote in
your own checkout. `/opt/ceo-server` is left behind as a symlink to `/opt/wpl7` so
anything still holding the old path keeps working until you remove it.

A week later, once nothing has needed the old generation, clean up:

```bash
docker volume rm ceo_mailspool                                  # after the queue has drained
docker image rm ceo-panel:latest $(docker image ls -q ceo-wordpress)
rm /opt/ceo-server                                              # the compatibility symlink
rm /srv/panel/panel.db.pre-wpl7
```

The compatibility shims (both API-key prefixes, both probe user agents, both network
generations, both SASL realms) are tagged `LEGACY(ceo)` in the source and are removed in
0.3.0 — so an install still carrying the old generation has to be migrated before then.

Worker servers migrate the same way, after the panel: **Servers → Update** pushes the new
bundle and runs `setup.sh` on them, which finds their legacy stack and does the same thing.

## Updating the wpl7-wordpress base images

Site containers run local `wpl7-wordpress:php<X.Y>` images. Because each site's files live in a bind
mount and WordPress core updates flow through WP-CLI, a stale base image only affects *newly created*
sites. To refresh:

```bash
cd /opt/wpl7
for v in 8.2 8.3 8.4 8.5; do
  docker build --pull --build-arg PHP_TAG=php$v -t wpl7-wordpress:php$v deploy/wordpress-image
done
```

Existing sites pick the new image up on their next PHP switch or container recreate.

## Multiple servers

Fleet management — adding workers, moving sites, the DNS model — is covered in docs/multi-server.md.
The operational short version:

- **Add**: **Servers → Add server** — either a blank Ubuntu 26.04 VPS created with the panel's SSH key
  (auto-provision), or a server you ran `setup.sh --role=worker` on yourself.
- **Update**: `provision/deploy.sh --workers` does the whole fleet in order (that is what the
  GitHub Actions deploy runs). By hand: update server 1 first, then **Update** on each server
  page (`POST /api/servers/:id/update`). It re-pushes the panel's provision bundle and re-runs
  the idempotent `setup.sh`, so worker stacks always run the panel's revision. That rebuilds the
  `wpl7-wordpress` images too, but without `--pull` — the upstream-base refresh above still means
  running that loop on each worker.
- **Remove**: move or delete its sites first; `?force=true` additionally drops records of backups
  stranded on a dead server. Revoke the panel's access by deleting its key line from
  `~wpl7-panel/.ssh/authorized_keys` on the server.
- **Move a site**: site page → **Move server** (docs/multi-server.md#moving-a-site).
- **Offsite backups**: the panel copies backups to a bucket or another server itself — **Backups →
  Storage → Add remote destination** (docs/backup-restore.md#offsite-copies). Uploads run on the
  server that holds the backup, so a fleet needs one destination, not one per machine. The nightly
  `panel` backup covers the registry; the fleet SSH key in `/srv/panel/ssh` is deliberately not
  included.

## Logs

```bash
docker logs wpl7-panel      # panel API + job worker
docker logs wpl7-traefik    # routing + ACME
docker logs wpl7-mariadb
docker logs wpl7-mail       # postfix queue/delivery (also readable in the panel: Mail -> Traffic)
docker logs wpl7-dkim       # DKIM signing decisions
docker logs wp-<slug>      # a site's Apache/PHP errors
docker logs wpl7-ftp       # FTP/SFTP logins, failed logins, transfers (only on servers with FTP logins)
docker logs wpl7-ftp-<slug> # that site's FTP file server
```

Container logs rotate automatically (json-file, 10 MB × 3, set in /etc/docker/daemon.json).

## Disk

- `df -h /srv` — overall; per-site usage is on the panel dashboard.
- Biggest consumers are the backup tree (tune retention in panel Settings) and `/srv/mysql`.
- Backups do not have to share that disk. Each server has its own **backup location** — panel
  **Backups → Storage** (the **Storage** button beside the server) shows the disk it is on, how full
  it is and every other filesystem the machine has, and can move what is already there. On the
  panel's own server the directory additionally has to be mounted into its container; the modal
  prints the two commands.
  Full recipe: docs/backup-restore.md#choosing-where-backups-are-stored.
- A short local retention next to a long offsite one is a sensible shape: local pruning never destroys
  the last copy — a backup that already exists offsite gives up its local files and stays listed as
  *offsite only*, fetchable on demand.

## Panel state

Panel state (sites registry, jobs, API keys, settings) lives in `/srv/panel/panel.db` (SQLite).

The backup cron copies it nightly to `<backup root>/panel/<ts>/panel.db.gz` on server 1 (backup type
`panel`, SQLite's online backup API, so no downtime) and it is copied offsite like any other backup —
which is what makes a fleet recoverable from a bucket rather than only by hand. Restoring it is
documented in docs/backup-restore.md#the-panels-own-state.

`/srv/panel/ssh` holds the fleet SSH key and is deliberately **not** in that snapshot: it opens every
machine you own. Keep it somewhere a bucket is not — a password manager or an encrypted volume.

## Firewall

UFW allows 22 (rate-limited), 80, 443. Docker-published ports bypass UFW — by design only Traefik
publishes ports, 80/443, and the FTP gateway on a server one of whose sites has an FTP login: SFTP
2222, FTP 21 and passive 30000-30015 by default, IPv4 only (docs/ftp.md). Nothing else. A cloud
firewall in front of a server has to allow the FTP ports for FTP to work. Never publish mariadb or
the panel directly.

**Blocked addresses** (docs/security.md) have a table of their own, `table inet wpl7`, ahead of
Docker's forwarding, for ports 80 and 443 only - UFW and Docker's tables are never touched. On a
server: `sudo wpl7-firewall status` says what is loaded; `sudo wpl7-firewall off` empties it and
keeps it empty, whatever the panel sends, until `sudo wpl7-firewall on`. `nftables.service` is
never enabled: its default configuration begins with `flush ruleset`.

## Security posture

What keeps attacks out - rules and limits in front of every site, blocked addresses, malware
scans - is docs/security.md. This section is about what a compromised site can reach.

### Blast radius of one compromised site

WordPress gets compromised; the question is what that costs everyone else. A site container:

- is on **its own network** with Traefik, the relay and MariaDB, and nothing else. It cannot open a
  connection to another site (not even by container name) or to the panel. Outbound internet comes
  from a shared network with inter-container communication disabled.
- runs **without `NET_RAW`** (no packet forging or ARP poisoning on the bridges it shares) and with
  `no-new-privileges`, so Debian's setuid binaries are not an escalation path.
- is **capped** at 2 CPU cores, 512 MB and 512 processes by default (Settings → Site container
  limits), so a miner or a fork bomb is contained to its own site's performance.
- has its **own mail credential**, and the relay refuses any sender domain belonging to another
  site — so it cannot send DKIM-signed phishing as one of your other customers (docs/mail.md).
- **cannot turn the panel against its neighbours through its files.** The Files tab and the panel's
  own drop-ins work inside the site's container, as the site's user, so a symlink it plants resolves
  in its own filesystem - never on the host, where the panel is root (docs/web-ftp.md). FTP and
  SFTP logins go through a file server container that has only that site's folder mounted, as its
  user, so the same link leads nowhere through them either (docs/ftp.md).
- is stopped from sending at all once it crosses the abuse threshold, with an email to the address in
  Settings → Mail.

What it still shares with its neighbours: the kernel, the MariaDB instance (its own database and
user within it), the server's disk and the server's IP reputation. A container escape or a MariaDB
compromise is still fleet-level on that server; other **servers** hold no credentials for each other,
so nothing here spreads between them except over the public internet.

Sites created before this policy keep the old one until recreated — run **Recreate container**
on each, or `POST /api/sites/reconcile-all` (docs/site-lifecycle.md). A container built before its
protection moved inside it (docs/security.md) is recreated by the panel itself, once.

### Panel and access

- The panel container is root-equivalent on the host (docker.sock). Treat panel credentials and Full
  API keys like root SSH keys — every admin account included, since there are no lesser roles for
  people. **Give each API key the least it needs**: Read only for a dashboard, Manage for tooling that
  creates sites and runs updates, Full only where it has to delete, restore or run commands. A key's
  level is fixed; revoke keys you stop using (panel → Integrations → API keys).
- **AI apps over MCP** are off until switched on (Integrations → MCP), and an app only connects by
  signing in during the ten minutes after an admin presses **Connect an app**, approved by that admin
  at a level they choose — Read only unless they pick more (docs/mcp.md). Check the address the
  approval page says your browser goes to before approving; revoke what you no longer use on the
  MCP page. Every tool call is an API call, in the activity log and credited in the Jobs list.
- **Give each person their own login** (Users → Add admin) rather than sharing one. Sessions,
  sign-in times and two-factor are per account, so removing someone ends their access at once —
  every session they have — without signing anyone else out. (A web terminal they already have open
  runs on until it exits or idles out, like any other; see below.) The owner, the account the first
  boot created, is the one nobody else may rename, reset or remove; any admin can do that to any
  other account.
- **Rename the owner off `admin`** (Users → your account). Half of a guessed login is the name,
  and `admin` is the one every bot tries first. It asks for your password, changes nothing else —
  API keys, other browser sessions and an already-enrolled authenticator all carry on — and
  `PANEL_ADMIN_USER` in `deploy/.env` is not the place to do it: that line only named the owner on
  the very first boot.
- **Set a recovery email** (Users → your account → Recovery email), the owner above all: with one,
  a forgotten password is **Forgot your password?** on the sign-in page; without one, the owner's only
  way back in is a shell on the server. It counts once you follow the link sent to it. Reset links need
  outbound mail that arrives — set `SMTP_RELAYHOST` (docs/mail.md) — and a reset leaves two-factor
  authentication in place, so a mailbox alone does not open an account that has it.
- **Turn on two-factor authentication** (Users → your account → Two-factor authentication). It is
  off by default, per account, and takes a minute: scan the QR with any authenticator app, confirm one
  code, save the ten recovery codes. After that a leaked or reused panel password is not enough to
  sign in, and switching it on signs out your other browser sessions — none of them ever passed a
  second factor. It guards the browser login only: API keys are a separate credential, so automation
  keeps working untouched. Lost the phone and the recovery codes? Another admin can turn it off from
  your page; for the owner, the escape hatch is a shell on the box — docs/troubleshooting.md.
- **FTP logins are the internet-facing part of a server**, when there are any: the gateway takes
  password logins on its own ports. It runs unprivileged with nothing mounted but its config, bans
  an address that keeps failing, refuses FTP without TLS, and hands each login no more than its
  own site's files. Give out a login per person, set an expiry on temporary ones, and delete what is
  no longer needed - creating, changing and deleting logins is logged as `ftp:` lines in the panel's
  log, and each login's sessions and transfers in `docker logs wpl7-ftp` on its server.
- **The Files tab is logged.** Every change, download and content read through it (or its API) is
  one `files:` line in the panel's log naming the admin or key and the path —
  `docker logs wpl7-panel 2>&1 | grep '"files"'`. It edits live sites directly: a PHP file that does
  not parse is refused, but a backup before a big edit is still the way back.
- The web terminal is a root shell behind panel auth: the WebSocket upgrade requires the session
  cookie (or a Bearer key) and a same-origin `Origin` header, sessions are capped at 10 and closed
  after 30 idle minutes. A shell that is already open outlives its browser session cookie until it
  exits or idles out. sshd must keep allowing key-based root login (Ubuntu's default
  `PermitRootLogin prohibit-password` does).
- **Log in to WordPress** mints a single-use token that expires after 120 seconds and is burned the
  first time it is presented; the site stores only its SHA-256, in a transient. Anyone who can call it
  can already reset that administrator's password through the same authenticated API, so panel auth is
  the whole gate. The drop-in it relies on (`wp-content/mu-plugins/wpl7-login.php`) is inert without a
  matching transient — deleting it from a site only costs that site the feature until the next click.
- The first-boot owner password (if generated) is printed once: `docker logs wpl7-panel | grep -A2 'First boot'`.
- MariaDB root password lives in `deploy/.env` (chmod 600) and the panel environment only.
