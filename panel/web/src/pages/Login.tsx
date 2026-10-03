import { useState } from 'react';
import { ApiError, api } from '../api/client';
import { Button, ErrorNote, Field, inputClass } from '../components/ui';
import { QuietButton, SignedOutCard } from '../components/SignedOutCard';
import { nextAfterLogin } from '../lib/loginNext';

/** The server sets this when the half-finished sign-in is gone and only the password is left. */
const mustRestart = (err: unknown) =>
  err instanceof ApiError && (err.details as { restart?: boolean } | undefined)?.restart === true;

/**
 * `code` once the password is accepted and the server asks for a second factor. `forgot` and
 * `sent` are "Forgot your password?" - opened from the link under the password box, or
 * straight away as /login?forgot, which is where a reset link that expired sends people.
 */
type Mode = 'password' | 'code' | 'forgot' | 'sent';

/** Signing in on the way to an AI app's approval page (lib/loginNext.ts). */
const FOR_APPROVAL = nextAfterLogin(location.search) !== '/';

const SUBTITLE: Record<Mode, string> = {
  password: FOR_APPROVAL ? 'Sign in to approve an app' : 'Sign in to the control panel',
  code: 'Two-factor authentication',
  forgot: 'Reset your password',
  sent: 'Reset your password',
};

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [login, setLogin] = useState('');
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).has('forgot') ? 'forgot' : 'password',
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Load the panel as a new document instead of switching route: the session cookie now
   * exists, so the panel serves a document that says so, and the app paints its shell on
   * the first frame rather than waiting to be told who we are. Back to the approval page when
   * an AI app sent us here (lib/loginNext.ts); to the dashboard otherwise.
   */
  const enterPanel = () => {
    location.href = nextAfterLogin(location.search);
  };

  const restart = () => {
    setMode('password');
    setCode('');
    setPassword('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        // Answered the same whether or not anything was sent, so there is nothing to tell
        // apart here either: the next screen says what may happen, not what did.
        await api('/api/auth/forgot-password', { method: 'POST', body: { login: login.trim() } });
        setMode('sent');
        return;
      }
      if (mode === 'code') {
        await api('/api/auth/login/totp', { method: 'POST', body: { code } });
        enterPanel();
        return;
      }
      const res = await api<{ totpRequired: boolean }>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      if (res.totpRequired) {
        // The password is done with: the pending session on the cookie is what the code
        // is checked against, so nothing here has to hold on to it.
        setPassword('');
        setMode('code');
        return;
      }
      enterPanel();
    } catch (err) {
      setError(err);
      // A pending sign-in that timed out or ran out of tries is gone server-side; the only
      // way forward is the password again, so don't leave a dead code box on screen.
      if (mustRestart(err)) {
        setMode('password');
        setCode('');
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SignedOutCard subtitle={SUBTITLE[mode]} onSubmit={submit}>
      {mode === 'code' && (
        <>
          <Field
            label="Authentication code"
            hint="The six digits from your authenticator app — or one of your recovery codes."
          >
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
            />
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? 'Checking…' : 'Verify'}
          </Button>
          <QuietButton onClick={restart}>Start over</QuietButton>
        </>
      )}

      {mode === 'forgot' && (
        <>
          <p className="text-sm text-neutral-600">
            A link to choose a new password goes to the account&apos;s recovery email, if it has one.
          </p>
          <Field label="Username or recovery email">
            <input
              className={inputClass}
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy || !login.trim()}>
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
          <QuietButton onClick={restart}>Back to sign in</QuietButton>
        </>
      )}

      {mode === 'sent' && (
        <>
          <p className="text-sm text-neutral-600">
            If that account has a recovery email, a link to reset its password is on its way. It works
            once, for 30 minutes.
          </p>
          <p className="text-sm text-neutral-600">
            Nothing arriving? Check the spam folder, or ask another admin to set you a new password.
          </p>
          <QuietButton onClick={restart}>Back to sign in</QuietButton>
        </>
      )}

      {mode === 'password' && (
        <>
          <Field label="Username">
            <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <QuietButton
            onClick={() => {
              setLogin(username);
              setError(null);
              setMode('forgot');
            }}
          >
            Forgot your password?
          </QuietButton>
        </>
      )}
    </SignedOutCard>
  );
}
