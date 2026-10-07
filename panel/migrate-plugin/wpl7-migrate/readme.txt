=== WPL7 Migrate ===
Tags: migration, import, move
Requires at least: 5.0
Tested up to: 7.1
Requires PHP: 7.0
License: AGPL-3.0-only
License URI: https://www.gnu.org/licenses/agpl-3.0.html

Moves this site to a WPL7 panel. The panel copies the files and the database; nothing is packed or uploaded here.

== Description ==

WPL7 is a self-hosted WordPress hosting panel. Its **Import site** gives you this plugin, made for one import.

1. Install the zip: **Plugins > Add New > Upload Plugin**.
2. Activate it. The site connects to the panel.
3. Go on in the panel. It copies the site in short requests, while the site stays online.

The page **Tools > WPL7 Migrate** shows the connection and the copy's progress.

== What is sent ==

Only to the panel the plugin came from, and only to requests the panel signs with this import's code:

* the site's facts: WordPress and PHP versions, the table prefix, plugins, themes, and the settings in wp-config.php other than the database login, keys and salts;
* the files under the WordPress folder, except wp-config.php, caches, backups and logs;
* the rows of the database tables.

While the panel copies the database, it may turn on a maintenance page for visitors. The panel turns it off when it is done; if the panel goes away, it ends on its own within two hours. Administrators can use the site as usual.

== Frequently Asked Questions ==

= What does it not support? =

Multisite networks, and Windows servers.

= When can I remove it? =

When the panel says the import is done. The panel switches the plugin off when it lets go of the site. Deleting the plugin removes its tables and settings.
