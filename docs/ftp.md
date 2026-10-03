# FTP and SFTP logins

Every site can have its own FTP and SFTP logins, for FileZilla, WinSCP, Cyberduck, `sftp` or
anything else that speaks either. A login belongs to one site and reaches that site's files and
nothing else, which makes it the thing to hand a customer or a freelance developer who wants
their own way in.

A site has **no logins by default**, and nothing FTP runs on a server - no container, no open
port - until one of its sites has one. Everything here is in the REST API too
([below](#the-api)).

## Adding a login

**Site → FTP → Add login**:

- **Username.** Unique across the whole panel, not just the site: a site can move to another
  server, and that server has to be able to take all of its logins. The site's own name is
  suggested for the first one, then `<site>-2` and so on. 3-32 characters of `a-z`, `0-9` and
  `. _ -`.
- **Password.** Generated - 24 letters and digits, safe to paste into an `ftp://` address - and
  shown **once**, or one you choose (at least 12 characters). The panel keeps a hash of it, not
  the password.
- **Folder** (optional): keeps the login inside one folder of the site, such as
  `wp-content/themes/child`. See [what a login can reach](#what-a-login-can-reach-and-why-no-more)
  for what this does and does not do.
- **Expires** (optional): access stops at the end of that day, in your browser's time zone.

**Copy all connection details** puts the host, ports, username and password on the clipboard,
ready for a password manager or a message.

The first login on a server sets up its FTP. On an install from released images that takes a
few seconds the first time (the panel downloads SFTPGo, about 20 MB). An install built from
source builds SFTPGo on the server instead, as it does its site images: a few minutes, once per
version, and the tab says so meanwhile. The tab shows **Applying…** until the server has the
change, then **Ready**, or **Expired** once every login the site has is past its expiry.

## Connecting

The **How to connect** card on the tab has everything a client needs:

- **Host**: the public IP address of the server the site is on. Any hostname that points
  straight at that address works too - the site's own domain, usually - but not one behind a
  proxy such as Cloudflare's, which carries web traffic and nothing else.
- **SFTP**: port **2222** (22 is the server's own SSH). The first connection asks you to trust
  the server's key; the tab lists its fingerprints to compare.
- **FTP**: port **21**, and only with TLS - *explicit FTP over TLS*, also called FTPS. A client
  that does not upgrade the connection is refused before it sends the password. The
  certificate is the server's own rather than one from a certificate authority, so the client
  asks to trust it once; the tab shows its SHA-256 fingerprint to compare. Data connections use
  ports 30000-30015 (passive mode; active mode is off).

The ports are settings ([below](#settings)).

| Client | SFTP | FTP |
|---|---|---|
| FileZilla | Site Manager → Protocol *SFTP*, port 2222 | Protocol *FTP*, Encryption *Require explicit FTP over TLS*, port 21 |
| WinSCP | File protocol *SFTP*, port 2222 | File protocol *FTP*, Encryption *TLS/SSL Explicit encryption*, port 21 |
| Command line | `sftp -P 2222 alice@203.0.113.10` | use SFTP |

Once a site moves to another server, its logins connect to that server instead: a new host,
and a new key and certificate for the client to trust.

## What a login can reach, and why no more

A site's files are only ever touched from a place that holds that one site's files, as the
site's own user - the same rule as the [Files tab](web-ftp.md). A compromised WordPress can plant
symlinks pointing anywhere; followed by a process that can see other sites' folders, one such
link reads another customer's `wp-config.php`. So each server runs two kinds of container:

- **The gateway** (`wpl7-ftp`), the only one with open ports. It speaks SFTP and FTPS, checks
  passwords and bans brute force - and has no site files at all.
- **A file server per site with logins** (`wpl7-ftp-<site>`). It runs as the site's user
  (`www-data`), with the site's WordPress folder mounted and nothing else, on an internal
  network only the gateway can reach. The gateway fetches and stores every file of a login
  through that site's file server, with a key only that file server accepts.

An FTP login can therefore do nothing the site's own PHP cannot: a planted link leads nowhere
the site could not already reach. None of the containers runs as root or holds the Docker
socket, and all of them run with a read-only filesystem and every capability dropped.

What follows from it:

- **Uploads belong to the site** (`www-data`), like everything WordPress writes.
- **Permissions can be changed** (FileZilla's *File permissions…*); ownership cannot, and
  symlinks cannot be created.
- **An upload lands only once it is complete**: it is written under a temporary name
  (`.sftpgo-upload.…`) and renamed into place when the last byte arrived, so a dropped
  connection never leaves half a `functions.php` behind. A file it replaces stays as it was
  until then: the site keeps its `wp-config.php` for the whole upload - without one,
  WordPress shows its install screen to whoever asks - and keeps it for good if the upload
  breaks off. This holds for SFTP, SCP and FTPS alike. The other side of it: an interrupted
  upload starts over rather than resuming.
- **A folder is a convenience, not a wall.** A folder login sees only its folder. But PHP it
  uploads there runs as the site as soon as a browser requests it, and PHP can read the whole
  site. Give a folder login to keep someone's work where it belongs, not to keep someone out.
- **A stopped site's logins keep working**, which is how a customer fixes a site that broke
  itself.

## Changing and removing logins

**Edit** (folder, expiry), **Reset password** and **Delete** take effect for new logins at once.
They also **end every FTP and SFTP session open on the site**: SFTPGo does not end a session
when its login changes, so the panel replaces the key between the gateway and the site's file
server instead, and a session still holding the old one is refused its next file. Clients
reconnect by themselves; a login that was removed or changed cannot. Sessions on other sites
are not touched.

An **expired** login is refused from its expiry on, and a session open at that moment ends
within a minute; the tab shows **Applying…** until it has. A site whose logins have all
expired shows **Expired**, and a server where no login is left unexpired runs nothing FTP.

Changes to a server that is unreachable wait for it: the tab says so, and they are applied as
soon as the panel reaches the server again.

## During restores, moves and deletes

- **Restore**: the site's FTP stops for as long as the restore runs - the restore replaces the
  whole folder, and an upload meanwhile would land in the copy it sets aside. Afterwards the
  logins see the restored files.
- **Move**: FTP stops when the move starts copying (an upload made on the old server after the
  copy would be lost) and comes back on the new server when the move ends - or on the old one,
  if the move was rolled back.
- **Delete**: the site's logins go with it.

While FTP is stopped the tab shows **Paused**, and a login attempt fails.

## Settings

**Settings → FTP & SFTP** applies to every server:

- **Allow FTP and SFTP logins**: off removes every server's gateway and file servers - at
  once from the servers the panel can reach, and from any other as soon as it can reach it.
  Until a server has confirmed it, its sites' FTP tabs and its server page say so
  (**Switching off…**, or why it has not happened yet) rather than **Off**: its logins may
  still work there. The logins are kept and work again when it is back on.
- **SFTP port** (2222), **FTP port** (21) and the **passive range** (30000-30015; 2 to 100
  ports, and not 2022 or 2121, which the gateway uses inside its container). Each passive port
  is one small `docker-proxy` process on every server with logins.
- **Also offer FTP**: off leaves SFTP alone, and closes port 21 and the passive range.

A server offers FTP only once its **public IP** is set (Servers → the server → Edit settings):
passive mode hands clients that address for the data connection. Without it, the server offers
SFTP alone and the FTP tab says why.

**Firewalls.** The ports open on a server only while one of its sites has a login. Docker
publishes them past the server's own firewall (UFW), the same way as ports 80 and 443; a cloud
provider's firewall in front of the server has to allow them. Only IPv4 is published.

**Resources.** The gateway uses about 70 MB of memory and each site's file server about 10 MB.

## Logs and trouble

- `docker logs wpl7-ftp` on the server shows every login, failed login and transfer;
  `docker logs wpl7-ftp-<site>` shows the file server's side.
- **Brute force**: an address that keeps failing to log in is banned for 30 minutes, longer each
  time it comes back (failed logins for an unknown user count double). An address may hold 20
  connections at once.
- **"Port 21 is already in use … so it offers SFTP only"** in the tab: something else on that
  server listens on an FTP port (a preinstalled FTP server, say). SFTP keeps working. Free the
  port, or pick another in Settings; either is tried again at once.
- **"port 2222 is already in use"**: the SFTP port is taken on that server - often by its own
  SSH, on a server set up to listen there. Nothing FTP runs there until the SFTP port changes
  (Settings).
- **The client logs in, then hangs on the directory listing, or reports "425 Can't open data
  connection"**: the passive ports are blocked on the way, usually by a cloud firewall. Allow
  30000-30015, or use SFTP.
- **"Server unreachable"**: the panel cannot reach the server over SSH; see
  [troubleshooting.md](troubleshooting.md).
- **"building SFTPGo failed: …"**: the server could not build the image (an install built from
  source does that on the server). The build fetches SFTPGo from github.com and its Go modules
  from proxy.golang.org, and needs about 2 GB of disk while it runs. It is tried again after
  15 minutes, or at once when a login or the FTP settings change.

## The API

| | |
|---|---|
| `GET /api/sites/:slug/ftp` | How to connect, the server's FTP status, and the site's logins |
| `POST /api/sites/:slug/ftp/users` | Create a login: `{username, password?, folder?, expiresAt?}`; the answer holds a generated password, once |
| `PATCH /api/sites/:slug/ftp/users/:id` | Change `folder` or `expiresAt` |
| `POST /api/sites/:slug/ftp/users/:id/password` | New password: `{password}`, or no body to have one generated |
| `DELETE /api/sites/:slug/ftp/users/:id` | Delete a login |
| `GET /api/servers/:id/ftp` | One server's gateway: status, ports, fingerprints |

```sh
# A login for a freelancer, kept to the child theme, for the month.
curl -sX POST https://panel.example.com/api/sites/shop/ftp/users \
  -H "Authorization: Bearer $WPL7_KEY" -H 'content-type: application/json' \
  -d '{"username":"shop-dev","folder":"wp-content/themes/child","expiresAt":1793491200000}'
# -> 201 {"user":{...},"password":"Gk7mPq2RtV9xWz3NbHc4JdYe"}
```

## Under the hood

- The panel's database is the source of truth; each server gets what its sites' logins need,
  under `/srv/wpl7-ftp` (`gateway/` and `sites/<site>/`), rewritten whenever a login changes and
  checked every few minutes. The files are readable only by the container that uses them.
- Removing a server from the panel takes its FTP containers and files off it first.
- SFTPGo (AGPL-3.0, like WPL7) runs from WPL7's own image, `wpl7-sftpgo:<version>` on each
  server, made from `deploy/sftpgo-image`: one pinned upstream release, built the way upstream
  builds its distroless image, plus `staged-overwrite.patch`. An install from released images
  pulls the build CI publishes (`ghcr.io/andyfo/wpl7/sftpgo`); one built from source builds it
  on the server, and removes the Go toolchain the build used afterwards. Upstream's atomic uploads move a file
  being overwritten to the temporary name before the new one arrives - missing for the whole
  transfer, deleted if the transfer fails; the patch leaves it in place until the new one is
  complete. The image carries the patch (`/usr/share/doc/wpl7-sftpgo/`).
- The gateway's SSH keys and certificate are made once per server and kept in the panel's
  database, so a client that trusted a server once is not asked again - unless the site moves.
- Restoring the panel's database from a backup brings back the logins it had then, including
  ones deleted since.
