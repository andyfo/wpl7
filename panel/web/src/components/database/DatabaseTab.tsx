// @docs sites/database
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SiteDatabaseDto, SiteDatabaseEntryDto } from '../../../../shared/types';
import { dbExportUrl, revealDbPassword, scanDatabases, useDbTables, useSiteDatabases } from '../../api/databases';
import { useRunJob, useSite } from '../../api/hooks';
import { formatBytes, timeAgo } from '../../lib/format';
import { Button, Card, ConfirmDialog, ErrorNote, Segmented, Spinner } from '../ui';
import { AddDatabaseDialog, ImportDialog } from './DatabaseDialogs';
import { TablesView } from './TablesView';

// The SQL editor carries CodeMirror: it loads the first time SQL is opened, not with the site page.
const SqlView = lazy(() => import('./SqlView'));

type Dialog = { kind: 'add' } | { kind: 'import'; db: string } | { kind: 'delete'; db: string } | { kind: 'password' };

/**
 * A site's databases: how its code connects, the databases it has, and a browser for them - tables,
 * rows and SQL - that works as the site's own database user, so it reaches nothing else.
 *
 * Where the browser is lives in the URL (`?tab=database&db=…&table=…&view=sql`), so a table can be
 * linked to - the Databases page does - and Back goes back to the one before.
 */
