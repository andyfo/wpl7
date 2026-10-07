# Site lifecycle

All flows run as sequential panel jobs with live step logs (Jobs page / `GET /api/jobs/:id`).

## Create

1. Validates the slug + domains, reserves the slug.
2. Creates `/srv/sites/<slug>/` (wordpress/, config/uploads.ini, config/msmtprc, site.json) — the
   msmtp config carries this site's own mail relay credential, minted with the registry row.
3. Creates network `wpl7_site_<slug>` and attaches Traefik, the relay and MariaDB to it. This is the
   only network the site shares with anything, and no other site is ever a member (docs/architecture.md).
4. Creates the MariaDB database + user.
5. Ensures the `wpl7-wordpress:php<X.Y>` image exists (builds it on first use of a PHP version).
6. Registers the site's login with the relay on every server, before the container starts —
   `wp core install` sends the welcome mail, so the credential has to be in place first.
7. Creates + starts container `wp-<slug>` **without a public router**, with its capability drops and
   resource ceilings; waits for the image entrypoint to copy WordPress core into the bind mount.
8. WP-CLI: `core install` (title, admin user/email/password) → verifies that administrator exists →
   sets the permalink structure (`/%postname%/`) → discourages search engines unless that box was
   unticked → deletes the plugins WordPress bundles (Akismet, Hello Dolly) → language pack (if not
   en_US) → plugin installs (wp.org slugs, then catalog zips) → plugin recipes (`afterInstall`): every
   licensed plugin on the site gets its key and is activated for the dev URL, then verified — a
   vendor that refuses is a warning, and the site page has an *Activate* button
   (docs/licenses.md). Permalinks are set by the panel rather
   than left to `core install`: WordPress picks its structure by loopback-probing a post URL, which
   cannot succeed while the container is still unrouted (step 7), and its fallback — plain permalinks —
   leaves `/wp-json/` serving the home page under a 200. "Discourage search engines"
   (`blog_public = 0`) is on by default because a site answers on its dev hostname from the first
   minute. Going live turns it off (`allowSearchEngines`, on unless unticked in the Go live dialog),
   after the URL rewrite; a plain domain change never touches it. The bundled-plugin removal happens *before* the installs, so a
   catalog that deliberately contains Akismet gets a current copy from wp.org; it is permanent (the
   image entrypoint only seeds an empty directory, and core updates never restore a deleted bundled
   plugin). The removal and the installs run as the administrator `core install` just created
   (`--user`), as they would from wp-admin: a plugin that makes whoever activates it its owner (WP
   Godmode does) gets one, and an uninstall routine that checks the user runs. Plugin failures —
   removal included — are warnings, not fatal. Slugs picked through the
   panel come from a live wordpress.org search, so they exist by construction; a slug posted straight
   to the API is only checked here, by `wp`.
9. Only now is the container recreated with its Traefik labels (published). Until the panel's
   administrator exists, WordPress would serve its web installer to whoever reached the hostname first
   — and that visitor, not the panel, would own the site.
10. Smoke check (through Traefik, so routing is part of what "up" means); site becomes `running`. A
    generated admin password is returned once in the job result.

**On failure** every created resource is rolled back in reverse order (container → database → network
→ files) and the site row disappears, so the same name can be retried immediately. Each rollback step
is registered *before* the operation it undoes, so a step that half-succeeds (container created, second network not
attached) still gets cleaned up. If a rollback step itself fails the site is marked `error` — resolve
with Delete, which is safe to repeat.

## One-click WordPress login

**Log in to WordPress** on the site page (`POST /api/sites/:slug/wp/admin-login`) opens `wp-admin`
already signed in, with no plugin to install and no password to copy:

1. The panel writes/refreshes its own must-use plugin, `wp-content/mu-plugins/wpl7-login.php` — done on
   every click, so sites created before the feature existed get it on first use.
