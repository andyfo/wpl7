# Documentation

## Running WPL7

| | |
|---|---|
| [install.md](install.md) | Blank server to a panel you can log into |
| [configuration.md](configuration.md) | `deploy/.env` versus panel settings, and where state lives |
| [updating.md](updating.md) | Updating WPL7 itself: channels, applying an update, and what the panel does afterwards |
| [updates.md](updates.md) | WordPress core, plugin and theme updates across every site, and known vulnerabilities |
| [site-lifecycle.md](site-lifecycle.md) | Creating a site, going live, moving it, deleting it |
| [dns.md](dns.md) | The records you need, and letting the panel manage them |
| [mail.md](mail.md) | The relay, DKIM, deliverability, sender authorization |
| [web-ftp.md](web-ftp.md) | The Files tab: editing, uploading and searching a site's files, and why it runs as the site |
| [ftp.md](ftp.md) | FTP and SFTP logins per site: connecting, what a login can reach, and why no more |
| [security.md](security.md) | Site protection, blocked addresses and malware scans: what each refuses, blocks and finds, and how to switch it off |
| [backup-restore.md](backup-restore.md) | What is backed up, where, and how to get it back |
| [multi-server.md](multi-server.md) | Adding servers and moving sites between them |
| [jobs.md](jobs.md) | Jobs and schedules: what runs, who started it, pausing, and your own scheduled jobs |
| [operations.md](operations.md) | Day to day: logs, disk, firewall, security posture |
| [troubleshooting.md](troubleshooting.md) | When something is wrong |

## Building on it

| | |
|---|---|
| [api.md](api.md) | The REST API and API keys |
| [mcp.md](mcp.md) | AI apps in the panel: connecting Claude, ChatGPT and others over MCP, and what they may do |
| [architecture.md](architecture.md) | How the pieces fit, and why they are arranged this way |
| [scripts.md](scripts.md) | Every script in `provision/`, every flag, in the order you run them |

## Working on it

| | |
|---|---|
| [development.md](development.md) | Versions, channels, cutting a release, and working on a server |
| [local-dev.md](local-dev.md) | A whole stack on macOS with Docker Desktop |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | What a good pull request looks like, and the CLA |

---

Start with [install.md](install.md) if you have a server and no panel yet, and
[scripts.md](scripts.md) if you want the one-page reference to what runs what.
