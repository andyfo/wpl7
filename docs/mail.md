# Mail

PHP `mail()` works on every site the moment it is created — no SMTP plugin, no per-site
credentials. This page explains how, what the panel's **Mail** section shows you, and the three
DNS records a customer domain needs before its mail reliably reaches an inbox.

## How it works

```
wp-<slug>  ──PHP mail()──▶ msmtp ──SMTP:587──▶ wpl7-mail (postfix)
                                                    │  milter
                                                    ▼
                                               wpl7-dkim (OpenDKIM)  signs
                                                    │
                                                    ▼
                                    smarthost  ·or·  recipient MX
```

* The site image (`wpl7-wordpress:php8.x`) has msmtp installed as `sendmail`, so PHP's `mail()` —
  and therefore `wp_mail()` and every plugin built on it — hands the message to the `wpl7-mail`
  container over the site's own internal network.
* Each site **authenticates with its own login** (`<slug>@wpl7`), and the relay refuses any sender
  domain that belongs to a different site — see Sender authorization below.
* `wpl7-mail` queues and retries. It publishes no ports and is unreachable from the internet, so it
  is not an open relay.
* On the way through, `wpl7-dkim` signs the message for a domain that has a key (below) — when the
  site that sent it owns that domain.
* Delivery is either **smarthost** (`SMTP_RELAYHOST` set — every message relayed through one
  provider account) or **direct** (postfix talks to recipient mail servers itself).

One relay serves every site on a server, which is why the panel can show *all* outbound traffic
in one place.

### Smarthost or direct?

| | Smarthost (`SMTP_RELAYHOST` set) | Direct (default) |
|---|---|---|
| Deliverability | The provider's reputation — good from day one | Yours; needs rDNS, SPF, DKIM, and a warm-up period |
| Outbound port 25 | Not needed | Must be unblocked by your VPS provider (Hetzner/DO block it by default) |
| SPF record | Points at the provider (their instructions) | Must list every one of your server IPs |
| Cost | Per-message, above a free tier | None |

A smarthost is recommended for customer-facing mail. Direct delivery is fine for a single server
with correct DNS, and the panel checks all of it for you.

## Sender authorization

Signing decides purely on the `From:` domain. So on a shared relay that accepts anything, one
compromised site could emit mail as **any other customer on the fleet** — DKIM-valid, SPF-aligned
and indistinguishable from the real thing. Phishing a customer's own clients, from your IP, with
your signature on it.

Every site therefore gets its own SASL credential, written to
`/srv/sites/<slug>/config/msmtprc` and mounted at `/etc/msmtprc`, and the panel publishes a map of
which login owns which sender domain. Postfix enforces it with
`reject_known_sender_login_mismatch`:

| Site alpha sends as… | Result |
|---|---|
| its own domain (or dev hostname) | accepted |
| a domain belonging to site beta | **`553 Sender address rejected: not owned by user alpha@wpl7`** |
| a domain with a DKIM key but no site | rejected — those are parked on a login nobody holds |
| a domain the fleet knows nothing about | accepted |

The last row is deliberate: the `known` variant of the rule leaves unknown domains alone, so a
customer relaying their own off-fleet address keeps working. Nothing off-fleet can be signed here
anyway, and the recipient's SPF/DMARC judges it.

That rule holds the **envelope** sender. A signature vouches for the **`From:` header**, which a
site writes as it likes — `MAIL FROM:<wordpress@alpha.example>` with `From: ceo@beta.example`
passes the relay. So the signer holds the header to the same owners: its signing policy
(`/srv/mail/dkim/policy.lua`, run by OpenDKIM for every message) signs only when the login the
relay authenticated owns the `From:` domain, or a domain between it and the key's.

| Site alpha's message, `From:`… | Signed? |
|---|---|
| its own domain, or a subdomain of it | yes, with that domain's key or the key above it |
| a domain belonging to site beta, or a subdomain of beta's | no — delivered unsigned |
| a domain with a DKIM key but no site | no |
| anything, without logging in | no |

