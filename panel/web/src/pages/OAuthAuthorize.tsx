// @docs integrations/mcp
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useMe } from '../api/hooks';
import { AccessPicker } from '../components/AccessPicker';
import { SignedOutCard } from '../components/SignedOutCard';
import { Button, ErrorNote } from '../components/ui';
import { ACCESS_LABELS, type AccessLevel } from '../../../shared/access';
import { checkRedirectUri } from '../../../shared/oauth';
import type { OAuthCheckDto } from '../../../shared/types';

/**
 * /oauth/authorize: where an AI app sends its admin to be approved (docs/mcp.md). A page of the
 * panel rather than an API route, for the session cookie's sake: it is `SameSite=strict`, so the
 * navigation arriving from the app's site does not carry it - but this page's own requests do.
 *
 * What the admin reads first is where the browser goes afterwards, the one thing on the screen
 * a fake app cannot choose freely; then the app's name, quoted, because it is only a claim; then
 * who is signed in, and the levels with Read only already picked, whatever the app asked for.
 *
 * The panel never sends the browser anywhere by itself. Every navigation from here - an approval,
 * a refusal, an error handed back - is the admin's click on a page that names the destination.
 */
export function OAuthAuthorize() {
  // Sent as it is, and parsed on the server for both calls: what is shown is what is used.
  const query = location.search.replace(/^\?/, '');
  const me = useMe();
  const [check, setCheck] = useState<OAuthCheckDto | null>(null);
  const [access, setAccess] = useState<AccessLevel>('read');
  const [error, setError] = useState<unknown>(null);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    // A 401 here goes to the sign-in page, which comes back to this one (api/client.ts).
    api<OAuthCheckDto>('/api/oauth/authorize/check', { method: 'POST', body: { query } })
      .then(setCheck)
      .catch(setError);
  }, [query]);

  /** Checked again here, before the browser goes: a `javascript:` URL would run in the panel's origin. */
  const go = (to: string) => {
    const checked = checkRedirectUri(to);
    if (!checked.ok) {
      setError(new Error(`Refusing to open ${to}: it ${checked.problem}`));
      return;
    }
    setLeaving(checked.host);
    location.href = to;
  };

  const decide = async (approve: boolean) => {
    setError(null);
    try {
      const res = await api<{ redirectTo: string }>('/api/oauth/authorize/decision', {
        method: 'POST',
        body: { query, approve, access },
      });
      go(res.redirectTo);
    } catch (err) {
      setError(err);
    }
  };

  if (leaving) {
    return (
      <SignedOutCard subtitle="Connect an app">
        <p className="text-sm text-neutral-600">
          Taking you back to <b>{leaving}</b>…
        </p>
      </SignedOutCard>
    );
  }

  if (!check) {
    return (
      <SignedOutCard subtitle="Connect an app">
        {error ? <ErrorNote error={error} /> : <p className="text-sm text-neutral-500">Checking the request…</p>}
      </SignedOutCard>
    );
  }

  if (check.status === 'closed') {
    return (
      <SignedOutCard subtitle="Connect an app">
        <p className="text-sm font-medium text-neutral-800">No connection is being set up.</p>
        <p className="text-sm text-neutral-600">
          {check.reason}. A link like this one only works in the ten minutes after an admin opens a window — so
          nobody can get an app approved by sending you one.
        </p>
        <p className="text-sm text-neutral-600">
          Connecting an app yourself? Open{' '}
          <Link className="underline" to="/integrations/mcp">
            Integrations → MCP
          </Link>
          , press <b>Connect an app</b>, then start again from the app.
        </p>
      </SignedOutCard>
    );
  }

  if (check.status === 'error') {
    const returnTo = check.returnTo;
    const host = returnTo ? checkRedirectUri(returnTo) : null;
    return (
      <SignedOutCard subtitle="Connect an app">
        <p className="text-sm font-medium text-neutral-800">This request cannot be approved.</p>
        <p className="text-sm text-neutral-600">{check.message}.</p>
        <ErrorNote error={error} />
        {returnTo && host?.ok ? (
          <Button variant="secondary" onClick={() => go(returnTo)}>
            Tell the app, at {host.host}
          </Button>
        ) : (
          <p className="text-xs text-neutral-500">Nothing is sent back to the app. You can close this page.</p>
        )}
      </SignedOutCard>
    );
  }

  const { redirect, client, requested } = check;
  return (
    <SignedOutCard subtitle="Connect an app" wide>
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <div className="text-xs text-neutral-500">After you approve, your browser goes to</div>
        <div className="mt-0.5 font-mono text-base font-semibold break-all text-neutral-900">{redirect.host}</div>
        {redirect.kind === 'loopback' && (
          <p className="mt-1 text-xs text-amber-800">
            An app on this computer. Approve only if you started it here yourself, just now.
          </p>
        )}
        {redirect.kind === 'app' && (
          <p className="mt-1 text-xs text-amber-800">A desktop app on this computer, by its {redirect.host} link.</p>
        )}
      </div>
      <p className="text-sm text-neutral-600">
        An app calling itself <b>“{client.name}”</b> asks to use this panel through MCP.
        {me.data?.user && (
          <>
            {' '}
            You are signed in as <b>{me.data.user.username}</b>; the app will act as itself, not as you.
          </>
        )}
      </p>
      <div>
        <div className="mb-1 text-sm font-medium text-neutral-700">What it may do</div>
        <AccessPicker name="app-access" value={access} onChange={setAccess} />
        {requested && requested !== 'read' && (
          <p className="mt-1 text-xs text-neutral-500">
            It asked for {ACCESS_LABELS[requested]}. You decide; you can change it later on the MCP page.
          </p>
        )}
      </div>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <Button onClick={() => void decide(true)}>Approve</Button>
        <Button variant="secondary" onClick={() => void decide(false)}>
          Decline
        </Button>
      </div>
    </SignedOutCard>
  );
}
