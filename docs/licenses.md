# Plugin licenses and recipes

A pro plugin needs more than its zip: a license key, an activation call to the vendor for
the site's URL, the same call again when that URL changes, and a release when the site
goes. The panel does all of that through **recipes** — one JSON file per plugin under
`panel/catalog/recipes/` — and what each recipe asks for (the license key, and whatever the
vendor pairs with it) entered once, on the Recipes page (under **Plugins** in the sidebar).

ACF PRO and Breakdance ship with recipes. Adding another plugin is adding a file.

## What happens, and when

| When | Hook | What the panel does |
|---|---|---|
| Site creation, right after the plugin installs (the container is still unrouted, but already has its route out) | `afterInstall` | writes the constants drop-in, runs the recipe's steps (activate; then update the plugin to the vendor's current release), then the `verify` steps |
| Go-live / domain change, restore under another hostname, move to a server with a different dev domain | `afterUrlChange` | right after the panel's own `wp search-replace`, inside the same started-if-stopped window: re-activation for the new URL, plus whatever the plugin needs (Breakdance's own URL replacement and a cache clear) |
| Site deletion | `beforeRemove` | releases the activation, best effort — the site is deleted either way |
| **Check** on the site page, and after each hook above | `verify` | decides the status the site page shows |

An installed and enabled recipe applies to a plugin that is **installed and active** on the
site, however it got there — catalog zip, the customer's own upload, a restore. An inactive
plugin is left alone and shown as such; a recipe with an input still empty is reported as
"not set up".

The new-site form's **Review** step lists the recipes the site will get from the plugins
picked for it, and marks any that are not set up (those are skipped). An uploaded zip counts
by the folder inside it, which is what WordPress installs it as, not by the zip's file name.

A failing recipe never fails the job around it: a vendor's licensing server being down, or
a key that turns out wrong, becomes a warning in the create/go-live/restore log and a red
status on the site page, where **Activate** runs the recipe again. The on-demand job those
buttons start *does* fail when a recipe does, so it is red on the Jobs page rather than a
warning nobody reads.

## Installing recipes

Knowing a recipe and using it are two things. The **Recipes** page lists every recipe the
panel knows — from the public catalog, bundled with the panel, or added
locally — and nothing runs on a site until the operator **installs** it there. The
catalog lists first the recipes for plugins already on your sites or in your plugin
catalog. An installed recipe can be switched off (**Disabled**: it stops running, and its
constants leave every site at the next recipe run) and **uninstalled**, which also
forgets what was entered for it.

- **From the catalog.** *Install* takes the recipe by reference: the panel keeps using the
  catalog's copy, so **a new version published there replaces the installed one** at the
  next hourly fetch, with no action needed. The installed list shows when a recipe last
  changed. That is the point of the catalog — a vendor changes a command, the recipe is
  corrected once, every panel follows.
- **Local.** *Add a local recipe* takes a recipe of your own in the same format, installed
  and enabled at once. A local recipe is yours: no fetch ever touches it. A local recipe
  with the same id as a catalog recipe replaces it — which is how you freeze or fork a
  catalog recipe: *Copy JSON* on the installed one, change it, add it as local. One local
  recipe per plugin: to change yours, add it again under the same id.
  Uninstalling a local recipe deletes it; copy it first if you want to keep it.

## Bundled recipes

| Plugin | Needs | Activation | After a URL change |
|---|---|---|---|
| **ACF PRO** (`advanced-custom-fields-pro`) | key; ACF PRO 6.2.3 or newer for the URL-change behaviour | defines `ACF_PRO_LICENSE` on the site and runs ACF's own defined-license check through `wp eval` — the same code path a wp-admin visit would trigger, just now | the same call: ACF sees the stored URL differs, releases the old activation and activates the new one |
| **Breakdance** (`breakdance`) | key; Breakdance 2.7 or newer (its WP-CLI commands) | `wp breakdance license <key>`, success meaning the output says `Status: Valid` and `Activation: Active` | `wp breakdance replace_url <old> <new>` (Breakdance stores URLs in JSON, which `search-replace` does not reach), `wp breakdance clear_cache`, then the license command again |

Both install hooks end with an *optional* `wp plugin update <plugin>`: the catalog zip may
be months old, and once the license is active the plugin's own updater can fetch the
current release. Delete that step from the recipe if you pin versions deliberately.

## The catalog

