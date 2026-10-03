# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/andyfo/wpl7/security/advisories/new).

Expect an acknowledgement within a few days. WPL7 is maintained by one person, so
please be realistic about response times — but a report about something that puts other
people's servers at risk will always jump the queue.

If GitHub is not an option, email the address in the repository owner's GitHub profile with
`WPL7 SECURITY` in the subject.

## What is in scope

Anything that lets someone:

- reach one hosted site from another, or reach the panel from a site - including through an
  FTP or SFTP login, which must never reach more than its own site's files;
- send mail as a domain belonging to a site that is not theirs;
- obtain panel credentials, API keys, site database passwords or DKIM private keys;
- do more with an API key or an MCP connection than its level allows, or get an AI app approved
  without an admin opening a connection window and approving it themselves;
- run code on the host without already holding panel or SSH access;
- make the panel apply an update it did not resolve from a release manifest.

Reports about dependencies are welcome, especially anything reachable from an unauthenticated
request.

## What is not

Some things are deliberate, and saying so up front saves everyone time:

- **The panel is root-equivalent on its own host.** It holds `/var/run/docker.sock`, an SSH
  key for root, and passwordless sudo on every worker. Docker-socket access *is* root access;
  that is the design, not a finding. Anyone who can log into the panel can already run
  anything on the box.
- **The deploy user is root-equivalent too.** It is in the `docker` group and has NOPASSWD
  sudo. The forced command on the CI key limits a leaked GitHub secret to running the deploy
  script; it is not a boundary against someone who can push to `main`.
- **Site containers run as root inside themselves.** They are contained by capability drops,
  `no-new-privileges`, per-site networks and resource ceilings — not by an unprivileged uid.
- **Self-hosted WordPress will be compromised eventually.** What matters here is what that
  costs the other customers on the box; reports about that containment are very much in
  scope, and `docs/operations.md` describes what it is meant to be.

## Supported versions

`0.x`: only the newest release. There is no backporting yet. Updating is one button or one
command ([docs/updating.md](docs/updating.md)).
