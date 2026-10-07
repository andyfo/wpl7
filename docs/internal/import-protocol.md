# Import protocol, version 1

How the panel copies an existing WordPress site through the WPL7 Migrate plugin. This document is
normative: the plugin (`panel/migrate-plugin/wpl7-migrate/`) implements it, and the panel's pull
client must follow it. Change them together, and change this document in the same pull request.

The shared test vectors are in `panel/test/fixtures/migrateProtocol.json`. The plugin checks itself
against them with `php panel/migrate-plugin/tests/run.php` (CI runs it on PHP 7.0 and 8.5), and the
panel's tests read the same file. `panel/migrate-plugin/tests/client.php` is a signed client for
trying a real site by hand.

The plugin is installed on the old site from a zip the panel builds. The panel writes
`connection.php` into the zip and replaces the version string `0.0.0-dev` in `wpl7-migrate.php`:

```php
<?php
// WPL7 Migrate: the panel this download came from. Read once at activation, then deleted.
defined('ABSPATH') || exit;
return array('panel' => 'https://panel.example.com', 'import' => 12, 'token' => '<43 chars base64url>', 'issued' => 1759843200);
```

The token is 32 random bytes, base64url without padding: 43 characters of `[A-Za-z0-9_-]`. The
plugin's admin page calls it the connection code.

## 1. Addresses and reachability

The panel reaches the plugin at the report's `endpoint`, an absolute URL on the same host as `home`.
`endpoint` is what WordPress's `rest_url('wpl7-migrate/v1/')` gives, and the action's name is
appended to it:

| Permalinks | `endpoint` | `ping` is at |
|---|---|---|
| Pretty | `https://old.example/wp-json/wpl7-migrate/v1/` | `https://old.example/wp-json/wpl7-migrate/v1/ping` |
| Plain | `https://old.example/index.php?rest_route=/wpl7-migrate/v1/` | `https://old.example/index.php?rest_route=/wpl7-migrate/v1/ping` |

There are two transports. Both take a POST with a JSON body, and both answer byte for byte the
same:

- **REST**: `{endpoint}{action}`.
- **Query**: `{home}/?wpl7-migrate={action}`, handled on WordPress's `init` at priority 0, before
  page caches, for hosts that block `/wp-json/`. Only a POST that carries the query variable is
  the plugin's; a GET with it is the site's ordinary page. It defines `DONOTCACHEPAGE`.

The panel probes REST first, then the query transport, and remembers what worked. A pretty
`endpoint` can still fail when the server does not route `/wp-json/` to WordPress (no rewrite rules,
a security plugin, a WAF); the server's own 404 or a challenge page then comes back without the
protocol header, and the query transport is the way in.

The panel's side of the connection:

- Only `https:` unless the import allows HTTP; ports 80 and 443 only; no userinfo.
- The host must resolve to public addresses only. Private, loopback, link-local and
  `::ffff:`-mapped private addresses are refused, and a mixed answer fails closed.
- The connection is pinned to the vetted address, and any 3xx is an error.

