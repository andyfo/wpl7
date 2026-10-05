# REST API

Everything the panel UI does is available over HTTP for your external admin tools.

## Authentication

Create an API key in the panel (**API keys → New key**), then send it as a Bearer token:

```
Authorization: Bearer wpl7_…
```

Bearer requests need no CSRF header. (The panel UI itself uses a session cookie + `X-CSRF: 1` on
mutations.) All endpoints are under `https://<panel-domain>/api`.

**Every key has a level**, picked when it is made: **Read only**, **Manage** or **Full**
(`POST /api-keys {name, access}`; `access` defaults to `full`, and the keys from before there were
levels are Full). Read only sees and changes nothing; Manage does everything inside the sites that
their WordPress admins could — WP-CLI, shell, files and logins included; Full is the panel itself
(docs/mcp.md → Access). Each endpoint needs one of them — the rule of thumb is that reading is Read
only and a change needs what its group says, Manage for the sites' groups and Full for the panel's,
with deliberate exceptions for the site itself and its safety nets (Full), a GET that returns secrets
or a command's output, and nudges that only do now what the panel does anyway (Manage). A key below what an endpoint
needs gets `403 forbidden`, naming both: `This key is Read only; POST /api/sites needs Manage`. At
Read only, a job's result has its credential-looking fields masked (`•••`), and so has a panel
job's (one of no site) below Full; a `wp.cli`, `site.shell` or `wp.rest` job, or a recipe run,
shows no summary, no error text and no log (`logs: []`, `logsWithheld: true`) and is not found by
searching them; and a custom schedule that runs one shows `params: null`. What a failed recipe
step printed is withheld wherever else it is kept: the `message` of a failed outcome in a recipe
run's result and on `GET /sites/:slug/wp/recipes`, and the log lines of the other jobs that run
recipes (creating, deleting, moving or restoring a site, changing its domains), which say that a
step failed, not what it said. Below Full, a licence key's `display` is `null` and a custom
rclone remote's own options are `•••`. Full also holds what no route level can: going live with
`manageDns: true`; giving a site a domain whose mail would be signed with a DKIM key the site
does not hold; the backup policy (changing, running or deleting a built-in schedule or a
custom one that takes backups, and cancelling a backup or offsite copy the panel started on its
own, or any job of the panel itself); and downloading, copying or fetching a panel snapshot. A
browser session is always Full. The same levels govern AI apps connected over [MCP](mcp.md).

The panel carries the same reference: **API keys → Docs** is a short integration guide plus every
endpoint below, with a console that runs any of them against your own panel (paste the key and it
authenticates as that key, not as your browser session). **API keys → Activity** is the request log
those calls land in.

