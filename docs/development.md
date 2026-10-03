# Development

How WPL7 is built, versioned and released. Running it is [operations.md](operations.md);
hacking on it locally is [local-dev.md](local-dev.md).

## What a build calls itself

The panel cannot work out its own revision at runtime — `.dockerignore` drops `.git`, on
purpose — so the version is stamped into the image when it is built. `panel/Dockerfile`
turns `--build-arg VERSION` and `--build-arg GIT_SHA` into `WPL7_VERSION` and
`WPL7_GIT_SHA`, and `panel/src/lib/version.ts` is the only thing that reads them. That stamp
is the single record of what a box is running: the sidebar, `/api/meta`, the update checker
and the health gate an update waits on all come from it.

| Built by | Version | When |
|---|---|---|
| `.github/workflows/release.yml` | `0.3.0` | a `v*` tag |
| `.github/workflows/deploy.yml` | `0.3.0-edge.a1b2c3d` | every merge to `main` |
| `provision/deploy.sh`, `provision/setup.sh` | `0.3.0-source` | a box building from its own checkout |
| `provision/build.sh` | `dev` | an on-box build of whatever is on disk, committed or not |

`provision/lib.sh`'s `wpl7_stamp` sets the two variables; `deploy/docker-compose.yml` passes
them through as build arguments. Outside an image — `npm run dev`, the test suite — there is
no stamp and the panel reports `<package.json version>-dev`, so the number in the panel header
— and on the About page it opens — can never disagree with `package.json`.

The prerelease suffixes are load-bearing, not decoration. Semver puts `0.3.0-edge.a1b2c3d`
below `0.3.0` and above `0.2.9`, which is exactly what an edge build is, and `dev` is what
`provision/update.sh` refuses to overwrite without `--force` — the image-mode equivalent of
`deploy.sh` refusing a dirty tree.

## Two channels

| | `edge` | `stable` |
|---|---|---|
| Built from | every push to `main` | a `vX.Y.Z` tag |
| Panel image | `ghcr.io/<owner>/wpl7/panel:edge` (and `:sha-<short>`) | `:X.Y.Z`, `:X.Y`, `:latest` |
| Site images | `…/wordpress:php8.x-edge` | `…/wordpress:php8.x-X.Y.Z` |
| FTP image | `…/sftpgo:<deploy/sftpgo-image/VERSION>`, built once by the first build that finds it missing | the same |
| Runs on | the maintainer's own server | everyone else |
| GitHub Release | a rolling prerelease tagged `edge`, recreated by CI on every merge | a real release, with generated notes |

Running `main` in production is the soak test, and it is deliberate: every merge exercises
the same artefacts and the same mechanism users update through, so a broken release path is
found by the person who broke it rather than by someone else's box a month later.

The `edge` release's tag is moved by deleting and recreating the release, because a release's
tag cannot be moved in place. Do not link to `edge` as if it were a version.

## Cutting a release

A release is not a new state of the code. It is the `main` commit that has been running as
`edge` since it merged, given a number.

```bash
./scripts/release.sh 0.3.0            # or 0.3.0-rc.1 for a prerelease
./scripts/release.sh 0.3.0 --dry-run  # print what it would do
```

It bumps `panel/package.json`, commits `Release 0.3.0`, tags `v0.3.0` and pushes both. It
refuses a dirty tree, a branch other than `main`, a `HEAD` that is not `origin/main`, and a
tag that already exists. Then `release.yml`:

1. checks the tag against `panel/package.json` — they have to agree, because the panel
   reports the package version whenever it is not running from a stamped image;
2. runs the full test suite (`test.yml`, the same one every PR goes through);
3. builds and pushes the panel image and the four site images (`build-images.yml`);
4. `git archive`s `deploy/` and `provision/` into a bundle tarball — a few kilobytes, all a
   blank machine needs to provision itself, because everything else arrives as an image;
5. publishes the release with generated notes, the bundle and `manifest.json`.

`manifest.json` is the contract between a release and the boxes that apply it: the version,
the channel, the image references, `minUpgradeFrom` (the oldest version this release can be
applied to directly) and `requiresDowntime` (shown in the panel before the Update button is
pressed). Both channels emit the same shape, so there is one code path for both.

`minUpgradeFrom` has to be reachable from what the workflow is publishing, or a fresh install
of it can never take its next build: `update.sh` refuses before it pulls anything. `sort -V` —
the comparison `update.sh` makes — ranks `0.2.0` below `0.2.0-edge.<sha>`, so the practical
rule is that `panel/package.json` stays **at or above** the floor. Both workflows assert it and
go red rather than publishing a release nothing can apply. Bump the package to the next version
straight after a release, so `edge` is again a prerelease of what is coming rather than of what
has already shipped.

