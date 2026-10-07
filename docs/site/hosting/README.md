# Publishing the docs to the website

The docs are static files in the `/docs` folder of the website, a WordPress site. The website
fetches every new build itself. GitHub holds no key to the website, and the website needs none
to GitHub.

## How it works

1. The `package` job in `.github/workflows/docs.yml` builds the site and zips it. It runs on
   every merge to `main` that changes the docs or the code they document, after every release,
   and by hand.
2. The `publish` job puts the zip on the repository's
   [`docs-site` release](https://github.com/andyfo/wpl7/releases/tag/docs-site). Beside it,
   `wpl7-docs.json` names the zip, its size and its SHA-256.
3. On the website, the must-use plugin [`wpl7-docs.php`](wpl7-docs.php) adds the command
   `wp wpl7-docs update`, and a schedule runs it. When `/docs` has another build than the one
   `wpl7-docs.json` names, the command downloads that zip and installs it.

## What an update checks

- The zip's size and SHA-256 match `wpl7-docs.json`.
- Every file has a plain name and a type the docs are made of: HTML, CSS, JavaScript, JSON,
  images, fonts and the search index. No `.php` file, no dot file such as `.htaccess`, no `..`
  and no link gets in.
- `index.html` and `404.html` are at the top of the zip.

A failed check stops the update before anything is written, and the job's message names the
file. The new build is unpacked next to `/docs` and swapped in once it is complete, so a failed
update leaves the old docs in place.

The plugin writes the folder's `.htaccess` itself. It turns WordPress's rewrites and PHP off in
`/docs`, serves the docs' own 404 page and sets how long browsers keep each file. A bad zip
could show wrong docs, but it cannot run code on the server.

The `package` job installs every zip with this plugin before it is published. A zip the plugin
would refuse fails there, not on the website.

## Set it up on a WPL7 site

1. In the site's **Files** tab, open `wp-content/mu-plugins` and upload `wpl7-docs.php`. Create
   the folder if it is missing. A must-use plugin needs no activation.
2. In **Automations → Schedules**, choose **New schedule** and fill it in:

   | Field | Value |
   |---|---|
   | **What** | **WP-CLI command** |
   | **On** | the website's site |
   | **Command** | `wpl7-docs update` |
   | **When** | **Repeat**, **Cron schedule** `0 * * * *`, every hour |

3. Choose **Run now** on the schedule's row. The job's log ends with a line like this one:

   ```
   Success: Installed the docs: commit a1b2c3d, built 2026-10-06T12:00:00Z, 364 files.
   ```

Each run is a job. A run that finds nothing new ends within seconds with "The docs are up to
date". A failed run shows in **Automations → All jobs** with the reason, and the docs stay as
they were.

On a server without WPL7, a cron job that runs `wp wpl7-docs update` in the WordPress folder
does the same.

## WordPress

- No page, post or plugin route may use the slug `docs`. The folder would still win, but
  editors and sitemaps would see two things at one address.
- Add the docs' sitemap to the site's robots output, in the SEO plugin's robots setting or with
  a `robots_txt` filter:

  ```
  Sitemap: https://www.example.com/docs/sitemap-index.xml
  ```

- Leave page-cache plugins as they are. They cache WordPress's PHP pages, not files in `/docs`.

## Commands

| Command | What it does |
|---|---|
| `wp wpl7-docs update` | Installs the latest build, unless `/docs` has it |
| `wp wpl7-docs update --force` | Installs the latest build again |
| `wp wpl7-docs status` | Shows the build in `/docs` and the latest one |

`/docs/build.json` names the build that is installed. To fetch from another repository's
release, a fork's for example, set its address in `wp-config.php`:

```php
define('WPL7_DOCS_MANIFEST_URL', 'https://github.com/example/wpl7/releases/download/docs-site/wpl7-docs.json');
```

## When the plugin changes

The website runs its own copy of `wpl7-docs.php`. Upload it again after a change here. The
`package` job checks every zip with the repository's copy, so an older copy on the website can
still refuse a zip that passed. The failed job then names the file.

## Limits

- New docs go live at the schedule's next run, not at the merge.
- The site's backups include `/docs`. A restore brings back the backup's docs until the next run.
- `/docs` must be a plain folder. A link or a file in its place stops the update.
