# Contributing

Thank you for looking. WPL7 is a small project maintained by one person, and the
fastest way to get a change merged is to make it easy to say yes to.

## Before you write code

**Open an issue first** for anything that adds a feature, changes a default, or touches how
sites, mail or updates work. A bug fix with an obvious shape needs no ceremony — send the PR.

Things that will not be merged, so nobody wastes an evening on them: a second way to do
something the panel already does; a plugin system; support for another distribution or
another init system; anything that puts a customer's data anywhere but their own server.

## Setting up

[docs/development.md](docs/development.md) has the whole picture. The short version:

```bash
cd panel && npm ci
npm run typecheck && npm test
npm run dev                # API on :3000, Vite on :5173
```

A real stack on your own machine is [docs/local-dev.md](docs/local-dev.md); it needs Docker
Desktop and about five minutes.

## What a good pull request looks like

- **One change.** A rename, a fix and a refactor in one diff is three reviews.
- **Green.** `npm run typecheck` and `npm test` both pass. CI runs exactly these.
- **Tested.** New behaviour comes with a test in the existing style — `panel/test/unit` and
  `panel/test/api`, against the fake world in `panel/test/helpers.ts`. The suite never
  touches the network or a real Docker daemon.
- **Explained.** The commit message says what was wrong, what the change does about it, and
  what you verified. The subject line is a sentence someone could read in a changelog. Look
  at `git log` for the register; PR titles become release-note lines.
- **Commented where it is surprising.** Comments in this codebase explain *why*, not what.
  If a line exists because of something that went wrong once, say so — that is the comment
  that saves the next person.
- **Documented.** A change in behaviour updates `docs/` in the same PR.

Label your PR `breaking`, `feature`, `fix`, `docs` or `internal`; that is how the release
notes group themselves.

## Things to be careful with

Some parts of this can lose somebody's website, so they get more scrutiny:

- anything under `provision/` that runs on a customer's box — it has to be idempotent and
  re-runnable, and say what it is about to do;
- database migrations — they run at every boot and **there are no down-migrations**, ever;
- anything that touches `/srv/sites`, `/srv/mysql` or `/srv/backups`;
- the update path, because a bug there is a bug nobody can update past.

## The CLA

Before a first pull request can be merged, you will be asked to sign a contributor licence
agreement — the bot comments on the PR with a link, and it takes a minute.

Being straight about why: WPL7 is AGPL-3.0, and a commercial edition is a future the
maintainer wants to keep open. That needs the right to relicense contributions, which only a
CLA gives. Your contribution stays yours; you grant the maintainer a licence to use it under
other terms as well. If that is not something you want to sign, that is entirely reasonable —
open an issue describing the change instead, and it may get written independently.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be decent.
