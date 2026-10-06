// @docs plugins/updates
import { Link } from 'react-router';
import { timeAgo } from '../../lib/format';

/**
 * Where the severities come from, and whether they are current.
 *
 * Attribution is deliberate rather than decorative: wpvulnerability.net publishes this data
 * for free, with no key and no rate limit, and asks only to be credited.
 */
export function FeedFooter({ enabled, refreshedAt }: { enabled: boolean; refreshedAt: number | null }) {
  return (
    <p className="text-xs text-neutral-400">
      {enabled ? (
        <>
          Vulnerability data:{' '}
          <a
            href="https://www.wpvulnerability.net/"
            target="_blank"
            rel="noreferrer"
            className="hover:text-neutral-600 hover:underline"
          >
            WPVulnerability.net
          </a>
          {refreshedAt ? ` · refreshed ${timeAgo(refreshedAt)}` : ' · not checked yet'}
        </>
      ) : (
        <>
          Vulnerability checks are switched off in{' '}
          <Link to="/settings" className="underline hover:text-neutral-600">
            Settings
          </Link>
          , so nothing is rated.
        </>
      )}
    </p>
  );
}
