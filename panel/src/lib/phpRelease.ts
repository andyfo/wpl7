/**
 * A PHP release as the panel stores and shows it: `PHP_VERSION` as a site image sets it, or as
 * WPL7 Connect reports it. Upstream builds read 8.4.27. A distribution's build carries its own
 * patch level after that (8.3.6-0ubuntu0.24.04.13), which is kept: that is where its security
 * fixes show. Anything else is not a release, and null.
 */
export function phpReleaseOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const release = value.trim();
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}[0-9A-Za-z.+~_-]{0,24}$/.test(release) ? release : null;
}
