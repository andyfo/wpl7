// @docs sites/php-updates
import { Link } from 'react-router';
import { usePhpUpdates } from '../api/hooks';
import { phpLines, type PhpLine } from '../lib/php';
import { Card, OutLink } from './ui';

/** The Overview's PHP card: a security release coming, one out, sites moving onto it. Nothing otherwise. */
export function PhpCard() {
  const query = usePhpUpdates();
  if (!query.data) return null;
  const lines = phpLines(query.data, Date.now());
  if (lines.length === 0) return null;
  return (
    <Card title="PHP">
      <ul className="space-y-2 text-sm">
        {lines.map((line, i) => (
          <PhpLineItem key={i} line={line} />
        ))}
      </ul>
    </Card>
  );
}

const TONES: Record<string, string> = {
  waiting: 'bg-amber-500',
  updating: 'bg-sky-500',
  behind: 'bg-red-500',
  done: 'bg-emerald-500',
};

function PhpLineItem({ line }: { line: PhpLine }) {
  if (line.kind === 'notice') {
    return (
      <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
        <span className="font-medium">{line.text}</span>
        <span className="text-neutral-500">
          <OutLink href={line.url}>php.net</OutLink>
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
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONES[line.tone]}`} />
        <span>{line.text}</span>
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
