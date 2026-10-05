# DNS setup

## One-time (when provisioning the server)

| Record | Name | Value | Purpose |
|---|---|---|---|
| A | `panel.example.com` | server IPv4 | admin panel |
| A | `*.dev.example.com` | server IPv4 | wildcard — every new site is instantly reachable at `<name>.dev.example.com` |
| A | `mail.example.com` | server IPv4 | mail hostname (`MAIL_HOSTNAME`) |

Verify: `dig +short panel.example.com`, `dig +short anything.dev.example.com` — both must return the
server IP.

If your server has IPv6, either add matching AAAA records or none at all — an AAAA record pointing
elsewhere breaks ACME validation.

## Cloudflare: Settings → DNS

Give the panel an API token for your Cloudflare account under **Settings → DNS**, and it does the DNS
work itself, in every zone the token reaches:

- the record of a site on a server the dev wildcard does not point at ([below](#additional-servers-fleet));
- a domain's records when it goes live, if you ask for it ([Go-live](#go-live-per-customer-domain));
- SPF, DKIM and DMARC, published from **Mail → Setup guide** ([mail.md](mail.md));
- the [wildcard certificate](#wildcard-certificate-for-dev-sites-recommended) dev sites share, on the
  servers you switch it on for.

Without a token everything still works: the panel says which records to create, and you create them.

Create the token in Cloudflare under **My Profile → API Tokens → Create Token** ("Create Custom
Token"), with **Zone → Zone → Read** and **Zone → DNS → Edit**, on the zones you host or on all of
them. Zone Read is what finds a name's zone; Cloudflare refuses to list zones without it.

**Check** asks Cloudflare what a token reaches before anything depends on it: whether it takes the
token at all, the zones it can read, and for each dev domain of the fleet the zone it is in and
whether its records are readable. It only reads. **Save token** runs the same check first and keeps
nothing Cloudflare refuses, or that reaches no zone.

The token is write-only: no page and no API answer contains it once it is saved — a Read only API key
sees whether there is one, and when it was set. It lives in the panel's database
(`/srv/panel/panel.db`), with the panel's other credentials, and each server's Traefik is given a
copy (below). Replacing it restarts Traefik on every server that held the old one; removing it
rebuilds the dev sites that shared a wildcard certificate from Cloudflare, since nothing could renew
that certificate any more.

`CF_DNS_API_TOKEN` in `deploy/.env` — with `DNS_PROVIDER` empty or `cloudflare` — fills this in on the
panel's first boot, so an install configured that way keeps working through the update that brings
Settings → DNS. It is not read again: the panel owns the token from then on, as it owns the backup
schedule ([configuration.md](configuration.md#seeds)), and the DNS tab says when `.env` holds a
different one.

## Additional servers (fleet)

With more than one server (docs/multi-server.md) there is still **one** dev domain; records become
per-server:

| Record | Name | Value |
|---|---|---|
| A | `panel.example.com` | server 1 (the panel) |
| A | `*.dev.example.com` | the **wildcard server** — server 1 by default |
| A | `<site>.dev.example.com` | that site's server — panel-managed for sites on non-wildcard servers (TTL 300, unproxied; a specific record beats the wildcard) |
| A + rDNS | one `MAIL_HOSTNAME` per server (direct mail mode) | that server's IP |

The panel creates a site's explicit record at creation, re-points it on a move and deletes it with the
site, through the Cloudflare token in Settings → DNS. Without one everything still works: the panel
warns and prints the record to create by hand. For direct mail, override each worker's
`MAIL_HOSTNAME` default (`mail.<dev domain>`) so every server has its own name with matching reverse
DNS.

## Wildcard certificate for dev sites (recommended)

Switched on per server, under **Settings → DNS → Wildcard certificate**. On a server with it on, the
dev sites share one `*.dev.example.com` certificate, issued over DNS-01. Without it each dev site gets
its own HTTP-01 certificate — fine for tens of sites, but it consumes Let's Encrypt's
50-certificates/week budget per registered domain.

- **On** needs the server's Traefik to answer the challenge: with Cloudflare, the token has to reach
  the dev domain's zone and its records, and the panel asks Cloudflare before it agrees. It reaches the dev sites
  created or rebuilt from then on; a dev site with a certificate of its own keeps it.
- **Off** rebuilds the dev sites that share the certificate onto certificates of their own — a
  `site.reconcile` each, a few seconds of downtime per site. So does removing the token, for the
  servers that got it from Cloudflare. A site busy with a job of its own at that moment is rebuilt
  by the hourly site network repair.

**How Traefik gets the token.** Every server's Traefik reads it from
`${SRV_ROOT}/traefik/dns/cloudflare-api-token` (`CF_DNS_API_TOKEN_FILE` in
`deploy/docker-compose.yml`), a file the panel writes (0600) and keeps in step with Settings: right
after a change, within a minute on a server that was away, and again every half hour. Traefik reads
it the first time it needs it and keeps what it read for as long as it runs, so when a token Traefik
may hold is replaced or removed, the panel restarts Traefik on that server — a few seconds in which
its sites do not answer. A first token needs no restart. The table on Settings → DNS says, server by
server, whether its Traefik has the token and when it was last restarted for it.

A server running a stack from before Settings → DNS has to be updated first — **Settings → Updates**
for server 1, **Update** on a worker's page. Until then its Traefik reads its own `deploy/.env`, and
the table says so: with a token there it keeps working with that one; without the DNS resolver at
all, the panel refuses to switch its wildcard certificate on.

**Another DNS provider.** The DNS-01 resolver uses `DNS_PROVIDER` from the server's `deploy/.env`
(any name from https://doc.traefik.io/traefik/https/acme/#providers), Cloudflare when it is empty. Set
it and that provider's credentials there (see the variables in `deploy/docker-compose.yml`), recreate
Traefik (`./provision/compose.sh up -d traefik`), and the switch in Settings → DNS uses it, with no
Cloudflare token needed. The panel's own records still go through Cloudflare only.

On a fleet, *every* server issues its own `*.dev.example.com` certificate. Let's Encrypt allows 5
certificates per week for an identical name set, so switch it on for at most 5 servers a week;
renewals spread out naturally.

## Go-live (per customer domain)

Ask the customer (or set on their behalf):

| Record | Name | Value |
|---|---|---|
| A | `customerdomain.com` | IPv4 of the site's server |
| A (or CNAME to apex) | `www.customerdomain.com` | IPv4 of the site's server |

Then use **Go live** on the site page (or `POST /api/sites/<slug>/go-live`). The certificate is issued on
the fly; the dev hostname keeps serving until the switch completes and can remain as a 301 redirect.

If the customer's zone is one the Cloudflare token reaches, switch on **Point them at this server
through Cloudflare** in the Go live dialog (`manageDns: true` in the API) and the panel creates or
updates exactly these records itself before requesting the certificate.

## Email deliverability

Full guide, plus the panel checks that verify each record: **docs/mail.md**. With a Cloudflare token
in Settings → DNS the panel can publish these itself from **Mail → Setup guide** — SPF merged into any
record already there, never replaced. In short, per customer domain:

| Record | Name | Value |
|---|---|---|
| TXT (SPF) | `customerdomain.com` | `v=spf1 ip4:<every server ip> ~all` (direct) or the provider's `include:` (smarthost) — exactly **one** SPF record per domain |
| TXT (DKIM) | `wpl7._domainkey.customerdomain.com` | generated by Panel → Mail → **Enable DKIM** |
| TXT (DMARC) | `_dmarc.customerdomain.com` | `v=DMARC1; p=none; rua=mailto:dmarc@customerdomain.com` to start |

And once per server, for direct delivery only:

| Record | Name | Value |
|---|---|---|
| A | `mail.example.com` (`MAIL_HOSTNAME`) | that server's IPv4 |
| PTR (reverse DNS) | that server's IPv4 | `mail.example.com` — set at your VPS provider |

Direct delivery also needs outbound port 25 unblocked (Hetzner/DO block it for new accounts). A
smarthost (`SMTP_RELAYHOST`) avoids the port, the rDNS and the per-server SPF entries entirely, and
is recommended once you run more than one server.