export function DatabaseTab({ slug }: { slug: string }) {
  const info = useSiteDatabases(slug);
  const site = useSite(slug);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const run = useRunJob([['site-databases', slug], ['databases'], ['db-tables', slug]]);

  if (info.isError && !info.data) return <ErrorNote error={info.error} />;
  if (!info.data) return <Spinner />;
  const d = info.data;
  const asked = params.get('db');
  const db = d.databases.some((x) => x.name === asked) ? asked! : d.name;
  const view = params.get('view') === 'sql' ? 'sql' : 'tables';

  const navigate = (next: Record<string, string | undefined>) =>
    setParams((p) => {
      const out = new URLSearchParams(p);
      out.set('tab', 'database');
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined || v === '') out.delete(k);
        else out.set(k, v);
      }
      return out;
    });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['site-databases', slug] });
    void qc.invalidateQueries({ queryKey: ['databases'] });
  };
  const status = site.data?.status;
  const unavailable = status === 'provisioning' || status === 'deleting' ? `The site is ${status}` : null;

  return (
    <div className="space-y-6">
      <ErrorNote error={run.error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <ConnectionCard slug={slug} info={d} onChangePassword={() => setDialog({ kind: 'password' })} busy={run.busy('password')} />
        <DatabasesCard
          slug={slug}
          info={d}
          active={db}
          unavailable={unavailable}
          deleting={(name) => run.busy(`delete:${name}`)}
          onBrowse={(name) => navigate({ db: name === d.name ? undefined : name, table: undefined, view: undefined, sql: undefined })}
          onAdd={() => setDialog({ kind: 'add' })}
          onImport={(name) => setDialog({ kind: 'import', db: name })}
          onDelete={(name) => setDialog({ kind: 'delete', db: name })}
          onRefreshed={refresh}
        />
      </div>

      <Card
        title={d.databases.length > 1 ? `Browse ${db}` : 'Browse'}
        action={
          <Segmented
            small
            label="View"
            options={[
              { id: 'tables', label: 'Tables' },
              { id: 'sql', label: 'SQL' },
            ]}
            value={view}
            onChange={(v) => navigate({ view: v === 'sql' ? 'sql' : undefined })}
          />
        }
      >
        {unavailable ? (
          <p className="text-sm text-neutral-500">{unavailable}; its databases open once it is done.</p>
        ) : view === 'sql' ? (
          <Suspense fallback={<Spinner />}>
            <SqlFor slug={slug} db={db} user={d.user} initial={params.get('sql')} />
          </Suspense>
        ) : (
          <TablesView
            key={db}
            slug={slug}
            db={db}
            table={params.get('table')}
            onTable={(table) => navigate({ table: table ?? undefined })}
            onOpenSql={(sql) => navigate({ view: 'sql', sql })}
          />
        )}
      </Card>

      {dialog?.kind === 'add' && <AddDatabaseDialog slug={slug} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'import' && <ImportDialog slug={slug} db={dialog.db} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${dialog.db}`}
          message={
            <>
              Deletes <b>{dialog.db}</b> and everything in it. Backups taken before keep a copy.
            </>
          }
          confirmWord={dialog.db}
          confirmLabel="Delete database"
          onConfirm={() => {
            run.mutate({ path: `/api/sites/${slug}/databases/${dialog.db}`, method: 'DELETE', action: `delete:${dialog.db}` });
            if (db === dialog.db) navigate({ db: undefined, table: undefined });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'password' && (
        <ConfirmDialog
          title="Change the database password"
          message="WordPress gets the new password and restarts: the site is offline for a few seconds."
          confirmLabel="Change password"
          onConfirm={() => run.mutate({ path: `/api/sites/${slug}/database-password`, action: 'password' })}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** The SQL view, with the table names for its completion. */
function SqlFor({ slug, db, user, initial }: { slug: string; db: string; user: string; initial: string | null }) {
  const tables = useDbTables(slug, db);
  return <SqlView key={db} slug={slug} db={db} user={user} tables={(tables.data ?? []).map((t) => t.name)} initial={initial} />;
}

function Fact({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 flex-1">
        <div className="break-all font-medium">{children}</div>
        {hint && <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>}
      </dd>
    </div>
  );
}

function ConnectionCard({
  slug,
  info,
  onChangePassword,
  busy,
}: {
  slug: string;
  info: SiteDatabaseDto;
  onChangePassword: () => void;
  busy: boolean;
}) {
  return (
    <Card
      title="Connection"
      action={
        <Button small variant="secondary" onClick={onChangePassword} busy={busy}>
          Change password
        </Button>
      }
    >
      <dl className="space-y-2 text-sm">
        <Fact label="Database">
          <code>{info.name}</code>
        </Fact>
        <Fact label="User">
          <code>{info.user}</code>
        </Fact>
        <Fact label="Password">
          <PasswordValue slug={slug} changing={busy} />
        </Fact>
        <Fact label="Host" hint="Only sites on this server can connect.">
          <code>
            {info.host}:{info.port}
          </code>
        </Fact>
        <Fact label="Table prefix">
          <code>{info.tablePrefix}</code>
        </Fact>
      </dl>
    </Card>
  );
}

/** The password, hidden until asked for: shown by a request of its own, which the panel logs. */
function PasswordValue({ slug, changing }: { slug: string; changing: boolean }) {
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // A new password is on its way: the one shown is about to stop working.
  useEffect(() => {
    if (changing) setPassword(null);
  }, [changing]);
  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      setPassword((await revealDbPassword(slug)).password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (password === null) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="tracking-widest text-neutral-400">••••••••••••</span>
        <Button small variant="ghost" onClick={() => void show()} busy={busy}>
          Show
        </Button>
        <ErrorNote error={error} />
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="break-all">{password}</code>
      <Button
        small
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(password);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </Button>
      <Button small variant="ghost" onClick={() => setPassword(null)}>
        Hide
      </Button>
    </span>
  );
}

function DatabasesCard({
  slug,
  info,
  active,
  unavailable,
  deleting,
  onBrowse,
  onAdd,
  onImport,
  onDelete,
  onRefreshed,
}: {
  slug: string;
  info: SiteDatabaseDto;
  active: string;
  unavailable: string | null;
  deleting: (name: string) => boolean;
  onBrowse: (name: string) => void;
  onAdd: () => void;
  onImport: (name: string) => void;
  onDelete: (name: string) => void;
  onRefreshed: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<unknown>(null);
  const rescan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      await scanDatabases();
      onRefreshed();
    } catch (err) {
      setScanError(err);
    } finally {
      setScanning(false);
    }
  };
  return (
    <Card
      title="Databases"
      action={
        <Button small onClick={onAdd} disabled={!!unavailable} title={unavailable ?? undefined}>
          Add database
        </Button>
      }
    >
      <table className="w-full text-sm">
        <tbody>
          {info.databases.map((d) => (
            <tr key={d.name} className="border-t border-neutral-100 first:border-t-0">
              <td className="py-2 pr-3">
                <button
                  type="button"
                  onClick={() => onBrowse(d.name)}
                  className={`font-mono text-left hover:underline ${d.name === active ? 'font-semibold' : ''}`}
                  title="Browse it"
                >
                  {d.name}
                </button>
                {d.kind === 'site' && <span className="ml-2 text-xs text-neutral-400">WordPress</span>}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-right text-neutral-500">
                <SizeText entry={d} />
              </td>
              <td className="whitespace-nowrap py-2 text-right">
                <a
                  className={`px-1.5 text-xs font-medium text-neutral-600 hover:underline ${unavailable ? 'pointer-events-none opacity-50' : ''}`}
                  href={dbExportUrl(slug, d.name)}
                  download
                  title={unavailable ?? 'Download a dump (.sql.gz)'}
                >
                  Export
                </a>
                <button
                  type="button"
                  className="px-1.5 text-xs font-medium text-neutral-600 hover:underline disabled:opacity-50"
                  disabled={!!unavailable}
                  title={unavailable ?? 'Load a dump into it'}
                  onClick={() => onImport(d.name)}
                >
                  Import
                </button>
                {d.kind === 'extra' && (
                  <button
                    type="button"
                    className="px-1.5 text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                    disabled={!!unavailable || deleting(d.name)}
                    title={unavailable ?? undefined}
                    onClick={() => onDelete(d.name)}
                  >
                    {deleting(d.name) ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {info.databases.length > 1 && (
        <p className="mt-3 text-xs text-neutral-500">
          Added databases use the same login, and are backed up, moved and deleted with the site.
        </p>
      )}
      <p className="mt-2 text-xs text-neutral-500">
        {info.scannedAt ? `Sizes from ${timeAgo(info.scannedAt)}` : 'Sizes not read yet'}
        {info.scanError && <span className="text-red-600"> · last read failed: {info.scanError}</span>} ·{' '}
        <button type="button" className="underline disabled:opacity-50" disabled={scanning} onClick={() => void rescan()}>
          {scanning ? 'Reading…' : 'Refresh'}
        </button>
      </p>
      <ErrorNote error={scanError} />
    </Card>
  );
}

function SizeText({ entry }: { entry: SiteDatabaseEntryDto }) {
  if (entry.missing) return <span className="text-red-600">Missing</span>;
  if (!entry.size) return <span>–</span>;
  return (
    <span className="tabular-nums">
      {formatBytes(entry.size.bytes)} · {entry.size.tables} {entry.size.tables === 1 ? 'table' : 'tables'}
    </span>
  );
}
