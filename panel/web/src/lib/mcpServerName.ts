/** Labels that say what the host is, not whose: panel.agency.com is agency's. */
const GENERIC = new Set(['www', 'panel', 'wpl7', 'wp', 'admin']);

/** The second level under a country's domain, as in co.uk or com.au: no one's name either. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

const slug = (s: string) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * What the MCP page's snippets call this panel in an AI app: `wpl7-` and the part of its domain
 * that says whose it is - panel.agency.com gives `wpl7-agency`, staging.agency.co.uk
 * `wpl7-staging-agency`. An app can hold several panels, but only under names of their own:
 * Claude Code refuses to add a second `wpl7`, and in a JSON config the second replaces the
 * first. Letters, digits and hyphens only, so it fits a shell command and a tool name as it is.
 */
export function mcpServerName(serverUrl: string): string {
  const host = new URL(serverUrl).hostname;
  const labels = host.split('.');
  const tld = labels.pop()!;
  // localhost, or an IP address: nothing in it to leave out.
  if (labels.length === 0 || /^\d+$/.test(tld) || host.startsWith('[')) return `wpl7-${slug(host)}`;
  if (tld.length === 2 && labels.length > 1 && SECOND_LEVEL.has(labels.at(-1)!)) labels.pop();
  const whose = slug(labels.filter((label) => !GENERIC.has(label)).join('-'));
  return whose ? `wpl7-${whose}` : 'wpl7';
}
