# Connect protocol, version 1

How the panel manages a WordPress site hosted elsewhere through the WPL7 Connect plugin. This
document is normative: the plugin (`panel/connect-plugin/wpl7-connect/`) implements it, and the
panel's client (`panel/src/services/connectClient.ts`) must follow it. Change them together, and
change this document in the same pull request.

It shares its shape with the import protocol (`docs/internal/import-protocol.md`). Where this
document says nothing, that one holds, with "the plugin" meaning WPL7 Connect and `wpl7-migrate`
read as `wpl7-connect`. The paging code (`snapshot`, `files`, `range`, `bundle`, `tables`, `sql`)
is a copy of WPL7 Migrate's, so the two plugins can be active on one site: a fix to one plugin's
paging code is made in the other's in the same change.

The shared test vectors are in `panel/test/fixtures/connectProtocol.json`. The plugin checks itself
against them, and against the SQL vectors of `panel/test/fixtures/migrateProtocol.json`, with
`php panel/connect-plugin/tests/run.php` (CI runs it on PHP 7.0 and 8.5). The panel's tests read the
same files. `panel/connect-plugin/tests/client.php` is a signed client for trying a real site by
hand.

The differences from the import protocol, in short:

- The plugin is permanent. It never deactivates itself.
- Requests are signed with Ed25519. The site keeps only the panel's public key, so a copy of its
  database or of a backup cannot be used to drive it.
- The canonical string carries the site's home, and a site whose address changed says so.
- There is no `maintenance` and no `finish`. There are actions for updates, rollback, plugin and
  theme changes, the REST API, registered commands, login links and disconnecting.
- A must-use loader lets the panel reach a site that a plugin or theme update broke.

## 1. The download

The plugin is installed from a zip the panel builds for one connection. The panel replaces the
version string `0.0.0-dev` in the plugin's `.php` and `.txt` files and writes `connection.php`
into the plugin's folder:

```php
<?php
// WPL7 Connect: the panel this download came from. Read once at activation, then deleted.
defined('ABSPATH') || exit;
return array('panel' => 'https://panel.example.com', 'connection' => 7, 'token' => '<43 chars>', 'key' => '<43 chars>', 'issued' => 1759843200);
```

- `token`: the enrollment token, 32 random bytes in base64url without padding (43 characters of
  `[A-Za-z0-9_-]`). It authenticates the plugin's one call to the panel (section 4) and nothing
  else. The panel accepts it for 24 hours, and forgets it once the site is added.
- `key`: the panel's Ed25519 public key for this connection, 32 bytes in base64url without
  padding (43 characters).
- `connection`: the connection's id, a positive integer.

The plugin's admin page can take the same by hand: the panel's address, and a connection code
`<token>.<key>` (87 characters). A connection entered by hand gets its id from the panel's answer
to `enroll`.

The panel serves the plugin without `connection.php` too, for self-update (section 12).

## 2. Addresses and transports

The panel reaches the plugin at the report's `endpoint`, `rest_url('wpl7-connect/v1/')`, an
absolute URL on the same host as `home`. Two transports, both a POST with a JSON body, both
answering byte for byte the same:

- **REST**: `{endpoint}{action}`.
- **Query**: `{home}/?wpl7-connect={action}`, handled on WordPress's `init` at priority 0, before
  page caches, for hosts that block `/wp-json/`. Only a POST that carries the query variable is the
  plugin's; a GET with it is the site's ordinary page. It defines `DONOTCACHEPAGE`.

Every response from the plugin, errors included, carries `X-WPL7-Connect: 1` and
`Cache-Control: no-store, no-transform`, with `X-Content-Type-Options: nosniff` and
`X-Robots-Tag: noindex, nofollow`, unless output was sent before the plugin answered. A response
without `X-WPL7-Connect` is not the plugin's: the panel reports that the site "answered with
something else" and names the fix (allow the panel's address, or skip `/wp-json/wpl7-connect/` and
`?wpl7-connect=` in the firewall). The rest is as the import protocol's section 1: content types,
`Content-Length`, the response ending before WordPress's shutdown hooks.

The panel's side of the connection is the import's: `https:` only unless the connection allows
plain HTTP, ports 80 and 443, no user info, public addresses only (a mixed answer fails closed),
the connection pinned to the vetted address, and any 3xx an error.