Mail that goes out unsigned is judged by the recipient's DMARC as the unauthenticated mail it is:
with `p=reject` it bounces, which is the point. The panel's own mail — test sends and account
emails, injected with `sendmail` inside the relay — reaches the signer from `127.0.0.1`, where no
site can connect from, and is signed as before.

Everything the relay needs is panel state (`/srv/mail/policy/*`, `/srv/mail/sasl/sasldb2`, and the
owners the signer reads, `/srv/mail/dkim/SenderLogins`), written on every site create, delete, move
and domain change, and republished at panel boot. At boot the panel also brings each signer's
config and policy up to date where they differ, and restarts only those signers. The panel's own
**Send test message → From the relay** injects with `sendmail` inside the container, so it bypasses
authentication by design and keeps working even when every site login is blocked.

In local development the relay is Mailpit, which enforces nothing — the panel logs one line saying
so at boot. Sender authorization is a production property.

### Suspension (the abuse guard)

**Volume by site** flags a site above the alert threshold. Past the higher *suspension* threshold
(Settings → Mail, default 1000 messages/hour, `0` disables it) the panel stops asking you to look
and acts: the login goes into a reject map, the relay refuses that site's mail, and the panel emails
the address in Settings → Mail → **Send alerts to**.

The site keeps serving pages — only its outbound mail stops. That is the proportionate response to
"this looks like a spam run": the queue stops filling and the server's IP stops earning a listing
that every other customer on it would pay for, while you look at the site. Resuming is deliberately
manual, from the site page (**Resume mail**): whether it was a compromise or a newsletter is not a
question the counter can answer.

## Panel → Mail

### Overview

Per-server health checks, and the first place to look when someone says "the contact form stopped
working":

| Check | Meaning |
|---|---|
| `relay` | `wpl7-mail` is running. If it is not, `mail()` fails for **every** site on that server. |
| `dkim` | `wpl7-dkim` is running. Mail still goes out if it is down, just unsigned. |
| `hostname` | The name postfix announces. Reverse DNS should match it. |
| `mode` | Smarthost (with the relay host) or direct. |
| `milter` | Postfix is actually wired to the signer. |
| `port-25` | Direct mode only: whether outbound port 25 is open. A blocked port is otherwise invisible until customers report missing mail days later. |
| `queue` | How much mail is waiting, and how much is deferred. |

**Send a test message** does it two ways:

* **From the relay** — injects straight into postfix, skipping WordPress. Proves the relay, the
  signing and the delivery path. Use a sender at a domain that has a DKIM key to exercise signing.
* **From a site** — runs `wp_mail()` inside the site container: the exact path a password reset or
  a contact form takes, including PHP configuration and msmtp.

If the relay test arrives and the site test does not, the problem is in that site (a plugin
overriding `wp_mail`, an SMTP plugin pointed elsewhere), not in mail delivery.

**Volume by site** is the abuse view. A compromised WordPress install used as a spam relay looks
like one of two things, and both are flagged:

* **high volume** — more than the configured budget (Settings → Mail, default 200 messages per
  site per hour)
* **many failures** — over 40% of at least 20 messages bounced or rejected, which means the
  recipient list was scraped rather than earned

The sending site is taken from the **connection** (the site's own container), not from the `From:`
header, so a compromised site cannot attribute its mail to somebody else.

### Setup guide

A step-by-step walkthrough for this install, with the live state of every record inline —
your server IPs and hostnames already filled in, and each check run against public DNS so a
green mark means the record really is published, not that someone was asked to publish it.

1. **Each server** — the mail hostname's A record, reverse DNS (with instructions for your
   VPS provider, picked from a dropdown), and outbound port 25.
2. **Each sending domain** — SPF, DKIM and DMARC in the order they must be published.
3. **Prove it works** — what to send and which headers to read.

