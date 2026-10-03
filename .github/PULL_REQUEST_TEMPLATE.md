<!--
The title becomes a release-note line, so write it as one: what changes for someone using
this, not what you touched. Label the PR breaking / feature / fix / docs / internal.
-->

## What and why

<!-- What was wrong, and what this does about it. The why is the part a reviewer cannot
     reconstruct from the diff. -->

## How it was verified

<!-- "typecheck and tests pass" is the floor, not the answer. What did you actually run, and
     against what? A real stack, a Multipass VM, a browser? -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass (in `panel/`)
- [ ] New behaviour has a test
- [ ] `docs/` updated if behaviour changed
- [ ] Anything under `provision/` is idempotent and safe to re-run
- [ ] No migration removes or rewrites data (there are no down-migrations)
