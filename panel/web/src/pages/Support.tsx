import type { ReactNode } from 'react';
import { useMeta } from '../api/hooks';
import { Icon, type IconName } from '../components/Icon';
import { OutButton, OutLink } from '../components/ui';

/**
 * Where to go when something needs a person: the community, the Enterprise package, or -
 * for a bug - the issue tracker.
 *
 * The forum and the repository come from /api/meta, which the layout has already loaded,
 * not from /api/system/about: that one asks the host a question first, and this is the page
 * someone opens when the host is the problem. Both follow the install, so a fork sends its
 * operators to its own forum and its own issues.
 */

/*
 * The one link here that is not the install's to choose. Like WP Godmode's, it sends no
 * referrer, which would name this panel's domain; utm_source still lets wpl7.com count the
 * clicks that came from a panel without learning which one.
 */
const ENTERPRISE_URL = 'https://wpl7.com/enterprise/?utm_source=wpl7&utm_medium=panel';

interface Point {
  title: string;
  text: string;
}

const COMMUNITY_POINTS: Point[] = [
  { title: 'Ask anything', text: 'Get help from WPL7 users and maintainers.' },
  { title: 'Learn from others', text: 'Tips, fixes and setups from people running the same stack.' },
  { title: 'Share ideas', text: 'Suggest what WPL7 should do next.' },
];

const ENTERPRISE_POINTS: Point[] = [
  { title: 'Hotfixes', text: 'Critical fixes for your installation, without waiting for the next release.' },
  { title: 'Priority email support', text: 'Your questions go to the front of the queue.' },
  { title: 'Dedicated engineer', text: 'A real person, ready to investigate and help in an emergency.' },
];

export function Support() {
  const meta = useMeta();
  const links = meta.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Support</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Ask the community, get priority support for your business, or report a bug.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SupportCard
          icon="chat"
          tag="Free"
          title="Community support"
          text="The community forum is where people running WPL7 help each other out. Ask a question, or answer one."
          points={COMMUNITY_POINTS}
        >
          {links &&
            (links.communityUrl ? (
              <OutButton href={links.communityUrl}>Open community forum</OutButton>
            ) : (
              <p className="text-xs text-neutral-500">This install points at no community forum.</p>
            ))}
        </SupportCard>
        <SupportCard
          premium
          icon="gem"
          tag="Premium"
          title="Enterprise package"
          text="For agencies and businesses that run WPL7 in production and can’t afford to wait."
          points={ENTERPRISE_POINTS}
        >
          <OutButton href={ENTERPRISE_URL} primary>
            Explore Enterprise
          </OutButton>
        </SupportCard>
      </div>

      {links && (
        <section className="mt-12 flex gap-4">
          <span className="support-icon">
            <Icon name="bug" size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-neutral-900">Found a bug?</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Open an issue on GitHub. For a security problem, please{' '}
              <OutLink href={`${links.repoUrl}/security/advisories/new`}>report it privately</OutLink> instead.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              <OutLink href={`${links.repoUrl}/issues`}>GitHub issues</OutLink>
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One way to get help. The Enterprise card is the same card turned dark green in either theme
 * (.support-premium re-points the neutral and accent tokens), so the two read as a pair and
 * the paid one still stands out from everything else in the panel.
 */
function SupportCard({
  premium,
  icon,
  tag,
  title,
  text,
  points,
  children,
}: {
  premium?: boolean;
  icon: IconName;
  tag: string;
  title: string;
  text: string;
  points: Point[];
  children: ReactNode;
}) {
  return (
    <section className={`panel-card support-card ${premium ? 'support-premium' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <span className="support-icon">
          <Icon name={icon} size={20} />
        </span>
        <span className={`support-tag ${premium ? 'support-tag-premium' : ''}`}>{tag}</span>
      </div>
      <h2 className="support-title mt-5 self-start text-lg font-semibold text-neutral-900">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">{text}</p>
      <ul className="mt-6 space-y-4">
        {points.map((point) => (
          <li key={point.title} className="flex gap-3">
            <span className="support-check">
              <Icon name="check" size={12} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-900">{point.title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500">{point.text}</span>
            </span>
          </li>
        ))}
      </ul>
      {/* Pinned to the foot, so the two buttons sit level whichever card has more to say. */}
      <div className="mt-auto pt-7">{children}</div>
    </section>
  );
}