Every response from the plugin, errors included, carries `X-WPL7-Protocol: 1` and
`Cache-Control: no-store, no-transform`, with `X-Content-Type-Options: nosniff` and
`X-Robots-Tag: noindex, nofollow`, unless output was already sent before the plugin answered (a
plugin printing before `init`): then the body arrives without them. A response without
`X-WPL7-Protocol` (a WAF page, a challenge, a server's 404) is reported as "the old host answered
with something else", and the message names the fix: allow the panel's address, or a WAF skip rule
for the two paths. JSON responses are `application/json; charset=utf-8`. Every response has a
`Content-Length`, except where PHP's `zlib.output_compression` is on and cannot be turned off.

The plugin ends the response before WordPress's shutdown hooks run, so nothing a plugin prints at
shutdown reaches the panel.

## 2. Signing

Every request from the panel is signed. Four values travel as headers:

```
X-WPL7-Import-Id: <id>               decimal, no leading zero
X-WPL7-Timestamp: <unix seconds>     decimal, no leading zero
X-WPL7-Nonce: <32 lowercase hex>
X-WPL7-Signature: v1=<64 lowercase hex>
```

For hosts that strip custom headers, the same four may travel as query parameters `_id`, `_ts`,
`_nonce` and `_sig` (the last one also `v1=<hex>`). Each value is taken from its header when that
is present and not empty, else from its query parameter.

```
canonical = "WPL7-MIGRATE-V1\n" + import_id + "\n" + action + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(body_bytes)
signature = hex(HMAC-SHA256(key = token as UTF-8 bytes, message = canonical))
```

`action` is the action's name as the URL gives it. The body hash covers the exact bytes sent; an
empty body hashes as the empty string. Send `Content-Type: application/json; charset=utf-8`.

The plugin answers only while it holds a token, and checks in this order:

1. The action is one it knows, else **404** `not_found` with `detail: "action"`. On the REST
   transport a method other than POST is **405** `method_not_allowed`, with `Allow: POST`.
2. The body is at most 1 MiB, else **413** `too_large` with `detail: "body"`.
3. A token and an import id are stored, the four values are well formed, and the import id equals
   the stored one, else **401** `unauthorized`. The import id comes from `connection.php` and is
   replaced by the one the panel returns from `connect`.
4. The signature matches (`hash_equals`), else **401** `unauthorized`.
5. `|now - timestamp| <= 300`, else **401** `stale` with the plugin's clock:
   `{ "error": { "code": "stale", "time": 1759843200 } }`. The panel corrects its offset and tries
   once more. It checks after the signature, so only the panel learns the plugin's clock from it.
6. The plugin's two tables exist, or are created again (section 6).
7. The nonce is new, else **401** `replay`. Nonces are kept in `{prefix}wpl7_migrate_nonces` for
   600 seconds, twice the window, so no accepted timestamp can repeat one. Older rows are deleted
   on every signed request.

Steps 1 to 5 read options and write nothing, so a request that is not the panel's never writes
to the database.

The vectors' `signature` cases give the canonical string and the signature for fixed inputs, and
`timestamps` the edges of the window.

## 3. Plugin to panel

| Call | Request | Success | Failures |
|---|---|---|---|
| connect | `POST {panel}/api/migrate/connect`, header `X-WPL7-Import-Token: <token>`, body the report (section 4) | `200 { "ok": true, "import": { "id", "status", "label" }, "panel_version" }` | 401 `unauthorized` (bad or expired token), 409 `conflict` (import already running or bound to another `home`), 410 `gone` (import deleted), 426 `protocol_unsupported { min, max }`, 503 (maintenance; retry) |
| status | `GET {panel}/api/migrate/status`, same header | `200 { "status", "phase", "filesDone", "filesTotal", "bytesDone", "bytesTotal", "tablesDone", "tablesTotal", "siteUrl"?, "message"? }` | as above |

Both go through `wp_remote_*` with `timeout` 15 seconds, `sslverify` on, `redirection` 0 (the token
goes to the address the panel gave and nowhere else) and `User-Agent: WPL7-Migrate/<version>`.

The token travels over https only, with one exception: plain http to this machine or a private
network, where nobody on the way can read it. That is a host that is an IP address in a loopback or
private range (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1, fc00::/7, and
IPv4-mapped forms of those), `localhost` or a name under `.localhost`, or a name whose every IPv4
and IPv6 address is one of those. A panel's own test can then write `http://host.docker.internal:<port>`
into `connection.php`. The plugin asks before every call, since what a name resolves to can change,
and the admin page's form refuses any other http address with "The panel address must use https."
A `connection.php` naming one is still read, and the page then shows the same line instead of
connecting.

`connect` is idempotent for the same `home`. The panel binds the token to the first `home` it sees
and refuses another. The plugin calls it only from its admin page, Tools > WPL7 Migrate:

- Activation takes the administrator to that page (not from WP-CLI, and not in a bulk
  activation). The page connects on its own when the plugin has a code but has not connected yet,
  at most once a minute, so a panel that is down does not hold every reload for the timeout. This
  is what makes the site connect "on its own" after activation.
- **Connect** (with a code entered by hand, or again after a failure) and **Check again** (a fresh
  report once connected) call it too.

`status` is read when the page opens while connected, and kept for 5 seconds. A 410 from either
call, or a 401 from `status`, means the panel let go of the site: the plugin forgets the token
(section 10). A 401 from `connect` is a code the panel does not know, which the administrator can
correct.

The page shows the panel's `status`: `connected` or `pending` as connected, with the report's
facts; `queued`, `pulling`, `pulled` and `finishing` as progress from `filesDone`/`filesTotal`,
`bytesDone`/`bytesTotal` and `tablesDone`/`tablesTotal`, reloading itself every 10 seconds;
`done` with `siteUrl`; `failed` with `message`; `expired`.

## 4. The report

The body of `connect`, and the answer to `info`. Values as implemented:

```json
{
  "protocol": 1,
  "plugin": "1.2.3",
  "time": 1759843200,
  "endpoint": "https://old.example/wp-json/wpl7-migrate/v1/",
  "home": "https://old.example",
  "siteurl": "https://old.example",
  "abspath": "/var/www/html/",
  "abspath_real": "/var/www/html/",
  "document_root": "/var/www/html/",
  "content_dir": "/var/www/html/wp-content",
  "uploads_dir": "/var/www/html/wp-content/uploads",
  "multisite": false,
  "windows": false,
  "table_prefix": "wp_",
  "wp": "7.1.2",
  "php": "8.3.35",
  "locale": "en_US",
  "charset": "utf8mb4",
  "collation": "utf8mb4_unicode_520_ci",
  "blog_public": 1,
  "admin_email": "admin@example.com",
  "title": "Example",
  "https": true,
  "db": {
    "server": "MariaDB 11.8.9",
    "bytes": 23414824,
    "tables": [{ "name": "wp_options", "rows": 140, "bytes": 1589248, "pk": ["option_id"], "collation": "utf8mb4_unicode_520_ci" }],
    "views": 1, "triggers": 1, "routines": 0, "events": 0
  },
  "constants": [{ "name": "WP_DEBUG", "value": false, "type": "bool" }],
  "dropins": ["object-cache.php"],
  "mu_plugins": [{ "file": "host-tweaks.php", "name": "Host tweaks" }],
  "plugins": [{ "file": "akismet/akismet.php", "slug": "akismet", "name": "Akismet Anti-spam", "version": "5.7.2", "active": false }],
  "theme": { "slug": "twentytwentyfive", "name": "Twenty Twenty-Five", "version": "1.5", "template": "twentytwentyfive" },
  "htaccess": { "present": true, "custom": false },
  "user_ini": false,
  "php_ini": false,
  "files": { "count": 3790, "bytes": 115324744, "dirs": 471, "links": 5, "unreadable": 1, "excluded": ["wp-config.php", "*.log"] },
  "warnings": []
}
```

- `time` is the plugin's clock, like `ping.time`.
- `endpoint` is described in section 1.
- `abspath` is ABSPATH as WordPress defines it: search and replace in the database uses it.
  `abspath_real` and `document_root` are both resolved with `realpath()` and end in `/`, so they can
  be compared even where the document root is a symbolic link. `document_root` is null when the
  server does not set it.
- `charset` and `collation` are WordPress's database connection's (`$wpdb->charset`,
  `$wpdb->collate`).
- `blog_public` is 1 only when the option is exactly 1; a private site's -1 is 0.
- `https` says whether `home` starts with `https:`.
- `db.tables` lists base tables (and MariaDB's system-versioned tables) of the whole database,
  other prefixes included, without the plugin's own two. `pk` is the key the table is paged by
  (section 9), null when it is paged by offset. `rows` is the server's estimate. At most 5000
  tables; more add the warning `tables_truncated`.
- `constants`: the names come from a token scan of wp-config.php (next to WordPress or one folder
  up), never run; the values are the constants' values now, so a value wp-config.php computes is
  sent as it came out. Only strings, booleans, integers, floats and null, names matching
  `^[A-Z][A-Z0-9_]{0,63}$`, at most 500. A string longer than 2000 bytes, or not valid UTF-8, is
  left out with the warning `constant_skipped`. Without the tokenizer or a readable file the list is
  empty, with the warning `constants_unread`.
- `files` comes from a quick walk with the default excludes, links not followed. It stops after 20
  seconds, or sooner when the request has less time, and then says `"partial": true`. `count` and
  `bytes` are regular files; `excluded` lists the patterns that left something out.
- `plugins` at most 2000, else the warning `plugins_truncated`.
- Text from options and plugin headers is made valid UTF-8 (section 7).

Blocklisted names, never sent: `DB_NAME DB_USER DB_PASSWORD DB_HOST DB_CHARSET DB_COLLATE`, the eight
keys and salts, `WP_HOME WP_SITEURL ABSPATH WP_CONTENT_DIR WP_CONTENT_URL WP_PLUGIN_DIR WP_PLUGIN_URL
WPMU_PLUGIN_DIR UPLOADS COOKIE_DOMAIN WP_CACHE WPCACHEHOME DISABLE_WP_CRON WP_TEMP_DIR FS_METHOD
FTP_*`, `MULTISITE WP_ALLOW_MULTISITE SUBDOMAIN_INSTALL DOMAIN_CURRENT_SITE PATH_CURRENT_SITE
SITE_ID_CURRENT_SITE BLOG_ID_CURRENT_SITE`. The panel applies the same blocklist again.

## 5. Actions

All POST with a JSON object as the body (`{}` or an empty body when there are no parameters).
Responses are JSON unless noted. A parameter of the wrong type or out of range is **422**
`unsupported` with `detail` naming it, for example `{ "error": { "code": "unsupported", "detail": "limit" } }`.

| Action | Params | Response |
|---|---|---|
| `ping` | none | limits and capabilities |
| `info` | none | the report of section 4, fresh |
| `snapshot` | `op`, and for `start`: `follow`, `since`, `exclude`; `budget_ms`, `snapshot_id` | walk state |
| `files` | `snapshot_id`, `after`, `limit` | a page of the file list |
| `range` | `id`, `offset`, `length`, `encoding`, `if_changed`, `snapshot_id` | bytes of one file |
| `bundle` | `snapshot_id`, `ids`, `max_bytes`, `encoding` | several small files whole |
| `tables` | none | the tables |
| `sql` | `table`, `cursor`, `max_bytes`, `encoding` | a page of SQL |
| `maintenance` | `on`, `ttl_s` | the gate's state |
| `finish` | none | `{ "ok": true }` |

### ping

```json
{
  "protocol": 1,
  "plugin": "1.2.3",
  "time": 1759843200,
  "limits": { "max_ms": 10000, "max_bytes": 8388608, "max_row_bytes": 15728640 },
  "transports": ["rest", "query"],
  "encodings": ["raw", "base64", "gzip"],
  "actions": ["ping", "info", "snapshot", "files", "range", "bundle", "tables", "sql", "maintenance", "finish"]
}
```

`encodings` are the ones `range` can answer with; `gzip` is there only when PHP has zlib, and then
`sql` and `bundle` can use it too. `actions` lists what this plugin answers, so the panel can tell
whether `bundle` exists. `limits` are in section 11.

### snapshot

`{ "op": "start" | "continue" | "status", "follow"?: "none" | "inside", "since"?: <unix>, "exclude"?: [<pattern>], "budget_ms"?: <ms>, "snapshot_id"?: <id> }`

- `start` empties the file table and begins a new walk with a new `snapshot_id`, then walks until
  the request's time is up. `follow`, `since` and `exclude` are given here (defaults `none`, none,
  none). `exclude` adds up to 200 patterns (section 7) to the defaults.
- `continue` walks on until `done` or the time is up. With `snapshot_id`, a different current
  snapshot is **409** `snapshot_stale`, as is having no snapshot at all.
- `status` reads the totals, and walks nothing.
- `budget_ms` shortens the request's time (section 11). Present, it must be a positive integer,
  else **422** with `detail: "budget_ms"`.
- A folder is walked only where it was found: its real path, every link on the way resolved, must
  still be its own path under ABSPATH (or, for a followed link, the real path found when it was
  listed). It is checked before and after the folder is read, and before each batch of entries is
  stored. A folder that has become, or now sits under, a link elsewhere is flagged `unreadable` and
  not walked.
- One walk at a time: another `start` or `continue` meanwhile is **409** `busy`.

```json
{
  "snapshot_id": "93defb66b8123e79",
  "done": true,
  "entries": 4266,
  "bytes": 115324779,
  "files": 3790,
  "dirs": 471,
  "dirs_pending": 0,
  "warnings": [
    { "code": "link", "count": 5 },
    { "code": "unreadable", "count": 1 },
    { "code": "special", "count": 1 },
    { "code": "excluded", "detail": "wp-content/cache/**", "count": 1 }
  ]
}
```

`entries` counts everything listed, folders and links included; `bytes` and `files` are regular
files. Before any snapshot, `status` answers `snapshot_id: null`, `done: false` and zeros.
`warnings` counts entries by flag (section 7), plus `special` (sockets, fifos and devices, which are
not listed), `too_long` (paths over 4096 bytes, not listed) and `excluded` once per pattern, with
how many entries it left out. A folder left out counts once; nothing below it is looked at.

With `follow: "inside"`, a link whose target is inside ABSPATH and not left out is listed as what
it points to: a file entry, or a folder entry that is walked. Both keep the flag `link` and the
target in `l`. A folder that contains the link, or one of the folders above it as the walk reached
them, gets the flag `cycle` and is not walked. Other links stay links.

With `since`, a regular file whose mtime and ctime are both earlier gets the flag `unchanged`. It is
still listed, so the panel can tell what was deleted.

### files

`{ "snapshot_id": "...", "after": 0, "limit": 1000 }`; `limit` from 1 to 5000. A different
`snapshot_id` is **409** `snapshot_stale`; a walk that is not `done` is **409** `busy` with
`detail: "walking"`.

```json
{
  "entries": [
    { "id": 2, "p": "index.php", "s": 405, "m": 1759843200, "md": "0644", "t": "f", "h": "<sha256 hex>" },
    { "id": 17, "p": "wp-content/uploads", "s": 0, "m": 1759843200, "md": "0755", "t": "d" },
    { "id": 871, "p": "wp-content/uploads/caf�.txt", "pb": "d3AtY29udGVudC91cGxvYWRzL2NhZukudHh0", "s": 15, "m": 1759843200, "md": "0644", "t": "f", "h": "<sha256 hex>" },
    { "id": 880, "p": "wp-content/uploads/link-to-index", "s": 0, "m": 1759843200, "md": "0777", "t": "l", "f": ["link"], "l": "../../index.php" }
  ],
  "next": 1000
}
```

Entries come in id order, which is the order the walk found them in: breadth first by folder, and
by name in byte order within one. `next` is the last id of this page when more follow, else null;
pass it as `after`.

| Key | Meaning |
|---|---|
| `id` | The entry's id, for `range` and `bundle` |
| `p` | Path relative to ABSPATH, `/`-separated, never with a leading `./` or `/`, as displayable UTF-8 (section 7) |
| `pb` | The path's exact bytes in base64, only when they are not valid UTF-8; use it when present |
| `s` | Size in bytes; 0 for folders and links |
| `m` | mtime, unix seconds |
| `md` | Permission bits as four octal digits, `0644` |
| `t` | `f` file, `d` folder, `l` link |
| `f` | Flags, when there are any (section 7) |
| `l`, `lb` | A link's target as `readlink()` gives it, displayable, and its bytes when not valid UTF-8 |
| `h` | sha256 of a regular file of at most 1 MiB, while the request has time and the file still matches its listing |

ABSPATH itself is not listed. Folders are entries of their own, so empty folders survive.

### range

`{ "id": 42, "offset": 0, "length": 1048576, "encoding"?: "raw" | "base64" | "gzip", "if_changed"?: "error" | "refresh", "snapshot_id"?: "..." }`

`length` from 1 to `limits.max_bytes`, else **413** `too_large` with `detail: "length"` and the
limit in `max_bytes`. The answer is `length` bytes, or fewer at the end of the file; past the end it
is empty. Pass `snapshot_id`: ids mean nothing across snapshots, and a different one is **409**
`snapshot_stale`.

`raw` answers `application/octet-stream`, the bytes as the body, with headers:

```
X-WPL7-Size: <file size now>
X-WPL7-Mtime: <file mtime now>
X-WPL7-Range-Sha256: <sha256 hex of exactly the bytes in this body>
X-WPL7-Sha256: <sha256 hex of the whole file>     only when the file is at most 1 MiB
```

`base64` and `gzip` answer JSON, with the same headers:

```json
{ "data": "<base64>", "size": 5242880, "mtime": 1759843200, "sha256": "<sha256 of this range's bytes>", "file_sha256": "<whole file, at most 1 MiB>" }
```

`data` is the range's bytes in base64, or (`gzip`) the base64 of `gzencode()` of them. `sha256` is
always of the decoded file bytes.

The file is checked again before it is read: it must still be a regular file (or, for a followed
link, still point at one), inside ABSPATH once every link on the way is resolved, at its own path
when links are not followed, and not left out. Otherwise **404** `not_found` with `detail`:
`missing` (gone, replaced by a link, now pointing elsewhere, or not a file entry), `unreadable`
(flagged at listing or cannot be opened), `too_large` (flagged at listing), `excluded` (the path, or
where a link now points, is left out).

PHP cannot open a file relative to a folder it has checked, so the time between the check and the
read is narrowed instead. The file is opened right after the check, and the open file must be the
very one the check found (device and inode) at the same real path; a file replaced in between is
checked once more, then `missing`. The bytes are read from that open file. After the read the path
must still lead to it (device and inode), with the same size and mtime.

A file whose size or mtime differs from its listing is **409** `changed`, with what it is now:
`{ "error": { "code": "changed", "size": 18, "mtime": 1893456000 } }`. With `if_changed: "refresh"`
and `offset: 0` it is served instead, and its listing takes the new size and mtime, so the rest of
the file follows without `refresh`. A file that changes, or is replaced, while it is read is
**409** `changed` too, with the size and mtime of what its path now holds, checked as before.

### bundle

`{ "snapshot_id": "...", "ids": [3, 4, 5], "max_bytes"?: 4194304, "encoding"?: "base64" | "gzip" }`

Several small files whole, so a site of many small files does not cost a request each. `ids` holds 1
to 500 ids; `max_bytes` from 1 to `limits.max_bytes` (default the limit; above it is **413**);
`encoding` defaults to `base64`. A different `snapshot_id` is **409** `snapshot_stale`.

The files are read in the order given, each opened and checked as `range` does. The plugin stops
before the bytes read would pass `max_bytes`, counting file sizes before encoding, and always
answers for the first id. It also stops when the request's time is up, after the first id. A file
larger than 1 MiB, or than `limits.max_bytes`, is refused per entry with `too_large`, and goes
through `range`. That holds for a file that grows past the cap while it is read, too: the plugin
reads one byte more than the cap, so such a file is never sent cut short as if whole.

```json
{
  "files": [
    { "id": 3, "size": 15, "mtime": 1759843200, "sha256": "<sha256 hex>", "data": "<base64>" },
    { "id": 4, "size": 10, "mtime": 1924992000, "sha256": "<sha256 hex>", "data": "<base64>", "changed": true },
    { "id": 5, "error": "not_a_file" }
  ],
  "next": 6
}
```

`size`, `mtime` and `sha256` describe the bytes read now, not the listing; `changed: true` marks a
file whose size or mtime differs from its listing, and the panel uses what it got. A file that
changes while it is read is read once more; if it changes again, the last read is returned and
described. `error` is one of `missing`, `unreadable`, `too_large`, `excluded`, `not_a_file`, as for
`range`. `next` is the first id not answered for, or null when all were.

### tables

```json
{
  "tables": [{ "name": "wp_posts", "rows": 504, "bytes": 2637824, "pk": ["ID"], "collation": "utf8mb4_unicode_520_ci", "engine": "InnoDB", "avg_row": 3998 }],
  "prefix": "wp_"
}
```

As `db.tables` in the report, with `engine` and `avg_row`, and WordPress's table prefix.

### sql

`{ "table": "wp_posts", "cursor": "", "max_bytes"?: 8388608, "encoding"?: "json" | "gzip" }`

`table` must match `^[A-Za-z0-9_]{1,64}$` and start with the site's table prefix (else **422**
with `detail: "table"`: where several sites share one database, the others' tables are not the
panel's to read, and `tables` lists them only for the panel's warning). It must be a base table: a
view is **422** `unsupported` with `detail: "view"`, a table that does not exist, or one of the
plugin's own, **404** `not_found`.
`max_bytes` from 1 to `limits.max_bytes` (default the limit; above it is **413**). A cursor that is
not one of ours, or does not fit the table (an offset for a keyed table, a key of the wrong length),
is **422** with `detail: "cursor"`.