## 3. Signing (panel to plugin)

Every request from the panel is signed. Five values travel as headers:

```
X-WPL7-Site: <connection id>           decimal, no leading zero
X-WPL7-Home: <home as bound, percent-encoded>
X-WPL7-Timestamp: <unix seconds>       decimal, no leading zero
X-WPL7-Nonce: <32 lowercase hex>
X-WPL7-Signature: ed25519=<signature, 64 bytes in base64url without padding: 86 characters>
```

For hosts that strip custom headers, the same five may travel as query parameters `_site`,
`_home`, `_ts`, `_nonce` and `_sig`. Each value is taken from its header when that is present and
not empty, else from its query parameter.

`X-WPL7-Home` (and `_home`, as its value after the query string is decoded) is the home URL
percent-encoded as JavaScript's `encodeURIComponent` does it. The plugin decodes it with
`rawurldecode()`; any percent-encoding of the same text decodes to the same home. The vectors'
`homes` cases pin it.

```
canonical = "WPL7-CONNECT-V1\n" + connection_id + "\n" + home + "\n" + action + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(body_bytes)
signature = Ed25519(private key of this connection, canonical as UTF-8 bytes)
```

`home` is the decoded value. `action` is the action's name as the URL gives it. The body hash
covers the exact bytes sent; an empty body hashes as the empty string.

The plugin answers only while it holds a public key and a connection id, and checks in this order:

1. The action is one it knows, else **404** `not_found` with `detail: "action"`. On the REST
   transport a method other than POST is **405** `method_not_allowed`, with `Allow: POST`. A body
   over 1 MiB is **413** `too_large` with `detail: "body"`.
2. A public key and a connection id are stored, the five values are well formed, and the
   connection id equals the stored one, else **401** `unauthorized`.
3. `sodium_crypto_sign_verify_detached(signature, canonical, public_key)`, with the canonical
   string built from the request's own home, else **401** `unauthorized`.
4. The request's home equals the site's home now, `untrailingslashit(home_url('', <scheme>))`
   with the scheme of the `home` option itself, else **409**
   `home_changed` with the home now: `{ "error": { "code": "home_changed", "home": "https://new.example" } }`.
   Only a request the panel signed gets this far, so only the panel learns the new address. The
   scheme is the option's own because plain `home_url()` follows the request's scheme when the
   option is http, and the same site would then answer `home_changed` depending on how it was
   reached. The report's `home` is made the same way.
5. `|now - timestamp| <= 300`, else **401** `stale` with the plugin's clock in `time`.
6. The plugin's tables exist, or are created again (section 11).
7. The nonce is new, else **401** `replay`. Nonces are kept in `{prefix}wpl7_connect_nonces` for
   600 seconds. Older rows are deleted on every signed request.

Steps 1 to 5 read options and write nothing. The first request that passes all seven moves the
plugin to `connected` and deletes the enrollment token (section 11).

`sodium_crypto_sign_verify_detached` is native from PHP 7.2; WordPress bundles `sodium_compat`
from 5.2, which is why the plugin needs WordPress 5.2. Where the function is still missing when the
plugin needs it, the plugin requires `wp-includes/sodium_compat/autoload.php` itself. The vectors'
`keyPair` and `signature` cases pin the canonical string and the signatures, `badAuth` the values
that are not well formed, and `timestamps` the edges of the window.

## 4. Plugin to panel

| Call | Request | Success | Failures |
|---|---|---|---|
| enroll | `POST {panel}/api/connect/enroll`, header `X-WPL7-Connect-Token: <token>`, body the report (section 5) | `200 { "ok": true, "connection": { "id": 7, "status": "enrolled" }, "panel_version": "0.4.0" }` | 401 `unauthorized` (an unknown or expired token), 409 `conflict` (bound to another home, or the site was added already), 410 `gone` (deleted in the panel), 422 `invalid_report`, 426 `protocol_unsupported { min, max }`, 503 (maintenance; retry) |

The transport rules are the import's (its section 3): `wp_remote_post` with `timeout` 15 seconds,
`sslverify` on, `redirection` 0, `User-Agent: WPL7-Connect/<version>`, and plain http only to an
address on this machine or a private network.

