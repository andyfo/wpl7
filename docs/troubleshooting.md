# Troubleshooting

## Site redirects in a loop
The X-Forwarded-Proto→HTTPS fix is injected via `WORDPRESS_CONFIG_EXTRA` on every container, so loops
usually mean `home`/`siteurl` point at the wrong scheme or host. Check with
`docker exec -u 33 wp-<slug> wp option get home` (or the panel's WP-CLI console) and fix with
`wp option update`.

## /wp-json/ answers with the home page (REST clients fail on a 200)
A site whose `permalink_structure` is empty has no rewrite rules, but the site image's catch-all
`.htaccess` still hands every unknown path to `index.php` — so `/wp-json/...` renders the home page
under a **200**, and anything connecting over the REST API (the WordPress app, headless front ends,
site-management services) reports "the site answered but sent the wrong thing" instead of a 404.
Seen from outside, the tell is `/wp-json/` returning HTML while `/?rest_route=/` returns JSON.

    docker exec -u 33 wp-<slug> wp option get permalink_structure   # empty = plain permalinks
    docker exec -u 33 wp-<slug> wp rewrite structure '/%postname%/'

Sites created by the panel are put on `/%postname%/` during create; a site restored from a backup
taken before that keeps whatever structure the backup had.

## No HTTPS certificate / browser warning
- DNS must point at this server *before* the certificate can be issued — `dig +short <domain>`.
- `docker logs wpl7-traefik | grep -i acme` shows validation errors.
- Rate limits: Let's Encrypt allows 5 failed validations per hostname per hour and 50 certs per
  registered domain per week. Use `TLS_MODE=staging` (`ACME_RESOLVER=letsencrypt-staging`) while testing,
  and switch on the wildcard certificate (**Settings → DNS**) so dev sites share one.
- `acme*.json` must be mode 600 or Traefik refuses to start the resolver.
- A dev site on a server whose wildcard certificate is on: **Settings → DNS → Check** says whether the
  token reaches the dev domain's zone and can read its records, and the table there whether that
  server's Traefik has the token. `docker logs wpl7-traefik | grep -i -e acme -e cloudflare` shows what
  Cloudflare answered. A token that lacks **Zone → Zone → Read** fails the zone lookup even with DNS Edit.

## "Error establishing a database connection"
- `docker inspect --format '{{.State.Health.Status}}' wpl7-mariadb` → should be `healthy`.
- Site DB credentials live in the container env (`docker exec wp-<slug> env | grep WORDPRESS_DB`).
- A site started while MariaDB was down heals itself once the DB is up — no restart needed.

## wp_mail() sends nothing
- Panel → **Mail → Overview** first: the health checks there name the failure directly (relay down,
  port 25 blocked, signer stopped). **Send a test message** both ways — from the relay and from the
  site — to tell "mail is broken" apart from "this site is broken".
- Panel → **Mail → Traffic**, filtered to the site, shows whether the message was accepted and what
  the receiving server said. **Queue** shows what is stuck and why.
- Landing in spam rather than missing? **Mail → DKIM & DMARC** checks SPF, DKIM and DMARC against
  live DNS and gives you the records to publish. Full guide: docs/mail.md.

## A site is suddenly sending a lot of mail
Panel → **Mail → Overview → Volume by site** flags a site over the configured hourly budget, or with
a failure rate high enough that the recipient list cannot be real — both are what a compromised
install used as a spam relay looks like. Past the suspension threshold the panel has already stopped
the relay accepting its mail and emailed you; the site page shows the reason and a **Resume mail**
button. Empty its queued mail (**Mail → Queue**), then audit its plugins and users. See docs/mail.md.

## A site reads "Offline" (or "No container") though the panel started it

The badge is the uptime probe's answer, not the registry's — see docs/site-lifecycle.md → Status vs.
health. Open the site: the banner on its Overview names what the probe got back, and **404** is the
tell that Traefik has no router for the hostname, i.e. the container is there but was recreated
without its labels (a PHP switch or domain change that failed halfway). The banner's button is the
repair for the state it names: **Recreate container** (`site.reconcile`, which rebuilds from the
registry and leaves files and database alone) for a 404 or a missing container, **Start** for one that
exited or was built and never ran — see the Created case below. `site.reconcile` does not roll back a
rebuilt container that still fails to answer, it only warns, so read the job log rather than trusting
the green status. By hand:

    docker ps -a --filter "name=wp-<slug>"                 # exists? what state?
    docker inspect wp-<slug> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep traefik
    docker logs --tail=50 wp-<slug>
    curl -sI -H 'Host: <domain>' http://127.0.0.1/ | head -1   # what the panel's probe sees

## Every site returns 504 after a stack redeploy
`docker compose up` recreates Traefik from a file that knows nothing about the per-site networks, so
it comes back attached to none of them. The panel re-attaches Traefik, the relay and MariaDB at boot
and every 60 seconds — wait a minute, or restart `wpl7-panel` to force a pass. `docker logs wpl7-panel |
grep "Site networks"` shows what it repaired. To check by hand:
`docker inspect wpl7-traefik --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`
should list one `wpl7_site_<slug>` per site on that server.

## A site cannot reach another site (or the panel) — on purpose
Sites are isolated on their own Docker network by design, so cross-site HTTP calls, a shared Redis on
a site container, or anything pointed at `wpl7-panel` from inside a site will not connect. Legitimate
cross-site traffic has to go out through the public hostname like any other client. See
docs/architecture.md → Networks.

## "Site did not answer the smoke check"
Probes now go through Traefik with the site's Host header rather than straight at the container, so a
failure means "a visitor would not get this page" — the container may be fine while its router is
not. Check `docker logs wpl7-traefik`, then that the site container carries
`traefik.docker.network=wpl7_site_<slug>` (`docker inspect wp-<slug> --format '{{json .Config.Labels}}'`).

## File permission errors (uploads, updates failing)
Site files must be owned by uid/gid 33 (www-data). Files a root shell created are the usual culprit;
the Files tab shows them with a lock and an amber owner. **Files → ⋯ → Fix ownership** hands a folder
back to the site from inside its container (docs/web-ftp.md); from a shell on the server it is
`chown -R 33:33 /srv/sites/<slug>/wordpress`.

## Site down after a PHP switch
The job rolls back automatically when the smoke check fails. If the server died mid-switch, the site may
be marked `error` — use Start (or Delete for a broken experiment). `docker logs wp-<slug>` has the PHP
error that broke it (usually a plugin incompatible with the new PHP).

## Container refuses to start: `not a directory: Are you trying to mount a directory onto a file`
A bind mount whose source file is missing is not an error to Docker's `-v` form: it **creates the
source, and always as a directory**. The site image has a regular file at `/etc/msmtprc` and at the
PHP ini path, so the container then fails to start — and the empty directory stays behind, so every
later attempt fails identically, including the rollback meant to restore the working container. A
site created before per-site mail authentication (or restored from an archive older than it) could
lose its container to a routine PHP switch this way.

Site containers are now built with the `--mount` form (`HostConfig.Mounts`), which refuses at create
time with `bind source path does not exist` and touches nothing on the host. Measured on Docker
29.8.1; moby/moby#47616 asked for the same choice on `-v` and was closed as not planned. A container
created by an older panel keeps its `-v` binds until it is recreated, so the rest of this section
still applies to one of those.

The binds are resolved every time the container **starts**, not only when it is created, so this is
not limited to a PHP switch: plain Start and Restart recreate the directory too. That is why removing
it by hand and then pressing Start does not help — the Start puts it straight back.

Every start, restart and create now materialises those files first and removes a directory found in
their place, so **Start is the fix** — it rewrites the files from the registry and runs the
container. On a panel older than that, use **Recreate container** (site page, next to Restart)
instead: it repairs the files and *recreates* the container, where Start would only have put the
directory back. Failing that, remove the directory by hand and then re-apply:

```bash
rm -rf /srv/sites/<slug>/config/msmtprc      # only ever an empty directory Docker made
```

A host reboot can reintroduce it: the containers' `unless-stopped` policy starts them before the
panel is up, so a site whose msmtprc is still missing gets the directory back. Start it from the
panel once and it is repaired for good.

## A site 404s after Recreate container / a PHP switch, and the job said it succeeded
`docker ps -a` shows the container as **Created** rather than Up. Jobs that recreate a container
preserve whether it was running, and "stopped on purpose" is read from Docker. A container whose
start FAILED sits in Docker's `created` state, which used to be reported as `exited` — so the job
rebuilt the container perfectly, concluded the site had been stopped deliberately, and left it down.
Traefik has a router but no backend, which is the 404.

`created` and `exited` are now distinct, and only `exited` counts as stopped on purpose; anything
else falls back to the status in the registry. A reconcile that does leave a site stopped now says so
in its log. To recover a site already in this state, press **Start**.

## A job is stuck / the panel restarted mid-job
Jobs interrupted by a panel restart are marked `failed`, and half-provisioned sites become `error` on
boot. So do backups that were being written: they are listed as `failed`, and deleting one removes
what it had written. Delete is always safe to repeat; create can be retried after a successful
rollback.

## A job timed out and the next job on that server won't start
A timed-out job is marked `failed` immediately, but its handler keeps running until its next
checkpoint (a long `tar` or database import has to finish first). The panel keeps that server's lane
reserved for as long as the handler is alive — otherwise a retry would run alongside the old job's
rollback on the same files and database. The panel log says
`Job #N timed out but is still unwinding; holding its server lane` and then
`Job #N finished unwinding; server lane released`. Jobs on other servers are unaffected. If it never
releases, restart the panel: boot reconciliation marks everything `failed` and the lanes come back
empty.

## Forgotten a panel username

**Forgot your password?** on the sign-in page takes the account's recovery email instead of its name,
and the email it sends names the account. Any admin can also read every name on **Users**. With nobody
signed in, the names are in the panel's own database, in the clear, because a login name is not a
secret:

```bash
docker exec wpl7-panel node -e "
  const db = require('better-sqlite3')('/srv/panel/panel.db');
  console.table(db.prepare('select id, username, is_owner from users').all());
"
```

`PANEL_ADMIN_USER` in `deploy/.env` is no help — it only named the owner on the very first boot.

## Forgotten the owner password

With a recovery email on the account, **Forgot your password?** on the sign-in page is the way back in
for anyone — the owner included. An admin without one asks a colleague: any admin can set them a new
password from their page under **Users**. Nobody but the owner may change the owner's account, though,
so for an owner with no recovery email — or an install with nobody else to ask — the way back in is a
shell on the server. That is the honest boundary: anyone who can run this already owns the machine
the panel runs on.

Blank the owner's password hash, then restart the panel:

```bash
docker exec wpl7-panel node -e "
  const db = require('better-sqlite3')('/srv/panel/panel.db');
  db.prepare(\"update users set password_hash = '' where is_owner = 1\").run();
"
docker restart wpl7-panel
docker logs wpl7-panel | grep -A2 'Generated password'
```

The boot that finds the blank hash seeds a new password: `PANEL_ADMIN_PASSWORD` from `deploy/.env` if
that is set, otherwise a generated one, printed once in the log (the `grep` above). The name, the
second factor and the other admins stay as they were, and every session the owner had open is signed
out. A blank hash opens nothing in the meantime.

## The password reset email never arrives

The sign-in page answers the same whether or not it sent anything, so it cannot tell you which of these
it is:

- **The account has no confirmed recovery email.** An address set on it only counts once the link sent
  to it has been followed; until then the account page shows it as waiting.
- **It went to spam, or nowhere.** Mail is delivered directly unless `SMTP_RELAYHOST` is set, and many
  providers file that as spam or block it outright. The panel log says `Password reset link emailed
  for "<name>"` when the relay took it — from there it is the relay's (Mail → Queue).
- **It was asked for twice within a minute.** Only one reset email per account per minute goes out, and
  only the newest link works.
- **`PANEL_DOMAIN` is not set.** The links point at it, so without it nothing is sent, and the log says
  so.

## Locked out by two-factor authentication
The phone is gone and the recovery codes with it. Any other admin can turn your two-factor off:
**Users → your name → Two-factor authentication → Turn off**, confirmed with *their* password. The
next sign-in is password-only again — a code prompt left open sends you back to the password form —
so set it up afresh from your own page, and this time keep the recovery codes somewhere that is not
the phone.

The owner is the exception — nobody else may change the owner's account — so for the owner (or anyone
with no colleague left to ask) the way back in is a shell on the server:

