import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BackupCopyDto, BackupDestinationDto, ServerCheck } from '../../../shared/types';
import {
  BACKUP_PROVIDERS,
  providerByKey,
  type ProviderField,
  type ProviderPreset,
} from '../../../shared/backupProviders';
import { offsiteCopyTypes } from '../../../shared/schemas';
import { api } from '../api/client';
import { useBackupDestinations, useMeta, useOffsiteOverview, useServers } from '../api/hooks';
import { StorageModal } from '../components/StorageModal';
import {
  Button,
  Card,
  ChecksList,
  ConfirmDialog,
  CopyField,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  Modal,
  Spinner,
  StatusBadge,
  Toggle,
} from '../components/ui';
import { formatBytes, formatDate, timeAgo } from '../lib/format';

const GROUP_LABELS: Record<ProviderPreset['group'], string> = {
  object: 'Object storage',
  servers: 'Servers',
  advanced: 'Advanced',
};

/**
 * Where backups go: each server's own disk, and the remote destinations they are copied to.
 * The backups themselves are listed on the Backups page (Backups.tsx).
 */
export function BackupStorage() {
  const meta = useMeta();
  const servers = useServers();
  const destinations = useBackupDestinations();
  const overview = useOffsiteOverview();
  const qc = useQueryClient();
  const [storageFor, setStorageFor] = useState<{ id: number; name: string } | null>(null);
  const [editing, setEditing] = useState<BackupDestinationDto | 'new' | null>(null);
  const [removing, setRemoving] = useState<BackupDestinationDto | null>(null);
  const [passphraseFor, setPassphraseFor] = useState<BackupDestinationDto | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['backup-destinations'] });
    void qc.invalidateQueries({ queryKey: ['offsite-overview'] });
    void qc.invalidateQueries({ queryKey: ['meta'] });
  };

  const roots = meta.data?.backupRoots ?? [];
  const items = destinations.data ?? [];
  const multiServer = meta.data?.multiServer ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Storage</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Where backups are kept: on the disk of each server, and copied to remote destinations.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>Add remote destination</Button>
      </div>
      <ErrorNote error={error} />

      <Card title="Where backups are stored">
        <p className="mb-3 text-xs text-neutral-500">
          Written to the disk of the server that hosts the site. Schedule and retention live in{' '}
          <Link className="underline" to="/settings">Settings</Link>.
        </p>
        <table className="w-full text-sm">
          <tbody>
            {roots.map((row) => {
              const server = (servers.data ?? []).find((s) => s.id === row.serverId);
              return (
                <tr key={row.serverId} className="border-t border-neutral-100 first:border-0">
                  <td className="py-2.5 pr-3 font-medium">{row.serverName}</td>
                  <td className="py-2.5 pr-3">
                    <code className="text-xs">{row.root}</code>
                    {row.isDefault && <span className="ml-2 text-[11px] text-neutral-400">default</span>}
                  </td>
                  <td className="py-2.5 pr-3 text-right text-xs text-neutral-500">
                    <Link className="hover:underline" to={multiServer ? `/backups?serverId=${row.serverId}` : '/backups'}>
                      {row.backups} backup(s)
                    </Link>
                  </td>
                  <td className="py-2.5 text-right">
                    <Button
                      small
                      variant="secondary"
                      disabled={server?.status === 'unreachable'}
                      onClick={() => setStorageFor({ id: row.serverId, name: row.serverName })}
                    >
                      Storage
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Remote destinations">
        {items.length === 0 ? (
          <EmptyState>No remote copies yet.</EmptyState>
        ) : (
          <div className="space-y-3">
            {items.map((dest) => (
              <DestinationCard
                key={dest.id}
                dest={dest}
                onEdit={() => setEditing(dest)}
                onRemove={() => setRemoving(dest)}
                onPassphrase={() => setPassphraseFor(dest)}
                onChanged={refresh}
                onError={setError}
              />
            ))}
          </div>
        )}
      </Card>

      {(overview.data?.failures.length ?? 0) > 0 && (
        <Card title="Recent failures">
          <FailuresTable failures={overview.data!.failures} onChanged={refresh} onError={setError} />
        </Card>
      )}

      {storageFor && (
        <StorageModal serverId={storageFor.id} serverName={storageFor.name} onClose={() => setStorageFor(null)} />
      )}
      {editing && (
        <DestinationModal
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}
      {passphraseFor && (
        <PassphraseDialog dest={passphraseFor} onClose={() => setPassphraseFor(null)} onError={setError} />
      )}
      {removing && (
        <RemoveDestinationDialog
          dest={removing}
          onClose={() => setRemoving(null)}
          onDone={refresh}
          onError={setError}
        />
      )}
    </div>
  );
}

function DestinationCard({
  dest,
  onEdit,
  onRemove,
  onPassphrase,
  onChanged,
  onError,
}: {
  dest: BackupDestinationDto;
  onEdit: () => void;
  onRemove: () => void;
  onPassphrase: () => void;
  onChanged: () => void;
  onError: (err: unknown) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [checks, setChecks] = useState<ServerCheck[] | null>(null);

  const dot = !dest.enabled
    ? 'bg-neutral-300'
    : dest.stats.failed > 0
      ? 'bg-red-500'
      : dest.stats.pending > 0
        ? 'bg-amber-400'
        : 'bg-emerald-500';

  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
            <span className="font-medium">{dest.name}</span>
            <span className="text-xs text-neutral-500">{dest.providerLabel}</span>
            {dest.encryption === 'crypt' && (
              <span
                className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800"
                title="Contents and file names are encrypted before upload"
              >
                encrypted
              </span>
            )}
            {!dest.enabled && <StatusBadge status="stopped" />}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {dest.stats.complete} copied · {formatBytes(dest.stats.bytes)}
            {dest.stats.pending > 0 && ` · ${dest.stats.pending} waiting`}
            {dest.stats.failed > 0 && ` · ${dest.stats.failed} failed`}
            {dest.lastSuccessAt && ` · last success ${timeAgo(dest.lastSuccessAt)}`}
          </div>
          <div className="measure mt-0.5 text-xs text-neutral-400">
            Copies {dest.copyTypes.join(', ')} ·{' '}
            {dest.retentionMode === 'external'
              ? 'retention managed by the provider'
              : dest.retentionScheduled === 0
                ? 'keeps every scheduled backup'
                : `keeps the last ${dest.retentionScheduled} scheduled per site`}
            {dest.bwlimit && ` · limited to ${dest.bwlimit}`}
          </div>
          {dest.lastError && dest.stats.failed > 0 && (
            <div className="mt-1 max-w-2xl text-xs text-red-700">{dest.lastError}</div>
          )}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button
            small
            variant="secondary"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setChecks(null);
              void api<{ checks: ServerCheck[] }>(`/api/backup-destinations/${dest.id}/test`, { method: 'POST' })
                .then((r) => setChecks(r.checks))
                .catch(onError)
                .finally(() => setTesting(false));
            }}
          >
            {testing ? <Spinner /> : 'Test'}
          </Button>
          <Button
            small
            variant="secondary"
            onClick={() => {
              void api(`/api/backup-destinations/${dest.id}`, { method: 'PATCH', body: { enabled: !dest.enabled } })
                .then(onChanged)
                .catch(onError);
            }}
          >
            {dest.enabled ? 'Pause' : 'Resume'}
          </Button>
          {dest.encryption === 'crypt' && (
            <Button small variant="secondary" onClick={onPassphrase}>
              Passphrase
            </Button>
          )}
          <Button small variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          <Button small variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      {checks && (
        <div className="mt-3 border-t border-neutral-100 pt-3">
          <ChecksList checks={checks} />
        </div>
      )}
    </div>
  );
}

/**
 * The passphrase, presented the one way that matches what it is: the single thing standing
 * between a bucket of ciphertext and a recoverable backup. Shown when it is first minted
 * and on demand afterwards — there is no second copy anywhere but the panel's database,
 * which is exactly what this is insurance against losing.
 */
function PassphraseBlock({ crypt, intro }: { crypt: { password: string; salt: string }; intro: ReactNode }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-neutral-700">{intro}</p>
      <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
        <b>Copy both lines into a password manager.</b> They exist nowhere but this panel&apos;s database.
        Without them these backups cannot be read.
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">Passphrase</div>
        <CopyField value={crypt.password} />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">Salt</div>
        <CopyField value={crypt.salt} />
      </div>
      <p className="text-xs text-neutral-500">
        Both halves are needed. They are rclone&apos;s <code>password</code> and <code>password2</code>.
      </p>
    </div>
  );
}

