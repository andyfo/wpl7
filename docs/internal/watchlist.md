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
| [RDAP: registry endpoints and bootstrap](#rdap-registry-endpoints-and-bootstrap) | Medium | 2026-11-13 13:08 UTC | .co, .io, .me and .us still absent from IANA; all four supplement endpoints publish `expiration`; RFC 8056 and ICANN's profile unchanged |
| [Reminders: PHP and OS support dates](#reminders-php-and-os-support-dates) | Medium | 2026-11-13 13:02 UTC | All dates match; PHP 8.6 not out (GA due 2026-11-19); the interim Ubuntu 26.10 is not in the map |
| [Reminders: Cloudflare token lifetime](#reminders-cloudflare-token-lifetime) | Medium | 2026-11-13 13:15 UTC | Contracts unchanged; neither verify endpoint is documented to take `cfoat_` OAuth tokens, so one would get no date |
| [Traefik: an idle visitor's rate limit refills](#traefik-an-idle-visitors-rate-limit-refills) | High | 2026-11-24 09:18 UTC | Open upstream, fix #13958 awaiting review; not in v3.7.20 or v3.8.0; worked around. New, #14328: requests arriving at once each get a full bucket, past the bursts of 2 |
| [AMWScan: the pinned image and its signatures](#amwscan-the-pinned-image-and-its-signatures) | High | 2026-11-24 10:53 UTC | 0.21.20, the latest, pinned; same definitions; ends 0.21.12's crash on oversized scripts; engine test passes |
| [AMWScan: WPL7's tuning of it](#amwscan-wpl7s-tuning-of-it) | Medium | 2026-11-24 10:53 UTC | On 0.21.20 both overrides apply and `@preg_replace` is still dropped; engine test passes |
| [SFTPGo: our build and its overwrite patch](#sftpgo-our-build-and-its-overwrite-patch) | High | 2026-11-24 09:19 UTC | 2.7.6 is the latest, no new advisory; patch still needed |
| [PHP security releases and the site image's floor](#php-security-releases-and-the-site-images-floor) | High | 2026-11-19 19:51 UTC | 8.2.36, 8.3.37, 8.4.28 and 8.5.13 out today, all security releases: floor raised to them, released in 0.4.1; Docker's bases and the edge images carry them; the refresh workflow has had no scheduled run on `main` yet |
| [phpredis: the pinned 6.3.0](#phpredis-the-pinned-630) | Medium | 2026-11-01 09:08 UTC | 6.3.0 is the latest on PECL and GitHub |
| [Redis in the site image](#redis-in-the-site-image) | Medium | 2026-11-01 09:08 UTC | Debian's 5:8.0.2-3+deb13u3; three open issues on trixie, none reachable here; `LICENSE.txt` still offers AGPLv3 |
| [The Redis Object Cache plugin: its constants and `wp redis`](#the-redis-object-cache-plugin-its-constants-and-wp-redis) | Medium | 2026-11-01 09:08 UTC | 3.0.0 is the latest; all seven constants and `status`, `enable`, `disable` are in its code |
| [The cache plugins' clear hooks](#the-cache-plugins-clear-hooks) | Medium | 2026-11-01 09:08 UTC | Every hook is in the latest releases: WP Rocket 3.24, W3 Total Cache 2.11.0, WP Super Cache 3.1.4, LiteSpeed Cache 7.9.2, Autoptimize 3.1.17, Elementor 4.3.5, WooCommerce 11.2.1 |
| [WP Rocket: its .htaccess rules, which WP-CLI deactivation leaves](#wp-rocket-its-htaccess-rules-which-wp-cli-deactivation-leaves) | Medium | 2026-11-25 10:47 UTC | 3.24.2: the rules come out only under a web server, and not while another domain's config file is left; markers `# BEGIN WP Rocket` and `# END WP Rocket` |
| [The built-in cache rules' cookies and parameters](#the-built-in-cache-rules-cookies-and-parameters) | Medium | 2026-11-01 09:08 UTC | Every name is in the latest code or WP Rocket 3.24's lists; `wp_is_mobile()` tests the same words |
| [Debian's nginx and Apache, as the page cache and PHP sites rely on them](#debians-nginx-and-apache-as-the-page-cache-and-php-sites-rely-on-them) | Low | 2026-11-01 09:08 UTC | nginx 1.26.3-3+deb13u10 and Apache 2.4.69-1~deb13u1 on trixie-security, as tested; engine test not run at this check |
| [PHP-FPM: `[PATH=]` and `[HOST=]` in a `.user.ini`](#php-fpm-path-and-host-in-a-userini) | Low | 2026-11-01 09:08 UTC | No upstream issue found; `php_ini_parser_cb` unchanged in its handling; not re-run at this check |
| [PHP-FPM: `ondemand` and requests arriving together](#php-fpm-ondemand-and-requests-arriving-together) | Low | 2026-11-01 12:13 UTC | On PHP 8.4.27, two 4 s requests at once take 8 s on `ondemand` and 4 s on `dynamic` |
| [PHP-FPM: the status line, and a header with no colon](#php-fpm-the-status-line-and-a-header-with-no-colon) | Low | 2026-11-01 09:08 UTC | `sapi_cgi_send_headers` on master still sends the stored status line first |
| [Download Monitor and Complianz, as the page cache's design relies on them](#download-monitor-and-complianz-as-the-page-caches-design-relies-on-them) | Low | 2026-11-01 09:08 UTC | Download Monitor 5.3.6 and Complianz 7.5.6 as relied on; Cookiebot 4.7.5 reads its cookie in PHP |
| [Cloudflare's request headers](#cloudflares-request-headers) | Low | 2026-11-01 09:08 UTC | Default and visitor location headers are on the list; `CF-Worker`, `CF-Connecting-O2O` and two managed transforms' are not |
| [Docker: the firewall backend](#docker-the-firewall-backend) | Medium | 2026-11-03 08:38 UTC | Docker 29.9.2: nftables backend still experimental, iptables the default |
| [Docker: the build cache and image names, as the nightly clean-up reads them](#docker-the-build-cache-and-image-names-as-the-nightly-clean-up-reads-them) | Medium | 2026-10-27 17:47 UTC | Docker 29.9.2: both prune parameters trim, `all` would remove shared layers first |
| [Docker: a CPU cap stays on a running container](#docker-a-cpu-cap-stays-on-a-running-container) | Low | 2026-10-19 16:22 UTC | Open upstream; worked around by a new container |
| [Docker: a signal counts as stopping a container by hand](#docker-a-signal-counts-as-stopping-a-container-by-hand) | Medium | 2026-11-01 06:30 UTC | Docker 28.1.1: after `docker kill --signal USR1`, a container with `unless-stopped` that exits stays down |
| [Traefik: a router on web beside the HTTPS redirect](#traefik-a-router-on-web-beside-the-https-redirect) | High | 2026-11-24 09:19 UTC | Traefik 3.7.20 and 3.8.0: nothing on entry point redirections, router priorities or the ACME HTTP challenge; engine test not run at this check |
| [Docker: an image's labels on its container](#docker-an-images-labels-on-its-container) | High | 2026-11-24 09:19 UTC | Docker 29.10.0, Traefik 3.7.20 and 3.8.0: nothing on label inheritance, `exposedByDefault` or the default rule; engine test not run at this check |
| [Docker: the names in an image archive](#docker-the-names-in-an-image-archive) | Medium | 2026-11-14 20:51 UTC | Docker 28.1.1 and 27.5.1: the classic store reads `manifest.json`, containerd's `index.json`; renamed in both, only the panel's name lands |
| [Docker: the registry's distribution answer and pulls with a login](#docker-the-registrys-distribution-answer-and-pulls-with-a-login) | Medium | 2026-11-14 20:51 UTC | Docker 28.1.1 and 27.5.1: a digest without a pull, with the login; platforms for a list only on containerd's store |
| [Docker: unprivileged ports from 0](#docker-unprivileged-ports-from-0) | Low | 2026-11-14 20:51 UTC | Docker 28.1.1 sets `ip_unprivileged_port_start=0` in a container's namespace |
| [Traefik's image: busybox wget, tar and unzip](#traefiks-image-busybox-wget-tar-and-unzip) | Medium | 2026-11-14 20:51 UTC | traefik:v3.7 (3.7.19): all three answer as the way in and the mount unpacker use them |
| [Docker: a container whose image a build deleted](#docker-a-container-whose-image-a-build-deleted) | Low | 2026-11-03 09:08 UTC | Docker 29.9.2: a build deletes the image on the containerd store, and keeps it on overlay2; the container still stops, renames and starts |
| [boky/postfix: how the relay picks its hostname](#bokypostfix-how-the-relay-picks-its-hostname) | Medium | 2026-11-08 17:26 UTC | `latest` is v5.2.1; hostname logic as relied on; rspamd idle without keys |
| [wordpress.org's checksum lists](#wordpressorgs-checksum-lists) | Medium | 2026-11-03 08:38 UTC | Both answer as expected for WordPress 7.1.4 and Akismet 5.7.2; no scan failed to fetch them |
| [Search engines' crawler host names](#search-engines-crawler-host-names) | Medium | 2026-11-03 08:44 UTC | All six as listed; 174 of the 384 geo-crawl addresses in Google's list have Google Cloud names |
| [AI assistants' address lists](#ai-assistants-address-lists) | Medium | 2026-11-03 09:24 UTC | All 13 lists pass; Google's and Perplexity's are read from their new URLs |
| [Traefik: the Cloudflare token from a file](#traefik-the-cloudflare-token-from-a-file) | Medium | 2026-11-08 17:27 UTC | lego v5.6.0 reads the file; Traefik keeps the client |
| [Cloudflare: API tokens as the panel takes them](#cloudflare-api-tokens-as-the-panel-takes-them) | Medium | 2026-11-08 17:28 UTC | Formats and permissions as validated; new `cfoat_` (Wrangler OAuth, expiring) not refused |
| [Cloudflare's and Jetpack's address lists](#cloudflares-and-jetpacks-address-lists) | Low | 2026-09-30 07:23 UTC | All three answer |
| [Ubuntu's `nftables.service`](#ubuntus-nftablesservice) | Low | 2026-09-29 | Disabled by default on 26.04 |
| [The docs site's toolchain and its screenshot image](#the-docs-sites-toolchain-and-its-screenshot-image) | Low | 2026-10-07 07:33 UTC | Starlight 0.42.5, Astro 7.3.6, Playwright 1.63.0, oxipng 10.2.1 are the latest; the `braces` and `postcss-selector-parser` advisories have no fix the site can take |
| [The demo world's WordPress and plugin versions](#the-demo-worlds-wordpress-and-plugin-versions) | Medium | 2026-11-08 17:25 UTC | Behind: WordPress 7.1.4 and 12 plugin releases are out; the demo's 7.1.2, 7.0.6 and 6.9.9 are now insecure, and four of its plugin versions have advisories |
| [concurrently's pinned shell-quote](#concurrentlys-pinned-shell-quote) | Low | 2026-10-07 07:33 UTC | concurrently 10.0.5 pins 1.9.0; overridden to `^1.11.0` |
| [The DKIM signer's image: x86-64 only](#the-dkim-signers-image-x86-64-only) | Low | 2026-10-07 11:05 UTC | Every tag is amd64 only |
| [setup-php: PHP 7.0 in CI](#setup-php-php-70-in-ci) | Low | 2026-10-07 15:07 UTC | `v2` is the newest major, 2.37.2 the latest release; 7.0 and 8.5 supported |
| [The migration plugin's floor: WordPress 5.0 and PHP 7.0](#the-migration-plugins-floor-wordpress-50-and-php-70) | Medium | 2026-11-08 17:27 UTC | PHP 7.0 on 0.54% of sites, WordPress before 5.0 on 2.5%; CI installs 7.0; PHP 8.6 due 2026-11-19 |
| [The WordPress image's entrypoint, as an import and `wpl7-start` rely on it](#the-wordpress-images-entrypoint-as-an-import-and-wpl7-start-rely-on-it) | Medium | 2026-11-24 06:45 UTC | Acts on a `php-fpm` first argument; seeds only an empty folder; writes wp-config.php only when absent, from the site folder's `wp-config-docker.php` before its own |
| [WPL7 Connect's floor: WordPress 5.2 and PHP 7.0](#wpl7-connects-floor-wordpress-52-and-php-70) | Medium | 2026-11-08 17:27 UTC | PHP 7.0 on 0.54% of sites, WordPress before 5.2 on 3.0%; CI installs 7.0; Docker test not run at this check |
| [WordPress's upgrader, as WPL7 Connect drives it](#wordpresss-upgrader-as-wpl7-connect-drives-it) | Medium | 2026-11-08 17:30 UTC | 7.1.4 is the latest; it unpacks into a randomly named folder, which WPL7 Connect does not use; Docker test not run at this check |
| [WordPress's shutdown, as WPL7 Connect answers an activation that ended PHP](#wordpresss-shutdown-as-wpl7-connect-answers-an-activation-that-ended-php) | Medium | 2026-11-20 09:48 UTC | WordPress 7.1.4 and 7.1.5: output is flushed at `shutdown` priority 1, and the fatal error handler stays out of an activation; the Docker test passes |
| [WP-CLI: a plugin's status after a failed install or activation](#wp-cli-a-plugins-status-after-a-failed-install-or-activation) | Low | 2026-11-20 09:58 UTC | WP-CLI 2.12.0: `--skip-plugins` lets go of `active_plugins` at `plugins_loaded`, so the listing has each plugin's real status; an activation that fails during `install --activate` is only a warning |
| [WordPress 7.2: sudo mode and Application Passwords](#wordpress-72-sudo-mode-and-application-passwords) | Medium | 2026-11-08 17:30 UTC | Beta 4 is out: no sudo mode; Application Passwords only gain an email on creation; beta tests not run at this check |
| [WP Godmode's `godmode` command on WPL7 Connect](#wp-godmodes-godmode-command-on-wpl7-connect) | Medium | 2026-11-08 17:31 UTC | Not released: 1.3.2, the latest, registers no command with WPL7 Connect |
| [WordPress's answer to a fatal error](#wordpresss-answer-to-a-fatal-error) | Low | 2026-10-09 15:55 UTC | 500, as relied on |
| [WordPress's default From address](#wordpresss-default-from-address) | Medium | 2026-11-13 13:00 UTC | `wordpress@` and the home URL's host without `www.`, on 7.1.4, trunk and 7.2 Beta 5 |
| [msmtp: one envelope sender, as `wpl7-sendmail` relies on it](#msmtp-one-envelope-sender-as-wpl7-sendmail-relies-on-it) | Low | 2026-11-11 23:04 UTC | msmtp 1.8.28 in the image, 1.8.34 upstream; nothing since changes the four behaviours; the engine mail tests pass |
| [sodium_compat for PHP 7.0 in CI](#sodium_compat-for-php-70-in-ci) | Low | 2026-10-09 15:55 UTC | 1.24.2 is the newest 1.x and takes PHP 7; 2.x needs 8.1 |
| [GNU tar: its words for a file that changes while it is read](#gnu-tar-its-words-for-a-file-that-changes-while-it-is-read) | Low | 2026-11-25 10:47 UTC | 1.35 on Ubuntu 24.04 and 26.04: exit 1 and three messages for a file changed, removed or shorter while read; exit 2 for one it cannot read |
| [The MariaDB image's bash and client, as the database browser and imports rely on them](#the-mariadb-images-bash-and-client-as-the-database-browser-and-imports-rely-on-them) | Medium | 2026-11-19 08:16 UTC | `mariadb:11.4` (11.4.13 on Ubuntu 24.04, rebuilt 2026-11-11) has bash 5.2 with `/dev/tcp`, and its client refuses a dump's commands; the engine test passes |
| [Adminer: the pinned build and its advisories](#adminer-the-pinned-build-and-its-advisories) | High | 2026-11-24 10:07 UTC | 6.3.1, the latest, pinned as `6.3.1-wpl7.1` on PHP 8.4.28; the panel takes its 303 sign-in; engine test passes |
| [wordpress.org's directory, as the panel's closed flag reads it](#wordpressorgs-directory-as-the-panels-closed-flag-reads-it) | Medium | 2026-11-19 11:43 UTC | The feed still calls `bbpress` and `bbpress-private-replies` closed and misses `captcha`; the directory answers as `wporgListing` reads them |
| [Google's crawler address lists](#googles-crawler-address-lists) | Medium | 2026-11-03 09:35 UTC | Both answer: 589 prefixes, none wider than a /27 or a /64 |
| [ssh2: how a channel closes, as the panel's SSH channels rely on it](#ssh2-how-a-channel-closes-as-the-panels-ssh-channels-rely-on-it) | Low | 2026-11-15 10:57 UTC | 1.17.0 is the latest; channels half-open by default, `destroy()` never marks one destroyed, `'close'` waits for `'end'` or an unreadable stream |
| [ssh2: ed25519 keys from its own generator](#ssh2-ed25519-keys-from-its-own-generator) | Low | 2026-11-24 14:29 UTC | Open upstream since 2024, fix #1515 waiting for review; 1.17.0 cuts 1 key in 256 short; the panel does not use it |
| [Duplicator's package format, as New site reads it](#duplicators-package-format-as-new-site-reads-it) | Medium | 2026-11-25 10:03 UTC | Lite 5.2.0 is the latest; the plugin's own records as its installer leaves them, the same from 5.0.0 to 5.2.0 and in 1.5.17; on real WordPress, the first login after a 5.2.0 and a 1.5.11 package ends on Duplicator's own message |
| [MariaDB: MySQL 8's collations](#mariadb-mysql-8s-collations) | Medium | 2026-11-24 08:46 UTC | 11.4.13 has MySQL 8.0's 44 `0900` collations, with the weights of the `uca1400` `nopad` ones they are mapped to; 11.4.4 has only the latter |
| [WordPress's incompatible SQL modes, as a package's triggers run in them](#wordpresss-incompatible-sql-modes-as-a-packages-triggers-run-in-them) | Low | 2026-11-24 10:31 UTC | 7.1.5 takes out six modes; trunk adds `NO_BACKSLASH_ESCAPES`, which the panel takes out already |
| [MariaDB's keywords and functions, as a trigger's words are read](#mariadbs-keywords-and-functions-as-a-triggers-words-are-read) | Low | 2026-11-24 11:54 UTC | 11.4.13: 699 keywords, 268 functions, as `panel/src/lib/mariadbWords.ts` has them; spatial functions are not among them |
| [MCP: no way to hand a tool a file](#mcp-no-way-to-hand-a-tool-a-file) | Low | 2026-11-25 18:17 UTC | `io.modelcontextprotocol/files` is a draft extension, last changed 2026-11-09, with no reference implementation and no app known to support it |
| [CI: the Web FTP scripts' tests, on the site image's Debian](#ci-the-web-ftp-scripts-tests-on-the-site-images-debian) | Low | 2026-11-26 09:05 UTC | WordPress's fpm image and `node:22-trixie` are both Debian 13.8 with GNU coreutils 9.7; `ubuntu-latest` is Ubuntu 26.04, whose `head` is uutils 0.10.0 |

## Traefik: an idle visitor's rate limit refills

- **Priority:** High
- **Last checked:** 2026-11-24 09:18 UTC. [traefik#13957](https://github.com/traefik/traefik/issues/13957)
  is open, with nothing from the Traefik team since 2026-09-28. Its fix,
  [traefik#13958](https://github.com/traefik/traefik/pull/13958) (against `v3.7`, milestone 3.7),
  still waits for review. Two users have commented since the last check. One (2026-11-19) measured
  a residual on top of it: the in-memory map keeps expiries in whole seconds, so a bucket can still
  go up to a second early, and suggested a one-line follow-up. v3.7.20, v3.8.0 and v2.11.64 came
  out on 2026-11-23, none with a rate-limiter item in its notes. `traefik:v3.7` moved to 3.7.20 that
  evening and does not follow 3.8 (`v3.8` and `latest` do). Nothing under
  `pkg/middlewares/ratelimiter` has changed on `v3.7`, `v3.8` or `master` since 2026-09-24.
  3.7.20 fixes three advisories, published on 2026-11-24: memory exhaustion through the Compress
  middleware's Brotli writer
  ([GHSA-3rh5-223h-cpwr](https://github.com/traefik/traefik/security/advisories/GHSA-3rh5-223h-cpwr),
  high), provider credentials in debug logs and support dumps (GHSA-42x2-976f-ph52), and hosts with
  a trailing dot evading TLS-option conflict detection (GHSA-9657-c2gv-wjpj). None reaches WPL7,
  which sets up no Compress middleware, no HTTP provider, no Docker provider password and no
  client-certificate TLS options, and logs at INFO. A server gets them when it next pulls
  `traefik:v3.7`. New and related:
  [traefik#14328](https://github.com/traefik/traefik/issues/14328) (2026-11-19, labelled confirmed):
  in the in-memory backend, requests that arrive at once from a source without a bucket each make a
  full one, so more than `burst` get through, and again each time an idle bucket has expired
  (#13957). Its test let up to 16 of 16 simultaneous first requests through at a burst of 5. The
  bursts of 2 do not cover a guesser who sends requests in parallel after each pause; not measured
  here. Its fix, [traefik#14329](https://github.com/traefik/traefik/pull/14329) (against `v3.7`, no
  milestone), waits for review.
- **The problem:** Traefik drops a visitor's rate-limit bucket after `1 + 1/rate` seconds without
  a request - 2 seconds for limits of one a second or more, 4 for 20 a minute - and starts the
  next request on a full burst. With logins at 20 a minute in bursts of 30, a guesser who paused
  five seconds got 30 more every time. Requests that arrive at once from a visitor with no bucket
  each get a full one ([traefik#14328](https://github.com/traefik/traefik/issues/14328)), so
  requests sent in parallel get past the burst too. Attack detection, on by default, still blocks an
  address that keeps at it.
- **What we do about it:** logins (Standard 20 a minute, Strict 6) and XML-RPC (30 a minute)
  come in bursts of 2, so a pause gains two (`LEVEL_PRESETS` in `panel/shared/security.ts`).
  Requests and assets keep their large bursts; `docs/security.md` lists that as a known limit.
- **Check:** `gh issue view 13957 -R traefik/traefik --comments`, `gh issue view 14328 -R
  traefik/traefik --comments` and its fix, `gh pr view 14329 -R traefik/traefik`, and the release
  notes of every Traefik release since the last check for rate-limit changes. `traefik:v3.7` follows 3.7.x
  releases: `setup.sh` pulls it (`compose pull`) whenever it runs, as on an update.
- **When it changes:** once a release we deploy has the fix, measure it. Use a file-provider
  router with `rateLimit` average 20, period 1m, burst 30. Send 40 requests, wait five seconds,
  send 40 more: fixed, the second round gets one or two through, not 30. For #14328's fix, send 40
  at once from an address with no bucket: fixed, 30 get through, not 40. Then offer the user the
  plan's bursts back (logins 30 Standard and 10 Strict, XML-RPC 30). Update the `LEVEL_PRESETS`
  comment, the level table and the known limit in `docs/security.md`.

## AMWScan: the pinned image and its signatures

- **Priority:** High
- **Last checked:** 2026-11-24 10:53 UTC, moving the pin to 0.21.20, released 2026-11-15 and the
  latest. Its image, `sha256:430618977f11050678535ea591417e157d2c9f70b2fe42f9370ac09afdcd5b22`
  (amd64 and arm64), bundles the same definitions as 0.21.12, 2026.09.08.1. 0.21.12 crashed on an
  oversized script with a signature match in the part Lite mode samples:
  `LITE_SIGNATURE_MATCH_EXCLUSIONS` was undefined, PHP threw, and the whole signature scan ended
  with exit 255 and no message. Three of the thirty scripts over 1 MB in the latest Elementor and
  WooCommerce did it on their own. A real scan skips a plugin folder whose files all match
  wordpress.org's checksums, so the crash could come only from a folder it scans, such as a premium
  plugin's. 0.21.20 defines the constant and scans all thirty. `--lite`, which WPL7 passes, now
  skips four more signatures (`0f53abf5`, `85310fdd`, `8c60fbdb`, `e6300ec0`) and any match that
  contains `ls-la` or a schema.org product snippet. The new `--memory-limit` is not passed. Like
  0.21.12, 0.21.20 sets PHP's memory limit to 1G as it starts, over the `-d memory_limit` WPL7 gives
  it. The engine test passes, 4 of 4. A scan of WordPress 7.1.5 with seven wordpress.org plugins and
  three webshells in uploads, leaving out core, Elementor and WooCommerce as a real scan would,
  gives the same 25 findings on both versions: every webshell, and 12 raw findings in UpdraftPlus,
  Yoast SEO and WPForms Lite that a real scan, which skips those folders, never sees.
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
- **Last checked:** 2026-11-24 10:53 UTC, on 0.21.20. Both overrides apply, `@preg_replace`
  (22c684e7) is still dropped, and every signature finding is read back to its own id: the engine
  test passes, 4 of 4. Its definitions are the same 2026.09.08.1 as 0.21.12's.
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
- **Last checked:** 2026-11-24 09:19 UTC. We build v2.7.6 (commit 62ae9ba3) with
  `deploy/sftpgo-image/staged-overwrite.patch`; v2.7.6 (2026-09-19) is still the latest release,
  and no advisory has been published since the four of that day, which 2.7.6 fixes (one high:
  stored XSS through directory names in the WebClient). The `2.7.x` branch has not moved since
  2026-09-26. `main` got 9 commits, 2026-11-19 to 2026-11-21. One (0f4cece8) removes creating
  symbolic links over every protocol (`symlink_mode` is ignored with a warning) and opens sub-path
  mounts inside their folder; WPL7 never grants `create_symlinks` (`FULL_ACCESS` in
  `panel/src/services/ftpConfig.ts`). The others merge directories in recursive copies, refuse a
  file in a parent path on object storage, add `loaddata-fail-on-error`, and update dependencies.
  None changes how an upload replaces a file: the FTP, SFTP and SCP handlers on `main` still rename
  the existing file to the temporary path first, and `BaseTransfer.Close`
  (`internal/common/transfer.go`) is unchanged since 2026-10-17. The patch's code still applies to
  `main` (360ca011), with offsets; the one test hunk in `internal/sftpd/sftpd_test.go` still does
  not. `main` needs Go 1.27, so the builder image moves with the next release.
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

## PHP security releases and the site image's floor

- **Priority:** High
- **Last checked:** 2026-11-19 19:51 UTC. PHP 8.5.13, 8.4.28, 8.3.37 and 8.2.36 came out today,
  all security releases. GitHub lists 12 to 17 advisories for them, several critical: among them
  CVE-2026-115560, the session upload progress bug php.net warned of on 2026-10-23, remote code
  execution through session files and the timezone cache, and request smuggling in PHP-FPM. The
  floor is raised to the four, and 0.4.1 ships it. 8.6.0 came out too; `WP_PHP_VERSIONS` does not
  offer 8.6, so it needs no floor yet. The official `php` images and `wordpress:php<X.Y>-fpm`
  carry all four, and so do the newest edge build's images. The published 0.4.0 images do not: the
  refresh workflow has had no scheduled run on `main` in the two hours since it merged, and an
  install on 0.4.0 has no `php-releases` schedule to follow them anyway, so 0.4.1 is what brings
  the new PHP to installs that pull their images. A panel on `main` read today's releases and
  advisories as its fixtures have them, built its 8.4 images on the new base and moved its sites
  onto 8.4.28.
- **The problem:** a site's PHP is whatever its server's `wpl7-wordpress:php<X.Y>` image has, and
  that image is built on `wordpress:php<X.Y>-fpm`. Docker rebuilds that base a few hours after
  each PHP release: on 2026-10-21 the `php` images had the release after about two hours and the
  `wordpress` images after four or five. A site gets the release only once its server's image is
  rebuilt on the new base and the site is recreated on it. A stale base, cached on a server or in
  CI, would ship an old PHP without anyone noticing.
- **What we do about it:**
  - The `php-releases` schedule (`panel/src/services/phpUpdates.ts`) reads php.net every 15
    minutes. It gives each server the newest site image of its install's release, pulled, or
    built on the server when the install builds its own, and the site image sweep
    (`services/siteImages.ts`) recreates the sites on it.
  - `.github/workflows/site-images-refresh.yml` rebuilds the newest release's and edge's published
    site images when Docker's base has a newer PHP, and on Mondays when a package changed, and
    pushes them under the same tags; edge's under its commit's tag, which edge installs follow.
  - `deploy/wordpress-image/Dockerfile` refuses to build on a PHP below the floor of its branch.
    Every build pulls its base (CI's `pull: true`, `--pull` in the provision scripts, `pull` in
    the panel's own builds).
  - Upload progress tracking stays off, as the advisory for CVE-2026-109619 recommends even after
    patching.
- **Check:**
  - The security releases and news on [php.net](https://www.php.net/archive/2026.php), and
    `gh api repos/php/php-src/security-advisories --jq '.[] | [.published_at, .severity, .summary] | @tsv'`,
    since the last check. Then the versions the official images carry:
    `curl -s https://raw.githubusercontent.com/docker-library/php/master/versions.json`.
  - What the panel reads, against its fixtures in `panel/test/phpFixtures.ts`:
    `curl -s https://www.php.net/releases/active.php`,
    `curl -s 'https://www.php.net/pre-release-builds.php?format=json'`, the newest "Upcoming"
    security notice in `https://www.php.net/feed.atom`, and an advisory's `patched_versions`.
  - `gh run list -R andyfo/wpl7 --workflow site-images-refresh.yml --limit 5`: it ran within the
    hour, and its last runs passed. GitHub turns a scheduled workflow off after 60 days without
    activity in the repository.
  - For each offered branch, `scripts/site-image-refresh.sh php wordpress:php<X.Y>-fpm` and
    `scripts/site-image-refresh.sh php ghcr.io/andyfo/wpl7/wordpress:php<X.Y>-<newest release>`
    name the same release, and so do edge's `php<X.Y>-sha-<commit>` images, for the commit the
    `edge` release's manifest names. `php<X.Y>-edge` keeps what its edge build had.
- **When it changes:**
  - **A security release:** within a day, check that the published images carry it (the line
    above) and that the sites of an install on the newest release moved. Raise that branch's
    floor in the Dockerfile in a pull request of its own. An install whose panel predates the
    `php-releases` schedule never pulls a refreshed image: until every install runs a release
    that has it, cut a release too, as before.
  - **A shape the panel reads:** fix `phpUpstream.ts` and the fixtures. Until then the schedule
    fails or the card misses a notice, while servers still follow the published images.
  - **The workflow failing or turned off:** fix it, or run it by hand (**Run workflow**). Until
    then installs that pull their images get no new PHP.
  - **A new PHP branch offered (`WP_PHP_VERSIONS`):** give it a floor too. A branch missing from the
    table is not checked.
  - **An advisory with a configuration mitigation:** weigh putting it in the site image, as the
    upload progress setting is.

## phpredis: the pinned 6.3.0

- **Priority:** Medium
- **Last checked:** 2026-11-01 09:08 UTC. PECL's `latest.txt` and `stable.txt` and GitHub's latest release all say
  6.3.0, from 2025-11-06. It builds and loads on the PHP 8.2, 8.4 and 8.5 the site image was tested on.
- **The problem:** `deploy/wordpress-image/Dockerfile` pins `pecl install redis-6.3.0`, the client the
  object cache plugin talks to Redis with. A release can carry a fix the image needs, and a new PHP
  branch needs a version that builds on it.
- **Check:** `curl -s https://pecl.php.net/rest/r/redis/latest.txt`, and
  `gh release list -R phpredis/phpredis --limit 3` for what changed.
- **When it changes:** move the pin in the Dockerfile, and the version on
  `docs/site/src/content/docs/reference/third-party.mdx`. Build the image for the oldest and newest PHP
  on offer and run `WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteStack.test.ts`: `wp redis status`
  has to say connected.

## Redis in the site image

- **Priority:** Medium
- **Last checked:** 2026-11-01 09:08 UTC. trixie-security has `redis` 5:8.0.2-3+deb13u3, which the image installs.
  Debian's tracker has three issues open on trixie, no DSA for any. CVE-2026-92925 is in the cluster bus,
  and cluster mode is off here. CVE-2026-82677 and CVE-2026-82631 are from valkey's reports, marked minor,
  and Debian's notes say they need a loaded module, and none is loaded here. `LICENSE.txt` on `unstable`
  still offers RSALv2, SSPLv1 or AGPLv3. Redis's own latest is 8.10.3, and forky has 8.0.6.
- **The problem:** the image takes Debian's `redis-server`, with Debian's fixes, and Redis itself no longer
  supports 8.0. That is acceptable because Redis has no port (`port 0`) and a socket only www-data can use,
  so only the site's own PHP reaches it, and a hole in it gives nothing PHP doesn't already have. WPL7 runs
  it unmodified under AGPLv3, one of the three licenses it offers, and says so on
  `docs/site/src/content/docs/reference/third-party.mdx`.
- **Check:** the trixie column of <https://security-tracker.debian.org/tracker/source-package/redis>,
  `curl -s 'https://qa.debian.org/madison.php?package=redis&table=debian&s=trixie,trixie-security&text=on'`,
  and `curl -s https://raw.githubusercontent.com/redis/redis/unstable/LICENSE.txt | head -4`.
- **When it changes:**
  - **An open issue a local socket can reach, with no Debian fix coming:** look at Redis's own apt repo
    (`packages.redis.io`), at the cost of a third-party source and signing key in the image build.
  - **Debian stops backporting, or the image moves to the next Debian release:** the same look, and rerun
    the object cache's part of the engine test.
  - **A release no longer offers AGPLv3:** stay on the last one that does, and tell the user. Valkey is the
    alternative, and needs a look at the Redis Object Cache plugin too.

## The Redis Object Cache plugin: its constants and `wp redis`

- **Priority:** Medium
- **Last checked:** 2026-11-01 09:08 UTC. 3.0.0, from 2026-09-18, is the latest on wordpress.org. Its code reads all seven
  constants, and `includes/cli/class-commands.php` has `status`, `enable` and `disable`. Its drop-in still
  names itself "Redis Object Cache Drop-In".
- **The problem:** the `site.objectCache` job (`panel/src/jobs/handlers/caches.ts`) installs whatever
  wordpress.org has when someone switches the object cache on, then runs `wp redis enable` and looks for
  `Status: Connected` in `wp redis status`. `REDIS_CONSTANTS` in `panel/src/services/wpCachePhp.ts` sets
  `WP_REDIS_SCHEME`, `WP_REDIS_PATH`, `WP_REDIS_CLIENT`, `WP_REDIS_GRACEFUL`, `WP_REDIS_MAXTTL`,
  `WP_REDIS_DISABLE_BANNERS` and `WP_REDIS_DISABLE_COMMENT`. If `WP_REDIS_DISABLE_COMMENT` stopped working,
  its HTML comment would be frozen into stored pages. If `WP_REDIS_GRACEFUL` did, a Redis that is down would
  take the site with it. `cacheDto` in `panel/src/services/sites.ts` tells its drop-in from another plugin's
  by the title.
- **Check:** `curl -s 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=redis-cache' | jq .version`.
  For a new version, grep its zip for the seven names and read `includes/cli/class-commands.php`.
- **When it changes:** adapt the constants and the job, and run
  `WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteStack.test.ts`, which uses the real plugin. Run a
  malware scan over its new drop-in once: 3.0.0 was clean on AMWScan 0.21.12.

## The cache plugins' clear hooks

- **Priority:** Medium
- **Last checked:** 2026-11-01 09:08 UTC. Each is fired in the latest release's own code:
  - WP Rocket 3.24, `inc/functions/files.php`: `after_rocket_clean_domain`, `after_rocket_clean_cache_dir`,
    `after_rocket_clean_minify`.
  - W3 Total Cache 2.11.0, `CacheFlush_Locally.php`: `w3tc_flush_all`, `w3tc_flush_posts`,
    `w3tc_flush_after_minify`.
  - WP Super Cache 3.1.4, `wp-cache-phase2.php`: `wp_cache_cleared`.
  - LiteSpeed Cache 7.9.2, `src/purge.cls.php`: `litespeed_purged_all`, `litespeed_purged_all_lscache`,
    `litespeed_purged_all_cssjs`.
  - Autoptimize 3.1.17, `classes/autoptimizeCache.php`: `autoptimize_action_cachepurged`, from shutdown at
    priority 11.
  - Elementor 4.3.5, `core/files/manager.php`: `elementor/core/files/clear_cache`.
  - WooCommerce 11.2.1, `includes/wc-stock-functions.php` and
    `includes/data-stores/class-wc-product-data-store-cpt.php`: `woocommerce_product_set_stock`,
    `woocommerce_variation_set_stock`, `woocommerce_product_set_stock_status`,
    `woocommerce_variation_set_stock_status`.
- **The problem:** `wp-cache.php` (`WP_CACHE_CODE` in `panel/src/services/wpCachePhp.ts`) clears the page
  cache when one of these fires. A stored page pointing at CSS a plugin just deleted is a broken page. A
  renamed action breaks nothing that shows: pages only stay stale until their keep time. The engine test
  fires them with `do_action`, and only WooCommerce runs for real.
- **Check:** for each plugin, the latest version from
  `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=<slug>`, its zip
  in an empty folder, and a grep for `do_action` with the name. For WP Rocket,
  `gh release list -R wp-media/wp-rocket --limit 3`, then that tag's `inc/functions/files.php`.
- **When it changes:** add the new action to `$changes` in `WP_CACHE_CODE` and keep the old one while
  releases that fire it are in use. Update the versions in its comments and here.


## WP Rocket: its .htaccess rules, which WP-CLI deactivation leaves

- **Priority:** Medium
- **Last checked:** 2026-11-25 10:47 UTC. 3.24.2 is the latest release of `wp-media/wp-rocket`.
  `Deactivation::deactivate_plugin` (`inc/Engine/Deactivation/Deactivation.php`) calls
  `flush_rocket_htaccess( true )` only when no config file of another domain is left in
  `wp-rocket-config`, and `flush_rocket_htaccess` (`inc/functions/htaccess.php`) returns at once
  unless WordPress's `$is_apache`, which `wp-includes/vars.php` sets from `SERVER_SOFTWARE` and
  WP-CLI leaves empty. It takes out the line with `# BEGIN WP Rocket`, the line with
  `# END WP Rocket` and what is between. On a site made from a package that left WP Rocket
  deactivated, the block was still there and the page cache stored no page.
- **The problem:** the panel deactivates plugins with WP-CLI, so WP Rocket's rules stay in
  `.htaccess`. `ExpiresByType text/html "access plus 0 seconds"` among them sends every page with
  `max-age=0`, and the panel's page cache stores none.
- **What we do about it:** after the panel deactivates or deletes WP Rocket (an import or a package
  leaving it deactivated, the WordPress tab, Bulk management), `clearPluginLeftovers` in
  `panel/src/services/pluginLeftovers.ts` takes the block out as WP Rocket does.
- **Check:** `gh api repos/wp-media/wp-rocket/releases/latest --jq .tag_name`. For a newer release,
  read `flush_rocket_htaccess` in `inc/functions/htaccess.php` and `deactivate_plugin` in
  `inc/Engine/Deactivation/Deactivation.php`: the markers, how the block is taken out, and whether
  it still needs `$is_apache`.
- **When it changes:** new markers, or another way of taking the block out: follow them in
  `pluginLeftovers.ts` and its test. If WP Rocket takes its rules out under WP-CLI too, the panel's
  step can go, and so can this entry.
## The built-in cache rules' cookies and parameters

- **Priority:** Medium
- **Last checked:** 2026-11-01 09:08 UTC. Read in the latest code:
  - WooCommerce 11.2.1: `woocommerce_items_in_cart`, `woocommerce_cart_hash`, `wp_woocommerce_session_`,
    the option `woocommerce_default_customer_address` with `geolocation` and `geolocation_ajax`, and the
    `?v=` of `WC_Cache_Helper::geolocation_ajax_redirect`.
  - Easy Digital Downloads 3.7.3: `edd_items_in_cart`.
  - Polylang 3.9.1: `pll_language`.
  - WooCommerce Multilingual 5.6.3: `wcml_client_currency`, `wcml_client_currency_language` and
    `wcml_client_country`, as WP Rocket 3.24 lists them. They are cookies only when something picks its cookie
    store through `wcml_user_store_strategy`, as WP Rocket does. By default it keeps them in WooCommerce's
    session, whose cookie skips the cache.
  - CURCY 2.2.20: `wmc_current_currency`, `wmc_current_currency_old`.
  - WOOCS 1.5.6: `woocs_current_currency`.
  - From WP Rocket 3.24's lists, because the plugins aren't on wordpress.org: Aelia's
    `aelia_cs_selected_currency`, `aelia_customer_country`, `aelia_customer_state`, `aelia_tax_exempt`, the
    Currency Converter Widget's `woocommerce_current_currency`, and WPML's `wp-wpml_current_language`.
  - WordPress 7.1.4: `wp_is_mobile()` tests the hint, then `Mobile`, `Android`, `Silk/`, `Kindle`,
    `BlackBerry`, `Opera Mini` and `Opera Mobi`, which the phones copy repeats.
- **The problem:** `CACHE_RULE_GROUPS` and `HARMLESS_COOKIES` in `panel/shared/cacheRules.ts` are on for
  every site. A visitor with a cookie nothing knows can't store a page, but can get one. So a cart cookie that
  was renamed gives a visitor the page without their cart, and a renamed currency cookie shows them the
  default currency. `plugins` marks a group **In use** by a plugin's folder name.
- **Check:** for each plugin, its latest zip in an empty folder, and a grep for each name. For WP Rocket's
  lists, `inc/3rd-party/plugins/ecommerce/` and `inc/functions/i18n.php` at its latest tag. For the phones,
  `wp_is_mobile` in `wp-includes/vars.php`.
- **When it changes:** add the new name to its group, with its id, and keep the old one while releases that
  use it are around. `runtimeChangedSinceLastApply` brings a release's new rules to every site at the next
  boot, and the page cache clears. Anything new gets the same check, in the plugin's own code.

## Debian's nginx and Apache, as the page cache and PHP sites rely on them

- **Priority:** Low
- **Last checked:** 2026-11-01 09:08 UTC. trixie-security has nginx 1.26.3-3+deb13u10 and apache2 2.4.69-1~deb13u1, the
  versions the engine test last passed on. The test needs Docker, and was not run at this check.
- **The problem:** the page cache and PHP sites lean on behaviour no one promises to keep:
  - nginx: `X-Accel-Expires` outranks `Cache-Control`, and with no `proxy_cache_valid` a response without it
    is not stored. `proxy_ignore_headers Vary` stores regardless of `Vary`. Deleting a cache file counts as a
    purge: a missing one is a miss, with a harmless `[crit] unlink()` in the log. The mark file
    `generation.0000000000` lives through nginx's start-up scan because nginx names a page being written that
    way, with ten digits after a dot.
  - Apache: `CGIPassAuth` hands PHP the Authorization header, `SetEnv ap_trust_cgilike_cl 1` keeps PHP's
    `Content-Length`, and `req_novary()` in `ProxyFCGISetEnvIf` adds no `Vary`, which would stop nginx storing
    every page. The event MPM closes idle connections when its workers are busy, which is why nginx keeps none
    open to it. The Dockerfile removes Debian's `mpm_event.conf` and `deflate.conf`.
  - Apache, for a PHP site: a `DocumentRoot` that does not exist is a warning (AH00112) inside a
    `<VirtualHost *:80>`, and every request answers 404. In the main server it fails the reload and the
    next start. `SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on` reaches PHP-FPM as `$_SERVER['HTTPS']`.
- **Check:** `curl -s 'https://qa.debian.org/madison.php?package=nginx&table=debian&s=trixie,trixie-security&text=on'`,
  the same for `apache2`. For a new version, build the image and run
  `WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteStack.test.ts test/engine/phpSite.test.ts`, which
  pin each of these.
- **When it changes:** the tests name what moved. Fix it in `deploy/wordpress-image/`,
  `panel/src/services/siteStack.ts` or `panel/src/services/siteHardening.ts`. When the image moves to the next Debian release, read nginx's `CHANGES` and
  Apache's `CHANGES_2.4` for these names, and run `panel/scripts/site-load-test.ts` against the old image.

## PHP-FPM: `[PATH=]` and `[HOST=]` in a `.user.ini`

- **Priority:** Low
- **Last checked:** 2026-11-01 09:08 UTC. A search of php-src's issues finds nothing about it. On master,
  `php_parse_user_ini_file` still hands a `.user.ini` to `php_ini_parser_cb`, which still makes a persistent
  array for such a section. The crash was tried on PHP 8.4 when the move to PHP-FPM was built, and needs
  Docker to try again, so it was not re-run at this check.
- **The problem:** PHP-FPM's workers crash on such a section in a `.user.ini`, an empty one too: a 503 for
  every script below it. mod_php never read the file, so one left by another host can hold one.
- **What we do about it:** `clean_user_ini` in `panel/src/services/siteMigration.ts` comments out the section
  and what is under it, at the move to PHP-FPM and whenever files arrive from elsewhere.
- **Check:** `gh api -X GET search/issues -f q='repo:php/php-src ".user.ini" PATH section'`. Then in the site
  image for the newest PHP, write `[PATH=/x]` to a `.user.ini` beside a PHP file, and ask for it through PHP-FPM.
- **When it changes:** once every branch on offer survives such a section, change the reason `clean_user_ini`
  gives. What is under one was meant for another path or host, so it still goes.

## PHP-FPM: `ondemand` and requests arriving together

- **Priority:** Low
- **Last checked:** 2026-11-01 12:13 UTC. On PHP 8.4.27, from an idle pool, two 4 s requests sent together took 8.1 s on
  `pm = ondemand`, six times out of six, and 4.2 s on `pm = dynamic`. Twelve 20 s requests got 5 workers on
  `ondemand` however long they waited, and 10 within 8 s on `dynamic`.
- **The problem:** `ondemand` starts a worker when a request arrives and none is idle. Requests that arrive
  together count as one arrival, so the second waits for the first to end, however long that takes, unless a
  third comes along. mod_php never did that.
- **What we do about it:** `deploy/wordpress-image/php-fpm.conf` uses `dynamic`, with one worker kept ready. That
  costs a site about 10 MB, and from idle a burst has to wait for the pool to grow: 10 home pages at once took
  about 2 s there, against 1 s on the old image.
- **Check:** `fpm_pctl_on_socket_accept` in `sapi/fpm/fpm/fpm_process_ctl.c` in php-src. Then two slow requests
  together on an idle pool with `pm = ondemand`.
- **When it changes:** if requests arriving together each get a worker, `ondemand` is worth going back to: an
  idle site would again hold no workers.

## PHP-FPM: the status line, and a header with no colon

- **Priority:** Low
- **Last checked:** 2026-11-01 09:08 UTC. `sapi_cgi_send_headers` in `sapi/fpm/fpm/fpm_main.c` on master still sends
  `SG(sapi_headers).http_status_line` when a status line is set, before it looks at the response code.
- **The problem:** PHP-FPM sends the status line a page set first, and mod_php the code it set last. WordPress
  calls `status_header(200)` on every page it finds, so `http_response_code(403)` from a theme or a plugin went
  out as a 200. Apache also answers a 500 to a header line with no colon, which mod_php passed over.
- **What we do about it:** `FIX_HEADERS` in `panel/src/services/wpCachePhp.ts` registers a
  `header_register_callback` that corrects both on WordPress's pages. A plain script keeps them, and a plugin
  registering its own callback replaces this one. `docs/site/src/content/docs/sites/settings.mdx` says so under
  Limits.
- **Check:** read `sapi_cgi_send_headers` on master, and PHP's `NEWS` since the last check for FPM and `Status`.
- **When it changes:** when every branch on offer sends the last code, `FIX_HEADERS` can drop the status half
  and the limit can go.

## Download Monitor and Complianz, as the page cache's design relies on them

- **Priority:** Low
- **Last checked:** 2026-11-01 09:08 UTC. Download Monitor 5.3.6 answers from `parse_request` at priority 0
  (`src/DownloadHandler.php`), reads `HTTP_REFERER` for its hotlink check, `HTTP_DLM_XHR_REQUEST` and
  `HTTP_RANGE`. Complianz 7.5.6 reads consent cookies in PHP (`cmplz_has_consent` in `functions.php`), and its
  `websitescan/class-wsc-scanner.php` stops when `SERVER_ADDR` is `127.0.0.1`. Cookiebot 4.7.5 reads
  `CookieConsent` in `src/lib/Cookie_Consent.php`.
- **The problem:** three choices rest on these. nginx holds the `Referer` back on the path that may store a page,
  and `wp-cache.php` hands it to what runs before `template_redirect`, where Download Monitor's check is. A
  `Range` skips the cache, because its addresses have no file extension. Consent cookies are not in
  `HARMLESS_COOKIES`, because a page drawn for someone who agreed would reach someone who refused. Apache hands PHP
  the address nginx was reached on, because of that `SERVER_ADDR` test.
- **Check:** each plugin's latest zip in an empty folder, and a grep for those names.
- **When it changes:**
  - **Download Monitor reads the Referer later:** give it back later in `wpl7_cache_start`, or say on
    `docs/site/src/content/docs/sites/caching.mdx` that its hotlink check needs a skip rule.
  - **Complianz and Cookiebot stop drawing by consent in PHP:** the cookies could go back on the harmless list,
    which would let more visitors store pages. That is an offer to the user, not a duty.

## Cloudflare's request headers

- **Priority:** Low
- **Last checked:** 2026-11-01 09:08 UTC. Cloudflare's [header list](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
  and [managed transforms](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/).
  `CLOUDFLARE_HEADERS` has what it adds by default, and the visitor location transform's. Not on it:
  `CF-Worker` on a Worker's subrequests, `CF-Connecting-O2O` for SSL for SaaS, the bot protection transform's
  `cf-bot-score`, `cf-verified-bot`, `cf-ja3-hash` and `cf-ja4`, the TLS client transform's `cf-cert-*`, and
  what the leaked credentials and malicious uploads transforms add.
- **The problem:** PHP refuses to store a page for a request with a header it doesn't know
  (`wpl7_cache_unknown_request_header` in `panel/src/services/wpCachePhp.ts`), and nginx blanks
  `CLOUDFLARE_HEADERS` (`panel/src/services/siteStack.ts`) on the path that may store. So a site behind Cloudflare
  with one of those on stores no page, and its pages say `X-Cache-Skipped: request header <name>`. It is slower,
  and nothing is wrong to see.
- **Check:** both pages above, against `CLOUDFLARE_HEADERS`.
- **When it changes:** add the header to `CLOUDFLARE_HEADERS`, unless PHP should have it, as the country has
  through `X-Wpl7-Country`. Those not on the list today are proposed: Workers and the transforms are a choice a
  site makes, and none has been reported.

## Docker: the firewall backend

- **Priority:** Medium
- **Last checked:** 2026-11-03 08:38 UTC. Docker Engine 29.9.2 (2026-10-20) is the latest, after
  29.8.2, 29.9.0 and 29.9.1. None of their notes changes the default backend or moves port
  forwarding: their networking fixes are for inter-container communication, firewalld zones,
  Swarm and overlay networks. The
  [nftables backend](https://docs.docker.com/engine/network/firewall-nftables/) is still marked
  experimental. `selectFirewallBackend` in moby's `daemon/libnetwork/firewall_linux.go`, at
  v29.9.2 and on `master`, turns it on only when `firewall-backend` is `nftables`, so the default
  is iptables (iptables-nft on Ubuntu).
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

## Docker: the build cache and image names, as the nightly clean-up reads them

- **Priority:** Medium
- **Last checked:** 2026-10-27 17:47 UTC. Measured on Docker Engine 29.9.2, in two throwaway `docker:29-dind`
  daemons, one on each image store (`--storage-driver=overlay2` for the classic one).
- **The problem:** dockerd trims the build cache only when free space falls under 20% of the disk,
  and then only down to 10% of it (`DefaultGCPolicy` in moby's
  `daemon/internal/builder-next/worker/gc.go`). The nightly housekeeping trims it itself instead,
  and removes the images nothing uses (`panel/src/services/dockerCleanup.ts`). Both rest on details
  of the Engine API:
  - `POST /build/prune` takes `reserved-space` since API 1.48 and still reads the deprecated
    `keep-storage` without it. `DockerService.pruneBuildCache` sends both, and not `all`. With
    `all`, BuildKit removes the least recently used records first, image layers included, and
    counts them against the target. Removing a layer an image keeps frees nothing, so the private
    cache stayed. Without `all`, only cache no image shares is removed.
  - On the containerd image store, an image pulled by digest lists `repo@sha256:…` in `RepoTags`
    and is not dangling. On the classic store it has no tags, only `RepoDigests`. The clean-up
    reads both, and removes an image by each of its names: Docker refuses one with two names by id.
  - A rebuild through the API (the classic builder, which the panel uses) leaves the replaced image
    without a name on both stores. A BuildKit rebuild through the CLI leaves none on the containerd
    store.
  - `ImageID` in the container list is the `Id` of `GET /images/json`, and an image a container
    uses, running or stopped, is refused with 409 without `force`.
- **Check:** the Engine API changelog and the release notes since the last check. Look for
  `keep-storage` being removed, a change to how `reserved-space` and `all` select records, and a
  change to the default builder GC policy. Then run the probe again: build three images whose
  first stage writes a few MB that the final stage leaves out, and call `pruneBuildCache` with a
  smaller limit. The private cache must shrink to it, oldest first.
- **When it changes:** if `keep-storage` is gone, drop it from `pruneBuildCache`. If the default
  GC starts trimming early enough on its own, consider dropping the nightly trim. If image listing
  changes, rerun `test/unit/dockerCleanup.test.ts`'s cases against a real daemon before relying on
  `imagesToRemove`.

## Docker: a signal counts as stopping a container by hand

- **Priority:** Medium
- **Last checked:** 2026-11-01 06:30 UTC. On Docker 28.1.1, a site container with `unless-stopped`
  stays `exited` after Apache exits if it was sent `docker kill --signal USR1` before, and comes back
  if the same signal came from `docker exec <c> sh -c 'kill -USR1 1'`. `killWithSignal` in moby's
  `daemon/kill.go` sets `HasBeenManuallyStopped` for any signal, and only a real start clears it.
- **The problem:** a signal meant as "reload" also turns the restart policy off, so a container that
  exits, or a server that reboots, leaves it down. Nothing shows until that happens.
- **What we do about it:** `APACHE_RELOAD_COMMAND` in `panel/src/services/security.ts` signals Apache
  from inside the site's container. `signalContainer` in `panel/src/services/docker.ts` is left for
  the FTP gateway, whose image has no shell, and whose container the FTP reconciler starts again on
  its next tick.
- **Check:** `killWithSignal` in [moby's `daemon/kill.go`](https://github.com/moby/moby/blob/master/daemon/kill.go),
  and the Docker Engine release notes since the last check for `unless-stopped` and restart policies.
- **When it changes:** if a signal no longer sets the flag on a Docker release we install, nothing
  has to change. The reload from inside keeps working, and `signalContainer`'s comment can go.

## Docker: a CPU cap stays on a running container

- **Priority:** Low
- **Last checked:** 2026-10-19 16:22 UTC. [docker/for-linux#558](https://github.com/docker/for-linux/issues/558)
  is open, with nothing since 2019. On Docker 28.1.1, `docker update --cpus 0` on a container
  capped at 2 cores still exits 0 and leaves `NanoCpus` at 2000000000.
- **The problem:** an update with a CPU limit of 0 means "leave it as it is" to Docker, so a cap
  cannot be lifted from an existing container. `CpuQuota: -1` lifts it, but stays in the
  container's config: a cap set later holds only until the next restart (checked on 28.1.1).
- **What we do about it:** `limitsChange` in `panel/src/services/siteSpec.ts` answers `recreate`
  for a site losing its CPU cap. `server.applySiteLimits` then queues a `site.reconcile`, which
  builds a new container, and the site does not answer for a few seconds. That happens when the
  CPU limit in Settings, or a site's own, is set to 0.
- **Check:** `gh issue view 558 -R docker/for-linux --comments`, and the Docker Engine release
  notes since the last check for `docker update` and `NanoCpus`.
- **When it changes:** on a Docker release we install, confirm that an update with `NanoCpus: 0`
  lifts the cap. Then `updateContainerLimits` can send it, `limitsChange` loses `recreate`, and
  the "restarts each site once" sentences go from Settings, the site's Container limits card and
  `docs/site/src/content/docs/sites/settings.mdx`.

## Traefik: a router on web beside the HTTPS redirect

- **Priority:** High
- **Last checked:** 2026-11-24 09:19 UTC. v3.7.20 and v3.8.0 came out on 2026-11-23; `traefik:v3.7`
  is now 3.7.20 and does not follow 3.8. Neither's notes, nor the v3.8.0 migration guide, touch entry
  point redirections, router priorities or the ACME HTTP challenge. 3.7.20 moves lego to v5.7.0 and
  keeps the OCSP staple cache alive. 3.8.0 adds `**.` wildcard hosts, which rank below single
  wildcards and leave the default priority of existing rules unchanged. From v3.7.19 to v3.7.20
  nothing changed in the internal provider that makes the redirect router, nor in the HTTP
  challenge's code. The engine test was not run at this check. At the last one, on Traefik 3.7.19
  with `deploy/docker-compose.yml`'s flags and the redirect at priority 1, a container app's router
  on `web` answered plain http, and every other request on port 80 still redirected: a WordPress and
  a PHP site under the panel's labels and protection files, and a host nobody has. The ACME challenge
  router (`acme-http@internal`, MaxInt) stayed above every app route, and Pebble issued certificates
  over HTTP-01 for the app's host and the sites'. Without the flag, the redirect beats every router
  on `web`.
- **The problem:** a container app may answer plain http (a payment provider's webhook, an old client).
  Traefik's entry point redirect is a router of its own; its default priority is the highest there is,
  so a router on `web` never answers. Set to 1, any router there wins over it.
- **What we do about it:** the flag in `deploy/docker-compose.yml`. Only app http routers and the block
  list's `-web` twin are on `web` (`panel/src/services/appRoutes.ts`, `firewallRender.ts`).
  `plainHttpRefusal` refuses an http route on a server whose running Traefik lacks the flag.
  `test/engine/containerApps.test.ts` item 1 and `composeFlags.test.ts` pin it.
- **Check:** the Traefik release notes since the last check for entry point redirections, router
  priorities and the ACME HTTP challenge. To measure: `WPL7_ENGINE_TESTS=1 npx vitest run
  test/engine/containerApps.test.ts -t "1. plain http"` in `panel/`, with the compose file's Traefik.
- **When it changes:** if the option goes or changes meaning, plain http routes stop answering, or the
  redirect stops for everyone: move the redirect to a router of the panel's own at priority 1 instead.
  If the ACME router can lose to a router on `web`, give app routes a rule that leaves
  `/.well-known/acme-challenge/` out.

## Docker: an image's labels on its container

- **Priority:** High
- **Last checked:** 2026-11-24 09:19 UTC. Docker Engine 29.10.0 (2026-11-16, API 1.57) is the only
  Engine release since the last check; neither its notes nor the API changelog say anything about
  labels. Traefik 3.7.20 and 3.8.0 change nothing in how the Docker provider reads labels:
  `pkg/config/label` and the provider's label parsing are unchanged, `exposedByDefault` still
  defaults to true and the default rule is still `` Host(`{{ normalize .Name }}`) ``. 3.7.20 only
  keeps the provider's password out of logs. The engine test (items 3 and 7) was not run at this
  check. At the last one, on Docker 28.1.1 with Traefik 3.7.19, an image's `traefik.*` and `wpl7.*`
  labels landed on a container made without labels: Traefik routed another site's domain to it at
  once, and `listManaged(['wpl7.role=wordpress'])` counted it as that site's. `traefik.enable=false`
  on the container won over the image's. A container with `traefik.enable=true` and only a service
  label got a default router, `Host(<container name>)` with no TLS, on ports 80 and 443.
- **The problem:** a container app's image is the user's, built elsewhere. Its labels would claim
  domains in Traefik and pass for a site's container in the panel's sweeps.
- **What we do about it:** an image with a `traefik.*` or `wpl7.*` label is refused after its pull or
  load (`labelRefusal` in `panel/src/services/appImages.ts`). The app's container carries
  `traefik.enable=false` and no other Traefik label (`appLabels` in `appSpec.ts`); its routes are a
  file. `test/engine/containerApps.test.ts` items 3 and 7.
- **Check:** the Docker Engine and Traefik release notes since the last check for label inheritance,
  `exposedByDefault` and the Docker provider's default rule. To measure: items 3 and 7 of the engine
  test above.
- **When it changes:** if Traefik stops honouring `traefik.enable=false` over an image's label, the
  container needs `--providers.docker.exposedbydefault=false` on the stack, with every site's router
  opted in. If Docker stops passing labels on, nothing has to change.

## Docker: the names in an image archive

- **Priority:** Medium
- **Last checked:** 2026-11-14 20:51 UTC. `docker save` writes `manifest.json` (`RepoTags`), `index.json`
  (`io.containerd.image.name`) and, on the classic store, `repositories`. A load of an archive that
  carries a name the server has gives the name away. When the places disagree, the classic store goes
  by `manifest.json` and containerd's by `index.json`. Renamed in all three places, only the new name
  lands. The classic store refuses an archive whose entries carry extended attributes. Measured on
  Docker 28.1.1 (containerd) and 27.5.1 (both stores).
- **The problem:** an uploaded archive could plant a name the server uses: a site image, or a name it
  takes later.
- **What we do about it:** `panel/src/services/imageArchive.ts` reads every entry, refuses more than one
  image, and rewrites every name to `wpl7-app-<slug>:u<id>` in all three files before the load, as a
  plain tar. `test/engine/containerImages.test.ts` item 9 and the e2e on both stores.
- **Check:** the Docker Engine release notes for `docker load`, the image stores and the OCI layout. To
  measure: item 9 of the image engine test, and `test/e2e/ssh-transport.sh` with both stores.
- **When it changes:** a new place a load reads a name from has to be rewritten too, in
  `renamedArchive`.

## Docker: the registry's distribution answer and pulls with a login

- **Priority:** Medium
- **Last checked:** 2026-11-14 20:51 UTC. With a login (`registry:2`, bcrypt), the Engine API's
  distribution endpoint gives a tag's digest without a pull, locally and over the SSH agent, on both
  stores. A pull by digest leaves a local tag where it was. Before a pull, the answer lists a list's
  platforms (with `unknown/unknown` attestation entries); for a single image it gives the platform on
  the classic store and nothing on containerd's. A list without the server's platform fails the pull.
  Docker 28.1.1 and 27.5.1.
- **The problem:** app-updates asks the registry every interval instead of pulling, and the platform
  check rests on what the answer says. The PHP releases schedule asks it too, and tells a tag the
  registry does not have (a branch its release does not publish) from a registry it cannot reach or
  that refuses it. On 2026-11-19, Docker 28.1.1 answered the first with 404 `manifest unknown`, and an
  unknown host or a refused repository with 500. dockerode words a 401 `no such image`.
- **What we do about it:** `resolveDigest` and `pullPinned` in `panel/src/services/appImages.ts`. A single
  image's platform is checked after the pull. `test/engine/containerImages.test.ts` items 4 and 6.
  `unpublished` in `panel/src/services/phpUpdates.ts` takes a 404 or `manifest unknown` alone.
- **Check:** the Engine API changelog for `/distribution/{name}/json` and image pulls with
  `X-Registry-Auth`. To measure: items 4 and 6 of the image engine test, and
  `curl --unix-socket /var/run/docker.sock http://localhost/distribution/ghcr.io/andyfo/wpl7/wordpress:php7.4-0.4.0/json`
  for a tag that does not exist.
- **When it changes:** if the answer stops giving a digest, app-updates has to pull to compare. If it
  gives a single image's platform on every store, the check can move before the pull. If a missing
  tag stops answering 404, every branch a release does not publish shows as a server the PHP
  releases schedule could not check: change `unpublished`.

## Docker: unprivileged ports from 0

- **Priority:** Low
- **Last checked:** 2026-11-14 20:51 UTC. Docker 28.1.1 sets `net.ipv4.ip_unprivileged_port_start=0` in
  a container's network namespace: an app running as uid 10001 with every capability dropped listened on
  port 80. Set to 1024, it can't.
- **The problem:** a container app's image may listen on a port below 1024 as a user that is not root.
- **What we do about it:** nothing: there is no switch for it (`test/engine/containerImages.test.ts`
  item 5 measures it).
- **Check:** the Docker Engine release notes for the default sysctls of a container's network
  namespace. To measure: item 5 of the image engine test.
- **When it changes:** set `Sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0' }` in
  `createSiteContainer` for an app.

## Traefik's image: busybox wget, tar and unzip

- **Priority:** Medium
- **Last checked:** 2026-11-14 20:51 UTC. In `traefik:v3.7` (3.7.19), busybox `wget -S` prints each
  answer's status line, a stopped app fails in about 200 ms ("bad address"), and `tar -xzf`, `tar -tzf`,
  `unzip -l` and `unzip -q -o` work as a uid with no capability, no network and a read-only root.
- **The problem:** the way in to a container app (its health check and uptime check) and the mount
  unpacker run in a short-lived container of the image the server's Traefik runs, because every server
  has it.
- **What we do about it:** `askApp` in `panel/src/services/appProbe.ts`, and `mountListScript` and
  `mountUnpackScript` in `panel/src/jobs/handlers/apps.ts`. `test/engine/containerApps.test.ts` items 8
  and 11.
- **Check:** the Traefik image's Dockerfile and its base image since the last check. To measure: items
  8 and 11 of the engine test.
- **When it changes:** if the image loses busybox or one of its applets, use the MariaDB client image,
  which every server has too, or a small image of the panel's own.

## Docker: a container whose image a build deleted

- **Priority:** Low
- **Last checked:** 2026-11-03 09:08 UTC. On Docker 29.9.2 with the containerd image store, `docker build -t <tag>`
  deletes the image the tag named, though a container runs it: `docker image inspect`, `docker tag` and
  `docker create` all answer "No such image" for its id. The container itself still stops, is renamed and
  starts. With the classic overlay2 store the image stays, without a name. Docker Compose treats such a
  container as a normal, lasting state ([docker/compose#14028](https://github.com/docker/compose/pull/14028),
  merged 2026-08-14). `test/engine/siteSwitch.test.ts` passes on both stores.
- **The problem:** a site's way back from a new container can't be its old image. An install that builds
  from source rebuilds its site images that way (`provision/setup.sh`, `deploy.sh`, `build.sh`), which may
  delete it, and then the move to PHP-FPM failed on every site, before it had changed anything.
- **What we do about it:** `replaceContainer` in `panel/src/jobs/handlers/sites.ts` keeps the old
  container aside, stopped, as `<name>.previous`, until the new one is up, and puts it back when that
  fails. `failedSwitchToKeep` keeps a site on its old image only while Docker still has that image.
- **Check:** the Docker Engine release notes since the last check for the containerd image store and for
  builds that replace a tag. To measure, in a throwaway `docker:dind` with each store: build a tag, run a
  container from it, build the tag again with a change, `docker image inspect` the old id, then stop,
  rename and start the container.
- **When it changes:** if a build keeps the old image on the containerd store too, nothing has to change:
  a site whose move failed then stays on its old image there as well. If a container whose image is gone
  can no longer start, the way back breaks, and the scripts that rebuild site images would have to keep
  the old ones by a name first.

## boky/postfix: how the relay picks its hostname

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:26 UTC. `boky/postfix:latest` is v5.2.1 (2026-11-02, digest
  `sha256:0632783c…`), after v5.2.0 (2026-10-29). At both, `postfix_set_hostname` still falls
  back to `$HOSTNAME` when `POSTFIX_myhostname` and `AUTOSET_HOSTNAME` are unset (v5.2.0's fix,
  #265, is to the `AUTOSET_HOSTNAME` branch), and `run.sh` still calls `postfix_setup_dkim` and
  then `postfix_custom_commands` after it, on every start. `postfix_custom_commands` now skips
  the upper-case `POSTFIX_MAIL_…` names Kubernetes injects; none of ours is one. `do_postconf -#`
  now removes a key with `postconf -X`, no longer taking the two lines after it with it (#294).
  v5.2.0 replaces OpenDKIM with rspamd: with no keys in the container it clears `smtpd_milters`
  and `non_smtpd_milters` before the `POSTFIX_*` settings, as OpenDKIM's setup did, and rspamd
  itself never starts. The relay host, sender domain and SASL setup are unchanged, and
  `sasl2-bin` is still installed. The scripts moved from `scripts/` to `image_root/scripts/` in
  v5.2.0, so the Check's path reads releases from v5.2.0 on. The live container test was not
  run at this check.
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
- **Last checked:** 2026-11-03 08:38 UTC. Both answered 200 in the shape the panel reads, for the
  latest WordPress and Akismet:
  - `https://api.wordpress.org/core/checksums/1.0/?version=7.1.4&locale=en_US` gives an md5 for
    each of 3,782 files (3,872 for `de_DE`).
  - `https://downloads.wordpress.org/plugin-checksums/akismet/5.7.2.json` gives an md5 and a
    sha256 for each of 47 files.
  - Nothing published still reads as none: a plugin version with no list answers 404, and a core
    version that does not exist `{"checksums":false}`.
  - In a panel, no scan since the last check says the checksums could not be fetched, and none
    is incomplete.
- **The problem:** malware scans hold WordPress and directory plugins to these lists
  (`panel/src/services/integrityManifests.ts`), and neither is a documented, versioned API.
- **Check:** fetch both. In the panel, look for scans that say "wordpress.org's checksums could
  not be fetched".
- **When it changes:** adapt the parsing in `integrityManifests.ts`. Until then scans say
  "incomplete", never "clean".

## Search engines' crawler host names

- **Priority:** Medium
- **Last checked:** 2026-11-03 08:44 UTC. Google's page has moved to
  [Verify Google requests](https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests),
  and the old address redirects there; it was last updated 2026-03-20. It lists `googlebot.com`
  for its common crawlers (`crawl-…`, and `geo-crawl-….geo.googlebot.com`) and `google.com` for
  the special-case ones (AdsBot); `googleusercontent.com`, and `google-proxy-….google.com`, are
  for its user-triggered fetchers. These resolved, and pointed back:
  `crawl-66-249-66-1.googlebot.com` (and an IPv6 one), `geo-crawl-34-101-50-145.geo.googlebot.com`,
  `rate-limited-proxy-66-249-90-77.google.com`, `msnbot-157-55-39-1.search.msn.com` (from
  `bingbot.json`), `17-241-208-161.applebot.apple.com` (from Apple's `applebot.json`),
  `5-255-231-1.spider.yandex.com`, `baiduspider-220-181-108-100.crawl.baidu.com` and
  `petalbot-114-119-132-10.petalsearch.com`. Not every address in Google's `common-crawlers.json`
  has a Googlebot name: of the 384 in its 23 geo-crawl prefixes, 174 answer to
  `<ip>.bc.googleusercontent.com`, among them all of `34.22.85.0/27` and the page's own example,
  `35.247.243.240`. A Googlebot crawl from one of those is not verified here.
- **The problem:** attack detection never blocks a crawler it verified: reverse DNS under the
  engine's domain, confirmed forward (`CRAWLERS` in `panel/src/lib/crawlerVerify.ts`). A domain
  anyone can get a name under is a way past detection. Every Google Cloud machine answers to
  `<ip>.bc.googleusercontent.com`, which is why that domain is not on the list. A crawler that
  moves to a domain not on the list fails the check, and can be blocked like any visitor.
- **Check:** Google's [Verify Google requests](https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests)
  table. Then `dig -x` an address of each engine (Bing's are in
  `https://www.bing.com/toolbox/bingbot.json`): the name must be under the listed domain and
  resolve back to the address.
- **When it changes:** update `CRAWLERS`. Never add a domain that cloud customers get names
  under: a Google Cloud name must stay unverified (`panel/test/unit/attackDetector.test.ts`).

## AI assistants' address lists

- **Priority:** Medium
- **Last checked:** 2026-11-03 09:24 UTC. All 13 lists answered and passed the panel's checks
  (1,097 ranges once merged, the same as on 2026-10-31), each named on its company's bot page:
  OpenAI's four (GPTBot, OAI-SearchBot, ChatGPT-User, OAI-AdsBot), Anthropic's one (ClaudeBot,
  Claude-User, Claude-SearchBot), Google's three user-triggered lists (Gemini Notebook,
  `Google-Agent`), Perplexity's two, Mistral's two and DuckDuckGo's DuckAssistBot. Two lists had
  moved:
  - Google's are now under `/static/crawling/ipranges/`. The old fetchers URL redirects, but the
    old agents URL still answers with a copy last modified 2026-03-03: 4 ranges against 20,
    missing `136.121.40.0/21` and `74.125.232.0/25`, and with a `2001:4860:c::/48` that Google
    has since narrowed to eight /124s. `RANGE_SOURCES` now reads the new paths, and
    `user-triggered-fetchers-google.json` (the Google-owned fetchers, `google-proxy-….google.com`),
    which Google's page names with the other two.
  - Perplexity's page links its two from `www.perplexity.ai`; the `www.perplexity.com` URLs
    redirect there.
  Mistral's page has a `MistralAI-Training` crawler with no published addresses, so there is no
  list to add. The widest ranges are Google's `136.122.0.0/16` and ChatGPT-User's
  `9.129.0.0/16`, which is Microsoft's and in Azure's `AzureCloud` service tag. It was a /17 on
  2026-09-30 and is now at `AI_WIDEST`: one more doubling and the refresh refuses OpenAI's lists.
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
  [Google](https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers),
  [Perplexity](https://docs.perplexity.ai/guides/bots), [Mistral](https://docs.mistral.ai/robots)
  and [DuckDuckGo](https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot).
- **When it changes:** add the list's URL to its company's entry in `RANGE_SOURCES` (a new
  company: a new entry and an `AI_SOURCES` key), run the script again, and commit
  `aiRanges.ts` with it. A list refused for a range wider than `AI_WIDEST` needs a look before
  the limit moves: never blocking a whole /15 is a lot to take on trust.

## Traefik: the Cloudflare token from a file

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:27 UTC. Traefik v3.7.17 (2026-10-30, commit 04e8ccf), what
  `traefik:v3.7` now pulls, imports lego v5.6.0 (#14166); v3.7.15 and v3.7.16 kept v5.5.2. In
  v5.6.0, as in v5.5.2, `GetOrFile` (`platform/env/env.go`, unchanged) returns
  `CF_DNS_API_TOKEN` when it has a value and only otherwise reads the file
  `CF_DNS_API_TOKEN_FILE` names, trailing newline trimmed; the Cloudflare provider asks for its
  token through it (`NewDNSProvider`, `providers/dns/cloudflare/cloudflare.go`, unchanged).
  Traefik builds its ACME client, DNS provider and all, once per process: `getClient` in
  `pkg/provider/acme/provider.go`, unchanged since v3.7.14, keeps `p.client`, and is called only
  to get or renew a certificate.
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
- **Last checked:** 2026-11-08 17:28 UTC. Cloudflare's
  [token formats](https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/)
  (updated 2026-10-23): a prefix - `cfut_` for a user's token, `cfat_` for an account's - then 40
  characters and a checksum; older tokens are 40 characters and keep working; `cfk_` is a Global
  API Key, an older one 37 to 45 lowercase hex characters. New on the page: Wrangler's OAuth
  access tokens, `cfoat_`, which expire and which `wrangler auth token` hands to other tools;
  `cloudflareTokenSchema` does not refuse them by prefix, so one that fits its characters would
  be saved, work until it expires, and then leave certificates unrenewed. Refusing the prefix, as `cfk_` is refused,
  is a one-line refine; not done. The API reference accepts Zone Read for List Zones (`per_page`
  5 to 50) and DNS Read or DNS Write for List DNS Records.
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
- **Last checked:** 2026-10-07 07:33 UTC. `@astrojs/starlight` 0.42.5, `astro` 7.3.6 (2026-10-06),
  `@playwright/test` 1.63.0 and oxipng 10.2.1 (2026-09-02) are the latest releases. Moving from
  Astro 7.3.5 changed nothing in the built site but its generator tag. `npm outdated` also lists
  newer patch and minor releases of `picomatch`, `tinyglobby`, `yaml`, `@types/node` and
  `@types/picomatch`, and `pixelmatch` 8. `npm audit` in `docs/site` reports two advisories.
  `braces` (stack exhaustion on deeply nested patterns) comes through `starlight-llms-txt` →
  `micromatch`, with no fixed version yet. `postcss-selector-parser` (quadratic selector parsing,
  GHSA-rj75-hqrm-r3gf) is fixed only in 7.1.6: `postcss-nested` 7 takes it, but
  `@expressive-code/core` 0.44.2, the latest, requires `postcss-nested` 6.
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
- **Last checked:** 2026-11-08 17:25 UTC. The demo is behind, and `check-versions.ts` exits 1.
  WordPress 7.1.4 (2026-10-28, after 7.1.3 on 2026-10-06) is the newest release; wordpress.org now
  calls the demo's 7.1.2, 7.0.6 and 6.9.9 insecure. The newest of the older branches, 7.0.8 and
  6.9.11 (both 2026-10-28), are outdated but not insecure, and have no advisory. Newer directory
  releases, the latest updated 2026-11-05: Yoast SEO 28.8, WooCommerce 11.2.2, Safe SVG 2.5.2,
  The Events Calendar 6.18.3.1, MC4WP 4.15.0, TablePress 3.4.1, Polylang 3.9.1, WP Super Cache
  3.1.5 and Query Monitor 4.1.1. By hand: ACF PRO 6.8.11 (2026-11-02, security fixes), and
  Breakdance 3.0 (2026-10-26) and 3.0.1 (2026-10-28); Breakdance Zero is still 1.0.0.
  Redirection and Yoast Duplicate Post are now tested up to 7.1.4, Regenerate Thumbnails up to
  6.8.12. Four plugin versions the demo runs now have advisories: The Events Calendar 6.17.5.1
  (up to 6.18.2), WooCommerce 11.1.1 (below 11.2.0), Polylang 3.8.10 and MC4WP 4.14.1; The Events
  Calendar 6.18.3 and WooCommerce 11.2.0 have none. Yoast SEO 28.8 needs WordPress 7.0, which the
  site on 6.9 lacks; 28.7 (2026-10-13) needs only 6.9. Contact Form 7 6.2.4.1 still needs PHP 8.3
  and WordPress 7.1, which three demo sites lack, so the demo keeps 6.1.7. The demo was not
  updated at this check.
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

## The DKIM signer's image: x86-64 only

- **Priority:** Low
- **Last checked:** 2026-10-07 11:05 UTC. Every tag of `instrumentisto/opendkim` on Docker Hub,
  `latest` included, is built for amd64 alone. The last push was 2026-01-29.
- **The problem:** `deploy/docker-compose.yml` runs the DKIM signer from this image. It is the
  one third-party image in the stack without an ARM build: Traefik, MariaDB, `boky/postfix`, the
  scanner and rclone all have one. WPL7's own images (`build-images.yml`) are amd64 only too, so
  `install.sh` and `setup.sh` stop on a server that is not x86-64.
- **Check:** `curl -fsS 'https://hub.docker.com/v2/repositories/instrumentisto/opendkim/tags?page_size=10' | jq -r '.results[] | .name + " " + ([.images[].architecture] | join(","))'`.
- **When it changes:** an arm64 build of `latest` leaves only WPL7's own images between it and
  ARM servers. Tell the user, and offer what ARM support then takes: `linux/arm64` beside
  `linux/amd64` for the panel, site and SFTPGo images in `build-images.yml`, a test install on an
  ARM server, and the architecture check taken out of `install.sh` and `provision/setup.sh`.

## setup-php: PHP 7.0 in CI

- **Priority:** Low
- **Last checked:** 2026-10-07 15:07 UTC. `v2` is the newest major tag of
  `shivammathur/setup-php`. Its latest release is 2.37.2 (2026-06-08); 2.40.0-beta has been out
  since 2026-09-29. Its README lists PHP 5.3 to 8.6 on GitHub-hosted runners, 7.0 and 8.5 among
  them, on `ubuntu-latest` (Ubuntu 24.04).
- **The problem:** the `php` job in `.github/workflows/test.yml` lints the migration plugin and
  checks its protocol vectors on PHP 7.0 and 8.5 through `shivammathur/setup-php@v2`, pinned by
  major tag like every action here. PHP 7.0 has been out of support since 2019. If the action or
  the runner image stops providing it, the job fails, and the plugin's floor (the next entry) goes
  untested.
- **Check:** `gh api repos/shivammathur/setup-php/releases/latest --jq .tag_name`, then
  `gh api 'repos/shivammathur/setup-php/git/matching-refs/tags/v' --jq '.[].ref'` for a new major,
  and the PHP support table in its README for 7.0 on `ubuntu-latest`.
- **When it changes:**
  - **A new major:** read its release notes and move `@v2`. Dependabot's `actions` group proposes
    it too.
  - **7.0 gone from `ubuntu-latest`:** run the job's 7.0 leg in the `php:7.0-cli` image instead
    (`container:` on the job), and tell the user: the floor may have to move.

## The migration plugin's floor: WordPress 5.0 and PHP 7.0

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:27 UTC. By wordpress.org's statistics, PHP 7.0 runs 0.54% of
  WordPress sites, 7.1 0.32% (0.86% together) and 5.x 1.9%. WordPress before 5.0 runs 2.5%, and
  5.0 itself 0.19%. The `php` job's 7.0 leg still runs: on 2026-11-04 setup-php installed PHP
  7.0.33 on `ubuntu-24.04`, and it passed. PHP 8.5 (8.5.12) is still the newest release and the
  matrix's upper end. 8.6.0 is at RC5 (2026-11-05), with GA set for 2026-11-19.
- **The problem:** WPL7 Migrate runs on the old site, which can be anything. Its header and
  `readme.txt` say `Requires at least: 5.0` and `Requires PHP: 7.0`, activation refuses anything
  older, and the code keeps to what PHP 7.0 has: no nullable or void types, no arrow functions, no
  `??=`, no functions added since. Nothing in it may be deprecated on the newest PHP either. A floor
  set too high locks out the sites that most need moving; one set too low costs care in every
  change, and needs a CI that can still install it.
- **Check:** `curl -s https://api.wordpress.org/stats/php/1.0/` and
  `curl -s https://api.wordpress.org/stats/wordpress/1.0/` for the shares of PHP 7.0 and 7.1 and of
  WordPress 5.0 and older. Whether the `php` job's 7.0 leg still runs. Whether a newer PHP than the
  matrix's upper end is out.
- **When it changes:**
  - **PHP 7.0 and 7.1 together under about 0.5% of sites, or 7.0 gone from CI:** propose raising
    the floor to the user. It is `Requires PHP` in `wpl7-migrate.php` and `readme.txt`, the version
    checks in `wpl7-migrate.php` and `WPL7_Migrate_Plugin::requirements_problem()`, the matrix in
    `test.yml`, and docs/internal/import-protocol.md.
  - **WordPress 5.0 and older under about 1%:** the same for `Requires at least`.
  - **A new PHP release:** make it the matrix's upper end, and run the plugin on a real WordPress
    with that PHP and `WP_DEBUG_LOG` on (the official image has a `php8.x-apache` tag for each).

## The WordPress image's entrypoint, as an import and `wpl7-start` rely on it

- **Priority:** Medium
- **Last checked:** 2026-11-24 06:45 UTC. `docker-entrypoint.sh` on docker-library/wordpress's default branch acts
  only when its first argument starts with `apache2` or is `php-fpm`. It then copies WordPress into
  `/var/www/html` only when neither `index.php` nor `wp-includes/version.php` is there, and writes
  `wp-config.php` only when there is none (`! -s`), then chowns it to `www-data`. It writes it from
  the first `wp-config-docker.php` it finds: the one in the site's folder, then its own in
  `/usr/src/wordpress`. `wp-config-docker.php` reads the table prefix from `WORDPRESS_TABLE_PREFIX` and ends with
  the `/* That's all, stop editing!` line.
- **The problem:** the site image is the fpm variant, whose services `wpl7-start` starts itself. So it
  runs the entrypoint once as `docker-entrypoint.sh php-fpm -t`: the first argument gets the seeding and
  `wp-config.php` done, and `-t` only tests PHP-FPM's configuration and returns. An import
  (`panel/src/jobs/handlers/import.ts`) moves an old site's files into the site folder without a
  `wp-config.php` and starts the container: the image must leave those files alone and write a
  `wp-config.php` of its own, with the site's prefix, which the import then adds the carried settings
  to with `wp config set` (placed above the "stop editing" line). The image copies its own `.htaccess`
  only into an empty folder, which is why the finish job writes WordPress's standard one when the old
  site had none. An old site's own `wp-config-docker.php`, there when it ran on this image, would be
  the template for the new `wp-config.php`: an import (`IMPORT_SKIPS` in `panel/src/services/imports.ts`,
  for pulls saved before it too) and a Duplicator package (`siteFileFilter` in
  `panel/src/services/duplicator.ts`) leave it out, and `leaveBehind` takes it out of the staging folder.
  PHP sites rely on the other side of it: `wpl7-start` runs the entrypoint only for a
  container with `WORDPRESS_DB_HOST`, which every WordPress site's container has and a PHP site's
  never does, and plain `php-fpm -t` otherwise, so nothing is put into a PHP site's folder.
  `test/engine/phpSite.test.ts` proves that an empty folder stays empty without the variable, and
  that a WordPress container on the same image is still seeded.
- **Check:** `gh api repos/docker-library/wordpress/contents/docker-entrypoint.sh --jq .content | base64 -d`
  around the first `if`, the `index.php` and `wp-config.php` tests and the `wp-config-docker.php` list, and
  `gh api repos/docker-library/wordpress/contents/wp-config-docker.php --jq .content | base64 -d | grep -n 'table_prefix\|stop editing'`.
- **When it changes:**
  - **It stops acting on `php-fpm`:** `wpl7-start` has to run it with whatever it takes instead. A new
    site would otherwise get an empty folder. Run `WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteStack.test.ts`,
    and `test/engine/phpSite.test.ts`, which starts a WordPress container and a PHP site's on the same
    image.
  - **It starts seeding a folder that has WordPress in it:** the import must write its files after the
    first start instead of before.
  - **It stops writing `wp-config.php`:** the finish job has to write one itself. Then run the import's
    Docker test (`panel/test/e2e/import/`).

## WPL7 Connect's floor: WordPress 5.2 and PHP 7.0

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:27 UTC. By wordpress.org's statistics, PHP 7.0 runs 0.54% of
  WordPress sites and 7.1 0.32%. WordPress before 5.2 runs 3.0% (5.0 0.19%, 5.1 0.32%, older
  2.5%). The `php` job still checks the vectors on PHP 7.0 and 8.5: on 2026-11-04 its 7.0 leg got
  PHP 7.0.33 on `ubuntu-24.04` and passed. PHP 8.6.0 is at RC5, with GA set for 2026-11-19. The
  Docker test (`panel/test/e2e/connect/`) was not run at this check; at the last check it passed
  on WordPress 5.2 with PHP 7.1, which has no sodium, and on the latest WordPress.
- **The problem:** WPL7 Connect runs on a site the panel does not host, which can be old. Its
  header and `readme.txt` say `Requires at least: 5.2` and `Requires PHP: 7.0`, activation refuses
  anything older, and the code keeps to what PHP 7.0 and WordPress 5.2 have: 5.2 is the first
  WordPress with its fatal-error handler and with sodium_compat, which the plugin verifies the
  panel's signatures with where PHP has no sodium. A floor set too high locks sites out; one set
  too low costs care in every change.
- **Check:** `curl -s https://api.wordpress.org/stats/php/1.0/` and
  `curl -s https://api.wordpress.org/stats/wordpress/1.0/` for PHP 7.0 and 7.1 and for WordPress
  before 5.2. Whether the `php` job's 7.0 leg still runs (the setup-php entry above).
- **When it changes:**
  - **PHP 7.0 and 7.1 together under about 0.5% of sites, or 7.0 gone from CI:** propose raising
    the floor to the user: `Requires PHP` in `wpl7-connect.php` and `readme.txt`, the checks in
    `wpl7-connect.php` and `WPL7_Connect_Plugin::requirements_problem()`, the matrix in `test.yml`,
    the Docker test's oldest case, and docs/internal/connect-protocol.md.
  - **WordPress before 5.2 under about 1%:** the same for `Requires at least`.
  - **A new PHP release:** make it the matrix's upper end, and run the Docker test with that PHP.

## WordPress's upgrader, as WPL7 Connect drives it

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:30 UTC. WordPress 7.1.4 (2026-10-28) is the latest release. As
  a security fix it changed `class-wp-upgrader.php` and `update-core.php` (r64877 on trunk,
  backported to 7.0.8 and 6.9.11): `unpack_package()` now unpacks into
  `wp-content/upgrade/<package>-<16 random characters>` and keeps an `index.php` in
  `wp-content/upgrade/`, and `update_core()` never copies a `wp-config.php`. WPL7 Connect does not
  use that folder, and its backups leave `wp-content/upgrade/` out. On trunk, the plugin and theme
  upgraders changed only in their docs (r64435, 2026-10-16): `upgrade()` and `install()` are now
  documented to return `null` when they fail before installing, which `upgrade_error()` already
  counts as a failure. `update-core.php` also gained 7.2 file-list entries (two Gutenberg
  updates, and the new default theme). `class-core-upgrader.php` is unchanged. No major release
  since the last check: 7.2 is due 2026-12-08, and its field guide is not out yet. The Docker
  test was not run on 7.1.4 at this check.
- **The problem:** WPL7 Connect updates plugins, themes and WordPress through WordPress's own
  upgrader (`Plugin_Upgrader::bulk_upgrade`, `Theme_Upgrader::bulk_upgrade`, `Core_Upgrader::upgrade`)
  and reads its results to say whether an item was updated. Before an update it copies the plugin
  or theme to `wp-content/wpl7-rollback/<op>/`, and puts that copy back when the site stops
  answering. WordPress's own temporary backup folder (`wp-content/upgrade-temp-backup`, 6.3 on) is
  left out of backups. A change to the upgrader's results, to where it moves files, or to its own
  rollback could make an update look failed or a rollback put back the wrong files.
- **Check:** `gh api 'repos/WordPress/wordpress-develop/commits?path=<file>&since=<last check>'`
  for `src/wp-admin/includes/class-wp-upgrader.php`, `class-plugin-upgrader.php`,
  `class-theme-upgrader.php`, `class-core-upgrader.php` and `src/wp-admin/includes/update-core.php`,
  and the field guide of every major release since the last check.
- **When it changes:** read the change against `class-wpl7-connect-updates.php`, then run the
  Docker test (`WPL7_CONNECT_E2E=1 npx vitest run test/e2e/connect` in `panel`) on the release's
  image. A change in what the upgrader returns goes into `upgrade_error()` and the vectors.

## WordPress's shutdown, as WPL7 Connect answers an activation that ended PHP

- **Priority:** Medium
- **Last checked:** 2026-11-20 09:48 UTC. In WordPress 7.1.4, `default-filters.php` hooks
  `wp_ob_end_flush_all` to `shutdown` at priority 1, `wp-settings.php` registers
  `shutdown_action_hook` as a shutdown function, and `WP_Fatal_Error_Handler::handle()` returns at
  once while `WP_SANDBOX_SCRAPING` is defined, which `plugin_sandbox_scrape()` does. The Docker
  test's activation cases pass on 7.1.5.
- **The problem:** a plugin can end PHP while WordPress activates it, after WordPress saved it as
  active. Breakdance's first activation does: `exit(wp_redirect(...))` to its onboarding page.
  WPL7 Connect then answers the panel from WordPress's `shutdown` action, at `PHP_INT_MIN`, ahead
  of `wp_ob_end_flush_all()`. Once that flush has sent the redirect, the panel sees no answer and
  asks again the other way in; an install then fails on its own folder. A fatal error during an
  activation reaches the same answer only while WordPress's fatal error handler stays out of it.
- **Check:** `gh api 'repos/WordPress/wordpress-develop/commits?path=<file>&since=<last check>'`
  for `src/wp-includes/default-filters.php` (the `shutdown` hooks), `src/wp-settings.php`,
  `src/wp-includes/class-wp-fatal-error-handler.php` and `src/wp-admin/includes/plugin.php`
  (`activate_plugin`, `plugin_sandbox_scrape`). Or run the Docker test's activation cases on the
  latest image.
- **When it changes:** move the answer ahead of whatever sends output first
  (`answer_if_php_ends()` in `class-wpl7-connect-server.php`), raise the plugin's version, and run
  `WPL7_CONNECT_E2E=1 npx vitest run test/e2e/connect` in `panel`.

## WP-CLI: a plugin's status after a failed install or activation

- **Priority:** Low
- **Last checked:** 2026-11-20 09:58 UTC. In WP-CLI 2.12.0, `Runner::setup_skip_plugins_filters()`
  filters `active_plugins` while WordPress loads and removes the filters at `plugins_loaded`, so
  `wp plugin list --skip-plugins` gives each plugin's real status. `CommandWithUpgrade::install()`
  counts only the installs, and an activation that fails during `--activate` is a warning.
- **The problem:** WP-CLI's exit code does not say whether a plugin install or activation worked.
  A plugin that ends PHP after WordPress saved it as active makes it exit non-zero (Breakdance's
  first activation, exit status 1 on PHP 8.4). A failed activation during `install --activate`
  exits 0. After a run that failed, `WpService.settle()` lists the plugins with
  `--skip-plugins --skip-themes --skip-update-check`, and goes by the status. If that listing hid
  the real status, an active plugin would read as installed but not active.
- **Check:** `gh api 'repos/wp-cli/wp-cli/commits?path=php/WP_CLI/Runner.php&since=<last check>'`
  and `gh api 'repos/wp-cli/extension-command/commits?path=src/WP_CLI/CommandWithUpgrade.php&since=<last check>'`,
  then read what changed in `setup_skip_plugins_filters()` and `install()`.
- **When it changes:** read the status another way in `pluginState()` (`wp option get
  active_plugins --format=json`), and run `test/unit/wpPluginChange.test.ts` against the new
  output.

## WordPress 7.2: sudo mode and Application Passwords

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:30 UTC. 7.2 Beta 1 came out on 2026-10-20, Beta 2 on
  2026-10-27, Beta 3 with 7.1.4 on 2026-10-28, and Beta 4 on 2026-11-03. RC1 is set for
  2026-11-17 and the release for 2026-12-08. Sudo mode is in none of the beta announcements or
  make/core posts, and no trunk commit or pull request mentions it. For Application Passwords,
  trunk adds an email to the user whenever one is created (r63582, 2026-09-10; the
  `wp_send_application_password_created_email` filter turns it off), and rewords the profile
  screen's note for HTTP sites (r64091). How they authenticate is unchanged. The panel never
  creates one: the user makes it in wp-admin, and gets that email once. The login link, the REST
  request and the Docker test were not run on the beta at this check.
- **The problem:** the panel signs administrators in without their password: **Log in to
  WordPress** on hosted sites, and WPL7 Connect's login links on external ones. A sudo prompt would
  ask that administrator for a password they may not know. The panel's REST requests
  (`POST /api/sites/:site/wp/rest`, scheduled `wp.rest` jobs) authenticate on hosted sites with
  Application Passwords, which the hardening may change.
- **Check:** the 7.2 beta announcements and dev notes on make.wordpress.org/core for sudo mode and
  Application Passwords. Once Beta 1 is out, run a login link and a REST request on a hosted site
  with the beta, and the Docker test (`panel/test/e2e/connect/`) on the beta's image.
- **When it changes:** if sudo mode ships, find out whether a login made without a password can
  pass it (a filter, or the session's own) and tell the user before 7.2 is out. If Application
  Passwords change, check the panel's REST bridge and the docs that describe it.

## WP Godmode's `godmode` command on WPL7 Connect

- **Priority:** Medium
- **Last checked:** 2026-11-08 17:31 UTC. Not released yet. WP Godmode's latest release is 1.3.2
  (2026-10-06), which added control through WP-CLI; no release note mentions WPL7 Connect. On an
  external site running 1.3.2 and WPL7 Connect 1.0.0, `GET /api/sites/<site>/wp/cli/help` answers
  "No commands are registered with WPL7 Connect", and `?command=godmode` answers 404. Until a
  release registers it, the panel's Godmode calls on an external site (`/api/sites/:site/godmode/*`)
  answer 409, as on a site without WP Godmode.
- **The problem:** on a hosted site the panel drives WP Godmode through WP-CLI's `wp godmode`. An
  external site has no WP-CLI the panel can reach: there, WP Godmode has to register `godmode` with
  WPL7 Connect (the `wpl7_connect_commands` filter, docs/internal/connect-protocol.md section 8),
  answering the same words with the same JSON. The panel splits a long wait into steps of 25
  seconds, which the command must take as `--timeout`.
- **Check:** WP Godmode's release notes for WPL7 Connect. On a site that has such a release,
  `GET /api/sites/<site>/wp/cli/help` lists `godmode`.
- **When it changes:** run the MCP's send, wait, answer and read loop on an external site. Then
  update docs/site's MCP and external sites pages, and remove this entry.

## WordPress's answer to a fatal error

- **Priority:** Low
- **Last checked:** 2026-10-09 15:55 UTC. `class-wp-fatal-error-handler.php` on trunk still sends its
  error page with `'response' => 500`; it last changed on 2026-09-05 (docs).
- **The problem:** after an update, the panel asks an external site's home page, and WPL7 Connect
  behind it, whether they still answer; a plugin that breaks the site is put back when they do not.
  That rests on WordPress answering a fatal error with a 5xx status (5.2 on). A broken site answering
  200 would pass the check, and keep the broken plugin.
- **Check:** `gh api repos/WordPress/wordpress-develop/contents/src/wp-includes/class-wp-fatal-error-handler.php --jq .content | base64 -d | grep -n "'response'"`.
- **When it changes:** the check in `ConnectorBackend.healthy()` (`panel/src/services/siteBackend.ts`)
  has to read the answer's body too (the handler's page), then run the Docker test.

## WordPress's default From address

- **Priority:** Medium
- **Last checked:** 2026-11-13 13:00 UTC. `wp_mail()` still sends as `wordpress@` and the host of
  `network_home_url()`, with a leading `www.` taken off, on 7.1.4, the latest release, and on trunk.
  pluggable.php's one change since (2026-10-17) was to a doc comment. 7.2 Beta 5 (2026-11-10, final
  due 2026-12-08) is the same. WordPress still sets no envelope sender of its own: the default one
  added in r61010 was reverted in r61537.
- **What we rely on:** Mail → Setup guide lists one sending domain per site, its primary domain
  without `www.` (`MailService.sendingDomains`, with `mailDomainOf` in
  `panel/src/services/mailAuth.ts`). A site on `www.example.com` also owns `example.com` for the
  relay and the signer (`MailService.senderOwners`). If WordPress sent from another address, the
  guide would ask for records where no mail comes from, and the mail it does send would go out
  unsigned. A WordPress site's default sender, for mail that names no sender of its own, is the same
  address: `wordpress@` and the primary domain without `www.` (`defaultMailFrom` in
  `panel/src/services/mailAuth.ts`, written to `config/runtime/mail-from` for the image's
  `wpl7-sendmail`). So a change there changes this too.
- **Check:** `gh api repos/WordPress/wordpress-develop/contents/src/wp-includes/pluggable.php --jq .content | base64 -d | grep -n "get rid of www" -A6`.
- **When it changes:** make `mailDomainOf` and `defaultMailFrom` follow it, and update "Which domains
  are listed" on `docs/site/src/content/docs/mail/setup.mdx`, and the owner rule and the sender rule
  on `mail/overview.mdx`.

## msmtp: one envelope sender, as `wpl7-sendmail` relies on it

- **Priority:** Low
- **Last checked:** 2026-11-11 23:04 UTC. The site image has msmtp 1.8.28, Debian trixie's
  1.8.28-3, with nothing newer in trixie-security or trixie-updates. On 2026-11-11 the wrapper was
  run through 14 cases of PHP's `mail()` and `sendmail` with it, on PHP 8.4.27, and the engine mail
  tests pass on PHP 8.4 (arm64). Upstream is at 1.8.34 (2026-07-31). Since 1.8.28, 1.8.29 added `%F`
  to the `from` command, which sets the envelope sender from the From header, and the 1.8.31
  announcement lists a fix to the error checks of `--read-envelope-from` (its NEWS entry says no
  significant changes). Nothing else since touches the four behaviours below, and neither change is
  in Debian's package. Master's `src/msmtp.c` still refuses every `-b` mode but `-bm`.
- **What we rely on:** msmtp takes the envelope sender from one place: `-f` (`--from`), or
  `--read-envelope-from`, which reads it from the From header. It refuses the two together ("cannot
  use both --from and --read-envelope-from"), and a message with neither fails ("envelope-from
  address is missing"). Given `-f` and a message with no From header, it adds one
  (`set_from_header auto`, the default). It refuses every `-b` mode but `-bm` at once, before it
  reads anything ("unsupported operation mode"). `deploy/wordpress-image/wpl7-sendmail`, which is
  PHP's `sendmail_path` and `/usr/sbin/sendmail`, relies on all four: it passes a caller's `-f` on as
  it is, runs `--read-envelope-from` for a message with a From header, and gives a message with
  neither the site's default sender with `-f`, which msmtp then writes as its From header too. It
  hands any other `-b` mode to msmtp untouched: read by the wrapper, `-bs` would hang, because its
  caller waits for an SMTP greeting and never closes stdin. A `from` line
  in msmtprc is no substitute: beside `--read-envelope-from` msmtp ignores it, and without that flag
  it replaces every message's envelope sender.
- **Check:** `curl -s 'https://qa.debian.org/madison.php?package=msmtp&table=debian&s=trixie,trixie-security,trixie-updates&text=on'`
  for the image's version, and NEWS and the release announcements since that version
  (<https://marlam.de/msmtp/news/>) for `--from`, `--read-envelope-from` and `set_from_header`. For a
  new version, build the image and run
  `WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteStack.test.ts test/engine/phpSite.test.ts -t mail`,
  whose mail cases send all three kinds and assert each one's `MAIL FROM`, and see `-bs` refused at
  once.
- **When it changes:** rework `wpl7-sendmail`. If msmtp stops adding a missing From header, or `-f`
  or `--read-envelope-from` takes the sender from somewhere else, a message the wrapper hands it
  leaves with no From header, or with another sender than the one it picked. msmtp taking both flags
  together breaks nothing: the wrapper adds only one of them. If it starts speaking
  SMTP for `-bs`, the wrapper can keep handing `-bs` on, but has to give it the sender too. Once the image's msmtp
  has `%F` (1.8.29 on, so not before Debian's next release), `from %F` in msmtprc may do the
  wrapper's second rule; test it before relying on it.

## sodium_compat for PHP 7.0 in CI

- **Priority:** Low
- **Last checked:** 2026-10-09 15:55 UTC. paragonie/sodium_compat 1.24.2 (2026-08-18) is the newest
  1.x and requires PHP `^5.2.4|…|^7|^8`; 2.5.2 needs PHP 8.1, so Composer on PHP 7.0 takes 1.x.
- **The problem:** PHP 7.0 has no sodium. WordPress bundles sodium_compat from 5.2 on, but the `php`
  job runs the plugin's checks without WordPress: on its 7.0 leg it installs sodium_compat with
  Composer (`composer require paragonie/sodium_compat`, unpinned) and points `WPL7_SODIUM_COMPAT`
  at it. If 1.x stops installing on PHP 7.0, the 7.0 leg fails.
- **Check:** `gh api repos/paragonie/sodium_compat/releases --jq '.[0:4][] | "\(.tag_name) \(.published_at)"'`,
  and the `require` of the newest 1.x tag's `composer.json`.
- **When it changes:** pin the last 1.x that installs (`paragonie/sodium_compat:^1.24`), or copy the
  sodium_compat WordPress 5.2 bundles into the test folder.




## GNU tar: its words for a file that changes while it is read

- **Priority:** Low
- **Last checked:** 2026-11-25 10:47 UTC. Ubuntu 24.04 and 26.04 both have GNU tar 1.35. In a
  container, tar exits 1 with "file changed as we read it" for a folder that gains files and a
  file that grows while it is read, "File removed before we read it" and "File shrank by N bytes;
  padding with zeros", and the archive tests whole. A file it cannot open gives exit 2, "Cannot
  open: Permission denied" and "Exiting with failure status due to previous errors".
- **The problem:** a backup archives a running site's files, which the site may change while tar
  reads them. tar's exit 1 says only that; the archive is whole.
- **What we do about it:** `changedWhileArchived` in `panel/src/services/backup.ts` lets a backup
  go on when tar exits 1 and every line it says is one of those three, and the backup's log names
  the files. Anything else fails the backup.
- **Check:** `tar --version` on a new Ubuntu release. For a new tar, read its NEWS for these
  messages and the exit codes, or repeat the container test: a folder that gains files and a
  file truncated while `tar -czf` reads them.
- **When it changes:** reworded messages go into `CHANGED_WHILE_READ_RE` and its test. Until then a
  backup of a busy site fails again on them, as it did before the change.
## RDAP: registry endpoints and bootstrap

- **Priority:** Medium
- **Last checked:** 2026-11-13 13:08 UTC. IANA's bootstrap of 2026-10-28 still has no .co, .io, .me
  or .us. All four supplement endpoints answer `google.<tld>` and `nic.<tld>` with an `expiration`
  event, and an unregistered name with 404. RFC 8056 has no update or errata, and ICANN's response
  profile is still Version 2.2 of 21 February 2024. IANA's RDAP JSON Values registry last changed
  2025-06-04. ICANN's conformance tool 4.0.0 (2026-11-09) changes only which status combinations its
  test -46900 accepts, not any status value or event.
- **Status:** The panel uses IANA first, then the four entries in `RDAP_SUPPLEMENT` in
  `panel/src/services/domainLookups.ts`. Dates without an `expiration` event stay manual.
- **Check:** Fetch [IANA's bootstrap](https://data.iana.org/rdap/dns.json), check those four TLDs,
  and check each supplement endpoint's domain response. Check [RFC 8056](https://www.rfc-editor.org/rfc/rfc8056)
  for status mappings and ICANN's RDAP requirements for changes to expiration events.
- **When it changes:** Remove a supplement entry once IANA supplies it, or update an endpoint
  that has moved. Update the RDAP tests and Reminders documentation. Never treat `auto renew period`
  as proof that the registrant has renewed, or discard a known date after a failed lookup.

## Reminders: PHP and OS support dates

- **Priority:** Medium
- **Last checked:** 2026-11-13 13:02 UTC. PHP 7.0 through 8.5, Ubuntu LTS 18.04 through 26.04 and
  Debian 10 through 13 still match php.net, ubuntu.com and debian.org, and no support was extended.
  PHP 8.6 is not out: RC7 came on 2026-11-12, GA is planned for 2026-11-19, and no php.net table
  lists it yet. php.net dates a branch from its GA, four years on, moved to 31 December, so
  2030-12-31 is expected. Add it to `PHP_EOL` from php.net's table once it is there, no later than
  the change that offers 8.6 to sites. Ubuntu 26.10 came out on 2026-10-15, with standard support to
  July 2027. It is an interim release, which the LTS-only map leaves out.
- **Status:** `PHP_EOL` and `OS_EOL` in `panel/src/services/reminderSources.ts` are the shipped
  security-support dates. Ubuntu standard maintenance ends in a published month, so the reminder
  uses its first day and says so. Debian includes LTS. Paid extensions are excluded.
- **Check:** Compare [supported PHP](https://www.php.net/supported-versions.php),
  [unsupported PHP](https://www.php.net/eol.php),
  [Ubuntu's release cycle](https://ubuntu.com/about/release-cycle) and
  [Debian's release table](https://www.debian.org/releases/index.en.html) with both maps.
  Include newly stable branches and support extensions announced upstream.
- **When it changes:** Update the maps, their tests and the documented coverage. Existing tracked
  reminders pick up revised dates on the next reminder pass. Unknown releases must never get
  an invented support date.

## Reminders: Cloudflare token lifetime

- **Priority:** Medium
- **Last checked:** 2026-11-13 13:15 UTC. Cloudflare's OpenAPI schema of 2026-11-12 differs from
  2026-10-13's only in annotations. `/user/tokens/verify` and `/accounts/{account_id}/tokens/verify`
  take an API token, list no permission, and return `id` and `status` (`active`, `disabled`,
  `expired`), with `expires_on` and `not_before` optional. List Zones takes Zone Read and names each
  zone's `account`. Neither verify endpoint is documented to take Wrangler's `cfoat_` OAuth tokens
  (formats page of 2026-10-23), so the reminder would most likely say "Token check failed" for one
  and claim no date. Not tried: that needs a real token.
- **Status:** `ReminderSources` uses user verification for user tokens and account verification
  for account tokens, including legacy tokens discovered through visible zones. A working token
  whose verification is refused retains its last known date, without claiming it is expired.
- **Check:** Read Cloudflare's [user-token verification](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/),
  [account-token verification](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/)
  and [zone listing](https://developers.cloudflare.com/api/resources/zones/methods/list/) contracts.
  Check response fields, required permissions and supported token formats.
- **When it changes:** Update `ReminderSources`, its failure-handling tests and Reminders docs.
  Never expose the token in a reminder, a response, an error or a calendar feed.

## The MariaDB image's bash and client, as the database browser and imports rely on them

- **Priority:** Medium
- **Last checked:** 2026-11-19 08:16 UTC. `mariadb:11.4` was rebuilt on 2026-11-11 and is still
  MariaDB 11.4.13 on Ubuntu 24.04.5. Its bash is 5.2.21 and opens `/dev/tcp`. Its client, 15.2,
  refuses `\!`, `system`, `source` and `LOAD DATA LOCAL INFILE` with the import flags. The engine
  test `panel/test/engine/dbBrowser.test.ts` passes on it, 19 of 19, run on the image's arm64
  build.
- **The problem:** two things lean on the image.
  - A site's **Database** tab reaches MariaDB through `docker exec`. The relay (`RELAY_CMD` in
    `panel/src/services/dbBrowser.ts`) is `bash -c 'exec 3<>/dev/tcp/127.0.0.1/3306 …'` inside
    `wpl7-mariadb`, and logs in as the site's own user, which only works while the image creates
    no anonymous users. An image without bash, with a bash built without network redirections,
    or with an anonymous `''@'localhost'` user, would break the browser on every server. It
    would show at once: the tab answers 502 with the relay's own error.
  - Every dump is loaded by the image's `mariadb` client with `IMPORT_CLIENT_ARGS`
    (`panel/src/services/dbAdmin.ts`): `--binary-mode --sandbox --local-infile=0`. Without them
    a dump runs shell commands and reads local files inside the client's container, and on a
    remote server that is `wpl7-mariadb`, root password and all. A client that drops one of
    these options fails every import, which shows. One that keeps the option but stops
    refusing would not show: only the engine test catches it.
- **Check:** `docker pull mariadb:11.4`, then
  `docker run --rm --entrypoint bash mariadb:11.4 -c 'echo $BASH_VERSION; (exec 3<>/dev/tcp/127.0.0.1/1) 2>&1 | head -1'`
  answers a version and `Connection refused`. Then run the engine test:
  `WPL7_ENGINE_TESTS=1 npx vitest run test/engine/dbBrowser.test.ts` in `panel/`. It imports a
  dump with each of the four commands on both import paths, and expects each refused.
- **When it changes:** tell the user.
  - The relay: replace it with a command the image has, such as `perl -MIO::Socket::INET` or the
    `mariadb` client in a container of its own on `wpl7_db`.
  - The client: find the option that now refuses those commands, put it in
    `IMPORT_CLIENT_ARGS`, and keep imports off the new image until the engine test passes.
  - Either way, run the engine test on the new image before it reaches a server.

## Adminer: the pinned build and its advisories

- **Priority:** High
- **Last checked:** 2026-11-24 10:07 UTC, moving the pin to 6.3.1 (2026-11-20, the latest). The
  MySQL English build's SHA-256 matches GitHub's own digest of the file. 6.3.1 fixes two advisories.
  [GHSA-5xfm-7vgj-3f39](https://github.com/vrana/adminer/security/advisories/GHSA-5xfm-7vgj-3f39)
  (medium, a `file:` URI as a database name) is in the SQLite driver, which the MySQL-only build
  leaves out.
  [GHSA-qjv8-pw8g-jw65](https://github.com/vrana/adminer/security/advisories/GHSA-qjv8-pw8g-jw65)
  (low) put keys of `where[]` from the URL into the Select page's search form unescaped. It names
  only 6.3.0, but 6.2.0 had the same code: 6.3.1 keeps only the keys' digits. Without an advisory,
  it also escapes a geometry column's name in conditions, edit and export (SQL injection), and a
  FULLTEXT index's name in the search form (HTML injection). The 6.3.1 file still calls all ten
  hooks `wpl7.php` uses, as often as 6.2.0, and `connection()` and `adminer_object()`. Since 6.3.0
  the sign-in and Logout redirect with 303, not 302: `prepare()` in `panel/src/adminer/index.ts` now
  takes either, 302 for an older Adminer in an image set with `WPL7_ADMINER_IMAGE`. The image,
  `6.3.1-wpl7.1`, builds on `php:8.4-cli-alpine` at PHP 8.4.28, and the engine test passes on it (6
  of 6). Its `php.ini` leaves `session.upload_progress.enabled` on, which the site image turns off:
  Adminer's import shows its progress bar with it.
- **The problem:** "Open in Adminer" runs Adminer's MySQL-only English build on every server
  that uses it, pinned in `deploy/adminer-image/Dockerfile` by `ADMINER_VERSION` and
  `ADMINER_SHA256`. It sits behind the panel's front door, signs in as a site's own database
  user and listens on no network, but a bug in Adminer's core or its MySQL code still reaches
  whoever opens it. Adminer fixed several such bugs this year, some within days of each other.
- **Check:** releases and advisories since the last check:
  `gh api repos/vrana/adminer/releases --jq '.[0:3][] | "\(.tag_name) \(.published_at)"'` and
  `gh api repos/vrana/adminer/security-advisories --jq 'sort_by(.published_at) | reverse | .[0:5][] | "\(.published_at) \(.severity) \(.summary)"'`.
  Then the base image:
  `docker pull php:8.4-cli-alpine && docker run --rm php:8.4-cli-alpine php -v`.
- **When it changes:** tell the user.
  - A new release: set `ADMINER_VERSION` and `ADMINER_SHA256` in the Dockerfile and
    `deploy/adminer-image/VERSION` to `<release>-wpl7.1`. Read the release notes for the plugin
    hooks `wpl7.php` uses (`credentials`, `login`, `afterConnect`, `verifyLoginToken`, `loginForm`,
    `bruteForceKey`, `verifyVersion`, `serviceWorker`, `manifest`, `importServerPath`), for
    `connection()`, which `afterConnect` takes the request's lock with, and for `adminer_object()`
    and `X-Forwarded-Prefix`, which `router.php` relies on. Run the engine test, then merge: CI
    publishes the image.
  - An advisory that reaches the MySQL build before a fix is out: ask the user to switch Adminer
    off in **Settings → Security** until it is.
  - A new PHP patch release: bump `VERSION` (`-wpl7.2`) so servers take the new base.

## wordpress.org's directory, as the panel's closed flag reads it

- **Priority:** Medium
- **Last checked:** 2026-11-19 11:43 UTC. Unchanged: the feed still says `closed: 1` for
  `bbpress` (2.6.22 now) and `bbpress-private-replies`, and `closed: null` for `captcha`. The
  directory answers as below: a 200 with `slug` and `version` for `bbpress`, a 404 with
  `error: "closed"`, `closed: true`, `reason: "author-request"` and the sentence for
  `wp-gdpr-compliance`, "Plugin not found." and "Theme not found" for slugs it does not have, and
  a 200 for `twentytwentyfive`.
  At 2026-10-20 12:22 UTC the feed said `closed: 1` for five plugins that wordpress.org lists: `bbpress` (2.6.20, updated 2026-10-15), `bbpress-private-replies`,
  `bbpress-new-topic-notifications`, `bbpress-enable-tinymce-visual-tab` and
  `bbpress-direct-quotes`. Archived copies of bbPress's page from 2026-09-11 to 2026-10-15 show
  it open each time, so the flag is not a closure the feed failed to clear. The feed has
  `closed: null` for `captcha`, `display-widgets` and `wp-symposium`, which wordpress.org closed.
  The directory answers as `wporgListing` reads it: a listed plugin or theme is a 200 with its
  `slug` and a `version`, a closed plugin a 404 with `error: "closed"`, `closed: true` and a
  `reason`, and a slug it does not have a 404 with an `error` string. A closed plugin's page
  stays up with the same sentence the API gives as `description`. Only that sentence says
  whether a closure is temporary. The themes API says "Theme not found" for a theme it took
  down as well.
- **The problem:** the feed's `closed` flag is wrong both ways. A false one put "Closed on
  wordpress.org — replace it." on an open plugin, and mailed it as a new vulnerability. A missed
  one leaves a plugin closed for a security issue unflagged.
- **What we do about it:** `checkClosed` in `panel/src/services/vulnerabilities.ts` asks
  wordpress.org's directory (`wporgListing` in `panel/src/services/wporg.ts`) about every
  plugin the feed is asked about, and about a theme the feed calls closed. Listed is open.
  Closed is closed, with the directory's reason. A slug the directory does not have keeps the
  feed's flag, which is all a closed theme gets. With no answer, the panel keeps its previous
  verdict. A closed verdict is asked about again after an hour (`CLOSED_TTL_MS`). The updates
  page's Limits names the two gaps: themes, and temporary closures shown like permanent ones.
- **Check:**
  ```bash
  for s in bbpress bbpress-private-replies captcha; do
    curl -s "https://www.wpvulnerability.net/plugin/$s/" | jq -c '.data | {plugin, closed, closed_reason, closed_date}'
  done
  for s in bbpress wp-gdpr-compliance not-a-real-plugin-wpl7; do
    curl -s -o /tmp/wporg.json -w '%{http_code} ' "https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=$s&request%5Bfields%5D%5Bsections%5D=0"
    jq -c '{slug, version, error, closed, reason, description}' /tmp/wporg.json
  done
  for s in twentytwentyfive not-a-real-theme-wpl7; do
    curl -s -o /tmp/wporg.json -w '%{http_code} ' "https://api.wordpress.org/themes/info/1.2/?action=theme_information&request%5Bslug%5D=$s"
    jq -c '{slug, version, error}' /tmp/wporg.json
  done
  ```
  The directory should answer 200 with a slug and version, 404 with `error: "closed"` and a
  reason, 404 with an error string, then 200 and 404 for the two themes.
- **When it changes:**
  - The directory answers in another shape: update `wporgListing` and
    `panel/test/unit/wporg.test.ts`. A closed plugin must never read as listed.
  - The themes API starts saying a theme is closed, or the plugins API gets a field for a
    temporary closure: read it, and drop the matching line from the updates page's Limits.
  - The feed's flags change, either way: nothing to do. The panel goes by the directory.

## Google's crawler address lists

- **Priority:** Medium
- **Last checked:** 2026-11-03 09:35 UTC. Both lists answered at the URLs Google's
  [Verify Google requests](https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests)
  page names, and passed the panel's checks: 589 prefixes, 95 ranges once merged.
  - `common-crawlers.json`: 170 IPv4 and 147 IPv6 prefixes. The old `googlebot.json` URL
    redirects to it.
  - `special-crawlers.json`: 136 IPv4 and 136 IPv6 prefixes.
  - None is wider than a /27 or a /64. Some of the common crawlers' addresses answer to
    `<ip>.bc.googleusercontent.com`, all of `34.22.85.0/27` among them.
- **The problem:** detection takes a visitor that claims to be Googlebot at its word when its
  address is on these lists (`googleCrawlers` in `panel/src/services/proxyRanges.ts`). Reverse
  DNS can't tell those addresses from any Google Cloud machine. The panel refreshes the lists
  weekly and keeps the last good copy. A list that moves, or one refused for a range wider than
  `CRAWLER_WIDEST` (a /24 or a /48), leaves that copy to age, and Googlebot from Google's newer
  addresses can be blocked like any visitor again.
- **Check:** count both lists' prefixes and their widest ranges:
  ```sh
  for f in common special; do
    curl -s "https://developers.google.com/static/crawling/ipranges/$f-crawlers.json" |
      jq -r --arg f "$f" '[.prefixes[] | (.ipv4Prefix // .ipv6Prefix)] | "\($f): \(length) prefixes, widest IPv4 /\([.[] | select(contains(".")) | split("/")[1] | tonumber] | min), IPv6 /\([.[] | select(contains(":")) | split("/")[1] | tonumber] | min)"'
  done
  ```
  Together they should hold 100 to 2,000 prefixes, none wider than a /24 or a /48. Then read
  Google's page for the lists' URLs, and for a new list for a crawler `CRAWLERS` counts as
  Googlebot.
- **When it changes:** update `googleCrawlers` in `RANGE_SOURCES`: a moved or new list's URL, or
  the limits once the wider ranges have had a look. Never take a list that covers Google Cloud
  in general: only addresses Google names as its crawlers'.

## ssh2: how a channel closes, as the panel's SSH channels rely on it

- **Priority:** Low
- **Last checked:** 2026-11-15 10:57 UTC. 1.17.0, the version in `panel/package-lock.json`, is the
  latest on npm. In it, `lib/Channel.js` makes a channel half-open unless it is opened with
  `allowHalfOpen: false`, and replaces `destroy()` with an `end()` and a `close()` that never mark the
  stream destroyed. `onCHANNEL_CLOSE` in `lib/utils.js` emits `'close'` only once the stream is no
  longer readable, is destroyed, or has emitted `'end'`. `test/unit/sshDockerChannels.test.ts` passes,
  and `test/e2e/ssh-transport.sh` passes over both ways to docker.sock, on OpenSSH 9.9p2 and Docker
  27.5.1.
- **What we rely on:** a server's Docker calls and host commands share one SSH connection, eight
  channels at a time (`panel/src/servers/sshConnection.ts`), and a channel's slot comes back when the
  channel closes. Two things in ssh2 decide when that is:
  - A channel is half-open: an EOF from the server ends only its readable side. Docker ends its half
    of an exec's connection when the command has exited and leaves the other to the client, and
    OpenSSH keeps a forwarded socket's channel open until both halves have ended. So
    `openDockerChannel` ends the panel's half when Docker's has ended, as Node does by itself for a
    local socket. `DockerService.execWithInput` needs the half-open channel the other way round: it
    ends its half to give a command EOF, and still reads the output after it.
  - `'close'` comes only after `'end'`, or once the stream is not readable, and a hang-up
    (`destroy()`) changes neither. A reader that hangs up has stopped reading, so `'end'` never
    comes. `openDockerChannel`'s hang-up sets `readable = false`, so `'close'` comes as soon as the
    server answers the channel's close; node:http's agent lets go of a socket on `'close'` only. A
    forwarded socket's channel gives its slot back at the hang-up. A dial-stdio channel is an sshd
    session, and one opened before the server has let go of the last is refused (`MaxSessions`), so
    its slot comes back with that `'close'`, or after `HANG_UP_CLOSE_MS` when none can follow: the
    server closed the channel first, or the connection dropped, with output still unread.
- **Check:** `npm view ssh2 version`. For a newer release, read its `lib/Channel.js` (`destroy`,
  `allowHalfOpen`) and `onCHANNEL_CLOSE` in `lib/utils.js` against the above, then install it in
  `panel/` and run `npx vitest run test/unit/sshDockerChannels.test.ts test/unit/dockerExecInput.test.ts`
  and `test/e2e/ssh-transport.sh`. A Dependabot bump runs the unit tests on its own.
- **When it changes:** if `destroy()` comes to mark the stream destroyed, or `'close'` stops waiting
  for `'end'`, the `readable = false` in `openDockerChannel` does nothing any more and can go. If a
  channel stops being half-open by default, ending the panel's half would close the whole channel:
  `execWithInput` would lose a command's output after its input, and the forwarded socket's channel
  would need `allowHalfOpen` passed where ssh2 then takes it.

## ssh2: ed25519 keys from its own generator

- **Priority:** Low
- **Last checked:** 2026-11-24 14:29 UTC. Open upstream since 2024-05-22 as
  [mscdex/ssh2#1390](https://github.com/mscdex/ssh2/issues/1390), reported again as #1513 and #1514
  on 2026-08-26. Its fix, [mscdex/ssh2#1515](https://github.com/mscdex/ssh2/pull/1515), waits for
  review. 1.17.0, the version in `panel/package-lock.json`, is the latest on npm and has the bug: of
  6,000 keys from `utils.generateKeyPairSync('ed25519')`, 23 had a 31-byte public key and failed
  `utils.parseKey`, as 1 in 256 would. Of 20,000 from `newSshKeyPair()`, none failed, 74 had a public
  key starting with a zero byte, and OpenSSH's `ssh-keygen` read the 8 of those it was given.
- **The problem:** ssh2's generator strips every leading zero byte off an ed25519 public key
  (`lib/keygen.js`). It means to drop the BIT STRING's unused-bits byte, but a public key that itself
  starts with a zero byte, 1 in 256, comes out 31 bytes long. Neither ssh2 nor OpenSSH reads that
  private key or its public line.
- **What we do about it:** nothing in the panel or its tests uses ssh2's generator. `newSshKeyPair()`
  in `panel/src/services/ftpKeys.ts` makes ed25519 keys with Node's crypto and writes OpenSSH's format
  itself, for FTP logins and for the panel's own key when it has to make one
  (`panel/src/servers/keys.ts`). An install has its key already: `provision/setup.sh` makes it with
  `ssh-keygen`. A new key anywhere, in tests too, comes from `newSshKeyPair()`.
- **Check:** `gh pr view 1515 -R mscdex/ssh2`, `gh issue view 1390 -R mscdex/ssh2` and
  `npm view ssh2 version`. For a newer release, read the ed25519 case in its `lib/keygen.js`.
- **When it changes:** nothing has to change, as `newSshKeyPair()` stays correct. Once a release we
  use has the fix, remove this entry: ssh2's generator may then be used again.

## Duplicator's package format, as New site reads it

- **Priority:** Medium
- **Last checked:** 2026-11-25 10:03 UTC. Duplicator Lite 5.2.0 is still the latest (the plugin's
  SVN tags). What the panel does in place of the installer's last steps, below, was read in 5.2.0's
  source and compared with the 1.5.17, 5.0.0, 5.0.6, 5.1.0 and 5.1.1 tags: the 5.x names are the
  same from 5.0.0 on, 1.5.17 has the 1.x ones. A site made from the 5.2.0 `.zip` and the 1.5.11 `.zip`
  on WordPress's own image and MariaDB 11.4, with the job's steps, then signed in to with curl:
  the first login lands on Duplicator's **Tools** page ("This site has been successfully
  migrated!", "No Duplicator files were found"), the next on a dashboard without a notice. Without
  the steps, 5.2.0's dashboard says "Encrypted Settings Reset" and "Manual Backup Failed". On
  2026-11-24 10:31 UTC: what the panel reads was taken from 5.2.0's source and from four packages
  built with it and with 1.5.11 on WordPress 7.1.5: a 5.2.0 `.daf` (DupArchive 5.0.1, PHP dump in one
  file per table), a 5.2.0 `.zip` (mysqldump, one dump file), and a 1.5.11 `.zip` and `.daf`
  (DupArchive 1.0.0, the old layout). `WPL7_DUPLICATOR_E2E_DIR=… npx vitest run test/e2e/duplicator`
  passes on all four: every file byte for byte, every table row for row against Duplicator's own
  dump.
- **What we rely on:** none of it is documented by Duplicator.
  - Where things are. 5.x: `dup-installer/dup_descriptors_<hash>/archive.txt`, the dump in
    `db_dumps/`, the old `.htaccess` and `.user.ini` in `orig_files/source_site_*`. 1.x:
    `dup-installer/dup-archive__<hash>.txt`, `dup-installer/dup-database__<hash>.sql`,
    `dup-installer/original_files_<hash>/source_site_*`. The root `wp-config.php`, `.htaccess` and
    `.user.ini` are left out of the archive (`PackageArchive.php`'s global file filter).
  - The dump's order: `dbInfo.dumpFiles` in archive.txt (`schema.sql` first, then a file per table,
    each `.gz` in the archive, `DumpFileMap.php`), else the files of `db_dumps/` by name, else 1.x's
    one file. No `SET NAMES`: the bytes are in WordPress's connection charset (`DB_CHARSET`) when
    the PHP dump wrote them (`PhpDumpEngine.php` reads through `$wpdb`), and when mysqldump did
    from 5.0.0 on (`--skip-set-charset --default-character-set=<$wpdb->charset>`, `DatabasePkg.php`).
    1.5.x's mysqldump has `--skip-set-charset` and no character set of its own (the plugin's SVN
    tags: every 1.5.x without `--default-character-set`, every 5.x with it): its dumps are in the
    client's default, UTF-8 unless the old host's configuration sets another. The job tells which
    from the bytes, which hold text only (`--hex-blob`).
    `dbInfo.buildMode` says which wrote it (`PHP`, `PHPCHUNKING`, `MYSQLDUMP`).
  - mysqldump's own header in 5.x, as the package keeps it: `/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS,
    UNIQUE_CHECKS=0 */;`. With unique checks off InnoDB may take a duplicate into a unique index
    without a word; New site turns them on there (`PackageDumpFilter`).
  - `wpInfo.configs.defines` holds `UPLOADS` when wp-config.php sets it (`addDefineIfExists`,
    `PackInstaller.php`); New site carries it as it is.
  - What the dump holds: rows in `INSERT IGNORE` statements of a row a line, at most the query size
    limit each (`TableDumpWriter.php`, at most 1 MiB); views, procedures and functions in the
    schema file as `SHOW CREATE` gives them, strings with line breaks in them and all
    (`writeRoutines`). Rows load with `INSERT IGNORE` in both modes (mysqldump's `--insert-ignore`);
    New site loads them with a plain `INSERT`, so a row that collides fails the load.
    Triggers are left out (`--skip-triggers`): `dbInfo.triggerList` has each one's
    `"DELIMITER ;;\n<SHOW CREATE TRIGGER>;;\nDELIMITER ;"` (`DatabaseInfo::addTriggers`, the same in
    1.5.x), but not the SQL mode it was made in, which `SHOW CREATE TRIGGER` gives beside it.
    Duplicator's own installer asks for them to be added by hand. New site adds them last, after
    the address rewrite, in WordPress's SQL mode.
  - `dbInfo.tablesList`: the base tables in the package, after its table filters; views only as
    `viewCount`. A table left out by a filter is named nowhere.
  - archive.txt's fields: `wp_tableprefix`, `version_*`, `mu_mode`, `exportOnlyDB`, `components`,
    `wpInfo.configs.realValues` (`homeUrl`, `siteUrl`, `originalPaths`: `home`, `abs`, `wpcontent`,
    `uploads`, `plugins`, `muplugins`, `themes`, from `SnapWP::getWpPaths` in both versions), `wpInfo.configs.defines`
    (`value`, `inWpConfig`), `wpInfo.plugins` (`active`, `mustUse`, `dropIns`), `wpInfo.themes`,
    `dbInfo.triggerList`, `viewCount`, `procCount`, `funcCount`.
  - The plugin's own records, as its installer leaves them on a new site (`DbCleanup.php`, and
    `duplicatorMigrationInfoSet` and `forceLogoutOfAllUsers` in `class.ctrl.s3.funcs.php`); the
    panel does the same (`duplicatorAfterInstall`). The dump is taken in the middle of the package's
    own build, so its row is there at status 20, exporting the database: left in place, the plugin
    calls that build failed. Both versions: every transient and every user's `session_tokens` go,
    and archive.txt's `opts_delete`. 5.x: the tables `duplicator_backups` and
    `duplicator_activity_logs` are emptied, the options `dupli_opt_plugin_data_stats` and
    `dupli_opt_unique_id` deleted, and `dupli_opt_first_login_after_install` (`1`) and
    `dupli_opt_migration_data` (MigrateData's fields as JSON, `InstState::getMigrationData`) written
    last. At the first administrator login `MigrationMng.php` reads them, finishes the move and
    says so. The settings are encrypted with `DUPLICATOR_AUTH_KEY`, or the older `DUP_SECURE_KEY`,
    from wp-config.php (`CryptBlowfish.php`); the installer keeps the old wp-config.php and so the
    key. The panel reads it from `source_site_wpconfig`, which archive.txt's `defines` leave out.
    Only a new install writes a key (`initSecureKey` in `UpgradeFunctions.php`): with none, the
    plugin uses the md5 of `AUTH_KEY`, `DB_HOST`, `DB_NAME` and `DB_USER` (`getLegacyKey`), as a site
    that has had it since 1.x does. Those four differ on a new site, so the panel works that key out
    from the old wp-config.php and writes it as `DUPLICATOR_AUTH_KEY`.
    1.x: `duplicator_packages`, `duplicator_plugin_data_stats`,
    `duplicator_first_login_after_install` and `duplicator_migration_data` (an array with `time`,
    `getMigrationData` in `class.installer.state.php`); no key. `opts_delete` is a JSON string there.
    Duplicator Pro's names were not read: its packages (`dup_type` `pro`) are left as they came.
  - DupArchive: `<A><V>` then `<C>` before 5.0.0, `<X>` flags and `<P>` password hash from 5.0.0; a
    file's own `<X>` flags from 5.0.0; every glob with its CRC-32 (`hash('crc32b')`, so eight hex
    digits), of the stored bytes before 5.0.0 and of the content since; each file's own CRC-32 of
    its content, taken before it is read in, or 32 zeros past 100 MiB. A file that changed between
    the two does not match: Duplicator's installer notes it and goes on (`validateExpandedFile`); the index file `__dup__archive__index.json` never compressed, its
    `extraPos` where the installer's files start.
- **Check:** the version of
  `https://downloads.wordpress.org/plugin/duplicator.latest-stable.zip`. For a newer one, compare
  with the last: `installer/dup-installer/src/Package/InstallerDescriptors.php`,
  `src/Package/Database/Dump/DumpFileMap.php`, `src/Package/Archive/PackageArchive.php`
  (`getDefaultGlobalFileFilter` and the config files after it), `src/Package/Create/PackInstaller.php`
  (`createArchiveConfigFile`, `getWpInfo`), `src/Package/Database/` (`DatabaseInfo.php`'s triggers,
  `Dump/PhpDumpEngine.php`, `Dump/TableDumpWriter.php`, the mysqldump flags in `DatabasePkg.php`) and
  `src/Libs/DupArchive/` (`DUPARCHIVE_VERSION`, the headers, `DupArchiveFileProcessor.php`'s globs),
  and for the plugin's records `installer/dup-installer/src/Core/Deploy/Database/DbCleanup.php`,
  `installer/dup-installer/ctrls/classes/class.ctrl.s3.funcs.php`,
  `installer/dup-installer/src/Core/InstState.php` (`getMigrationData`),
  `installer/dup-installer/src/Models/MigrateData.php`, `src/Core/MigrationMng.php` and
  `src/Utils/Crypt/CryptBlowfish.php`. Then build a `.zip` and a `.daf` package with it on any WordPress (**Duplicator →
  Settings → Backups → Archive engine**) and run the end-to-end test on them.
- **When it changes:** a moved or renamed file goes into the patterns in
  `panel/src/services/duplicator.ts`; a new DupArchive header into `panel/src/lib/dupArchive.ts`; a
  field into `descriptorSchema`. Triggers in the dump: they would load with the rows, before the
  address rewrite fires them, so take them out there and keep adding them last. A `SET NAMES` of
  its own in the dump: it wins over `packageDumpPreamble`'s. A new mysqldump character set flag, or
  one gone: `packageCharset`. Add the layout to `panel/test/duplicatorFixtures.ts` and run the
  unit and end-to-end tests. Until then the panel refuses such a package and says why. A renamed
  table, option or key constant of the plugin's, or a field its first login reads: `duplicatorAfterInstall`.
  Then make a site from a package and log in to it: the first login should end on Duplicator's
  own message, with no notice of settings reset or a failed backup.

## MariaDB: MySQL 8's collations

- **Priority:** Medium
- **Last checked:** 2026-11-24 08:46 UTC. MariaDB 11.4.13 knows MySQL 8.0's 44 `utf8mb4_*0900_*`
  collations: the root four, and twenty languages in `ai_ci` and `as_cs`. Their `WEIGHT_STRING` is the
  same as that of the `utf8mb4_uca1400_[<language>_]nopad_*` collation they are mapped to, and like
  MySQL's they pad no spaces. 11.4.4 has none of them, but every `uca1400` `nopad` collation, `ai`/`as`
  and `ci`/`cs`, in the same twenty languages. MySQL 8.0.30's later languages (`ru`, `nb`, `ja`, …) are
  in neither.
- **The problem:** a dump from MySQL 8 names these collations. A server before 11.4.5, which an install
  that never pulled its MariaDB again still runs, refuses the tables, and one mapped to a collation that
  compares less strictly (case-insensitive for `as_cs`, padded for any of them) makes two values one:
  a unique key keeps only the first, and Duplicator's dumps load with `INSERT IGNORE`.
- **What we do about it:** `replaceCollations` in `panel/src/services/importSql.ts`, for packages, the
  import's pull and backups of sites hosted elsewhere: the same strength and no padding, the language's
  own rules where MariaDB has them, the accent-sensitive root order where it does not.
  `test/unit/importSql.test.ts` pins the names. No MariaDB collation is UCA 9.0, MySQL 8's: UCA 14.0
  counts some characters Unicode added since alike with what they decompose to (`㋿` and `令和`), so
  rows always load with a plain `INSERT` (packages lose their `INSERT IGNORE`): such a pair fails the
  load, and the job says to change one of the rows.
- **Check:** on the compose file's MariaDB and on `mariadb:11.4.4`:
  `SELECT COLLATION_NAME FROM information_schema.COLLATIONS WHERE COLLATION_NAME LIKE 'utf8mb4%0900%'`,
  the `uca1400` `nopad` names, and `WEIGHT_STRING` of a few strings under a `0900` collation and its
  mapped one.
- **When it changes:** once every supported MariaDB has the `0900` names, leave them as they are and drop
  the mapping. A language MariaDB gains goes into `UCA1400_LANGUAGES`.

## WordPress's incompatible SQL modes, as a package's triggers run in them

- **Priority:** Low
- **Last checked:** 2026-11-24 10:31 UTC. `wpdb::$incompatible_modes` in `src/wp-includes/class-wpdb.php` is
  `NO_ZERO_DATE`, `ONLY_FULL_GROUP_BY`, `STRICT_TRANS_TABLES`, `STRICT_ALL_TABLES`, `TRADITIONAL` and
  `ANSI` in WordPress 6.9.9, 7.0.6 and 7.1.5; trunk (last changed 2026-10-28) adds
  `NO_BACKSLASH_ESCAPES`.
- **The problem:** a trigger keeps the SQL mode it was made in, and Duplicator does not record it.
  New site adds a package's triggers in the mode WordPress gives its own queries: the server's, without
  the modes wpdb takes out. That is the mode a plugin's trigger was made in, and the one in which a
  wrong guess makes no write fail.
- **What we do about it:** `WORDPRESS_INCOMPATIBLE_MODES` and `TRIGGER_PREAMBLE` in
  `panel/src/jobs/handlers/sitePackage.ts` copy trunk's list.
- **Check:** `gh api repos/WordPress/wordpress-develop/contents/src/wp-includes/class-wpdb.php --jq
  .content | base64 -d | sed -n '/incompatible_modes = array(/,/);/p'`, for trunk and the latest release.
- **When it changes:** copy the list. A mode taken back out of it stays out of the panel's copy until a
  release has done so.

## MariaDB's keywords and functions, as a trigger's words are read

- **Priority:** Low
- **Last checked:** 2026-11-24 11:54 UTC. MariaDB 11.4.13 lists 699 words in `information_schema.KEYWORDS` and 268
  in `information_schema.SQL_FUNCTIONS`; the spatial functions (`ST_Distance` and the like) are in
  neither.
- **The problem:** New site adds a package's trigger only when every word of it is accounted for
  (`panel/src/services/packageTriggers.ts`): a keyword or function of MariaDB's, or a name of the
  site's database. A keyword or function MariaDB adds is an unknown name until the list has it, and a
  trigger that uses it is left out and named.
- **What we do about it:** `panel/src/lib/mariadbWords.ts` is the two tables of the compose file's
  MariaDB, written out.
- **Check:** on the compose file's MariaDB, `SELECT WORD FROM information_schema.KEYWORDS ORDER BY
  WORD` and `SELECT FUNCTION FROM information_schema.SQL_FUNCTIONS ORDER BY FUNCTION`, against the file.
- **When it changes:** write the file again from the two tables. Left out, a word only makes a
  trigger that uses it stay out: nothing breaks.

## MCP: no way to hand a tool a file

- **Priority:** Low
- **Last checked:** 2026-11-25 18:17 UTC. File transfer is not in the MCP specification. The working
  group's draft extension, `io.modelcontextprotocol/files` in
  [modelcontextprotocol/experimental-ext-file-uploads](https://github.com/modelcontextprotocol/experimental-ext-file-uploads),
  was announced on the MCP blog on 2026-11-10 and last changed on 2026-11-09. It says "Status: Draft",
  has no reference implementation, and names no app that supports it. The blog expects it to be
  stable by the end of 2026.
- **The problem:** an MCP tool's arguments are written by the model, so a file can only reach a tool
  as text the model writes out. A zip or an image costs a token every few characters of its base64,
  and past a few hundred kilobytes it does not fit in a call at all.
- **What we do about it:** `wpl7_upload_site_file` (`panel/src/mcp/tools.ts`) takes a file up to
  1 MiB as base64, or answers with a curl command and a one-time upload link
  (`panel/src/services/uploadLinks.ts`, `PUT /api/file-uploads`) for a file on the app's own disk.
  The link takes one file, named by its size and SHA-256, so the bytes never pass through the model.
  It needs an app whose shell can reach the panel, such as Claude Code, or claude.ai's code sandbox
  once its network settings allow the panel's domain.
- **Check:** the extension's repository: `gh api 'repos/modelcontextprotocol/experimental-ext-file-uploads/commits?per_page=5'`
  and its `specification/` folder for a version that is no longer a draft. The MCP blog and
  specification changelog for the extension being made official. Whether Claude (claude.ai, the
  desktop app, Claude Code) or ChatGPT say they support it.
- **When it changes:** once it is stable and an app the panel's users connect supports it, give
  `wpl7_upload_site_file` a file argument marked `x-mcp-file` for clients that declare the extension,
  and answer its `upload_required` with an upload link as the target. The app then sends the file
  itself, from a file picker or its sandbox. Keep base64 and the curl command for apps without it.

## CI: the Web FTP scripts' tests, on the site image's Debian

- **Priority:** Low
- **Last checked:** 2026-11-26 09:05 UTC. `wordpress:php8.4-fpm`, which `deploy/wordpress-image` builds on, is
  Debian 13.8 with GNU coreutils 9.7, findutils 4.10.0 and dash. `node:22-trixie` is Debian 13.8 with
  the same coreutils. `ubuntu-latest` is the `ubuntu-26.04` runner image, whose `head` is
  `uutils coreutils 0.10.0`.
- **The problem:** `panel/test/unit/siteFilesScripts.test.ts` runs the Web FTP scripts for real
  only on GNU tools, as the site's container has them, and skips those tests elsewhere. Once
  `ubuntu-latest` moved to Ubuntu 26.04 and its Rust coreutils, the main test job skipped 43 of the
  file's 47 tests and still passed.
- **What we do about it:** the `scripts` job in `.github/workflows/test.yml` runs the file in
  `node:22-trixie`, the Debian release of the site image's base, as the `node` user.
  `WPL7_SCRIPT_TESTS=required` makes a missing tool, or running as root, a failure there.
- **Check:** `docker run --rm --entrypoint sh wordpress:php8.4-fpm -c 'cat /etc/debian_version;
  head --version | head -1'`, and the same in the `scripts` job's image. In a recent pull request's
  run, the `scripts` job ran the file with nothing skipped.
- **When it changes:** when the WordPress image moves to another Debian release, move the job to the
  node image of that release (`node:22-<codename>`), in the same pull request as the site image if
  it can be.