`enroll` is idempotent for the same `home` until the site is added. The panel binds the token to
the first `home` it sees and refuses another. The plugin calls it only from its admin page,
Settings > WPL7 Connect, which activation takes the administrator to (not from WP-CLI, not in a
bulk activation). The page enrolls on its own when the plugin has a code and is `bound`, at most
once a minute, and on **Connect** and **Check again**.

On 200 the plugin stores the connection id from the answer, which must be a JSON integer and
replaces the one `connection.php` gave, and moves to `enrolled`. A 410 moves it
to `disconnected` and forgets the token and the key. Any other failure keeps it `bound`, with the
reason on the page.

## 5. The report

The body of `enroll`, and the answer to `info`. It is the import report (import protocol section
4) **without** `constants`, `htaccess`, `user_ini` and `php_ini`, and **with**:

```json
{
  "admins": [{ "id": 1, "login": "admin", "name": "Admin" }],
  "fs_method": "direct",
  "file_mods": true,
  "loader": true,
  "commands": ["godmode"]
}
```

- `admins`: the users with the `administrator` role, by id, at most 50.
- `fs_method`: `get_filesystem_method()`: `direct`, `ssh2`, `ftpext` or `ftpsockets`.
- `file_mods`: false when `DISALLOW_FILE_MODS` is true. The site then takes no updates.
- `loader`: the must-use loader (section 10) is in place and is this version's.
- `commands`: the names of the registered commands (section 8).
- `plugin` is WPL7 Connect's version; `protocol` is 1.
- `endpoint` is `rest_url('wpl7-connect/v1/')`.

The panel refuses to add a site whose report says `multisite` or `windows`. It warns, without
refusing, when `fs_method` is not `direct`, when `file_mods` is false, when `loader` is false, and
when `home` is not https.

## 6. Actions

All POST with a JSON object as the body. Parameters of the wrong type or out of range are **422**
`unsupported` with `detail` naming the parameter.

**From the import protocol, unchanged:** `ping`, `info`, `snapshot`, `files`, `range`, `bundle`,
`tables` and `sql`, except that:

- `files`, `bundle` and `sql` take `budget_ms` as `snapshot` does: a positive integer that
  shortens the request's time (section 9), else **422** with `detail: "budget_ms"`;
- the excludes are Connect's (section 7);
- `sql` and `tables` leave out the plugin's own three tables, and `sql` keeps every row of
  `{prefix}options`, the plugin's own options included (section 7).

There is no `maintenance` and no `finish`.

### ping

As the import's, plus:

```json
{
  "home": "https://example.com",
  "wp": "7.1.2",
  "php": "8.3.35",
  "commands": ["godmode"],
  "loader": true,
  "fs_method": "direct",
  "file_mods": true,
  "offer_seen": "1.2.4"
}
```

`actions` lists every action of this section. `offer_seen` is the version of the update offer
the plugin holds (section 12), or null.

The body may be `{}` or `{ "offer": { "version": "1.2.4", "package": "<url>", "expires": 1759850400 } }`
(section 12).

### inventory

`{ "check": true }`. With `check` true (the default), the plugin asks for fresh update data first,
as WP-CLI's `plugin list`, `theme list` and `core check-update --force-check` do: it deletes the
`update_plugins` and `update_themes` site transients and calls `wp_update_plugins()`,
`wp_update_themes()` and `wp_version_check(array(), true)`. A premium plugin's updater that hooks
WordPress's update check reports through that. With `check` false it reads what is cached.

```json
{
  "core": { "version": "7.1.2", "update": { "version": "7.1.3", "type": "minor" } },
  "plugins": [
    { "name": "akismet", "title": "Akismet Anti-spam", "status": "active", "version": "5.7.2", "update": "available",
      "update_version": "5.8", "auto_update": "off", "file": "akismet/akismet.php" }
  ],
  "themes": [
    { "name": "twentytwentyfive", "title": "Twenty Twenty-Five", "status": "active", "version": "1.5", "update": "none",
      "update_version": "", "auto_update": "off" }
  ],
  "partial": false
}
```