/** Read the passphrase back out later, for a destination that already has one. */
function PassphraseDialog({
  dest,
  onClose,
  onError,
}: {
  dest: BackupDestinationDto;
  onClose: () => void;
  onError: (err: unknown) => void;
}) {
  const [crypt, setCrypt] = useState<{ password: string; salt: string } | null>(null);
  useEffect(() => {
    void api<{ password: string; salt: string }>(`/api/backup-destinations/${dest.id}/passphrase`, {
      method: 'POST',
    })
      .then(setCrypt)
      .catch((err: unknown) => {
        onError(err);
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dest.id]);

  return (
    <Modal title={`Passphrase for "${dest.name}"`} onClose={onClose}>
      {crypt ? (
        <PassphraseBlock
          crypt={crypt}
          intro={<>Decrypts the backups stored at this destination.</>}
        />
      ) : (
        <div className="py-6 text-center">
          <Spinner />
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function FailuresTable({
  failures,
  onChanged,
  onError,
}: {
  failures: BackupCopyDto[];
  onChanged: () => void;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
          <th className="pb-2">Backup</th>
          <th className="pb-2">Destination</th>
          <th className="pb-2">Error</th>
          <th className="pb-2 text-right">Attempts</th>
          <th className="pb-2" />
        </tr>
      </thead>
      <tbody>
        {failures.map((copy) => (
          <tr key={copy.id} className="border-t border-neutral-100 align-top">
            <td className="py-2 pr-3">
              {copy.siteSlug ? (
                // To the backup list rather than the site: the site may be deleted, or be the panel.
                <Link className="font-medium hover:underline" to={`/backups?siteSlug=${encodeURIComponent(copy.siteSlug)}`}>
                  {copy.backupType === 'panel' ? 'Panel database' : copy.siteSlug}
                </Link>
              ) : (
                <span className="font-medium">#{copy.backupId}</span>
              )}
              <div className="text-xs text-neutral-500">
                {copy.backupType} · {copy.backupCreatedAt ? timeAgo(copy.backupCreatedAt) : ''}
              </div>
            </td>
            <td className="py-2 pr-3 text-neutral-600">{copy.destinationName}</td>
            <td className="py-2 pr-3 text-xs text-red-700">
              {copy.error}
              <div className="text-neutral-400">
                {copy.nextAttemptAt
                  ? `next attempt ${formatDate(copy.nextAttemptAt)}`
                  : 'gave up — retry it by hand'}
              </div>
            </td>
            <td className="py-2 pr-3 text-right text-neutral-500">{copy.attempts}</td>
            <td className="py-2 text-right">
              <Button
                small
                variant="secondary"
                disabled={busy === copy.id}
                onClick={() => {
                  setBusy(copy.id);
                  void api(`/api/backups/${copy.backupId}/offsite`, {
                    method: 'POST',
                    body: { destinationId: copy.destinationId },
                  })
                    .then(onChanged)
                    .catch(onError)
                    .finally(() => setBusy(null));
                }}
              >
                {busy === copy.id ? <Spinner /> : 'Retry'}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RemoveDestinationDialog({
  dest,
  onClose,
  onDone,
  onError,
}: {
  dest: BackupDestinationDto;
  onClose: () => void;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const [deleteRemote, setDeleteRemote] = useState(false);
  return (
    <ConfirmDialog
      title={`Remove "${dest.name}"`}
      confirmWord={deleteRemote ? dest.name : undefined}
      confirmLabel="Remove"
      message={
        deleteRemote ? (
          <>
            Deletes the {dest.stats.complete} copy/copies this panel wrote to <b>{dest.name}</b>, then removes
            the destination. Nothing else in the bucket is touched. <b>This cannot be undone.</b>
          </>
        ) : (
          <>
            The {dest.stats.complete} copy/copies already there are <b>left in place</b>; the panel stops
            tracking them.
            {dest.encryption === 'crypt' && (
              <> The passphrase goes with it — save it first if you want to read them later.</>
            )}
          </>
        )
      }
      onConfirm={() => {
        void api(`/api/backup-destinations/${dest.id}?deleteRemote=${deleteRemote}`, { method: 'DELETE' })
          .then(onDone)
          .catch(onError);
      }}
      onClose={onClose}
    >
      <Toggle
        checked={deleteRemote}
        onChange={setDeleteRemote}
        label="Also delete the copies stored there"
      />
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Add / edit

type Values = Record<string, string>;

/**
 * Catalog-driven: the fields, their widgets, which of them are secret and which vendors
 * prefill what all come from `shared/backupProviders.ts`, so a new provider shows up here
 * without this file learning anything about it.
 */
function DestinationModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: BackupDestinationDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const meta = useMeta();
  const [provider, setProvider] = useState(existing?.provider ?? 's3-compatible');
  const preset = providerByKey(provider)!;
  const [name, setName] = useState(existing?.name ?? '');
  const [config, setConfig] = useState<Values>(() => initialConfig(preset, existing, meta.data?.panelDomain));
  const [secrets, setSecrets] = useState<Values>({});
  const [replacing, setReplacing] = useState<Set<string>>(new Set());
  const [copyTypes, setCopyTypes] = useState<string[]>(
    existing?.copyTypes ?? ['scheduled', 'manual', 'final', 'panel'],
  );
  const [retentionScheduled, setRetentionScheduled] = useState(existing?.retentionScheduled ?? 30);
  const [retentionMode, setRetentionMode] = useState(existing?.retentionMode ?? 'panel');
  const [bwlimit, setBwlimit] = useState(existing?.bwlimit ?? '');
  const [backfill, setBackfill] = useState<'none' | 'latest' | 'all'>('none');
  const [encrypt, setEncrypt] = useState((existing?.encryption ?? 'none') === 'crypt');
  const [adopt, setAdopt] = useState<{ password: string; salt: string } | null>(null);
  const [checks, setChecks] = useState<ServerCheck[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Set once after saving, when a passphrase has just been minted and nobody has it yet. */
  const [minted, setMinted] = useState<{ password: string; salt: string } | null>(null);

  // A destination that already holds copies cannot change its encryption: the objects are
  // named and written one way or the other, with no path back.
  const encryptionLocked = !!existing && existing.stats.complete + existing.stats.pending > 0;

  const body = () => ({
    name,
    provider,
    config,
    secrets,
    copyTypes,
    retentionScheduled,
    retentionMode,
    bwlimit,
    encryption: encrypt ? 'crypt' : 'none',
    ...(encrypt && adopt?.password && adopt?.salt ? { cryptPassword: adopt.password, cryptSalt: adopt.salt } : {}),
    ...(existing ? {} : { backfill }),
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await api<BackupDestinationDto & { crypt?: { password: string; salt: string } }>(
            `/api/backup-destinations/${existing.id}`,
            { method: 'PATCH', body: body() },
          )
        : await api<BackupDestinationDto & { crypt?: { password: string; salt: string } }>(
            '/api/backup-destinations',
            { method: 'POST', body: body() },
          );
      // Stay open on the passphrase rather than closing over it: it exists in exactly one
      // other place, and that place is the database this is meant to survive the loss of.
      if (saved.crypt && !adopt) {
        setMinted(saved.crypt);
        return;
      }
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: string, value: string, field: ProviderField) => {
    if (field.secret) {
      setSecrets((s) => ({ ...s, [key]: value }));
      return;
    }
    setConfig((c) => {
      const next = { ...c, [key]: value };
      // A vendor pick fills in the endpoint pattern and region for that vendor.
      const option = field.options?.find((o) => o.value === value);
      if (option?.preset) for (const [k, v] of Object.entries(option.preset)) next[k] = v;
      return next;
    });
  };

  if (minted) {
    return (
      // Only the button closes it: Escape or a stray click must not throw away the one copy.
      <Modal title="Save this passphrase now" onClose={onSaved} dismissible={false}>
        <PassphraseBlock
          crypt={minted}
          intro={
            <>
              Backups going to <b>{name}</b> are encrypted on your server before they are uploaded, with
              this passphrase.
            </>
          }
        />
        <div className="mt-4 flex justify-end">
          <Button onClick={onSaved}>I have saved it</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={existing ? `Edit "${existing.name}"` : 'Add remote destination'} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        <Field label="Provider" hint={existing ? 'Cannot be changed after saving.' : preset.blurb}>
          <select
            className={inputClass}
            value={provider}
            disabled={!!existing}
            onChange={(e) => {
              const next = providerByKey(e.target.value)!;
              setProvider(e.target.value);
              setConfig(initialConfig(next, null, meta.data?.panelDomain));
              setSecrets({});
              setChecks(null);
            }}
          >
            {(['object', 'servers', 'advanced'] as const).map((group) => (
              <optgroup key={group} label={GROUP_LABELS[group]}>
                {BACKUP_PROVIDERS.filter((p) => p.group === group).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        {preset.fields.map((field) => (
          <ProviderFieldInput
            key={field.key}
            field={field}
            value={field.secret ? (secrets[field.key] ?? '') : (config[field.key] ?? '')}
            stored={!!existing?.secretsSet.includes(field.key)}
            replacing={replacing.has(field.key)}
            onReplace={() => setReplacing((r) => new Set(r).add(field.key))}
            onChange={(v) => setField(field.key, v, field)}
          />
        ))}

        <div className="space-y-2 rounded-lg border border-neutral-200 p-3">
          <Toggle
            checked={encrypt}
            onChange={encryptionLocked ? () => undefined : setEncrypt}
            label="Encrypt these backups before uploading"
          />
          {encryptionLocked ? (
            <p className="text-xs text-neutral-500">
              {existing!.encryption === 'crypt' ? 'On' : 'Off'} and fixed — this destination already holds
              backups.
            </p>
          ) : encrypt ? (
            <>
              <p className="text-xs text-neutral-600">
                Contents and file names are encrypted on your server, so the provider only holds ciphertext.
                The passphrase is shown once.
              </p>
              <p className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                <b>Lose the passphrase and these backups are unreadable.</b> Save it in a password manager.
              </p>
              {!existing && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-neutral-600">
                    I already have a passphrase for this bucket
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p className="text-neutral-500">
                      Paste both halves to read backups already in this bucket.
                    </p>
                    <input
                      className={inputClass}
                      placeholder="Passphrase"
                      autoComplete="off"
                      value={adopt?.password ?? ''}
                      onChange={(e) => setAdopt((a) => ({ salt: a?.salt ?? '', password: e.target.value }))}
                    />
                    <input
                      className={inputClass}
                      placeholder="Salt"
                      autoComplete="off"
                      value={adopt?.salt ?? ''}
                      onChange={(e) => setAdopt((a) => ({ password: a?.password ?? '', salt: e.target.value }))}
                    />
                  </div>
                </details>
              )}
            </>
          ) : (
            <p className="text-xs text-neutral-500">
              The provider can read the backups. Cannot be changed once a backup is stored here.
            </p>
          )}
        </div>

        <details className="rounded-lg border border-neutral-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-neutral-700">What gets copied, and for how long</summary>
          <div className="mt-3 space-y-3">
            <div>
              <span className="mb-1 block text-sm font-medium text-neutral-700">Backup kinds</span>
              <div className="flex flex-wrap gap-3">
                {offsiteCopyTypes.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={copyTypes.includes(t)}
                      onChange={(e) =>
                        setCopyTypes((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))
                      }
                    />
                    {t}
                  </label>
                ))}
              </div>
              <span className="mt-1 block text-xs text-neutral-500">
                <code>panel</code> is the nightly copy of the panel&apos;s own database.{' '}
                <code>pre_restore</code>, <code>pre_update</code> and <code>move</code> are short-lived safety
                copies.
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Keep last N scheduled per site"
                hint="0 keeps every one. Independent of the local retention."
              >
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  disabled={retentionMode === 'external'}
                  value={retentionScheduled}
                  onChange={(e) => setRetentionScheduled(Number(e.target.value))}
                />
              </Field>
              <Field label="Bandwidth limit" hint='rclone syntax, e.g. "2M" or "08:00,1M 20:00,off".'>
                <input className={inputClass} value={bwlimit} onChange={(e) => setBwlimit(e.target.value)} />
              </Field>
            </div>
            <Toggle
              checked={retentionMode === 'external'}
              onChange={(v) => setRetentionMode(v ? 'external' : 'panel')}
              label="Retention is managed by the provider"
            />
            <p className="text-xs text-neutral-500">
              For buckets with lifecycle rules or Object Lock, or a key without delete permission.
            </p>
          </div>
        </details>

        {!existing && (
          <Field
            label="Existing backups"
            hint="Copying everything can be a lot of traffic."
          >
            <select className={inputClass} value={backfill} onChange={(e) => setBackfill(e.target.value as 'none')}>
              <option value="none">Only copy backups taken from now on</option>
              <option value="latest">Also copy the newest backup of each site</option>
              <option value="all">Copy every backup there is</option>
            </select>
          </Field>
        )}

        {checks && <ChecksList checks={checks} />}
        <ErrorNote error={error} />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setChecks(null);
              setError(null);
              void api<{ checks: ServerCheck[] }>('/api/backup-destinations/test', { method: 'POST', body: body() })
                .then((r) => setChecks(r.checks))
                .catch(setError)
                .finally(() => setTesting(false));
            }}
          >
            {testing ? <Spinner /> : 'Test connection'}
          </Button>
          <Button disabled={!name || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : existing ? 'Save' : 'Add destination'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProviderFieldInput({
  field,
  value,
  stored,
  replacing,
  onReplace,
  onChange,
}: {
  field: ProviderField;
  value: string;
  stored: boolean;
  replacing: boolean;
  onReplace: () => void;
  onChange: (value: string) => void;
}) {
  const warn = field.warnWhen && value === field.warnWhen.value ? field.warnWhen.message : null;

  // A stored secret is never read back; it is either kept or explicitly replaced.
  if (field.secret && stored && !replacing) {
    return (
      <Field label={field.label} hint={field.hint}>
        <div className="flex items-center gap-2">
          <span className="flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500">
            •••••••• set
          </span>
          <Button small variant="secondary" onClick={onReplace}>
            Replace
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field label={field.label + (field.required ? '' : ' (optional)')} hint={field.hint}>
      {field.kind === 'select' ? (
        <select className={inputClass} value={value || field.default || ''} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'textarea' ? (
        <textarea
          className={`${inputClass} h-24 font-mono text-xs`}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={inputClass}
          type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
          value={value || (field.kind === 'number' ? (field.default ?? '') : '')}
          placeholder={field.placeholder}
          autoComplete={field.secret ? 'new-password' : 'off'}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {warn && <span className="mt-1 block text-xs text-red-700">{warn}</span>}
    </Field>
  );
}

function initialConfig(preset: ProviderPreset, existing: BackupDestinationDto | null, panelDomain?: string): Values {
  if (existing) return { ...existing.config };
  const out: Values = {};
  for (const field of preset.fields) {
    if (field.secret) continue;
    if (field.default) out[field.key] = field.default;
    // The vendor select's own default carries an endpoint template with it.
    const option = field.options?.find((o) => o.value === field.default);
    if (option?.preset) Object.assign(out, option.preset);
  }
  // A prefix per panel means two panels can share a bucket without colliding, and the
  // panel's own domain is the one name that is already unique and already known. It is
  // rename-proof too: nothing downstream derives anything from it.
  if (preset.fields.some((f) => f.key === 'prefix') && panelDomain) out.prefix = panelDomain;
  return out;
}
