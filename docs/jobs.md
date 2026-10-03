# Jobs and schedules

Everything the panel does to a site, a server or itself that takes longer than a page load is a
**job**: it is queued, runs with a log you can read while it happens, and ends as succeeded,
failed or canceled. Everything that happens *on its own* - backups at night, the WordPress scan,
offsite copies, monitoring - is a **schedule**, and the schedules are listed, pausable and runnable
on demand too. Both live under **Automations** in the sidebar: *All jobs* and *Schedules*.

## Jobs

### How they run

- **One active job per site.** A second change to a site while one is queued or running is
  refused (`409 job_conflict`); schedules report such a site as *skipped* instead.
- **One running job per server.** Docker and MariaDB changes on one machine happen in order, so
  jobs for different sites on the same server wait for each other; different servers do not. A
  site move holds both its servers.
- **Named lanes** run beside that, for work that must not hold a server up: offsite uploads
  (`offsite:<server>`, one at a time per server), commands in a site (`exec:<server>`, see
  [below](#commands-in-a-site)), malware scans (`scan:<server>`, see
  [security.md](security.md#malware-scans)) and the nightly housekeeping (`housekeeping`). A
  malware scan carries no site, so the site's other jobs are not held up by it.
- A job that outlives its time limit is failed and asked to stop at its next safe step. Every
  type has its own limit (`GET /api/jobs/types`).
- Finished jobs are kept `jobsRetentionDays` days (default 90; the footer of the Jobs list
  changes it), then removed by the nightly housekeeping.

### What the list shows

Every job carries the name of its type ("WordPress inventory scan", not `wp.scanAll`), a
one-line summary of what this one did ("Update plugin akismet", "wp cache flush") and **who
started it**:

| Origin | Shown as | Means |
|---|---|---|
| `user` | the admin's username | someone clicked something in the panel |
| `api` | `API key "<name>"` | a request carrying that key |
| `mcp` | `Claude via MCP (approved by andy)`, `API key "<name>" via MCP` | an AI app's tool call ([docs/mcp.md](mcp.md)) |
| `schedule` | the schedule's name | a schedule fired, on its own |
| `system` | Panel | the panel's own follow-up work: what a job queues, what an update runs afterwards |

"Run now" on a schedule is credited to whoever pressed it, and still linked to the schedule.
Jobs from before this was recorded show no origin.

The summary never names the site or server - those are columns of their own - and never
repeats a password: the admin password of a new site is left out, and in a command line
anything that looks like a credential (`--user_pass=…`, `DB_PASSWORD value`, `token=…`) is
shown as `•••`. It is written once, when the job is queued.

### Finding one

The search box matches `#123` (or `123`) as that job, and anything else as part of a job's
summary, type, site, error or who started it - or of a type's *name*, so "inventory" finds the
scans. Status chips combine (failed *and* canceled); the job filter takes a whole category or
one type; site, server, origin and a time window narrow it further. Every filter is in the page's
address, so a filtered list can be bookmarked or sent. The same filters are the query string of
`GET /api/jobs` - see [api.md](api.md#jobs-and-schedules).

A job's page says what that type of job does, who started it, how long it waited and ran, what
it returned, and its log - filterable to warnings and errors, searchable, and downloadable. A
running job can be asked to stop: it does at its next safe step, and what it already did is not
rolled back.

## Schedules

### Built in

| Schedule | When | Pausing it means | |
|---|---|---|---|
| Scheduled backups | `backupCron` (Settings, default 03:00) | no site is backed up on schedule; manual, safety and final backups still happen | queues jobs |
| WordPress inventory scan | when any site's snapshot is older than `wpScanIntervalHours` (default 6), checked every 10 minutes | update counts and vulnerability warnings go stale | queues jobs |
| Malware scans | each site every `scan.intervalHours` (default 24), checked every 10 minutes; at most three at a time, one per server. Also queues the check of each plugin-catalog zip not yet checked with this AMWScan, three at a time | no site is scanned for malware, and no catalog zip checked; **Scan now** and **Check again** still work | queues jobs |
| Offsite copies | every minute, and right after each backup | nothing is copied offsite; to stop one destination, pause it under Backups → Storage instead | queues jobs |
| Container limits follow-up | every minute, after the limits in Settings changed | sites that were busy when the limits changed keep the old ones | queues jobs |
| Nightly housekeeping | 04:00 | old backups, statistics, logs and finished jobs are no longer removed | queues jobs |
| WordPress cron | every 5 minutes | scheduled posts, plugin tasks and WooCommerce emails stop on every site | background |
| Uptime checks | `monitorUptimeIntervalSec` | a site going down is not noticed | background |
| Site / server resource stats | `monitorStatsIntervalSec` | the charts get a gap | background |
| Disk usage | a few sites every few minutes, each site about every `monitorDuIntervalMin` | disk sizes stop updating | background |
| Visitor statistics | every minute | statistics stop updating; visits meanwhile may not be counted | background |
| Update check | hourly | new panel releases go unnoticed ("Check now" still works) | background |
| Recipe catalog | hourly | new recipes stop arriving ("Fetch now" still works) | background |
| Mail log | every minute | *cannot be paused*: it enforces the outbound mail limits | background |
| Site network repair | every minute | *cannot be paused*: a redeployed stack could leave sites unreachable. Also rebuilds, once, a site container made before its protection moved inside it | background |
| Site protection | every minute, and right after each change | *cannot be paused*: it puts a site's rules back on a server that lost them, and takes them off a site switched to Off | background |
| Blocked addresses | every minute, and right after each change | *cannot be paused*: it ends blocks on time, runs the attack detection and loads the list on every server | background |
| FTP upkeep | every minute | *cannot be paused*: it switches off expired FTP logins | background |
| Update watchdog | every 30 seconds | *cannot be paused*: a failed update would leave the panel read-only | background |

"Queues jobs" means each run is jobs you can open in the list; background tasks work inside the
panel process and show only their last run. Monitor intervals are read when the panel starts,
and the page shows the ones in force.

A pause holds on every way a schedule is started - its timer, the catch-up run at boot, and the
events that kick it (a finished backup kicks the offsite copies) - and survives restarts.
**Run now** works whether it is paused or not. A run that had nothing to do (a scan check that
found every snapshot fresh) is not recorded, so *last run* means the last time it did something.
The nightly housekeeping used to run inside the scheduler with nothing to show for it but log
lines; it is now the `system.housekeeping` job, with its own log and counts.

### Custom schedules

A custom schedule is one **action** on a **target**, repeated on a cron expression or run once
at a time. Create them on the Schedules page or with `POST /api/schedules`.

| Action | Targets | Options | Queues |
|---|---|---|---|
| `backup` | sites, server, all | `note` | a backup per site |
| `site.restart` / `site.start` / `site.stop` | sites, server (restart: all too) | – | the site job |
| `wp.scan` | sites, server, all | – | one inventory scan |
| `wp.update` | sites, server, all | `plugins`, `themes`, `core`, `onlyVulnerable`, `backupFirst`, `healthCheck` | a WordPress updates job per site |
| `panel.snapshot` | panel | – | a panel snapshot |
| `wp.cli` | sites, server, all | `args` (the argv after `wp`), `timeoutMin` | a WP-CLI job per site |
| `site.shell` | sites, server, all | `command`, `timeoutMin` | a shell command job per site |
| `wp.rest` | sites, server, all | `method`, `route`, `body`, `auth`, `timeoutMin` | a REST API request job per site |

Targets are `{"kind": "sites", "slugs": [...]}` (up to 200), `{"kind": "server", "serverId": 2}`
(the sites running there - for *start*, the stopped ones), `{"kind": "all"}` (every running site)
and `{"kind": "panel"}`.
`server` and `all` are worked out when the schedule fires, so a site created next week is
included without editing anything; for backups they also respect each site's *Include this site
in the periodic backups* switch, which a named list of sites does not. A site on a named list
that has since been deleted is skipped, and does not stop the schedule from being paused or
edited: only a site a change adds to the list has to exist.

**When.** `cron` is a five-field expression on the panel's clock (`GET /meta` → `timezone`),
and no two runs may be closer than **five minutes**: every run is a job with a log that holds its
site against every other change while it runs. `runAt` (milliseconds) runs it once; afterwards
it stays in the list as *done* until deleted or given a new time.

**What a run does with a site it cannot use.** A busy site (another job in progress), a stopped
one (for anything but backups and *start*) or a deleted one is *skipped*, with the reason in the
run's result; the other sites go ahead. A run that queued nothing at all is recorded as skipped.
Stopped sites are never started by a schedule.

**Missed runs.** A panel that was down when a schedule was due - an update, a reboot - catches up
once if it is back within half the schedule's interval (at least two minutes, at most an hour; an
hour for a one-off), and otherwise records the run as missed and waits for the next one. Several
missed runs never turn into a burst of them, and neither does resuming a paused schedule. Nothing
fires while the panel is updating itself.

**Scans on a schedule.** A `wp.scan` over all sites is a pass over the fleet, like the built-in
scan. One over named sites or a server is not: it refreshes those sites, and the built-in scan
still comes round for every other site on its own interval.

**Updates on a schedule.** `wp.update` is a policy, not a list: when its job runs it scans the
site first and updates whatever the fresh scan says is out of date - or, with `onlyVulnerable`,
only what clears a known vulnerability, the same choice as the site page's *Fix vulnerable*.
A site with nothing to do finishes without a backup; the backup it takes otherwise is a
*scheduled* backup, so retention bounds it.

**Backups and retention.** Backups from a schedule count toward `backupRetention` exactly like
the nightly ones: the newest N scheduled backups per site are kept, whichever schedule took them.
An hourly backup schedule on a site with a retention of 10 keeps ten hours of backups, not ten
nights.

### Commands in a site

`wp.cli` and `site.shell` run inside the site's container **as www-data** (the site's own user,
never root, and the container has `no-new-privileges`), in the WordPress folder. Output goes to
the job log as it arrives, up to 1,000 lines. A non-zero exit fails the job, with the exit code in
its result. `timeoutMin` (1-60, default 10) is enforced inside the container with `timeout`, which
kills the command; *canceling* a running command only takes effect once it has finished, because
Docker cannot interrupt an exec.

They run in the server's `exec` lane: one command at a time per server, beside - not in front
of - that server's other jobs, while the site itself stays held for the duration.

A command is stored as written, in the schedule and in the job: keep passwords and tokens out of
it (put them in `wp-config.php` or the site's environment instead, or hand them to a one-off command
on stdin, below). The summary masks what looks like a credential; the log shows whatever the command
prints.

The same commands can be run once, without a schedule: `POST /api/sites/:slug/wp/cli` with
`"async": true`, and `POST /api/sites/:slug/shell`.

A one-off `wp.cli` can be given text on its **stdin** as well, `"stdin": "…"` beside `args`, up to
64 KB: what a `-` value (`wp godmode chat send <id> --message=-`) reads, or the values `--prompt`
asks for, one per line (`--prompt=user_pass`). Its summary and its log say only how much there was
(`+ stdin, 1.2 KB`), and the job keeps the text in `panel.db` just until it ends - succeeded, failed,
canceled or cut short by a restart - when it is dropped from the stored job. WP-CLI echoes what
`--prompt` was handed, after each question and in the command line it prints afterwards; those
values are masked (`••••••`) in every line the log keeps. The output reaches the log as it comes, as
for any command. Schedules take no stdin.

A `wp godmode` command that waits on a chat - `chat wait`, or one given a `--wait` above 0, or asked
for one through `--prompt` - is refused as a job (`400`), from `/wp/cli` with `async` and in a custom
schedule alike: it would hold the `exec` lane, and with it every other site's commands on the server,
for as long as it waits. Run it without `async`, within the request, or wait with
`GET /api/sites/:slug/godmode/chats/:chatId?wait=40` ([api.md](api.md#wp-godmode)). The check is
there against the easy mistake, not a fence: a `wp eval` that runs a wait is not caught.

### REST API requests

`wp.rest` sends one request to a route of the site's WordPress REST API - `GET wp/v2/posts`,
`POST myplugin/v1/sync` - and keeps the answer in the job log: the status, size and time,
`X-WP-Total` and `Location` when there are any, then the body (JSON indented), up to 1,000 lines of
the first 1 MB. Anything but a 2xx answer fails the job, with WordPress's own error message when it
gave one. It runs in the same `exec` lane as the commands, and holds the site the same way.

- **Options.** `method` is `GET` (the default), `POST`, `PUT`, `PATCH` or `DELETE`. `route` is what
  follows `/wp-json/`, query string included (`wp/v2/posts?status=draft&per_page=5`); a pasted
  `/wp-json/…` is fine, a whole address is not. `body` is a JSON object or list, sent as
  `application/json`, and not allowed with `GET`. `timeoutMin` (1-60, default 10) is how long it
  waits for the whole answer.
- **From inside the site.** curl runs as www-data in the site's container and asks the site's own
  Apache on 127.0.0.1, with the site's primary hostname as `Host`. DNS, certificates and Traefik
  play no part - it works for a site whose domain does not point here yet - and the request never
  leaves the server. The route goes in as `/?rest_route=`, which WordPress answers whatever the
  permalink setting.
- **Signing in.** `"auth": {"username": "editor", "applicationPassword": "abcd efgh ijkl mnop qrst
  uvwx"}` sends the request as that user, with HTTP Basic - the way WordPress takes an
  [application password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/)
  from outside. Make one in the site's admin under *Users → Profile → Application Passwords*; the
  login password does not work. The request is marked as HTTPS (`X-Forwarded-Proto: https`) even
  on an install without TLS: WordPress ignores an application password on plain HTTP, silently, so
  the request would run signed out - and this one is as private as HTTPS, since it never leaves
  the container.
- **The password is kept, never shown.** It is stored with the schedule, in `panel.db` like the
  panel's other credentials, and every read of the schedule leaves it out: `auth` comes back with
  the username only. A change that sends `auth` without `applicationPassword` keeps the stored one
  for the same username; a new username needs its own. It reaches curl on stdin, never on a command
  line, and is masked in the job log if the site ever echoes it back. A job holds it only while it
  runs: it is dropped from the stored job once that has ended. Revoke it in WordPress once the
  schedule is gone.

A request can also be made once, without a schedule: `POST /api/sites/:slug/wp/rest` answers with
the response itself (`{status, headers, body, …}`, within 45 seconds), or queues the job with
`"async": true`.

### Things worth knowing

- The panel's Update button refuses to start while any job is queued or running, so a schedule
  that keeps a site busy around the clock also keeps updates waiting.
- A custom schedule every five minutes on fifty sites is 14,400 jobs a day; with 90 days of
  retention that is a large jobs table. Prefer the fewest runs that do the job.
- At most 100 custom schedules.

## For integrations

`GET /api/schedules/actions` describes every action with a JSON Schema for its options, the target
and the whole create request - enough to build a valid request without reading the panel's
source. `:id` in the schedule endpoints also takes a built-in's key (`wp-scan`, `backups`, …).

```bash
API="https://panel.example.com/api"; AUTH="Authorization: Bearer $TOKEN"

# Every night at 02:30: scan each running site and install only the updates that fix a
# known vulnerability, with a backup first and a health check after.
curl -sX POST "$API/schedules" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "Nightly security updates",
  "action": "wp.update",
  "target": {"kind": "all"},
  "params": {"onlyVulnerable": true, "core": true, "backupFirst": true},
  "cron": "30 2 * * *"
}'

# Every 15 minutes, ask a plugin to sync, signed in as the WordPress user "sync".
curl -sX POST "$API/schedules" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "Order sync",
  "action": "wp.rest",
  "target": {"kind": "sites", "slugs": ["customer-shop"]},
  "params": {"method": "POST", "route": "myplugin/v1/sync", "body": {"since": "15m"},
             "auth": {"username": "sync", "applicationPassword": "abcd efgh ijkl mnop qrst uvwx"}},
  "cron": "*/15 * * * *"
}'

# Flush one site's object cache every hour, starting paused.
curl -sX POST "$API/schedules" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "Hourly cache flush",
  "action": "wp.cli",
  "target": {"kind": "sites", "slugs": ["customer-shop"]},
  "params": {"args": ["cache", "flush"]},
  "cron": "0 * * * *",
  "enabled": false
}'

curl -sX PATCH "$API/schedules/2" -H "$AUTH" -H 'content-type: application/json' -d '{"enabled": true}'
curl -sX POST  "$API/schedules/2/run" -H "$AUTH"          # 202 {jobs, skipped}; Location: the job
curl -s        "$API/jobs?scheduleId=2" -H "$AUTH"        # everything it has queued
curl -sX PATCH "$API/schedules/wp-scan" -H "$AUTH" -H 'content-type: application/json' -d '{"enabled": false}'
```

Schedules need a Full key - a schedule can hold a shell command, so creating, changing or running
one is as much as running that command. Create one key per integration so the Jobs list and the
[API activity log](api.md#the-api-activity-log) say which one did what.