The rows are what `wp plugin list --format=json --fields=name,title,status,version,update,update_version,auto_update,file`
and `wp theme list --format=json --fields=name,title,status,version,update,update_version,auto_update`
print on the same site, and are made the same way:

- **Plugins:** every plugin `get_plugins()` lists, then the must-use plugins (`status`
  `must-use`, `file` the file name), then the drop-ins (`status` `dropin`, `name` the file name).
  - `name` is the plugin's folder, or the file name without `.php` for a plugin of one file. When
    two plugins would get the same name, each takes its file path without the extension.
  - `status` is `active-network`, `active` or `inactive`.
  - `update` is `available` when `update_plugins` has a response for the file, and
    `unavailable` when that update needs a newer PHP (`requires_php`) or WordPress (`requires`)
    than the site runs; `version higher than expected` when the installed version is above the
    `no_update` entry's `new_version`; otherwise `none`.
  - `update_version` is the response's `new_version`, or `""`.
  - `auto_update` is `on` when the file is in the `auto_update_plugins` site option, else `off`.
- **Themes:** every theme `wp_get_themes()` lists, `name` its directory. `status` is `active` for
  the active stylesheet, `parent` for the active theme's parent, else `inactive`. `update`,
  `update_version` and `auto_update` (the `auto_update_themes` site option) as for plugins, from
  `update_themes`.
- **Core:** `version` is `$wp_version`. `update` is the newest offer in `update_core` above the
  installed version, or null. `type` is WP-CLI's word: `minor` for a new release of the installed
  branch (7.1.2 to 7.1.3), `major` for anything newer.
