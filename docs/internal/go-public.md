# Going public — the runbook

The public repository `andyfo/wpl7` starts from one commit: the tree of the private
`andyfo/ceo-server` `main`, with none of its history. The private repository stays as the
archive. The first release is `0.3.0-beta.1`.

## 0. Freeze the private repo

- Merge everything that belongs in the first commit. Close the dependabot PRs; dependabot
  reopens them on the new repository.
- Wait for that last deploy to go green. The live box is then on exactly the tree being
  published, which step 4 relies on.

## 1. Create the repository from a snapshot

```bash
git clone --depth 1 git@github.com:andyfo/ceo-server.git /tmp/ceo-src
mkdir ~/dev/wpl7 && cd ~/dev/wpl7
git -C /tmp/ceo-src archive HEAD | tar -xf -
git init -b main && git add -A
git commit -m "Initial commit" -m "[skip deploy]"
gh repo create andyfo/wpl7 --public --source=. --remote=origin --push --homepage https://wpl7.com \
  --description "Self-hosted WordPress hosting: one VPS, one command, a panel that runs the fleet."
```

`[skip deploy]` is there because the live box cannot fast-forward onto an unrelated history;
step 4 moves it by hand. Tests, images and the `edge` release still run. The commit shows your
git email publicly.

## 2. Settings the docs link to

```bash
R=andyfo/wpl7
for l in breaking feature fix docs internal no-release-note; do gh label create "$l" -R $R -f; done
gh api -X PUT repos/$R/private-vulnerability-reporting
gh api -X PUT repos/$R/vulnerability-alerts
gh api -X PATCH repos/$R -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
gh repo edit $R --enable-discussions --add-topic wordpress,self-hosted,hosting,docker
```

The labels group the release notes (`.github/release.yml`). `SECURITY.md` and the issue
templates link to vulnerability reporting and Discussions, which 404 until they are on.

Leave **Immutable releases** off: CI deletes and recreates the `edge` release on every merge.

## 3. Make the packages public

When the first Deploy run is green, go to `github.com/andyfo?tab=packages` and, for each of
`wpl7/panel`, `wpl7/wordpress` and `wpl7/sftpgo`, open **Package settings → Change visibility
→ Public**. This cannot be undone. Check it from a client that is not logged in:

```bash
docker logout ghcr.io
docker manifest inspect ghcr.io/andyfo/wpl7/panel:edge >/dev/null && echo public
```

## 4. Move the live box to the new repository

On the box, as root. The checkout at `/opt/wpl7` builds from source and belongs to `ceo`, the
pre-rename user, which becomes `wp` (the default of `dev-access.sh` and `ci-access.sh`). The
uid stays the same, and the home directory, SSH keys and `gh` login move with it. The panel
reads the owner from the checkout at run time.

```bash
usermod -l wp -d /home/wp -m ceo && groupmod -n wp ceo
mv /etc/sudoers.d/90-ceo-dev-ceo /etc/sudoers.d/90-wpl7-dev-wp
sed -i 's/^ceo /wp /' /etc/sudoers.d/90-wpl7-dev-wp && visudo -c

cd /opt/wpl7
sudo -u wp git remote set-url origin https://github.com/andyfo/wpl7.git
sudo -u wp git fetch origin
sudo -u wp git diff --stat HEAD origin/main      # must print nothing
sudo -u wp git checkout -B main origin/main
./provision/ci-access.sh --repo=andyfo/wpl7 --rotate
sed -i '/ceo-deploy@github-actions/d' /home/wp/.ssh/authorized_keys
rm /opt/ceo-server
```

If the diff prints anything, the box is not on the snapshot's tree yet: finish step 0 first.
`--rotate` only replaces `wpl7-deploy` keys, so the `sed` removes the old repository's key.
That key was the last user of the `/opt/ceo-server` symlink. Log in as `wp@` from now on.

## 5. Release

```bash
cd ~/dev/wpl7
./scripts/release.sh 0.3.0-beta.1          # then wait for the Release workflow to go green
gh release edit v0.3.0-beta.1 --prerelease=false --latest
```

`release.yml` publishes any `-suffix` version as a pre-release, and GitHub's "latest" skips
pre-releases. Without the last command the README's `releases/latest/download/install.sh`
returns 404, `install.sh` cannot resolve a version, and no panel on `stable` offers the beta.
Repeat it for every beta that users should get. Add `--notes-file` to replace the
near-empty generated notes.

The release commit also deploys to the box through the new repository, which proves step 4.

## 6. Install it the way a user will

On a fresh x86-64 Ubuntu 26.04 VPS, with two DNS records on a spare subdomain: follow the
README's Quick start word for word. Sign in, create a site, and check that **Settings →
Updates** shows `0.3.0-beta.1` on `stable`. Then delete the VPS.

## 7. Retire the old repository

```bash
gh repo archive andyfo/ceo-server --yes
```

In every local clone, point `origin` at `git@github.com:andyfo/wpl7.git` and run
`git fetch origin && git checkout -B main origin/main`. Unmerged branches do not share
history with the new `main`: `git rebase --onto origin/main <last ceo-server main sha> <branch>`.

Before merging the first outside pull request, install
[cla-assistant](https://github.com/apps/cla-assistant). `CONTRIBUTING.md` promises it.
