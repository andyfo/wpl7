// @docs sites/php-updates
import { usePhpUpdates } from '../api/hooks';
import { sitePhp } from '../lib/format';
import { phpBehind } from '../lib/php';

/**
 * The PHP a site runs, marked when a newer release of its branch is out: the site moves onto it
 * by itself, and the Overview says how far that got.
 */
export function PhpRelease({ site }: { site: { kind?: string; app?: string; phpVersion: string; phpRelease: string | null } }) {
  const php = usePhpUpdates();
  const behind = phpBehind(site, php.data);
  if (!behind) return <>{sitePhp(site)}</>;
  const why = php.data?.updateNeeded ? 'Update WPL7 to get it.' : 'The site moves onto it by itself.';
  return (
    <span
      className="text-amber-700 underline decoration-amber-400 decoration-dotted underline-offset-2"
      title={`PHP ${behind.version} is out${behind.security ? ', with security fixes' : ''}. ${why}`}
    >
      {sitePhp(site)}
    </span>
  );
}
