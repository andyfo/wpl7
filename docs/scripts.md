# The provision/ scripts

Eight scripts run this project. Every one takes `--help`.

| Script | What it does | Run as | When |
|---|---|---|---|
| [`setup.sh`](#setupsh) | Blank Ubuntu 26.04 → running stack | **root** | Once per server, then after any `provision/**` change |
| [`migrate-rename.sh`](#migrate-renamesh) | Moves a pre-0.2.0 `ceo-server` install to its new names | **root** | Once, and `setup.sh` calls it for you |
| [`dev-access.sh`](#dev-accesssh) | Makes the box editable: dev user, Node, gh | **root** | Once, on a server you want to work on |
| [`ci-access.sh`](#ci-accesssh) | Lets GitHub Actions deploy here | **root** | Once, to turn on push-to-deploy |
| [`update.sh`](#updatesh) | Move this install to a released version | checkout owner (re-execs as root) | Every update, on a box that pulls |
| [`build.sh`](#buildsh) | Test + rebuild what you just edited | checkout owner | Every edit, on the box |
| [`deploy.sh`](#deploysh) | Ship a revision that is already on `main` | checkout owner | Automatic on push; by hand when you want |
| [`compose.sh`](#composesh) | `docker compose` with this install's `.env` | checkout owner | Ad-hoc: `ps`, `logs`, manual restarts |

**"Checkout owner"** means `wp` once `dev-access.sh` has run, `root` before that. It matters:
a `git pull` as root in a `wp`-owned checkout leaves files `wp` can no longer edit.

**About `sudo` in this page.** The three root scripts are written as `sudo ./provision/…`
because by the time you run them again you are normally logged in as `wp`. On a fresh box you
are still `root` and there is no `sudo` to add — drop it. The scripts check for themselves and
say `Run as root (sudo …)` if you got it wrong, so neither mistake does damage.

## Setting up a server, in order

Note where you stop being `root` — everything after the second block is done as `wp`.

```bash
# ─── as root, on the fresh VPS (this is who you are when you first ssh in) ───
cd /opt/wpl7
./provision/setup.sh --panel-domain=panel.example.com --dev-domain=dev.example.com --acme-email=you@example.com

./provision/dev-access.sh
#   creates the `wp` user, hands it the checkout, installs Node and gh, and prints
#   an SSH public key -> add it at github.com/<owner>/<repo>/settings/keys/new with
#   "Allow write access" ticked, so the box can push
```

```bash
# ─── from here on, log in as wp ───
ssh wp@<server>
cd /opt/wpl7

gh auth login                                        # once: ci-access.sh needs wp's own gh session
sudo ./provision/ci-access.sh --repo=<owner>/<repo>  # ci-access.sh itself must be root
```

`dev-access.sh` and `ci-access.sh` are both optional and independent of hosting: a server that
only runs customer sites needs nothing past `setup.sh`.

If you would rather not switch users yet, the whole thing works from the root session too —
authenticate `gh` *as the deploy user* instead, because that is the session `ci-access.sh`
reads:

```bash
sudo -u wp -H gh auth login
./provision/ci-access.sh --repo=<owner>/<repo>
```

---

## setup.sh

Blank Ubuntu 26.04 to a running host: packages, Docker, UFW, the `wpl7-firewall` helper for
blocked addresses, `/srv`, the `wpl7-wordpress` images, and the stack itself. Idempotent — **it never overwrites an existing `deploy/.env`**,
so re-running it is how you apply a provisioning change.

```bash
# first run - as root on the fresh VPS
./provision/setup.sh --panel-domain=panel.example.com --dev-domain=dev.example.com --acme-email=you@example.com

# later - as wp, to apply a provisioning change; no flags, reuses the existing .env
sudo ./provision/setup.sh
```

| Flag | Meaning |
|---|---|
| `--panel-domain=` `--dev-domain=` `--acme-email=` | Required on a first run (main server); prompted for if omitted |
| `--role=main\|worker` | `worker` = sites only, no panel; the panel drives it over SSH |
| `--panel-key='ssh-ed25519 …'` | Authorize the panel's key on a worker |
| `--admin-user=` `--admin-password=` | The owner account the first boot creates; password is generated and printed if omitted |
| `--dns-provider=` `--dns-token-stdin` | Wildcard dev certificates; the token arrives on stdin, never argv |
| `--mail-hostname=` `--ssh-port=` | Override the defaults derived from your domains / sshd |
| `--non-interactive` | Fail instead of prompting for a missing value |
| `--no-firewall` | Leave the host's firewalls alone: no UFW, and no `wpl7-firewall` - blocked addresses are then refused by Traefik alone on this server (docs/security.md#enforcement) |

### The `wpl7-firewall` helper

`provision/firewall/wpl7-firewall`, installed to `/usr/local/sbin`, loads the list of blocked
addresses the panel writes to `<SRV_ROOT>/wpl7-firewall/wpl7.nft` into `table inet wpl7`, and
nothing else. Its own unit, `wpl7-firewall.service`, loads the last list at boot, before the
network, and never fails a boot. A timed block's timeout counts from when the panel wrote the
file, so a list loaded late - at boot, or on `on` - gives each block only what is left of it.
The panel runs it as root over SSH (sudo) or `HostShell`.

| Command | Does |
|---|---|
| `wpl7-firewall status` | What is loaded, as one line of JSON |
| `wpl7-firewall apply` | Check the file with `nft -c`, then load it in one transaction; a file that touches any other table is refused, and what is loaded stays |
| `wpl7-firewall off` | Empty the table and keep it empty, whatever the panel writes, until `on` |
| `wpl7-firewall on` | Load the last list again, and let the panel's updates through |

## migrate-rename.sh

One-time migration of an install that still runs the pre-0.2.0 `ceo-server` stack. You do not
normally run this yourself: `setup.sh` calls it when it finds a container named `ceo-panel`,
after the site images are built and before anything is started.

```bash
sudo ./provision/migrate-rename.sh --dry-run   # print the plan, change nothing
sudo ./provision/migrate-rename.sh             # ask before the ~1 minute of downtime
```

| Flag | Meaning |
|---|---|
| `--yes` | Do not ask (what `setup.sh --non-interactive` passes) |
| `--dry-run` | Print the plan, change nothing |
| `--new-dir=` | Where the checkout moves to (default `/opt/wpl7`) |
| `--state-file=` | Where to report the new checkout path back to `setup.sh` |

It refuses to start if a site is still attached to `ceo_proxy` — that means a site predating
per-site isolation, which has to be reconciled from the panel first, where the operation has
a rollback. Then it aliases the site images under their new names and builds the panel image
while everything is still serving, stops and removes the five old containers in dependency
order, snapshots `panel.db`, moves the checkout (leaving a symlink behind), carries the mail
queue into the new volume, and hands back to `setup.sh` to start the stack.

It never touches `/srv/sites`, `/srv/mysql` or `/srv/backups`, and never stops a site
container. The whole procedure, including what to verify afterwards and how to roll back, is
in [operations.md](operations.md#migrating-an-install-from-ceo-server).

## dev-access.sh

Prepares the box for editing on it: creates a non-root user that **owns the checkout**, puts it
in the `docker` group, installs Node 22 and the GitHub CLI from their official signed apt
repositories, and generates an SSH key for pushing to GitHub.

```bash
# as root - this is the script that creates the non-root user, so you are still root here
./provision/dev-access.sh
./provision/dev-access.sh --user=wp --git-name="Your Name" --git-email=you@example.com
```

| Flag | Meaning |
|---|---|
| `--user=` | Which user owns the checkout (default `wp`) |
| `--git-name=` `--git-email=` | Commit authorship for commits made on the server; defaults to this repo's last author |
| `--with-claude` | Also install Claude Code (off by default: an AI coding agent on a production host is a choice) |
| `--skip-node` `--skip-gh` | Leave a tool out |

Safe to re-run; nothing is overwritten. What changes hands is the **checkout** — `/srv`, the
containers and the Docker daemon all stay root's. Full detail, including why the dev user is
root-equivalent anyway, is in
[development.md](development.md#developing-on-the-server-claude-code--git-push).

## ci-access.sh

Authorizes GitHub Actions to deploy to this server. Generates an ed25519 key, sets the six
`DEPLOY_*` repository secrets, and installs the public half with a **forced command** so the
key can run `deploy.sh` and nothing else — no shell, no port forwarding.

```bash
# as wp (drop the sudo if you are still root); needs root either way
sudo ./provision/ci-access.sh --repo=andyfo/wpl7   # sets the secrets with gh
sudo ./provision/ci-access.sh                            # prints them for you to paste
sudo ./provision/ci-access.sh --repo=… --rotate          # replace an existing key
```

| Flag | Meaning |
|---|---|
| `--repo=owner/name` | Set the secrets with `gh`. The deploy user needs its own `gh` session first: `gh auth login` as `wp`, or `sudo -u wp -H gh auth login` from root. Without `--repo`, the values are printed for you to paste |
| `--rotate` | Replace a CI key that is already authorized — see below |
| `--user=` | The deploy user (default `wp`) |
| `--host=` `--port=` | Override what the runner connects to; both are auto-detected |

### Why `--rotate` exists

The private key is generated in a temp directory, printed (or handed to `gh`) **once**, and
deleted when the script exits. Only the public half stays on the server. So the script cannot
re-show you the secret for a key that already exists — it does not have it. The only way to give
you a working `DEPLOY_SSH_KEY` again is to generate a new pair and replace the old line.

On a server where the deploy is already working, that is destructive: the moment the new public
key lands, the `DEPLOY_SSH_KEY` sitting in GitHub stops authenticating until you update it. So
the script refuses by default, and `--rotate` is you saying *yes, invalidate the old one*.

Think password **reset**, not password **lookup**.

A run that fails partway — `gh` not logged in, a token without `repo` scope, no host keys to
pin — changes nothing on the server at all: the key is authorized last, only once every secret
is in place. So `--rotate` is only ever needed for what it says.

**To revoke**, delete the `wpl7-deploy@github-actions` line from `~wp/.ssh/authorized_keys`.

## build.sh

The on-box edit loop in one command: work out what the working tree touched, run typecheck and
tests if panel code changed, rebuild only what is affected, and confirm the panel came back —
restoring the previous image if it did not.

```bash
./provision/build.sh
```

| Flag | Meaning |
|---|---|
| `--quick` | Skip typecheck + tests |
| `--dry-run` | Print the plan, change nothing |
| `--stack` | Rebuild every service, not just the panel |
| `--images` | Also rebuild the `wpl7-wordpress:php*` site images |
| `--full` | Hand over to `setup.sh` |

`BUILD_HEALTH_TIMEOUT` (default 300s) bounds the health check. The image it restores is the one
the running `wpl7-panel` container was created from, pinned by id before the rebuild — not the
`wpl7-panel:dev` tag this build is about to write, which on a first build does not exist at all
and on a later one may be a leftover from a different session.

## update.sh

Moves an install that pulls the released panel image to another version: resolve the
release's manifest, pull, swap the bundle in, run `setup.sh`, wait for the panel, and roll
back to the previous image, bundle and database if it does not come back.

```bash
./provision/update.sh --to=0.3.0 --dry-run
./provision/update.sh --to=0.3.0
./provision/update.sh --to=edge        # the rolling build of main
```

| Flag | Meaning |
|---|---|
| `--to=<version\|edge>` | Required. A published release, or the rolling `edge` build |
| `--channel=stable\|edge` | Record a different channel than the release's own |
| `--dry-run` | Print the plan, change nothing |
| `--force` | Replace a hand-built panel, and leave source mode |
| `--no-rollback` | Leave a failed update in place instead of reverting |
| `--expect-sha=` | The commit CD believed was current; reported, never enforced |

`WPL7_UPDATE_HEALTH_TIMEOUT` (default 300s) bounds the health gate. State and log live in
`/srv/panel/update/`, which is root-owned and `0700` — so this script re-execs itself under
`sudo -n` and runs as root, then gives the checkout back to its owner. The whole procedure,
and what the panel's Update button does with it, is in [updating.md](updating.md).

## deploy.sh

Ships a revision that is **already on `origin/main`**. This is what GitHub Actions runs over
SSH; it is also the quickest way to update a server by hand.

```bash
./provision/deploy.sh                # the tip of origin/main
./provision/deploy.sh --dry-run
```

| Flag | Meaning |
|---|---|
| `--ref=<sha>` | A specific commit — must be an ancestor of `origin/main` |
| `--full` | Force a whole `setup.sh` run |
| `--workers` | Afterwards, update every worker server through the panel API |
| `--dry-run` | Print the plan, change nothing |
| `--allow-dirty` | Discard uncommitted server-side edits instead of refusing |
| `--no-rollback` | Leave a failed deploy in place instead of reverting |

`DEPLOY_BRANCH`, `DEPLOY_HEALTH_TIMEOUT` and `DEPLOY_WORKER_TIMEOUT` override the defaults.
The difference from `build.sh`: `deploy.sh` moves the checkout to a pushed commit and rolls back
by commit; `build.sh` builds whatever is on disk and rolls back by image.

On an install that pulls its panel (`WPL7_SOURCE=image`) there is no checkout to move, so
`deploy.sh` hands over to `update.sh --to=edge` instead. That keeps CD a single entry point:
`ci-access.sh` pins one forced command with one flag whitelist, whichever mode the server is
in.

## compose.sh

`docker compose` with this install's `.env` and the right overlays always applied, so an ad-hoc
command cannot silently reconfigure the stack. The overlays it adds, each when the matching `.env`
key is set:

| Overlay | Added when | What it does |
|---|---|---|
| `docker-compose.dns.yml` | `DNS_PROVIDER=…` | DNS-01 resolver, so dev sites share one wildcard certificate |
| `docker-compose.worker.yml` | `SERVER_ROLE=worker` | drops the panel container (the central panel drives this machine over SSH) |
| `docker-compose.backup-root.yml` | `BACKUP_ROOT=…` | mounts the chosen backup directory into the panel at the identical path |

```bash
./provision/compose.sh ps
./provision/compose.sh logs -f panel
./provision/compose.sh restart wpl7-mail
```

Everything after the script name goes straight to `docker compose`. It adds
`docker-compose.build.yml` when `.env` says `WPL7_SOURCE=build`, which is what puts `build:`
back on the panel service.

## lib.sh

Not a script — sourced by the ones above. Currently holds `wpl7_stamp`, which decides what
a panel image calls itself (`dev`, `<package>-source`, or a release version) and exports it
for `compose.sh` to pass through as a build argument. See
[development.md](development.md#what-a-build-calls-itself).

## Not in provision/

`scripts/release.sh <version>` cuts a release: bump, commit, tag, push, and CI does the rest.
It runs on your laptop, not on a server — [development.md](development.md#cutting-a-release).
