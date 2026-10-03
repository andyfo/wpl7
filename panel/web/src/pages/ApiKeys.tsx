import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApiKeys } from '../api/hooks';
import { api } from '../api/client';
import { Button, Card, ConfirmDialog, CopyField, EmptyState, ErrorNote, Field, inputClass, Modal, Tabs } from '../components/ui';
import { ActivityTab } from '../components/apiKeys/ActivityTab';
import { DocsTab } from '../components/apiKeys/DocsTab';
import { AccessBadge, AccessPicker } from '../components/AccessPicker';
import { formatDate, timeAgo } from '../lib/format';
import type { AccessLevel } from '../../../shared/access';

const TABS = [
  { id: 'keys', label: 'Keys' },
  { id: 'docs', label: 'Docs' },
  { id: 'activity', label: 'Activity' },
];

export function ApiKeys() {
  const [tab, setTab] = useState('keys');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">API keys</h1>
        <p className="mt-1 text-sm text-neutral-500">
          The REST API, at the level each key was given: <code>Authorization: Bearer wpl7_…</code>.
        </p>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'keys' && <KeysTab />}
      {tab === 'docs' && <DocsTab />}
      {tab === 'activity' && <ActivityTab />}
    </div>
  );
}

function KeysTab() {
  const keys = useApiKeys();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<AccessLevel>('read');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revokeId, setRevokeId] = useState<number | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['api-keys'] });

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />

      <Card
        title={`${(keys.data ?? []).length} key${(keys.data ?? []).length === 1 ? '' : 's'}`}
        action={
          <Button small onClick={() => { setCreateOpen(true); setToken(null); setName(''); setAccess('read'); setError(null); }}>
            New key
          </Button>
        }
      >
        {(keys.data ?? []).length === 0 ? (
          <EmptyState>No API keys yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Name</th>
                <th className="pb-2">Key</th>
                <th className="pb-2">Access</th>
                <th className="pb-2">Created</th>
                <th className="pb-2">Last used</th>
                <th className="pb-2 text-right">Requests (24h)</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id} className="border-t border-neutral-100">
                  <td className="py-2.5 pr-3 font-medium">{k.name}</td>
                  <td className="py-2.5 pr-3 font-mono text-xs text-neutral-500">{k.prefix}…</td>
                  <td className="py-2.5 pr-3"><AccessBadge level={k.access} /></td>
                  <td className="py-2.5 pr-3 text-xs text-neutral-500">{formatDate(k.createdAt)}</td>
                  <td className="py-2.5 pr-3 text-xs text-neutral-500">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}</td>
                  <td className="py-2.5 pr-3 text-right text-xs text-neutral-500">
                    {k.requests24h > 0 ? k.requests24h : '–'}
                  </td>
                  <td className="py-2.5 text-right">
                    <Button small variant="ghost" onClick={() => setRevokeId(k.id)}>Revoke</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {createOpen && (
        <Modal title="New API key" onClose={() => setCreateOpen(false)} dismissible={token === null}>
          {token === null ? (
            <div className="space-y-4">
              <Field label="Name" hint="What uses this key, e.g. billing-system">
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
              {/* Not a Field: that is a <label>, and each level is a label of its own. */}
              <div>
                <span className="mb-1 block text-sm font-medium text-neutral-700">Access</span>
                <AccessPicker name="new-key-access" value={access} onChange={setAccess} />
                <span className="mt-1 block text-xs text-neutral-500">
                  Fixed for the life of the key. Give it the least it needs — a new key is easy to make.
                </span>
              </div>
              <ErrorNote error={error} />
              <div className="flex justify-end">
                <Button
                  disabled={!name.trim()}
                  onClick={() =>
                    void api<{ token: string }>('/api/api-keys', { method: 'POST', body: { name: name.trim(), access } })
                      .then((res) => { setToken(res.token); void refresh(); })
                      .catch(setError)
                  }
                >
                  Create
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm">Copy the key now — it is shown <b>only this once</b>:</p>
              <CopyField value={token} />
              <p className="text-xs text-neutral-500">
                The Docs tab has a console that takes this token, so you can prove it works before wiring it into
                anything.
              </p>
              <div className="flex justify-end">
                <Button onClick={() => setCreateOpen(false)}>Done</Button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {revokeId !== null && (
        <ConfirmDialog
          title="Revoke API key"
          message="Requests using this key start failing immediately."
          confirmLabel="Revoke"
          onConfirm={() => {
            setError(null);
            void api(`/api/api-keys/${revokeId}`, { method: 'DELETE' }).then(refresh).catch(setError);
          }}
          onClose={() => setRevokeId(null)}
        />
      )}
    </div>
  );
}