**Every person signs in with an account of their own** (**Users** in the panel). All admins can do
everything; the *owner* — the account the first boot created — differs only in that nobody else may
change or remove it. A browser session belongs to the account that opened it, so revoking is per
account: a new password ends every *other* session of yours, or every session of the colleague whose
password you set; `POST /auth/logout-all` ends all of yours; removing an admin ends all of theirs.
API keys are unaffected by any of it. A key belongs to the panel rather than to a person, which is
also why it cannot do what re-asks for a password (see [Admin accounts](#admin-accounts)).
`PANEL_ADMIN_USER` in `deploy/.env` only named the owner on the first boot, so it is not the place
to rename anyone.

**A forgotten password can be reset by email** when the account has a *recovery email*: an address set
on it and confirmed by following the link the panel sends there, so a reset link only ever goes to a
mailbox somebody reads. `POST /auth/forgot-password` sends that address a link to
`https://<panel-domain>/reset-password#<token>`, good once and for 30 minutes; the token is after the
`#`, so it reaches no server log. Links are built from `PANEL_DOMAIN`, never from the request's `Host`
header. A reset changes the password and signs every session of the account out — it does not touch
two-factor authentication, which the next sign-in still asks for.

**Two-factor authentication is optional, per account, and applies to the browser login only.** With
it on, `POST /auth/login` accepts the password and answers `{"ok": true, "totpRequired": true}` — the
cookie it sets is a half-login that no other endpoint accepts until `POST /auth/login/totp` completes
it. API keys are deliberately outside this: they are a separate credential with their own revocation
page, and a machine has no phone to be asked.

## Conventions

- JSON in/out. Errors always use the envelope
  `{"error": {"code": "...", "message": "...", "details"?: ...}}` with codes
  `validation_error | unauthorized | forbidden | not_found | conflict | job_conflict | precondition_failed | syntax_error | rate_limited | bad_gateway | timeout | maintenance | internal`.
  `precondition_failed` (412) and `syntax_error` (422) come only from [file writes](#files-web-ftp);
  `maintenance` (503) is a panel that is updating itself and refuses changes until it is back;
  `timeout` (504) is a command that ran past its time limit and was stopped - or, when the message
  says so, still runs. `rate_limited` (429) is over 300 requests a minute, or over an endpoint's own
  limit (a scan, a search): wait as `Retry-After` says.
- **Long operations are asynchronous**: the endpoint returns `202 {"job": {...}}` plus a `Location:
  /api/jobs/<id>` header. Poll the job until `status` is `succeeded | failed | canceled`.
- One active job per site: a second mutation while one runs returns `409 job_conflict`. Jobs are also
  serialized per server — one runs at a time on each server, and a site move occupies both its source
  and target server; other jobs simply queue behind it. Offsite uploads and commands run in a site
  (`wp.cli`, `site.shell`, `wp.rest`) are the exception: they run in lanes of their own, at most one of
  each per server, without blocking that server's site operations.
- Every job records how it was queued: `origin` is `user` (the panel), `api` (a key — `createdBy`
  names it), `mcp` (an AI app's tool call, docs/mcp.md), `schedule` or `system`. Create one key per
  integration and the Jobs list says which one did what.

## Typical flow: create a site, then take it live

```bash
API="https://panel.example.com/api"; AUTH="Authorization: Bearer $TOKEN"

# 1. create on the dev domain (instantly reachable, no DNS work)
curl -sX POST "$API/sites" -H "$AUTH" -H 'content-type: application/json' -d '{
  "title": "Customer Shop",
  "domainMode": "dev",
  "locale": "cs_CZ",
  "phpVersion": "8.3",
  "adminUser": "customer",
  "adminEmail": "customer@example.com",
  "plugins": { "catalogIds": [1, 2], "extraWporgSlugs": ["wordpress-seo"] }
}'
# -> 202 { "job": { "id": 17, ... } }   site will be at customer-shop.dev.example.com

# 2. poll (logAfter returns only new log lines; use lastSeq as the next cursor)
curl -s "$API/jobs/17?logAfter=0" -H "$AUTH"
# -> { "job": {"status":"succeeded","result":{"url":"...","adminPassword":"..."}}, "logs":[...], "lastSeq": 42 }

# 3. later: go live on the customer's domain (zero downtime; dev hostname 301s afterwards)
curl -sX POST "$API/sites/customer-shop/go-live" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"domains": ["customershop.com", "www.customershop.com"], "keepDevAlias": true}'
```

## Fleet flow: add a server, move a site onto it

```bash
# 0. once: fetch the panel's SSH public key and add it to your VPS provider account
curl -s "$API/servers/ssh-public-key" -H "$AUTH"          # -> { "publicKey": "ssh-ed25519 ..." }

# 1. register a worker you provisioned yourself (or add "provision": true + "acmeEmail" for a blank VPS)
curl -sX POST "$API/servers" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "hel1", "sshHost": "95.216.10.20", "devDomain": "dev.example.com", "dnsProvider": "cloudflare"
}'
# -> 201 { "server": {"id": 2, ...}, "checks": [...], "job": {...} }   (502 + error.details.checks on failure)

# 2. move a site there (hostnames never change; DNS is flipped for you when Cloudflare is configured)
curl -sX POST "$API/sites/customer-shop/move" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"targetServerId": 2}'
# -> 202 { "job": ... }   poll as above
```

## Endpoints

### Auth
| Method & path | Body | Returns |
|---|---|---|
| `POST /auth/login` | `{username, password}` | `{ok: true, totpRequired}` — unauthenticated. `totpRequired: true` means the cookie is only a half-login: finish it below, within 5 minutes |
| `POST /auth/login/totp` | `{code}` | `{ok: true}` — the six digits from the authenticator app, or a recovery code. Unauthenticated (it is the half-login cookie being completed). Five wrong codes in a row stop the **account** accepting any code for five minutes, from every browser and address at once — that account only, never a colleague's; a good code ends the run |
| `POST /auth/logout` | – | `204` |
| `POST /auth/forgot-password` | `{login}` | `{ok: true}` — unauthenticated. `login` is a username or a confirmed recovery email (any case); the account's address gets a reset link. The answer is the same whether or not an account matched, and at most one link per account goes out a minute |
| `POST /auth/reset-password` | `{token, newPassword}` | `{ok: true, username}` — unauthenticated. The token from the link, which then stops working; every session of the account ends and the address is told. `400` for a token that is wrong, used, expired or superseded by a newer link |
| `POST /auth/confirm-email` | `{token}` | `{username, email}` — unauthenticated. The token from a confirmation link: the pending address becomes the recovery email. `400` once used or after 24 hours |
| `POST /auth/logout-all` | – | `204` — ends every session of the signed-in admin, this one included. Other admins and API keys are untouched; `403` for an API key, which has no sessions of its own |
| `GET /auth/me` | – | `{user, authVia}` — `user` is the signed-in admin (a `PanelUser`, below), `null` for an API key |

A code is spent once it is accepted, so the same six digits cannot be replayed while they are still
on screen — which also means the code used to finish setup cannot open the first session.

### Admin accounts
`PanelUser` is `{id, username, isOwner, email, pendingEmail, twoFactor: {enabled, confirmedAt, recoveryCodesLeft}, createdAt, lastLoginAt}` — `email` is the confirmed recovery email, `pendingEmail` one still waiting for its link to be followed.

| Method & path | Body | Returns |
|---|---|---|
| `GET /users` | – | `{items: PanelUser[]}` — the owner first |
| `POST /users` | `{username, password}` | `201 PanelUser` — a new admin. Username 3-60 chars of `a-z A-Z 0-9 . _ @ -`, password at least 10; they can change it themselves. A name that differs from a taken one only in case is `409` |
| `GET /users/:id` | – | `PanelUser` |
| `DELETE /users/:id` | – | `204` — the account and every session it has open. `409` for the owner, and for yourself |
| `PUT /users/:id/username` | `{password, username}` | `204` — nobody is signed out. An already-enrolled authenticator app keeps showing the old label, which is cosmetic — the secret is untouched |
| `PUT /users/:id/email` | `{password, email}` | `204` — sends the address a confirmation link; it becomes the recovery email once that is followed, and until then any confirmed address keeps the job. `502` if the mail relay would not take it, `409` if `PANEL_DOMAIN` is not set |
| `DELETE /users/:id/email` | `{password}` | `204` — no recovery email, and any reset link already sent stops working |
| `PUT /users/:id/password` | `{password, newPassword}` | `204` — on your own account every *other* session ends and this one is re-issued; on a colleague's, every session they have ends |
| `POST /users/:id/totp/setup` | `{password}` | `{secret, otpauthUrl, qrDataUrl}` — mints a secret and holds it pending; nothing about the login changes yet. `409` if 2FA is already on |
| `POST /users/:id/totp/enable` | `{code}` | `{recoveryCodes[]}` — a code from the app arms 2FA and returns ten single-use codes, the only time they are readable. Also signs out your other sessions, which never passed a second factor |
| `POST /users/:id/totp/recovery-codes` | `{password}` | `{recoveryCodes[]}` — issues a fresh set; the previous ones stop working |
| `DELETE /users/:id/totp` | `{password}` | `204` — turns 2FA off: yours, or a colleague's who lost their phone |

`password` in these bodies is always **your own** — the signed-in admin's — whichever account is being
changed: a colleague's password gets reset precisely because nobody knows it any more. A wrong one is
`403`, never `401`: the request was authenticated — the session is valid and stays valid — and it is
this one action that is refused; a `401` would tell every client its session had expired over a typo.

The same `403` answers three more cases:

- a change to the owner's account by anyone but the owner;
- `totp/setup`, `totp/enable` and `totp/recovery-codes` on someone else's account — nobody can enrol a
  phone they are not holding (turning it *off* is allowed, and is how a colleague gets back in);
- an API key on any route here that takes a `password`, and on `totp/enable`. A key belongs to no
  account, so it has no password to prove. Listing, adding and removing admins work with a key.

### Sites
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /sites` | – | `{items: SiteSummary[]}` — `status` is the registry's lifecycle state (what the last job left the site as, never re-read from Docker); `up`, `httpStatus` and `lastCheckedAt` are the uptime probe's own answer. They can disagree, and that disagreement is the interesting case — docs/site-lifecycle.md → Status vs. health |
| `POST /sites` | `{title, slug?, serverId?, domainMode: "dev"\|"custom", domains?, phpVersion?, locale?, adminUser, adminEmail?, adminPassword?, discourageSearchEngines?, plugins?: {catalogIds?[], extraWporgSlugs?[]}}` | `202 {job}` — omitted `adminPassword` is generated and returned once in `job.result.adminPassword`; omitted `adminEmail` uses the `defaultAdminEmail` setting, and is a `400` while that is empty; omitted `serverId` uses the `defaultServerId` setting; omitted `catalogIds` (or `plugins`) installs the catalog's `isDefault` plugins, as the New Site wizard preselects them, and `catalogIds: []` installs none of the catalog. `extraWporgSlugs` are installed as given, not verified up front — a slug the directory does not have becomes a warning in the create job. Use `GET /plugins/search` to resolve names to slugs first |

`locale` takes any wp.org locale code (`cs_CZ`, `de_DE_formal`, `pt_PT_ao90`, …); `GET /meta` lists the
ones the panel's pickers offer. Every new site has WordPress's bundled plugins — Akismet and Hello
Dolly — removed right after the install, before the requested plugins go on.
`discourageSearchEngines` defaults to **true**: the site is created with WordPress's "Discourage
search engines from indexing this site" (Settings → Reading) switched on. Pass `false` for a site
that should be indexed from the start — nothing else turns it off later, go-live included.
| `GET /sites/:slug` | – | `SiteDetail` (incl. `containerState` — `unknown` when the hosting server cannot be reached; the rest is served from the registry — `url`, monitoring snapshot) |
| `DELETE /sites/:slug` | `?finalBackup=true\|false` (default true; `false` skips the final backup) | `202 {job}` |
| `POST /sites/:slug/start` · `/stop` · `/restart` | – | `202 {job}` |
| `PUT /sites/:slug/php` | `{phpVersion}` | `202 {job}` — auto-rollback if the site stops responding |
| `POST /sites/:slug/go-live` | `{domains: [primary, ...aliases], keepDevAlias?: true, manageDns?: false}` | `202 {job}` — `manageDns: true` creates the A records via the DNS provider first (zone must be in the account) |
| `PUT /sites/:slug/domains` | `{domains}` | `202 {job}` — general domain edit |
| `POST /sites/:slug/move` | `{targetServerId, quiesce?: "maintenance"\|"stop"\|"none"}` | `202 {job}` — default quiesce: live site `maintenance`, dev site `none`; see docs/multi-server.md |
| `POST /sites/:slug/move/finalize` | – | `202 {job}` — tear down the source copy of a moved site now instead of waiting for DNS verification |
| `POST /sites/:slug/reconcile` | – | `202 {job}` — re-apply the current isolation policy (network, capability drops, resource ceilings, mail credential). Rolls back only if Docker refuses to create or start the replacement: a container that starts and then fails the HTTP smoke check is left in place and the job still **succeeds**, with the warning in its log |
| `POST /sites/reconcile-all` | – | `202 {jobs}` — the same for every site, one job each, serialized per server |
| `PUT /sites/:slug/mail-suspension` | `{suspended, reason?}` | `SiteDetail` (sync) — stop or resume the relay accepting this site's mail |
| `PUT /sites/:slug/backups-enabled` | `{enabled}` | `SiteDetail` (sync) — take this site in or out of the scheduled backup run (`backupCron`, which is not necessarily nightly). Only that run: manual, pre-restore, move and final backups still happen either way (docs/backup-restore.md) |
| `PUT /sites/:slug/offsite-enabled` | `{enabled}` | `SiteDetail` (sync) — stop (or resume) copying this site's backups to the offsite destinations. Copies already made are kept |
| `GET /sites/:slug/traffic` | `?days=1..365` (default 30) | `SiteTrafficDto` — visitor statistics; see below |

### Backups
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /backups` | `?siteSlug=&deleted=true\|false&type=&serverId=&limit=&offset=` (`type` a comma list; `siteSlug=panel` = the panel's own snapshots) | `{items, total, deletedSites}` — every backup, newest first, each a `Backup` plus `siteTitle` and `siteDeleted` (no site of that slug exists any more). `deleted=true` keeps only those; `false`, everything else. `deletedSites: [{slug, backups, complete, lastBackupAt, sizeBytes}]` names every deleted site that still has backups, whatever the filters (`complete` leaves out failed ones, which have no files) |
| `GET /sites/:slug/backups` | – | `{items: Backup[]}` — each carries `filesPresent`, `rootPath` and `copies[]` (one per offsite destination) |
| `POST /sites/:slug/backups` | `{note?}` | `202 {job}` |
| `POST /backups/:id/restore` | `{skipPreRestoreBackup?: false}` | `202 {job}`; `409` when the backup is offsite-only (fetch it back first) or lives on another server |
| `GET /backups/:id/download` | – | tar stream; `409` when the backup is offsite-only |
| `POST /backups/:id/offsite` | `{destinationId?}` | `202 {job}` — copy now, or retry a copy that gave up (resets its attempt counter). `400` when every destination already has it |
| `POST /backups/:id/fetch` | `{destinationId}` | `202 {job}` — download an offsite copy back onto the site's **current** server, checksums verified |
| `DELETE /backups/:id` | `?keepOffsite=true\|false` (default false) | `204`; `409` while the backup is being written, being copied offsite, or a restore/backup/move/delete job for its site is queued or running. Default deletes the offsite copies too; `keepOffsite=true` removes only the local files and answers `200 {keptOffsite}` |

### Offsite destinations (docs/backup-restore.md#offsite-copies)

Credentials are write-only: a destination is created and patched with `{provider, config, secrets}`,
and read back with `config` (non-secret fields) plus `secretsSet` — the names of the secrets on file,
never their values. A `secrets` key omitted on `PATCH` keeps its stored value; an empty string clears
it. `provider` is immutable.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /backup-destinations` | – | `{items: Destination[]}` |
| `POST /backup-destinations` | `{name, provider, config, secrets, enabled?, copyTypes?, retentionScheduled?, retentionMode?, bwlimit?, encryption?: 'none'\|'crypt', cryptPassword?, cryptSalt?, backfill?: 'none'\|'latest'\|'all'}` | `201 Destination` — with `encryption: 'crypt'` the response additionally carries `crypt: {password, salt}` **once**: the generated passphrase, which exists nowhere else but `panel.db`. Supply `cryptPassword` **and** `cryptSalt` to adopt an existing one instead (re-adding a destination after losing the database) |
| `POST /backup-destinations/test` | as above (unsaved values) | `{ok, checks: [{name, ok, detail}]}` — probes the image, a listing, a write and a delete from server 1 |
| `POST /backup-destinations/:id/test` | – | as above, with the stored credentials |
| `PATCH /backup-destinations/:id` | any field except `provider` | `Destination`; `409` when changing `encryption` on a destination that already holds a copy — rclone cannot re-key encrypted content, and the object names derive from the passphrase |
| `POST /backup-destinations/:id/passphrase` | – | `{password, salt}` — read the crypt passphrase back. The only endpoint that returns a stored secret, and it exists because the alternative to remembering it is losing every backup there. `400` when the destination is not encrypted |
| `DELETE /backup-destinations/:id` | `?deleteRemote=true\|false` (default false) | `{removed, forgotten}` — the objects are left in place; with `deleteRemote=true`, `202 {job}` that purges only the paths this panel wrote |
| `GET /backup-destinations/:id/copies` | `?status=&limit=&offset=` | `{items: Copy[], total}` |
| `GET /backups/overview` | – | `{destinations, lastSuccessAt, last24h: {completed, failed, pending}, failures}` |

`provider` is one of `s3`, `s3-compatible`, `sftp`, `ftp`, `webdav`, `rclone`; the fields each one
takes are defined in `panel/shared/backupProviders.ts`, which also drives the form and the validation.

`encryption` defaults to `none`. With `crypt`, contents and file names are encrypted on the server
before upload (rclone's crypt backend) and the setting is fixed from the first copy onwards — see
docs/backup-restore.md#encryption-optional-off-by-default.

### Visitor statistics

`GET /sites/:slug/traffic?days=30` answers from rollups the panel builds from each server's Traefik
access log, so the cost does not depend on the range:

```json
{ "days": 30, "bucket": "day", "since": 1789000000000, "collecting": true,
  "totals": { "requests": 41233, "pageViews": 9871, "visitors": 4102,
              "botRequests": 22140, "errors": 3, "bytes": 918273645, "avgMs": 214 },
  "series": [ { "ts": 1789000000000, "requests": 1411, "pageViews": 322, "visitors": 140,
                "botRequests": 801, "errors": 0, "bytes": 30112233, "avgMs": 209 } ],
  "topPages":     [ { "path": "/blog/hello-world/", "views": 812 } ],
  "topReferrers": [ { "referrer": "google.com", "views": 391 } ],
  "topCountries": [ { "country": "DE", "visitors": 2811 } ],
  "topCrawlers":  [ { "crawler": "Googlebot", "requests": 9042, "lastSeenAt": 1789000000000 } ],
  "topIps":       [ { "ip": "203.0.113.7", "requests": 4120, "pageViews": 0, "botRequests": 4120,
                      "errors": 0, "country": "US", "lastSeenAt": 1789000000000 } ],
  "ipsCollected": true, "ipRetentionDays": 7, "countryData": true }
```

- `bucket` is `hour` for `days` ≤ 2 and `day` beyond. `series` is dense — empty buckets are present
  with zeroes, because "nobody came" is an answer.
- `requests` counts everything Traefik routed to the site; `pageViews` counts pages (not assets, not
  `/wp-admin`, not `/wp-json`) fetched by something that is not a crawler. The panel's own uptime
  probe is excluded from all of them.
- `visitors` is a count of distinct one-way hashes of address + user agent, salted with a key that is
  regenerated every night and mixed with the site slug. No visitor address is ever written to disk,
  the same person is a different id on the next day and on another customer's site — and in `totals`
  the figure is therefore **daily uniques added up**, not a de-duplicated 30-day number.
- `collecting: false` means the site's server has never emitted an access-log line: its Traefik
  predates this feature and has not been redeployed. Redeploy the stack; nothing is backfilled.
- `topCountries` counts **distinct visitors**, not requests — one reader who opened ten pages is one
  German. Countries come from the regional internet registries' own delegation files, which the panel
  downloads weekly and queries locally, so no address is ever sent anywhere. They record the country
  the address block was *registered* in: right for consumer ISPs, approximate for corporate and cloud
  ranges. `countryData: false` means the table has not been downloaded yet (a fresh install, or a
  panel with no outbound internet) and `topCountries` is empty rather than wrong.
- `topCrawlers` counts requests with the version stripped, so `Googlebot/2.1` and `Googlebot/2.0` are
  one row. These requests are excluded from `visitors`, `pageViews`, `topPages` and `topCountries`.
- `topIps` is the one place an address is stored, and it exists for the operational question the
  anonymous counters cannot answer: who is generating this load. It includes crawlers, so the top of
  it is usually a search engine. It has its own short retention (`ipRetentionDays`, default **7
  days**, separate from `trafficRetentionDays`) and `PUT /settings {"trafficStoreIps": false}` turns
  it off *and* deletes what is already stored — after which `ipsCollected` is false and `topIps` is
  empty while every other number keeps working. Traefik's own container log holds these addresses
  either way, for as long as Docker keeps it.

`SiteSummary` (and so `GET /sites`) carries `recentTraffic: {visitors, pageViews} | null` for the
last 24 hours, and `wp: {scannedAt, updates, vulnerable, worstSeverity, coreUpdate} | null` —
the WordPress snapshot's counters, `null` until the site has been scanned once.

Backups carry a `serverId` — the server whose disk holds the files — and a `rootPath`, the backup
location in force when they were taken. Download works wherever the backup lives; restore is rejected
when the site has since moved to a different server, unless the backup has an offsite copy that can be
fetched onto the current one (docs/backup-restore.md).

### Servers (multi-server fleets — see docs/multi-server.md)
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /servers` | – | `{items: Server[]}` (incl. `status`, `sitesCount`, `publicIp`, `hostKeySha256`) |
| `GET /servers/ssh-public-key` | – | `{publicKey}` — the key to authorize on new servers |
| `POST /servers` | `{name, sshHost, sshPort?: 22, sshUser?: "wpl7-panel", devDomain, dnsProvider?, publicIp?, provision?: false, rootUser?: "root", acmeEmail?}` | register an already-provisioned server: `201 {server, checks, job}` or `502` with `error.details.checks`; with `provision: true` (blank VPS, `acmeEmail` required): `202 {server, job}` |
| `GET /servers/:id/info` | `?refresh=true` skips the one-minute cache | what the machine is: `{reachable, error, os, kernel, arch, hostname, cpuModel, cpus, memTotalBytes, uptimeSeconds, dockerVersion, readAt}`. Every field is independently nullable; `reachable: false` means the server could not be asked at all. Server 1 is read over the panel's host shell, so `os` is the host's, not the container's |
| `POST /servers/:id/test` | – | `{ok, checks}` — synchronous re-verification |
| `POST /servers/:id/update` | `{rootUser?: "root"}` | `202 {job}` — re-push the provision bundle + re-run setup.sh (this is how worker stacks are upgraded) |
| `PATCH /servers/:id` | any of `name, sshHost, sshPort, sshUser, publicIp, devDomain, dnsProvider`; `retrustHostKey: true` clears the pinned SSH host key after a legitimate reinstall (allowed for server 1 too); `backupRoot: string\|null` sets where this server keeps its backups (`null` = the default) | updated `Server` |
| `GET /servers/:id/storage` | `?path=` validates a candidate instead of describing the current location | `{backupRoot, defaultRoot, isDefault, exists, writable, visibleInPanel, reason, mountInstructions, disk, backups: {count, bytes}, mounts[]}` |
| `POST /servers/:id/backups/relocate` | `{to}` | `202 {job}` — copy every backup on this server to `to`, verify each one, remove the originals, then set the location |
| `GET /servers/:id/terminal` | WebSocket upgrade; `?cols=&rows=` initial size; same-origin `Origin` required when present; Bearer keys accepted | interactive **root shell**. Binary frames = terminal bytes both ways; text frames = JSON control: client sends `{"t":"resize","cols","rows"}`, server sends `{"t":"status"\|"ready"\|"exit"\|"error", …}` |
| `DELETE /servers/:id` | `?force=true` also drops backup *records* still pointing at the server (files untouched) | `{removed, note}` — refused (409) while sites live there or while a moved site still has its old copy parked there; server 1 can never be removed |

### WordPress management (see docs/updates.md)
Every plugin and theme change the panel makes — install, activate, deactivate, update, delete, one
at a time or in bulk — runs as the site's administrator (WP-CLI's `--user`), as it would from
wp-admin: the one the panel created while it still is one, else the oldest administrator, and no
user at all (with a warning in the job log) on a site without one. Plugins run code of their own
then: an activation hook that makes whoever activated the plugin its owner, an uninstall routine that
checks that user may.

| Method & path | Body | Returns |
|---|---|---|
| `GET /sites/:slug/wp/status` | – | the site's inventory **snapshot**: `core`, `plugins[]`, `themes[]`, `counts`, `feed`. A database read — no `docker exec` — so it answers instantly and answers for a stopped site. `scannedAt: null` means never scanned (which is not "nothing installed"); `partial: true` means the listing had to run with `--skip-plugins`, so update info from premium plugins is missing |
| `POST /sites/:slug/wp/scan` | – | re-reads this site now and returns the fresh snapshot. **Synchronous** (≈5-20 s: `wp plugin list` re-checks wordpress.org), rate-limited to 10/min, `409` when the container is not running |
| `POST /sites/:slug/wp/bulk` | `{ops: [{kind:"plugin"\|"theme"\|"core", slug?, action:"update"\|"activate"\|"deactivate"\|"delete"}], backupFirst?: false, healthCheck?: true}` | `202 {job}` (`wp.bulkTask`) — every operation in one job: optional `pre_update` backup, the operations in order, optional HTTP health check, then a re-scan. `400` listing the offending ops when the snapshot says one of them cannot run |
| `GET /sites/:slug/wp/plugins` | – | installed plugins w/ available updates, read **live** from the container (sync, `409` when stopped). The snapshot above is what the UI uses |
| `POST /sites/:slug/wp/core-update` | – | `202 {job}` |
| `POST /sites/:slug/wp/plugins` | `{source: {kind:"wporg",slug}\|{kind:"catalog",id}, activate?}` | `202 {job}` |
| `POST /sites/:slug/wp/plugins/:name/activate` · `/deactivate` · `/update`; `DELETE …/plugins/:name` | – | `202 {job}` |
| `POST /sites/:slug/wp/themes/:name/activate` · `/update`; `DELETE …/themes/:name` | – | `202 {job}` (`wp.themeTask`). Deliberately no theme *install*. wp-cli refuses to delete the active theme or its parent and the panel never passes `--force` |
| `POST /sites/:slug/wp/users/reset-password` | `{user}` | `{newPassword}` (sync, never stored) |
| `GET /sites/:slug/wp/maintenance` | – | `{enabled}` (current state) |
| `PUT /sites/:slug/wp/maintenance` | `{enabled}` | sync |
| `POST /sites/:slug/wp/test-email` | `{to}` | `{accepted, detail}` — real end-to-end `wp_mail()` |
| `POST /sites/:slug/wp/admin-login` | – | `{url, user, expiresInSeconds}` — one-click login: open `url` to land in `wp-admin` signed in. Single-use, expires after 120 s, logs in as the site's administrator (oldest administrator if that account is gone) |
| `POST /sites/:slug/wp/cli` | `{args: ["option","get","siteurl"], stdin?, async?: false, timeoutMin?: 10}` | `{stdout, stderr, exitCode}` (sync, 55 s cap; `504 timeout` past it). With `async: true`: `202 {job}` (`wp.cli`) — the output goes to the job log as it arrives, and the command may run up to `timeoutMin` (1-60) minutes; `409` for a stopped or busy site (docs/jobs.md#commands-in-a-site). `stdin` is text the command reads on its stdin, then end-of-file — what a `-` value (`--message=-`) takes, or the values `--prompt` asks for, one per line: at most 64 KB counted in UTF-8 bytes. It is in no summary or log (they say `+ stdin, 1.2 KB`); a synchronous call writes it nowhere, and a queued job keeps it only until it ends. A `wp godmode` command that waits is not queued: `400` with `async: true` ([WP Godmode](#wp-godmode)) |
| `GET /sites/:slug/wp/cli/help` | `?command=godmode` (words only: `godmode chat send`, `plugin list`) | `{command, help, panel?}` — `wp help` for that command, a plugin's own included, in its words and for the version the site runs; no `command` lists them all. WP-CLI's global parameters (`--user`, `--skip-plugins`, …), the same for every command, are left out. `panel`, for a few plugins' commands, says how to reach them through the panel. `404` when the site has no such command. Read only, so an AI app reads it before running a command it has not met without being asked ([mcp.md](mcp.md#wp-godmode)) |
| `GET /sites/:slug/godmode/chats` | `?parent=<chatId>` | the site's WP Godmode chats and what each is doing, as `wp godmode chat list` prints them, or one chat's or agent's sub-chats ([below](#wp-godmode)) |
| `GET /sites/:slug/godmode/agents` | – | its agents, as `wp godmode agent list` prints them; an agent's id is a chat id ([below](#wp-godmode)) |
| `GET /sites/:slug/godmode/chats/:chatId` | `?wait=0-40&after=&last=&pending=` | one chat: `wp godmode chat read` at once, or with `wait` above 0 `chat wait` for up to that many seconds ([below](#wp-godmode)) |
| `POST /sites/:slug/shell` | `{command: "du -sh wp-content", timeoutMin?: 10}` | `202 {job}` (`site.shell`) — `sh -c <command>` inside the site's container as www-data, in the WordPress folder; output in the job log; a non-zero exit fails the job. `409` for a stopped or busy site |
| `POST /sites/:slug/wp/rest` | `{method?: "GET", route: "wp/v2/posts?per_page=5", body?, auth?: {username, applicationPassword}, async?: false, timeoutMin?: 10}` | `{status, statusText, contentType, headers, body, truncated, sizeBytes, durationMs, error}` — the site's answer, whatever its status (sync, 45 s cap, the first 1 MB of the body; `502` when nothing answered at all). With `async: true`: `202 {job}` (`wp.rest`) — the answer goes to the job log, and anything but a 2xx fails the job. Made from inside the site's container, signed in with the application password when `auth` is given (docs/jobs.md#rest-api-requests); `409` for a stopped or busy site |
| `GET /sites/:slug/wp/recipes` | – | `{items: SiteLicense[]}` — where each plugin recipe stands on this site (`status`: `active`, `failed`, `inactive`, `not-set-up`, `released`, `unknown`), from the inventory snapshot and the last run; a database read (docs/licenses.md) |
| `POST /sites/:slug/wp/recipes/apply` | `{recipeId?, hook?: "afterInstall"\|"verify"}` | `202 {job}` — run the recipes now (every recipe whose plugin is on the site, or the one named). Starts a stopped site for it. The job fails when a recipe does |

#### WP Godmode

[WP Godmode](https://wpgodmode.com), the AI plugin for WordPress, has WP-CLI commands of its own once
its *Remote control (WP-CLI)* feature is on: `wp godmode chat send | wait | read | answer | cancel`,
`agent list | create`, and more. `GET /sites/:slug/wp/cli/help?command=godmode` has the plugin's own
guide to them: the loop, the cards, the errors. Three endpoints run the reading ones with arguments
the panel builds, which is why they are GETs an AI app may call without being asked each time
([mcp.md](mcp.md#wp-godmode)). They are Manage, not Read only: they run a command in the site, and a
chat can quote anything the site holds.

- `GET /sites/:slug/godmode/chats` runs `wp godmode chat list`, or with `parent` (a chat or agent id)
  `chat list --parent=<id>`: that one's sub-chats.
- `GET /sites/:slug/godmode/agents` runs `wp godmode agent list`.
- `GET /sites/:slug/godmode/chats/:chatId` runs `wp godmode chat read <chatId>`, or, with `wait` of
  1-40, `wp godmode chat wait <chatId> --timeout=<wait>` — which answers as soon as the chat and its
  sub-chats have all stopped working, or one of them asks something, and with `state: "working"` if
  neither happened in time (`"unknown"`: the plugin lost its connection; wait again). `chatId` is a
  UUID. `after` (-1 or more) is the turn cursor an earlier answer gave, -1 meaning from the start;
  `last` (1-50) is how many turns a read shows when it has no `after`; `pending=true` reads only the
  cards waiting for an answer, in full — a wait and a read cut long plans (`plan_cut: true`) and
  texts, and a card goes to the user whole before it is answered. A wait takes no `last`, `pending`
  goes alone, and anything else is a `400`.

They answer with the plugin's JSON as it printed it — `{"ok": true, …}`, and `{"ok": false, "error":
{"code", "message"}, …}` too. That is WP Godmode's answer (no such chat, the feature not in its plan),
not the panel failing to get one, so it comes back `200` like any other: check `ok`. A read carries
its transcript in `turns`; a wait, once nothing works any more, in `digest`. Every answer is held to
the plugin's own 20,000 characters (`--max-chars`), whatever a `wp-cli.yml` on the site says. A site
whose WP Godmode is missing, inactive or too old for the command (`'godmode' is not a registered wp
command`) is `409 conflict`, with `details: {exitCode, stdout, stderr}`: asking again will not change
it. When the command prints no answer at all — WordPress fails to load — it is `502 bad_gateway` with
the same details, each cut to 2,000 characters.

They are always synchronous. A wait sits out up to 40 seconds of a chat working, and as a job it would
hold the server's `exec` lane — every other site's commands there — the whole time; for the same reason
`POST /sites/:slug/wp/cli` and custom schedules refuse a queued `wp godmode chat wait`, and any `wp
godmode` command given a `--wait`. The same request made again while the first still runs — an app
retrying a wait its client gave up on — joins it rather than running the command twice, and a caller
that hangs up stops holding the connection to the container. What changes a
chat — sending, answering, cancelling — is a command: `POST /sites/:slug/wp/cli {"args": ["godmode",
"chat", "send", "<chatId>", "--message=-", "--label=<your app>"], "stdin": "<the message>"}`.

### Files (Web FTP)
The Files tab over HTTP ([web-ftp.md](web-ftp.md) explains the why). Paths are relative to the site's
WordPress folder (`path=` empty = the folder itself) and can never leave it. Everything runs inside
the site's container as `www-data`: `409` when it is stopped, `403` for what the site's own user may
not touch, and changes answer `409 job_conflict` while a restore, move, re-creation or delete runs on
the site (a backup blocks nothing). A job queued while a change is under way starts when it is done.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /sites/:slug/files` | `?path=` | `{path, writable, entries[], truncated}` — per entry: `name`, `nameOk`, `type` (`file`\|`dir`\|`link`\|`other`), `target`/`targetType` for links (`targetType: null` = dangling), `size`, `mtimeMs`, `mode` (octal digits), `uid`, `gid`, `readable`/`writable` for `www-data`. At most 10,000 entries |
| `GET /sites/:slug/files/content` | `?path=` | the raw bytes (≤ 8 MiB) as a download, with `ETag: "<sha256>"`. `409` for a folder or a bigger file |
| `PUT /sites/:slug/files/content` | `?path=&lint=php`; body: the bytes, `application/octet-stream`, with a `Content-Length` | `{path, entry, etag}`. `If-Match: "<etag>"` saves only over that version, `If-Match: *` only over a file that exists, `If-None-Match: *` only creates — `412 precondition_failed` otherwise; of two saves from one version, one lands. `lint=php` refuses PHP that does not parse: `422 syntax_error`, `details.line`. Atomic: temp file + rename, permissions kept |
| `GET /sites/:slug/files/download` | `?path=` | a file as it is, a folder as `.tar.gz` (the site folder as `<slug>.tar.gz`). 3 at a time per server, `429` beyond |
| `GET /sites/:slug/files/search` | `?path=&q=&mode=name\|content&case=&regex=&include=*.php,*.js` | `{mode, path, matches[], truncated, timedOut}` — names: `{path, type}`; contents: `{path, line, text}`, binary files skipped. 1,000 matches or 45 s; 30/min |
| `PUT /sites/:slug/files/uploads/:id` | `?path=&offset=&size=&overwrite=`; body: one chunk ≤ 8 MiB | `{received, written}` — `written` is set by the chunk that completes the file; that chunk sent again (its answer lost) gets the same answer. `409` with `details.received` when `offset` is not what the server has: continue from there. Offset 0 needs the folder to exist and 1 GiB to stay free |
| `DELETE /sites/:slug/files/uploads/:id` | `?path=` | `204` — abandons the upload |
| `POST /sites/:slug/files/mkdir` | `{path}` | `{entry}` |
| `POST /sites/:slug/files/move` | `{from, to, overwrite?: false}` | `{entry}` — rename or move; a folder is never replaced, nor moved into itself |
| `POST /sites/:slug/files/copy` | `{from, to}` | `{entry}` — never over an existing entry; links copied as links |
| `POST /sites/:slug/files/delete` | `{paths: [...]}` (≤ 200) | `{deleted}` — all are checked first, so one bad path deletes nothing; a link is removed, not what it points at |
| `POST /sites/:slug/files/chmod` | `{path, mode: "644"}` | `{entry}` — not on links |
| `POST /sites/:slug/files/fix-ownership` | `{path?: ""}` | `{ok}` — `chown -R -h 33:33` inside the container: hands what root left behind back to the site |
| `POST /sites/:slug/files/extract` | `{path, to?: "", overwrite?: false}` | `202 {job}` (`files.extract`) — refuses unsafe archives whole, skips symlinks, lists what is in the way unless `overwrite` |
| `POST /sites/:slug/files/compress` | `{paths: [...], to: "dir/name.zip", overwrite?: false}` | `202 {job}` (`files.compress`) — entries of one folder, into a `.zip` in that folder |

### FTP & SFTP logins (see docs/ftp.md)
A site's logins for desktop FTP and SFTP clients. Each reaches its own site's files and nothing else;
none exist by default. Usernames are unique across the panel (`409` when taken - the answer does not say
by which site). A password is returned once, when the panel generated it, and never again; the panel
stores a hash. Changing, resetting or deleting a login ends the site's open FTP sessions. Changes answer
`409` while the site is being created or deleted.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /sites/:slug/ftp` | – | `{enabled, serverId, serverName, endpoint, status, applied, paused, users[]}` — `endpoint` = `{host, sftp: {port, hostKeys[{type, fingerprint}]}, ftp: {available, reason, port, passivePorts, certFingerprint}}`; `status.state` is `off`\|`starting`\|`ready`\|`error`\|`unreachable`; `applied: false` while the last change has not reached the server |
| `POST /sites/:slug/ftp/users` | `{username, password?, folder?: "", expiresAt?: <unix ms>\|null}` | `201 {user, password}` — `password` is the generated one, or `null` when you sent one (12-128 characters). 30/min |
| `PATCH /sites/:slug/ftp/users/:id` | `{folder?, expiresAt?}` | `{user}` |
| `POST /sites/:slug/ftp/users/:id/password` | `{password?}`, or no body | `{user, password}` — generated unless you sent one. 30/min |
| `DELETE /sites/:slug/ftp/users/:id` | – | `204` |
| `GET /servers/:id/ftp` | – | `{serverId, enabled, endpoint, status, sites, logins, activeLogins}` — `activeLogins` leaves out expired ones; `status.checkedAt` is `null` until the panel has looked at the server since it started, so `off` with a date is confirmed |

The ports and the switch are settings: `ftpEnabled`, `ftpSftpPort`, `ftpOfferFtps`, `ftpPort`,
`ftpPassivePortStart`, `ftpPassivePortEnd` in `PUT /settings` (ports that clash with SSH, the web or
each other, and passive ranges of fewer than 2 or more than 100 ports, are refused with `400`;
switching FTP off never is).

### Security (see docs/security.md)
A site's protection, its malware scans and their findings, and the fleet's blocked addresses. A site's
own protection, scans and quarantine need **Manage**; the block list, the never-block list and the
firewall need **Full**. The fleet defaults are settings (`securityLevel`, `securityOverrides`,
`securityAutoBlock`, `securityRules`, `scanEnabled`, `scanOnFinding` … in `PUT /settings`; every key in
docs/security.md#settings).

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /security/overview` | – | `{fleet, fleetPolicy, sites[], servers[], blocked24h, activeBlocks, recentBlocked[], scansInFlight}` — each site says what it set for itself in `own: {level, changes, customRules, scanEnabled, scanOnFinding}` (`null`: the default's) |
| `POST /security/sync` | – | the overview, once every server's rules and blocked addresses are in line |
| `GET /sites/:slug/security` | – | `{level, overrides, customRules, policy, fleet, status, rejections, blocked7d, scan}` — `level: null` follows the default; `policy` is what is in force, with `sources` saying where each part comes from; `status.unprotected` says why it is not in force when it is not |
| `PUT /sites/:slug/security` | `{level?: "off"\|"standard"\|"strict"\|null, overrides?, customRules?}` | the same. Each part left out stays as it is; a rule without an `id` is given one |
| `GET /sites/:slug/security/blocked` | `?limit=100&rule=` | `{items[], counts7d}` — the blocked requests, newest first; `ip` is `null` while addresses are not stored |
| `GET /sites/:slug/security/scan` | – | `{scan, history[]}` — `scan.enabled`/`onFinding` are the site's own (`null`: the default's), `scan.effective` what is in force, `scan.defaults` the fleet's |
| `POST /sites/:slug/security/scan` | – | `202 {job}` — one scan per site at a time: asking again answers the one waiting or running |
| `PUT /sites/:slug/security/scan/settings` | `{enabled?: boolean\|null, onFinding?: "report"\|"quarantine-confirmed"\|"quarantine-all"\|null}` | the site's scan settings; `null` follows the fleet's |
| `GET /sites/:slug/security/findings` | `?status=open\|ignored\|resolved\|quarantined\|all` | `{items[], counts}` — the most serious first; each says whether it `canReinstall` or `canPutBack`, why it cannot be quarantined (`quarantineProblem`, `null` when it can), and `zipReview`: the catalog zip whose check flagged the same file and waits on a review (`null` when none) |
| `POST /sites/:slug/security/findings/:id/ignore` · `…/unignore` · `…/resolve` | – | the finding |
| `POST /sites/:slug/security/findings/:id/reinstall` | – | `202 {job}` — `wp.reinstall`, then a scan |
| `POST /sites/:slug/security/findings/:id/put-back` | – | `202 {job}` — a changed WPL7 file written again from inside the site, then the scan; `409` while the site is not running |
| `POST /sites/:slug/security/findings/:id/quarantine` | – | the quarantined file; `400` with the reason when it may not be moved |
| `GET /sites/:slug/security/quarantine` | – | `{items[]}` |
| `POST /sites/:slug/security/quarantine/:id/restore` · `DELETE /sites/:slug/security/quarantine/:id` | – | the item; `409` once it is no longer in quarantine |
| `GET /security/scans` · `POST /security/scans` | `POST {slugs?}` — every site that is scanned when left out | `{items[], inFlight}` · `{queued[], already[]}` |
| `GET /security/blocks` | `?state=active\|history&q=&limit=100&offset=0` | `{items[], total, activeCount, maxActive}` |
| `POST /security/blocks` | `{address, minutes?: number\|null, note?, siteSlug?}` | `201` the block — `minutes` left out or `null`: until lifted. `400` with the reason for an address that is never blocked, `409` for one blocked already |
| `DELETE /security/blocks/:id` | – | the block, lifted (not counted as a repeat) |
| `GET /security/never-block` · `POST` `{address, note?}` · `DELETE /security/never-block/:id` | – | `{items[], admins[]}` · `201` the entry (blocks on it are lifted) · `204` |
| `GET /security/firewall` · `POST /security/firewall/sync` | – | `{enforced, activeBlocks, servers[{state, message, appliedAt, networkEntries, httpProxied, httpDirect, httpSkipped}]}` |
| `GET /security/check` | `?address=` | `{address, valid, problem, protectedBecause, blockedBy, country}` |
| `GET /security/detection` | – | `{mode, tracked, maxTracked, decisions[]}` — the detector's recent decisions, including why it did not block |

### Fleet-wide WordPress (bulk management — see docs/updates.md)
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /wp/inventory` | `?kind=plugin\|theme\|core` (default `plugin`), `filter=` any comma-separated mix of `updates,vulnerable,inactive,closed` (AND-ed), `q=`, `serverId=`, `siteSlug=`, `includeStopped=true` | one row per component slug with its per-site rows: `rows[]` (aggregate counts, distinct `versions`, `worstSeverity`, `closedOnWporg`, `feedCoverage`, `siteRows[]`), `fleet` counters, `feed`, and the current/last `scanJob`. Reads the snapshot only |
| `POST /wp/bulk` | `{action: "update"\|"activate"\|"deactivate"\|"delete"\|"core-update", targets: [{siteSlug, kind, slug?}], backupFirst?: false, healthCheck?: true}` | `202 {batch, jobs[], skipped[]}` — **one `wp.bulkTask` job per site**, sharing `batch.id`. Sites whose job lane is busy come back in `skipped` (retryable); a target that cannot run the action is a `400` with every problem in `error.details` and **nothing queued** |
| `GET /wp/batches?limit=10` | – | recent runs with rolled-up job counts |
| `GET /wp/batches/:id` | – | `{batch, jobs}` — one poll drives the whole progress table; each job carries its own `result.ops[]`, `result.backupId` and `result.healthy` |
| `POST /wp/scan` | – | `202 {job}` (`wp.scanAll`) — refresh the whole fleet's snapshot. Lane-less; `409` while one is queued or running |

`GET /jobs?batchId=<id>` filters the job list to one bulk run, and every `JobDto` carries
`batchId` (null outside a run).

### Mail (see docs/mail.md)
| Method & path | Body | Returns |
|---|---|---|
| `GET /mail/status` | – | per-server relay/signer health checks, queue depth, reverse-DNS verdicts |
| `GET /mail/messages?siteSlug=&status=&serverId=&search=&hours=&limit=&offset=` | – | `{items, total}` — one row per recipient; `siteSlug` comes from the sending container, not the `From:` header |
| `GET /mail/stats?hours=24` | – | totals by status, per-hour buckets, per-site volume with `overBudget` / `highFailureRate` abuse flags |
| `POST /mail/ingest` | – | parse each relay's log now instead of waiting for the one-minute tick |
| `GET /mail/queue?serverId=` | – | postfix queue, with the deferral reason per recipient |
| `POST /mail/queue/:serverId/flush` | – | retry everything now |
| `DELETE /mail/queue/:serverId/:queueId` | – | `204`; `queueId=ALL` empties the queue |
| `POST /mail/test` | `{from, to, serverId?, subject?}` | injects into the relay, bypassing WordPress |
| `GET /mail/setup` | – | the whole setup guide: delivery mode, whether DNS automation is on, per-server hostname/rDNS/port-25 state, per-provider reverse-DNS instructions, and the per-domain record plan |
| `GET /mail/domains?domain=` | – | per-domain SPF/DKIM/DMARC checks against live DNS + the records to publish, each with `automation.state` (`ready` = the panel can write it) |
| `POST /mail/domains/:domain/publish` | – | publishes what it safely can: SPF is **merged** into the record already published, DKIM generates and distributes a key first if needed, an existing DMARC policy is left alone. Returns a per-step outcome. `400` without a DNS token or when the zone is not in the account |
| `PUT /mail/servers/:serverId/hostname` | `{hostname}` | changes the name the relay announces. Applied live (`postconf` + `postfix reload`, so the queue is untouched) and persisted to `/srv/mail/relay.env`, which compose reads back as an `env_file` so it survives a container recreate; after a restart the panel puts it back within a minute. The default name (`MAIL_HOSTNAME`) is not stored as an override: asking for it is the same as `DELETE`. Returns `{effective, applied, detail}`, `effective` being the value read back from postfix, not the one requested |
| `DELETE /mail/servers/:serverId/hostname` | – | drops the name set in the panel: the relay goes back to `MAIL_HOSTNAME`, live. Same answer as `PUT`. `GET /mail/setup` shows each server's `defaultHostname` and `hostnameOverride` |
| `POST /mail/servers/:serverId/publish-hostname` | – | points the relay's mail hostname A record at that server |
| `POST /mail/domains/:domain/check` | – | re-check one domain ("I've added the record") |
| `GET /mail/dkim` | – | keys with their DNS record values |
| `POST /mail/dkim` | `{domain, rotate?}` | `201 {key, sync}` — generates, pushes to every server, restarts the signers |
| `DELETE /mail/dkim/:domain` | – | `{removed, sync}` — also deletes the key files |
| `POST /mail/dkim/sync` | – | re-materialize every key on every server (repair after a restore) |

### Plugin catalog, jobs, monitoring, settings
| Method & path | Notes |
|---|---|
| `GET /plugins/search?q=&page=` | searches the wordpress.org directory (`q` ≥ 2 chars, 10 results/page); returns `{items: WporgPluginDto[], page, pages, total}`. Backs the panel's plugin typeahead; results are cached in-process. `502` when the directory is unreachable |
| `GET/POST /plugins`, `POST /plugins/upload` (multipart `file`, ≤100 MB zip), `PUT/DELETE /plugins/:id` | catalog of preinstallable plugins; `isDefault` entries are preselected at site creation, and installed on a site created through the API without `catalogIds`. Each entry's `pluginDir` is the folder it installs into, which is what recipes go by: the slug for wordpress.org, the folder inside an uploaded zip (`null` when the zip has no single top-level folder). `POST {kind:"wporg", slug, name?, isDefault?, force?}` verifies the slug against wordpress.org first — an unknown slug is `404`, an unreachable directory is `502`, and `force: true` skips the check (for panels with no outbound internet). The directory's own plugin name is stored when `name` is omitted. `PUT` takes `{name?, isDefault?}` and needs at least one of them (400 otherwise) |
| `GET /plugins/:id/check`, `POST /plugins/:id/check`, `POST /plugins/:id/check/review` | an uploaded zip's malware check ([security.md](security.md#plugins-from-the-catalog)): `GET` answers `{check, findings}`. `check` is `{status: pending/done/incomplete/failed, checking, folder, version, files, flagged, confirmed, problem, checkedAt, reviewed, needsReview}`, and each finding is `{path, kind, label, severity, rule, line, detail}` with the path inside the zip's folder. `POST …/check` queues the check again (`202 {job}`); an upload queues one on its own. `POST …/check/review` says the flagged files are the plugin's own, so sites' unchanged copies of them are vouched for; it holds for exactly those findings. A wordpress.org entry answers `400`: it is checked on each site |
| `GET /recipes` | every plugin recipe the panel knows and whether it is in use: `{items: [{id, name, plugin, version, description, source: "catalog"\|"bundled"\|"local", installed, enabled, changedAt, sites, inPluginCatalog, inputs: [{id, label, hint, secret, constant, set, display, updatedAt}], …}]}`. `sites` counts the sites whose last inventory has the plugin; `inPluginCatalog` says the panel's plugin catalog has an entry that installs into the recipe's plugin folder (for a zip, the folder inside it, not its file name). Secret inputs (license keys) are write-only — their `display` is the last four characters; an input the recipe marks as not secret shows its value (docs/licenses.md) |
| `POST /recipes/:id/install` · `DELETE /recipes/:id/install` | take a known recipe into use (by reference: a catalog recipe keeps following the catalog), or stop using it — which also forgets what was entered for it, and deletes a local recipe outright. `404` for a recipe the panel does not know / has not installed |
| `PUT /recipes/:id/enabled` `{enabled}` | switch an installed recipe off or on without uninstalling it; a disabled recipe does not run and its constant leaves every site at the next recipe run |
| `POST /recipes/local` `{recipe}` | add (or replace) a recipe of your own in the catalog's format; installed and enabled at once, and shadows a catalog recipe of the same id. `400` with the first validation problem when it does not validate, or when another local recipe already covers its plugin |
| `GET /recipes/:id/definition` | the recipe as the panel has it, to copy and fork |
| `PUT /recipes/:id/inputs/:input` `{value}` · `DELETE /recipes/:id/inputs/:input` | store or forget the value for one of a recipe's inputs (`key` for the license key of the bundled recipes). `404` for a recipe the panel does not know or an input it does not declare, `400` for a recipe that is not installed. Takes effect on the next recipe run per site (site creation, URL change, or **Activate** on the site page) |
| `GET /catalog` | the public recipe catalog as this panel sees it: `{url, entries, unsupported, generatedAt, commit, fetchedAt, changedAt, error, keyId, recipes: {catalog, bundled}}`. `url: null` = fetching is off (`WPL7_CATALOG_URL=off`); `error` is the last fetch's failure while the previous copy stays in use (docs/licenses.md, "The catalog") |
| `POST /catalog/refresh` | fetch and verify the catalog now, ignoring the cached ETag (sync, ≤15 s): `{outcome: "updated"\|"unchanged"\|"failed"\|"disabled", catalog}`. The panel does this on its own hourly |
| `GET /monitor/overview` | per-server load/mem/disk in `servers[]` (legacy `server` field = server 1) + per-site `up`/`httpStatus`/`httpMs`/CPU/mem/disk. `httpStatus` is what the probe got back (`null` = nothing answered at all), which is what tells "the site is down" apart from "Traefik has no route for this hostname" |
| `GET /monitor/servers/:id/history?hours=24` | authenticated server load/memory/disk history; `hours` is 1–168. Returns `{samples, since, until, bucketMs, sampleIntervalMs}` with at most 240 recorded samples, each containing `ts` and the overview resource fields. Load is the OS load average, not CPU utilization; byte capacities of zero mean unavailable. |
| `GET /monitor/sites/:slug/history?hours=24` | bucketed samples for charts. `cpuPct` is a percentage of **one core** (100% = one core saturated), averaged across the whole sampling interval |
| `GET /meta` | offered PHP versions, `locales[]` (WordPress's own language list: `{code, label, english}`), dev domain, TLS/mail mode, `servers[]`, `defaultServerId`, `multiServer`, `dnsManaged`, `timezone` (the panel's clock, which cron schedules run on), `repoUrl` and `communityUrl` (the same links as `GET /system/about`, without asking the host) — feeds the creation/move forms and the Support page |
| `GET/PUT /settings` | backup cron & retention, monitor intervals, mail retention & per-site volume budget, `trafficRetentionDays` (visitor statistics, default 90), `trafficIpRetentionDays` (default 7) and `trafficStoreIps` (setting it false also deletes the stored addresses), `wpScanIntervalHours` (WordPress inventory refresh, default 6) and `vulnerabilityFeed` (false = no slug ever leaves the box and nothing is rated), `apiActivityRetentionDays` (API request log, default 30), site defaults incl. `defaultServerId` and `defaultAdminEmail` (what the New Site wizard's admin email starts as; `""` = none), and the per-site container limits `siteCpuLimit` / `siteMemoryLimitMb` / `sitePidsLimit`. `PUT` answers `{settings, jobs}`: changing a limit queues one `server.applySiteLimits` per server with sites, which changes every existing site container in place (no restart) — except lifting the CPU cap (`0`), which Docker cannot do to a live container, so those sites get a `site.reconcile` each (a site busy with a job of its own at that moment gets it once that job has run). `jobs` is empty otherwise |
| `GET/POST /api-keys`, `DELETE /api-keys/:id` | `POST {name, access?: "read"\|"manage"\|"full"}` (default `full`); the token is returned exactly once, at creation, and a key's level is fixed for its life |
| `GET /api-keys/activity` | the API request log (below): `?keyId=&outcome=ok\|error\|denied&method=&search=&hours=&limit=&offset=` -> `{items, total, last24h, retentionDays, maxRows}`. `hours=0` means everything still stored |
| `DELETE /api-keys/activity` | empties the log -> `{removed}`. Keys and their access are untouched |
| `POST /feedback` | `{summary, details, environment?}` -> `{ok: true}`. Forwards a question or an idea to `<WPL7_COMMUNITY_URL>/feedback` as `{kind: "question", …}`; `502` when that host refuses or cannot be reached, `404` when the install points at no community. Bug reports and feature requests do **not** come through here - the panel's feedback dialog composes those in the browser and opens them as GitHub issues under the sender's own account |
| `GET /health` | unauthenticated liveness probe |

### Jobs and schedules (see docs/jobs.md)
| Method & path | Notes |
|---|---|
| `GET /jobs` | newest first: `{items, total, counts, retentionDays}`. Filters: `q` (`#123` or `123` is that job; anything else matches the summary, type, site, error, who started it, or a type's name), `status`, `type`, `category` (`sites\|backups\|wordpress\|files\|servers\|system`) and `origin` (`user\|api\|mcp\|schedule\|system`) — each a comma list, `siteSlug`, `serverId` (includes that server's named lanes), `scheduleId`, `batchId`, `since`/`until` (ms), `limit` (≤200) & `offset`. `counts` is per status under every filter except `status`. A job carries `summary`, `origin`, `createdBy`, `scheduleId`, `serverId` and `cancelRequested` besides its status and times |
| `GET /jobs/types` | every job type: `{items: [{type, label, description, category, internal, timeoutMs}]}` |
| `GET /jobs/:id?logAfter=<seq>` | job + new log lines + `lastSeq` cursor |
| `POST /jobs/:id/cancel` | queued → canceled (`200 {job}`); running → asked to stop at its next safe step, answered `409` with `details: {cancelRequested: true}`; anything else `409` |
| `GET /schedules` | every schedule — the built-in ones (`kind: "builtin"`, `group: "jobs"\|"background"`) and yours (`kind: "custom"`) — with `cadence`, `enabled`, `pausable` (+ `lockedReason`), `pauseWarning`, `running`, `nextRunAt`, and the last run's time, duration, outcome (`ok\|failed\|skipped`), result (`{jobs, skipped: [{siteSlug, reason}], message}`) and `lastJobs` (status counts of the jobs it queued) |
| `GET /schedules/actions` | what a custom schedule can do: `{actions: [{action, label, description, category, targets, jobType, paramsSchema}], targetSchema, createBodySchema, minGapMinutes, maxCustomSchedules, timezone}` — the schemas are JSON Schema, for building requests without the panel's source |
| `GET /schedules/:id` | `{schedule}`. `:id` is the numeric id, or a built-in's key (`backups`, `wp-scan`, `offsite`, `housekeeping`, `wp-cron`, `uptime`, …) |
| `POST /schedules` | `{name, description?, action, target, params?, cron \| runAt, enabled?: true}` → `201 {schedule}`. `target` is `{kind:"sites", slugs}` \| `{kind:"server", serverId}` \| `{kind:"all"}` \| `{kind:"panel"}`; `cron` is five fields on the panel's clock, at least 5 minutes between runs; `runAt` (ms) runs it once. `400` names what is wrong; at most 100 custom schedules (`409`) |
| `PATCH /schedules/:id` | a built-in takes `{enabled}` only (`400` for one that cannot be paused), and needs Full: pausing it stops the backups, the scans or the housekeeping of every site. So does any change to, run of or deletion of a schedule that takes backups. A custom schedule takes any field of the create body, merged and re-validated; `null` clears `cron`, `runAt` or `description`. Resuming counts from now — missed runs are not caught up |
| `DELETE /schedules/:id` | custom schedules only; the jobs it queued stay in the list |
| `POST /schedules/:id/run` | now, paused or not: `202 {jobs, skipped, running}`, with `Location` when exactly one job was queued. A background task answers `{running: true}` at once — poll `GET /schedules/:id` |

### MCP connections (see docs/mcp.md)

The MCP endpoint itself is `POST /mcp`, outside `/api`, with its OAuth endpoints under `/oauth` and
`/.well-known`; docs/mcp.md describes them. None of the endpoints below is reachable through MCP.

| Method & path | Body | Returns |
|---|---|---|
| `GET /mcp` | – | `{enabled, unavailable, url, window, connections[], activity[]}` — the MCP page: whether it is on, why it cannot be (no `PANEL_DOMAIN`, no TLS), the server URL, the open connection window, every connected app (`{id, app, redirectHost, approvedBy, access, createdAt, lastUsedAt}`) and the latest calls MCP made |
| `POST /mcp/connect-window` | – | `{window}` — ten minutes in which one app may register and you may approve it. Browser session only; `409` while MCP is off |
| `DELETE /mcp/connect-window` | – | `204` — close it. Browser session only |
| `DELETE /mcp/connect-window/registration` | – | `204` — forget the app that registered in your window and keep the window open for the right one; `409` when none has. Browser session only |
| `PATCH /mcp/connections/:id` | `{access}` | `{connection}` — the app's next call has the new level |
| `DELETE /mcp/connections/:id` | – | `204` — its tokens stop working at once |
| `POST /oauth/authorize/check` · `/decision` | `{query}` · `{query, approve, access?: "read"}` | The approval page's two calls: what it shows, and `{redirectTo}` after the admin's click. Browser session only, from the panel's own page |

Switching MCP on and off is the `mcpEnabled` setting (`PUT /settings`), which answers `409` for
switching it on where it cannot run.

### This install, and updating it (see docs/updating.md)
| Method & path | Body | Returns |
|---|---|---|
| `GET /system/version` | – | `{version, gitSha, channel, source, latest, updateAvailable, checkedAt, nextCheckAt, error}` — served from the cached hourly check, so no request ever waits on GitHub |
| `GET /system/about` | – | `{repoUrl, host, publicIp, reverseDns, communityUrl, panelDomain, node, panelUptimeSeconds}` — what the panel's About page shows. `host` is the server-1 reading of `GET /servers/:id/info`; `reverseDns` is the PTR of `publicIp`, and `null` whenever the lookup does not produce one |
| `POST /system/update/check` | – | the same object, after asking GitHub now |
| `POST /system/update` | `{version}` — the release the check found, nothing else | `202 {unit, version}` — hands `provision/update.sh` to systemd. From here the panel stops answering for a while and comes back as the new version, or as the old one after a rollback |
| `GET /system/update/status` | – | `{running, maintenance, state, log, history}` — keep polling through the gap where nothing answers; `state.phase` ends at `switched` or `failed` |
| `POST /system/update/post-update` | – | `202 {job}` — re-run the follow-up tasks of the last applied update (per-version hooks, worker servers); `404` when none has been applied |

While an update is in flight every mutating call is refused with `503 maintenance`; reads, and
the endpoints above, keep answering.

### The API activity log

Every request that presents a Bearer token is recorded - the ones that succeed, and the ones
that never reach a handler: a refused token, a path that has moved, a body the panel rejects,
a 429. The panel's own browser session is deliberately *not* recorded; it polls itself every
fifteen seconds and would bury everything an integration does.

A row carries the key (name and prefix), method, path with the query string stripped, the
matched route pattern, status, error code, duration, client address, user agent and - for a
202 - the id of the job it started. A call an AI app's tool made over [MCP](mcp.md) is recorded the
same way, with `via: "mcp"`, the tool, and the key or the connected app (`connectionId`) - and the
app's own address, not the panel's. A token refused at `/mcp` is recorded too. A token that matched no live key is recorded with
`keyId: null` and only its 12-character prefix; the token itself is never written down.
Opening the server terminal is recorded too, as its `101` upgrade, at the moment the shell
opens: a key that can open a root shell is exactly the one worth seeing in the log.

Two limits, both deliberate: `apiActivityRetentionDays` (default 30, changed in **API keys ->
Activity** or through `PUT /settings`) removes old rows in the nightly housekeeping job, and a
hard ceiling of 100,000 rows applies whatever the period says - a client polling a job once a
second writes 86,000 rows a day, and a request log is not a rollup. The ceiling is enforced
as rows are written, not only by the nightly run: a refused token is recorded as well, so the
table's size cannot be left to depend on how hard somebody is knocking.

The same page carries the integration guide and a console that runs a request against this
panel with a key you paste, which is the quickest way to prove a new key works.
