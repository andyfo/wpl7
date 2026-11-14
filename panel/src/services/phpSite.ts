// @docs sites/php
/**
 * What a PHP site starts with, and the page that stands in for its own files until they are
 * uploaded. A PHP site is a hosted site with no WordPress in it (sites.app): the same container
 * and image, and nothing put into its folder but this page.
 */

/** The file the create job writes into a new PHP site's web root. */
export const PLACEHOLDER_FILE = 'index.html';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A new PHP site's only file: its title and one line. Self-contained, with nothing loaded from
 * elsewhere, and kept out of search engines, so a site that is never uploaded to is not found.
 */
export function renderPlaceholderPage(title: string): string {
  const name = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #1e293b; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 32rem; padding: 2rem; text-align: center; }
h1 { margin: 0 0 0.5rem; font-size: 1.75rem; }
p { margin: 0; color: #475569; }
</style>
</head>
<body>
<main>
<h1>${name}</h1>
<p>This site is ready. Upload your files to replace this page.</p>
</main>
</body>
</html>
`;
}
