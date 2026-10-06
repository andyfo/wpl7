# CLAUDE.md

## Watchlist: recheck it periodically

[docs/internal/watchlist.md](docs/internal/watchlist.md) lists what WPL7 depends on outside this
repository: upstream bugs it works around (Traefik's rate-limit bug, for one), versions it pins,
and services it calls. Each entry has a priority and a **Last checked** time.

- When you start work in this repository, read the watchlist's table. An entry is due for a
  recheck once its **Last checked** is older than its priority allows: High 7 days, Medium 30,
  Low 90. Recheck every entry that is due.
- A recheck is the entry's **Check**. Afterwards, update its **Last checked** (UTC) and
  **Status**, both in the entry and in the table.
- If something changed, tell the user, and do the entry's **When it changes** step or propose it.
  A changed status that is only noted down is not a recheck.
- When a change works around something upstream, or pins a version for a reason, add a watchlist
  entry in the same change. Remove an entry once there is nothing left to watch.

## Docs follow the code

[docs/site/](docs/site/) is the documentation site, published at wpl7.com/docs. A page names the
code it documents (`sources:` in its front matter), and code names its pages in a comment
(`// @docs sites/domains`). The `docs-sync` check holds every pull request to both.

- A change in behaviour updates the pages its `@docs` markers and the pages' `sources:` name, in
  the same pull request. `npm run docs:sync -- --base main` in `docs/site` lists them.
- When none of them needs a change, the pull request description says why, on a line of its own:
  `Docs: not needed — <reason>`.
- A new feature gets a page, and `@docs` markers in its code: `npm run docs:markers` adds them
  for every file a page lists in `sources:`.
- Generated pages (API reference, MCP tools, `deploy/.env`, job types, levels, changelog) are
  never edited by hand. Change the source, run `npm run docs:generate`, commit what it writes.
- A change to the panel's UI changes screenshots: run the screenshot script to look at them
  (`docs/site/README.md`, Screenshots). The `screenshots` job commits the new ones.
- The writing rules for pages are in [docs/site/README.md](docs/site/README.md).
