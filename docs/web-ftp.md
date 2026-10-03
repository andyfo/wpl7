# Web FTP: a site's files in the browser

Every site has a **Files** tab: its WordPress folder, from `wp-config.php` down. Browse it, edit
files in a code editor, upload, download, rename and move, copy, delete, change permissions,
zip and unzip, and search by name or by content. An entry's actions are in its **⋯** menu, which
a right-click anywhere on its row opens too, where you clicked. Everything the tab does is in the
REST API too ([below](#the-api)).

For a desktop client, a site can also have its own FTP and SFTP logins, which follow the same
rule as this tab: [ftp.md](ftp.md).

## What it can do, and why it can do no more

Every operation runs **inside the site's own container, as the site's own user (`www-data`,
uid 33)**. The Files tab can do exactly what the site's PHP can do, and nothing else.

That is a deliberate limit. A compromised WordPress can plant symlinks: `wp-content/x` pointing
at `/srv/sites/<another-site>/wordpress/wp-config.php`, or at the panel's own database. Followed
on the host - or in the panel's container, which is root and mounts every site - one such link
reads or overwrites another customer's files. Followed inside the site's container, the same
link leads nowhere the site could not already reach. (Web file managers that resolved paths
on the host have shipped exactly this bug: File Browser's CVE-2026-54094, and the two
follow-ups that its first fix missed.) Running on the host as uid 33 would not be enough
either: every site's files are uid 33 on the host.

What follows from it:

- **The site has to be running.** A stopped site's tab offers **Start the site**.
- **Files owned by root are read-only here**, with a lock next to them - what a root shell
  (the web terminal) or an old panel left behind. **⋯ → Fix ownership** hands everything in
  the current folder back to `www-data`. It is the one operation of the tab that runs as root,
  still inside the container, and it changes symlinks themselves (`chown -R -h`), never what
  they point at. A folder on the way that turned out to be a symlink is refused, so a site
  cannot aim it at the container's own files.
- **While a restore, a move, a re-creation or a delete runs on the site, changes are refused**
  (`409 job_conflict`) - the job would replace the folder and take the edit with it. It works
  the other way round too: a job queued while a change is being made starts once the change is
  done. Browsing and downloading carry on, and a backup never blocks anything: it only reads.

## Editing

Click a text file to open it in the editor (CodeMirror, with highlighting for PHP, JavaScript,
CSS, HTML, JSON, XML, Markdown, YAML, SQL, ini/`.htaccess` and shell). **Cmd/Ctrl-S** saves.

- **A save never lands half-written.** The new content goes to a temporary file beside the old
  one, is checked, and takes its place in one rename - a visitor never runs half a
  `functions.php`. The file keeps its permissions; a link is written through, as an editor would.
- **PHP is checked before it is saved**, with the site's own PHP version (`php -l`). A file that
  does not parse is refused with the line of the error - **Go to line**, fix it, or **Save
  anyway** if you mean it. This is the check that turns a typo in `functions.php` into a message
  instead of a white screen.
- **A save only replaces the version you opened.** When the file changed on the server
  meanwhile - a plugin update, a colleague - the save is refused and you choose: **Overwrite with
  mine**, or **Load theirs** and discard your changes. Two people saving the same version at the
  same moment is the same case: one save lands, the other is refused.
- **Nothing is lost by accident.** Leaving the page, closing the editor or pressing Back with
  unsaved changes asks first. An expired session, or the panel not answering for a while, keeps
  your text: the page stays where it is, and a save that fails says to sign in again in another
  tab.
- Encoding is kept exactly: a UTF-8 BOM stays, CRLF line endings stay. A file that mixes line
  endings is saved with `\n` throughout, and the editor says so before you save.
- Files over 8 MiB, binary files and text that is not UTF-8 are not edited here: they download
  (non-UTF-8 text is shown read-only). Images open in a preview; an SVG can also be edited as text.

## Uploading

Drop files anywhere on the tab, or use **Upload**. Up to three go up at once while you keep
browsing; each shows its progress and can be cancelled or retried. A file that would replace an
existing one is asked about first.

- **Up to 2 GiB per file.** Files go up in chunks sized to your connection (about ten seconds
  each), because Traefik ends any request that takes longer than 60 seconds to arrive - that
  limit protects every site on the server and stays as it is. A chunk lost on the way is sent
  again; the upload carries on from what the server has. That includes the last chunk: if its
  answer is lost after the file was put in place, sending it again gets the same answer.
- **At least 1 GiB must stay free** on the server's disk: an upload that would leave less is
  refused before the first byte, because a full disk stops MariaDB and every site with it.
- Folders cannot be dropped as they are: zip the folder, upload the `.zip`, and **Extract** it.
- While a file uploads it is assembled as `.wpl7-upload-<id>.part` in the target folder and
  renamed into place with its last chunk. Parts left behind by an abandoned upload are removed
  after a day, the next time an upload starts in that folder. Names starting with `.wpl7-` are
  reserved for these.

## Downloading

A file downloads as it is; a folder as `.tar.gz` (the whole site folder as `<site>.tar.gz`, so it
unpacks into a folder of its own). The panel's temporary files are left out. At most three
downloads run at a time per server - they share its SSH connection with everything else when the
site is on another server.

## Zip archives

**Extract** (on a `.zip`) and **Compress** (on one entry, or several selected in one folder) run as
jobs, with their progress in the tab. They use PHP's zip support inside the container, so no site
needs a newer image first.

Extraction checks the whole archive before it writes anything, and refuses it whole when an entry
would land outside the folder (`../`, an absolute path, a drive letter - the "zip-slip" attack).
Symlinks inside an archive are skipped, nothing is written through a symlink already on disk, and
nothing existing is replaced unless you tick **Replace files that are already there** - otherwise the
job lists what is in the way. An entry that inflates past the size the archive declares stops the
job. Compressing never follows a symlink.

## Search

**Search** finds things under the current folder:

- **File names** - part of a name, case-insensitive unless you say otherwise.
- **Contents** - plain text by default, a regular expression if ticked, optionally only in files
  matching patterns like `*.php,*.js`. Binary files are skipped, and each file shows at most 20
  matching lines. Clicking a line opens the file at it.

It is the tool for "which files call `eval(base64_decode(`". A search stops after 1,000 matches or
45 seconds and says so; search a smaller folder to see the rest.

## Limits

| | |
|---|---|
| A file opened in the editor, and one save | 8 MiB |
| One upload | 2 GiB, in chunks of at most 8 MiB |
| Free space an upload, copy or extraction must leave | 1 GiB |
| Entries listed per folder | 10,000 (search finds the rest) |
| Search | 1,000 matches, 45 s |
| Entries one delete or compress request may name | 200 (the tab deletes more in batches) |
| Downloads at once, per server | 3 |

## Who changed what

Every change, every download and every read of a file's content is one line in the panel's log,
naming the admin (or the API key) and the path:

```bash
docker logs wpl7-panel 2>&1 | grep '"files"'
```

API keys also leave their usual row in **API keys → Activity**, without the path (the activity log
drops query strings).

## The API

The same operations, for your own tooling ([api.md](api.md#files-web-ftp) lists every endpoint).
Paths are relative to the site's WordPress folder; `path=` (empty) is the folder itself.

```bash
API="https://panel.example.com/api"; AUTH="Authorization: Bearer $TOKEN"

# A folder
curl -s "$API/sites/customer-shop/files?path=wp-content/themes" -H "$AUTH"

# Read a file, keeping its ETag for a conditional save
curl -s -D headers.txt -o functions.php "$API/sites/customer-shop/files/content?path=wp-content/themes/shop/functions.php" -H "$AUTH"
ETAG=$(grep -i '^etag:' headers.txt | tr -d '\r' | cut -d' ' -f2)

# Save it back - only if nobody changed it meanwhile (412 otherwise), and only if it parses (422 otherwise)
curl -sX PUT "$API/sites/customer-shop/files/content?path=wp-content/themes/shop/functions.php&lint=php" \
  -H "$AUTH" -H "If-Match: $ETAG" -H 'content-type: application/octet-stream' --data-binary @functions.php

# Create a file that must not exist yet (If-Match: * is the opposite: only replace one that does)
curl -sX PUT "$API/sites/customer-shop/files/content?path=robots.txt" -H "$AUTH" -H 'If-None-Match: *' \
  -H 'content-type: application/octet-stream' --data-binary $'User-agent: *\nDisallow:\n'
```

**Uploading** is a PUT per chunk to `/files/uploads/<id>`, where `<id>` is any 16-64 characters of
`A-Za-z0-9_-` you choose for this upload. Each chunk says where it goes (`offset`, the bytes sent so
far) and how big the whole file is (`size`); the chunk that completes the file puts it in place and
answers `{"written": {...}}`. A chunk for the wrong offset answers `409` with `details.received`:
continue from there. Sending the completing chunk again (its answer got lost) returns the same
`{"written": {...}}` for ten minutes, without writing anything.

```bash
FILE=video.mp4; SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE"); ID=$(uuidgen)
CHUNK=$((8 * 1024 * 1024)); OFFSET=0
while [ "$OFFSET" -lt "$SIZE" ] || [ "$SIZE" -eq 0 ]; do
  dd if="$FILE" bs=$CHUNK skip=$((OFFSET / CHUNK)) count=1 2>/dev/null |
    curl -sfX PUT "$API/sites/customer-shop/files/uploads/$ID?path=wp-content/uploads/$FILE&offset=$OFFSET&size=$SIZE" \
      -H "$AUTH" -H 'content-type: application/octet-stream' --data-binary @- || exit 1
  OFFSET=$((OFFSET + CHUNK)); [ "$SIZE" -eq 0 ] && break
done
```

`DELETE /files/uploads/<id>?path=…` abandons an upload and removes what arrived of it. Add
`&overwrite=true` to replace an existing file.