```json
{ "sql": "DROP TABLE IF EXISTS `wp_posts`;\nCREATE TABLE `wp_posts` ( ... );\nINSERT INTO `wp_posts` (...) VALUES (...),(...);\n",
  "next": "k:[\"512\"]", "rows": 1200, "skipped": [], "sha256": "<sha256 hex of the SQL text>" }
```

With `encoding: "gzip"`, `gz` (base64 of `gzencode()` of the UTF-8 SQL text) replaces `sql`.
`sha256` is of the uncompressed text either way. The response also has `warnings` when the table's
CREATE TABLE lost something (section 9): `[{ "code": "create_comment", "detail": "<what was removed>" }]`.

- The first page (`cursor: ""`) starts with `DROP TABLE IF EXISTS` and `CREATE TABLE`; every later
  page is INSERT lines only. A first page may hold nothing else, when those two fill it or the time
  is up; its `next` is then the start of the rows (`k:[]` or `o:0`).
- Every later page holds at least one row, sent or skipped, or reaches the end of the table. Pages
  stop at about `max_bytes` of SQL, and when the request's time is up; a single row larger than
  that is a page of its own.
- `next` is the cursor for the next page, or null when the table is done. Cursors are opaque to the
  panel: `k:[...]` is the key of the last row sent, as a JSON array whose items are strings or, for
  bytes that are not UTF-8, `{"x": "<hex>"}`; `o:<n>` is the number of rows sent, for a table
  without a key. The vectors' `cursors` and `badCursors` pin the format.