2. It picks the site's administrator (the account it created; the oldest administrator if the customer
   replaced it) and stores `{user id, sha256(verifier)}` in a WordPress transient that expires after
   **120 seconds**.
3. The browser opens `<siteurl>/?wpl7-login=<selector>.<verifier>`. The drop-in deletes the transient on
   sight — so a link works exactly once — compares the hashes in constant time, sets the auth cookie
   and redirects to `wp-admin`.

Only the hash reaches the site, so a dump of its database is not a login. The link is minted on the URL
WordPress itself reports (`siteurl`), because the auth cookie is set for the host that serves the
request. A site frozen in maintenance mode has to be un-frozen first — WordPress skips plugins,
must-use ones included, while `.maintenance` is in place.

## Go live / domain change (zero downtime)

1. DNS pre-check (warns if the new domains don't point at this server yet).
2. Container is recreated serving **old + new hostnames simultaneously** — the dev hostname keeps
   working while Traefik obtains the production certificate.
3. Waits (up to 90 s) for the new primary to answer over HTTPS.
4. Re-checks that no other site claimed one of the hostnames while the certificate was issuing; if one
   did, this site's container is put back on its old domains and the job fails with a 409-style conflict.
5. Container recreated with the final labels (production primary; the dev hostname stays as a 301
   redirect if "keep dev alias" is on), then the canonical URL flips: `wp option update home/siteurl`
   + `wp search-replace` across all tables (GUIDs preserved). A **stopped** site is started for this
   step and stopped again afterwards — the rewrite runs through `wp-cli` inside the container, and
   skipping it would leave the site flagged live while WordPress still redirected to the dev URL.
   Inside that same window the plugin recipes' `afterUrlChange` hook runs: licensed plugins are
   re-activated for the new URL, and Breakdance's own URL replacement (its content keeps URLs in
   JSON, out of `search-replace`'s reach) and cache clear run (docs/licenses.md).
6. The registry row (domains, live flag) is written **last**. If the container swap or the rewrite
   fails, the transition router is put back and the job fails; re-running the change repairs it — the
   current URL is read from WordPress itself, never assumed from the row.

## Move to another server

Full guide: docs/multi-server.md. Hostnames never change, so nothing is search-replaced — a move is
copy + cutover + DNS:

1. Preflight on the target: reachable, MariaDB healthy, leftovers of a previous failed attempt
   removed, free disk ≥ 2.5× the site, PHP image built if missing.
2. Source quiesced — live sites default to the maintenance page, which the job re-arms every 5 minutes
   for as long as the copy runs (WordPress ignores a `.maintenance` marker older than 10 minutes), so
   nothing written can be lost; dev sites default to `none`, where edits made during the copy are
   lost; `stop` is the hard-offline option.
3. Snapshot (backup type `move`) → streamed source→panel→target, sha256-verified; the staged copy is
   registered as a backup on the target.
4. Restore on the target + probe. A failed probe rolls the target back completely and the source
   resumes untouched — **re-running the move is always the recovery**, even after a panel restart.
5. Cutover: the registry flips to the new server; the dev DNS record is re-pointed (custom domains too
   when their zone is in the Cloudflare account — otherwise the job log lists the records to change).
6. The source keeps terminating TLS for **every** hostname (dev alias included) and forwards to the
   target while DNS propagates — no downtime, no lost writes. The source copy is never torn down inside
   the move: it is cleaned up automatically once every hostname resolves *only* to the target (no old
   address left in the answer, no AAAA records) and ≥ 24 h have passed, or earlier via **Finalize**.

## Import (`site.import` + `site.importFinish`)

Docs page: docs/site/src/content/docs/sites/import.mdx; the protocol: docs/internal/import-protocol.md.
An import brings an existing WordPress site in through the migration plugin, installed on the old site
from a zip the panel builds for that import (it carries the import's token).

1. **Connect.** The plugin reports the old site (`POST /api/migrate/connect`, its token in
   `X-WPL7-Import-Token`). The panel checks the report and binds the import to that site's `home`.
2. **Start** (`POST /api/imports/:id/run`) reserves the site like a new one - row `provisioning`, dev
   hostname only, the old site's table prefix - and queues `site.import` in the target server's
   `import:<server>` lane, so a pull of hours holds up nothing else on the machine.
3. **`site.import`** pulls into `<SRV_ROOT>/wpl7-import/<id>/`: the file listing, then the files as a tar
   stream straight into `tar -x` on the server (small files many to a request, big ones in ranges), then
   the database as SQL pages, every line checked against the protocol's grammar
   (services/importSql.ts) and appended to `db.sql.gz`. After every batch it writes its cursor to
   `import.json` and to the row: Continue (`POST /api/imports/:id/retry`) resumes from there after Stop,
   a failure or a restart. No compensations: the staging folder stays until the import is deleted, or
   for 7 days after a failure nobody continued.
4. **`site.importFinish`** (the server lane, with the site) removes the chosen drop-ins and must-use
   plugins, writes WordPress's standard `.htaccess` when there is none, then restores the site from the
   folder with the move's restore step (handlers/restoreSite.ts): files renamed into place, the database
   imported as the **site's own database user**, the container started without a router. The image
   writes `wp-config.php` at first start; the chosen constants go in with `wp config set`. Then
   `wp core update-db`, the old address replaced with the dev address (both schemes and JSON-escaped,
   plugins not loaded), the old folder with `/var/www/html` when asked, the chosen plugins deactivated,
   `blog_public = 0`, and the site published with its router. A failure rolls back to the pulled copy in
   staging (database dropped, container and network removed); Continue runs the finish again. Once the
   site is up, an inventory scan, a malware scan (trigger `import`) and the first backup (type `import`)
   follow, each a warning at worst, and the staging folder goes.
5. The plugin stays connected until **Disconnect** (site page) or **Delete import**, which also ask the
   plugin to clean up and deactivate itself (`finish`).

## PHP switch

Recreates the container with the new `wpl7-wordpress:php<X.Y>` image. Files and DB are untouched (the
image only seeds an *empty* directory). The recorded PHP version changes only once the new container
is up and answers: if Docker fails to create or start it, or the smoke check fails, the previous
container is put back and the job fails (safe to retry). "Already on that version" is only believed
while the container actually exists.

## Stop / start / delete

- Stop/start = plain container stop/start; Traefik returns 404 for stopped sites.
- WP operations that need `wp-cli` (core update, plugin and theme install/activate/update/delete, bulk
  runs, inventory scans on demand) start a stopped site for the duration and stop it again afterwards,
  so its status stays truthful. The scheduled fleet scan skips stopped sites instead — it exists to
  keep a dashboard current, which is no reason to wake a site nobody asked for (docs/updates.md).
- Every WordPress job re-reads that site's plugin/theme/core snapshot when it finishes, so the panel's
  view of a site is never older than the last thing it did to it.
- Delete first tears down the old copy a move may have left parked on the previous server. If that
  fails, the site stays (marked `error`) and keeps its name reserved — re-run Delete. A create that is
  canceled while still queued releases its reservation immediately.
- Before the container goes, the plugin recipes' `beforeRemove` hook releases the licensed plugins'
  activations at their vendors (Breakdance counts sites, ACF PRO counts production URLs). Best
  effort: a vendor that cannot be reached is a warning, and the site is deleted regardless
  (docs/licenses.md).
- Backups cannot be deleted (API or retention) while a job that may use them — restore, backup, move
  or delete of that site — is queued or running (`409`).
- Delete = optional **final backup** (kept until you delete it) → remove container → drop DB + user →
  remove files → remove the site's network → remove registry row → revoke its relay login. Backups
  survive site deletion, listed under **Backups → Deleted sites**: the final one stays until you delete
  it, scheduled ones keep following retention. If teardown fails part-way the site is left `error`
  rather than `deleting`, so Delete can be retried.
- **Delete its existing backups too** (off by default, `?deleteBackups=true`) queues a `backup.delete` for
  the site's other backups once the site is gone — offsite copies included, in their own job lane rather
  than the server's. The final backup is not among them, so with both switches on the site leaves
  exactly one backup. Should a final backup be asked for when the files are already gone (a retry after
  a teardown that removed them), the newest complete backup is kept instead. Nothing happens to the
  backups while teardown can still fail.

## Status vs. health

Two different questions, and the panel used to answer both at once with two indicators that
regularly contradicted each other:

- **`status`** (`provisioning | running | stopped | error | deleting`) is what the last job *left the
  site as*. It is a stored registry field, never re-read from Docker, so `running` means "the panel
  started it and nothing has told it otherwise".
- **`up` / `httpStatus`** come from the uptime probe: a real request through Traefik with the site's
  own `Host` header, every `monitor.uptimeSec`. The only one of the two that knows whether a visitor
  sees anything. Traefik answers its catch-all **404** for a hostname no router matches, which is
  precisely what a site whose container was recreated without its labels looks like from outside —
  so a 404 counts as down (`panel/src/lib/httpProbe.ts`).

The panel collapses them (plus a live `docker inspect` on the site page, which costs a round trip and
so is not in the list) into one badge per site — `panel/web/src/lib/siteHealth.ts`:

| Badge | What it means |
|---|---|
| **Online** | started, and the probe got a page |
| **Offline** | started, but not serving — the probe got nothing / a 404 / a 5xx, or its container has exited or was built and never ran |
| **No container** | the registry says running and Docker has no container by that name |
| **Stopped** | stopped on purpose |
| **Unknown** | its server could not be reached, so nothing shown is live |
| **Checking** | started; no probe has completed since the panel last booted |
| **Creating** / **Deleting** / **Error** | the transitional and failed lifecycle states |

The badge names the state; the banner on the site page names the repair for *that* state and offers
the button for it, because they differ — **Start** for a container that exited or never ran,
**Recreate container** for a 404 or a missing one. They are not interchangeable: `shouldSiteRun`
reads `exited` as "stopped on purpose", so a recreate on one of those rebuilds it and leaves the
site down.

## Recreate container (`site.reconcile`)

Networks, capability drops, resource ceilings and the mail credential are all applied when a
container is **built**, so a site created under an older policy keeps the old one until something
recreates it. This job does it deliberately: mints the relay credential if the site has none, writes
its msmtp config, creates/repairs its network, republishes the sender map, then recreates the
container from the current spec. Files and database are untouched.

It does **not** roll back a container that starts but fails the HTTP smoke check afterwards — it
logs a warning and finishes successfully, so check the job log, not just its status. There is also
nothing to roll back to: unlike the PHP switch, this job rebuilds from the same site row it started
from, so the "previous" container is the same container. The rollback that does exist covers Docker
refusing to create or start the replacement.

Run it per site (**Recreate container** on the site page) or across the fleet
(`POST /api/sites/reconcile-all`, one job per site, serialized per server). It is idempotent, so
running it on an already-current site costs one container restart and changes nothing else. A
changed CPU/memory/process limit in Settings does not need it: saving one changes every existing
container in place (`server.applySiteLimits`), and queues this job only for the sites losing a CPU
cap, which Docker cannot lift from a live container. A site that already has a job queued cannot be
given a second, so it is recreated by a later pass, which the scheduler queues once that job has run.

## Manual disaster recovery (no panel needed)

Each site is self-describing: `/srv/sites/<slug>/site.json` + `/srv/backups/<slug>/<ts>/manifest.json`.
A site can be resurrected on any Docker host with the official WordPress image, the files.tar.gz and
db.sql.gz — see docs/backup-restore.md.
