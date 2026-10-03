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