PR titles are the release-note lines, and `.github/release.yml` groups them by label:
`breaking`, `feature`, `fix`, `docs`, `internal`. An unlabelled PR still appears, under
"Other changes".

### After the first release of a package

**GHCR packages are private until you make them public, and repository visibility does not
change that.** A linked package inherits the repository's *permissions* but not its
*visibility*, so pulls will keep working for you and fail for everyone else — the most
convincing possible way to ship a broken update path. Make all three packages — `panel`,
`wordpress`, `sftpgo` — public in `https://github.com/users/<owner>/packages`, then check it
from a client that is not logged in:

```bash
docker logout ghcr.io
docker manifest inspect ghcr.io/<owner>/wpl7/panel:0.3.0
```

Making a package public cannot be undone, so it is worth knowing what is in the layers first.

### Prereleases

A tag with a `-suffix` (`0.3.0-rc.1`) is published as a GitHub prerelease and does **not**
move `:latest` or the `:X.Y` alias. That is how the release path itself gets tested — install
the *previous* stable on a throwaway VM, then update it to the candidate — without any real
install seeing the candidate as the newest stable.

## Workflows

| File | What it is |
|---|---|
| `.github/workflows/test.yml` | Typecheck, unit + API tests, web build. Reusable; every other workflow calls it |
| `.github/workflows/build-images.yml` | The panel image and the four site images. Reusable; called with different tags by the two below |
| `.github/workflows/deploy.yml` | Every push and PR: test. Merges to `main`: `edge` images, the rolling `edge` release, then deploy to the production server |
| `.github/workflows/release.yml` | A `v*` tag: check, test, images, release |

`[skip deploy]` in a merge commit message skips the deploy job and nothing else — the escape
hatch for a change the server cannot take unattended.

---

# Working on a server

The three things below used to live in `operations.md`. They are maintainer workflow, not
operator workflow: an install that simply runs needs none of it.

## Deploying automatically (GitHub Actions)

Every push to `main` runs the test suite and, if it passes, deploys itself:
`.github/workflows/deploy.yml` SSHes in and runs `provision/deploy.sh`, which fast-forwards
`/opt/wpl7` to the tested commit, rebuilds **only what the diff touched**, waits for
`wpl7-panel` to report healthy and rolls back if it does not.

One-time setup, on the server. The workflow calls `provision/deploy.sh` *on the server*, so
that file has to be there before the first automatic deploy can work — pull once by hand:

```bash
ssh wp@<server>                                       # the checkout owner, after dev-access.sh
cd /opt/wpl7
git pull
gh auth login                                         # once: ci-access.sh reads wp's gh session
sudo ./provision/ci-access.sh --repo=<owner>/<repo>   # needs root; sets the secrets with `gh`
sudo ./provision/ci-access.sh                         # or print them to paste by hand
```

