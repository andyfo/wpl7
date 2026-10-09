// @docs sites/wordpress
import { useState } from 'react';
import { api } from '../api/client';
import { Button, ErrorNote, ExternalLinkIcon } from './ui';

/**
 * One-click WordPress admin login: the panel mints a single-use token and this opens a tab
 * that spends it. The tab is opened synchronously inside the click handler and pointed at
 * the URL afterwards - opening it once the request has resolved is what popup blockers
 * stop. Blocked anyway: the link is offered instead (single-use, expires in two minutes).
 */
export function WpAdminLoginButton({ slug, running }: { slug: string; running: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setError(null);
    setBlockedUrl(null);
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null; // the customer's site never gets a handle on the panel window
    try {
      const res = await api<{ url: string }>(`/api/sites/${slug}/wp/admin-login`, { method: 'POST' });
      if (tab) tab.location.replace(res.url);
      else setBlockedUrl(res.url);
    } catch (err) {
      tab?.close();
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button small variant="secondary" disabled={!running || busy} onClick={() => void login()}>
        {busy ? 'Signing in…' : 'Log in to WordPress'}
      </Button>
      {blockedUrl && (
        <a
          className="inline-flex items-center gap-1 text-xs underline"
          href={blockedUrl}
          target="_blank"
          rel="noreferrer"
        >
          Popup blocked — open wp-admin (link works once, for two minutes)
          <ExternalLinkIcon />
        </a>
      )}
      <ErrorNote error={error} />
    </>
  );
}
