# Bundled catalog

Content the panel ships with, one JSON file per entry, validated at boot against
`shared/recipes.ts`. Today that is plugin recipes (`recipes/`): how to supply and activate
a plugin's license, what to redo when the site's URL changes, and how to release it.

Add a plugin by adding a file. The format, the placeholders and the hooks are documented
in `docs/licenses.md`. A file the running panel cannot understand is skipped with a log
line, never fatal.