The recipes bundled with the panel are a floor. The same recipes, and any added or
corrected since the release, are published as a **signed public catalog** —
[github.com/andyfo/wpl7-catalog](https://github.com/andyfo/wpl7-catalog),
served at `https://andyfo.github.io/wpl7-catalog/v1/index.json` — which the panel
fetches **once an hour** and thirty seconds after it boots. A published recipe wins over
the bundled copy of the same id. The Recipes page says when the catalog was fetched and
offers *Fetch now* for the minute after something was published; a recipe of your own is
marked *local*.

- **Verified before it is read.** The index is signed with the maintainers' Ed25519 key,
  and the panel carries the public key. An index that does not verify — a mirror, a CDN
  hiccup, a compromised host — is refused and reported; the previous copy stays in use.
  Nothing a fetch does can take a recipe away except a newer *verified* index that no
  longer carries it.
- **Kept.** The last verified copy lives in `panel.db` (table `catalog_entries`) and is
  what the panel boots with, so an unreachable catalog costs nothing.
- **Forward compatible.** Entries carry a `type` and a `typeVersion`. A panel skips what it
  does not understand and shows how many entries need a newer panel — which is the only
  case where a catalog update calls for a software update.
- **Switches** (deploy env, not the UI): `WPL7_CATALOG_URL=off` never fetches and uses
  only the bundled recipes; any other URL points at a fork's own index, in which case
  `WPL7_CATALOG_PUBLIC_KEY` holds that fork's public key (PEM, or just its base64 body).
- **What leaves the box.** One conditional GET of the index and one of its signature per
  hour, from the panel to GitHub Pages, carrying the panel's address and nothing about any
  site. `off` stops that too.

## Where the key lives, and who can read it

- **Panel:** `panel.db`, table `recipe_inputs` (one row per recipe and input), in
  plaintext — like the site database passwords in `sites`. The panel has to hand the key
  to the site in the clear, so encrypting it at rest would protect it from nothing that
  matters.
- **Site:** for inputs with a constant, the must-use plugin
  `wp-content/mu-plugins/wpl7-licenses.php` defines it. The panel writes that file only
  for plugins actually installed on the site (a site without ACF PRO has no business
  holding the ACF PRO key) and only once every input of the recipe is entered, rewrites
  it when values change, and removes it when no plugin on the site takes a constant.
  CLI-based recipes pass the key as an argument to the vendor's command; PHP steps
  receive it as an environment variable (`WPL7_INPUT_KEY` for an input with the id `key`).
- **Site administrators can read it.** Once a licensed plugin is on a site, its key is in
  that site's files or options — that is what licensing a site means, and no recipe design
  changes it.
- **Job logs redact it.** The API never returns it: the list shows the last four characters.
  That holds for every input unless the recipe marks it as not secret — an account email,
  which the Recipes page shows in full. A vendor's command can print the key back in a form
  redaction does not recognise (upper-cased, escaped, cut short), so a Read only key or app
  is told that a step failed, never what it printed (docs/api.md).

## What leaves the box, and to whom

Activation calls go from the **site's container** to the vendor's licensing server (ACF:
`connect.advancedcustomfields.com`; Breakdance: its own API) and carry the key, the site
URL and whatever the plugin itself sends (plugin and WordPress version, PHP version). The
panel makes no call of its own. No key stored means no call.

Activation counts: ACF PRO limits *production* activations and exempts development and
staging URLs by pattern (localhost, IP addresses, `dev.`/`test.`/`staging.` subdomains,
`.test`/`.local` domains); whether `<slug>.dev.<your domain>` matches their rule is theirs
to decide — check the license page in your ACF account after the first site. Breakdance
states that local, staging and development installs do not count against a single-site
license. On go-live ACF releases the dev URL's activation itself; Breakdance is simply
told the key again for the new URL; deleting a site releases both.

## Writing a recipe

`recipes/<id>.json` in the [catalog repository](https://github.com/andyfo/wpl7-catalog)
for everyone, or `panel/catalog/recipes/` for a recipe bundled with the panel; both are
validated against `panel/shared/recipes.ts` (the catalog through the JSON Schema
`npm run catalog:schema` prints from it).
A file the running panel cannot understand is skipped with a log line, never fatal, and a
recipe only ever runs through the same `docker exec` path as every other wp-cli call: as
`www-data`, inside the site's container, with no shell. What a step can do is what a site
administrator could do; nothing on the host.

```json
{
  "type": "plugin-recipe",
  "typeVersion": 1,
  "id": "example-pro",
  "name": "Example Pro",
  "plugin": "example-pro",
  "vendorUrl": "https://example.com/",
  "description": "One sentence on what the recipe does; shown on the Recipes page.",
  "inputs": [
    { "id": "email", "label": "Account email", "secret": false,
      "hint": "The email you log in to example.com with." },
    { "id": "key", "label": "License key", "constant": "EXAMPLE_PRO_LICENSE",
      "hint": "Your license key from example.com → Licenses." }
  ],
  "hooks": {
    "afterInstall": [
      { "run": "wp", "label": "Activating the Example Pro license",
        "args": ["example", "license", "activate", "{{inputs.key}}", "--email={{inputs.email}}"],
        "expect": "activated" },
      { "run": "wp", "label": "Updating to the current release",
        "args": ["plugin", "update", "{{plugin}}"], "optional": true }
    ],
    "afterUrlChange": [
      { "run": "wp", "args": ["example", "license", "activate", "{{inputs.key}}", "--email={{inputs.email}}"],
        "expect": "activated" }
    ],
    "beforeRemove": [
      { "run": "wp", "args": ["example", "license", "deactivate"], "optional": true }
    ],
    "verify": [
      { "run": "php", "label": "Checking the Example Pro license",
        "code": "if (!function_exists('example_license_is_active')) { fwrite(STDERR, \"plugin not loaded\\n\"); exit(1); }\nif (example_license_is_active()) { echo \"OK\\n\"; exit(0); }\nfwrite(STDERR, \"not active\\n\"); exit(1);",
        "expect": "^OK" }
    ]
  }
}
```

- `id` is the identity stored values are filed under; never change it once people have
  entered keys. `plugin` is the directory name `wp plugin list` shows. `version` is for
  people: bump it when the recipe changes. `description` is one plain sentence on what the
  recipe does for the operator — what gets activated when — not how; without one the panel
  makes a sentence from the hooks.
- **`inputs`** is what the operator enters for the plugin, one field each on the Plugins
  page, in this order — usually just the license key, sometimes something the vendor
  pairs with it (WP Rocket wants the account email too). `id` is how steps refer to it
  and what the value is filed under, so keep it stable; `label` names the field and
  `hint` says where to find the value. `constant` makes the panel define that PHP
  constant with the value on the site (for vendors that read a wp-config constant: ACF
  PRO, WP Rocket, Gravity Forms, Meta Box…). Inputs are **secret** unless `"secret": false`:
  masked, never returned by the API, redacted from job logs. The recipe runs once every
  input has a value. A recipe with no inputs can still automate things — an unlicensed
  plugin that needs a cache clear after a URL change, say.
- A **`wp` step** takes its arguments verbatim, with `{{inputs.<id>}}`, `{{plugin}}`,
  `{{url}}` and, in `afterUrlChange`, `{{oldUrl}}` / `{{newUrl}}` substituted. A
  **`php` step** is run through `wp eval` (PHP without an opening tag) and receives the
  same values as environment variables — `WPL7_INPUT_<ID>` (the input's id in capitals),
  `WPL7_SITE_URL`, `WPL7_OLD_URL`, `WPL7_NEW_URL` — so a key is never spliced into code.
  Exit non-zero to fail. A placeholder the panel cannot fill (a typo, an input the recipe
  does not declare) makes the recipe invalid, so the mistake shows when it loads, not on a
  customer's site.
- **`expect`** is a regular expression (JavaScript, multiline) the step's stdout must
  match. Use it whenever the vendor's command exits 0 whatever it concludes. A pattern
  that does not compile makes the recipe invalid.
- **`optional`** steps only warn when they fail; the first failing non-optional step ends
  the run for that plugin, with the step's last lines as the message. A step that does
  not finish within three minutes has failed.
- Every hook may be empty. Without `verify` steps, a hook that ran through counts as
  active.

To try one: put the file under `panel/catalog/recipes/`, restart the panel (bundled files
load at boot), install the recipe and fill in its fields on the Recipes page, install the
plugin on a test site, press **Activate** on its WordPress tab and read the job log. Then
open a pull request at the catalog repository so every panel gets it at its next hourly
fetch.

## Status words on the site page

| Shown | Meaning |
|---|---|
| **active** | the last run (or check) found the license active, for the URL shown |
| **failed** | a step failed, or the check afterwards did; the message says which — a wrong key, a vendor that could not be reached, a plugin version without the command |
| **plugin inactive** | installed but not active on the site, so nothing was done |
| **not set up** | an input of the recipe has no value yet — the message names it (Plugins → Recipes) |
| **released** | the `beforeRemove` hook ran (a deleted site, mid-deletion) |
| **not checked** | the recipe has never run on this site |

## API

`GET /recipes` · `POST /recipes/:id/install` · `DELETE /recipes/:id/install` ·
`PUT /recipes/:id/enabled {enabled}` · `POST /recipes/local {recipe}` · `GET /recipes/:id/definition` ·
`PUT /recipes/:id/inputs/:input {value}` · `DELETE /recipes/:id/inputs/:input` ·
`GET /sites/:slug/wp/recipes` · `POST /sites/:slug/wp/recipes/apply {recipeId?, hook?}` ·
`GET /catalog` · `POST /catalog/refresh` — see [docs/api.md](api.md).
