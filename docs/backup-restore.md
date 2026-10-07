# Backups & restore

## What a backup contains

`<backup root>/<slug>/<YYYYMMDD-HHMMSS>/`

| File | Content |
|---|---|
| `db.sql.gz` | `mariadb-dump --single-transaction` of the site database (consistent InnoDB snapshot, no locks) |
| `files.tar.gz` | `wordpress/` tree + `config/` (php overrides) + `site.json` |
| `manifest.json` | slug, title, domains, PHP + WP versions, locale, db name/user, timestamp |
| `sha256sums` | checksums of both archives, verified before every restore |

Files are archived live (uploads are append-mostly; a few seconds of skew vs the dump is accepted).

The **backup root** defaults to `${SRV_ROOT}/backups` and is set per server — see
[Choosing where backups are stored](#choosing-where-backups-are-stored).

## Types & retention

- **scheduled** — created by the backup cron (panel Settings; default daily 03:00). The schedule is
  edited one cron field at a time, with the result in words underneath (hover it for the next three
  run times) on the panel server's clock — which is UTC unless the host says otherwise. Only the newest N
  per site are kept (default 10). A site can be taken out of this run on its own — the site's
  **Backups** tab → **Scheduled backups**, or `PUT /api/sites/:slug/backups-enabled {"enabled": false}`.
  That is the only thing the switch does: every other kind below still runs, because those exist to
  catch a mistake in progress rather than to keep history. Existing backups are kept, and retention
  keeps pruning them.
- **manual** — "Back up now"; kept until you delete them.
- **final** — taken on site deletion (optional, default on); kept until you delete them, survives the site
  (see [Backups of deleted sites](#backups-of-deleted-sites)). Deleting a site can take its other backups
  with it (**Delete its existing backups too**, off by default): with a final backup as well, that one is
  the site's only backup afterwards.
- **pre_restore** — automatic safety backup before every restore.
- **pre_update** — taken before a WordPress update run when "Back up first" is ticked (it is, by
  default, for live sites). The job's result carries the id, and a failed health check afterwards names
  it, so recovering from a bad update is the ordinary restore below. Kept until you delete them, like
  every other non-scheduled kind — so a weekly fleet-wide update run does accumulate them, and they are
  yours to prune.
- **move** — both ends of a server move: the source snapshot (note "pre-move to …") and the staged
  copy registered on the target (note "staged copy (move)"), so a moved site arrives with a backup at
  its new home. Kept until you delete them.
- **panel** — a nightly copy of the panel's own database (see
  [The panel's own state](#the-panels-own-state)). Pruned by the same retention as **scheduled**.

Retention pruning only ever touches **scheduled** and **panel** backups.

## Finding a backup

**Backups** in the sidebar lists every backup on every server, newest first, and filters by site, kind
and server (`GET /api/backups`). A site's own **Backups** tab lists that site's. The panel's nightly
snapshots are in the list too, as **Panel database**.

### Backups of deleted sites

A deleted site has no page any more, but its backups outlive it. The final backup, and every kind but
**scheduled**, stays until you delete it. Scheduled backups go on following retention like any site's:
the newest N are kept, locally and at each destination, so lowering retention thins them out too. The
Backups list is where they are — each deleted site is named under **Deleted sites** at the top, and
its rows say **deleted**. They can be downloaded, fetched back from a
remote destination, and deleted — one at a time or [in bulk](#deleting-several-at-once); deleting the
last complete one asks for the site's name to be typed, like deleting the site did.

Restoring needs a site to restore onto. A backup belongs to its site by name (slug), so a new site
created with the same name owns the old backups: create it on the server the backup is on, then
restore from its **Backups** tab. The restore replaces the new site's files and database and rewrites
the URLs from the old domain to the new site's.

## Restore (panel or `POST /api/backups/:id/restore`)

1. Checksums verified; pre-restore backup taken (unless skipped).
2. Site stopped → database dropped, recreated and re-imported → files swapped in
   (the previous tree is kept 24 h as `wordpress.pre-restore-<ts>` next to the site). The site's
   FTP/SFTP logins are paused from here to the end, and then see the restored files (docs/ftp.md).
3. If the backup was taken on a different PHP version that is still offered, the container is recreated
   to match; so it is when the backup's tables have another prefix (a backup of a deleted site that had
   the same slug), and the site takes that prefix. If the domains changed since the backup, URLs are
   rewritten to the current primary.
4. Site started + smoke-checked.

If step 1 fails (checksum mismatch, no disk for the safety copy) the site is untouched and keeps
running — only failures from step 2 onwards mark it `error`. A failure after the file swap leaves the
previous tree in place and says where.

## On a fleet

A backup lives on the server where it was taken (`serverId` on the row) and stays there when the site
moves. Download streams from whichever server holds it; restore must run where the backup lives.
Restoring onto a site that has since moved elsewhere is rejected — **unless the backup has an offsite
copy**, in which case **Fetch back** brings it onto the site's current server and the ordinary restore
then works (see [Fetching a backup back](#fetching-a-backup-back)).

---

## Choosing where backups are stored

Each server has its own **backup location** (`servers.backup_root`; empty = `${SRV_ROOT}/backups`).
Set it in **Backups → Storage** with the **Storage** button beside the server, or on a server's page.
The modal shows the disk the location sits on, how full it is, and how many backups are already
there, followed by every disk the machine has. Each of those rows is named by its **mount point**
and device — `/` on `/dev/sda1`, `/mnt/data` on `/dev/sdb1` — with the directory it would use spelled
out under it (`/backups`, `/mnt/data/backups`). The disk the backups already sit on is shown but not offered:
picking it would mean a second backup directory on the disk they are already on.

The location must be an absolute path, and may not be `/`, a system tree, or anywhere inside (or
containing) `${SRV_ROOT}/{sites,mysql,panel,mail,traefik,plugins}` — the panel creates and removes
timestamp directories under it.

**Worker servers** need nothing else: the panel reaches their filesystem over SSH as root, so any
path works the moment it is saved.

**The panel's own server is the exception.** The panel runs in a container that can only see what
compose mounted, and it cannot recreate itself to mount more. Two ways round it:

1. **The simple one** — if the disk is not in use yet, mount it *at* the current location:
   ```bash
   # /etc/fstab
   /dev/sdb1  /srv/backups  ext4  defaults  0 2
   ```
   Nothing in the panel changes.

2. **A different path** — tell compose about it:
   ```bash
   echo 'BACKUP_ROOT=/mnt/backups' >> deploy/.env
   ./provision/compose.sh up -d panel
   ```
   `provision/compose.sh` picks up `deploy/docker-compose.backup-root.yml` automatically whenever
   `BACKUP_ROOT` is set; it mounts the directory at the identical path inside the container, which is
   what the [sibling-container rule](architecture.md) requires. The value is adopted into server 1's
   row on the next boot; after that the panel is the source of truth. Until the mount exists, the
   Storage modal shows exactly these two commands instead of an Apply button — including when the
   directory does not exist on the host yet, because recreating the panel is what creates it.

**Moving what is already there.** Tick *"Move the existing backups there"* (or
`POST /api/servers/:id/backups/relocate {"to": "/mnt/backups"}`). Each backup is copied, its checksums
verified, the row repointed, and only then is the original removed — so an interrupted run leaves
every backup wholly at one location or the other, and re-running it finishes the job. Backups a job is
currently using are skipped and listed.

---

## Offsite copies

A backup on the same disk as the site survives a mistake. It does not survive the machine, the
provider, or somebody with your panel password. Offsite copies close that gap.

**Add a destination** in **Backups → Storage → Add remote destination**. From then on every new
backup is copied there automatically.

### How it works

Transfers run [rclone](https://rclone.org) in a container that lives for the length of one transfer,
**on the server that holds the backup**. The backup directory goes in as a read-only bind mount and
the data goes straight from that machine to the destination — it never passes through the panel, and
no server needs anything installed. Credentials are environment variables of that short-lived
container: never on the command line (which `ps` would show), never written to an `rclone.conf`.

Uploads run in their own job lane (`offsite:<serverId>`): at most one per server at a time, but they
never block that server's site operations — an upload can take hours.

Copies are driven by a reconciler that runs every minute rather than by a hook on backup creation, so
a panel restart mid-upload, a newly added destination and a re-enabled one all catch up on their own.

### Providers

| Preset | Covers |
|---|---|
| Amazon S3 | AWS S3 |
| S3-compatible | Backblaze B2 (S3 API), Cloudflare R2, Wasabi, Hetzner Object Storage, DigitalOcean Spaces, Scaleway, MinIO and anything else speaking S3 |
| SFTP | any machine you can log into over SSH — another VPS, a NAS, a storage box |
| FTP / FTPS | classic FTP hosting |
| WebDAV | Nextcloud, ownCloud, Hetzner Storage Box |
| Custom rclone | any other rclone backend, configured by hand |

**Test connection** in the form runs four probes — the rclone image is present, the root lists, a probe
file writes, the probe file deletes — and reports each one.

### Remote layout

```
<bucket-or-directory>/<prefix>/<slug>/<YYYYMMDD-HHMMSS>/{db.sql.gz, files.tar.gz, manifest.json, sha256sums}
```

The same shape as the local tree, `manifest.json` included, so a backup is identifiable with any
bucket browser and restorable by hand from one. The **prefix** defaults to the panel's own domain, so
two panels can share one bucket without colliding.

### Encryption (optional, off by default)

Switch **"Encrypt these backups before uploading"** on when adding a destination and rclone's
[crypt](https://rclone.org/crypt/) backend wraps it: file contents *and* file names are encrypted on
your own server, so the provider only ever holds ciphertext. Nobody who obtains the bucket — the
provider, a leaked key, whoever buys the disks — can read a customer's database.

The panel generates a **passphrase** and a **salt** and shows them to you once. rclone treats the
salt as a second password, so both halves are needed and both belong in your password manager.

> **If you lose the passphrase and lose `panel.db`, those backups are gone.** Not recoverable by you,
> by the provider, or by anybody. That is what the encryption is for, and it cuts both ways.

The crypt layer is anchored *at* the bucket and prefix, so those stay readable — an S3 bucket name
has to be literal, and the prefix is how two panels share one bucket. Everything below it is
ciphertext: site names, timestamps, file names and every byte of content.

**What it does not hide.** Encryption is not concealment. rclone stores modification times in the
clear and encrypted file sizes are within 16 bytes of the original, so somebody with the bucket can
still infer how many sites you host, roughly how large each one is, and exactly when your backups
run. It stops them reading the contents; it does not stop them counting.

**It cannot be changed later.** rclone has no way to re-key already-encrypted content, and the object
names themselves are derived from the passphrase — so turning encryption on or off would leave every
existing copy unreadable *and* unfindable. The panel fixes the setting once a destination holds its
first backup. Want the other behaviour? Add a second destination.

Verification uses `rclone cryptcheck` rather than `check`, because crypt stores no hashes and a plain
`check` would quietly degrade to comparing sizes.

**Re-adding a destination after losing `panel.db`.** Add it again with the same bucket and expand
*"I already have a passphrase for this bucket"* to paste both halves. The existing backups become
readable again, and **Fetch back** works on them.

### Retention

Each destination keeps its **own** count of scheduled backups per site (default 30, against 10
locally) — keeping more offsite than on the disk is the point of having both.

Local retention never destroys the last copy: a scheduled backup past its local retention that has a
completed offsite copy gives up its local files and stays listed as **offsite only**. One whose upload
has not finished yet is skipped that round rather than pruned out from under rclone.

A destination can be set to **"retention is managed by the provider"**, after which the panel never
deletes anything there. Use it with bucket lifecycle rules, Object Lock, or a key with no delete
permission — which is what makes a copy survive an attacker who reaches the panel.

### Deleting

- **Delete a backup** removes it everywhere, offsite copies included. `?keepOffsite=true` (a checkbox
  in the dialog) frees the disk and leaves the archive; the backup stays listed as offsite-only.
- A backup that is being uploaded right now cannot be deleted (409) — the upload would fail halfway
  and leave a partial object behind.
- **Several at once**: see [below](#deleting-several-at-once).
- **Remove a destination** forgets the copies and **leaves the objects in place** by default. The
  checkbox — or `?deleteRemote=true` — purges them first, as a job, and only ever touches the paths
  this panel wrote: never the whole prefix, which may be shared.

### Deleting several at once

Tick backups in the **Backups** list and **Delete** them together. Ticking the whole page of a
filtered list offers **Select all N** — every backup the filters match, on every page: all of one
site's (also reachable as **Bulk delete** on the site's Backups tab), all of a deleted site's, every
*Before an update* backup of the fleet. With no filter at all there is no such offer.

- Each backup goes as **Delete** takes one: offsite copies first, then the files and the record. A
  remote copy that cannot be removed keeps its backup, rather than leaving an object in the bucket that
  nothing knows about.
- One `backup.delete` job does it, oldest first, in a lane of its own (`backup-delete`), so purging
  remote copies never holds up a server's site work. Rows it has yet to reach say **Deleting…**, and
  nothing can restore, fetch or copy them meanwhile.
- A backup a job may be using is skipped: one whose site is being backed up, restored, moved or
  deleted, one being copied offsite, or one on a server whose backups are being moved to a new
  location. The job finishes the rest, then fails naming what it kept. A move to a new location, in
  turn, leaves alone whatever a deletion names.
- **Select all** takes the backups the filters match at that moment, by id, and keeps exactly those
  until the selection is cleared: a backup taken afterwards, or the backups of a site deleted
  afterwards, are not among them however the list refreshes (`GET /api/backups/ids`, docs/api.md).
- It is always typed for: `delete`, or the site's name where it takes everything a site has — every
  backup of a site, or the last complete ones of a deleted site.

### Fetching a backup back

An offsite-only backup gets a **Fetch back** button. The four files are downloaded onto the site's
**current** server, their checksums verified, and Restore and Download work normally afterwards. That
is also how a backup taken before a site moved gets restored: fetch it onto the new server.

### Failures

Failed copies back off 10 minutes → 1 hour → 6 hours and then stop. They stay listed in
**Backups → Storage → Recent failures** with the error and a **Retry** button, and the operator is
emailed at most once a day per destination (Settings → Mail → Send alerts to).

### Security

Destination credentials live in `panel.db` alongside every other credential the panel holds — site
database passwords, relay passwords — in plaintext, in a file with mode 600 inside a directory with
mode 700. The API never returns them; it only reports which fields are set. Encryption at rest would
be a change for the whole file, not for this table.

What that means in practice:

- **Use a key per panel, scoped to one bucket prefix.** The panel never needs `CreateBucket`
  (`--s3-no-check-bucket` is always on), so `List`/`Get`/`Put`/`Delete` on `<bucket>/<prefix>/*` is
  enough. Omit `Delete` and set retention to "managed by the provider".

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::my-backups",
        "Condition": { "StringLike": { "s3:prefix": ["panel.example.com/*"] } } },
      { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        "Resource": "arn:aws:s3:::my-backups/panel.example.com/*" }
    ]
  }
  ```

  Backblaze B2 and Cloudflare R2 have the same shape: an application key restricted to one bucket,
  read+write, optionally without delete.

- **Versioning or Object Lock** on the bucket turns an offsite copy into something an attacker who
  reaches the panel cannot destroy.
- **Plain FTP is cleartext** — the password and every byte of your backups. The form says so. Use
  explicit TLS unless the server genuinely cannot.
- **Pin the SFTP host key** (the optional "Host key" field, from `ssh-keyscan -t ed25519 <host>`) so a
  swapped server fails loudly instead of silently.
- **Credentials reach rclone as environment variables** of a container that exists for one transfer —
  never on the command line, where `ps` would show them. rclone's own "obscured" form is reversible
  by design (its documentation calls it protection against eyedropping, not encryption), so the panel
  additionally strips every known credential out of rclone's output before it reaches a job log, an
  error message or the Storage page.
- **Encryption protects the backups from the provider, not from the panel.** The passphrase is in
  `panel.db` next to everything else. What it buys you is that a bucket on its own is worthless.

---

## The panel's own state

Offsite copies of every site are still only half a recovery: what they cannot rebuild is the fleet —
which servers exist, which domains belong to which site, the DKIM key every sending domain published.
That lives in `panel.db`.

So the backup cron also takes a **panel** backup on server 1:

`<backup root>/panel/<ts>/{panel.db.gz, manifest.json, sha256sums}`

It uses SQLite's online backup API, so it is consistent without stopping the panel, and it is copied
offsite like any other backup. The fleet SSH private key is deliberately **not** included: it is the
key to every machine you own, and a bucket is not where it belongs.

Restoring it is manual, and rare:

```bash
cd /opt/wpl7
docker compose stop panel
gunzip -c /srv/backups/panel/<ts>/panel.db.gz > /srv/panel/panel.db
chmod 600 /srv/panel/panel.db
docker compose start panel
```

The panel then puts every server back in line with what that database says - including its FTP
logins: ones deleted after the backup was taken come back, and ones created since are gone.

## Manual restore without the panel

```bash
cd <backup root>/<slug>/<ts>
sha256sum -c sha256sums
# database (root password: grep MARIADB_ROOT_PASSWORD /opt/wpl7/deploy/.env)
zcat db.sql.gz | docker exec -i wpl7-mariadb mariadb -uroot -p"$PW" wp_<slug>
# files
docker stop wp-<slug>
tar -xzf files.tar.gz -C /srv/sites/<slug>/
chown -R 33:33 /srv/sites/<slug>/wordpress
docker start wp-<slug>
```

### …from a bucket, without this panel at all

The remote layout is plain files, so any rclone or `aws` client will do:

```bash
rclone copy :s3,provider=AWS,access_key_id=…,secret_access_key=…:my-backups/panel.example.com/shop/20260920-030000 ./restore
# or
aws s3 sync s3://my-backups/panel.example.com/shop/20260920-030000 ./restore
cd ./restore && sha256sum -c sha256sums
```

`manifest.json` tells you the database name, the table prefix, the PHP and WordPress versions and the
domains the site had — enough to rebuild it anywhere.

### …from an *encrypted* bucket

Same thing with a crypt remote in front. Obscure both halves first — rclone's config stores them that
way — then point `remote` at the bucket and prefix, exactly where the panel anchored it:

```bash
rclone obscure 'the-passphrase'   # -> paste as password
rclone obscure 'the-salt'         # -> paste as password2
```

```ini
# ~/.config/rclone/rclone.conf
[dest]
type = s3
provider = AWS
access_key_id = …
secret_access_key = …
region = eu-central-1

[vault]
type = crypt
remote = dest:my-backups/panel.example.com
password = <obscured passphrase>
password2 = <obscured salt>
```

```bash
rclone lsd vault:                                      # site names, decrypted
rclone copy vault:shop/20260920-030000 ./restore
cd ./restore && sha256sum -c sha256sums
```

Nothing here needs this panel — only rclone and the two secrets. Which is the whole point of writing
them down somewhere else.