Where the panel holds a DNS API token (below), each step gets a **Publish** button. Where it
does not, the same step shows the exact record to add by hand — nothing is hidden behind the
automation.

### Traffic

Every message the relay handled, one row per recipient, with sender, recipient, DKIM verdict,
delivery status and the receiving server's response. Filter by site, status, time window, or a
substring of either address. Click a row for the full detail including the SMTP reply.

Traffic is parsed from each relay's log once a minute; **Refresh now** pulls it immediately.
History is kept for 30 days by default (Settings → Mail).

`status` values: `sent` (accepted by the receiving server), `deferred` (temporary failure, postfix
will retry), `bounced` (permanently refused), `rejected` (refused before being queued), `expired`
(retried until postfix gave up), `queued` (accepted, not yet attempted).

### Queue

What postfix is still trying to deliver. A handful of deferred messages is normal. A growing queue
means delivery is failing — the reason is printed on each row.

* **Retry all** asks postfix to try everything again (use after fixing a relay password or DNS).
* **Delete** drops one message; **Empty** drops the whole queue, including legitimate mail waiting
  on a temporary failure.

### DKIM & DMARC

One block per sending domain, with a live check of each record and the exact value to publish.

## Letting the panel publish the records

Give the panel a DNS API token and the Setup guide stops printing values to copy and starts
writing them:

```
DNS_PROVIDER=cloudflare
CF_DNS_API_TOKEN=<token with Zone → DNS → Edit on the zones you host>
```

This is the **same token** the wildcard-certificate overlay already uses (docs/dns.md), so on
an install with wildcard dev certificates it is usually configured. Re-run provisioning after
adding it.

The panel then publishes SPF, DKIM and DMARC for any domain whose zone is in that account.
These records are shared with mail this platform never sent, so a set of rules governs what it
will and will not do:

* **SPF is merged, never replaced.** A customer on Microsoft 365 keeps their
  `include:spf.protection.outlook.com`; the panel inserts `ip4:<server>` just before the
  `all` term and leaves everything else alone. It refuses when two SPF records are published
  (consolidate them first) or when the merge would exceed the 10-lookup limit.
* **An explicit denial is never flipped.** A record containing `-ip4:<server>` is rejecting
  this server on purpose. The panel reports the conflict instead of quietly turning it into
  an authorization.
* **An existing DMARC policy is never touched.** Overwriting a deliberate `p=reject` with the
  starter `p=none` would quietly weaken a customer's security, so a published record is left
  as it is — and a record that is published but *broken* (no `p=` tag, so receivers ignore it)
  is reported for you to correct rather than counted as done.
* **Unrelated TXT records at the same name are preserved.** Only the SPF/DKIM/DMARC record is
  replaced — domain-verification tokens sharing the name survive.
* **DKIM is not published until the key is on every server.** If a relay cannot be reached,
  the DNS record is withheld and the failure named: promising receivers a signature that a
  server cannot produce is worse for delivery than no DKIM record at all. The key is kept, so
  publishing again after fixing the server picks up where it left off.

Every automated write is previewed before you press the button, and reported afterwards.

The preview comes from public DNS, but **what actually gets written is decided from the zone
itself** at the moment of writing. The two disagree more often than you would think — a record
added minutes ago, a resolver returning SERVFAIL, an answer still cached — and a plan built on
"nothing is published" must never be written over a record that plainly is.

### What cannot be automated

**Reverse DNS.** The PTR for an IP address lives in the *IP owner's* zone, not the domain's,
so it is set wherever the server was rented and no DNS provider token can reach it. Automating
it would mean a second credential per hosting provider — a Hetzner Cloud or DigitalOcean API
token, which carries far more power than writing a DNS record — for something you do once per
server. The Setup guide therefore ships per-provider instructions instead: pick your provider
and follow the four or five clicks.

