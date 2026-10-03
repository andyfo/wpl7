import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { Button, ErrorNote } from '../components/ui';
import { SignedOutCard } from '../components/SignedOutCard';

/**
 * Where a confirmation link lands. Opening it confirms nothing: the button does. Mail
 * scanners follow every link in a message - some run its scripts too - and an address a
 * scanner confirmed on a stranger's behalf is exactly the typo this step exists to catch.
 */
export function ConfirmEmail() {
  const [token] = useState(() => location.hash.slice(1));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ username: string; email: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !token) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ username: string; email: string }>('/api/auth/confirm-email', {
        method: 'POST',
        body: { token },
      }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <SignedOutCard subtitle="Recovery email confirmed">
        <p className="text-sm text-neutral-600">
          From now on, “Forgot your password?” sends the reset links of{' '}
          <span className="font-medium">{done.username}</span> to{' '}
          <span className="font-medium">{done.email}</span>.
        </p>
        <Button onClick={() => (location.href = '/')}>Go to the panel</Button>
      </SignedOutCard>
    );
  }

  return (
    <SignedOutCard subtitle="Confirm your recovery email" onSubmit={submit}>
      {token ? (
        <p className="text-sm text-neutral-600">
          Confirm that password reset links for your WPL7 panel account should come to the address
          this link was sent to.
        </p>
      ) : (
        <ErrorNote error={new Error('This link is incomplete. Open it from the email again.')} />
      )}
      <ErrorNote error={error} />
      {token && (
        <Button type="submit" disabled={busy}>
          {busy ? 'Confirming…' : 'Confirm'}
        </Button>
      )}
    </SignedOutCard>
  );
}