- `rows` counts the rows in this page.
- `skipped` lists rows above `limits.max_row_bytes`, which are not sent:
  `{ "key": ["2"], "bytes": 16778216 }` for a keyed table, `{ "offset": 41, "bytes": ... }` for one
  paged by offset. A row's size is the sum of `LENGTH()` of its text, blob, JSON and spatial
  columns; the server nulls such values before they reach PHP, so a large row never costs the old
  site's memory.

### maintenance

`{ "on": true, "ttl_s"?: 3600 }` turns the gate on until now plus `ttl_s` (1 to 7200, default 3600),
and `{ "on": false }` turns it off. The answer is `{ "on": true, "until": 1759846800 }`, or
`{ "on": false, "until": 0 }`. The panel renews it while it works; section 10 says who passes.

### finish

`{ "ok": true }`. The plugin forgets the token, the import's id, the panel's address and the
snapshot, lifts maintenance, empties its file table and deactivates itself. Its tables stay until
the plugin is deleted. From then on nothing answers the protocol: the REST route is gone (WordPress's
own 404), and the query transport is the ordinary page.

### Errors

`{ "error": { "code": "<code>", "detail"?: ..., ...fields } }` with:

| Status | Code | When |
|---|---|---|
| 401 | `unauthorized`, `stale` (+ `time`), `replay` | section 2 |
| 404 | `not_found` | unknown action (`detail: "action"`); `range` (`detail`: `missing`, `unreadable`, `too_large`, `excluded`); `sql` unknown table (`detail: "table"`) |
| 405 | `method_not_allowed` | not a POST, on the REST transport; `Allow: POST` |
| 409 | `changed` (+ `size`, `mtime`), `busy`, `snapshot_stale` | `range`; a walk running, or `files` before the walk is done; another snapshot |
| 413 | `too_large` (+ `max_bytes`) | a body over 1 MiB, `length` or `max_bytes` over the limit |
| 422 | `unsupported` | a parameter that is wrong (`detail` names it); `sql` of a view, or of a table without the site's prefix |
| 500 | `internal` | anything else, with a `detail` the panel can log; retry |