```bash
docker exec wpl7-panel node -e "
  const db = require('better-sqlite3')('/srv/panel/panel.db');
  db.prepare('update users set totp = null, totp_enrollment = null where is_owner = 1').run();
  console.log('two-factor authentication disabled for the owner');
"
```

For another admin, the same with `where id = <their id>` in place of `where is_owner = 1` (the listing
under *Forgotten a panel username* shows the ids). No restart is needed.

If **codes are refused but nothing is lost**, it is almost always the phone's clock: the panel
accepts 30 seconds of drift either way, so turn on automatic time on the phone (in Google
Authenticator: Settings → Time correction for codes). Five wrong codes in a row then stop the
account accepting *any* code for five minutes. That budget is per account, shared by every browser
and address on purpose, so that a password thief cannot spread their guessing across them — and it
locks out nobody but that one account. Wait it out; the first good code afterwards clears it.

## Offsite copies are failing

The error is on **Backups → Storage → Recent failures**, per copy, and it is rclone's own. The usual
ones:

- **`403 Forbidden` / `AccessDenied` on upload** — the key is missing `PutObject` on the prefix, or the
  policy's `Resource` does not include it. The panel never needs `CreateBucket`; the policy it does
  need is in docs/backup-restore.md#security.
- **`AccessDenied` only on delete** — that is a key without delete permission, which is a good thing to
  have. Set the destination's retention to *"managed by the provider"* so the panel stops trying, and
  let a bucket lifecycle rule do the pruning.
