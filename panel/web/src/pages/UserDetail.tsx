import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { panelUsernameSchema } from '../../../shared/schemas';
import type { PanelUserDto } from '../../../shared/types';
import { api } from '../api/client';
import { useMe, useUser } from '../api/hooks';
import { Button, Card, ConfirmDialog, ErrorNote, Field, inputClass, Spinner } from '../components/ui';
import { TwoFactorCard } from '../components/TwoFactorCard';
import { formatDate, timeAgo } from '../lib/format';
import { RolePill } from './Users';

/**
 * One admin account: its name, its password, its recovery email and its second factor. Your
 * own page and a colleague's look alike - an admin may change anyone's account but the
 * owner's - except that a second factor is only ever set up by the person holding the phone.
 *
 * Every change asks for the password of whoever is making it, never the account's own: a
 * colleague resetting a password is doing it because nobody knows that one any more.
 */
export function UserDetail() {
  const { id } = useParams();
  const userId = Number(id);
  const user = useUser(userId);
  const me = useMe();

  if (Number.isFinite(userId) && (user.isPending || me.isPending)) return <Spinner />;
  const u = user.data;
  if (!u) {
    return (
      <div className="space-y-4">
        <ErrorNote error={user.error ?? new Error(`User #${id} does not exist.`)} />
        <Link className="text-sm underline" to="/users">
          ← back to users
        </Link>
      </div>
    );
  }

  const self = me.data?.user?.id === u.id;
  const canEdit = self || !u.isOwner;
  const canRemove = !u.isOwner && !self;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="page-title">{u.username}</h1>
            <RolePill owner={u.isOwner} />
            {self && <span className="text-sm text-neutral-500">this is you</span>}
          </div>
          <div className="mt-1 text-sm text-neutral-500">
            Added {formatDate(u.createdAt)} ·{' '}
            {u.lastLoginAt ? `last signed in ${timeAgo(u.lastLoginAt)}` : 'never signed in'}
          </div>
        </div>
        <Link to="/users" className="text-sm text-neutral-500 hover:underline">
          ← users
        </Link>
      </div>

      {canEdit ? (
        // Keyed by account: moving from one admin's page to another's reuses this component,
        // and a half-typed password must not carry over to someone else's form.
        <div key={u.id} className="grid gap-6 xl:grid-cols-2">
          <UsernameCard user={u} self={self} />
          <PasswordCard user={u} self={self} />
          <div className="xl:col-span-2">
            <TwoFactorCard userId={u.id} status={u.twoFactor} self={self} />
          </div>
          <EmailCard user={u} self={self} />
          {canRemove && <RemoveCard user={u} />}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-neutral-600">
            Only the owner can change the owner&apos;s username, password, recovery email and two-factor
            authentication.
          </p>
        </Card>
      )}
    </div>
  );
}

function UsernameCard({ user, self }: { user: PanelUserDto; self: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<{ from: string; to: string } | null>(null);
  const ready = password !== '' && panelUsernameSchema.safeParse(name).success;

  const submit = async () => {
    try {
      await api(`/api/users/${user.id}/username`, { method: 'PUT', body: { password, username: name } });
      setSaved({ from: user.username, to: name });
      setError(null);
      setName('');
      setPassword('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['users'] }),
        qc.invalidateQueries({ queryKey: ['user', user.id] }),
        // The sidebar shows your own name.
        self ? qc.invalidateQueries({ queryKey: ['me'] }) : undefined,
      ]);
    } catch (err) {
      setError(err);
      setSaved(null);
    }
  };

  return (
    <Card title="Username">
      <p className="mb-4 text-sm text-neutral-600">
        Currently <span className="font-medium">{user.username}</span>. Nobody is signed out, and API keys are
        unaffected.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <div className="space-y-4">
          <Field label="New username" hint="3–60 characters: letters, digits and . _ @ -">
            <input className={inputClass} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Your password">
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button type="submit" disabled={!ready}>
            Change username
          </Button>
          {saved && (
            <span className="text-sm text-emerald-700">
              {self ? `Sign in as ${saved.to} from now on.` : `${saved.from} signs in as ${saved.to} from now on.`}
            </span>
          )}
        </div>
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      </form>
    </Card>
  );
}

/**
 * The same request either way; what differs is whose password goes in the first box and
 * what the change does to sessions. On your own account the others are signed out and this
 * one carries on; on a colleague's, every session they have ends.
 */
