import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { panelUsernameSchema } from '../../../shared/schemas';
import type { PanelUserDto } from '../../../shared/types';
import { api } from '../api/client';
import { useMe, useUsers } from '../api/hooks';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNote, Field, inputClass, Modal } from '../components/ui';
import { formatDate, timeAgo } from '../lib/format';

/** The one difference between accounts, in the pill ServerDetail uses for a server's role. */
export function RolePill({ owner }: { owner: boolean }) {
  return (
    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
      {owner ? 'owner' : 'admin'}
    </span>
  );
}

/**
 * Everyone who can sign in to the panel. There are no roles to hand out: every admin can do
 * everything, and the owner differs only in that nobody else may change or remove them.
 */
export function Users() {
  const users = useUsers();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PanelUserDto | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const myId = me.data?.user?.id ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Everyone who can sign in to this panel. Every admin can do everything; only the owner&apos;s
            account is theirs alone.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>Add admin</Button>
      </div>

      <Card>
        <ErrorNote error={actionError ?? users.error} />
        {users.isPending ? (
          <EmptyState>Loading…</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Username</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Two-factor</th>
                <th className="pb-2">Created</th>
                <th className="pb-2">Last sign-in</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr
                  key={u.id}
                  // A mouse convenience on top of the real link in the name cell, as on
                  // Servers: the name stays an anchor for the keyboard and for new tabs.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a, button, input, select')) return;
                    if (e.metaKey || e.ctrlKey) window.open(`/users/${u.id}`, '_blank');
                    else void navigate(`/users/${u.id}`);
                  }}
                  className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-50"
                >
                  <td className="py-2.5 pr-3">
                    <Link to={`/users/${u.id}`} className="font-medium hover:underline">
                      {u.username}
                    </Link>
                    {u.id === myId && <span className="ml-2 text-xs text-neutral-500">you</span>}
                    {u.email && <div className="text-xs text-neutral-500">{u.email}</div>}
                  </td>
                  <td className="py-2.5 pr-3">
                    <RolePill owner={u.isOwner} />
                  </td>
                  <td className="py-2.5 pr-3 text-xs">
                    {u.twoFactor.enabled ? (
                      <span className="font-medium text-emerald-700">on</span>
                    ) : (
                      <span className="text-neutral-500">off</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-neutral-500">{formatDate(u.createdAt)}</td>
                  <td className="py-2.5 pr-3 text-xs text-neutral-500">
                    {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}
                  </td>
                  <td className="py-2.5 text-right">
                    {!u.isOwner && u.id !== myId && (
                      <Button small variant="ghost" onClick={() => setRemoveTarget(u)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {addOpen && <AddAdminModal onClose={() => setAddOpen(false)} />}
      {removeTarget && (
        <ConfirmDialog
          title={`Remove ${removeTarget.username}`}
          confirmWord={removeTarget.username}
          confirmLabel="Remove"
          message="Their sessions end immediately and they can no longer sign in. API keys are not affected."
          onConfirm={() => {
            setActionError(null);
            void api(`/api/users/${removeTarget.id}`, { method: 'DELETE' })
              .then(() =>
                Promise.all([
                  qc.invalidateQueries({ queryKey: ['users'] }),
                  qc.invalidateQueries({ queryKey: ['user', removeTarget.id] }),
                ]),
              )
              .catch(setActionError);
          }}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}

function AddAdminModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ready = panelUsernameSchema.safeParse(username).success && password.length >= 10 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/users', { method: 'POST', body: { username, password } });
      await qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title="Add admin" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <Field label="Username" hint="3–60 characters: letters, digits and . _ @ -">
          <input
            className={inputClass}
            autoComplete="off"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password" hint="Minimum 10 characters. They can change it on their own page.">
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready}>
            Add admin
          </Button>
        </div>
      </form>
    </Modal>
  );
}