## 6. Plugin tables

`{prefix}wpl7_migrate_files`: `id` bigint unsigned auto-increment primary key; `parent` (the folder
entry it was found in; the root row's id for the top level); `seq` (its position in that folder's
sorted listing); `type` tinyint (1 file, 2 folder, 3 link); `path` VARBINARY(4096); `real`
VARBINARY(4096) (a folder's resolved path with `follow: "inside"`, kept for cycle checks and for
checking the folder is still in place when it is walked); `size`
bigint unsigned; `mtime` bigint; `mode` smallint (permission bits); `flags` smallint; `target`
VARBINARY(4096); `walked` tinyint; `pos` int (how many names of a folder were looked at, when a
request ran out of time inside it). Keys `walk (type, walked, id)` and `parent (parent)`. A row with
an empty path stands for ABSPATH; the file list never shows it.

`{prefix}wpl7_migrate_nonces`: `nonce` CHAR(32) primary key, `seen_at` int, key `seen_at`.

Both are created at activation and dropped by `uninstall.php`. Every signed request makes sure
they exist, once its signature and timestamp are checked (section 2): a table that is missing, as
after a copy or a restore of the old site's database, is created again, and so are both when the
plugin's schema version is newer than the one recorded. A request that is not signed never gets
that far, so it cannot make the plugin write to the database. Paths are stored as bytes: a file
name need not be valid in any character set.

