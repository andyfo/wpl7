# Documentation site: build plan

A public documentation site for WPL7, served as static HTML from the `/docs` folder of the
wpl7.com WordPress site, built from Markdown in this repository, with screenshots generated
from a seeded demo of the panel, and kept in step with the code by checks that fire when the
code changes. This file is the hand-over to the agents who build it: decisions, structure,
style, tooling, pipeline, and the work split into pull requests with acceptance criteria.

Written 2026-10-05 against `main` at b0bca74 (panel 0.3.0-beta.1). Where the plan says "today",
it means that commit.

**Status, 2026-10-05:** built. The eight decisions of [§10](#10-open-decisions-for-the-user)
were taken as recommended. Where the build differs from this plan, [§11](#11-as-built) says how
and why. WP9 waits for the first publish.

---

## 0. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| Generator | **Astro Starlight** (`@astrojs/starlight` 0.42.x on Astro 7.3.x), output = plain HTML/CSS/JS | Static output we host ourselves (Mintlify is hosted-only); sidebar, right-hand TOC, prev/next, dark mode, Pagefind search and component overrides come built in; same Node toolchain as `panel/` |
| Where the source lives | `docs/site/` in this repository (`src/content/docs/**` Markdown/MDX, one folder per sidebar group) | Docs change in the same PR as the code, so CI can hold a PR to its docs ([§7](#7-docs-signals-keeping-the-docs-in-step-with-the-code)) |
| Public URL | `https://wpl7.com/docs/`, pages as `/docs/<group>/<page>/` (`base: '/docs'`, `trailingSlash: 'always'`, `build.format: 'directory'`) | A physical `/docs` directory wins over WordPress's rewrite rules on Apache, LiteSpeed and nginx alike; every page is a folder with an `index.html` |
| Search | **Pagefind**, client-side, bundled by Starlight (⌘K). Nothing in WordPress or PHP | Index is built at build time and fetched in chunks (about 100 kB for a site this size); no server, no database, no third-party service |
| Header | Wordmark (links to `https://wpl7.com/`), a "Docs" label (links to `/docs/`), search, GitHub icon, **Download** button | The user's spec. Download points where the marketing site's main call to action points, default `https://github.com/andyfo/wpl7/releases/latest` |
| Publishing | GitHub Action on every merge to `main` that touches the docs or their sources, and on every published release: build → validate → `rsync` over SSH to the website host's `/docs` directory → smoke test | Push on change, as asked; the SSH-with-pinned-host-key pattern already exists in `deploy.yml` |
| Docs ↔ release drift | Publish from `main`; a page or section newer than the latest release carries an **Edge** badge from a `since:` front-matter field; the release trigger republishes and the badges fall away | One site, immediate publishing, honest labelling |
| Screenshots | Playwright against a seeded in-process **demo world** (the test suite's `makeWorld()` with the real routes, fake Docker), 1440×900 at 2× (2880×1800 PNG), light for every shot and dark for a hero set, generated on the CI runner and committed | Never a real install (public-project rule), deterministic, regenerated when the UI changes |
| Marketing screenshots | Same pipeline; published at stable URLs under `/docs/screens/` | One deploy target; the marketing site embeds them directly |
| Keeping docs current | `@docs <slug>` markers in code + `sources:` globs in page front matter → a `docs-sync` check on every PR that names the affected pages and fails until they change or the PR says `Docs: not needed — <reason>`; reference pages generated from `panel/shared/*` with a drift check; screenshots regenerated on `panel/web/**` changes | The "signals" the user asked for, enforced by CI rather than remembered |
| Vocabulary | The panel's words: **Sites** (not "websites"), **Servers**, **Automations**, **Integrations**; US spelling | Readers look for what they see in the panel |
| The Markdown in `docs/*.md` | Migrated into the site; the files stay as one-line pointers for one release, then go. `development.md`, `local-dev.md` and `internal/` stay in the repository | Two copies drift; contributors' docs belong next to the code |
| Analytics | None | The product promises no third-party calls; the docs keep the same stance. Fonts and search are self-hosted |

Open points for the user are collected in [§10](#10-open-decisions-for-the-user); each has a
recommendation, and the plan is written as if the recommendations stand.

---

## 1. Goals and non-goals

**Goals**

1. A reader who has a server and no panel gets to a running site in ten minutes without leaving
   the Get started group.
2. Every feature of the panel has a page that says what it is, where it is in the UI, how to use
   it, what happens, and what its limits are, in that order.
3. Every page links to the pages it depends on and the ones that depend on it. No dead ends, no
   dead links: the build fails on a broken internal link or anchor.
4. The docs look like the panel: same wordmark, same typeface, same accent, light and dark.
5. The docs cannot silently fall behind the code: a change to a documented area holds its PR until
   the docs move too; reference tables are generated; screenshots regenerate.
6. The output is static files that work as-is under `wpl7.com/docs/`, and publish themselves.

**Non-goals (for the first release of the site)**

- Translations. Starlight supports them; the content is English only until the panel is.
- Versioned docs (one site per release). The `since` badge covers the gap; revisit if the stable
  and edge channels diverge for long.
- A hosted search service, comments, feedback widgets, or anything that needs WordPress code.
  The site stays dependency-free; [§6.5](#65-later-optional-wordpress-side-augmentation) lists
  what WordPress could add later.
- Documentation of the code for contributors. That stays in `docs/development.md`,
  `docs/local-dev.md` and `CONTRIBUTING.md`; the site links to them.

---

## 2. What exists today (inputs)

- **22 Markdown files, 6,480 lines, in `docs/`** (`docs/README.md` is the index). They are
  precise, explanatory and operator-oriented, written as "why" as much as "how". They are the
  raw material; they are not the shape of the site. The migration map is in
  [Appendix A](#appendix-a-migration-map).
- **The panel's navigation** (`panel/web/src/components/Layout.tsx`): Dashboard (page title
  "Overview"); Sites → All sites, Bulk management, Security; Servers → All servers, Terminal,
  Security; Plugins → All plugins, Recipes; Backups → All backups, Storage; Mail; Automations →
  All jobs, Schedules; Integrations → API keys, MCP; Users; Settings (tabs Sites, Backups,
  Security, Mail, DNS, Monitoring, Updates); and at the foot an Appearance group with the theme
  and accent picker, Support, About and the WP Godmode page. A site's page has the tabs
  Overview, Visitors, Backups, WordPress, Files, FTP, Security, Settings. The Sites list shows
  Site, Status, Mode, Server (on fleets), PHP, Updates, Visitors (24 h), Disk, Created.
- **A machine-readable API catalog**, `panel/shared/apiDocs.ts`: every endpoint with method,
  path, one-line summary, input, returns, access level, danger and MCP reachability, in 20
  groups. `test/unit/apiDocs.test.ts` checks it against Fastify's route table both ways. The
  panel renders it as **Integrations → API keys → Docs** and the MCP server answers
  `wpl7_api_docs` from it. The site's API reference is generated from it, not written.
- **Other single sources of truth** worth generating from: `panel/shared/access.ts` (key
  levels), `panel/shared/security.ts` (`LEVEL_PRESETS`), `panel/shared/jobTypes.ts`,
  `panel/src/mcp/tools.ts` (tool names and descriptions), `deploy/.env.example` (every
  variable with its comment), `install.sh` and `provision/setup.sh` (flags).
- **The fake world** in `panel/test/helpers.ts`: `makeWorld()` builds the real services over
  in-memory SQLite with a fake Docker, fake host exec, fake DNS and fake remote servers
  (`addSshServer`, already using documentation-range addresses such as `203.0.113.9`);
  `buildServer(world.deps, { webDist })` serves the real routes. Previous screenshot sessions
  used exactly this as an ad-hoc demo API (never committed). The lessons from those sessions
  are folded into [§8](#8-screenshots).
- **The brand**: the wordmark is text, `WP` + `L7`, all weight 750, `L7` painted with a
  theme-accent gradient and a sheen that sweeps once on load and on hover (`.brand-name`,
  `.brand-name-accent` in `panel/web/src/styles.css`). No icon, no tagline. Inter is
  self-hosted (`panel/web/src/fonts/inter-{latin,latin-ext}.woff2`, variable weight, woff2
  only), and the favicon is an `L7` tile in a fixed `#315fc5`. Light accent `#315fc5`, dark
  accent `#9bb7ff`; neutrals `--n50…--n900` in both schemes.
- **CI**: `deploy.yml` tests every PR (`test.yml`), and on `main` builds the `edge` images,
  recreates the `edge` release and deploys over SSH with a pinned host key; `release.yml` does the
  same for a `v*` tag. Node 22 on the runners (`.github/actions/panel-deps`). PR titles are
  release-note lines, grouped by the labels `breaking`, `feature`, `fix`, `docs`, `internal`.
  The PR template's checklist has "`docs/` updated if behaviour changed".
- **Links to update at launch**: the README links `docs/*.md` in about 25 places; the panel
  itself has no links to the Markdown docs. `WPL7_COMMUNITY_URL` (default
  `https://wpl7.com/community`) and the Enterprise link (`https://wpl7.com/enterprise/`) are
  the only wpl7.com addresses in the code.

---

## 3. What we take from the best docs sites

Looked at for this plan: Conductor (Mintlify), Cursor (Mintlify, with `llms.txt` and a `.md`
twin for every page), Coolify (VitePress), SpinupWP (help-center style), plus the patterns of
Stripe, Docker and the Diátaxis framework.

| Pattern | Seen at | What we do |
|---|---|---|
| **Introduction → Get started → feature groups → Reference**, top to bottom | Conductor, Cursor, Coolify | Same spine ([§4](#4-information-architecture)) |
| A short "Start here" group: one page to understand, one to install, one tutorial | Cursor ("Start here"), Coolify ("Get started") | Introduction, Quick start, Installation, Your first site, How WPL7 works |
| Groups named after what the user does or sees, not after code | Cursor ("What you can do with Cursor"), SpinupWP (Servers, Sites) | Groups follow the panel's sidebar |
| Concepts separated from tasks | Coolify ("Knowledge base"), Diátaxis (explanation vs how-to) | One concepts page per group where the "why" needs room; task pages stay short and link to it |
| Reference generated, not typed | Stripe, Cursor's OpenAPI | API, MCP tools, env variables, job types, levels: all generated from `panel/shared` and `deploy/` |
| `title` + one-line `description` on every page, shown under the title and used by search and cards | Mintlify sites | Required front matter; the description is the sentence the page would be found by |
| Header with logo, search, GitHub, a primary button | Cursor (Download), Coolify (GitHub, Discord) | Exactly the user's spec |
| Right-hand table of contents, prev/next at the foot, "Edit this page", last updated | All of them | Starlight defaults, switched on |
| `llms.txt` and Markdown twins for AI readers | Cursor | `starlight-llms-txt`: `/docs/llms.txt`, `llms-full.txt`, `llms-small.txt`. Relevant to a product whose users connect AI apps over MCP |
| Question-shaped troubleshooting headings | SpinupWP, GitHub Docs | Troubleshooting entries are the symptom as the reader would say it ("wp_mail() sends nothing") |
| A "Related" footer on every page | Stripe, Tailscale | Mandatory; it is how "fully self-linked" is enforced beyond the sidebar |
| Screenshots in the product's own light and dark themes, no device frames baked in | Linear, Cursor | The `<Screenshot>` component draws the frame; the PNG is the bare viewport |

---

## 4. Information architecture

Slugs are final URLs under `/docs/`; renaming later means an entry in Astro's `redirects`.
Sidebar labels equal page titles unless noted. Groups are in sidebar order. Pages marked
*(generated)* are produced by scripts ([§7.3](#73-generated-reference-pages)).

### Get started · `get-started/`

| Slug | Title | What it covers | Source material |
|---|---|---|---|
| `/docs/` | **Introduction** | What WPL7 is in one sentence; hero screenshot; who it is for; what you get (eight bullets, one per group, each linking); how it works (the README's diagram, redrawn); what leaves your server (the privacy list from the README) | README |
| `quick-start` | **Quick start** | Ten minutes: what you need → 1 DNS → 2 Install → 3 Sign in → 4 Create a site → 5 Before real traffic (mail relay, Cloudflare token, alert address). Five steps, five lines each | README, install.md |
| `installation` | **Installation** | Requirements and providers; the two DNS records; the install command and reading it first; every flag; what the installer changes on the machine; first login; from a checkout instead; adding a second server (pointer) | install.md, scripts.md |
| `first-site` | **Your first site** | Tutorial: create a site in the wizard → watch the job → open the dev URL → one-click WordPress login → go live on a customer domain → what changed | site-lifecycle.md, dns.md |
| `how-it-works` | **How WPL7 works** | One container per site (PHP version, own network, own database), Traefik and certificates, dev domain vs live domain, the panel and its state, jobs, servers and workers, the edge and stable channels, where things are on disk (pointer to Architecture) | architecture.md, updating.md |

### Sites · `sites/`

| Slug | Title | What it covers |
|---|---|---|
| `overview` | **The Sites list** | Columns, status vs health, search, selection for bulk actions; the site page and its tabs |
| `create` | **Create a site** | The New site wizard: title and slug, PHP version, server, plugins, recipes, admin account and email (defaults from Settings → Sites); the `site.create` job |
| `domains` | **Domains and going live** | The dev domain; **Go live** with zero downtime; the DNS records a customer domain needs; certificates (per site or wildcard); what a URL change re-runs (recipes); changing the domain again |
| `wordpress` | **Manage WordPress** | The WordPress tab: one-click admin login, password resets, maintenance mode, the WP-CLI console, plugin and theme changes on one site |
| `files` | **Files** | The Files tab (Web FTP): browse, edit (PHP check, no overwriting a colleague's change), upload any size, download, zip and unzip, search by name or content, who changed what, limits, why it runs as the site's user |
| `ftp-sftp` | **FTP and SFTP logins** | Add a login, connect (FileZilla settings), what a login reaches and why no more, change and remove, what happens during restores, moves and deletes, settings and logs |
| `visitors` | **Visitor statistics** | Visitors, pages, referrers, countries; crawlers kept apart; the busiest-addresses list and switching it off; why no cookie banner |
| `settings` | **Site settings** | PHP switch, CPU/memory/process limits (applied live), stop and start, recreate container, delete (and taking the backups along) |
| `move` | **Move a site to another server** | Prerequisites, what moves, forwarding until DNS catches up, finalize, failure and recovery |
| `bulk` | **Bulk management** | Select many sites: updates, vulnerabilities, bulk runs as one tracked batch, backup first, health check after, the safety rules, recent runs |

### Servers · `servers/`

| Slug | Title | What it covers |
|---|---|---|
| `overview` | **Servers and monitoring** | The fleet list; uptime, CPU, RAM and disk; the server page (Machine, Configuration); alerts (Settings → Monitoring) |
| `add` | **Add a server** | Blank VPS over SSH (recommended) vs already provisioned; the worker role; DNS for the new server; updating workers |
| `terminal` | **Terminal** | The web terminal on any server; what it is for; limits |
| `resources` | **Disk, logs and housekeeping** | Where disk goes, log locations, the housekeeping job, the firewall helper (from operations.md) |

### Plugins · `plugins/`

| Slug | Title | What it covers |
|---|---|---|
| `overview` | **Plugins across your sites** | The inventory: every plugin, theme and WordPress version on every server; the snapshot and when it refreshes |
| `catalog` | **The plugin catalog** | Add from wordpress.org, upload a zip, default plugins for new sites, removing from the catalog, how zips are checked |
| `updates` | **Updates and known vulnerabilities** | The wpvulnerability.net feed (what leaves the box, switching it off), ratings, updating one or many, backup first and health check, update schedules |
| `recipes` | **Recipes and pro-plugin licenses** | What a recipe does and when it runs (install, go-live, delete); the bundled ACF PRO and Breakdance recipes; the signed public catalog; a local recipe; where keys live; status words on the site page; writing a recipe (link to Reference) |

### Backups · `backups/`

| Slug | Title | What it covers |
|---|---|---|
| `overview` | **How backups work** | What a backup contains, types and retention, schedules, on demand, finding one, backups of deleted sites, on a fleet |
| `restore` | **Restore and download** | Restore in place, download, what a restore does to logins and jobs, manual restore without the panel (pointer to Reference) |
| `storage` | **Backup storage** | Per-server location, moving the backup root, disk |
| `offsite` | **Offsite copies** | Destinations (S3 and compatible vendors, SFTP, FTP/FTPS, WebDAV), test connection, remote layout, encryption (why it is immutable), retention, fetch back, failures, the panel's own state |
| `delete` | **Delete backups** | One, several, all of a site; what deleting a site does with its backups |

### Mail · `mail/`

| Slug | Title | What it covers |
|---|---|---|
| `overview` | **How mail works** | The per-server relay, DKIM, per-site credentials, direct delivery vs smarthost, what the Mail page shows |
| `setup` | **Setup guide** | SPF, DKIM, DMARC and reverse DNS checked against live DNS; letting the panel publish the records; the mail hostname and its default; what cannot be automated; test message |
| `traffic` | **Traffic and queue** | Every message, volume by site, the queue, suspension (the abuse guard) and lifting it |
| `records` | **SPF, DKIM and DMARC explained** | The three records, one section each (concept page) |

### Security · `security/`

| Slug | Title | What it covers |
|---|---|---|
| `overview` | **Security in WPL7** | The three layers (site protection, blocked addresses, malware scans) and the isolation model: one compromised site stays one compromised site; what is and is not contained |
| `site-protection` | **Site protection** | Levels (Standard, Strict), what each refuses and limits, rate limits and login limits, the fleet default and a site's own settings (the sheet), visitors behind a proxy, how rules are applied, the known limit on bursts |
| `blocked-addresses` | **Blocked addresses** | Detection, the fleet block list at the firewall, who is never blocked (search engines verified by DNS, AI assistants, Cloudflare and Jetpack ranges), unblocking, Servers → Security |
| `malware-scans` | **Malware scans** | The daily scan, wordpress.org checksums, what a scan says, findings and what to do, quarantine and put-back, plugins vouched by the catalog, false positives, alerts, what the scanner is not asked to say |
| `accounts` | **Accounts and access to the panel** | Owner and admins, two-factor authentication, password reset by email, recovery when locked out, API keys as a separate credential, sessions and login limits |
| `privacy` | **What leaves your server** | The complete list of outbound calls (GitHub, wpvulnerability.net, wordpress.org, registries, published address lists, DNS lookups) and the switch for each |

### Automations · `automations/`

| Slug | Title | What it covers |
|---|---|---|
| `jobs` | **Jobs** | What runs as a job, lanes, the list and its filters, progress and logs, who started it, stuck and timed-out jobs |
| `schedules` | **Schedules** | The built-in schedules, pause, run now, where each is configured |
| `custom-jobs` | **Your own scheduled jobs** | WP-CLI commands, shell as the site's user, REST requests with application passwords; from the panel and from the API |

### Integrations · `integrations/`

| Slug | Title | What it covers |
|---|---|---|
| `api` | **The REST API** | Keys and the three levels (Read only, Manage, Full), authentication, conventions, asynchronous jobs, the activity log, the test console; two worked flows (create a site and take it live; add a server and move a site) |
| `api-reference/` *(generated)* | **API reference** | One page per catalog group, every endpoint with method, path, summary, input, returns, level, danger, MCP reachability; an index page with the error codes |
| `mcp` | **AI apps over MCP** | Switch it on; connect Claude, ChatGPT, Claude Code, Cursor, VS Code by signing in (the connection window) or with a key; levels; several panels in one app; what is recorded; revoking; troubleshooting; OAuth details for client authors |
| `mcp-tools` *(generated)* | **MCP tools** | Every tool with its description and the level it needs; WP Godmode's commands |
| `dns` | **DNS and Cloudflare** | The records a panel needs; a Cloudflare API token in Settings → DNS (permissions, rotation); one wildcard certificate per server; records written for you at go-live and for mail |

### Panel · `panel/`

| Slug | Title | What it covers |
|---|---|---|
| `settings` | **Settings** | One section per tab: Sites (defaults for new sites), Backups, Security, Mail (alert address, relay), DNS, Monitoring, Updates |
| `updating` | **Updating WPL7** | Channels, the hourly check, the Update button, the health gate and rollback, `update.sh`, image mode vs checkout mode, what the panel does afterwards |
| `users` | **Users** | Add an admin, roles (owner vs admin), reset a password, two-factor; pointer to Security → Accounts |
| `appearance` | **Appearance, Support and About** | Theme and accent, the Support page (community, Enterprise package, bugs), the About page |

### Reference · `reference/`

| Slug | Title | What it covers |
|---|---|---|
| `installer-and-scripts` | **Installer and scripts** | `install.sh` flags; every `provision/*.sh` script and flag in the order you run them |
| `configuration` *(generated)* | **Configuration (`deploy/.env`)** | Every variable with its comment, grouped as the example file groups them; what is `.env` and what is a panel setting; where state lives |
| `architecture` | **Architecture** | How the pieces fit: networks, naming, filesystem, site containers, containment, TLS, panel internals |
| `job-types` *(generated)* | **Job types** | Every job type with its lane and what starts it |
| `security-levels` *(generated)* | **Protection levels and key levels** | `LEVEL_PRESETS` and the access levels as tables |
| `recipe-format` | **Recipe format** | Writing a recipe: the JSON, `inputs`, hooks, the catalog's signature |
| `manual-recovery` | **Manual recovery without the panel** | Restoring a site from a backup by hand, from a bucket, from an encrypted bucket |
| `limits` | **Known limits** | Collected from every page's "Limits" section, one list |
| `third-party` | **Third-party components** | Traefik, MariaDB, the postfix relay, SFTPGo, AMWScan, Inter, with versions and licenses |
| `glossary` | **Glossary** | Every term in [Appendix B](#appendix-b-glossary-seed), one line each, linked from pages |

### Help · `help/`

| Slug | Title | What it covers |
|---|---|---|
| `troubleshooting` | **Troubleshooting** | Every entry of troubleshooting.md, grouped by area (Sites, Certificates, Mail, Backups, Jobs, Accounts, FTP, Security, Updates), symptom-shaped headings |
| `faq` | **FAQ** | Twenty questions a prospect asks before installing (ARM? how many sites per server? can I move away later? what does it cost? what phones home?) |
| `support` | **Support** | Community, the Enterprise package, reporting a bug, security reports (`SECURITY.md`) |
| `changelog` *(generated)* | **Changelog** | Release notes from GitHub releases, newest first; the edge channel explained |
| `contributing` | **Contributing** | Pointer page: `CONTRIBUTING.md`, `docs/development.md`, `docs/local-dev.md`, the CLA |

About 60 pages. Starlight's `sidebar` uses `autogenerate` per group directory with
`sidebar.order` in front matter; groups after Get started are `collapsed: true` except the one
containing the current page (Starlight does this).

### Cross-linking rules

- Every page ends with a **Related** list of two to six links: the concept page for its group,
  the task pages it depends on, the reference it draws on.
- A feature that lives in two UI places (security on a site and on the fleet; backups on a
  site and in All backups) has one page and is linked from both the other pages' Related lists.
- UI locations are written as paths in bold with arrows: **Sites → Security → Settings**. A
  path always links to the page that documents its last element.
- The first use of a glossary term on a page links to the glossary entry.
- The links validator (`starlight-links-validator`) fails the build on a broken internal link
  or missing anchor; `#fragment` links are checked too.

---

## 5. Page anatomy and style

### 5.1 Front matter

```yaml
---
title: Go live on a domain              # sentence case, a task or a thing, ≤ 40 characters
description: Move a site from its dev address to the customer's domain with no downtime.
sidebar:
  order: 3                              # position in its group
  label: Domains and going live         # only when it should differ from the title
since: 0.4.0                            # optional: first release with this feature → Edge badge
sources:                                # repo globs this page documents (see §7)
  - panel/src/routes/sites.ts
  - panel/src/services/goLive*.ts
  - panel/web/src/pages/SiteDetail.tsx
---
```

`title` and `description` are mandatory; the build fails without them. `description` is one
sentence, the one a reader would search for; it shows under the title and in link cards.

### 5.2 Page template (how-to pages)

```markdown
One or two sentences: what this is and what it is for.          ← no heading

<Screenshot name="site-go-live" alt="The Go live dialog with a domain filled in" />

## Before you start                                               ← only if there are preconditions
- DNS access for the customer's domain.

## Go live
1. Open the site and choose **Go live**.
2. Enter the domain. The panel checks its DNS and says what is missing.
3. Confirm. The site answers on both addresses until you remove the old one.

## What happens
Three to six sentences, or a short list: the job that runs, what changes on disk and in DNS,
what is re-run (recipes), how long it takes.

## Limits
- One domain per site. Aliases redirect.

## Related
- [Your first site](/docs/get-started/first-site/)
- [DNS and Cloudflare](/docs/integrations/dns/)
```

Concept pages (How it works, Security in WPL7, SPF/DKIM/DMARC explained) replace the task
sections with prose under two to five headings, and still end with Related. Reference pages
are tables.

### 5.3 Writing rules

These are the user's rules for UI copy, applied to prose. They are checked in review, not
negotiable.

- **Short.** A how-to page is 150–500 words plus one or two screenshots. If it is longer, split
  it or move the "why" into the group's concept page. The Markdown docs are the material, not
  the length.
- **One idea per sentence**, around 20 words, with a verb. No semicolons joining clauses, no
  parentheses, no em dashes, no arrows in prose (arrows are for UI paths only).
- **Plain words.** No marketing adjectives ("powerful", "seamless", "robust"), no
  "simply", no "just", no "AI word spill": a feature is named, placed and explained, not
  praised. Say a dependency in one sentence.
- **The UI's words, exactly**, in bold: **Go live**, **Bulk management**, **Add server**.
  Never invent a label. If a label is wrong, fix the panel, not the docs.
- **Tasks are headings**: "Add a login", not "Logins". Headings are sentence case.
- **Code is code**: commands, file paths, flags, environment variables and API paths in
  backticks or fenced blocks with a language. A command the reader will paste gets its own
  block and nothing else in it.
- **Numbers in tables or on their own line**, not woven into sentences.
- **Public-project rule.** Example domains only: `panel.example.com`, `dev.example.com`,
  `<slug>.dev.example.com`, customer domains under the reserved `.example` TLD. IPs from the
  documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`. No real installation,
  server name, person or incident, ever, in text or screenshots.
- **Honest about limits.** Every feature page has a Limits section, even if it is one line.
  What is not contained, not automated or not supported is said, not implied. Do not describe
  a behaviour without reading the code or the test that pins it.
- **US spelling** (color, license, catalog), matching the UI.
- **Callouts** (`:::note`, `:::tip`, `:::caution`, `:::danger`) at most two per page.
  `:::danger` only for data loss.
- **Versions** are stated as "since 0.4.0" via the `since` field or the `<Since v="0.4.0" />`
  inline component, never in prose.

### 5.4 Components available to writers

Built by WP1 ([§9](#9-work-packages)), documented in `docs/site/README.md`:

| Component | Use |
|---|---|
| `<Screenshot name alt caption? dark?>` | A screenshot from `screens/`: emits `<picture>` with WebP and PNG, light and dark variants switched by the theme, a CSS frame (rounded corners, soft shadow), zoom on click (`starlight-image-zoom`) |
| `<Since v="0.4.0" />` | Inline badge; renders "Edge" while `v` is newer than the latest release, then "Since 0.4.0" |
| `<UiPath>Sites → Security → Settings</UiPath>` | Bold path, last element linked; the docs-sync label check reads these |
| Starlight's `Steps`, `Tabs`, `Card`, `LinkCard`, `Aside`, `FileTree`, `Badge` | As Starlight documents them |

---

## 6. The site shell and its hosting

### 6.1 Header

Left to right: the **wordmark** (text, the panel's own `.brand-name` CSS with the fixed blue
accent, linking to `https://wpl7.com/`), a thin divider, **Docs** (linking to `/docs/`), then
the Pagefind **search** (⌘K / Ctrl K), the **GitHub** icon (`https://github.com/andyfo/wpl7`),
the **theme toggle**, and a filled **Download** button (`https://github.com/andyfo/wpl7/releases/latest`,
`rel="noopener"`). Below 800 px the search collapses to an icon and Download stays.

Implemented as Starlight overrides: `SiteTitle` (wordmark + Docs), `SocialIcons` (default icons
plus the button). Everything else is Starlight's own `Header`.

### 6.2 Layout

Starlight's three columns: sidebar (groups, collapsible), content (max width 60–65 rem), right
TOC (h2 and h3). Footer per page: Edit this page (GitHub), Last updated (from git), Previous
and Next. Site footer (`Footer` override): license line (AGPL-3.0), links to GitHub, Community,
Enterprise, Security policy, and a muted build id (`Built from a1b2c3d`) that the publish smoke
test reads.

### 6.3 Theme

- Inter from the same woff2 files as the panel, `font-display: swap`; `--sl-font: 'Inter'`.
- Accent scale generated from `#315fc5` (light) and `#9bb7ff` (dark) with Starlight's color
  editor; grays from the panel's neutrals so a screenshot's frame and the page agree.
- Code blocks: Expressive Code defaults with the panel's font for inline code.
- Both schemes verified with the docs' own screenshots and WCAG AA contrast.
- No icon mark anywhere. The favicon and touch icon are the panel's files.

### 6.4 Under WordPress at `/docs`

The build output is copied, as-is, to `<webroot>/docs/`. What has to be true on the host:

1. **No WordPress page, post or plugin route with the slug `docs`.** A physical directory is
   served before WordPress's rewrite rules on Apache (`RewriteCond %{REQUEST_FILENAME} !-d`),
   LiteSpeed and nginx (`try_files $uri $uri/ …`), but a WordPress page of the same name would
   confuse editors and sitemaps.
2. **Directory index** `index.html` is served and `/docs/sites/create` redirects to
   `/docs/sites/create/` (Apache `DirectorySlash On`, nginx `$uri/`). The docs' internal links
   always carry the slash.
3. **404s stay in the docs.** `docs/site/public/.htaccess` (copied into `/docs/.htaccess` on
   Apache and LiteSpeed hosts) turns the rewrite engine off for the directory, sets
   `ErrorDocument 404 /docs/404.html`, `Options -Indexes`, and cache headers. On nginx the
   equivalent goes into the server block; both snippets are kept in `docs/site/hosting/` and
   in the Reference.
4. **Cache headers**: `/docs/_astro/*` and `/docs/pagefind/*` are content-hashed →
   `Cache-Control: public, max-age=31536000, immutable`; HTML → `max-age=300`.
   `.wasm` must be served as `application/wasm` (Pagefind); modern Apache and nginx do this by
   default, and the smoke test checks it.
5. **Sitemap and robots**: Starlight emits `/docs/sitemap-index.xml` because `site` is set.
   Add `Sitemap: https://wpl7.com/docs/sitemap-index.xml` to the WordPress site's robots output
   (the SEO plugin's setting or a `robots_txt` filter). Canonical URLs come from `site` + `base`.
6. **Caches and CDNs**: WordPress page caches ignore non-PHP paths. If a CDN sits in front,
   the publish step may purge `/docs/*` later ([§6.5](#65-later-optional-wordpress-side-augmentation)).
7. **Ownership**: the `/docs` directory belongs to the deploy user the publish key logs in as;
   WordPress's PHP user needs no write access to it.

### 6.5 Later, optional: WordPress-side augmentation

Not built now; listed so nobody designs the static site around them.

- Search analytics: Pagefind can call a tiny `wp-json` endpoint with queries that returned
  nothing, so the FAQ learns what readers look for.
- "Was this page helpful?" posting to the same plugin.
- A publish receiver (`POST /wp-json/wpl7-docs/v1/publish`, HMAC-signed tarball, extracted to
  a temp directory and renamed into place) for a host without SSH. The rsync path is primary.
- A CDN purge of `/docs/*` after each publish.

---

## 7. Docs signals: keeping the docs in step with the code

The user's requirement: when something in WPL7 changes, the docs change with it. Memory is not
a mechanism, so this is five mechanisms that CI enforces, plus the rules that tell agents and
contributors what to do.

### 7.1 `@docs` markers and `sources` globs

Two directions, one map.

- **Code → page.** A comment near the thing that is documented names the page's slug:
  `// @docs sites/domains` (a route module's header, a service, a UI page or component, a
  provisioning script, a shared constant). Several slugs are comma-separated. Slugs are the
  URL path under `/docs/` without slashes at either end.
- **Page → code.** `sources:` in the page's front matter lists globs of the files it
  documents (see the example in [§5.1](#51-front-matter)).
- `npm run docs:map` (in `docs/site/`) walks both and writes `.docs-map.json` (ignored by
  git): for every page, the union of its `sources` and the files that `@docs` it. It fails
  when an `@docs` slug names no page, when a page under Sites, Servers, Plugins, Backups, Mail,
  Security, Automations, Integrations or Panel has no source at all, or when a generated page
  was hand-edited.

### 7.2 The `docs-sync` check on every pull request

In `.github/workflows/docs.yml`, job `sync`:

1. Changed files of the PR (`git diff --name-only origin/main...HEAD`) → affected pages via the
   map. Paths that affect everything (`panel/web/src/styles.css`, `Layout.tsx`) map to the
   screenshot job, not to pages.
2. If any page is affected and none of them changed in the PR, and the PR body has no line
   matching `^Docs: (not needed|n/a)\b.+` (a reason is required after it), the job fails.
   The label `no-docs-change` is the equivalent for automation.
3. Either way the job keeps one sticky comment on the PR (find-and-edit by a marker) that
   lists the affected pages with links to their source files and their public URLs, so the
   author sees what to update without asking.

The check is required on `main`. `docs/site/**`-only PRs skip it. A fork's PR gets the
comment but cannot be pushed to, so the author updates the pages themselves.

### 7.3 Generated reference pages

A script per source, all run by `npm run docs:generate`, output committed under
`src/content/docs/**` with a `<!-- generated by scripts/gen-*.ts; do not edit -->` header and
`linguist-generated` in `.gitattributes`. CI runs the generation and fails on a diff, so a
change to `panel/shared/apiDocs.ts` without regenerated pages cannot merge. Committing the
output keeps the links validator, GitHub browsing and offline builds simple.

| Script | Reads | Writes |
|---|---|---|
| `gen-api.ts` | `panel/shared/apiDocs.ts` (`API_DOC_GROUPS`, `API_DOC_RECIPES`, `API_ERROR_CODES`) | `integrations/api-reference/index.mdx` + one `.mdx` per group |
| `gen-mcp-tools.ts` | `panel/src/mcp/tools.ts` and `panel/src/mcp/call.ts` | `integrations/mcp-tools.mdx` |
| `gen-config.ts` | `deploy/.env.example` (comments + keys, in file order) | `reference/configuration.mdx` |
| `gen-job-types.ts` | `panel/shared/jobTypes.ts` | `reference/job-types.mdx` |
| `gen-levels.ts` | `panel/shared/security.ts` (`LEVEL_PRESETS`), `panel/shared/access.ts` | `reference/security-levels.mdx` |
| `gen-changelog.ts` | `src/data/releases.json`, refreshed by the publish workflow from the GitHub releases API (fails soft: keeps the last snapshot) | `help/changelog.mdx` |

Scripts import the TypeScript modules directly with `tsx` (the shared modules have no Node or
browser dependencies). Each emits deterministic output (stable ordering, no timestamps).

### 7.4 Screenshots that follow the UI

Job `screenshots` in `docs.yml` runs on PRs that touch `panel/web/**` or the demo world: it
rebuilds the demo, captures every shot, compares each with the committed one (`pixelmatch`,
threshold 0.1 % of pixels), and when any differ, commits the new files to the PR branch
("Update docs screenshots") for same-repository branches, or attaches them as an artifact and
comments for forks. Details in [§8](#8-screenshots).

### 7.5 Flags and labels, warn-only

- `check-flags.ts`: every `--flag` string in `install.sh` and `provision/setup.sh` must appear
  in `reference/installer-and-scripts.mdx`. Reported in the sticky comment, does not fail.
- `check-ui-paths.ts`: every `<UiPath>` segment and every bold `**Label**` that looks like a UI
  label must be a string literal somewhere in `panel/web/src`. Reported, does not fail: it
  catches a renamed button, which is the most common way docs rot.

### 7.6 Rules for people and agents

Changed in the same PR that adds the mechanisms (WP8):

- `CLAUDE.md`: a section "Docs follow the code": a behaviour change updates the pages its
  `@docs` markers and `sources` name, in the same PR; a new feature gets `@docs` markers and a
  page; a UI change runs the screenshot script; the writing rules are `docs/site/README.md`.
- `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`: "`docs/` updated if behaviour
  changed" becomes "The docs pages the `docs-sync` comment lists are updated, or the PR says
  `Docs: not needed — <reason>`".
- `.github/release.yml` already groups `docs`-labelled PRs; docs-only PRs use it.

### 7.7 Freshness against releases

`gen-changelog.ts` also records the tag GitHub marks **Latest** (prereleases excluded; if
there is none, nothing is "edge"). Starlight's `routeMiddleware` reads each page's `since`,
compares semver, and sets the sidebar badge **Edge** and a page banner ("Available on the
edge channel. Ships in 0.4.0.") while `since` is newer. The `release: published` trigger
republishes within minutes of a release, and the badges disappear.

---

## 8. Screenshots

### 8.1 The demo world

A committed, deterministic stand-in for a well-used installation, built on the test suite's
fake world. Nothing in it is real, and it never touches Docker, the network or disk outside a
temp directory.

- `panel/scripts/demo-world.ts`: `makeWorld()` + seeds → `buildServer(world.deps, { webDist })`
  → `app.listen(port)`. Run with `npm run demo -- --port 3999 [--web-dist ../web/dist]`.
  Lessons from earlier ad-hoc versions, now rules: it is an ESM module run with `tsx` from
  `panel/`; it signs the demo in through the real login once and the shooter reuses the
  session (the login is rate-limited to five a minute); it never starts the real dev API
  against the host's Docker.
- **Fixed clock.** The demo pins `Date.now()` to `2026-10-05T10:00:00Z` (a fake timer in the
  process) and the shooter pins the browser's clock with `page.clock.setFixedTime()` to the
  same instant, so "2 minutes ago" and absolute dates never move.
- **Stamped version.** `WPL7_VERSION=0.3.0` in the environment, so the sidebar shows a release
  number, not `-dev`.
- **Seeds**, all fictional, public-project rule applied (data sheet in
  [Appendix C](#appendix-c-demo-world-data-sheet)): three servers; twelve sites in three states
  across them (live, dev-only, stopped, maintenance mode), PHP 8.2–8.5, with visitor traffic,
  disk use, update counts and one known vulnerability; nightly and weekly backups, an encrypted
  S3-compatible destination, a deleted site whose backups remain; jobs in every state (done,
  running at 62 %, failed, queued); the built-in schedules plus one custom WP-CLI job; mail
  domains with mixed SPF/DKIM/DMARC results, 24 h of traffic, an empty queue; security findings
  (one quarantined file, one vouched renamed plugin), a block list with countries, one site with
  its own protection settings; a plugin inventory of about twenty plugins; the ACF PRO and
  Breakdance recipes with keys set; two API keys with an activity log; MCP on with two connected
  apps and recent calls; the owner and two admins, one with two-factor on.
- Each seed is a function in `panel/scripts/demo/*.ts` (sites, backups, jobs, mail, security,
  …) so a page's data can be adjusted without reading the rest. Where a service has no seeding
  path (traffic, mail log, block list), the seed goes through the same fakes the unit tests use
  (`accessLog.test.ts`, `mailLog.test.ts`, `blocklist.test.ts` show how).

### 8.2 The shooter

`docs/site/scripts/shoot.ts` (Playwright, `@playwright/test` 1.63 pinned, Chromium only):

- Builds the panel (`npm run build:web`) unless `--web-dist` is given, starts the demo world
  on a free port, signs in once, saves `storageState`, and opens one browser context per
  theme.
- **Viewport 1440×900 CSS px, `deviceScaleFactor: 2`** → 2880×1800 PNG. "Full standard
  browser size" means the viewport, no browser chrome; the `<Screenshot>` component and the
  marketing site add their own frames. Phone shots at 390×844 for a short list.
- Theme and accent via the panel's localStorage keys (`wpl7-theme`, `wpl7-accent`) in an init
  script; accent fixed to blue, except one marketing shot per other accent.
- `animations: 'disabled'`, `caret: 'hide'`, cursor hidden by an injected style, wait for
  `document.fonts.ready` and network idle, scroll to top, blur the active element.
- Shots are defined in `docs/site/scripts/shots.ts` as `{ name, path, theme: 'light' | 'both',
  prepare?(page) }` where `prepare` opens dialogs, selects tabs or fills forms. One file, one
  list, the single source of what exists.
- Output: `docs/site/screens/<name>-<theme>.png`, optimized with `oxipng -o4 --strip all`
  (flat UI compresses to 250–500 kB). The build copies them to `public/screens/` and derives
  WebP; the component picks WebP with PNG fallback.
- `--only <name>`, `--phone`, `--marketing` (the hero set in every accent, both themes) and
  `--out <dir>` for local previews: **local captures are for looking at, never for
  committing**; macOS antialiasing differs from the Linux runner's and would churn every
  file. The committed files always come from the CI job.

### 8.3 The shot list

Light for all; dark where the Theme column says both. Names are stable identifiers used by
`<Screenshot name="…">` and marketing URLs (`/docs/screens/<name>-light.png`).

| Name | Where | State to prepare | Theme |
|---|---|---|---|
| `overview` | Dashboard | fleet, recent activity, WordPress card | both |
| `sites-list` | Sites → All sites | twelve sites, Server column visible | both |
| `site-new` | Sites → New site | step one filled in | light |
| `site-overview` | a live site → Overview | domain, status, quick actions | both |
| `site-go-live` | the Go live dialog | domain entered, DNS check shown | light |
| `site-wordpress` | WordPress tab | console with one command's output | both |
| `site-files` | Files tab | editor open on a theme file | both |
| `site-ftp` | FTP tab | one login, connection details | light |
| `site-visitors` | Visitors tab | 7 days | both |
| `site-backups` | Backups tab | list and schedule | light |
| `site-security` | Security tab | settings sheet open | light |
| `site-settings` | Settings tab | PHP version and limits | light |
| `sites-bulk` | Sites → Bulk management | selection with updates | light |
| `sites-security` | Sites → Security → Findings | findings, blocked requests | both |
| `sites-security-settings` | Sites → Security → Settings | default protection | light |
| `servers-list` | Servers → All servers | three servers with charts | both |
| `server-detail` | a server's page | Machine, Configuration, charts | light |
| `server-add` | Add server dialog | blank VPS path | light |
| `terminal` | Servers → Terminal | a canned `docker ps` session from the fake shell | both |
| `servers-security` | Servers → Security | block list with countries | light |
| `plugins` | Plugins → All plugins | inventory with updates and a vulnerability | both |
| `plugins-catalog` | Plugins → All plugins | the catalog cards | light |
| `recipes` | Plugins → Recipes | ACF PRO and Breakdance | light |
| `backups-all` | Backups → All backups | a deleted site's backups, offsite badges | both |
| `backups-storage` | Backups → Storage | location, encrypted destination | light |
| `mail-overview` | Mail | domains with mixed checks | both |
| `mail-setup` | Mail → Setup guide | steps with verdicts | light |
| `mail-traffic` | Mail → Traffic | volume by site, messages | light |
| `jobs` | Automations → All jobs | running, failed, done | both |
| `job-detail` | a job's page | log | light |
| `schedules` | Automations → Schedules | built-in and custom | light |
| `schedule-new` | custom job dialog | WP-CLI command | light |
| `api-keys` | Integrations → API keys | two keys, levels | light |
| `api-docs` | API keys → Docs tab | endpoint reference and console | both |
| `api-activity` | API keys → Activity | requests, one refused | light |
| `mcp` | Integrations → MCP | server on, connected apps, recent calls | both |
| `users` | Users | owner and admins, 2FA badge | light |
| `user-detail` | an account | two-factor card | light |
| `settings-<tab>` ×7 | Settings | each tab | light |
| `login` | sign-in page | wordmark over the card | both |
| `about`, `support` | Appearance group | as rendered | light |
| `phone-sites`, `phone-site`, `phone-jobs` | 390×844 | mobile menu closed | light |
| `hero-*` | marketing set: `overview`, `sites-list`, `site-overview`, `security`, `backups-all`, `mcp` | every accent, both themes, written to `screens/marketing/` | both |

About 55 shots, about 75 files, under 40 MB committed. If the directory passes 100 MB over
time, move `screens/` to Git LFS; do not reduce the resolution.

### 8.4 Drift and regeneration

- The `screenshots` CI job ([§7.4](#74-screenshots-that-follow-the-ui)) is the only producer
  of committed files. It runs on `ubuntu-latest` with the Playwright image pinned to the
  package version, so two runs of the same code produce the same pixels.
- A PR that intends a visual change gets its new screenshots pushed by the job and reviews them
  in the diff like any other file. A PR that did not intend one sees them too, which is the
  point.
- `workflow_dispatch` on `docs.yml` with `screenshots: true` regenerates everything and opens
  a PR, for when the demo data changes.

---

## 9. Work packages

Each is one pull request (or two where marked), labelled `docs` unless it changes the panel.
"Done" means the acceptance criteria hold and the PR describes what was run, as the template
asks. Nothing in any package may name a real installation.

### Order and parallelism

```
WP1 scaffold ──┬── WP3 content: Get started + Sites ──┐
               ├── WP4 content: Servers, Plugins, Backups ─┤
WP2 demo +     ├── WP5 content: Mail, Security ───────────┼── WP9 launch
screenshots ───┼── WP6 content: Automations, Integrations, Panel ─┤
               ├── WP7 reference + help ────────────────┤
WP8 signals ───┘  (parallel to content; needs WP1's slugs)
WP10 publish pipeline (parallel to content; needs WP1 to have something to publish)
```

WP1 and WP2 start together. Content packages start when WP1 has merged (they need the
components and the README) and WP2 has produced the first screenshots (they can begin writing
with placeholders named from the shot list). WP8 and WP10 run alongside. WP9 is the launch.

### WP1 · Site scaffold and shell

**Builds:** `docs/site/` as an Astro Starlight project: `package.json` (its own lockfile; Node
22), `astro.config.mjs` (`site`, `base`, `trailingSlash`, `build.format`, sidebar groups with
`autogenerate`, `editLink`, `lastUpdated`, `pagefind`, `components`, `customCss`, `head`,
plugins `starlight-links-validator`, `starlight-llms-txt`, `starlight-image-zoom`), the
header overrides (`SiteTitle`, `SocialIcons` with the Download button, `Footer` with the build
id), brand CSS (Inter from the panel's woff2 files, accent scales, grays, wordmark CSS copied
with a comment naming its origin), favicon and touch icon, the `Screenshot`, `Since` and
`UiPath` components, the `since` route middleware, `public/.htaccess` and
`hosting/nginx.conf.snippet`, a `404.md`, `src/data/releases.json` with a first snapshot,
and every page of [§4](#4-information-architecture) as a `draft: true` stub holding only its
front matter (title, description, order, sources) so the sidebar and slugs exist for everyone
else. `docs/site/README.md`: how to run, write, shoot, generate and check, with the style
rules of [§5](#5-page-anatomy-and-style) copied in. `.github/workflows/docs.yml` with the
`build` job (install, generate, build, links validated, artifact uploaded) on PRs touching
`docs/site/**`.

**Acceptance:** `npm run build` in `docs/site` succeeds with zero link-validator findings;
`npm run preview` serves at `http://localhost:4321/docs/` with working search, theme toggle,
prev/next, Edit link and TOC; the header matches [§6.1](#61-header) at 1440 px and 390 px; the
Introduction renders the hero area; Lighthouse ≥ 95 for performance and accessibility on the
Introduction and one content page; the output contains `sitemap-index.xml`, `llms.txt`,
`404.html`, `pagefind/`; no request leaves the page's origin (checked in the browser's network
panel). Draft stubs are excluded from the build.

### WP2 · Demo world and screenshots

**Builds:** `panel/scripts/demo-world.ts` and `panel/scripts/demo/*.ts` seeds per
[§8.1](#81-the-demo-world) and [Appendix C](#appendix-c-demo-world-data-sheet); `npm run demo`
in `panel/`; `docs/site/scripts/shoot.ts`, `shots.ts` and the `screenshots` job in `docs.yml`
per [§8.2](#82-the-shooter)–[§8.4](#84-drift-and-regeneration); the first committed set in
`docs/site/screens/`; `oxipng` in CI (`apt` or a pinned binary) and WebP derivation in the
build. A short `panel/scripts/demo/README.md`: what the demo is, what it must never do.

**Acceptance:** `npm run demo` starts without Docker and without network; every shot in the
list exists in light, the marked ones in dark, each at 2880×1800 (phone shots at 780×1688);
two consecutive CI runs on the same commit produce byte-identical files; no file above
600 kB; a change to a page's padding in `panel/web/src` makes the job push updated files to the
PR; a PR with no visual change gets no commit; nothing in any image names a real domain,
address, person or server (reviewed by eye against the data sheet).

### WP3 · Content: Get started and Sites

Fifteen pages. The Quick start is tested by following it on a throwaway VM from the rendered
page alone, with no other source open; anything the tester had to look up is a bug in the
page. Every claim about behaviour is checked against the code or a test and the page lists its
`sources`. Screenshots placed. May be split into two PRs (Get started; Sites).

**Acceptance:** all pages out of draft; each has title, description, Related, Limits (how-to
pages); links validated; the UI-path check reports nothing for these pages; word counts within
[§5.3](#53-writing-rules); a reviewer with the user's rules can find no sentence to shorten.

### WP4 · Content: Servers, Plugins, Backups

Thirteen pages, same criteria. The offsite page is checked against a MinIO run as
`local-dev.md` describes.

### WP5 · Content: Mail, Security

Ten pages, same criteria. Security pages must say what is not contained in the same words the
code's comments and `operations.md`'s "Security posture" use, and must not describe a rule
as relaxing without the evidence the code requires.

### WP6 · Content: Automations, Integrations, Panel

Twelve pages, same criteria, plus the generated API reference and MCP tools pages wired in
from WP8's generators (or temporary stubs if WP8 is behind).

### WP7 · Reference and Help

Fifteen pages. Troubleshooting re-groups `troubleshooting.md` by area; FAQ is written from
the README, the issue templates and the Support page's intent, and verified; Glossary from
[Appendix B](#appendix-b-glossary-seed); Third-party components with versions read from
`deploy/` and `panel/src/services/scanEngines.ts`.

### WP8 · Docs signals

**Builds:** `@docs` markers on every route module, service, UI page and provisioning script
that a page lists in `sources` (and vice versa); `docs:map`, `docs:generate` and the six
generators; the `sync` and `check` jobs in `docs.yml` with the sticky comment; the warn-only
flag and UI-path checks; branch protection note (the user makes `docs-sync` required);
`CLAUDE.md`, `CONTRIBUTING.md` and the PR template changes of [§7.6](#76-rules-for-people-and-agents).

**Acceptance:** a PR that changes `panel/src/routes/sites.ts` without touching the Sites pages
fails `sync` with a comment naming `sites/create`, `sites/domains` and the rest; adding
`Docs: not needed — comment only` to the body turns it green; a PR that edits
`panel/shared/apiDocs.ts` without regenerating fails `check` with the diff; `docs:map` fails
on an unknown slug.

### WP9 · Launch

Flip the stubs' remaining drafts, publish once by hand through the workflow's
`workflow_dispatch`, run the smoke test, then: README's docs table and inline links point at
`https://wpl7.com/docs/...`; each migrated `docs/*.md` becomes a three-line pointer to its new
page (kept for one release, removed after); `docs/README.md` keeps only Working on it and the
pointer; the panel gains `WPL7_DOCS_URL` (default `https://wpl7.com/docs/`) in `/api/meta`
and a **Docs** link in the Appearance group, plus "Learn more" links on the MCP and API keys
pages to their docs pages (small `feature` PR; the slugs are now a contract, which is why
renames go through `redirects`).

### WP10 · Publish pipeline

**Builds:** the `publish` job in `docs.yml` per [§7](#7-docs-signals-keeping-the-docs-in-step-with-the-code)
and [§6.4](#64-under-wordpress-at-docs): triggers `push` to `main` on docs paths and their
sources, `release: published`, `workflow_dispatch`; `concurrency: docs-publish`, no
cancellation; refresh `releases.json` with `gh api`; build; validate; `rsync -az --delete
--delete-delay --delay-updates dist/ user@host:<path>/` over SSH with `BatchMode=yes`,
`StrictHostKeyChecking=yes` and a pinned known-hosts entry; smoke test (`/docs/` is 200 and
contains the build id; a deep page is 200; `/docs/pagefind/pagefind-entry.json` is 200 with the
right type; `/docs/does-not-exist/` is 404 and the docs' own page; `.wasm` content type); job
summary with the tail of the log. Secrets: `DOCS_DEPLOY_HOST`, `DOCS_DEPLOY_USER`,
`DOCS_DEPLOY_PORT`, `DOCS_DEPLOY_PATH`, `DOCS_DEPLOY_SSH_KEY`, `DOCS_DEPLOY_KNOWN_HOSTS`. On
the host the key's `authorized_keys` line is `restrict,command="rrsync -wo <path>"` so it can
only write that directory. A `hosting/README.md` checklist for the host: directory and
ownership, the `.htaccess`/nginx snippet, the robots sitemap line, no `docs` slug, cache plugin
left alone, how to rotate the key. Setting up the host and the secrets is the user's step; the
PR says exactly what to run.

**Acceptance:** a docs-only merge to `main` is live within five minutes with the smoke test
green; a release republishes and the Edge badges of that version disappear; the workflow
cannot write outside the docs directory (tested with a path outside it); a failed rsync leaves
the previous site in place.

---

## 10. Open decisions for the user

Decided 2026-10-05: every recommendation below stands.

Each with the recommendation the plan assumes. Say "go" or change one; nothing else blocks.

1. **Download button target**: GitHub's latest release (recommended, same as the marketing CTA)
   or the Installation page.
2. **Publish from `main` with Edge badges** (recommended) or only on releases, with
   `/docs/next/` for the edge channel.
3. **Transport to the website host**: rsync over SSH with a write-only restricted key
   (recommended) or the WordPress receiver plugin. Depends on whether the host allows SSH.
4. **Marketing screenshots at `/docs/screens/`** (recommended) or a separate path.
5. **Demo domains**: customer sites under the reserved `.example` TLD (`northwindbakery.example`),
   panel at `panel.example.com`, dev sites at `<slug>.dev.example.com` (recommended).
6. **Retire `docs/*.md`** after one release of pointer stubs (recommended) or keep both and
   accept drift.
7. **Spelling**: US (recommended, matches the UI) or British (matches much of the README).
8. **Dark variants** light for every shot plus dark for hero set.

---

## 11. As built

What the build does differently from the sections above, and why:

- **Header.** The button is **How to install**, linking to Installation, rather than **Download**
  (the user's change after the first build). Starlight hides its right-hand group (social icons,
  theme) on phones, so `Header` itself is overridden to keep the button visible there. Search
  sits in the middle of the bar rather than over the content column. `SocialIcons` is
  Starlight's, except that the GitHub link opens in a new tab.
- **No rules** under the page title or beside **On this page**; the title sits 2rem above its
  page.
- **Managed installation** (the user's addition): a box in the page after the requirements on
  Quick start and Installation, and a compact one under **On this page** on every page that has
  it, both with a **Get it installed** button to the website's `/assisted-setup` page. Phones
  show only the box in the page; their contents list is Starlight's dropdown.
- **Pagefind** loads its WebAssembly as gzipped `.pagefind` files through `fetch`, so no
  `application/wasm` type is needed. The smoke test checks `wasm.en.pagefind` instead. Only
  `_astro/`, `pagefind/fragment/`, `pagefind/index/` and `pagefind.*.pf_meta` are content-hashed
  and cached for a year; `pagefind.js` and `pagefind-entry.json` keep the five-minute cache.
- **Generated pages** are plain Markdown (`.md`): an HTML comment cannot be the header of an MDX
  file. The header carries a hash of the body, which `docs:map` checks.
- **Known limits** is generated too (`gen-limits.ts`), from every page's Limits section, so it
  cannot fall behind them.
- **The API reference** gives each endpoint a block under its own heading: a six-column table
  was wider than the page.
- **The `build` job** does not run the generators. The generated pages are committed and the
  `check` job holds them to their sources; the build stays free of the panel's dependencies.
- **The demo world's clock stands still** rather than ticking from its instant: the panel works
  out a chart's time window from its own clock, so a ticking one moved the axes between runs.
  Each page the shooter opens comes from its own documentation-range address, because the panel
  allows one address 300 requests a minute. Files are presented under `/srv`, and anything the
  panel would mint at random (DKIM keys, host key fingerprints) is a fixed stand-in.
- **The shot list follows the panel as it is:** **Plugins → All plugins** is the catalog, and the
  fleet's inventory is **Sites → Bulk management**. A site's **Settings** tab has no limits;
  they are in **Settings → Sites**. A running job shows no percentage.
- **Marketing screenshots:** every run takes one Dashboard shot per other accent into
  `screens/marketing/`; the whole hero set in every accent and theme is `shoot.ts --marketing`,
  on demand, to keep the committed set small.
- **Edge-only content** (what merged after 0.3.0-beta.1) carries `since: 0.3.0-beta.2`, the
  smallest next release number. Any later release number clears the badges as well.
- **WP9** changes the README, the Markdown docs and the panel's links to point at wpl7.com/docs,
  so it lands once the first publish is live.
- **`docs-sync` has a workflow of its own** (`docs-sync.yml`), so it runs again when the
  description or the labels change. In `docs.yml` those events would rerun the other jobs too,
  and a job skipped by its condition counts as passed.
- **No `release: published` trigger.** The Release workflow creates the release with its own
  token, which starts no other workflow. It runs `docs.yml` by hand instead, which builds `main`
  rather than the tag.
- **oxipng** comes from its GitHub release, pinned by version and checksum: Ubuntu's archive
  has no package for it. The screenshot image has no compiler, which better-sqlite3 needs during
  `npm ci`, and no GitHub CLI, so the job installs Ubuntu's `make`, `g++` and `gh` first.

---

## Appendix A: Migration map

Where each existing file's content goes. "Trim" means the explanatory passages move to the
group's concept page or the Reference and the task text is rewritten to the template.

| Today | Goes to |
|---|---|
| `README.md` (feature list, quick start, how it works) | Introduction, Quick start, How WPL7 works |
| `install.md` | Quick start, Installation |
| `site-lifecycle.md` | Your first site, Sites → Create, Domains, Settings, Move; Manual recovery (Reference) |
| `dns.md` | Domains; Integrations → DNS and Cloudflare; Mail → Setup |
| `web-ftp.md` | Sites → Files |
| `ftp.md` | Sites → FTP and SFTP logins |
| `updates.md` | Plugins → Updates; Sites → Bulk management |
| `licenses.md` | Plugins → Recipes; Reference → Recipe format |
| `backup-restore.md` | Backups (all five pages); Manual recovery |
| `mail.md` | Mail (all four pages); Troubleshooting |
| `security.md` | Security → Site protection, Blocked addresses, Malware scans; Reference → Security levels, Limits |
| `operations.md` | Servers → Disk, logs and housekeeping; Security → Security in WPL7 (posture); Panel → Updating; the maintainer parts stay in `development.md` |
| `multi-server.md` | Servers → Add a server; Sites → Move; Backups → How backups work (on a fleet) |
| `jobs.md` | Automations (all three pages) |
| `api.md` | Integrations → The REST API; API reference (generated) |
| `mcp.md` | Integrations → AI apps over MCP; MCP tools (generated) |
| `updating.md` | Panel → Updating WPL7 |
| `configuration.md` | Reference → Configuration (generated) + the prose parts into Panel → Settings |
| `architecture.md` | How WPL7 works (short); Reference → Architecture (full) |
| `scripts.md` | Reference → Installer and scripts |
| `troubleshooting.md` | Help → Troubleshooting |
| `development.md`, `local-dev.md`, `CONTRIBUTING.md` | Stay in the repository; Help → Contributing links to them |
| `internal/` | Stays |

## Appendix B: Glossary seed

site · slug · dev domain · live domain · go live · panel · server · worker · fleet · job ·
lane · schedule · recipe · catalog (plugin catalog, recipe catalog) · backup · offsite copy ·
destination · fetch back · retention · site protection · level (Standard, Strict) · blocked
address · block list · finding · quarantine · vouch · checksum · relay · DKIM · SPF · DMARC ·
sender authorization · suspension · API key · level (Read only, Manage, Full) · MCP ·
connection window · channel (edge, stable) · health gate · rollback · image mode · checkout
mode · owner · admin · two-factor authentication · WP-CLI console · one-click login ·
maintenance mode · Web FTP · login (FTP, SFTP) · wildcard certificate · housekeeping.

## Appendix C: Demo world data sheet

Servers (name, documentation-range address, what runs there):

| Server | Address | Role |
|---|---|---|
| `fra1` | `203.0.113.10` | panel server, 5 sites |
| `nyc1` | `203.0.113.20` | worker, 4 sites |
| `sin1` | `203.0.113.30` | worker, 3 sites |

Sites (slug, title, domain, PHP, server, state, something to show):

| Slug | Title | Domain | PHP | Server | State and detail |
|---|---|---|---|---|---|
| `northwind-bakery` | Northwind Bakery | `northwindbakery.example` | 8.4 | fra1 | live; the "first site" of the tutorial |
| `alpine-dental` | Alpine Dental Clinic | `alpinedental.example` | 8.3 | fra1 | live; own protection settings (Strict) |
| `harbor-yoga` | Harbor Yoga Studio | `harboryoga.example` | 8.4 | nyc1 | live; FTP login present |
| `cedar-stone` | Cedar & Stone Architects | `cedarstone.example` | 8.3 | nyc1 | live; maintenance mode on |
| `blue-fern` | Blue Fern Florist | `bluefern.example` | 8.2 | fra1 | live; 2 plugin updates, 1 known vulnerability |
| `pixel-press` | Pixel Press Magazine | `pixelpress.example` | 8.5 | sin1 | live; busiest visitors, one malware finding quarantined |
| `ridge-outfitters` | Ridge Outfitters | `ridgeoutfitters.example` | 8.4 | sin1 | live; largest disk use |
| `lumen-law` | Lumen Law Partners | `lumenlaw.example` | 8.3 | fra1 | live; moved from nyc1 last week |
| `summit-coffee` | Summit Coffee Roasters | `summit-coffee.dev.example.com` | 8.4 | nyc1 | dev only, recipes activated |
| `oak-and-ivy` | Oak & Ivy Interiors | `oak-and-ivy.dev.example.com` | 8.4 | fra1 | dev, created ten minutes ago (the `site.create` job) |
| `tidewater-realty` | Tidewater Realty | `tidewaterrealty.example` | 8.2 | nyc1 | stopped |
| `old-portfolio` | (deleted) | | | sin1 | only its backups remain |

People: owner `admin` (the sign-in used by the shooter), admins `sam` (two-factor on) and
`priya`. API keys: "Deploy script" (Manage), "Uptime monitor" (Read only). MCP apps: Claude,
Cursor. Mail: every live domain signed; `bluefern.example` missing DMARC; `cedarstone.example`
SPF too permissive. Backups: nightly for live sites, weekly kept four; destination "Archive
bucket" (S3-compatible, encrypted). Jobs: `site.create` done, `backup.run` running 62 %,
`wp.update` batch done over five sites, `scan.site` failed on `tidewater-realty` (container
stopped), `backup.offsite` queued. Block list: six addresses from `198.51.100.0/24` and
`192.0.2.0/24` with countries the fake GeoIP returns. Clock: `2026-10-05T10:00:00Z`.
