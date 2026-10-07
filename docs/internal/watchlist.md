# Watchlist

What WPL7 depends on outside this repository and has to keep an eye on: upstream bugs it works
around, versions it pins, services it calls. Each entry says how to check it and what to do when
it changes. CLAUDE.md asks for every entry to be rechecked when it is due:

| Priority | Recheck after | For |
|---|---|---|
| High | 7 days | a security property, or a workaround users notice, depends on it |
| Medium | 30 days | a change would break or weaken something, but it would show |
| Low | 90 days | a change would be cosmetic, or the panel already copes with it |

Rechecking an entry means doing its **Check**, then updating **Last checked** (UTC) and
**Status** here and in the table. If something changed, do the **When it changes** step, or
propose it. Add an entry whenever a change works around something upstream or pins a version
for a reason; remove one once there is nothing left to watch.

| Entry | Priority | Last checked | Status |
|---|---|---|---|
| [Traefik: an idle visitor's rate limit refills](#traefik-an-idle-visitors-rate-limit-refills) | High | 2026-09-30 07:23 UTC | Open upstream; worked around |
| [AMWScan: the pinned image and its signatures](#amwscan-the-pinned-image-and-its-signatures) | High | 2026-10-02 05:12 UTC | Pinned 0.21.12 is the latest |
| [AMWScan: WPL7's tuning of it](#amwscan-wpl7s-tuning-of-it) | Medium | 2026-10-02 05:12 UTC | Both overrides apply to 0.21.12; signatures named |
| [SFTPGo: our build and its overwrite patch](#sftpgo-our-build-and-its-overwrite-patch) | High | 2026-09-30 07:23 UTC | 2.7.6 is the latest; patch still needed |
| [Docker: the firewall backend](#docker-the-firewall-backend) | Medium | 2026-09-30 07:23 UTC | nftables backend still experimental |
| [boky/postfix: how the relay picks its hostname](#bokypostfix-how-the-relay-picks-its-hostname) | Medium | 2026-10-04 18:10 UTC | `latest` is v5.1.0; hostname logic as relied on |
| [wordpress.org's checksum lists](#wordpressorgs-checksum-lists) | Medium | 2026-09-30 07:23 UTC | Both answer as expected |
| [Search engines' crawler host names](#search-engines-crawler-host-names) | Medium | 2026-09-30 09:51 UTC | All six as listed |
| [AI assistants' address lists](#ai-assistants-address-lists) | Medium | 2026-09-30 10:46 UTC | All 12 lists pass the checks |
| [Traefik: the Cloudflare token from a file](#traefik-the-cloudflare-token-from-a-file) | Medium | 2026-10-04 18:36 UTC | lego v5.4.1 reads the file; Traefik keeps the client |
| [Cloudflare: API tokens as the panel takes them](#cloudflare-api-tokens-as-the-panel-takes-them) | Medium | 2026-10-04 18:36 UTC | Formats and permissions as validated |
| [Cloudflare's and Jetpack's address lists](#cloudflares-and-jetpacks-address-lists) | Low | 2026-09-30 07:23 UTC | All three answer |
| [Ubuntu's `nftables.service`](#ubuntus-nftablesservice) | Low | 2026-09-29 | Disabled by default on 26.04 |
| [The docs site's toolchain and its screenshot image](#the-docs-sites-toolchain-and-its-screenshot-image) | Low | 2026-10-07 07:33 UTC | Astro 7.3.6 is out, a patch over the pinned 7.3.5; Starlight, Playwright and oxipng are the latest; the `braces` and `postcss-selector-parser` advisories have no fix the site can take |
| [The demo world's WordPress and plugin versions](#the-demo-worlds-wordpress-and-plugin-versions) | Medium | 2026-10-06 06:19 UTC | WordPress 7.1.2 and the newest plugins of the demo's date; Contact Form 7 6.2 left out |
| [The site image's Apache modules for the docs' cache times](#the-site-images-apache-modules-for-the-docs-cache-times) | Low | 2026-10-07 06:49 UTC | `expires` on, `headers` off; the docs use `expires` |
| [concurrently's pinned shell-quote](#concurrentlys-pinned-shell-quote) | Low | 2026-10-07 07:33 UTC | concurrently 10.0.5 pins 1.9.0; overridden to `^1.11.0` |

## Traefik: an idle visitor's rate limit refills

- **Priority:** High
- **Last checked:** 2026-09-30 07:23 UTC. [traefik#13957](https://github.com/traefik/traefik/issues/13957)
  is open; the Traefik team said on 2026-09-28 they would reproduce it. The latest release is
  v3.7.13 (2026-09-04), which is what `traefik:v3.7` in `deploy/docker-compose.yml` runs.
- **The problem:** Traefik drops a visitor's rate-limit bucket after `1 + 1/rate` seconds without
  a request - 2 seconds for limits of one a second or more, 4 for 20 a minute - and starts the
  next request on a full burst. With logins at 20 a minute in bursts of 30, a guesser who paused
  five seconds got 30 more every time.
- **What we do about it:** logins (Standard 20 a minute, Strict 6) and XML-RPC (30 a minute)
  come in bursts of 2, so a pause gains two (`LEVEL_PRESETS` in `panel/shared/security.ts`).
  Requests and assets keep their large bursts; `docs/security.md` lists that as a known limit.
- **Check:** `gh issue view 13957 -R traefik/traefik --comments`, and the release notes of every
  Traefik release since the last check for rate-limit changes. `traefik:v3.7` follows 3.7.x
  releases: `setup.sh` pulls it (`compose pull`) whenever it runs, as on an update.
- **When it changes:** once a release we deploy has the fix, measure it. Use a file-provider
  router with `rateLimit` average 20, period 1m, burst 30. Send 40 requests, wait five seconds,
  send 40 more: fixed, the second round gets one or two through, not 30. Then offer the user the
  plan's bursts back (logins 30 Standard and 10 Strict, XML-RPC 30). Update the `LEVEL_PRESETS`
  comment, the level table and the known limit in `docs/security.md`.

## AMWScan: the pinned image and its signatures

- **Priority:** High
- **Last checked:** 2026-10-02 05:12 UTC. We pin 0.21.12, whose definitions are 2026.09.08.1;
  v0.21.12 (2026-09-26) is still the latest release.
- **The problem:** the scanner image is pinned by digest (`SCANNER_IMAGE` in
  `panel/src/services/scanEngines.ts`) and runs with `--disable-definitions-update`. Its
  signatures are the ones bundled in that image, and they age until the pin moves. Upstream
  releases often: it is 0.x, with one main maintainer.
- **Check:** `gh release list -R marcocesarato/PHP-Antimalware-Scanner --limit 5`. The `v0.x`
  tags are the scanner; the `wordpress-v…` tags are a separate plugin.
- **When it changes:** move `SCANNER_IMAGE` and `SCANNER_VERSION` to the new version's digest.
  Moving `SCANNER_VERSION` makes every plugin-catalog zip get checked again. Read the changelog
  for changed flags or report fields, which the reducer in `panel/src/services/scanScripts.ts`
  reads.
  Run the scan tests and `WPL7_ENGINE_TESTS=1 npx vitest run test/engine` against the new
  image, and do what [WPL7's tuning of it](#amwscan-wpl7s-tuning-of-it) says. Then a real scan of a
  site with a webshell planted in uploads: it must be found, and a wordpress.org plugin must not
  be reported. Update the version in `docs/security.md` and in the README's third-party section.

## AMWScan: WPL7's tuning of it

- **Priority:** Medium
- **Last checked:** 2026-10-02 05:12 UTC. On the pinned 0.21.12 both exploit overrides apply
  (AMWScan's patterns are exactly the ones replaced), `@preg_replace` is signature 22c684e7,
  and every signature finding of the engine test is read back to its own id.
- **The problem:** `panel/src/services/scanTuning.ts` works around AMWScan in four ways
  (docs/security.md, "What the scanner is not asked to say"): two exploit patterns that reach
  too far (`str_replace_eval`, `execution2`) are replaced through its local-rules folder; the
  raw signature `@preg_replace` is dropped by its id; presence findings (`function:`,
  `process:` at the warning level) and oversized-script notes are not findings; and signature
  findings are renamed after the signature, read back from the named group AMWScan puts after
  each signature in its merged regexes (`Signatures::getAll()`, loaded from the phar by the
  reducer). Each steps aside when AMWScan changes under it - an override whose pattern changed
  is skipped, a signature that cannot be read back keeps AMWScan's name - so a change means more
  findings, never fewer. The renaming relies on AMWScan internals that are no API.
- **Check:** `WPL7_ENGINE_TESTS=1 npx vitest run test/engine` (Docker, the pinned image pulled).
  For the latest release, read its `exploits.json` (`resources/definitions/definitions.amwdb`
  in the phar, a gzipped tar) for the two patterns, and its signatures for `@preg_replace`.
- **When it changes:**
  - **Upstream fixed a pattern itself:** drop the override, and bump `TUNING_VERSION`.
  - **Upstream changed it otherwise:** write the override against the new pattern (the
    positive and ordinary cases in `test/unit/scanTuning.test.ts` must still hold), and bump
    `TUNING_VERSION`.
  - **The engine test says signatures are not named:** adapt the reducer's lookup in
    `scanScripts.ts` to how the new version names them. Until then findings keep AMWScan's
    names, and a scanner bump reopens ignored ones once.

## SFTPGo: our build and its overwrite patch

- **Priority:** High
- **Last checked:** 2026-09-30 07:23 UTC. We build v2.7.6 (commit 62ae9ba3) with
  `deploy/sftpgo-image/staged-overwrite.patch`; v2.7.6 (2026-09-19) is the latest release, and
  the three advisories published that day (one high: stored XSS through directory names in the
  WebClient) are patched in 2.7.6.
- **The problem:** SFTPGo is on the internet (FTP and SFTP). Upstream's `upload_mode: 1` renames
  an existing file to a temporary name before an overwrite, so the file is missing for the whole
  transfer - WordPress without its `wp-config.php` shows the installer - and is deleted if the
  upload fails. This affects SFTP, SCP and FTPS, and no setting avoids it. Our patch stages the
  overwrite in a new temporary file instead.
- **Check:** `gh release list -R drakkan/sftpgo --limit 5` and
  `gh api repos/drakkan/sftpgo/security-advisories`. Also look in upstream's changelog for any
  change to how an upload replaces an existing file.
- **When it changes:**
  - **A new release, above all a security one:** move `SFTPGO_VERSION`/`SFTPGO_COMMIT` in
    `deploy/sftpgo-image/Dockerfile` and `deploy/sftpgo-image/VERSION`, and rebase the patch.
  - Build the image and check that an overwrite over SFTP keeps the old file until the new one is
    complete. Then publish it (the `sftpgo` job in `build-images.yml`).
  - **Upstream fixes the overwrite itself:** drop the patch.

## Docker: the firewall backend

- **Priority:** Medium
- **Last checked:** 2026-09-30 07:23 UTC. Docker Engine 29.8.1 (2026-09-15) is the latest. Its
  [nftables backend](https://docs.docker.com/engine/network/firewall-nftables/) is still marked
  experimental, so the default is iptables (iptables-nft on Ubuntu).
- **The problem:** blocked addresses are dropped by a table of our own, `inet wpl7`, hooked at
  `prerouting` priority -310, before Docker forwards the published ports (docs/security.md).
  This was tested on 2026-09-29 only with the iptables backend. That run used an Ubuntu 26.04
  stand-in with Docker CE 29.8.1 and UFW.
- **Check:** Docker Engine release notes since the last check. Look for a change of the default
  firewall backend, or for the port forwarding moving earlier than priority -310.
- **When it changes:** run the stand-in check again. It needs no VM:
  1. Build an `ubuntu:26.04` image with systemd, UFW, nftables and Docker CE from
     download.docker.com, as `provision/setup.sh` installs it, plus `provision/daemon.json`. It
     boots `/sbin/init` with `STOPSIGNAL SIGRTMIN+3`.
  2. Run it `--privileged --cgroupns=private` with tmpfs on `/run` and `/run/lock`. Put volumes on
     `/var/lib/docker`, `/var/lib/containerd` (Docker 29 keeps images there; overlay on overlay
     fails) and `/srv`.
  3. Run `setup.sh`'s firewall section twice. Start a container that publishes 80 and 443, and
     three client containers on the same network.
  4. Load a file from `renderNft` (`panel/src/services/firewallRender.ts`) with
     `wpl7-firewall apply`. A blocked client must time out on 80 and 443 and still reach 22.
  5. Repeat after `ufw reload`, `systemctl restart docker`, a restart of the whole container (a
     reboot: the boot unit loads the table), and `wpl7-firewall off` / `on`.

## boky/postfix: how the relay picks its hostname

- **Priority:** Medium
- **Last checked:** 2026-10-04 18:10 UTC. `boky/postfix:latest` is v5.1.0 (2026-01-04, digest
  `sha256:aafc7723…`). There and on upstream `master`, `postfix_set_hostname` falls back to
  `$HOSTNAME` when `POSTFIX_myhostname` is unset, and `run.sh` applies every `POSTFIX_*` setting
  after it, on every start. `master` has since replaced OpenDKIM with rspamd (2026-07-23); no
  release has that yet.
- **The problem:** `deploy/docker-compose.yml` runs `boky/postfix:latest`, unpinned, and an update
  pulls whatever release `latest` is then. The panel relies on how the image picks
  `myhostname`: `MAIL_HOSTNAME` reaches it as `HOSTNAME`, a name set in the panel as
  `POSTFIX_myhostname`, applied after it. The image applies the container's creation-time
  environment again on every start, so a restart undoes a hostname changed since. The panel
  puts it back every minute (`convergeHostname` in `panel/src/services/mail.ts`) and reads the
  default with `printenv HOSTNAME` in the container (`RELAY_HOSTNAME_PROBE` in
  `panel/src/services/mailHostname.ts`).
- **Check:** `gh release list -R bokysan/docker-postfix --limit 3`. For a release since the last
  check, read `postfix_set_hostname` and `postfix_custom_commands` at its tag, and the order
  `image_root/scripts/run.sh` calls them in:
  `gh api 'repos/bokysan/docker-postfix/contents/image_root/scripts/functions.sh?ref=<tag>' -H 'Accept: application/vnd.github.raw' | sed -n '/^postfix_set_hostname/,/^}/p'`.
  Read its release notes for the other variables the compose `environment:` sets.
- **When it changes:** if the hostname no longer comes from `HOSTNAME`, or `POSTFIX_*` settings
  stop being applied after it, change the compose `environment:` and `RELAY_HOSTNAME_PROBE` to
  match and run `npx vitest run test/api/mailSetup.test.ts`. Then, on a container of the new
  image: set a name with `postconf -e` and `postfix reload`, `docker restart` it, and see what it
  announces. If the image ever reads a mounted file again at every start, the panel's
  per-minute repair can go.

## wordpress.org's checksum lists

- **Priority:** Medium
- **Last checked:** 2026-09-30 07:23 UTC. Both answered 200 in the shape the panel reads:
  - `https://api.wordpress.org/core/checksums/1.0/?version=7.1.2&locale=en_US` gives an md5 per
    file.
  - `https://downloads.wordpress.org/plugin-checksums/akismet/5.7.2.json` gives an md5 and a
    sha256 per file.
- **The problem:** malware scans hold WordPress and directory plugins to these lists
  (`panel/src/services/integrityManifests.ts`), and neither is a documented, versioned API.
- **Check:** fetch both. In the panel, look for scans that say "wordpress.org's checksums could
  not be fetched".
- **When it changes:** adapt the parsing in `integrityManifests.ts`. Until then scans say
  "incomplete", never "clean".

## Search engines' crawler host names

- **Priority:** Medium
- **Last checked:** 2026-09-30 09:51 UTC. Google's page lists `googlebot.com` for its common
  crawlers and `google.com` for the special-case ones (AdsBot); `googleusercontent.com` is for
  its user-triggered fetchers only. These resolved, and pointed back:
  `crawl-66-249-66-1.googlebot.com`, `msnbot-157-55-39-1.search.msn.com` (from `bingbot.json`),
  `baiduspider-220-181-108-100.crawl.baidu.com`, `petalbot-114-119-132-10.petalsearch.com` and
  `5-255-231-1.spider.yandex.com`. Apple's page names `*.applebot.apple.com`.
- **The problem:** attack detection never blocks a crawler it verified: reverse DNS under the
  engine's domain, confirmed forward (`CRAWLERS` in `panel/src/lib/crawlerVerify.ts`). A domain
  anyone can get a name under is a way past detection. Every Google Cloud machine answers to
  `<ip>.bc.googleusercontent.com`, which is why that domain is not on the list. A crawler that
  moves to a domain not on the list fails the check, and can be blocked like any visitor.
- **Check:** Google's [Verifying Googlebot](https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot)
  table. Then `dig -x` an address of each engine (Bing's are in
  `https://www.bing.com/toolbox/bingbot.json`): the name must be under the listed domain and
  resolve back to the address.
- **When it changes:** update `CRAWLERS`. Never add a domain that cloud customers get names
  under: a Google Cloud name must stay unverified (`panel/test/unit/attackDetector.test.ts`).

## AI assistants' address lists

- **Priority:** Medium
- **Last checked:** 2026-09-30 10:46 UTC. All 12 lists answered and passed the panel's checks
  (1,014 ranges once merged), each named on its company's bot page: OpenAI's four (GPTBot,
  OAI-SearchBot, ChatGPT-User, OAI-AdsBot), Anthropic's one (ClaudeBot, Claude-User,
  Claude-SearchBot), Google's user-triggered fetchers and agents (Gemini Notebook,
  `Google-Agent`), Perplexity's two, Mistral's two and DuckDuckGo's DuckAssistBot. The widest
  ranges are Google's `136.122.0.0/16` and ChatGPT-User's `9.129.0.0/17`, the latter in
  Microsoft's address space.
- **The problem:** attack detection and blocking by hand leave these addresses alone
  (`AI_SOURCES` in `panel/src/services/proxyRanges.ts`; the copies shipped are in
  `panel/src/services/aiRanges.ts`). The panel refreshes the lists weekly and keeps the last
  good copy, but a new bot, or a list moved to a new URL, is missed until someone adds it; that
  bot is then blocked like any visitor when it crosses a rule.
- **Check:** `cd panel && npx tsx scripts/ai-ranges.ts` fetches every list through the panel's
  own checks, fails on one that does not pass, and rewrites the shipped copies. Then read each
  company's bot page for bots or lists not in `RANGE_SOURCES`:
  [OpenAI](https://developers.openai.com/api/docs/bots),
  [Anthropic](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler),
  [Google](https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers),
  [Perplexity](https://docs.perplexity.ai/guides/bots), [Mistral](https://docs.mistral.ai/robots)
  and [DuckDuckGo](https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot).
- **When it changes:** add the list's URL to its company's entry in `RANGE_SOURCES` (a new
  company: a new entry and an `AI_SOURCES` key), run the script again, and commit
  `aiRanges.ts` with it. A list refused for a range wider than `AI_WIDEST` needs a look before
  the limit moves: never blocking a whole /15 is a lot to take on trust.

## Traefik: the Cloudflare token from a file

- **Priority:** Medium
- **Last checked:** 2026-10-04 18:36 UTC. Traefik v3.7.13 (commit fc92cc1), what `traefik:v3.7`
  runs, imports lego v5.4.1. There `GetOrFile` (`platform/env/env.go`) returns `CF_DNS_API_TOKEN`
  when it has a value and only otherwise reads the file `CF_DNS_API_TOKEN_FILE` names, trailing
  newline trimmed; the Cloudflare provider asks for its token through it (`NewDNSProvider`,
  `providers/dns/cloudflare/cloudflare.go`). Traefik builds its ACME client, DNS provider and all,
  once per process: `getClient` in `pkg/provider/acme/provider.go` keeps `p.client`, and calls
  itself only to get or renew a certificate.
- **The problem:** Settings → DNS keeps the Cloudflare token in the panel, and every server's
  Traefik reads it from `${SRV_ROOT}/traefik/dns/cloudflare-api-token` through
  `CF_DNS_API_TOKEN_FILE` (`deploy/docker-compose.yml`). Two upstream behaviours carry that. The
  `_FILE` variable is read only while `CF_DNS_API_TOKEN` is empty, which is why compose must not
  pass that one (`panel/test/unit/composeFlags.test.ts` holds it). And the token is read once, so
  `services/traefikDns.ts` restarts Traefik where a token it may hold was replaced or removed.
- **Check:** the go.mod of the latest v3.7 release (`gh release list -R traefik/traefik --limit 5`,
  then `gh api 'repos/traefik/traefik/contents/go.mod?ref=<tag>' --jq .content | base64 -d | grep lego`),
  that lego version's `GetOrFile` and Cloudflare `NewDNSProvider`, and Traefik's `getClient`.
- **When it changes:**
  - **lego stops reading `_FILE`:** hand the token over another way - a panel-written `env_file`
    for Traefik and a recreate, as `relay.env` is for the mail container - and change
    `traefikDnsMode`.
  - **Traefik reads credentials again per certificate:** drop the restart in
    `TraefikDnsSync.syncServer`, and the downtime it warns of in Settings → DNS and docs/dns.md.

## Cloudflare: API tokens as the panel takes them

- **Priority:** Medium
- **Last checked:** 2026-10-04 18:36 UTC. Cloudflare's
  [token formats](https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/):
  since 2026 a prefix - `cfut_` for a user's token, `cfat_` for an account's - then 40 characters
  and a checksum; older tokens are 40 characters and keep working; `cfk_` is a Global API Key. The
  API reference accepts Zone Read for List Zones (`per_page` 5 to 50) and DNS Read or DNS Write for
  List DNS Records.
- **The problem:** `cloudflareTokenSchema` (`panel/shared/schemas.ts`) refuses what does not look
  like a token: not one word of letters, digits, `-` and `_`, shorter than 30 or longer than 200
  characters, or a `cfk_` key. Settings → DNS asks for **Zone → Zone → Read** and **Zone → DNS →
  Edit**, and `DnsAccount.check` proves the first by listing zones and the DNS half by reading one
  record per dev domain's zone - the read a server's wildcard certificate waits for before it is
  switched on (`DnsAccount.reach`). It does not ask `/user/tokens/verify`, which an account's token
  fails. A valid token refused by the schema is an operator who cannot save one.
- **Check:** the token formats page for a new prefix or character set, and the API reference's
  accepted permissions for [List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)
  and [List DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/).
- **When it changes:** widen `cloudflareTokenSchema`, and follow with `DnsAccount.check`, the hint
  in `web/src/components/settings/DnsTab.tsx`, docs/dns.md and `deploy/.env.example`.

## Cloudflare's and Jetpack's address lists

- **Priority:** Low
- **Last checked:** 2026-09-30 07:23 UTC. All three answered 200:
  `https://www.cloudflare.com/ips-v4` (15 ranges), `https://www.cloudflare.com/ips-v6` (7) and
  `https://jetpack.com/ips-v4.txt` (8).
- **The problem:** trusted proxies and the XML-RPC exemption use these lists.
  `panel/src/services/proxyRanges.ts` refreshes them weekly, sanity-checks them and keeps the
  last good copy. Its built-in copies date from 2026-09-29.
- **Check:** fetch the three URLs.
- **When it changes:** update the URLs or the parsing, and the built-in copies.

## Ubuntu's `nftables.service`

- **Priority:** Low
- **Last checked:** 2026-09-29. Disabled by default in the `ubuntu:26.04` image.
- **The problem:** its default `/etc/nftables.conf` begins with `flush ruleset`. On a server that
  enables it, every start of the service removes `inet wpl7`, along with Docker's rules.
  `setup.sh` warns when it is enabled, and the panel loads the table again within five minutes of
  finding it gone.
- **Check:** `systemctl is-enabled nftables` on each new Ubuntu release and the cloud images
  people install on.
- **When it changes:** if a common image enables it, make `setup.sh` handle it rather than warn.

## The docs site's toolchain and its screenshot image

- **Priority:** Low
- **Last checked:** 2026-10-07 07:33 UTC. `@astrojs/starlight` 0.42.5, `@playwright/test` 1.63.0 and
  oxipng 10.2.1 (2026-09-02) are the latest releases. `astro` 7.3.6 came out on 2026-10-06, a
  patch over the pinned 7.3.5. `npm outdated` also lists newer patch and minor releases of
  `picomatch`, `tinyglobby`, `yaml`, `@types/node` and `@types/picomatch`, and `pixelmatch` 8.
  `npm audit` in `docs/site` reports two advisories. `braces` (stack exhaustion on deeply nested
  patterns) comes through `starlight-llms-txt` → `micromatch`, with no fixed version yet.
  `postcss-selector-parser` (quadratic selector parsing, GHSA-rj75-hqrm-r3gf) is fixed only in
  7.1.6: `postcss-nested` 7 takes it, but `@expressive-code/core` 0.44.2, the latest, requires
  `postcss-nested` 6.
- **The problem:** `docs/site/package.json` pins every package exactly, and the `screenshots` job
  in `.github/workflows/docs.yml` runs in `mcr.microsoft.com/playwright:v1.63.0-noble`, the image
  of the same Playwright version. The pin is what makes two runs give the same screenshots, byte
  for byte; a Playwright in the package that differs from the image fails the job. The job also
  installs oxipng, which Ubuntu does not package, from its GitHub release, pinned by version and
  checksum (`OXIPNG_VERSION`, `OXIPNG_SHA256`). Dependabot does not watch `docs/site`, so nothing
  moves on its own. The `braces` advisory is build-time only and the patterns are the site's own,
  so nothing reachable from outside uses it. The same holds for `postcss-selector-parser`, which
  only parses the site's own CSS at build time.
- **Check:** `npm outdated` in `docs/site`, and `npm audit` there.
  `gh release list -R shssoichiro/oxipng --limit 3` for oxipng.
- **When it changes:** bump Starlight and its plugins together, run `npm run build` and look at a
  page or two. Bump `@playwright/test` and the image tag in the same change; every screenshot
  will differ slightly, so run the workflow with **Retake every screenshot** and review the pull
  request it opens. For oxipng, move `OXIPNG_VERSION` and `OXIPNG_SHA256` together; the checksum
  is the `sha256` digest of the `x86_64-unknown-linux-gnu` tarball in
  `gh release view -R shssoichiro/oxipng --json assets`. Read its changelog for changed flags:
  `shoot.ts` runs it with `-o 4 --strip all`. It is lossless, and the job keeps a file whose
  pixels did not change, so a new oxipng alone changes no committed screenshot. Once
  `micromatch` or `braces` ships a fix, or `@expressive-code/core` moves to `postcss-nested` 7,
  update the lockfile.

## The demo world's WordPress and plugin versions

- **Priority:** Medium
- **Last checked:** 2026-10-06 06:19 UTC. WordPress 7.1.2 (2026-09-22) is the newest release.
  Every plugin and theme the demo sites run is at its newest release of 2026-10-05, the demo's
  date, except where a site runs an older one on purpose. Contact Form 7 6.2 came out on
  2026-10-06 and needs PHP 8.3 and WordPress 7.1, which three demo sites lack, so the demo keeps
  6.1.7. `check-versions.ts` reports only that.
- **The problem:** the docs' screenshots come from the demo world (`panel/scripts/demo/`), and it
  names real versions of WordPress, plugins and themes (`plugins.ts`). Once a newer release is
  out, a screenshot calls an old version up to date. An older version a demo site runs can also
  get an advisory, and then a screenshot calls a vulnerable release safe.
- **What we do about it:** `plugins.ts` holds each version once: `WORDPRESS`, the directory's
  plugins (`WPORG_PLUGINS`, with their "tested up to"), `VENDOR_RELEASES` for the two premium
  plugins and the Breakdance theme, and the two default themes in `LATEST`. A site runs the
  newest release unless it names an older one, which then waits as its update. Older versions
  are ones wpvulnerability.net has no advisory for. The two sites behind on WordPress run the
  newest release of an older branch, which wordpress.org calls outdated, not insecure.
- **Check:** `npx tsx scripts/demo/check-versions.ts` in `panel/`. It lists newer releases on
  wordpress.org, older versions a site runs that are now insecure or have an advisory, and
  newest releases that need a newer PHP or WordPress than a site runs. For the three vendor
  releases it prints where to look; look there by hand.
- **When it changes:** update the versions in `plugins.ts`. If a release is newer than the demo's
  date (`DEMO_NOW` in `clock.ts`), move `DEMO_NOW` past it and the date in the demo's README. A
  release some site cannot run stays out, and Status says why. Run the check again, then
  `npm run shoot -- --out .screens-local --only site-wordpress,site-updates,sites-bulk,plugins-catalog`
  in `docs/site` and look at the shots. The `screenshots` job retakes the committed ones on the
  pull request.

## The site image's Apache modules for the docs' cache times

- **Priority:** Low
- **Last checked:** 2026-10-07 06:49 UTC. The official image's Dockerfile, `latest/php8.3/apache` and
  `latest/php8.5/apache`, runs `a2enmod rewrite expires` and `a2enmod remoteip`. It does not
  enable `headers`, and `deploy/wordpress-image/Dockerfile` enables nothing more.
- **The problem:** the docs' must-use plugin (`docs/site/hosting/wpl7-docs.php`) writes
  `/docs/.htaccess`. Its cache times use `mod_headers` where a server has it, and `mod_expires`
  where it does not, as on a WPL7 site. With neither, pages carry no cache time and browsers
  guess one from a file's age. A page kept past an update then asks for styles and scripts the
  update deleted.
- **Check:** for each PHP version WPL7 builds,
  `gh api repos/docker-library/wordpress/contents/latest/php8.3/apache/Dockerfile --jq .content | base64 -d | grep a2enmod`.
- **When it changes:** `headers` turning up needs nothing: the plugin's `mod_headers` block takes
  over. If `expires` goes, enable it in `deploy/wordpress-image/Dockerfile` with `a2enmod expires`,
  then check that `/docs/` answers with `Cache-Control: max-age=300`.

## concurrently's pinned shell-quote

- **Priority:** Low
- **Last checked:** 2026-10-07 07:33 UTC. concurrently 10.0.5, the latest release, pins
  `shell-quote` to exactly 1.9.0.
- **The problem:** `shell-quote` before 1.11.0 lets `quote()` turn a line break after a
  `{ comment }` token into a second command (GHSA-pqg4-j6r4-53mv, critical). concurrently runs only
  the panel's own development scripts, so nothing untrusted reaches it, but the alert stands
  until the version moves.
- **What we do about it:** `overrides` in `panel/package.json` sets `shell-quote` to `^1.11.0`
  for every package that uses it.
- **Check:** `npm view concurrently@latest dependencies.shell-quote`.
- **When it changes:** once concurrently asks for 1.11.0 or later, delete the `overrides` entry,
  run `npm install` in `panel/` and commit the lockfile.