**An SMTP provider's SPF value.** In smarthost mode the record has to name your provider's
servers, and only they know what that is. The panel never guesses it.

## The three records

These go in the **customer's** DNS zone, not yours — usually alongside the A record at go-live.

### 1. SPF — which servers may send

A single TXT record on the domain itself:

```
customerdomain.com.  TXT  "v=spf1 ip4:203.0.113.9 ~all"          # direct delivery
customerdomain.com.  TXT  "v=spf1 include:mailgun.org ~all"      # smarthost (provider's value)
```

* On a fleet, list **every** server IP, so moving a site never needs an SPF edit. The panel
  suggests exactly that record.
* There must be **exactly one** SPF record. Two makes receivers fail the check outright; the panel
  warns when it finds more than one.
* If the domain already has an SPF record (Microsoft 365, Google Workspace), **merge** into it —
  add `ip4:…` or `include:…` to the existing record rather than publishing a second one.
* `~all` (softfail) is the safe default. `-all` is stricter but unforgiving of a forgotten sender.
* SPF allows at most 10 DNS-querying mechanisms. The panel counts them and warns before receivers
  start treating the record as broken.

### 2. DKIM — a signature proving the mail is untampered

Press **Enable DKIM** on the domain. The panel generates a 2048-bit key, stores the private half in
its own database, writes it to every server, restarts the signers, and gives you the record:

```
wpl7._domainkey.customerdomain.com.  TXT  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBg…"
```

Most DNS providers accept the long value as-is. For BIND-style zone files the panel also offers the
value pre-split into 255-character strings (**Records → zone-file form**).

Notes:

* A key at `customerdomain.com` also signs mail from its subdomains (`shop.customerdomain.com`),
  with `d=customerdomain.com` — one record covers a whole customer.
* Keys belong to the panel, not to a server, and every server gets a copy. A site that **moves
  between servers keeps signing with the same published key**; nothing to re-publish at cutover.
* **Rotate key** generates new material under the same selector — update the one record afterwards.
  Mail already in flight is unaffected: receivers fetch the key when they verify.
* **Remove key** stops signing immediately. Delete the `_domainkey` record too, or receivers keep
  expecting a signature that no longer arrives.
* A domain with no key still sends mail; it just goes out unsigned.

### 3. DMARC — what to do when SPF and DKIM fail

```
_dmarc.customerdomain.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@customerdomain.com; adkim=r; aspf=r"
```

Publish SPF and DKIM **first**. A strict DMARC policy on a domain that fails both sends legitimate
mail to the spam folder.

* Start at `p=none` — monitoring only — with a `rua=` address so you receive reports.
* After a couple of weeks of clean reports, move to `p=quarantine`, then `p=reject`.
* `adkim=r` / `aspf=r` (relaxed alignment) is what lets a `d=customerdomain.com` signature cover
  `shop.customerdomain.com`.

### Changing the mail hostname

`MAIL_HOSTNAME` is the name postfix announces in HELO. It is chosen once at provisioning and
defaults to `mail.<the panel's domain>` — `panel.example.com` gives `mail.example.com` — but it can
be any name you control: `smtp.` instead of `mail.`, or a different domain entirely. It is
per-server, so each machine in a fleet can have its own.

Change it in **Mail → Setup guide → step 1 → Change hostname**. The dialog shows the name in
use and the default, `MAIL_HOSTNAME`; type a new name and **Apply**, or **Reset to default** to
drop a name set in the panel. Either takes effect immediately — postfix is reloaded rather than
restarted, so nothing queued is lost — and is kept when the relay restarts or is recreated.
Typing the default name is the same as resetting to it.

<details>
<summary>How that persists, and the command-line equivalent</summary>