Options, all named `wpl7_migrate_*`: the connection (`panel`, `import`, `token`, `state`,
`connected`), the facts the admin page shows, the snapshot's state, `maintenance_until` (autoloaded,
so the gate costs no query), the tables' schema version, the activation redirect, and the hash of
the last `connection.php` read. `uninstall.php` deletes them.

## 7. Paths, excludes and flags

Always left out:

```
wp-config.php
wp-content/plugins/wpl7-migrate/**
.wpl7-*
wp-content/cache/**
wp-content/upgrade/**
wp-content/updraft/**
wp-content/ai1wm-backups/**
wp-content/backups-dup-lite/**
wp-content/backup*/**
*.log
error_log
.git/**
wp-content/**/node_modules/**
```

and the plugin's own folder wherever it is installed. A pattern is matched against paths relative to
ABSPATH:

- With a slash, it is anchored at ABSPATH; without one, it matches a name at any depth (so
  `wp-config.php` is left out at any depth, and so is every `.git`).
- `*` and `?` match within a name, `**` spans any number of folders, zero included.
- `dir/**` takes the folder itself and everything in it.
- A folder left out takes everything below it, and the walk does not look inside it.
- The first pattern that matches is the reason given, in `excluded` warnings.

The vectors' `excludes` cases pin this, a non-UTF-8 name included.