- **`NoSuchBucket` / `SignatureDoesNotMatch` on an S3-compatible vendor** — nearly always the endpoint
  or region. **Test connection** on the destination isolates it in one round trip.
- **FTP hangs on transfer but lists fine** — passive-mode ports are not open. The rclone container
  connects out from the server, so the *FTP server's* passive range has to be reachable from it.
- **`ssh: handshake failed: knownhosts: key mismatch`** — the SFTP host key changed. If that was a
  legitimate reinstall, update the Host key field; if it was not, stop and find out why.
- **`Failed to copy: directory not found`** on a fetch — the copy row points at a path that is no
  longer in the bucket. Something else deleted it; the local backup (if any) is unaffected.
- **Encrypted destination, and the bucket looks empty or full of gibberish** — that is working. File
  and directory names are ciphertext; `rclone lsd` through the crypt remote (or the panel) shows the
  real ones. **Backups → Storage → the destination → Passphrase** hands back both halves.
- **`failed to make remote "CRYPT:"`** — the passphrase or salt is wrong. If the destination was
  re-added by hand, both halves have to match what wrote the objects; there is no way to re-key
  existing content.

Credentials never appear in these messages: the panel strips every value it knows out of rclone's
output before storing it, because rclone's "obscured" form is reversible rather than encrypted.

