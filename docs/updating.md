# Updating

How a WPL7 install moves from one version to the next. How releases are *produced* is
[development.md](development.md); migrating an install from the old `ceo-server` naming is
[operations.md](operations.md#migrating-an-install-from-ceo-server).

## The two modes

An install either pulls the released panel image or compiles it from a checkout, and
`WPL7_SOURCE` in `deploy/.env` says which:

| | `WPL7_SOURCE=image` (default) | `WPL7_SOURCE=build` |
|---|---|---|
| Where the panel comes from | `ghcr.io/andyfo/wpl7/panel` | this checkout |
| Update with | `provision/update.sh --to=<version\|edge>` | `provision/deploy.sh` |
| Rolls back to | the previous image and bundle | the previous commit |
| Site images | pulled and retagged `wpl7-wordpress:php<v>` | built from `deploy/wordpress-image` |
| FTP image (SFTPGo) | pulled and retagged `wpl7-sftpgo:<version>` when a server gets its first login | built there from `deploy/sftpgo-image` instead: a few minutes, once per version |

Image mode is what a release is for: an update is a pull and a recreate rather than a
compile on a customer's VPS, and every server in a fleet ends up running the identical
binary. Build mode exists for developing on the box and for anyone who would rather compile
what they run. `provision/build.sh` switches an install into build mode (it has just built
something that exists nowhere else); `update.sh --force` switches it back.

`provision/deploy.sh` is the single CD entry point either way — it reads `WPL7_SOURCE` and
hands over to `update.sh` when the install pulls — so the forced command on the CI key stays
one script with one flag whitelist.

## Applying an update

```bash
cd /opt/wpl7
./provision/update.sh --to=0.3.0 --dry-run   # what it would do, changing nothing
./provision/update.sh --to=0.3.0
```

Run it as the checkout owner; it re-execs itself under `sudo -n` and does the rest as root.
Everything it touches needs that — `/srv/panel` is `0700` and root-owned, and so is the panel
database it snapshots — and it hands the checkout back to its owner afterwards, which is why
it is not simply started as root. From the panel, **Settings → Updates → Update** runs exactly
this, through systemd: the panel cannot replace its own container from inside it, so the work
has to belong to something that outlives it.

What it does, in order:

1. **Lock.** Refuses if `/srv/panel/update/state.json` says an update is running and its pid
   is alive. (The systemd unit name is a second lock, so a double-click never gets this far.)
2. **Resolve.** Reads the release's `manifest.json` from the GitHub API — the version, the
   channel, the exact image references, `minUpgradeFrom` and `requiresDowntime`. An install
   older than `minUpgradeFrom` is told to step through an intermediate release rather than
   skipping the panel generation whose post-update hooks it needs.
3. **Fetch.** Notes the image ids of everything currently running — on the edge channel the
   tags move, so after the pull nothing would name the version being replaced — then pulls
   the panel image and the four site images and extracts the provisioning bundle *from the
   panel image*. It rides inside it, so the scripts can never be a different revision from
   the panel that will run them. The current bundle is kept in `.previous/`; `deploy/.env` is
   never in the bundle and is never touched.
4. **Pre-flight.** Records warnings rather than guessing: keys that appeared in
   `.env.example` and are missing from your `.env` (nothing here invents a value), less than
   2 GB free where Docker stores images, `requiresDowntime`.
5. **Switch.** Stops the panel, copies `panel.db` to
   `/srv/panel/update/panel.db.pre-<version>` while it is the only writer, writes the new
   version into `.env`, and runs `setup.sh` — the same idempotent "make this host match the
   bundle" step as always, with every pull already cached.
6. **Health gate.** Waits for `wpl7-panel` to report healthy *and* for the running container
   to be the new image. Migrations run before the panel listens, so a migration that throws
   can never pass this gate.
7. **Rollback**, on any failure: the previous bundle, the previous version in `.env`, the
   database snapshot from step 5, the image ids from step 3 put back under the tags compose
   asks for, and `setup.sh` again with `WPL7_SKIP_PULL=1` so it does not immediately fetch a
   moving tag over the top of them. The old images are still on the box, so this is a
   recreate rather than a download. It exits non-zero either way, so a CD run that rolled
   back goes red.

There are **no down-migrations, ever**. A failed update goes back to the whole previous
state, never partway.

## The Update button

**Settings → Updates → Update** does exactly what the command above does, and the interesting
part is how it survives doing it.

The panel cannot replace its own container from inside it — the process would be killed half
way through its own recreate. So it does not try. It opens the root SSH connection to its own
host that the web terminal already uses (same key, same trust-on-first-use pin on server 1),
and starts a transient systemd unit:

```
systemd-run --unit=wpl7-update --collect -p RuntimeMaxSec=1800 \
  -p WorkingDirectory=/opt/wpl7 --uid=<checkout owner> \
  /opt/wpl7/provision/update.sh --to=0.3.0
```

The update now belongs to systemd. The SSH session can close, the panel's container can be
torn down, and neither touches it. The unit name is a second lock on top of `state.json` —
`systemd-run` refuses to start a unit that is already active — `--collect` frees the name
after a failure so a retry is possible, and `journalctl -u wpl7-update` is the log of last
resort if `/srv` is the thing that broke.

`--uid` is the owner of the install directory rather than root, because that is who runs
`deploy.sh` and a hand-run update, and because starting as root would leave root-owned files
in a checkout its owner can no longer edit. `update.sh` escalates to root itself with
`sudo -n`; on the edge channel the argument is `--to=edge`, the moving tag the release is
published under, rather than the `0.3.0-edge.<commit>` version the build calls itself.

That requires sshd to accept the panel's key for root — Ubuntu's default
(`PermitRootLogin prohibit-password`) does, and `setup.sh` installs the key. On a host that
refuses root logins entirely, use the command line; the button will say it could not connect.

**What it checks before it starts.** The version has to be the one the panel has actually
resolved a manifest for, not an arbitrary string — it becomes an argument to a
root-launched script. No jobs may be queued or running: a backup or a restore killed
half way through the panel's own recreate is not something a health gate can undo. And
`WPL7_SOURCE` has to be `image`; a source-mode install is told to use `deploy.sh`.

**Maintenance mode** goes on before the command leaves, not after — by the time the panel
would have got around to it, it may not exist. While it is set:

- every page shows a banner;
- mutating API calls are refused with `503 maintenance` (reads, and the update page's own
  controls, keep working);
- the job worker stops claiming new work, while jobs already running are left to finish.

It is not for the panel's sake — the panel is about to be replaced and does not care. It is
so a site created in the last thirty seconds does not land in the database snapshot the
rollback restores and then vanish.

The flag is cleared once the update is over, not at boot. That distinction is the whole
subtlety: `update.sh` records its outcome only after the panel it just installed answers the
health check it is blocked on, and that panel *is* the one asking — so a boot-time question is
always one step early, and would leave every successful update read-only forever. The new
panel therefore starts listening, then waits for `state.json` to say `switched` or `failed`,
and only then lifts the flag and queues the follow-up. A 30-second tick does the same for the
other case: an update that dies before it ever replaces the panel, leaving the process that
set the flag still running.

"Is it still running" is answered by asking systemd over the same connection, not by the pid
in `state.json`: that pid belongs to a host process and the panel is in its own pid namespace,
so checking it here would answer a question about some unrelated process in the container.

**The page keeps watching through the gap.** Between `switching` and the new container
answering, every request fails — not with an error the API produced, but with no answer at
all. That is the update working, so the UI renders it ("Restarting…") rather than treating
it as a failure. What comes back is either the new panel or, after a rollback, the old one
reading `phase: "failed"` out of the same file. Both are rendered by the same code, because
from the browser they are the same event: the update finished, and here is what happened.

## Watching it

```
/srv/panel/update/state.json    what is happening, and what happened last time
/srv/panel/update/current.log   everything the run printed
journalctl -u wpl7-update       the same, if the panel started it and you lost the log
```

`state.json` always has every field, `null` where one does not apply:

```json
{ "id": "20261001T120000Z", "from": "0.2.0", "to": "0.3.0", "channel": "stable",
  "phase": "fetching|preflight|switching|healthcheck|switched|failed",
  "rolledBack": null, "startedAt": "…", "finishedAt": null,
  "warnings": [], "error": null, "logTail": [], "pid": 12345 }
```

Both outcomes land in the same place: after a rollback it is the *old* panel that comes back
and reads `phase: "failed"`, so the page that showed the progress also shows what went
wrong, with the last 60 lines of the container's log.

## Channels

`WPL7_CHANNEL=stable` follows releases; `WPL7_CHANNEL=edge` follows the rolling build of
`main`. Changing the key only changes which release the panel offers — it is applying an
update that changes what is installed.

Edge is what the maintainer's own server runs, which is the point: every merge exercises the
mechanism everyone else updates through. It is not a good idea for a machine with customers
on it unless you are the one writing the code.

## Moving an existing install to image mode

A box provisioned from a git checkout is in build mode. To have it pull instead:

```bash
cd /opt/wpl7
sed -i 's/^WPL7_SOURCE=.*/WPL7_SOURCE=image/' deploy/.env      # or edit it
./provision/update.sh --to=<version|edge> --force               # --force leaves build mode
```

`--force` is required because leaving build mode throws away a panel that may have been
built from uncommitted work. The checkout stays where it is and keeps working; `update.sh`
writes the bundle from the image over it, so `git status` will show differences from `HEAD`
afterwards — that is expected, and `git checkout .` after `WPL7_SOURCE=build` puts it back.

## What the panel does afterwards

`update.sh` stops when the new panel is healthy, on purpose. Everything after that point
needs a panel — recreating a site container is a job with a log and a rollback, not a line in
a shell script — so the new panel picks it up itself. Once it is listening and `update.sh`
has recorded that it succeeded, it queues **`system.postUpdate`**, keyed on the update's own
run id so restarting the container ten times queues it once.

That job runs, in order:

1. **Per-version hooks.** Each release can add one; a hook runs when
   `from < its version <= to`, so jumping three releases runs all three in order and a
   re-run runs none of them twice. Every hook is idempotent. The first two are the steps that
   used to be paragraphs in these docs beginning "after upgrading, run…": re-applying the
   container policy to every site, and republishing the relay credentials and DKIM material.
   The third rebuilds, once, every site container made before its protection moved inside it
   (docs/security.md#inside-the-container), going by the container's own label - so it never
   rebuilds one twice. The panel does the same at every boot, and hourly while any is left:
   an install that builds from its own checkout runs no hooks.
2. **Worker servers.** One `server.provision` each, which pushes the new bundle, records the
   panel's own release identity in `.wpl7-install` — a worker has no checkout and no release
   of its own, and `setup.sh` refuses image mode without a version rather than inventing one
   — and re-runs `setup.sh --role=worker`. Panel first, then workers, so a worker is never
   running a newer bundle than the panel driving it.
3. **Clearing maintenance**, whatever happened above.

**A failure here is a job failure, never a rollback.** By the time a hook runs, the new
version is the one serving the page; there is nothing to go back to. You get a red job with a
log, a row in the history on **Settings → Updates** saying which step failed and why, and a
**Re-run** button for once you have fixed it.

The record of all of this is the `system_updates` table, and the Updates page shows the most
recent entry. It is there so that "did the reconciles ever run?" is a question with an
answer six months later.
