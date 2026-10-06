// @docs panel/appearance
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation } from 'react-router';
import { useMe, useMeta } from '../api/hooks';
import { ApiError, api } from '../api/client';
import { GodmodeBolt } from './Godmode';
import { Icon, type IconName } from './Icon';
import { ThemeSwitch } from './ThemeSwitch';
import { Wordmark } from './Wordmark';

/**
 * The panel marks the document it serves when the request for it already carried a
 * signed-in session (see src/server.ts). That saves the first frame from waiting on
 * /api/auth/me; it is never taken as permission to see anything.
 */
const DOCUMENT_SIGNED_IN = document.documentElement.dataset.session === 'signed-in';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  /**
   * Extra paths this entry owns. A section's own pages do not all live under its link -
   * "/servers/3" is All servers, and "/servers/3/terminal" is Terminal - and a sidebar that
   * highlights nothing (or the wrong thing) on those pages loses the reader's place.
   */
  match?: RegExp;
  children?: NavChild[];
}

interface NavChild {
  to: string;
  label: string;
  end?: boolean;
  /** As on NavItem. */
  match?: RegExp;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  {
    to: '/sites',
    label: 'Sites',
    icon: 'sites',
    children: [
      { to: '/sites', label: 'All sites', end: true },
      { to: '/sites/bulk', label: 'Bulk management' },
      { to: '/sites/security', label: 'Security' },
    ],
  },
  {
    to: '/servers',
    label: 'Servers',
    icon: 'servers',
    children: [
      { to: '/servers', label: 'All servers', end: true, match: /^\/servers\/\d+$/ },
      { to: '/terminal', label: 'Terminal', match: /^\/servers\/\d+\/terminal$/ },
      { to: '/servers/security', label: 'Security' },
    ],
  },
  {
    to: '/plugins',
    label: 'Plugins',
    icon: 'plugins',
    children: [
      { to: '/plugins', label: 'All plugins', end: true },
      { to: '/plugins/recipes', label: 'Recipes' },
    ],
  },
  {
    to: '/backups',
    label: 'Backups',
    icon: 'disk',
    children: [
      { to: '/backups', label: 'All backups', end: true },
      { to: '/backups/storage', label: 'Storage' },
    ],
  },
  { to: '/mail', label: 'Mail', icon: 'mail' },
  {
    to: '/jobs',
    label: 'Automations',
    icon: 'jobs',
    children: [
      { to: '/jobs', label: 'All jobs', end: true, match: /^\/jobs\/\d+$/ },
      { to: '/jobs/schedules', label: 'Schedules' },
    ],
  },
  {
    to: '/api-keys',
    label: 'Integrations',
    icon: 'puzzle',
    children: [
      { to: '/api-keys', label: 'API keys' },
      { to: '/integrations/mcp', label: 'MCP' },
    ],
  },
  { to: '/users', label: 'Users', icon: 'users', end: true, match: /^\/users\/\d+$/ },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

/**
 * Where a group never folds: in the drawer (the max-width: 800px block in styles.css), with
 * nothing beside it for a fly-out to hang in, and on a screen with no hover to open one.
 */
const ALWAYS_OPEN = window.matchMedia('(max-width: 800px), (hover: none)');
const watchAlwaysOpen = (onChange: () => void) => {
  ALWAYS_OPEN.addEventListener('change', onChange);
  return () => ALWAYS_OPEN.removeEventListener('change', onChange);
};

const OFF_NAV_PAGES: Record<string, string> = { '/about': 'About', '/support': 'Support', '/wp-godmode': 'WP Godmode' };

export function Layout() {
  const me = useMe();
  const meta = useMeta();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  // Paint nothing until this browser is known to be signed in. The panel says so in the
  // document it serves; a document from anywhere else - the Vite dev server serves its
  // own - is worth the few milliseconds /api/auth/me takes to answer, because painting
  // the shell on a hunch is the whole panel flashing past on the way to /login, which is
  // the bug. On a 401 that trip is already booked (api/client.ts), so there is nothing
  // worth showing then either. Once the shell has been shown it stays: a 401 on a later
  // refetch either leaves the page anyway, or is held off for unsaved work that blanking
  // everything here would throw away (holdOffLoginRedirect).
  const signedOut = !me.data && me.error instanceof ApiError && me.error.status === 401;
  if (signedOut || (me.isPending && !DOCUMENT_SIGNED_IN)) return null;
  const account = me.data?.user ?? null;

  // About is reached from the header, Support from the foot of the sidebar and WP Godmode
  // from an entry kept apart from NAV, so none of them has a NAV entry to take its name from
  // - and a breadcrumb reading "Workspace / Workspace" is worse than three special cases.
  // A section's pages are its own even where they do not live under its link: /integrations/mcp
  // is Integrations, whose link is /api-keys.
  const page = location.pathname.includes('/terminal')
    ? 'Terminal'
    : (OFF_NAV_PAGES[location.pathname] ??
      NAV.find((item) =>
        item.to === '/'
          ? location.pathname === '/'
          : [item.to, ...(item.children ?? []).map((child) => child.to)].some((to) => location.pathname.startsWith(to)),
      )?.label ??
      'Workspace');

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <LinkBrand />
        {/*
          The nav and the Appearance group scroll as one, so a short window scrolls down to
          Appearance like any other row; only the account row stays pinned. A fly-out is pinned
          to the viewport rather than to its row, so it has to be moved when this scrolls.
        */}
        <div
          className="sidebar-scroll"
          onScroll={(e) => e.currentTarget.querySelectorAll<HTMLElement>('.nav-group-folded').forEach(placeFlyout)}
        >
          <nav className="sidebar-nav" aria-label="Main navigation">
            {NAV.map((item) =>
              item.children ? (
                <NavGroup key={item.to} item={item} pages={item.children} />
              ) : (
                <div key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/' || item.end}
                    className={({ isActive }) =>
                      `nav-item ${isActive || item.match?.test(location.pathname) ? 'nav-item-active' : ''}`
                    }
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                    <span className="nav-indicator" />
                  </NavLink>
                </div>
              ),
            )}
            {/*
              Not one of the panel's own sections, so it sits apart from them and keeps WP
              Godmode's green whatever accent the panel is wearing (.godmode in styles.css).
            */}
            <div className="nav-promo">
              <NavLink
                to="/wp-godmode"
                className={({ isActive }) => `nav-item godmode ${isActive ? 'nav-item-active' : ''}`}
              >
                <GodmodeBolt />
                <span>WP Godmode</span>
                <span className="nav-indicator" />
              </NavLink>
            </div>
          </nav>
          <div className="sidebar-bottom">
            <details
              className="appearance-disclosure"
              onToggle={(e) => {
                // What opens goes below the row, which on a short window is already at the
                // bottom of what shows.
                if (e.currentTarget.open) e.currentTarget.scrollIntoView({ block: 'nearest' });
              }}
            >
              <summary>
                <Icon name="sun" size={17} />
                <span className="flex-1">Appearance</span>
                <span className="appearance-chevron">
                  <Icon name="chevron" size={15} />
                </span>
              </summary>
              <div className="appearance-expanded">
                <ThemeSwitch />
              </div>
            </details>
            {/*
              Down here rather than in NAV: Support and About are pages someone opens twice, and
              a row in the main list would be passed over a hundred times a day to get to Sites.
              About keeps the version in the header as its other way in.
            */}
            <NavLink
              to="/support"
              className={({ isActive }) => `sidebar-bottom-link ${isActive ? 'sidebar-bottom-link-active' : ''}`}
            >
              <Icon name="support" size={17} />
              <span>Support</span>
            </NavLink>
            <NavLink
              to="/about"
              className={({ isActive }) => `sidebar-bottom-link ${isActive ? 'sidebar-bottom-link-active' : ''}`}
            >
              <Icon name="info" size={17} />
              <span>About</span>
            </NavLink>
          </div>
        </div>
        <div className="account-row">
          <Link className="account-link" to={account ? `/users/${account.id}` : '/users'} title="Your account">
            <span className="avatar">{(account?.username ?? '…').slice(0, 2).toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{account?.username ?? '…'}</div>
              <div className="text-xs text-neutral-500">{account?.isOwner ? 'Owner' : 'Administrator'}</div>
            </div>
          </Link>
          <button
            type="button"
            className="icon-button"
            title="Sign out"
            aria-label="Sign out"
            onClick={async () => {
              await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
              // A fresh document rather than a route change: it drops every page of
              // panel data this tab had cached, and what comes back is decided by the
              // panel, which now knows there is no session.
              window.location.href = '/login';
            }}
          >
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>
      {open && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <div className="workspace">
        <header className="workspace-header">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="icon-button mobile-menu"
              aria-label={open ? 'Close navigation' : 'Open navigation'}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <Icon name={open ? 'close' : 'menu'} />
            </button>
            <span className="text-neutral-500">Workspace</span>
            <span className="text-neutral-300">/</span>
            <span className="font-medium">{page}</span>
          </div>
          <div className="version-tag">
            {/*
              The version is the way in to About. It is the one thing on every page a reader
              already looks at to answer "what am I running", so the colophon - the licence,
              the author, what this box is - hangs off it rather than off a nav entry that
              would be passed over a hundred times a day to be used twice.
            */}
            <Link to="/about" className="version-link" title="About WPL7">
              WPL7 <span className="version-number">v{meta.data?.version ?? '…'}</span>
              <Icon name="info" size={15} />
            </Link>
            {meta.data?.updateAvailable && (
              // The one place an operator is guaranteed to look. It is a link rather than a
              // banner because an update is never urgent enough to interrupt what they came
              // here to do - and it goes straight to the button, not the long way via About.
              <>
                <span className="text-neutral-300">·</span>
                <NavLink to="/settings#updates" className="font-medium text-emerald-700 hover:underline">
                  update available
                </NavLink>
              </>
            )}
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="mx-auto max-w-7xl">
            {meta.data?.maintenance && (
              // On every page, not just Settings: a write refused with no explanation is the
              // thing this banner exists to prevent.
              <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <strong>{meta.data.maintenance.reason}.</strong> The panel is read-only until it
                finishes.{' '}
                <NavLink to="/settings#updates" className="font-medium underline">
                  Watch it
                </NavLink>
              </div>
            )}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * A section with pages of its own, such as Sites with All sites and Bulk management. While
 * one of its pages is showing they are listed under it, as they always are on a phone or a
 * touch screen; otherwise they fold away and fly out beside the row on hover or keyboard
 * focus, as in WordPress's admin menu, and the row still opens the first of them. Folded, the
 * links stay in the tab order and to screen readers, as when they always showed. It is one
 * tree either way, so a link followed from the fly-out keeps focus as the group unfolds
 * around it.
 */
function NavGroup({ item, pages }: { item: NavItem; pages: NavChild[] }) {
  const { pathname } = useLocation();
  const alwaysOpen = useSyncExternalStore(watchAlwaysOpen, () => ALWAYS_OPEN.matches);
  // Its pages are everything under its own link and under each of its entries' - a bare
  // /terminal is a Servers page too.
  const showing = [item.to, ...pages.map((page) => page.to)].some((to) =>
    matchPath({ path: to, end: false }, pathname),
  );
  const folded = !showing && !alwaysOpen;
  const ref = useRef<HTMLDivElement>(null);
  // Escape puts the fly-out away without the pointer or focus having to leave it (WCAG
  // 1.4.13); the next hover or focus brings it back.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!folded) return;
    const dismiss = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const group = ref.current;
      // Focus goes back to the row, not left on a link that is no longer shown.
      if (group?.lastElementChild?.contains(document.activeElement)) (group.firstElementChild as HTMLElement).focus();
      setDismissed(true);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [folded]);
  const reveal = (group: HTMLElement) => {
    placeFlyout(group);
    setDismissed(false);
  };
  return (
    <div
      ref={ref}
      className={`nav-group ${folded ? 'nav-group-folded' : ''} ${dismissed ? 'nav-group-dismissed' : ''}`}
      onPointerEnter={(e) => reveal(e.currentTarget)}
      onFocus={(e) => reveal(e.currentTarget)}
    >
      <NavLink
        to={item.to}
        end={item.end}
        className={() => `nav-item ${showing ? 'nav-parent-active' : ''}`}
      >
        <Icon name={item.icon} />
        <span>{item.label}</span>
        <span className="nav-indicator" />
      </NavLink>
      <div className="nav-submenu">
        <div className="nav-children">
          {pages.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              end={page.end === true}
              className={({ isActive }) =>
                `nav-item nav-child ${isActive || page.match?.test(pathname) ? 'nav-item-active' : ''}`
              }
            >
              {page.label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Pins a folded group's fly-out beside its row. It is position: fixed because the sidebar
 * scrolls, and a scroller clips anything that hangs out of it - so it has to be told where
 * the row is. Near the foot of the window it rides up, with its arrow still on the row.
 */
function placeFlyout(group: HTMLElement) {
  const row = group.firstElementChild!.getBoundingClientRect();
  const flyout = group.lastElementChild as HTMLElement;
  const top = Math.max(8, Math.min(row.top, window.innerHeight - flyout.offsetHeight - 8));
  const set = (name: string, px: number) => group.style.setProperty(name, `${px}px`);
  set('--flyout-top', top);
  set('--flyout-left', row.right);
  set('--flyout-arrow', row.top + row.height / 2 - top);
}

function LinkBrand() {
  return (
    <NavLink to="/" className="brand">
      <Wordmark />
    </NavLink>
  );
}