Nothing here touches the backups themselves: a failed copy means the offsite copy is missing, not that
the backup is. `docker logs wpl7-panel` has the panel-side half, and the job log has rclone's own
output line by line.

## FTP or SFTP does not connect

The site's FTP tab shows the state of its server's gateway and says what is wrong; the gateway's
own log is `docker logs wpl7-ftp` on that server (logins, bans, transfers).

- **Connection refused / times out**: the port is not reachable. A cloud firewall in front of the
  server has to allow the SFTP port (2222), and for FTP port 21 and the passive range
  (30000-30015) - the server's own firewall is not the problem, Docker publishes past it. A
  hostname behind Cloudflare's proxy carries web traffic only: use the server's IP.
- **FTP logs in, then hangs listing a folder, or "425 Can't open data connection"**: the passive
  ports are blocked on the way, or the server's public IP in the panel is not the one clients
  reach (Servers → Edit settings). SFTP needs neither.
- **"Port … is already in use … so it offers SFTP only"**: another program on the server listens
  on an FTP port (often a preinstalled FTP server); SFTP still works there. Stop it, or change the
  port in Settings → Sites → FTP & SFTP.
- **"port 2222 is already in use"**: the SFTP port is taken on that server, often by its own SSH.
  Change the SFTP port in Settings.
