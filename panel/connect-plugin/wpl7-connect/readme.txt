=== WPL7 Connect ===
Tags: management, updates, backup
Requires at least: 5.2
Tested up to: 7.1
Requires PHP: 7.0
Stable tag: 0.0.0-dev
License: AGPL-3.0-only
License URI: https://www.gnu.org/licenses/agpl-3.0.html

Connects this site to a WPL7 panel, which then keeps it updated, backed up and watched.

== Description ==

WPL7 is a self-hosted WordPress hosting panel. Its **Sites > Connect a site** gives you this plugin, made for one connection.

1. Install the zip: **Plugins > Add New > Upload Plugin**.
2. Activate it. The site sends its report to the panel.
3. Go back to the panel and finish there.

The page **Settings > WPL7 Connect** shows the connection and the panel's last requests.

== What is sent ==

Only to the panel the plugin came from. The plugin calls the panel once, with the code that came with it: the site's report. After that it only answers requests that the panel signs with its key; the site keeps only the key's public half.

* The report: WordPress and PHP versions, the addresses, the table prefix, the plugins, themes and administrators.
* Plugins, themes and WordPress itself, with their updates.
* For a backup: the files under the WordPress folder, except caches, other backups and logs, and the rows of the database tables.

The panel can update, activate, deactivate, install and delete plugins and themes, update WordPress, run commands other plugins registered for it, call the site's REST API, and open a one-time login link. Before an update it keeps a copy of the plugin or theme, to put back if the update breaks the site; copies older than a week are removed.

== Frequently Asked Questions ==

= What does it not support? =

Multisite networks, and Windows servers.

= How do I disconnect? =

Press **Disconnect** on **Settings > WPL7 Connect**, or remove the site in the panel. The panel can then no longer reach the site.

= What does deleting the plugin remove? =

Everything it kept: its tables, its settings, the rollback copies and the must-use loader.
