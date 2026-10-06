// @docs security/accounts
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { Button, ErrorNote, Field, inputClass } from '../components/ui';
import { QuietButton, SignedOutCard } from '../components/SignedOutCard';

/**
 * Where a reset link lands. The token is after the `#`, which a browser never sends anywhere:
 * it stays out of every server log and Referer header, and reaches the panel only in the body
 * of the one request that spends it.
 */
export function ResetPassword() {
  const [token] = useState(() => location.hash.slice(1));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || password.length < 10) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ username: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: password },
      });
      setUsername(res.username);
      setPassword('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const askAgain = () => {
    location.href = '/login?forgot';
  };

  if (username !== null) {
    return (
      <SignedOutCard subtitle="Password changed">
        <p className="text-sm text-neutral-600">
          <span className="font-medium">{username}</span> has a new password, and every session it had open
          is signed out. Sign in with the new one.
        </p>
        <Button onClick={() => (location.href = '/login')}>Sign in</Button>
      </SignedOutCard>
    );
  }

  if (!token) {
    return (
      <SignedOutCard subtitle="Choose a new password">
        <ErrorNote error={new Error('This link is incomplete. Open it from the email again, or ask for a new one.')} />
        <QuietButton onClick={askAgain}>Ask for a new link</QuietButton>
      </SignedOutCard>
    );
  }

  return (
    <SignedOutCard subtitle="Choose a new password" onSubmit={submit}>
      <Field label="New password" hint="Minimum 10 characters.">
        <input
          className={inputClass}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" disabled={busy || password.length < 10}>
        {busy ? 'Saving…' : 'Set new password'}
      </Button>
      {error !== null && <QuietButton onClick={askAgain}>Ask for a new link</QuietButton>}
    </SignedOutCard>
  );
}
