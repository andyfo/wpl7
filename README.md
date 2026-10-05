# WPL7

**Self-hosted WordPress hosting you actually control.** One VPS, one command, a panel that
runs the fleet.

[![CI](https://github.com/andyfo/wpl7/actions/workflows/deploy.yml/badge.svg)](https://github.com/andyfo/wpl7/actions/workflows/deploy.yml)
[![Release](https://img.shields.io/github/v/release/andyfo/wpl7?sort=semver)](https://github.com/andyfo/wpl7/releases)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

<!-- Screenshot: docs/img/panel.png, captured from a real install. Add it here once there is
     one worth showing. -->

WPL7 turns a plain Ubuntu server into WordPress hosting: each site is its own container
with its own PHP version behind Traefik and Let's Encrypt, with working `wp_mail()`, backups,
monitoring and a REST API. It is for agencies and freelancers hosting their own clients'
sites, and for anyone who would rather pay for a VPS than per site. There is no control plane
and no telemetry: the panel runs on your server, the data is on your disk, and nobody else's
service sits between you and your sites. On its own it only fetches public data: GitHub hourly
(new versions, the recipe catalog); wpvulnerability.net daily (asked by plugin or theme slug and
WordPress version, never by site; can be switched off); wordpress.org's checksums for the
malware scan; and weekly, the internet registries' IP-to-country tables and the address lists
Cloudflare, Jetpack and the AI companies publish. A visitor claiming to be a search engine's
crawler is checked with a DNS lookup.

## What it does

- **Blank Ubuntu 26.04 to a running host in one command**, and no toolchain on the box: the
  panel and the site images are pulled, not compiled.
- **One container per site**, PHP 8.2–8.5, behind Traefik with automatic certificates. A new
  site is live at `<name>.dev.yourdomain.com` seconds after you create it; **Go live** moves
  it to the customer's domain with no downtime.
- **One compromised site stays one compromised site.** Each site is on its own internal
  network whose only other members are Traefik, the mail relay and MariaDB — it cannot reach
  another customer's site or the panel — with capabilities dropped, `no-new-privileges`, and
  CPU, memory and process ceilings.
- **Security in front of every site, and a look inside it**: rules that refuse what no visitor
  asks for and limits on logins and request rates, per site or for the fleet; attack detection
  that blocks an address on every server, at the firewall; and a daily malware scan that holds
  each site's files to wordpress.org's published checksums, looks for known malware in the rest,
  and can move it into quarantine ([docs/security.md](docs/security.md)).
- **`wp_mail()` works out of the box**: a per-server postfix relay with DKIM signing, per-site
  SMTP credentials so a hacked site cannot send as another customer's domain, a page showing
  every message and the queue, and a setup guide that checks SPF/DKIM/DMARC against live DNS
  and can publish them for you.
- **One-click admin login** into a customer's `wp-admin`, with no login plugin and no shared
  passwords.
- **Web FTP**: every site's files in the browser - a code editor that checks PHP before it
  saves and never overwrites a colleague's change, uploads of any size, downloads, zip and
  unzip, and search by name or content. It runs inside the site's own container as the site's
  own user, so a planted symlink leads nowhere ([docs/web-ftp.md](docs/web-ftp.md)).
- **FTP and SFTP logins per site**, for a customer or a developer who wants FileZilla: a login
  reaches its one site's files and nothing else, because each site with logins gets its own
  file server with only its folder mounted, running as the site. FTP only over TLS, brute force
  banned, and nothing listens until the first login exists ([docs/ftp.md](docs/ftp.md)).
- **Pro-plugin licenses activated for you**: enter a key once per plugin and every new site
  gets it activated right after its plugins are installed, again when the site goes live on
  its own domain, and released when the site is deleted. Driven by **recipes**: ACF PRO and
  Breakdance ship with one, another plugin is one JSON file, and the panel fetches the
  [public, signed catalog](https://github.com/andyfo/wpl7-catalog) of them hourly, so a new
  or corrected recipe reaches every install without an update
  ([docs/licenses.md](docs/licenses.md)).
- **Backups** on any cron schedule and on demand, restore, download, one list of every backup
  (a deleted site's included), and a per-server storage location so they can live on their own
  disk. **Offsite copies** mirror every backup to S3 or any S3-compatible vendor, SFTP,
  FTP/FTPS or WebDAV — uploaded by the server that holds it, verified, pruned on their own
  retention and fetchable back on demand, the panel's own database with them, and optionally
  encrypted before they leave so the provider holds ciphertext and nothing else.
- **Updates and known vulnerabilities across every site**: one table of every plugin, theme
  and WordPress version on every server, rated against the free wpvulnerability.net advisory
  feed, with the update run as one tracked batch — a job per site, an optional backup first
  and a health check afterwards ([docs/updates.md](docs/updates.md)).
- **Monitoring** (uptime, CPU, RAM, disk) and **WP management** (password resets, maintenance
  mode, a WP-CLI console).
- **Visitor statistics per site** built from Traefik's access log — visitors, pages,
  referrers and countries, with crawlers listed separately and kept out of the counts. The
  audience numbers are anonymous hashes, so they need no cookie banner; a separate,
  short-lived list of the busiest addresses answers the operational question, and can be
  switched off.
- **Grows to a fleet**: add a server from the panel and it provisions the blank VPS over SSH;
  move a site between servers while the old one forwards traffic until DNS catches up.
- **A REST API with API keys**, so your own tooling can create and manage sites — each key
  Read only, Manage or Full — with the guide, the endpoint reference and a test console built
  into the panel, and an activity log of every request a key made, including the refused ones.
- **AI apps in the panel over MCP**: Claude, ChatGPT, Claude Code, Cursor or VS Code connect to
  one address and work through the same API — signing in, and approved by you at the level you
  choose, or with an API key. Off until you switch it on ([docs/mcp.md](docs/mcp.md)).
- **An account for every admin**, each with optional two-factor authentication. API keys are
  a separate credential and keep working untouched.
- **Updates itself**: it tells you when there is a new version, and applies it with a health
  gate and an automatic rollback.

## Quick start

You need a fresh **Ubuntu 26.04 x86-64** server (2 GB RAM or more) with root access and ports
80 and 443 open to the internet, and a domain whose DNS you can edit. WPL7 takes the whole
machine: it installs Docker and enables a firewall.

**1. DNS.** Create both records and wait until they resolve — the panel's certificate is
requested as soon as the stack starts.

| Record | Name | Value |
|---|---|---|
| A | `panel.example.com` | your server's IP |
| A | `*.dev.example.com` | your server's IP |

**2. Install.**

```bash
curl -fsSL https://github.com/andyfo/wpl7/releases/latest/download/install.sh | sudo bash -s -- \
  --panel-domain=panel.example.com \
  --dev-domain=dev.example.com \
  --acme-email=you@example.com
```

**3. Sign in** at `https://panel.example.com` as `admin`. Give the panel a minute to boot,
then read the generated password:

```bash
sudo docker logs wpl7-panel | grep -A2 'First boot'
```

Change it under **Users → your account**. Create a site: it serves at
`<name>.dev.example.com` within a minute.

**4. Before real customer traffic**, set `SMTP_RELAYHOST` (deliverable email) in
`/opt/wpl7/deploy/.env`, then apply with `sudo /opt/wpl7/provision/setup.sh`. And add a Cloudflare
API token under **Settings → DNS**: one wildcard certificate for all dev sites, and the DNS records
written for you.

Flags, reading the script before running it, and adding servers:
[docs/install.md](docs/install.md).

## Updating

The panel checks once an hour and tells you. **Settings → Updates → Update** applies it; on
the server it is `sudo /opt/wpl7/provision/update.sh --to=<version>`. Either way the panel is
health-gated and rolled back — image, files and database — if the new one does not come back.

[docs/updating.md](docs/updating.md) is the whole story, including why the update runs under
systemd rather than inside the container it is replacing.

## How it works

```
                       ┌──────────── your server ────────────┐
    :80 :443 ──────────┤ Traefik  ── TLS, routing, access log │
                       │    │                                 │
                       │    ├── wp-alpha   (PHP 8.3)  ──┐     │
                       │    ├── wp-beta    (PHP 8.4)  ──┤ one network each
                       │    └── wp-gamma   (PHP 8.2)  ──┘     │
                       │            │            │            │
                       │         MariaDB      postfix + DKIM   │
                       │                                      │
                       │  panel  ── Node + SQLite, /srv, docker.sock
                       └──────────────────────────────────────┘
```

The panel is one Node process holding a SQLite database, the Docker socket and an SSH key per
server. Sites are containers it creates through the Docker API — not compose — so Traefik
discovers them by label and nothing has to be regenerated when one is added. Long operations
are jobs with logs and rollbacks rather than requests that hang.

[docs/architecture.md](docs/architecture.md) goes properly into it.

## Documentation

| | |
|---|---|
| [install.md](docs/install.md) | Getting it running, and the `.env` that comes out of it |
| [updating.md](docs/updating.md) | Channels, the update path, and what happens after |
| [site-lifecycle.md](docs/site-lifecycle.md) | Create, go live, move, delete — and what each step does |
| [mail.md](docs/mail.md) | The relay, DKIM, deliverability, sender authorization |
| [dns.md](docs/dns.md) | Records you need, and letting the panel manage them |
| [backup-restore.md](docs/backup-restore.md) | What is backed up, where it lives, restoring |
| [multi-server.md](docs/multi-server.md) | Adding servers, moving sites between them |
| [security.md](docs/security.md) | Site protection, blocked addresses, malware scans |
| [operations.md](docs/operations.md) | Running it: logs, disk, firewall, security posture |
| [troubleshooting.md](docs/troubleshooting.md) | When something is wrong |
| [api.md](docs/api.md) | The REST API |
| [architecture.md](docs/architecture.md) | How the pieces fit |
| [scripts.md](docs/scripts.md) | Every script, every flag, in the order you run them |
| [development.md](docs/development.md) · [local-dev.md](docs/local-dev.md) | Hacking on it |

## Security

The panel holds the Docker socket and an SSH key for root on its own host: **it is
root-equivalent on your server by design**, and whoever can log into it can do anything the
machine can. Protect its credentials and its API keys accordingly, and put it behind whatever
you would put a root shell behind.

What it is designed to contain is a compromised *site* — the thing that actually happens to
self-hosted WordPress. [docs/operations.md](docs/operations.md#security-posture) describes the
blast radius honestly, including what is not contained; [docs/security.md](docs/security.md) what
keeps attacks out and notices the ones that got in.

Found a vulnerability? [Report it privately](https://github.com/andyfo/wpl7/security/advisories/new)
— see [SECURITY.md](SECURITY.md).

## Status

**Beta (0.x), and honest about it.** It hosts real sites on the maintainer's own server, which
runs the `edge` channel — every merge lands there before it becomes a release. But the API and
the `.env` keys may still change between minor versions, and there is no backporting: `0.x`
means the newest release is the supported one.

What that means in practice: take a backup before you update, and read the release notes.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before writing a feature; bug fixes can go
straight to a pull request. A contributor licence agreement is required before a first PR is
merged, and the reason for it is spelled out there rather than hidden.

## License

[AGPL-3.0-only](LICENSE), in plain English:

- You can run WPL7 for yourself, your company or your clients, modify it however you
  like, and keep those modifications to yourself.
- The obligation to publish your changes is triggered by **offering your modified version to
  other people as a service** — running a hosting product built on a fork. Hosting *websites*
  for customers is using WPL7, not offering it, and triggers nothing.
- If you do distribute it or offer it as a service, the source has to go with it, under the
  same licence.

The name and logo are not covered by that licence — [TRADEMARK.md](TRADEMARK.md).

Malware scans run [AMWScan](https://github.com/marcocesarato/PHP-Antimalware-Scanner) (PHP
Antimalware Scanner) by Marco Cesarato, which is GPL-3.0 and not part of WPL7: each server pulls
its official image, pinned by digest, and runs it unmodified as a separate process
([docs/security.md](docs/security.md#amwscan)).

The panel ships two third-party assets. The [Inter](https://rsms.me/inter/) typeface is under
the SIL Open Font License 1.1 (`panel/web/src/fonts/LICENSE.txt`). The
[WP Godmode](https://wpgodmode.com) logo and screenshots on the panel's WP Godmode page
(`panel/web/src/components/Godmode.tsx`, `panel/web/src/assets/wpgodmode/`) belong to WP Godmode
and are not covered by the AGPL.