`deploy/.env` lives in the git checkout, which the panel cannot reach on its own server (only
`${SRV_ROOT}` is mounted into it). So a hostname set in the panel is written to
`/srv/mail/relay.env` as `POSTFIX_myhostname=…`, which the mail service reads back as an
optional `env_file`. `POSTFIX_*` settings are applied after the image's own configuration, so
it wins over the `MAIL_HOSTNAME` default without the two having to agree.

A container keeps the environment it was created with, and the relay image applies it again
every time it starts. A restart that is not a recreate (a reboot, Docker restarting) therefore
brings back the name the container was created with. The panel checks every minute and puts
the right one back, with a reload.

From a shell, let the provisioner do it. A hostname passed explicitly is applied even on an
existing install, where `.env` is otherwise left alone, and it clears any name set in the
panel, even when `.env` already holds the one you pass:

```bash
sudo /opt/wpl7/provision/setup.sh --mail-hostname=smtp.example.com
```

Editing `MAIL_HOSTNAME` in `.env` by hand changes the default only. It takes effect when the
relay is recreated, and only while no name is set in the panel; reset that first, or the
override keeps winning:

```bash
sudo sed -i 's|^MAIL_HOSTNAME=.*|MAIL_HOSTNAME=smtp.example.com|' /opt/wpl7/deploy/.env
sudo /opt/wpl7/provision/compose.sh up -d mail
```

</details>

Then, in DNS:

1. Add an A record for the new name pointing at the server.
2. Change the server's **reverse DNS** to the new name (see below) — a PTR still pointing at
   the old one is a mismatch, which is worse than having none.
3. The old name can be dropped once nothing references it.

Nothing else moves: SPF authorizes IP addresses and DKIM is keyed to the sending domain, so
neither record mentions this name. Panel → **Mail → Setup guide** reads the hostname back from
the relay, so both checks re-verify on their own.

One caveat: receivers treat a changed HELO name as a new sender, so the reputation you have
built rebuilds over a few days. Worth doing before you have much traffic rather than after.

### Reverse DNS (direct delivery only)

Set the PTR record of each server IP to that server's `MAIL_HOSTNAME`, in your VPS provider's
control panel — **Mail → Setup guide** has click-by-click instructions per provider. Receivers check that the IP resolves back to a name and that the name resolves
forward to the same IP; a missing or mismatched PTR is the single most common reason self-hosted
mail is rejected outright. The panel checks both directions under **Overview → Reverse DNS**.

## Configuration

`deploy/.env`:

| Variable | Meaning |
|---|---|
| `MAIL_HOSTNAME` | The name postfix announces. Give it an A record and matching reverse DNS. |
| `SMTP_RELAYHOST` | Smarthost, e.g. `[smtp.eu.mailgun.org]:587`. Empty = direct delivery. |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | Smarthost credentials. |

Panel → Settings → Mail:

| Setting | Default | Meaning |
|---|---|---|
| Keep traffic history for | 30 days | Pruned nightly. |
| Flag a site above | 200 / hour | Per-site volume that marks a site suspicious. |

On disk (each server):

```
/srv/mail/dkim/                  mounted read-only at /etc/opendkim/keys
/srv/mail/dkim/<domain>/<sel>.private   private key, mode 0600
/srv/mail/dkim/KeyTable                 each domain's key, named after the domain
/srv/mail/dkim/policy.lua               the signing policy: which sender gets which key
/srv/mail/dkim/SenderLogins             which login owns which domain, read by the policy
/srv/mail/opendkim.conf          mounted over the signer's own config
```

Every one of those files is written by the panel and rewritten on each DKIM sync; edits are lost.
Use **Re-sync signers** after restoring a server or if a signer has drifted.

The postfix queue lives in the `wpl7_mailspool` Docker volume rather than under `/srv`: postfix
keeps chrooted sockets there that a host bind mount cannot always host, and mail in flight is not
something to back up.

## Upgrading an existing install

Signing runs in a new container (`wpl7-dkim`), so an install from before it existed needs one pass of
the normal update flow — on **every** server, workers included:

```bash
cd /opt/wpl7 && git pull && sudo ./provision/setup.sh
```

`setup.sh` creates `/srv/mail`, writes a starting `opendkim.conf`, seeds the (empty) sender-authorization
maps, and `compose up` then starts `wpl7-dkim` and recreates `wpl7-mail` with the milter and SASL wired
in. Mail keeps flowing throughout: with no keys yet, the signer accepts every message and signs
nothing. Worker servers can also be updated from the panel (**Servers → Update**), which pushes the
same bundle over SSH.

Sites created before per-site mail authentication have no relay login, and their containers have no
msmtp credential mounted — their mail is refused with `553 … not logged in` until they are
reconciled. **You no longer have to remember this**: the panel queues one `site.reconcile` per site
for itself after an update, as part of the post-update job, and republishes the relay credentials
and DKIM material in the same pass ([updating.md](updating.md#what-the-panel-does-afterwards)). If a
step there failed, the Updates page has a **Re-run** button; **Sites → Recreate container** (or
`POST /api/sites/reconcile-all`) still does the same thing by hand.

Afterwards, Panel → **Mail → Overview** should show `relay`, `dkim` and `milter` all green; then
enable DKIM per customer domain from the **DKIM & DMARC** tab. Existing traffic history starts from
the upgrade — the panel reads each relay's log from the point it first looks.

## Troubleshooting

**`wp_mail()` returns false**
The message never reached postfix. Check that the site container is running and that `wpl7-mail` is
up (Mail → Overview). `docker logs wpl7-mail` shows connection attempts.

**Mail is accepted but never arrives**
Look at Traffic for that recipient. `sent` means the receiving server took it — it is in their spam
folder or their own filtering. `deferred` or `bounced` shows the reason in the row.

**Everything is deferred with "Connection refused" or "Connection timed out" on port 25**
Direct mode with a blocked port. Ask your VPS provider to unblock outbound 25, or set
`SMTP_RELAYHOST`. The `port-25` check on the Overview tab tests this.

**Mail arrives but lands in spam**
Work down the Deliverability tab until SPF, DKIM and DMARC are all green, and check reverse DNS.
New IPs also need warming up: volume ramped gradually over a couple of weeks.

**A domain's DKIM check says the published key is different**
The record in DNS no longer matches what the panel signs with — usually a rotation whose record was
never updated, or a copy/paste that lost characters. Open **Records** and republish the value.

**Signatures stopped after restoring or rebuilding a server**
Press **Re-sync signers**. It rewrites every key, table and config file, then restarts the signers.

**A site is flagged for volume**
Open it, check recently installed or modified plugins and the user list, and look at Traffic
filtered to that site — spam runs have wildly varied recipients at consumer domains. Stop the site
to cut off sending, then empty the queue of what it already handed over.

**`553 Sender address rejected: not owned by user <slug>@wpl7`**
The site tried to send as a domain another site owns. If that is an attack, you have just watched it
fail. If the domain legitimately belongs to this site, it is missing from the site's domain list —
add it there and the map follows.

**`553 Sender address rejected: not logged in`**
The message reached the relay without authenticating: a site created before per-site mail
authentication, or one whose `/etc/msmtprc` is missing. Run **Recreate container** on that
site.

**`554 SASL login name rejected`**
The abuse guard (or an operator) suspended this site's outbound mail. The site page shows the reason
and a **Resume mail** button.

**Every message tempfails with `451 4.3.5 Server configuration error`**
Postfix could not open one of its maps — usually `/srv/mail/policy/*` missing after a manual cleanup.
Restart the panel: it republishes them at boot. `docker logs wpl7-mail` names the file.

## See also

* [docs/dns.md](dns.md) — every DNS record the platform needs, mail included
* [docs/troubleshooting.md](troubleshooting.md) — the wider symptom list
* [docs/architecture.md](architecture.md) — where the mail containers sit in the stack