Flags on file list entries:

| Flag | Meaning |
|---|---|
| `link` | A symbolic link, followed or not |
| `unreadable` | PHP cannot read it (permissions, `open_basedir`), or a folder could not be listed |
| `too_large` | A file of 2 GiB or more on 32-bit PHP, which cannot read it |
| `cycle` | A followed link to a folder that contains it; not walked |
| `dangling` | A link whose target does not exist |
| `too_deep` | A folder 48 levels down; not walked |
| `unchanged` | With `since`: mtime and ctime both earlier |

Text that is not valid UTF-8, in paths, link targets or the report, is made displayable by replacing
each ill-formed sequence with U+FFFD, one per maximal subpart, as the WHATWG decoder (and so Node)
does. The exact bytes travel beside it in base64 (`pb`, `lb`). The vectors' `utf8` cases pin it.

## 8. Dump preamble

Written by the panel, once, before the first page:

```
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS=0;
SET UNIQUE_CHECKS=0;
SET sql_mode='NO_AUTO_VALUE_ON_ZERO';
SET time_zone='+00:00';
```

## 9. SQL the plugin writes

- One statement per line, each ending in `;\n`. Heads: `DROP TABLE IF EXISTS \`t\`;`,
  `CREATE TABLE \`t\` (`, and `INSERT INTO \`t\` (\`c\`,...) VALUES (`. The table name must be one
  `tables` listed. Identifiers are in backticks, a backtick in one doubled.
- An INSERT line holds as many rows as fit in about 1 MiB of SQL; a single row larger than that is a
  line of its own. A row can be up to `max_row_bytes`, and as a hex or escaped literal about twice
  that, so the importing side needs a `max_allowed_packet` above `2 x max_row_bytes` (32 MiB for
  the default 15 MiB).
- Literals: `NULL`; numbers unquoted, as the server wrote them (a value that does not look like a
  number is quoted instead); `X'<lowercase hex>'` for binary columns and for text that is not valid
  UTF-8; everything else quoted with a `\` before exactly these seven bytes: NUL, line feed,
  carriage return, `\`, `'`, `"` and Ctrl-Z. On a mysqli connection that is
  `mysqli_real_escape_string` (utf8mb4, without `NO_BACKSLASH_ESCAPES`); where a `db.php` drop-in
  replaced mysqli, the plugin escapes the same seven bytes itself rather than use WordPress's
  fallback, `addslashes()`, which leaves line breaks in and would split an INSERT across lines.
  The output is the same whatever the connection. BIT columns are read as `col + 0`, a number on
  every client library, and written as one. The vectors' `literals` pin this.
- From `{prefix}options` the plugin leaves out its own rows (`wpl7_migrate_*`), so the
  connection's token never leaves the old site. The filter is part of the page's query; the key
  paging is unchanged.
- The plugin reads on its own session settings: `utf8mb4`, `sql_mode` empty (so `ANSI_QUOTES`
  cannot change how SHOW CREATE TABLE quotes, nor `NO_BACKSLASH_ESCAPES` how strings are escaped),
  `time_zone` `+00:00` (TIMESTAMP values read back as stored), `sql_quote_show_create` on.
- Generated columns are left out of INSERT lines; the importing server computes them again.
  `AUTO_INCREMENT=n` is kept. Views, triggers, routines and events are never written; the report
  counts them. Collations stay as the source wrote them (the panel rewrites `utf8mb4_0900_*`).
