// @docs sites/php-updates
import { usePhpUpdates } from '../api/hooks';
import { sitePhp } from '../lib/format';
import { phpBehind } from '../lib/php';

/**
 * The PHP a site runs, or a server's site image has, marked when a newer release of its branch is
 * out: it moves onto it by itself, and the Overview says how far that got.
 */
export function PhpRelease({
  site,
  image = false,
}: {
  site: { kind?: string; app?: string; phpVersion: string; phpRelease: string | null };
  /** A server's site image rather than a site. */
  image?: boolean;
}) {
  const php = usePhpUpdates();
  const behind = phpBehind(site, php.data);
  if (!behind) return <>{sitePhp(site)}</>;
  const why = php.data?.updateNeeded
    ? 'Update WPL7 to get it.'
    : image
      ? 'The server gets a new image by itself.'
      : 'The site moves onto it by itself.';
  return (
    <span
      className="text-amber-700 underline decoration-amber-400 decoration-dotted underline-offset-2"
      title={`PHP ${behind.version} is out${behind.security ? ', with security fixes' : ''}. ${why}`}
    >
      {sitePhp(site)}
    </span>
  );
}
