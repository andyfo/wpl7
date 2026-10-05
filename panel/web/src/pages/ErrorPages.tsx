import type { ReactNode } from 'react';
import { Link, isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router';
import { useMeta } from '../api/hooks';
import { SignedOutCard } from '../components/SignedOutCard';
import { Button, OutLink } from '../components/ui';

/*
 * What shows in place of a page: for an address with no page behind it, and for a page that
 * threw while drawing itself. Without these, react-router puts up its own screen, which is
 * written for the developer ("Hey developer 👋") rather than for whoever is using the panel.
 */

/** The catch-all route's id, which the header's breadcrumb looks for. */
export const NOT_FOUND_ROUTE = 'not-found';

/** Button looks for a link. Both carry a border, transparent on the primary, so a pair stands level. */
const LINK_BUTTON =
  'inline-flex items-center justify-center rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors';
const PRIMARY_LINK = `button-primary border-transparent ${LINK_BUTTON}`;
const SECONDARY_LINK = `border-neutral-300 bg-surface text-neutral-800 hover:bg-neutral-50 ${LINK_BUTTON}`;

/** Any address the router has no page for. Inside the layout, so the sidebar is there to go on from. */
export function NotFound() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <ErrorScreen
      mark={
        <div className="error-code mb-6" aria-hidden>
          404
        </div>
      }
      title="Page not found"
      actions={
        <>
          <Link to="/" className={PRIMARY_LINK}>
            Go to the dashboard
          </Link>
          {/* Only after a step inside the panel: opened from a bookmark or another site, Back would leave it. */}
          {location.key !== 'default' && (
            <Button variant="secondary" onClick={() => navigate(-1)}>
              Go back
            </Button>
          )}
        </>
      }
    >
      There is no page at{' '}
      <code className="break-all rounded-md border border-neutral-200 bg-surface px-1.5 py-0.5 text-[13px] text-neutral-800">
        {location.pathname}
      </code>
      .
    </ErrorScreen>
  );
}

/** A page that threw, in its place inside the layout. */
export function PageError() {
  const error = useRouteError();
  const meta = useMeta();
  return (
    <ErrorScreen
      title="This page crashed"
      actions={
        <>
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Link to="/" className={SECONDARY_LINK}>
            Go to the dashboard
          </Link>
        </>
      }
      footer={meta.data && <OutLink href={`${meta.data.repoUrl}/issues`}>Report the bug</OutLink>}
    >
      <ErrorDetail error={error} />
    </ErrorScreen>
  );
}

/**
 * Whatever throws outside the layout: the layout itself, or a page a signed-out browser
 * reaches - so it wears their card. No link to the issues here: their address comes from
 * /api/meta, and asking for it from a signed-out page would be sent to the sign-in page.
 */
export function AppError() {
  const error = useRouteError();
  return (
    <SignedOutCard subtitle="This page crashed">
      <ErrorDetail error={error} />
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </SignedOutCard>
  );
}

function ErrorScreen({
  mark,
  title,
  children,
  actions,
  footer,
}: {
  mark?: ReactNode;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      {mark}
      <h1 className="page-title">{title}</h1>
      <div className="mt-3 max-w-lg text-sm text-neutral-500">{children}</div>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{actions}</div>
      {footer && <div className="mt-6 text-sm text-neutral-500">{footer}</div>}
    </div>
  );
}

/** What was thrown: an Error, a response react-router made itself, or anything else at all. */
function ErrorDetail({ error }: { error: unknown }) {
  const text = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message || error.name
      : String(error);
  return (
    <code className="block break-words rounded-lg border border-neutral-200 bg-surface px-3 py-2 text-left text-xs text-neutral-700">
      {text}
    </code>
  );
}
