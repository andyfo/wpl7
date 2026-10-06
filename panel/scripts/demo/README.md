# The demo world

A fictional, well-used WPL7 install: three servers, eleven sites and one deleted one, backups
and an encrypted offsite destination, jobs in every state, mail traffic, security findings,
admins, API keys and two AI apps connected over MCP. It is the real panel - its routes, services
and web app - over the test suite's fakes (`test/helpers.ts` `makeWorld`): in-memory SQLite, fake
Docker, fake servers, no network.

```bash
npm run build:web -- --outDir /tmp/wpl7-web --emptyOutDir   # any folder; not web/dist if a dev API serves it
npm run demo -- --port 3999 --web-dist /tmp/wpl7-web
```

Open `http://localhost:3999` (localhost, not 127.0.0.1: the session cookie is Secure, which a
browser keeps over plain HTTP only there) and sign in as `admin` / `correct-horse-battery`.

The docs' screenshots are taken from it: `npm run shoot` in `docs/site`.

## What it must never do

- **Name a real installation.** Every domain is under `.example` or `example.com`, every
  address is from a documentation range (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), every
  person is invented. `data.ts` is the data sheet; screenshots made from it are published.
- **Touch Docker, the network or the disk outside its temporary directory.** It never starts the
  job worker or the schedulers. What a click queues stays queued.
- **Change between runs.** Its clock stands at 2026-10-05 10:00 UTC (`clock.ts`), random data
  comes from seeded generators, and stand-ins replace anything the panel would mint: DKIM keys,
  host key fingerprints, TOTP secrets. Two runs give the same screenshots, byte for byte.
- **Show the machine it runs on.** Files are presented under `/srv` (`paths.ts`), disk sizes are
  fixed, and server facts come from `world.ts`.

## Where things are

| File | Seeds |
|---|---|
| `data.ts` | the data sheet: servers, sites, people, and the seeded random generator |
| `world.ts` | the fake world with the demo's names, server facts, DNS answers and a release |
| `servers.ts` | the three servers and a week of load, memory and disk samples |
| `sites.ts` | the sites, their containers and a day of uptime and resource samples |
| `inventory.ts`, `plugins.ts` | plugins and themes per site, the vulnerability feed, the plugin catalog |
| `traffic.ts` | two weeks of visitor statistics |
| `backups.ts` | backups, the offsite destination and its copies, disk sizes |
| `jobs.ts` | jobs with their logs, the built-in schedules' last runs, a custom schedule |
| `docker.ts`, `files.ts` | what the containers answer: the mail relay, WordPress, the Files tab |
| `mail.ts`, `dnsRecords.ts` | DKIM keys, a day of mail, and public DNS for the setup guide |
| `security.ts` | protection settings, blocked requests and addresses, malware scans, quarantine |
| `accounts.ts` | admins, API keys and their activity, MCP connections, settings |
| `recipes.ts`, `ftp.ts`, `terminal.ts` | license keys, an FTP login, the terminal's session |

A page shows something wrong or empty: find the endpoint it calls (`web/src/api/hooks.ts`) and
seed what that reads. `DEMO_DEBUG=1` logs every container command nothing answers.

## Versions

WordPress, plugin and theme versions are real: the newest releases on the demo's date, each
named once in `plugins.ts`. An older version a site runs has no known advisory. Releases move
on: `npx tsx scripts/demo/check-versions.ts` lists what to change, and the watchlist
(`docs/internal/watchlist.md`) says how often to run it.