function PasswordCard({ user, self }: { user: PanelUserDto; self: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const ready = current !== '' && next.length >= 10;

  const submit = async () => {
    try {
      await api(`/api/users/${user.id}/password`, {
        method: 'PUT',
        body: { password: current, newPassword: next },
      });
      setSaved(true);
      setError(null);
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err);
      setSaved(false);
    }
  };

  return (
    <Card title="Password">
      <p className="mb-4 text-sm text-neutral-600">
        {self
          ? 'Every other browser signed in as you is signed out; this one stays.'
          : `Every session ${user.username} has open ends, and the new password is the way back in.`}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <div className="space-y-4">
          <Field label={self ? 'Current password' : 'Your password'}>
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label={self ? 'New password' : `New password for ${user.username}`} hint="Minimum 10 characters">
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button type="submit" disabled={!ready}>
            {self ? 'Change password' : 'Set password'}
          </Button>
          {saved && <span className="text-sm text-emerald-700">{self ? 'Password changed.' : 'Password set.'}</span>}
        </div>
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      </form>
    </Card>
  );
}

/**
 * Where "Forgot your password?" sends its link. A new address is sent a link of its own and
 * only takes over once that is followed, so a reset link always goes to a mailbox somebody
 * proved they read - never to a typo.
 */
function EmailCard({ user, self }: { user: PanelUserDto; self: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const address = email.trim();
  const ready = !busy && password !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPassword('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['users'] }),
        qc.invalidateQueries({ queryKey: ['user', user.id] }),
        self ? qc.invalidateQueries({ queryKey: ['me'] }) : undefined,
      ]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await api(`/api/users/${user.id}/email`, { method: 'PUT', body: { password, email: address } });
      // The address it already has sends nothing; saying "sent" would send someone looking.
      setSentTo(address === user.email ? null : address);
      setEmail('');
    });

  const remove = () =>
    run(async () => {
      await api(`/api/users/${user.id}/email`, { method: 'DELETE', body: { password } });
      setSentTo(null);
    });

  return (
    <Card title="Recovery email">
      <p className="mb-4 text-sm text-neutral-600">
        {user.email ? (
          <>
            “Forgot your password?” on the sign-in page sends its link to{' '}
            <span className="font-medium">{user.email}</span>.
          </>
        ) : (
          'None yet. Without one, “Forgot your password?” has nowhere to send its link.'
        )}
      </p>
      {user.pendingEmail && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">{user.pendingEmail}</span> is waiting to be confirmed with the link
          sent to it, which works for 24 hours{user.email ? '. Until then, links keep going to the address above' : ''}.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        <div className="space-y-4">
          <Field
            label={user.email ? 'New address' : 'Address'}
            hint={
              self
                ? 'It takes over once you follow the link sent to it.'
                : `It takes over once ${user.username} follows the link sent to it.`
            }
          >
            <input
              className={inputClass}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Your password">
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!ready}>
            Send confirmation link
          </Button>
          {(user.email || user.pendingEmail) && (
            <Button variant="ghost" disabled={busy || password === ''} onClick={() => void remove()}>
              Remove
            </Button>
          )}
          {sentTo && <span className="text-sm text-emerald-700">Link sent to {sentTo}.</span>}
        </div>
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      </form>
    </Card>
  );
}

function RemoveCard({ user }: { user: PanelUserDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <Card title="Remove admin">
      <p className="mb-4 text-sm text-neutral-600">
        {user.username} can no longer sign in, and every session they have open ends. API keys are not affected.
      </p>
      <Button variant="danger" onClick={() => setConfirming(true)}>
        Remove {user.username}
      </Button>
      <div className="mt-2">
        <ErrorNote error={error} />
      </div>
      {confirming && (
        <ConfirmDialog
          title={`Remove ${user.username}`}
          confirmWord={user.username}
          confirmLabel="Remove"
          message="Their sessions end immediately and they can no longer sign in. API keys are not affected."
          onConfirm={() => {
            setError(null);
            void api(`/api/users/${user.id}`, { method: 'DELETE' })
              .then(async () => {
                await Promise.all([
                  qc.invalidateQueries({ queryKey: ['users'] }),
                  // Marked stale but not fetched: this page is on its way out, and asking for
                  // the account just removed would flash "not found" on the way.
                  qc.invalidateQueries({ queryKey: ['user', user.id], refetchType: 'none' }),
                ]);
                void navigate('/users');
              })
              .catch(setError);
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}
