# Installing

From a blank server to a panel you can log into. Ten minutes, most of it waiting for Docker
to pull.

## What you need

- A fresh **Ubuntu 26.04** server, **x86-64** (the images are not built for ARM, and the
  installer stops on an ARM server), with root access. WPL7 takes the whole machine: it
  installs Docker, enables a firewall (UFW for SSH, 80 and 443, and an nftables table for
  blocked addresses) and binds ports 80 and 443.
- **Ports 80 and 443 open to the internet**, including in your provider's own firewall if it
  has one. Let's Encrypt validates over port 80.
- **2 GB of RAM** to start; a 2 GB swap file is added below 4 GB. Add memory as you add sites.
- **A domain** whose DNS you can edit.
- Outbound access to GitHub and `ghcr.io` (the release and its images), Docker Hub (Traefik,
  MariaDB, the mail relay, the malware scanner) and the Ubuntu and Docker apt repositories.

Any VPS with a plain Ubuntu image and a public IPv4 works: Hetzner, DigitalOcean, Vultr,
Linode, Scaleway, Contabo, OVH.

## 1. DNS

Create both records **before installing**, and wait until they resolve: Traefik requests the
panel's certificate as soon as it starts.

| Record | Name | Value |
|---|---|---|
| A | `panel.example.com` | your server's IP |
| A | `*.dev.example.com` | your server's IP |

The wildcard is what makes a new site reachable at once, at `<slug>.dev.example.com`. Customer
domains are added later, per site, when it goes live. [dns.md](dns.md) has the detail,
including letting the panel manage records through a provider API.

Created them after installing? Run `sudo docker restart wpl7-traefik` once they resolve.

## 2. Install

```bash
curl -fsSL https://github.com/andyfo/wpl7/releases/latest/download/install.sh | sudo bash -s -- \
  --panel-domain=panel.example.com \
  --dev-domain=dev.example.com \
  --acme-email=you@example.com
```

To read it before it runs:

```bash
curl -fsSL -O https://github.com/andyfo/wpl7/releases/latest/download/install.sh
less install.sh
sudo bash install.sh --panel-domain=… --dev-domain=… --acme-email=…
```

It finds the newest release on github.com, unpacks its bundle — a few kilobytes of
compose files and shell scripts — into `/opt/wpl7`, records the release in `deploy/.env`, and
hands over to `provision/setup.sh`, which pulls the images and starts the stack. Nothing is
compiled, and no checkout, Node or credential is left on the box.

Piped into `bash` there is no terminal, so it runs non-interactively: the three flags above are
required and the admin password is generated. Run the downloaded copy from a terminal and it
prompts for anything you leave out, the password included.

| Flag | Meaning |
|---|---|
| `--panel-domain=` | Where the panel answers. Required. |
| `--dev-domain=` | The wildcard subdomain new sites appear under. Required. |
| `--acme-email=` | Let's Encrypt account address. Required. |
| `--version=X.Y.Z` | A specific release instead of the newest |
| `--channel=edge` | Follow the rolling build of `main` ([updating.md](updating.md#channels)) |
| `--dir=PATH` | Somewhere other than `/opt/wpl7` |
| `--dry-run` | Print the plan, change nothing |

Anything else is passed through to `setup.sh` — `--admin-user=`, `--admin-password=`,
`--dns-provider=`, `--ssh-port=`, `--no-firewall`, `--role=worker`
([scripts.md](scripts.md#setupsh)).

## 3. First login

Give the panel a minute to boot, then read the generated password:

```bash
sudo docker logs wpl7-panel | grep -A2 'First boot'
```

Sign in at `https://panel.example.com` as `admin` (or your `--admin-user=`). The password is
printed once, on the first boot. Change it under **Users → your account**; editing `.env`
afterwards does nothing, because it is only read to seed the hash. Anyone else who needs the
panel gets their own account there too (**Users → Add admin**).

Then create a site. It serves at `<slug>.dev.example.com` within a minute, and the Jobs page
shows every step it took.

## 4. Before real customer traffic

Set these in `/opt/wpl7/deploy/.env` — each is explained in the file and in
[configuration.md](configuration.md) — then apply with `sudo /opt/wpl7/provision/setup.sh`.
Re-running it is safe: it never overwrites an existing `.env`.

- **`SMTP_RELAYHOST`** (with `SMTP_USERNAME` and `SMTP_PASSWORD`) — mail is delivered directly
  by default, which most VPS providers block or get filed as spam. Point it at a relay
  (Mailgun, Postmark, SES, your own). [mail.md](mail.md).

Also worth doing on day one, in the panel: add a Cloudflare API token under **Settings → DNS**
and switch on the server's wildcard certificate — every dev site then shares one certificate
instead of getting one each, and the panel writes DNS records itself ([dns.md](dns.md)); set an
alert address under **Settings → Mail** (mail suspensions and new releases are sent there); and
open **Mail → Setup guide**, which checks SPF, DKIM, DMARC and reverse DNS against live DNS and
tells you what is missing.

## Adding a second server

**Servers → Add server**, give it an IP and a root SSH key, and the panel provisions the blank
VPS itself: it pushes its own copy of the provisioning bundle and runs
`setup.sh --role=worker` over SSH. [multi-server.md](multi-server.md).

## Installing from a checkout instead

To compile the panel from source rather than pull the image — to hack on it, or on principle:

```bash
git clone https://github.com/andyfo/wpl7.git /opt/wpl7
cd /opt/wpl7
sudo ./provision/setup.sh --panel-domain=… --dev-domain=… --acme-email=…
```

`setup.sh` notices the checkout and sets `WPL7_SOURCE=build`: it builds the panel and the site
images here, and `provision/deploy.sh` becomes the update path instead of `update.sh`. The
trade is a longer install and a toolchain on the box. [updating.md](updating.md#the-two-modes)
covers both modes, and moving between them.
