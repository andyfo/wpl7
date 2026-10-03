# WordPress updates, bulk management and known vulnerabilities

The panel tracks what every site has installed — plugins, themes and the WordPress version —
what has an update waiting, and what matches a published security advisory. One site's view
lives on its **WordPress** tab; the whole fleet's lives under **Sites → Bulk management**.

## The inventory is a snapshot

Asking a site what it has installed is not a database read: it is a `docker exec` into the
container, and `wp plugin list` deletes WordPress's update transient and re-asks
api.wordpress.org (plus every premium plugin's own update server) on the way. That takes
seconds. Doing it per page load is fine for one site and impossible for a table covering
fifty, so the panel keeps a per-site snapshot in SQLite and reads that everywhere:

| When the snapshot is refreshed | What triggers it |
|---|---|
| Every `wpScanIntervalHours` (default **6**) | the `wp.scanAll` scheduler job |
| After every WordPress job | plugin, theme, core and bulk jobs all re-scan the site they touched |
| On demand, one site | **Check now** on the site's WordPress tab (`POST /sites/:slug/wp/scan`) |
| On demand, everything | **Rescan all** on the bulk page (`POST /wp/scan`) |

The scheduled pass is due when **any running site's** snapshot is older than the interval —
per site, not fleet-wide, so a busy site being scanned every hour cannot postpone the rest
of the fleet (or a site created this morning) indefinitely. A floor sits on top of that: at
most one pass is started per interval, so a site that simply cannot be scanned — stopped
server, permanently busy — does not queue a fresh pass every ten minutes.

Consequences worth knowing:

- A site that has never been scanned shows **“not scanned yet”**, not “nothing installed”.
  The distinction is deliberate: an empty list would read as a clean bill of health.
- Numbers are as old as the last scan. Every view says how old, and **Check now** costs one
  round trip to wordpress.org per site (≈ 5-20 s) — which is why it is rate-limited to ten
  per minute and why the scheduled interval is a setting rather than a minute-by-minute poll.
- A fleet scan only covers **running** sites, and skips any site that already has a job in
  flight; the job that is running refreshes that site's snapshot when it finishes.
- It is a lane-less job: the work is read-only, so it does not park a server's queue behind
  it, and it runs servers in parallel and their sites in sequence.
- If a plugin fatals under wp-cli, the listing is retried with `--skip-plugins
  --skip-themes`. That yields the inventory but not the update information a premium
  plugin's own updater would have contributed, so the snapshot is flagged **partial** and
  the UI says so.

## Known vulnerabilities

Every installed slug and the WordPress version are matched against
[wpvulnerability.net](https://www.wpvulnerability.net/), a free, key-less API. The panel
caches one answer per slug for 24 hours, and matches installed versions against each
advisory's affected range **locally** — so the same ~200 slugs serve a whole fleet, and a
newly published advisory changes every site's verdict at the next feed refresh without
touching a single container.

What the badges mean:

| Shown | Meaning |
|---|---|
| **critical / high / medium / low** + CVSS | at least one advisory's range covers the installed version |
| **closed** | the plugin was removed from wordpress.org (`closed_reason`, e.g. `security-issue`) — it will never be fixed, so replace it |
| *no data* | the feed answered but has no record of this slug (a premium or custom plugin). **Not** the same as "no vulnerabilities" |
| *not checked* | the slug has not been looked up yet; the next scan does it |
| *check overdue* / *check failed* | the cached answer is stale, or the last lookup failed and what is shown is the previous answer |
| *range unclear* | the advisory states no version range the panel can evaluate, so it is shown flagged rather than hidden |

**Fix vulnerable** (site page) updates everything whose *available* update actually clears
what is known against it — the panel re-runs the version matcher against the release being
offered, so a component sitting at 1.0 with a 1.1 on offer and an advisory fixed in 2.0 is
not included, and the Security card says "1.1 does not clear this yet" next to it. An
advisory the feed marks *unfixed* is left alone for the same reason: there is nothing to
update to, and the honest remedy — deactivate it — is a decision, not a button.

### What leaves the box, and how to stop it

The panel sends a plugin or theme **slug**, or a WordPress **version**, to
wpvulnerability.net — once per slug per day, from the panel, not from the sites. No site
name, domain, URL or visitor address is ever part of a lookup, and the matching happens
here. **Settings → WordPress updates & security → “Rate installed plugins and themes”**
turns it off: no lookups at all, severities disappear from every view (the cached rows stay
but are not consulted), and updates and bulk management keep working.

Vulnerability data is published by the WPVulnerability project, which asks for attribution
rather than payment; the panel credits it under every list that uses it.

## Bulk management

**Sites → Bulk management** is one table of every plugin (or theme, or core version) across
the fleet, one row per slug with its per-site rows underneath. Filter by *Has update*,
*Vulnerable*, *Inactive*, *Closed on wp.org*, by server, or by text; chips combine with AND,
so *Vulnerable* + *Has update* is exactly the set one click of **Update** can fix.

Checkboxes work at both levels. The aggregate checkbox selects **the per-site rows the
current filter is showing** — which is what makes "filter to Vulnerable, select all, Update"
mean what it looks like. Changing a filter clears the selection rather than quietly carrying
rows that are no longer on screen.

### How a bulk run executes

A run is **one job per site**, grouped into a *batch*:

- The panel already guarantees one active job per site and one running job per server. Reusing
  that means a run of 14 sites on one server updates them one after another, on three servers
  three at a time — with per-site logs, per-site cancellation and per-site failure.
- Each job optionally takes a **pre-update backup** (`pre_update`, kept until you delete it),
  runs the site's operations in order inside its container, optionally **checks the site still
  answers**, then re-scans the snapshot.
- Updates of one kind are coalesced into a single `wp plugin update a b c --format=json` call
  — one WordPress bootstrap instead of twenty — and the JSON it prints is split back per slug,
  because `wp` exits non-zero when *any* item failed and the per-item status is the truth.
- Core goes last: a plugin update is usually what makes a site compatible with the newer core.
- A site whose job lane is already busy is reported as **skipped**, with the reason, and can be
  retried — never silently dropped.

### What “failed” means, and how to get back

A bulk job fails when any operation failed **or** the health check failed. Its result carries
every operation's outcome (`from`, `to`, `error`), the health verdict, and the id of the
pre-update backup. There is deliberately no automatic rollback in this version: restoring is
one click on the site's **Backups** tab, and doing it automatically would mean deciding, on
the panel's own authority, to discard whatever happened on the site in the meantime.

A selection that cannot run the chosen action is rejected as a whole, with the offending
items listed, and nothing is queued. That is on purpose: a partly-valid selection that
half-runs is much harder to reason about than a 400.

### Safety rules (enforced server-side, mirrored as disabled buttons)

- Must-use plugins (the panel's own one-click login lives there) and drop-ins are never
  deactivated or deleted.
- The active theme is never deleted, and neither is the active theme's parent; `wp theme
  delete` is never called with `--force`. Themes have no "deactivate" — activate another one.
- **Update** is only offered where the snapshot has an update version. An install that is
  *newer* than the directory's latest is marked *ahead*, not updatable.
- Deleting from the fleet page needs the word `delete` typed; deleting a plugin deactivates it
  first, and leaves its database tables behind (WordPress only removes those if the plugin
  cleans up after itself).
- Stopped sites are hidden from the fleet page unless **Include stopped sites** is ticked. A
  per-site action on a stopped site starts the container, does the work, and stops it again.
- The selection only ever holds rows the table is showing: searching, filtering or a refresh
  that drops a row drops it from the selection too, and a run submits exactly what was on
  screen. "Reselect skipped sites" re-selects the components that run actually asked for,
  not everything those sites happen to have installed.
- `bulk` and `new` cannot be used as names for **new** sites, because `/sites/bulk` and
  `/sites/new` are pages. A site that already has one of those names keeps working
  everywhere — API, sites list, bulk runs — except that its own detail page is shadowed by
  the static page; rename it by creating a new site and restoring a backup into it if that
  matters to you.

## API

See docs/api.md for the full table. In short:

```bash
API="https://panel.example.com/api"; AUTH="Authorization: Bearer $TOKEN"

# what one site has installed, and what is wrong with it (snapshot, instant)
curl -s "$API/sites/customer-shop/wp/status" -H "$AUTH"

# re-read that site now (synchronous, rate-limited)
curl -sX POST "$API/sites/customer-shop/wp/scan" -H "$AUTH"

# every plugin across the fleet that is vulnerable AND has an update
curl -s "$API/wp/inventory?kind=plugin&filter=vulnerable,updates" -H "$AUTH"

# update it everywhere, backing each site up first
curl -sX POST "$API/wp/bulk" -H "$AUTH" -H 'content-type: application/json' -d '{
  "action": "update",
  "targets": [{"siteSlug": "customer-shop", "kind": "plugin", "slug": "contact-form-7"}],
  "backupFirst": true, "healthCheck": true
}'
# -> 202 {batch, jobs[], skipped[]}   then poll:
curl -s "$API/wp/batches/1" -H "$AUTH"
```

## Settings

| Setting | Default | What it does |
|---|---|---|
| `wpScanIntervalHours` | 6 | how often the fleet snapshot is refreshed (1-168) |
| `vulnerabilityFeed` | true | false = no lookups leave the box, and nothing is rated |

## Updates on a schedule

A custom schedule with the `wp.update` action is an update policy: "every night, update what fixes
a known vulnerability on every site", or "every Sunday, update all plugins on these three". Its
job scans the site first and decides from that fresh scan, so a policy never fails on a snapshot
gone stale - see [jobs.md](jobs.md#custom-schedules). Create one on **Automations → Schedules**
or with `POST /schedules`.

## Not in this version

Email on a new critical
advisory, snoozing an update per site, bulk *install* from the catalog, a second feed source
(Wordfence Intelligence's bulk export), automatic restore on a failed health check, and visual
regression checks after an update.
