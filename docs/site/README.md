# The WPL7 documentation site

The source of [wpl7.com/docs](https://wpl7.com/docs/): an [Astro Starlight](https://starlight.astro.build)
project that builds to plain HTML, published into the `/docs` directory of the website. The
plan behind it, with the reasons for each choice, is
[docs/internal/docs-site-plan.md](../internal/docs-site-plan.md).

```
docs/site/
  astro.config.mjs        site, base (/docs), sidebar groups, plugins, component overrides
  src/content/docs/       the pages: one folder per sidebar group, one .mdx file per page
  src/components/         Screenshot, Since, UiPath, ManagedInstall, and overrides
  src/styles/             the panel's typeface, colours and wordmark
  src/data/releases.json  the release notes snapshot (Changelog, Edge badges)
  screens/                the screenshots, taken by CI from the demo world
  scripts/                prepare, the shooter, the generators and the docs checks
  hosting/                what the website's server needs (nginx snippet, checklist)
  public/.htaccess        the same for Apache and LiteSpeed, published with the pages
```

## Run it

Node 22 or newer.

```bash
cd docs/site
npm ci
npm run dev          # http://localhost:4321/docs/ - search only works in a build
npm run build        # dist/, with links validated; fails on a broken link or anchor
npm run preview      # serves dist/ at http://localhost:4321/docs/
```

`npm run build` runs `scripts/prepare.ts` first. It copies the panel's favicon and touch
icon into `public/`, and the screenshots into `public/screens/` with a WebP twin of each.

Change `package-lock.json` with npm 11.21 or newer, or with the npm 10 that comes with Node 22.
Older npm 11 releases (11.6.2, for one) drop `@emnapi/core` and `@emnapi/runtime` from it, and
CI's `npm ci` then fails with "Missing: @emnapi/core from lock file".

## Pages

Every page is an `.mdx` file under `src/content/docs/<group>/`. The folder is the sidebar
group, the file name is the URL: `sites/domains.mdx` is `/docs/sites/domains/`. Slugs are a
contract once published. Renaming one later needs an entry in Astro's `redirects`.

```yaml
---
title: Domains and going live          # sentence case, a task or a thing, at most 40 characters
description: Move a site from its dev address to the customer's domain with no downtime.
sidebar:
  order: 3                             # position in its group
  label: Going live                    # only when it should differ from the title
since: 0.4.0                           # optional: first release with this feature (Edge badge)
sources:                               # the files this page documents (see Docs signals)
  - panel/src/routes/sites.ts
  - panel/web/src/pages/SiteDetail.tsx
---
```

`title` and `description` are required, and the build fails without them. The description
is one sentence, the one a reader would search for. It shows under the title and in link
cards.

### How-to pages

```mdx
One or two sentences: what this is and what it is for.

<Screenshot name="site-go-live" alt="The Go live dialog with a domain filled in" />

## Before you start
- DNS access for the customer's domain.

## Go live
1. Open the site and choose **Go live**.
2. Enter the domain. The panel checks its DNS and says what is missing.
3. Confirm. The site answers on both addresses until you remove the old one.

## What happens
Three to six sentences, or a short list: the job that runs, what changes on disk and in
DNS, what is run again, how long it takes.

## Limits
- One domain per site. Aliases redirect.

## Related
- [Your first site](/docs/get-started/first-site/)
- [DNS and Cloudflare](/docs/integrations/dns/)
```

The first paragraph has no heading. **Before you start** is there only if something must be
true first. A page about several tasks has one heading per task.

**Concept pages** (How WPL7 works, Security in WPL7, SPF, DKIM and DMARC explained) replace
the task sections with prose under two to five headings, and still end with Related.
**Reference pages** are tables.

### Writing rules

These are the project's rules for interface text, applied to prose. Review holds a page to
them.

- **Short.** A how-to page is 150 to 500 words plus one or two screenshots. If it is longer,
  split it, or move the reasons into the group's concept page. The old Markdown docs are the
  material, not the length.
- **One idea per sentence**, around 20 words, with a verb. No semicolons joining clauses, no
  parentheses, no em dashes, no arrows in prose. Arrows are for places in the panel only.
- **Plain words.** No marketing adjectives ("powerful", "seamless", "robust"), no "simply",
  no "just". A feature is named, placed and explained, not praised. Say a dependency in one
  sentence: "The wildcard certificate needs the Cloudflare token, because it is issued through
  a DNS check."
- **The panel's words, exactly**, in bold: **Go live**, **Bulk management**, **Add server**.
  Never invent a label. If a label is wrong, fix the panel, not the docs.
- **Places in the panel** are paths in bold with arrows: **Sites → Security → Settings**. Use
  `<UiPath href="…">` when the path should link to the page that documents its last step.
- **Tasks are headings**: "Add a login", not "Logins". Headings are sentence case.
- **Code is code**: commands, file paths, flags, environment variables and API paths go in
  backticks, or in a fenced block with a language. A command the reader will paste gets a
  block of its own with nothing else in it.
- **Numbers** go in tables or on their own line, not woven into sentences.
- **No real installation, ever.** Example domains only: `panel.example.com`,
  `dev.example.com`, `<slug>.dev.example.com`, customer domains under the reserved `.example`
  top-level domain (`northwindbakery.example`). Addresses from the documentation ranges
  `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`. No real server name, person, local
  path or incident, in text or screenshots.
- **Honest about limits.** Every feature page has a **Limits** section, even if it is one
  line. What is not contained, not automated or not supported is said, not implied. Do not
  describe a behaviour without reading the code or the test that pins it.
- **US spelling**: color, license, catalog, as the panel writes them.
- **Callouts** (`:::note`, `:::tip`, `:::caution`, `:::danger`): at most two per page.
  `:::danger` only for data loss.
- **Versions**: through the `since:` field or `<Since v="0.4.0" />`, never in prose.

### Links

- Internal links are absolute and end in a slash: `[Backups](/docs/backups/overview/)`,
  `[the Limits list](/docs/reference/limits/#mail)`. The build fails on a broken link or a
  missing anchor.
- Every page ends with **Related**: two to six links. The group's concept page, the pages it
  depends on, the reference it draws on.
- A feature that lives in two places in the panel has one page, linked from the other pages'
  Related lists.
- The first use of a term from the [glossary](/docs/reference/glossary/) links to its entry:
  `[dev domain](/docs/reference/glossary/#dev-domain)`. Not in headings, not inside a bold UI
  label, not twice on one page, and not for everyday words (site, server, panel, backup).

### MDX

Pages are MDX, so components work everywhere. Two characters mean something in MDX prose:
`<` starts a component and `{` starts an expression. Keep them inside backticks or code
blocks (`<slug>.dev.example.com`, `{title, slug}`), or escape them (`\<`, `\{`).

## Components

Imported where they are used:

```mdx
import Screenshot from '~/components/Screenshot.astro';
import Since from '~/components/Since.astro';
import UiPath from '~/components/UiPath.astro';
import ManagedInstall from '~/components/ManagedInstall.astro';
```

| Component | Use |
|---|---|
| `<Screenshot name="sites-list" alt="…" caption="…" />` | A screenshot from `screens/`. Light always, the dark twin when one exists and the page is dark (`dark={false}` keeps light). WebP with a PNG fallback, a CSS frame, zoom on click. A name not taken yet shows a dashed placeholder. |
| `<Since v="0.4.0" />` | Inline badge: "Edge" while 0.4.0 is newer than the latest release, then "Since 0.4.0". For a section; a whole page uses `since:`. |
| `<UiPath href="/docs/security/site-protection/">Sites → Security → Settings</UiPath>` | A bold place in the panel, the last step linked. `check-ui-paths` reads these. |
| `<ManagedInstall />` | The paid managed installation: a tinted box with a button to the website's `/assisted-setup` page. Quick start and Installation carry it in the page. The contents column shows a compact one on every page. |
| Starlight's `Steps`, `Tabs`, `TabItem`, `Card`, `CardGrid`, `LinkCard`, `Aside`, `FileTree`, `Badge` | As [Starlight documents them](https://starlight.astro.build/components/using-components/), imported from `@astrojs/starlight/components`. |

`~` is `src/`. The screenshot names are listed in `scripts/shots.ts`.

## Screenshots

`scripts/shots.ts` is the one list of what exists: a name, the panel URL, what to open or fill
in first, and whether a dark twin is taken. `scripts/shoot.ts` builds the panel's web app,
starts its **demo world** (`panel/scripts/demo-world.ts`: fictional servers and sites over the
test suite's fakes, no Docker, no network, see `panel/scripts/demo/README.md`), signs in once,
and captures every shot at 1440×900 CSS pixels at 2× into `screens/<name>-<theme>.png`. Both
clocks stand at the demo's instant, so two runs give the same bytes. Besides the shots, one
Dashboard shot per other accent goes to `screens/marketing/`; `--marketing` takes the whole
hero set in every accent and theme there.

```bash
npm run shoot -- --out .screens-local                   # every shot, for looking at
npm run shoot -- --out .screens-local --only sites-list
DOCS_SCREENS=.screens-local npm run dev                 # the docs with those shots
```

The panel's dependencies must be installed (`npm ci` in `panel/`). `oxipng` optimizes the PNGs
when it is installed.

**Local captures are for looking at, never for committing.** Fonts render differently on
macOS than on the Linux runner, so a local capture would change every file. The committed
files come from the `screenshots` job in `.github/workflows/docs.yml`, which runs in the
Playwright image pinned to the package's version. On a pull request that changes `panel/web`,
`panel/shared`, the demo world or the shot list, it takes every shot, keeps each committed
file whose new capture differs in at most 0.1 % of its pixels (`scripts/compare-shots.ts`), and
pushes the rest to the branch as "Update docs screenshots". A fork's pull request gets them as
an artifact. Run it by hand from the Actions tab (**Run workflow**, **Retake every
screenshot**) after changing the demo data: it opens a pull request with the new files.

A push or a pull request made with the workflow's own token starts no other workflow, so its
checks wait for the next push. The secret `SCREENSHOTS_PUSH_TOKEN` makes them run: a
fine-grained token for this repository with **Contents** and **Pull requests** set to **Read and
write**. Without it, the manual run can open its pull request only if **Allow GitHub Actions to
create and approve pull requests** is on (**Settings → Actions → General**). Otherwise the run
fails with a link to open it by hand.

## Generated pages

Six pages are written from the code, not by hand. Each is a plain Markdown file (`.md`), and the
line under its front matter names the script that wrote it, the files it read, and a hash of
everything below that line.

| Page | Script | Written from |
|---|---|---|
| `integrations/api-reference/`, an overview and a page per group | `gen-api.ts` | `panel/shared/apiDocs.ts` |
| `integrations/mcp-tools.md` | `gen-mcp-tools.ts` | `panel/src/mcp/tools.ts`, by registering the tools with a fake server that records them |
| `reference/configuration.md` | `gen-config.ts` | `deploy/.env.example` |
| `reference/job-types.md` | `gen-job-types.ts` | `panel/shared/jobTypes.ts`, and the `enqueue()` calls in `panel/src` for lanes and starters |
| `reference/security-levels.md` | `gen-levels.ts` | `panel/shared/security.ts` and `panel/shared/access.ts` |
| `help/changelog.md` | `gen-changelog.ts` | `src/data/releases.json` |

Do not edit them: `docs:map` fails on a page whose hash no longer matches. Change the source and
run the generators. They import panel modules, so `panel/node_modules` must be installed.

```bash
npm run docs:generate    # all six pages
npm run docs:releases    # first, to refresh src/data/releases.json from GitHub for the changelog
```

The `check` job in `.github/workflows/docs.yml` runs the generators on every pull request and
every push to `main`, and fails when what they write differs from what is committed.
`.gitattributes` marks the pages as generated, so GitHub folds them in diffs.

## Docs signals

Two ways tie a page to the code it documents:

- **`sources:`** in a page's front matter: globs of the files it documents, from the
  repository root.
- **`@docs <slug>`** in a comment in the code: `// @docs sites/domains`, or `# @docs …` in shell
  and YAML, comma-separated for several pages. The slug is the page's URL path under `/docs/`
  without slashes at either end.

| Command | What it does |
|---|---|
| `npm run docs:map` | Joins both into `.docs-map.json`. Fails when an `@docs` slug names no page, a page in a feature group names no code, a `sources:` glob matches no file, or a generated page was edited by hand. |
| `npm run docs:markers` | Adds the missing `@docs` markers to every code file a page lists in `sources:`: one line near the top, naming every page. `-- --check` only lists what is missing. |
| `npm run docs:sync -- --base main` | What the `docs-sync` job runs: the pages your changes since `main` affect, and its verdict. |
| `npm run docs:check-flags` | Every flag of `install.sh` and `provision/setup.sh` is on the Installer and scripts page. |
| `npm run docs:check-ui-paths` | Every `<UiPath>` step and bold UI label exists as text in the panel. Labels of other software go in its `IGNORE` list. |

The feature groups are Sites, Servers, Plugins, Backups, Mail, Security, Automations,
Integrations and Panel. Markers are not added for the sources of generated pages: the `check`
job already holds those pages to their code.

On every pull request, the `docs-sync` job (`.github/workflows/docs-sync.yml`) keeps one comment
up to date. It lists the pages that document the changed code, with their public URLs and the
changes behind them. It runs again when the description or the labels change. It passes when:

- the pull request changes only `docs/site/`;
- no page documents the changed code, or only generated pages do;
- one of the affected hand-written pages changed too;
- or the description has a line like this, with a reason after it:

```
Docs: not needed — only a comment changed
```

`Docs: n/a — …` works too, and the label `no-docs-change` does the same for automation.
Otherwise the job fails. A change to `panel/web/src/styles.css`, `Layout.tsx` or `ui.tsx`
changes every screenshot, so the comment points it at the screenshots job instead of at pages.
The comment ends with the reports of `check-flags` and `check-ui-paths`, which warn and never
fail. A pull request from a fork gets no comment: its job summary has the same text.

Make `docs-sync` a required check on `main`, in the repository's branch protection, so that a
failing one holds the merge.

## Publishing

`.github/workflows/docs.yml` publishes on every merge to `main` that touches the docs or their
sources, after every release, and by hand. The Release workflow starts the publish once the
release is out. It builds, validates, copies `dist/` to the website's `/docs` directory with
`rsync` over SSH, and checks the live site afterwards.
[hosting/README.md](hosting/README.md) is the website side: the directory, the key, the
`.htaccess` or nginx snippet, and the secrets.

A page with `since:` newer than the latest release carries an **Edge** badge and a banner. The
publish after a release builds `main` with the new release notes, and the badges disappear.
