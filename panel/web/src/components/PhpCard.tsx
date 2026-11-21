// @docs sites/php-updates
import { Link } from 'react-router';
import { usePhpUpdates } from '../api/hooks';
import { PHP_TONES, phpLines, type PhpLine } from '../lib/php';
import { usePhpDetails } from './PhpDetails';
import { Card, OutLink } from './ui';

/**
 * The Overview's PHP card: the PHP each version's sites run, and in its place, while some are
 * behind a new release, how that release is reaching them. Also a security release coming, and
 * the next releases. A version's line opens its details (PhpDetails).
 */
export function PhpCard() {
  const query = usePhpUpdates();
  const open = usePhpDetails();
  if (!query.data) return null;
  const lines = phpLines(query.data, Date.now());
  if (lines.length === 0) return null;
  return (
    <Card title="PHP">
      <ul className="space-y-2 text-sm">
        {lines.map((line, i) => (
          <PhpLineItem key={i} line={line} open={open} />
        ))}
      </ul>
    </Card>
  );
}

function PhpLineItem({ line, open }: { line: PhpLine; open: (branch: string) => void }) {
  if (line.kind === 'notice') {
    return (
      <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
        <span className="font-medium">
          <OutLink href={line.url}>{line.text}</OutLink>
        </span>
      </li>
    );
  }
  if (line.kind === 'next') {
    return <li className="text-neutral-500">{line.text}</li>;
  }
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHP_TONES[line.tone]}`} />
        <button type="button" className="text-left hover:underline" onClick={() => open(line.branch)}>
          {line.text}
        </button>
        {line.badge && <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">{line.badge}</span>}
        {line.update && (
          <Link className="text-xs text-neutral-500 hover:underline" to="/settings#updates">
            Updates →
          </Link>
        )}
      </div>
      {line.sites.length > 0 && (
        <p className="mt-1 pl-3.5 text-xs text-neutral-500">
          {line.sites.map((site, i) => (
            <span key={site.slug}>
              {i > 0 && ', '}
              <Link className="hover:underline" to={`/sites/${site.slug}`} title={`PHP ${site.release ?? 'unknown'}`}>
                {site.title}
              </Link>
            </span>
          ))}
          {line.more > 0 && ` and ${line.more} more`}
        </p>
      )}
    </li>
  );
}