- The panel validates every line. A character scan refuses `;` outside quotes except as the last
  character, and refuses CREATE TABLE lines containing, outside quotes, `DEFINER`, `DATA DIRECTORY`,
  `INDEX DIRECTORY`, `CONNECTION=`, `TABLESPACE`, `ENCRYPTION`, or `ENGINE=` FEDERATED, CONNECT,
  SPIDER, CSV or MERGE.

CREATE TABLE is SHOW CREATE TABLE made one line:

- White space outside quoted strings and identifiers, line breaks included, becomes a single space.
  Inside quotes MySQL has escaped line breaks already; a line break left inside an identifier makes
  the table **422** `unsupported`.
- Comments are removed. On MySQL these are versioned clauses such as a partitioning clause
  (`/*!50100 PARTITION BY ... */`) or MySQL 8's `/*!80023 INVISIBLE */`. Removing anything other
  than `ENCRYPTION='N'` or `DEFAULT ENCRYPTION='N'` changes the table and adds the page's
  `create_comment` warning. MySQL 8.0 writes `DEFAULT ENCRYPTION='N'` on databases, not on tables,
  as far as tested; the exception is there in case one carries it.
- The vectors' `createTable` cases pin the result.

Tables are paged by key: the primary key, or else the unique index over NOT NULL columns with the
fewest columns. Its columns must all be of a type that compares with a literal the way ORDER BY
sorts (integers, decimals, CHAR, VARCHAR, BINARY, VARBINARY, dates and times; not floats, ENUM,
SET, BIT, text or blobs) and none of them generated. A page continues after the last key sent:
`(a > x) OR (a = x AND b > y)`. A table without such a key is paged by offset, which a write
between two pages can shift; the panel warns about it (`no-primary-key`).

## 10. Maintenance and the connection's life

The gate is the option `wpl7_migrate_maintenance_until`, read on `init` at priority 0. While it is
in the future, a visitor gets **503** with `Retry-After` (the time left, at least 60 and at most
3600 seconds) and WordPress's error page. Every request is decided there, before the rest of
`init`, `wp_loaded`, `parse_request` and `wp`, where shop and form plugins save what visitors send.
These pass: users with `manage_options`, the login page, WP-CLI, the query transport (handled
first, on the same hook), and a request for the plugin's own REST route that the panel signed.

That route is the one WordPress would dispatch: `rest_route` from the POST body, else from the
query string (WordPress refuses a request whose two differ), else, with pretty permalinks only,
the path below home's `/wp-json/` (or `/index.php/wp-json/`), URL-decoded. It must be
`/wpl7-migrate/v1/<action>`, compared without regard to case as the REST server compares routes,
and the request must carry a valid signature for that action; its time window and nonce are
checked when it reaches the route, so a panel whose clock is off still gets its `stale` answer.
Only `index.php` outside wp-admin serves the REST API, so no other entry point (wp-admin,
admin-ajax.php, wp-cron.php, xmlrpc.php, wp-comments-post.php) can be that route. As a second line,
the REST server's match is checked again (`rest_pre_dispatch`: only the plugin's routes), and a
request that turns out to be a page is stopped before the template. WordPress itself dispatches a
route from the path as it is written, so a signed request that spells the route URL-encoded in the
path passes `init` and stops at that second line. Deactivating the plugin lifts the gate, and so
does `finish`.

The plugin's states, as its admin page shows them:

| State | Means |
|---|---|
| `unbound` | No panel known: a form for the panel's address and the connection code |
| `bound` | A panel and a code, not connected yet: the page connects when it opens |
| `connected` | `connect` succeeded; the page shows the panel's `status` |
| `disconnected` | The panel answered 410, or 401 to `status`, or sent `finish`: the token is forgotten |

Activation creates the tables, reads `connection.php` into options and deletes it (best effort; a
file that cannot be deleted is read only once), and refuses multisite, Windows, PHP before 7.0
and WordPress before 5.0 with a message. A new zip uploaded over an active plugin brings a new
`connection.php`, which the next admin page load reads. Deactivation keeps the connection, so an
import can go on after activating the plugin again. Deleting the plugin runs `uninstall.php`.

## 11. Limits

| Limit | Value |
|---|---|
| `max_ms` | Half of PHP's `max_execution_time`, at most 10000 ms; 10000 when there is no limit. Counted from the request's start, WordPress's own loading included |
| `max_bytes` | A twelfth of `memory_limit` (after `wp_raise_memory_limit('admin')`), at least 256 KiB, at most 8 MiB |
| `max_row_bytes` | An eighth of `memory_limit`, at least 1 MiB, at most 15 MiB |

A request that runs out of time ends with what it has, and the next one goes on: the walk
(`snapshot`), the `files` hashes, `bundle` and `sql` all stop at `max_ms` after doing at least one
item. `budget_ms` on `snapshot` asks for less. The plugin uses no `exec`, no ZipArchive and no
Composer; it needs PHP 7.0 or later and WordPress 5.0 or later, and runs on PHP 8.5.