Still logged in as `root` instead? Drop the `sudo` and authenticate `gh` as the deploy user:
`sudo -u wp -H gh auth login`. The full order is in [scripts.md](scripts.md#setting-up-a-server-in-order).

(If you merge to `main` before doing this, the deploy job fails on a missing `DEPLOY_SSH_KEY`
and says so — the tests still run, and nothing on the server is touched.)

The same merge also publishes the **`edge`** channel: the panel image and the four site
images on GHCR, plus a rolling `edge` release carrying the `manifest.json` an update is
resolved through. That is what this server will pull from once it moves to image mode;
today it still builds from its own checkout. How the channels and the release pipeline fit
together is [development.md](development.md).

The deploy user also has to be able to `git fetch` **without a prompt**: agent forwarding is
gone by the time Actions connects, so it needs its own key — the one `dev-access.sh` generates,
or a read-only deploy key ([Getting the code onto a server](#getting-the-code-onto-a-server)).
`deploy.sh` stops with that exact advice if the fetch fails.

It generates an ed25519 key and installs the public half in the deploy user's
`authorized_keys` with `restrict` **and a forced command**:

```
restrict,command="/opt/wpl7/provision/deploy.sh" ssh-ed25519 AAAA… wpl7-deploy@github-actions
```

so the key cannot open a shell, forward a port or run anything else — `deploy.sh` re-parses
the requested flags out of `$SSH_ORIGINAL_COMMAND` and rejects everything that is not one of
its own. The private half is printed (or handed to `gh`) once and is never stored on the
server. Rotate with `--rotate`; revoke by deleting the line from `authorized_keys`.

The key is authorized **last**, only once every secret is in place. A run that fails partway —
`gh` not logged in, a token without `repo` scope, no host keys to pin — leaves the server
exactly as it found it, so you can just fix the cause and re-run. `--rotate` is then only ever
needed for what it says: replacing a key that is already working.

Secrets it sets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_PATH`,
`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. The runner pins the server's host key from that last
one (`StrictHostKeyChecking=yes`), so a hijacked DNS record cannot collect the deploy key.

**Be clear-eyed about what this key is worth.** The deploy user is in the `docker` group and
has passwordless sudo, both root-equivalent on this box, and `deploy.sh` runs whatever
`main` contains. The forced command stops a leaked Actions secret from becoming an
interactive root shell; it is not a defence against someone who can push to `main`. Protect
the branch accordingly, and add required reviewers to the `production` environment in
GitHub if you want a human gate before each deploy.

### What a deploy actually does

| Changed in the push | What runs on the server |
|---|---|
| `panel/**`, `deploy/.env.example` | `compose.sh up -d --build panel` |
| `deploy/docker-compose*.yml` | `compose.sh up -d --build` (whole stack) |
| `deploy/wordpress-image/**` | rebuild `wpl7-wordpress:php*`, then the panel |
| `provision/**` | `sudo provision/setup.sh` (full: apt, ufw, images, stack) |
| docs, `.github/**` only | nothing — it just fast-forwards the checkout |

`panel/**` is not the only thing that rebuilds the panel image: it also carries `deploy/` and
`provision/` as the bundle pushed to worker servers, so a change to either has to be baked in.

Guard rails, all of them deliberate:

- **Refuses a dirty working tree.** Server-side edits you have not pushed would be silently
  overwritten. Commit and push them, or pass `--allow-dirty` to discard them.
- **Fast-forward only.** If the checkout has commits that are not on `origin/main`, the
  deploy stops rather than throwing them away.
- **Only deploys commits that are on the branch.** `--ref` must be an ancestor of
  `origin/main`, so the key cannot be used to ship an unmerged branch.
- **Health-gated with rollback.** If `wpl7-panel` is not healthy within
  `DEPLOY_HEALTH_TIMEOUT` (default 300s), it checks the previous commit back out, rebuilds,
  and fails the workflow with the last 60 lines of the panel log.
- **Never invents secrets.** `.env` is not in git; new keys in `.env.example` are reported as
  a warning for you to fill in by hand.

### Running it by hand

`deploy.sh` is not Actions-specific — it is the fastest way to deploy from a shell too:

```bash
./provision/deploy.sh                # deploy the tip of origin/main
./provision/deploy.sh --dry-run      # print the plan, change nothing
./provision/deploy.sh --full         # force a whole setup.sh run
./provision/deploy.sh --ref=<sha>    # a specific commit (must be on main)
```

### Fleets

Worker servers update themselves at the end of a deploy — `deploy.sh --workers` calls
`POST /servers/:id/update` for every `kind: "ssh"` server and waits for the jobs. That needs
a panel API key, which lives **on the server**, never in GitHub:

```bash
# as the deploy user
echo 'WPL7_API_KEY=wpl7_…' > ~/.wpl7-deploy.env && chmod 600 ~/.wpl7-deploy.env
```

Without that file the step prints one line and skips — a single-server install needs nothing.
A worker that fails to update fails the workflow, but server 1 stays on the new code.

## Getting the code onto a server

Only relevant if you are running in **source mode** — building the panel from a checkout
rather than pulling the released image. An ordinary install needs none of this: `install.sh`
downloads a bundle and the images come from GHCR ([install.md](install.md)).

Public clones need no credential at all:

```bash
git clone https://github.com/andyfo/wpl7.git /opt/wpl7
```

The routes below are for the case where the box has to be able to `git pull` **and push** on
its own — a fork you are developing in, or a private mirror. Every one of them ends in the
same place: a git clone at `/opt/wpl7` that `setup.sh` runs from.

Only the **first** server needs any of it. Workers get the panel's baked copy of the provision
bundle pushed to them over SSH by *Add server* ([multi-server.md](multi-server.md)), so they
never talk to GitHub at all.

Install git first if the image lacks it — minimal Ubuntu cloud images often don't ship it:
`apt-get update && apt-get install -y git`. (`setup.sh` installs it too, but that runs *after*
the clone.)

### Agent forwarding — nothing stored on the server

The right default for a server you provision by hand. Your laptop's `ssh-agent` signs GitHub's
authentication challenge through the connection you are already on; the private key never
leaves your machine.

```bash
# laptop
ssh-add --apple-use-keychain ~/.ssh/id_ed25519   # macOS; elsewhere: ssh-add ~/.ssh/id_ed25519
ssh -A root@<server-ip>                          # -A forwards the agent

# server
ssh-keyscan github.com >> ~/.ssh/known_hosts
git clone git@github.com:andyfo/wpl7.git /opt/wpl7
```

That `ssh-keyscan` trusts whatever answers on the spot; to be strict, skip it, let `git clone`
prompt, and compare the fingerprint against GitHub's published SSH key fingerprints.

The catch is the same one described under [agent forwarding for
pushes](#alternative-ssh-agent-forwarding): it works only while you are logged in with `-A`. A
later `git pull` from cron, a detached tmux pane, or an agent session you left running has no
usable `$SSH_AUTH_SOCK` and fails.

### Per-server deploy key — unattended pulls

```bash
# server, as root
ssh-keygen -t ed25519 -N '' -C "wpl7@$(hostname -s)" -f /root/.ssh/id_ed25519
ssh-keyscan github.com >> /root/.ssh/known_hosts
cat /root/.ssh/id_ed25519.pub
```

Add that public key at `https://github.com/andyfo/wpl7/settings/keys/new` and leave **"Allow
write access" unticked** — provisioning only ever reads. Then:

```bash
ssh -T git@github.com     # expect: "Hi andyfo/wpl7! You've successfully authenticated..."
git clone git@github.com:andyfo/wpl7.git /opt/wpl7
```

Each server needs its **own** key: GitHub refuses a public key that is already registered as a
deploy key elsewhere, so one key cannot be shared across machines. Revoke a server by deleting
its key from that settings page; nothing on your personal account is affected.

This read-only key is independent of the write-enabled one `provision/dev-access.sh` generates
for the `wp` user later — a repo can hold both, and that is the normal end state for a server
you also develop on.

### Fine-grained token over HTTPS — when SSH is not an option

For networks that block outbound port 22. Create a fine-grained personal access token scoped to
this one repository with **Contents: Read**, then:

```bash
git clone https://<token>@github.com/andyfo/wpl7.git /opt/wpl7
git -C /opt/wpl7 remote set-url origin https://github.com/andyfo/wpl7.git
```

The second line matters: without it the token sits in plaintext in `.git/config`, and unlike a
deploy key it is a credential of *yours* that likely reaches more than this repo. Afterwards
`git pull` prompts for a username and the token as the password, and it stops working on the
token's expiry date.

### Copy from your laptop — no GitHub credential on the server

```bash
# laptop, from your checkout (note the trailing slashes)
rsync -a --info=progress2 --exclude node_modules --exclude dist --exclude 'deploy/.env' \
  ./ root@<server-ip>:/opt/wpl7/
```

Mind those excludes: `deploy/.env` is your *local dev* configuration (`TLS_MODE=none`, localtest.me
domains, throwaway passwords) and would quietly become the production one — `setup.sh` never
overwrites an existing `.env`.

Keep `.git` in the copy, though: `dev-access.sh` reads the origin remote and commit history out of
it, and it is what lets you add one of the credentials above later and go back to `git pull`.

## Developing on the server (edit, test, push)

The production checkout at `/opt/wpl7` is an ordinary git clone, so you can edit,
commit and push straight from the box. Run this once to set it up:

```bash
sudo ./provision/dev-access.sh
```

It creates a non-root user (`wp` by default) that **owns the checkout** and is in the
`docker` group, installs Node 22 (for `npm test`) and the GitHub CLI from their
official signed apt repositories, and generates an SSH key whose public half it prints for
you to register on GitHub.

Note what does *not* change: `setup.sh` still runs as root, and the stack's containers are
still started by the root Docker daemon (the panel container also runs as root *inside* its
container — it needs `docker.sock` and has to chown site files to uid 33). What moves to
`wp` is the **checkout** and the day-to-day loop: edit, test, rebuild, commit, push.

**Why a separate user:** `setup.sh` runs as root, so the checkout ends up root-owned — an
agent running as a normal user could not write to it, and git would refuse with *"dubious
ownership"*. Rather than editing as root, the script hands ownership to `wp`
and gives it Docker access so the whole edit → test → rebuild → push loop needs no `sudo`.
Be clear-eyed about what that boundary is worth: the `docker` group is root-equivalent (any
member can start a container that mounts `/`). It buys hygiene and blast-radius control, not
protection from a determined attacker.

With `--with-claude`, Claude Code is installed from Anthropic's apt repository (the script pins and checks the
signing key fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`), **not** via
`sudo npm install -g`, which Anthropic's docs warn against and which would leave a root-owned
install a normal user can't update.

### Authenticating to GitHub

Two independent things need credentials, and they are not the same credential (a third — the
read-only credential that got the clone onto the box in the first place — is
[above](#getting-the-code-onto-a-server)):

| What | Used for | How |
|---|---|---|
| **Deploy key** (SSH) | `git push` / `git pull` — the transport | Add the printed public key at `https://github.com/andyfo/wpl7/settings/keys/new` with **"Allow write access"** ticked |
| **`gh` token** | GitHub *API* — PRs, issues, releases | `gh auth login` as the dev user (device flow: it prints a code and a URL) |

A deploy key is scoped to this one repository, never expires, and is revocable from the
repo's settings page — that's why it suits an unattended server better than a personal token.
Note that pushes authenticate as the key, but **commit authorship** comes from
`git config user.name/user.email`, which the script sets from your existing commit history —
so commits still show up as yours on GitHub.

### Alternative: SSH agent forwarding

If you'd rather store no key on the server at all, use agent forwarding. Your laptop's
`ssh-agent` holds your private key; connecting with `-A` exposes a *socket* to the server
(via `$SSH_AUTH_SOCK`) that the remote `ssh` — the one `git push` invokes — can ask to sign
authentication challenges. The private key itself never leaves your laptop; only signature
requests travel over the encrypted connection.

```bash
# laptop: make sure the key is in the agent
ssh-add --apple-use-keychain ~/.ssh/id_ed25519    # macOS; elsewhere: ssh-add ~/.ssh/id_ed25519

# connect with the agent forwarded
ssh -A wp@your-server
git push        # authenticates as YOU, using your laptop's key
```

Prefer enabling it per host rather than globally, in `~/.ssh/config`:

```
Host your-server
  HostName your-server.example.com
  User wp
  ForwardAgent yes
```

Two caveats. It only works inside that interactive session — a `tmux` pane started from an
older session, a cron job, or a Claude Code run you left going after logging out will have a
stale or missing `$SSH_AUTH_SOCK` and the push will fail. And while you are connected, anyone
with root on that server can use your forwarded socket to authenticate *as you* to anything
that key opens (they can't copy the key itself). `ssh-add -c` makes each use prompt for
confirmation on your laptop. The two approaches coexist happily: keep the deploy key as the
unattended fallback and forward your agent when you want commits pushed under your own
account.

### The loop

```bash
ssh wp@your-server
cd /opt/wpl7
claude                        # edit

./provision/build.sh          # install deps if needed, typecheck, test, rebuild, verify

git add -A && git commit -m "..." && git push
```

`build.sh` is the whole middle of the loop in one command. It works out what you touched and
rebuilds only that — the panel for `panel/**`, the whole stack for a compose change, the
`wpl7-wordpress` images for `deploy/wordpress-image/**`, `setup.sh` for `provision/**` — and it
runs `npm run typecheck && npm test` first whenever panel code changed, so a broken build is
caught *before* the running container is replaced. `npm ci` only re-runs when the lockfile has
moved ahead of `node_modules`.

If the panel still fails to come up, it re-tags the image that was serving before and recreates
the container from it. That is the difference from `deploy.sh`, which rolls back by commit:
there is no pushed revision to return to here, so the last good image is the fallback. Your
edits are never touched either way.

```bash
./provision/build.sh --quick     # skip typecheck+tests (you just ran them)
./provision/build.sh --dry-run   # print the plan, change nothing
./provision/build.sh --stack     # force every service
./provision/build.sh --full      # hand over to provision/setup.sh
```

Commit and push rather than leaving the tree dirty. Uncommitted server-side edits collide
with the next `git pull` from your laptop, and the automatic deploy refuses to run against a
dirty tree at all — it will not silently overwrite work you have not pushed.

Note which safety net you are under. A push to `main` goes through GitHub Actions: tests
first, then a health-gated deploy that rolls back if the panel does not come up. `build.sh`
gives you the same shape locally. Raw `compose.sh up -d --build panel` is the version with
neither — it
skips both, which is the point when you are iterating, but a bad build takes the control
panel down until the next build succeeds. Hosted sites keep serving (they are independent
containers behind Traefik), you just lose the ability to manage them —
`./provision/compose.sh logs -f panel` and `git revert` are the way back. `./provision/deploy.sh`
is the middle ground: same rebuild, with the health check and rollback.
