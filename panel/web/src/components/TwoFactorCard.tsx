import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TwoFactorEnrollmentDto, TwoFactorStatusDto } from '../../../shared/types';
import { api } from '../api/client';
import { formatDate } from '../lib/format';
import { Button, Card, ErrorNote, Field, inputClass } from './ui';

/** What the password re-check is standing in front of. */
type Intent = 'setup' | 'recovery' | 'disable';

type Step =
  | { kind: 'idle' }
  | { kind: 'password'; intent: Intent }
  | { kind: 'enroll'; enrollment: TwoFactorEnrollmentDto }
  | { kind: 'codes'; codes: string[] };

const INTENT_LABEL: Record<Intent, string> = {
  setup: 'Continue',
  recovery: 'Generate new codes',
  disable: 'Turn off two-factor authentication',
};

/** Base32 is much easier to copy by eye in blocks of four. */
const groupSecret = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * One account's second factor. `self` is whether the person looking is that account: only
 * they can enrol a phone or print new recovery codes, since only they are holding the phone.
 * Anyone else gets the one thing a colleague can do for them - turn it off, for when the
 * phone is gone.
 */
export function TwoFactorCard({ userId, status, self }: { userId: number; status: TwoFactorStatusDto; self: boolean }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep({ kind: 'idle' });
    setPassword('');
    setCode('');
    setError(null);
  };

  /** Every call here changes a login, so the account (and its status) has to be re-read. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['user', userId] }),
        qc.invalidateQueries({ queryKey: ['users'] }),
        self ? qc.invalidateQueries({ queryKey: ['me'] }) : undefined,
      ]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (intent: Intent) =>
    run(async () => {
      if (intent === 'setup') {
        const enrollment = await api<TwoFactorEnrollmentDto>(`/api/users/${userId}/totp/setup`, {
          method: 'POST',
          body: { password },
        });
        setStep({ kind: 'enroll', enrollment });
      } else if (intent === 'recovery') {
        const res = await api<{ recoveryCodes: string[] }>(`/api/users/${userId}/totp/recovery-codes`, {
          method: 'POST',
          body: { password },
        });
        setStep({ kind: 'codes', codes: res.recoveryCodes });
      } else {
        await api(`/api/users/${userId}/totp`, { method: 'DELETE', body: { password } });
        setStep({ kind: 'idle' });
      }
      setPassword('');
    });

  const enable = () =>
    run(async () => {
      const res = await api<{ recoveryCodes: string[] }>(`/api/users/${userId}/totp/enable`, {
        method: 'POST',
        body: { code },
      });
      setCode('');
      setStep({ kind: 'codes', codes: res.recoveryCodes });
    });

  return (
    <Card title="Two-factor authentication">
      {step.kind === 'idle' &&
        (status.enabled ? <EnabledSummary status={status} self={self} /> : <OffSummary self={self} />)}

      {step.kind === 'password' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-600">
            Confirm with your password.
            {!self && step.intent === 'disable' && ' They can set it up again from their own page.'}
          </p>
          <Field label="Your password">
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password) void submitPassword(step.intent);
              }}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              variant={step.intent === 'disable' ? 'danger' : 'primary'}
              disabled={busy || !password}
              onClick={() => void submitPassword(step.intent)}
            >
              {INTENT_LABEL[step.intent]}
            </Button>
            <Button variant="secondary" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step.kind === 'enroll' && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            Scan this with an authenticator app, then type the six digits it shows.
          </p>
          <div className="flex flex-wrap items-start gap-6">
            <img
              src={step.enrollment.qrDataUrl}
              alt="Two-factor setup QR code"
              className="h-44 w-44 rounded-lg border border-neutral-200"
            />
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                Or type it in
              </div>
              <code className="block rounded-lg bg-neutral-100 px-3 py-2 text-sm tracking-wide">
                {groupSecret(step.enrollment.secret)}
              </code>
              <p className="max-w-xs text-xs text-neutral-500">
                Time-based, 6 digits, 30 seconds.
              </p>
            </div>
          </div>
          <Field label="Code from the app">
            <input
              className={`${inputClass} max-w-40 tracking-widest`}
              value={code}
              autoComplete="one-time-code"
              inputMode="numeric"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.trim().length >= 6) void enable();
              }}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button disabled={busy || code.trim().length < 6} onClick={() => void enable()}>
              Turn it on
            </Button>
            <Button variant="secondary" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step.kind === 'codes' && <RecoveryCodes codes={step.codes} onDone={reset} />}

      {step.kind === 'idle' && (self || status.enabled) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {status.enabled ? (
            <>
              {self && (
                <Button variant="secondary" onClick={() => setStep({ kind: 'password', intent: 'recovery' })}>
                  New recovery codes
                </Button>
              )}
              <Button variant="secondary" onClick={() => setStep({ kind: 'password', intent: 'disable' })}>
                Turn off
              </Button>
            </>
          ) : (
            <Button onClick={() => setStep({ kind: 'password', intent: 'setup' })}>Set up</Button>
          )}
        </div>
      )}

      {error !== null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
    </Card>
  );
}

function OffSummary({ self }: { self: boolean }) {
  if (!self) {
    return (
      <p className="text-sm text-neutral-600">
        Off. Only the person holding the phone can set it up, from their own page.
      </p>
    );
  }
  return (
    <p className="text-sm text-neutral-600">
      Off. Turn it on and signing in asks for a code from your phone as well as the password. API keys
      are unaffected.
    </p>
  );
}

function EnabledSummary({ status, self }: { status: TwoFactorStatusDto; self: boolean }) {
  const low = status.recoveryCodesLeft <= 3;
  return (
    <div className="space-y-2 text-sm text-neutral-600">
      <p>
        <span className="font-medium text-emerald-700">On</span> since {formatDate(status.confirmedAt)}. Signing
        in asks for a code from {self ? 'your' : 'their'} authenticator app.
      </p>
      <p className={low ? 'text-amber-700' : undefined}>
        {status.recoveryCodesLeft} recovery {status.recoveryCodesLeft === 1 ? 'code' : 'codes'} left
        {low && (self ? ' — generate a new set before you run out' : ' — they can generate a new set')}.
      </p>
    </div>
  );
}

/**
 * Shown exactly once: the codes are stored hashed, so nothing can print them again. Once they
 * and the phone are both gone, a colleague can turn 2FA off from this page - or, for the
 * owner, whom nobody else may change, it is the DB from a shell on the server
 * (docs/troubleshooting.md).
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="font-semibold">Save these recovery codes now.</div>
        They are shown once. Each one signs you in a single time.
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-neutral-100 p-4 font-mono text-sm">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(codes.join('\n'));
            setCopied(true);
          }}
        >
          {copied ? 'Copied!' : 'Copy all'}
        </Button>
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}
