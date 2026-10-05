# Security

WPL7 contains a hacked site well (docs/operations.md#blast-radius-of-one-compromised-site). This
page is about the three things that keep attacks out and notice the ones that got in:

| | What it does | Where |
|---|---|---|
| [Site protection](#site-protection) | Refuses requests no visitor makes, limits logins and request rates, sends a few headers, and hardens each site from inside its container | **Sites → Security**, and each site's **Security** tab |
| [Blocked addresses](#blocked-addresses) | Notices an address attacking your sites and blocks it on every server, at the firewall | **Servers → Security** |
| [Malware scans](#malware-scans) | Holds every site's files to wordpress.org's published checksums, looks for known malware in the rest, and can move it out | each site's **Security** tab |

All three are on by default: every site gets **Standard** protection, automatic blocking is on,
and every site is scanned once a day, reporting rather than moving anything. Each has a switch
that takes it away within a minute ([below](#switching-it-off)).

Three rules hold throughout:

1. **Fail open.** A rule that cannot be applied leaves the site served as it was before;
   nothing here can take a site offline by failing. What a server already enforces stays
   enforced when the panel is down.
2. **Nothing the site can write switches a protection off.** Rules live in Traefik and in files
   mounted read-only into the site's container - never in `.htaccess`.
3. **The symlink rule** (docs/architecture.md): nothing running as root on the host follows a
   link inside a site's folder. Scans and quarantine run in throwaway containers, as the site's
   own user, with only that site's files mounted.

## Site protection

### Levels

A site either follows the **default** (set on **Sites → Security → Settings**) or has a level of its own.

| | Off | Standard (the default) | Strict |
|---|---|---|---|
| Sensitive files - `.env`, `.git`, wp-config copies, `debug.log`, SQL dumps | - | refused | refused |
| PHP in uploads - any `.php`, `.phtml`, `.phar` under `wp-content/uploads` | - | refused | refused |
| Install scripts - `wp-admin/install.php`, `setup-config.php` | - | refused | refused |
| Scanner user agents - sqlmap, Nikto, WPScan, Nuclei and the like | - | refused | refused |
| User enumeration - `/?author=N`, and the REST users list to anyone not signed in | - | refused | refused |
| XML-RPC (`xmlrpc.php`) | allowed | limited, 30 a minute, bursts of 2 | refused (Jetpack's servers still reach it) |
| `wp-cron.php` from outside | allowed | allowed | refused (the panel runs cron itself) |
| Login attempts, per address | - | 20 a minute, bursts of 2 | 6 a minute, bursts of 2 |
| Requests, per address | - | 50 a second, bursts of 500 | 10 a second, bursts of 100 |
| Assets (stylesheets, scripts, images, fonts), per address | - | 200 a second, bursts of 4,000 | 100 a second, bursts of 1,000 |
| Headers | - | `X-Content-Type-Options` | also `X-Frame-Options`, `Strict-Transport-Security`, `Referrer-Policy` |
| No PHP in uploads, inside the container | - | on | on |
| No theme and plugin editor in wp-admin | - | on | on |
| No installs or updates from wp-admin | - | - | on |

A refused request gets **403**; one over a limit gets **429** until its rate drops. The limits
are generous on purpose: a limit is felt by everyone behind one office connection, and it is
the [attack detection](#blocked-addresses) that deals with an address that keeps at it.

Every row can be changed on its own - for the default, or for one site - and each shows where
its value comes from: the level, the default, or this site. **reset** takes a site's own change
away again. A site set to **Off** has no rules and no limits at all; its own changes are kept
for when it is switched back.

A site's **Security** tab shows what its scans found and the requests its protection blocked; its
own settings - level, changes, [own rules](#a-sites-own-rules), malware scans - open over it
from **Settings**, with one Save for all of them. **Sites → Security → Settings** lists every
site that set something for itself, with what, and opens the same settings from there.

**Private addresses are never limited** (on by default, **Sites → Security → Settings**). Where Docker has
no IPv6 networking, every IPv6 visitor reaches a site as one private address, and so does the
panel's own uptime probe - a limit on that address would limit all of them together.

### Inside the container

Three settings are enforced by the site's own Apache and WordPress, from two files the panel
writes and mounts into the container read-only:

- **No PHP in uploads**: `php_admin_flag engine off` for `wp-content/uploads`, and every PHP
  name there refused - which a `.htaccess` in the site cannot undo. `AllowOverride` is left
  alone: WooCommerce protects downloads with `.htaccess`.
- **No file editor**: `DISALLOW_FILE_EDIT`, so a stolen admin login cannot rewrite PHP from
  wp-admin.
- **No installs from wp-admin** (Strict): `DISALLOW_FILE_MODS`. Updates from the panel keep
  working - both constants apply to web requests only, never to WP-CLI.

A constant the site's own `wp-config.php` defines first wins; PHP has no way to take one back.
These guard against a stolen login, not against code already running in the site.

A change is applied without a restart: the PHP file is replaced and read at the next request;
the Apache file is checked with `apache2ctl -t` first and applied with a graceful reload, and
one Apache refuses is put back and reported on the site's tab. The files live in
`<SRV_ROOT>/sites/<slug>/config/` (`security-apache.conf`, `security/wp-config-extra.php`).

Containers created before this carry no such mounts. The panel rebuilds each of them once, by
itself, with a **Recreate container** job - see [updating](#what-an-update-does).

### A site's own rules

**Security tab → Settings → This site's own rules**: up to 30 rules, each **block** or **allow** when all
(or any) of up to eight conditions hold:

| Field | Operators |
|---|---|
| Path | is, starts with, contains, matches (a regular expression) |
| User agent | is, starts with, contains, matches |
| Method | is |
| Query parameter (by name) | is, starts with, contains, matches, is present |
| Address | is (an address or a range, at most a /8 or a /16) |

Each condition can be negated. **Allow** lets a request through ahead of every other rule and
limit - for a payment provider's callbacks, say. Regular expressions are Go's (RE2): no
lookaround, no backreferences; `(?i)` makes one case-insensitive. A backtick and `{{`/`}}` are
refused anywhere in a rule - Traefik reads its rule files through Go's template engine.

A rule is never Traefik's own syntax: the panel writes that, escaping every value. Each rule is
its own router, so one Traefik refuses takes nothing else down with it - the tab says which.

### How it is applied

Each site's protection is one file on its server, `<SRV_ROOT>/traefik/dynamic/sec-<slug>.yml`,
with a router per rule and limit above the site's own router, which stays as the fallback. The
file is written when the site is created, started, moved, given new domains or its protection changes,
and removed when it stops or leaves the server; a built-in task, **Site protection**, puts
right every minute whatever drifted. A file is rewritten only when what it says changes:
Traefik restarts every rate limiter whenever any file in the folder changes.

A banner on the site's tab says when its protection is not in force as set - its server could
not be reached, a value could not be written, its container predates the in-container files -
or when Traefik refused one of its rules.

**Blocked requests** are counted from the same access log as the visitor statistics: per rule,
per day, and the last 500 per site. An address is kept only as **Settings →
Visitor statistics** says.

### Visitors behind a proxy

Behind Cloudflare or a load balancer, every visitor seems to be the proxy. For a **trusted
proxy** the visitor's own address is read from the proxy's header instead - but only when the
connection itself comes from that proxy's addresses, so a header sent by anyone else changes
nothing. Limits, blocks and the visitor statistics all use it, and so does Jetpack's way past
the XML-RPC rules - only for a header that holds one of Jetpack's addresses and nothing else.

**Settings → Security → Trusted proxies**: Cloudflare is built in and on (`Cf-Connecting-Ip`, its ranges
kept current weekly by the panel, and harmless for a site that is not behind it). Your own
proxies need a name, the addresses they connect from, and their header: `True-Client-Ip` or
`Fastly-Client-Ip`. A proxy that only sends `X-Forwarded-For` cannot be trusted this way: anyone
can send that header.

## Blocked addresses

### Detection

The panel reads every server's access log each minute and counts, per visitor address (an IPv6
visitor by its /64), across every site and server:

| Rule | Counts | Blocks at |
|---|---|---|
| Login guessing | `POST wp-login.php` answered 200 (the form again), 401, 403 or 429 | 20 in 10 minutes |
| XML-RPC | `POST xmlrpc.php` - one request can carry hundreds of guesses | 60 in 10 minutes |
| Probing | a path only an attacker asks for (`/.env`, `/wp-config.php.bak`, `/phpmyadmin/`: 4 points) or a request a rule refused (1 point), each path once | 12 points in 10 minutes |
| Dead URLs | 404 on a page (not an asset), each path once | 60 in 5 minutes |
| Flooding | 429 from a rate limit, on a page | 300 in 10 minutes |

The first block lasts an hour, each repeat within 30 days four times as long, never more than
30 days. A block lifted by hand is not a repeat. All of it is on **Servers → Security →
Detection**, with **Automatic blocking**: **On**, **Observe** (write down what would have been
blocked, block nothing), or **Off**.

**Never blocked:** private addresses, the fleet's own servers, the panel as each server sees
it, trusted proxies, Jetpack's servers, the **never-block** list, and every address an admin
used the panel from in the last 30 days - so nobody locks themselves out. Nor are AI
assistants, by the addresses their companies publish for their bots: OpenAI (ChatGPT, GPTBot),
Anthropic (Claude), Google's fetchers and agents (Gemini), Perplexity, Mistral and DuckDuckGo
(DuckAssistBot). The panel fetches those lists weekly, like Cloudflare's; a bot whose company
publishes none is a visitor like any other. Their requests are still limited. A search engine's
crawler is checked by reverse DNS, confirmed forward, before anything is decided; three or more
different browsers behind one address look like a shared connection and get a note, not a
block. The Detection tab lists what was decided, and why not when not.

### Enforcement

A block is in force on **every server** within a minute, for ports 80 and 443 only - SSH and FTP
keep their own protection:

| Layer | For | How |
|---|---|---|
| Network | direct visitors | a table of its own in the kernel's firewall, `table inet wpl7`, ahead of Docker's port forwarding: the visitor's packets are dropped. Timed blocks expire in the kernel, panel or no panel, and a reboot does not start them over |
| HTTP | visitors behind a trusted proxy | one Traefik file per server, `wpl7-blocked.yml`: the proxy's header matched against the list, answered 403. At most 5,000 addresses |
| HTTP, fallback | direct visitors on a server where the network layer is not available | the same file, at most 2,000 addresses |

The network layer is loaded by `wpl7-firewall`, a helper `provision/setup.sh` installs with a
unit of its own that loads the last list at boot (docs/scripts.md). It never touches another
table - UFW's and Docker's stay as they are. **Servers → Security → Enforcement** shows each
server: **In force**, **HTTP only**, **Off on the server**, **Not installed** (the server has not
been set up since Security arrived; updating it does that).

**Blocking by hand**: **Servers → Security → Block an address**, **Block** beside an address on a
site's Visitors tab or in its blocked requests, or `POST /api/security/blocks`. An address that
is never blocked is refused, with the reason.

A blocked address is kept while it is blocked and 30 days after (`security.historyDays`), for
the history and for counting repeats.

## Malware scans

### One scan

Every site is scanned every 24 hours (**Settings → Security → Malware scans**), or on **Scan now**. A scan
is three short-lived containers, each with that one site's files mounted read-only and nothing
else - no network, no capabilities, a read-only root, one CPU, a memory ceiling, the site's own
user:

1. **What is installed**, read from the files' own headers - WordPress's version and locale,
   each plugin and theme. Nothing of the site is run.
2. **The panel's own check**, against wordpress.org's published checksums, which the panel
   fetches and hands in: WordPress files changed, missing or not WordPress's at all; the same
   for plugins from the wordpress.org directory; PHP and handler tricks in uploads (an
   `.htaccess` mapping images to PHP; Wordfence's own guard is left alone); links that lead out
   of the site. A wordpress.org plugin in a folder of another name - a zip from GitHub, a
   copy - is known by its Text Domain or main file and held to that plugin's list at the same
   version, but only to vouch for files: one that matches is what everyone runs; one that does
   not is left to AMWScan rather than reported as changed, since the folder may hold another
   edition of the plugin, a premium one. The panel's own files are held to what it wrote
   them with (below).
3. **AMWScan's signatures** over whatever the check could not vouch for - premium plugins,
   themes, uploads, anything changed. Folders whose every file matched its published checksum
   are left out. What AMWScan is not asked to say is [below](#what-the-scanner-is-not-asked-to-say).

At most three scans run at a time across all servers, one per server, and none on a server
using more than 90% of its memory. A site's other jobs carry on beside its scan.

### What a scan says

| Result | Means |
|---|---|
| Nothing found | Every engine finished, and nothing is open |
| Findings | Something is open |
| Incomplete | An engine could not read everything, ran out of time or memory, or wordpress.org's checksums could not be fetched. Never shown as clean |
| Failed | Nothing could be scanned. Three in a row send an alert |
| Superseded | A restore, a move or an update changed the files while it read them; it runs again |

Every result also names what had **no published checksums** - premium plugins, themes: AMWScan
read them, but nothing could say they are unchanged. A premium plugin that is a zip in the
panel's plugin catalog can be vouched for by that zip instead (below).

| Finding | Severity |
|---|---|
| Known malware (a signature or a known-malware hash) | high |
| WordPress file changed; unknown file among WordPress's own; PHP in uploads; handler trick in uploads; WPL7 file changed | high |
| Plugin file changed; unknown file in a plugin; link leaving the site | medium |
| Suspicious code (what premium plugins trip too) | low; medium for a known exploit pattern |
| WordPress or plugin file missing | low |

A signature is a pattern, and some are short: the libraries plugins and themes ship can match
one. The free UpdraftPlus, where no checksums vouched for it, matched three - a `php_uname()`
call, a class file, phpseclib naming `.ssh/authorized_keys`. The scan cannot tell legitimate
code from a planted copy of it where nothing vouches for the file - a premium or custom plugin,
a theme - so such a match is reported as known malware, and **Ignore** is how a person says it
is not.

A finding stays one finding from scan to scan. **Ignore** keeps it ignored - until its file
changes. **Resolved** says it was dealt with; a scan reopens it if it is still there. **Reinstall
original** downloads WordPress or the plugin again from wordpress.org, at the version the site
has, over its files, and scans again. **Put back** writes a changed WPL7 file again (below).
**Quarantine** moves the file out (below). A finding links to its file and line in the Files
tab, and one on a file a catalog zip's check flagged too links to that zip's review.

The last scan also names the files AMWScan could only partly read - scripts over 1 MiB, of
which it screens the start and the end - that nothing vouched for. That is a note, not a
finding.

### WPL7's own files

The panel writes two must-use plugins into a site: `wpl7-login.php`, behind **Log in to
WordPress**, and `wpl7-licenses.php`, the constants of its [recipes](licenses.md). It notes the
hash of each every time it writes one, and a scan holds the file to those: the same is the
panel's own and never a finding - the login drop-in signs a user in, which is what a login
backdoor does, and AMWScan's signature for those matches it. A changed one, or a link in its
place, is **WPL7 file changed** (high): how a backdoor would hide. **Put back** writes the
panel's own again from inside the running site, then scans.

A plugin may put a copy of one of its own files outside its folder on purpose. WP Godmode puts
its recovery endpoint at `wp-godmode.php`, at the top of the site, where it still answers when
WordPress does not. A copy the same as the plugin's `direct/wp-godmode.php` is that file, held
to whatever holds the file, not an unknown file among WordPress's own; a different one is.

### On a finding

**Settings → Security → Malware scans → On a finding** (and per site, in the settings on its **Security** tab):

- **Report and alert** (the default): nothing is moved.
- **Quarantine confirmed malware**: a file matching a known-malware signature or hash is moved
  out, where that is safe.
- **Quarantine everything it may**: also what does not belong there, malware or not.

| Where the file is | Confirmed malware | Anything else, on "everything" |
|---|---|---|
| Uploads; an extra file among WordPress's own or at the top of the site | moved | moved |
| An extra file in a wordpress.org plugin | moved | reported |
| A file of WordPress or a plugin that was changed | reported - **Reinstall original** instead | reported |
| A WPL7 file that was changed | reported - **Put back** instead | reported |
| `wp-config.php`, the top `index.php` and `.htaccess`, anything in `mu-plugins`, any link | reported | reported |

Suspicious-code candidates never alert and are never moved, under any setting. Nothing moves
unless the scan recorded the file's hash, and more than 25 files in one scan move nothing at all:
that many is a site for a person to look at.

### Quarantine

A quarantined file goes to `<SRV_ROOT>/sites/<slug>/quarantine/`, beside the site's folder,
mounted into nothing, under a name that is not its own. The move runs in a throwaway container
as the site's user, with only the site's files and that folder: it refuses a path through a
link, checks the file is byte for byte the one the scan saw, copies it, checks the copy, and
only then removes the original. **Put back** is the reverse, never replaces a file that has
appeared at that path since, and marks its findings ignored so a scan does not move it again.

Quarantined files travel with a site that moves to another server, are in no backup, and are
kept until someone deletes them - or for **Keep quarantined files (days)**.

### Plugins from the catalog

A zip uploaded to the plugin catalog (**Plugins**) is checked once, and again whenever the
panel's AMWScan or its tuning changes. It is unpacked in a throwaway container on the panel's
server, with AMWScan's image, no network and nothing else mounted. Every file of its folder is
hashed, its plugin header gives its version, and AMWScan scans the files, tuned as for a site.
The result shows under **Malware check** on the Plugins page.

A site's scan then treats the checked zips of a plugin's folder as it treats wordpress.org's
checksums, whatever version the site has - a premium plugin updates itself, and most of its
files stay as they were:

- **A file the same as one of the zips' is vouched for**, and AMWScan leaves it out. How the
  plugin got onto the site does not matter, only the bytes.
- **A file that is not the same, or not in any of the zips, is scanned as usual.** It is never
  reported as changed: the site may run another build of the plugin.
- **A file a zip's own check flagged, or could only partly read, is not vouched for** by that
  zip until someone opens the check and says those files are the plugin's own code. Sites report it meanwhile, as they
  would without the zip, and their finding links to the review. The review holds for exactly
  the findings it was of: a check that finds anything else asks again.

That makes a premium plugin's false match one question on the Plugins page, rather than an
alert from every site after every update. A zip is trusted only as far as its check and that
review go: one that did not get through every file, or has no single top-level folder, vouches
for nothing.

### Alerts

New serious findings, automatic moves, a clean-up too big to do alone and a third failed scan
in a row are emailed to the alert address (**Settings → Mail**), at most once every six hours
per site. A catalog zip whose check matches known malware is emailed about once.

### AMWScan

The signature scan is [AMWScan](https://github.com/marcocesarato/PHP-Antimalware-Scanner)
(PHP Antimalware Scanner) 0.21.12 by Marco Cesarato, GPL-3.0, pulled by each server as the
official image pinned by digest and run unmodified as a separate process. Open-source
signatures lag behind what is new; the checks against published checksums do not age, and carry
the weight.

### What the scanner is not asked to say

AMWScan reports more than signatures, and on real plugins most of it is noise: on a site with
Breakdance and WP Godmode, 36 of 39 findings. WPL7 tunes what it hands the scanner and what it
keeps of its report (`panel/src/services/scanTuning.ts`), and each part steps aside when the
scanner it was written for changes:

- **"Calls eval(), exec() and the like" is left out.** Plugins do; a signature or an exploit
  pattern is what tells a backdoor from them. The same function hidden behind an encoding, which
  AMWScan rates dangerous, is kept. AMWScan's own help recommends signatures over these for
  WordPress. Each scan's log counts what was left out.
- **Two exploit patterns are tighter.** `str_replace_eval` matched any `str_replace(x, '', y)`
  with an `eval(` anywhere after it - one 433 lines further on; `execution2` read
  `array_filter(array_map('intval', $_POST[...]))` as a callback taken from the request. WPL7's
  versions go into AMWScan's own local-rules folder, and only while AMWScan's pattern is still
  exactly the one replaced; otherwise its own runs, and the scan's log says so.
- **A signature that cannot match running code on PHP 8 is left out**: the bare text
  `@preg_replace`, written for the `/e` modifier PHP 7.0 removed.
- **A script too large to read whole is a note on the scan**, not a finding. A catalog zip holds
  such a file back until it is reviewed: its unread middle is nobody's word.
- **A signature finding is named after the signature itself.** AMWScan names it after its place
  in a merged list of regexes, which moves with every definitions update - and with it every
  ignored finding and every zip review. Where the signature cannot be read back, AMWScan's name
  stays.

The opt-in test in `panel/test/engine` runs the pinned image with all of this over code each
part is for and over backdoor samples: the one stays quiet, the other is caught.

## Settings

| Setting | Default | Where |
|---|---|---|
| `security.level`, `security.overrides` | Standard, none | Sites → Security → Settings |
| `security.bypassPrivate` | on | Sites → Security → Settings |
| `security.trustedProxies` | Cloudflare on, none of your own | Settings → Security → Trusted proxies |
| `security.autoBlock` | on | Servers → Security → Detection |
| `security.rules` | the table [above](#detection) | Servers → Security → Detection |
| `security.blockMinutes`, `…blockMultiplier`, `…blockMaxDays` | 60, 4, 30 | Servers → Security → Detection |
| `security.maxActiveBlocks` | 10,000 | Servers → Security → Detection |
| `security.enforcement` | on | Servers → Security → Enforcement |
| `security.historyDays` | 30 | API |
| `scan.enabled`, `scan.signatures` | on, on | Settings → Security → Malware scans |
| `scan.intervalHours`, `scan.onFinding` | 24, report | Settings → Security → Malware scans |
| `scan.memoryMb`, `scan.timeoutMin` | 512, 30 | Settings → Security → Malware scans |
| `scan.quarantineKeepDays` | 0 (until deleted) | Settings → Security → Malware scans |

## Switching it off

Each within a minute, without a redeploy:

| Switch | Takes away |
|---|---|
| Protection level **Off** - the default, or one site | every rule, limit and header, and the in-container settings |
| **Automatic blocking** Off or Observe | new blocks from the detector |
| **Enforcement** off (Servers → Security → Enforcement) | every block, on every server; the list is kept |
| **Scan every site** off | scheduled scans |

On a server itself, `sudo wpl7-firewall off` empties the network layer and keeps it empty until
`sudo wpl7-firewall on`, whatever the panel sends meanwhile.

## What an update does

The update that brings Security recreates Traefik once per server (a gap of under a minute) and
every site container once, one **Recreate container** job per site - for the in-container files'
mounts. A site busy with another job is rebuilt within the hour instead. Its certificates are
unchanged. Standard protection and automatic blocking are then on, and scans start on their
schedule.

## Known limits

- Direct IPv6 visitors are not limited or detected one by one where Docker has no IPv6
  networking: they all arrive as one private address.
- Rate limits count from zero again whenever a server's rules change.
- Traefik forgets a visitor who pauses: it drops an idle visitor's count after 1 + 1/rate
  seconds (2 seconds for a limit of one a second or more, 4 for 20 a minute), and the next
  request starts a full burst ([traefik#13957](https://github.com/traefik/traefik/issues/13957),
  open). Measured on Traefik 3.7.13: with logins at 20 a minute in bursts of 30, a visitor who
  paused five seconds got 30 more. So logins and XML-RPC come in bursts of 2 - a pause gains
  a guesser two, and one pausing five seconds at a time got 22 a minute through - while
  requests and assets keep the large bursts real pages need, and a
  client that pauses two seconds between bursts gets five to ten times their rate. A steady
  flood is limited as set. Attack detection still blocks an address after 20 login attempts
  in 10 minutes, however they are spaced.
- A proxy that only sends `X-Forwarded-For` cannot be trusted.
- Request bodies are never inspected; a POST exploit is caught by its path, or not at all.
- Open-source signatures lag. The checks that do not age carry the weight.
- A scan reads files, not the database: malware kept there is not found, and a backdoor that
  writes its file again from the database comes back after the file is quarantined.
- Premium plugins and themes have no published checksums. A backdoor added to one is found
  only if AMWScan knows it, and a signature their own code happens to match is reported as
  known malware until someone ignores it - or, for a plugin whose zip is in the catalog, until
  someone reviews the zip's check.
- A catalog zip is trusted as far as its check and its review go. Malware that was in the zip
  when it was uploaded, and that AMWScan does not know, is vouched for on every site that has
  it - in that version and any later one that kept the file.
- Calls to `eval()`, `exec()` and the like are not findings. A hand-written backdoor that hides
  behind nothing but such a call, in a premium plugin, a theme or `mu-plugins`, is found only if
  a signature or exploit pattern knows its shape. Every sample tried was.
- Detection reacts within about two minutes, not seconds.

## The API

Everything here is in the REST API - **Site protection and malware scans** and **Blocked
addresses** in the Docs tab (panel → Integrations → API keys → Docs), and docs/api.md. A site's
protection, scans and quarantine need **Manage**; the fleet-wide block list and never-block list
need **Full**.