- `version` and `update_version` are `""` when empty. Text is valid UTF-8 (the import's section 7).
- Must-use plugins and drop-ins have `update` `none`, where WP-CLI prints false.
- `partial` is true when WordPress holds no update data for plugins, themes or core: a check that
  failed, or checks turned off.
- Over the rescue path (section 10), a skipped plugin shows as `inactive`: the loader leaves it
  out of `active_plugins` for the whole request.

The vectors' `inventory` cases give rows for fixed inputs.

### update, op, rollback, cleanup

`update`: `{ "op": "<id>", "kind": "plugin" | "theme" | "core" | "db", "slug"?: "<name>", "version"?: "<version>" }`.
`op` is the panel's id for this one change, `^[a-z0-9]{16,64}$`. One item per call.

```json
{ "op": "4f1c0e9a7b2d6e8f", "state": "done", "result": { "ok": true, "from": "5.7.2", "to": "5.8", "rollback": true } }
```

`state` is `running` or `done`; `result` comes with `done`: `ok`, `from` and `to` (the version
before and after, null when unknown), `error` when not `ok`, and `rollback`, whether a copy to roll
back to was made.

An `update` with an op id that exists runs again; it is not taken for a repeat. The copies an
update keeps are recorded in its op, and merged when several updates share one op, so one op per
item and one op per run both work. The checks come in this order: the parameters (**422**), the
component (**404**), `DISALLOW_FILE_MODS` (**422** `file_mods`), then the filesystem (**422**
`filesystem`).

- **plugin** (`slug` is the inventory's `name`): the plugin is found by its folder, or by its file
  for a plugin of one file, else **404** `not_found` with `detail: "plugin"`.
  1. `wp_update_plugins()`. No update on offer: `ok` false, `error` "No update is available."
  2. The plugin's folder (or file) is copied to `wp-content/wpl7-rollback/<op>/plugins/<name>`
     through `WP_Filesystem` (`copy_dir`). A copy that fails is not an error: `rollback` is
     false.
  3. `Plugin_Upgrader` with a quiet skin (`WP_Ajax_Upgrader_Skin`) runs `bulk_upgrade(array($file))`,
     as WP-CLI's `plugin update` does: WordPress's maintenance mode covers it, and an active plugin
     stays active.
  4. `from` and `to` are the plugin's `Version` header before and after. The upgrader's
     `WP_Error`, a false result, or errors collected by the skin give `ok` false with WordPress's
     message.
- **theme** (`slug` the stylesheet): the same with `Theme_Upgrader`, copied to
  `wp-content/wpl7-rollback/<op>/themes/<name>`. Not found: **404** `detail: "theme"`.
- **core** (`version` the offer to install): `find_core_update($version, get_locale())`, then the
  `en_US` offer when the site's locale has none for that version, else
  `ok` false with "WordPress <version> is not on offer." `Core_Upgrader::upgrade()` replaces the
  files. No rollback copy is made. The database upgrade is not run in this request: the old code
  is still loaded in it.
- **db**: brings the database up to the WordPress files, as `wp core update-db` does: when the
  `db_version` option is below the files' `$wp_db_version`, `wp_upgrade()`. `from` and `to` are
  the two numbers, as strings. The panel sends it after every core update, in a request of its own.

Every `update` runs with `ignore_user_abort(true)` and, where the host allows it,
`set_time_limit(0)`. A plugin, theme or db update answers `done` in the same request. A core update
answers `running` at once and goes on after the answer has gone, where PHP-FPM's
`fastcgi_finish_request()` exists; elsewhere it runs within the request and answers `done`. Either
way the state is kept in the option `wpl7_connect_op_<op>`, and a panel that lost the answer asks
`op`. A core update that never finishes (the host killed it) stays `running`; the panel gives up
after 15 minutes. WordPress ignores its own `.maintenance` file after 10 minutes.

Before it starts, `update` deletes rollback copies and op records older than 7 days.

The filesystem: a method other than `direct` without the FTP or SSH details in `wp-config.php`
(`request_filesystem_credentials()` cannot be answered in a request) is **422** `unsupported` with
`detail: "filesystem"`. `DISALLOW_FILE_MODS` is **422** `unsupported` with `detail: "file_mods"`.

`op`: `{ "op": "<id>" }` answers as `update` did, or **404** `not_found` with `detail: "op"`.

`rollback`: `{ "op": "<id>", "items": [{ "kind": "plugin" | "theme", "slug": "<name>" }] }` puts
each copy back: the current folder (or file) is deleted and the copy moved, or copied, in its place.

```json
{ "items": [{ "kind": "plugin", "slug": "akismet", "ok": true }, { "kind": "theme", "slug": "x", "ok": false, "error": "No copy to roll back to." }] }
```

After a plugin or theme update, and after a rollback, the plugin tells PHP's opcode cache that
the files changed (`opcache_invalidate`), as WordPress does on updates from 5.5 on. Without it an
older WordPress can go on running the replaced code for a moment, and a broken update answers the
panel's check as if it were fine.

`cleanup`: `{ "op": "<id>" }` deletes `wp-content/wpl7-rollback/<op>/` and the op's record:
`{ "ok": true }`, or `{ "ok": false, "error": "<why>" }` when the folder could not be removed.

### component

`{ "kind": "plugin" | "theme", "slug": "<name>", "action": "activate" | "deactivate" | "delete" | "install", "source"?: ..., "activate"?: false }`

| kind, action | Does |
|---|---|
| plugin activate | `activate_plugin()` |
| plugin deactivate | `deactivate_plugins()` |
| plugin delete | deactivates it when active, then `delete_plugins()` |
| plugin install | `source` `{ "wporg": "<slug>" }`: the download link from `plugins_api('plugin_information')`; or `{ "url": "<url>" }`; then `Plugin_Upgrader::install()`, and `activate_plugin()` unless `activate` is false |
| theme activate | `switch_theme()` |
| theme delete | `delete_theme()`; refused for the active theme and its parent |
| theme install | `{ "wporg": "<slug>" }` through `themes_api()` and `Theme_Upgrader::install()`; `switch_theme()` only with `activate` true |
| theme deactivate | **422** `unsupported` with `detail: "action"`: another theme is activated instead |

Answer: `{ "ok": true, "status": "active" | "inactive" | "deleted" }`, or `{ "ok": false, "error": "<why>" }`
when WordPress refused. A component that is not installed is **404** `not_found` with `detail`
`plugin` or `theme`.

- A `url` source must start with `<panel address>/api/connect/catalog/`, the panel this plugin
  enrolled with, else **422** with `detail: "source"`. The plugin downloads nothing else from a
  URL the panel names.
- The plugin refuses to deactivate or delete itself: `ok` false, "WPL7 Connect connects this site
  to the panel."
- The filesystem and `DISALLOW_FILE_MODS` rules of `update` apply to install and delete.

### rest

`{ "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE", "route": "/wp/v2/posts", "query"?: "per_page=5", "body"?: <JSON>, "user"?: "<login, email or id>" }`

Runs the request in-process through `rest_do_request()`, as `user` when given (`wp_set_current_user`)
and as no one otherwise. `route` starts with `/`, at most 2000 bytes; `query` is a query string,
parsed with `wp_parse_str()`; `body` is sent as JSON (`Content-Type: application/json`). An unknown
user is **422** with `detail: "user"`.

```json
{ "status": 200, "headers": { "content-type": "application/json; charset=UTF-8", "x-wp-total": "12", "x-wp-totalpages": "3" }, "body": "[...]", "truncated": false }
```

`body` is the response's data as WordPress's REST server would print it (`response_to_data()`,
with `_embed` when the query asks for it), JSON-encoded, cut at 1 MiB (`truncated` true).
`headers` holds `content-type`, `x-wp-total`, `x-wp-totalpages`, `link` and `allow` when the
response has them.

### commands, help, run

The registered commands (section 8).

- `commands`: `{}` answers `{ "commands": [{ "name": "godmode", "summary": "..." }] }`, by name.
- `help`: `{ "words": ["godmode", "chat"] }` answers `{ "text": "..." }`: what the command's `help`
  returns for those words. `words` empty lists the commands. A command nobody registered, or a
  `help` that returns null, is **404** `not_found` with `detail: "command"`.
- `run`: `{ "args": ["godmode", "chat", "list"], "stdin"?: "<text>" }` answers
  `{ "stdout": "...", "stderr": "...", "exit_code": 0 }`. `args[0]` not registered is **404**
  `not_found` with `detail: "command"`. At most 200 args of at most 64 KiB each, and `stdin` at
  most 512 KiB, else **413**.

`run` treats WP-CLI's global flags, anywhere in `args`, as WP-CLI would before the command sees
them:

- `--user=<login, email or id>` sets the current user and is removed. An unknown user is
  `exit_code` 1 with `Error: Invalid user ID, email or login: '<value>'` on stderr.
- `--quiet`, `--debug`, `--debug=<group>`, `--color`, `--no-color` are removed.
- `--path`, `--url`, `--ssh`, `--http`, `--skip-plugins`, `--skip-themes`, `--skip-packages`,
  `--require`, `--exec`, `--context` and `--prompt`, with or without a value, give `exit_code` 1
  and `Error: <flag> is not available through WPL7 Connect.` on stderr. The command is not run.
- Anything else, `--` and `-` included, is the command's own, as WP-CLI passes it on.

The global flags are dealt with first. So `--path` on a command nobody registered is `exit_code` 1,
not a 404, and `args` with nothing left after the flags is **404** `not_found` with
`detail: "command"`.

With no `--user`, no user is set, as under WP-CLI. The command's handler gets the rest, `args[0]`
included, and a context `{ "deadline": <unix time, float>, "stdin": <string or null> }`. The
deadline is the request's start plus 50 seconds, or less when `max_execution_time` is lower and
cannot be raised (it is raised to 60 where the host allows). `stdout` and `stderr` are cut at
1 MiB each. An exception in the handler is `exit_code` 1 with `Error: <message>` on stderr. The
vectors' `globalFlags` cases pin the rules.

### login

`{ "user"?: "<login, email or id>" }` answers `{ "url": "<site_url('/')>?wpl7-connect-login=<selector>.<verifier>", "user": "<login>", "expires_in": 120 }`.

The link is on the address WordPress serves wp-admin from (`site_url()`), not `home`: the login
cookie is set for the host the link is opened on, and wp-admin must see it there.

The user must be able to `manage_options`, else **422** with `detail: "user"`; without `user` it
is the first administrator by id. `selector` is 24 lowercase hex, `verifier` 32 random bytes in
base64url (43 characters). The plugin keeps `{"u": <user id>, "h": "<sha256 hex of the verifier>"}`
in the transient `wpl7_connect_login_<selector>` for 120 seconds.

A GET carrying `wpl7-connect-login` that matches `^([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$` is
handled on `init` at priority 1: the transient is deleted on sight, the verifier's hash compared
with `hash_equals`, the user checked to still be able to `manage_options`, and then the user is
signed in (`wp_set_auth_cookie`, `wp_login`) and sent to
`admin_url()`, with no-cache headers. Anything else is the site's ordinary page.

### disconnect

`{}` answers `{ "ok": true }`. The plugin then forgets the public key, the connection id and any
token, and moves to `disconnected`. From then on every request is **401** `unauthorized`.

### Errors

As the import protocol's, plus:

| Status | Code | When |
|---|---|---|
| 404 | `not_found` | `update`: `detail` `plugin` or `theme`; `op`: `detail: "op"`; `component`: `detail` `plugin` or `theme`; `help`, `run`: `detail: "command"` |
| 409 | `home_changed` (+ `home`) | section 3, step 4 |
| 413 | `too_large` | `run`'s args or stdin |
| 422 | `unsupported` | `detail`: `filesystem`, `file_mods`, `source`, `user`, or the parameter |

## 7. Paths and excludes

The import's defaults (its section 7), **without** `wp-config.php` and
`wp-content/plugins/wpl7-migrate/**`, which a backup keeps, and **with**
`wp-content/wpl7-rollback/**` and `wp-content/upgrade-temp-backup/**`. WPL7 Connect's own folder
is not left out either: a backup restored by hand brings it back. The vectors' `excludes` cases
pin the list.

`tables` and `sql` leave out `{prefix}wpl7_connect_files`, `{prefix}wpl7_connect_nonces` and
`{prefix}wpl7_connect_log`. Rows of `{prefix}options` are all copied, the plugin's own
`wpl7_connect_*` options included: they hold the panel's public key and settings, nothing secret
once the site is connected, and a database restored by hand then keeps the connection.

## 8. Registered commands

Plugins add commands to the connector through a filter:

```php
add_filter('wpl7_connect_commands', function (array $commands) {
    $commands['hello'] = array(
        'summary' => 'Says hello',                               // one line, for the list
        'help'    => function (array $words) {                   // what `wp help <words>` would print, or null
            return "NAME\n\n  wp hello\n";
        },
        'run'     => function (array $args, array $context) {    // $args[0] === 'hello', global flags removed
            return array('stdout' => "Hello\n", 'stderr' => '', 'exit_code' => 0);
        },
    );
    return $commands;
});
```

- A name matches `^[a-z][a-z0-9-]{0,39}$`; other entries, and entries without a callable `run`,
  are ignored. `summary` is cut at 200 characters, and `help` may be left out.
- The filter runs when an action needs the list, after every plugin has loaded (on `init` for the
  query transport, in the REST callback for the other).
- `run` returns an array with `stdout`, `stderr` (strings) and `exit_code` (an integer). Anything
  else is `exit_code` 1 with `Error: The command returned no result.` on stderr. Output it prints
  is caught and added to `stdout`.
- The connector runs only what is registered: nothing falls back to WP-CLI, a shell or PHP.

The vectors' `commandNames` cases pin the names.

## 9. Limits

As the import protocol's section 11. `budget_ms` on `snapshot`, `files`, `bundle` and `sql` asks
for less time than `max_ms`. The panel halves it after two gateway timeouts in a row (a 502 or 504
without the protocol header), down to 2000, and keeps it with the connection.

## 10. The must-use loader

`wp-content/mu-plugins/wpl7-connect-loader.php` is written at activation where that folder is
writable (created when missing), and removed at deactivation and by `uninstall.php`. It carries
the plugin's version in a comment. The plugin compares the whole file with its own copy at
activation and on every `ping` and `info`, and writes it again when it differs: a self-update
reaches the loader without an administrator's visit. It is self-contained: it loads nothing of
the plugin, so a broken copy of the plugin cannot break it.

On a POST carrying `wpl7-connect=<action>` in the query string (the query transport), and only
there, it checks the request at must-use time, as section 3 does: steps 1 to 7, the nonce
recorded then. WordPress has loaded its options and `sodium_compat` by then. A request that fails
any step is left alone, and the plugin answers it as usual.

A request that passes may carry, in its JSON body:

- `"skip_plugins": ["<plugin file>", ...]`: the loader filters `option_active_plugins` (and
  `site_option_active_sitewide_plugins`) to leave those out of this one request;
- `"skip_theme": true`: the loader filters the `template` and `stylesheet` options to a theme that
  does not exist for this one request, so no theme's `functions.php` loads.

It then records the verified nonce for the request, and the plugin, reaching the same request on
`init`, takes it as checked rather than as a replay. WPL7 Connect itself is never skipped. While
plugins are skipped, a save of `active_plugins` in that request keeps them in it: a skip never
becomes a deactivation.

The panel uses it when a site answers 500 after an update: `rollback`, `inventory` and `login`
then go over the query transport with the updated plugins (or the theme) skipped. REST requests
never take this path. Without the loader those requests fail as the site does, and the panel
says: "The site fails before WPL7 Connect loads. Restore the plugin's folder from the last
backup."

## 11. Tables, options and states

Tables, created at activation and again by a signed request that finds one missing (as the
import's section 6):

- `{prefix}wpl7_connect_files`: as `{prefix}wpl7_migrate_files`.
- `{prefix}wpl7_connect_nonces`: as `{prefix}wpl7_migrate_nonces`.
- `{prefix}wpl7_connect_log`: `id` bigint unsigned auto-increment primary key, `at` int unsigned,
  `action` varchar(32), `summary` varchar(255), `ok` tinyint unsigned. At most 200 rows: older ones
  are deleted as rows are added.

Every signed action writes one log row, except `ping`, `op`, `files`, `range`, `bundle`, `tables`,
`sql` and `snapshot` (`snapshot` `start` writes one: "Backup started"). A row names the action and
what it acted on (`Updated plugin akismet 5.7.2 → 5.8`, `REST GET /wp/v2/posts`,
`Command: godmode chat send`), never a body, a query string, stdin or a URL. The admin page shows
the last 20, escaped.

Options are named `wpl7_connect_*` and never autoloaded. `uninstall.php` drops the three tables,
deletes the options, the transients and the rollback folder, and removes the loader.

| State | Means |
|---|---|
| `unbound` | No panel known: a form for the panel's address and the connection code |
| `bound` | A panel and a token: the page enrolls when it opens |
| `enrolled` | The panel accepted the report: "Finish in the panel: Sites > Connect a site." |
| `connected` | A signed request passed; the token is gone |
| `disconnected` | The panel sent `disconnect`, answered 410, or the administrator pressed Disconnect; the key, the connection id and the token are gone |

Activation creates the tables, reads `connection.php` into options and deletes it (best effort; a
file that cannot be deleted is read once), writes the loader, and refuses multisite, Windows, PHP
before 7.0 and WordPress before 5.2. A new zip uploaded over the active plugin brings a new
`connection.php`, which the next admin page load reads: the new key replaces the old one at once,
and the page enrolls with the new token. Deactivation keeps the connection.

The admin page, connected, shows the panel's host, when the site connected, the last request,
the last 20 log rows, and **Disconnect**, with a confirmation. It also says, one line each, when
updates need FTP details in `wp-config.php` (`fs_method` not `direct`) and when rollback after a
broken update is off (no loader).

## 12. Self-update

`ping` may carry an offer: `{ "offer": { "version": "1.2.4", "package": "<url>", "expires": <unix> } }`.

- An offer of the wrong shape is **422** `unsupported` with `detail: "offer"`. A `package` that
  does not start with `<panel address>/api/connect/package?` is ignored, silently.
- The plugin keeps the offer in the option `wpl7_connect_offer`. While it has not expired and its
  version is above the plugin's own, the plugin adds itself to the `update_plugins` site transient
  as it is read (`site_transient_update_plugins`): `new_version` the offer's, `package` its URL,
  `slug` `wpl7-connect`. WordPress, WP-CLI and the panel's `update` then see an update for WPL7
  Connect like any other. Without an offer, any other entry for the plugin is taken out of that
  transient: its updates come from the panel only.
- The plugin's header says `Update URI: false`, so WordPress 5.8 and later never ask
  wordpress.org about it. The transient filter above covers the versions before.
- The panel signs the package link with an HMAC only it knows and lets it live two hours; a ping
  every hour renews it. Before it updates the plugin itself, the panel sends a fresh offer.