- **The right password is refused**: after repeated failures the gateway bans the address for 30
  minutes (longer each time); wait, or connect from elsewhere. A login past its expiry is refused
  too - the tab shows it as expired.
- **"Paused"**: a restore, move or delete of the site is running; FTP comes back when it ends.
- **"Server key changed" / a new certificate**: the site moved to another server, which has its own
  key and certificate. Compare with the fingerprints on the site's FTP tab, then trust them.

## A site's Security tab says it is not protected as set

The banner says why (docs/security.md):

- **"The panel cannot reach its server"**: the rules are applied once it answers again - the
  **Site protection** task retries every minute.
- **"Its rules could not be written"** or **"its server's rules could not be updated"**: the
  message is the reason; the site keeps the rules it had. `POST /api/security/sync` (or waiting a
  minute) tries again.
- **"Its container was built before protection reached inside it"**: the panel recreates it by
  itself within the hour; **Recreate container** does it now.
- **"Apache refused the new protection inside its container"**: the previous file is back in
  place, so the site is untouched. `docker exec wp-<slug> apache2ctl -t` shows what Apache says.

## Traefik would not use one of a site's rules

The site's tab lists the router and Traefik's words; every other rule of the site keeps
working. It is almost always a custom rule's regular expression: Traefik's are Go's (RE2), with
no lookaround and no backreferences. Fix or remove the rule; the message goes when the file is
written again. `docker logs wpl7-traefik 2>&1 | grep wpl7sec` shows the same on the server.

## A visitor - or you - is blocked

**Servers → Security → Blocked addresses** shows why each address is blocked, and **Unblock**
lifts it on every server within a minute. **Never block** keeps an address or a range off the
list for good. The panel never blocks an address an admin used it from in the last 30 days, so
signing in from where you are protects that address - from another connection if yours is the
one blocked.

Everything at once, from the panel: **Servers → Security → Enforcement**, switch off **Blocked
addresses reach the servers**. From a server, without the panel: `sudo wpl7-firewall off` (and
`sudo wpl7-firewall on` afterwards). A limit's 429 is not a block: it ends as soon as the rate
drops.

## Servers → Security says "Not installed" or "HTTP only"

**Not installed**: the server has not been set up since Security arrived. Updating it installs
the helper (`provision/setup.sh`, which the update runs on every worker). Until then Traefik
refuses blocked addresses there on its own, at most 2,000 of them. **HTTP only**: the helper is
there but could not load the list; the message says why, and `sudo wpl7-firewall status` on the
server says the same. `setup.sh --no-firewall` servers stay HTTP only by design.

## A malware scan is incomplete or failed

The scan's result says what happened, and its job's log (Jobs → *Malware scan*) the details:

- **"ran out of time"** or **"ran out of memory"**: raise **Time per scan** or **Memory per
  scan** in Settings → Security → Malware scans. A site with many unpublished plugins takes longest.
- **"could not be read"**: files or folders the site's own user (`www-data`) may not read - often
  root-owned files from a manual copy. `docker exec wp-<slug> chown -R www-data: /var/www/html`
  hands them back.
- **"checksums could not be fetched"**: the panel could not reach wordpress.org; the next scan
  tries again.
- **"The scanner could not be fetched"**: the server could not pull AMWScan's image from Docker
  Hub. The file check still ran.
- **Superseded**: a restore, a move or an update ran while it read the files; it runs again on
  its own.

## Upload size limits
Per-site PHP limits live in `/srv/sites/<slug>/config/uploads.ini` (default 64 MB) — edit and
`docker restart wp-<slug>`. Traefik imposes no request-size limit of its own, but it does end any
request that takes over 60 seconds to arrive — which is why the Files tab uploads in chunks. A file
too big for WordPress's media uploader can go up there (up to 2 GiB) instead.
