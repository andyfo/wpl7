// @docs plugins/overview, plugins/updates, sites/wordpress
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WpComponentDto } from '../../../../shared/types';
import { fixVulnerableOps, updateAllOps, type WpUpdateOp } from '../../../../shared/wpOps';
import { api, ApiError } from '../../api/client';
import { useRunJob, useSite, useWpMaintenance, useWpStatus } from '../../api/hooks';
import {
  Button,
  Card,
  ConfirmDialog,
  CopyField,
  EmptyState,
  ErrorNote,
  inputClass,
  Spinner,
  StatTile,
  Toggle,
} from '../ui';
import { JobProgress } from '../JobProgress';
import { SiteRecipesCard } from './SiteRecipesCard';
import { WporgPluginSearch } from '../WporgPluginSearch';
import { timeAgo } from '../../lib/format';
import { tokenizeCli } from '../../lib/cliArgs';
import { ComponentTable } from './ComponentTable';
import { BulkRunOptions, type BulkRunOptionsValue } from './BulkRunOptions';
import { FeedFooter } from './FeedFooter';
import { CoverageNote, SeverityBadge } from './severity';
import { VulnerabilityList } from './VulnerabilityList';

/** A failed action, reported inside the card whose button ran it. */
function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="mt-3 space-y-2">
      <ErrorNote error={error} />
      {error instanceof ApiError && error.details ? (
        <pre className="rounded-lg bg-neutral-100 p-2 text-xs">{JSON.stringify(error.details, null, 2)}</pre>
      ) : null}
    </div>
  );
}

export function WordPressTab({ slug }: { slug: string }) {
  const site = useSite(slug);
  // A site hosted elsewhere is worked on through WPL7 Connect while it is connected.
  const external = site.data?.kind === 'external';
  const running = external ? site.data?.status === 'connected' : site.data?.containerState === 'running';
  const isLive = site.data?.isLive ?? false;
  const status = useWpStatus(slug);
  // Every WordPress job ends by re-reading the snapshot, so the status query is what has
  // to be invalidated when one finishes - not a plugin list that no longer exists.
  const run = useRunJob([['wp-status', slug]]);
  const qc = useQueryClient();
  const maintenanceQuery = useWpMaintenance(slug, !!running && !external);
  const [resetUser, setResetUser] = useState('');
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testEmailResult, setTestEmailResult] = useState<string | null>(null);
  const [cliArgs, setCliArgs] = useState('');
  const [cliResult, setCliResult] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null);
  const [cliOpen, setCliOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Keyed by action so the failure is reported in the card that caused it. A single
  // page-level note (like the page-level spinner this replaced) makes the user hunt for
  // feedback that belongs next to the control they just used.
  const [failure, setFailure] = useState<{ action: string; error: unknown } | null>(null);
  /** The value the maintenance switch is being moved to, while the PUT is in flight. */
  const [maintenanceTo, setMaintenanceTo] = useState<boolean | null>(null);
  // Live sites get a backup by default and dev copies do not: on a dev site the whole point
  // is to find out whether the update breaks anything.
  const [runOptions, setRunOptions] = useState<BulkRunOptionsValue>({ backupFirst: isLive, healthCheck: true });
  const [pending, setPending] = useState<{ title: string; message: string; ops: WpUpdateOp[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WpComponentDto | null>(null);

  const sync = async (action: string, fn: () => Promise<void>) => {
    setBusy(action);
    setFailure((prev) => (prev?.action === action ? null : prev));
    try {
      await fn();
    } catch (err) {
      setFailure({ action, error: err });
    } finally {
      setBusy(null);
    }
  };

  /** The last failure, but only where it happened. */
  const errorOf = (action: string) => (failure?.action === action ? failure.error : null);

  const cliRunnable = cliArgs.trim().length > 0 && busy !== 'cli';
  const runCli = () =>
    sync('cli', async () => {
      const res = await api<{ stdout: string; stderr: string; exitCode: number }>(`/api/sites/${slug}/wp/cli`, {
        method: 'POST',
        body: { args: tokenizeCli(cliArgs) },
      });
      setCliResult(res);
    });

  const checkNow = () =>
    sync('scan', async () => {
      await api(`/api/sites/${slug}/wp/scan`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['wp-status', slug] });
      await qc.invalidateQueries({ queryKey: ['sites'] });
    });

  const runOps = (ops: WpUpdateOp[]) =>
    run.mutate({
      path: `/api/sites/${slug}/wp/bulk`,
      body: { ops, backupFirst: runOptions.backupFirst, healthCheck: runOptions.healthCheck },
    });

  const data = status.data;
  const neverScanned = !!data && data.scannedAt === null;
  const vulnerable = data
    ? [...data.plugins, ...data.themes].filter((c) => c.vulnerabilities.length > 0 || c.closedOnWporg)
    : [];
  const coreVulnerable = (data?.core.vulnerabilities.length ?? 0) > 0;
  const allOps = data ? updateAllOps(data) : [];
  const fixOps = data ? fixVulnerableOps(data) : [];

  if (status.isLoading && !data) return <Spinner />;
  if (!data) {
    // Without this the page renders zeroes and "everything is up to date" for a snapshot it
    // could not read at all - the one thing a security view must never do.
    return (
      <Card title="Updates">
        <ErrorNote error={status.error} />
        <p className="mt-2 text-sm text-neutral-600">
          The panel could not read this site's WordPress inventory.
        </p>
        <div className="mt-3">
          <Button small variant="secondary" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* --------------------------------------------------------- updates */}
      <Card
        title="Updates"
        action={
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span>
              {data?.scannedAt ? `checked ${timeAgo(data.scannedAt)}` : 'never checked'}
              {data?.partial && ' · partial scan'}
            </span>
            <Button small variant="ghost" disabled={!running || busy === 'scan'} onClick={() => void checkNow()}>
              {busy === 'scan' ? 'Checking…' : 'Check now'}
            </Button>
          </div>
        }
      >
        {!running && (
          <p className="mb-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
            {external ? 'The site is disconnected' : 'The site container is not running'} — these numbers are from the last scan.
          </p>
        )}
        {neverScanned ? (
          <EmptyState>
            Not scanned yet.{' '}
            {running ? 'Use “Check now”' : external ? 'Reconnect the site, then use “Check now”' : 'Start the site, then use “Check now”'}.
          </EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatTile
                label="WordPress core"
                value={data?.core.version ?? '–'}
                sub={
                  data?.core.updateVersion ? (
                    <span className="text-amber-600">
                      → {data.core.updateVersion}
                      {data.core.updateType ? ` (${data.core.updateType})` : ''}
                    </span>
                  ) : (
                    'up to date'
                  )
                }
              />
              <StatTile
                label="Plugins"
                value={data?.plugins.length ?? 0}
                sub={`${data?.plugins.filter((p) => p.actionable.update).length ?? 0} with updates · ${
                  data?.plugins.filter((p) => p.vulnerabilities.length > 0 || p.closedOnWporg).length ?? 0
                } vulnerable`}
              />
              <StatTile
                label="Themes"
                value={data?.themes.length ?? 0}
                sub={`${data?.themes.filter((t) => t.actionable.update).length ?? 0} with updates · ${
                  data?.themes.filter((t) => t.vulnerabilities.length > 0 || t.closedOnWporg).length ?? 0
                } vulnerable`}
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                disabled={!running || allOps.length === 0}
                onClick={() =>
                  setPending({
                    title: 'Update everything on this site',
                    message: `${allOps.length} update${allOps.length === 1 ? '' : 's'} will run in one job, in order, ${external ? 'through WPL7 Connect' : "inside this site's container"}.`,
                    ops: allOps,
                  })
                }
              >
                {allOps.length > 0 ? `Update all (${allOps.length})` : 'Everything is up to date'}
              </Button>
              {data?.core.updateVersion && (
                <Button
                  variant="secondary"
                  disabled={!running}
                  onClick={() =>
                    setPending({
                      title: `Update WordPress to ${data.core.updateVersion}`,
                      message: 'Core files are updated and the database upgrade runs straight afterwards.',
                      ops: [{ kind: 'core', action: 'update' }],
                    })
                  }
                >
                  Update core
                </Button>
              )}
            </div>
          </>
        )}
        {data?.scanError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            Last scan failed: {data.scanError}
          </p>
        )}
        <ActionError error={errorOf('scan')} />
        <div className="mt-3">
          <ErrorNote error={run.error} />
          <JobProgress job={run.job} logs={run.logs} />
        </div>
      </Card>

      {/* -------------------------------------------------------- security */}
      {data && (vulnerable.length > 0 || coreVulnerable) && (
        <Card
          title={`Security (${vulnerable.length + (coreVulnerable ? 1 : 0)})`}
          action={
            fixOps.length > 0 && (
              <Button
                small
                disabled={!running}
                onClick={() =>
                  setPending({
                    title: 'Update everything with a known fix',
                    message: `${fixOps.length} component${fixOps.length === 1 ? '' : 's'} with a known vulnerability will be updated to a release that fixes it.`,
                    ops: fixOps,
                  })
                }
              >
                Fix vulnerable ({fixOps.length})
              </Button>
            )
          }
        >
          <div className="space-y-4">
            {coreVulnerable && (
              <div>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">WordPress {data.core.version}</span>
                  {data.core.worstSeverity && <SeverityBadge severity={data.core.worstSeverity} />}
                  {data.core.updateVersion && (
                    <span className="text-xs text-amber-600">update to {data.core.updateVersion}</span>
                  )}
                </div>
                <div className="mt-1.5">
                  <VulnerabilityList items={data.core.vulnerabilities} />
                </div>
              </div>
            )}
            {vulnerable.map((item) => (
              <div key={`${item.kind}:${item.slug}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{item.title}</span>
                  <span className="text-xs text-neutral-400">
                    {item.kind} · {item.version}
                  </span>
                  {item.worstSeverity && <SeverityBadge severity={item.worstSeverity} />}
                  <CoverageNote coverage={item.feedCoverage} />
                  {/* An update that does not reach the fixed release is still offered - it
                      is an improvement - but it is not sold as a fix. */}
                  {item.actionable.update && !item.updateFixes && (
                    <span className="text-xs text-neutral-500">
                      {item.updateVersion} does not clear this yet
                    </span>
                  )}
                  <span className="ml-auto flex gap-1.5">
                    {item.actionable.update && (
                      <Button
                        small
                        variant="secondary"
                        disabled={!running}
                        onClick={() =>
                          runOps([{ kind: item.kind, slug: item.slug, action: 'update' }])
                        }
                      >
                        Update to {item.updateVersion}
                      </Button>
                    )}
                    {item.actionable.deactivate && (
                      <Button
                        small
                        variant="ghost"
                        disabled={!running}
                        onClick={() =>
                          run.mutate({ path: `/api/sites/${slug}/wp/plugins/${item.slug}/deactivate` })
                        }
                      >
                        Deactivate
                      </Button>
                    )}
                  </span>
                </div>
                {item.closedOnWporg && (
                  <p className="mt-1 text-xs text-red-700">
                    Closed on wordpress.org
                    {item.closedReason ? ` (${item.closedReason.replace(/-/g, ' ')})` : ''} — replace it.
                  </p>
                )}
                <div className="mt-1.5">
                  <VulnerabilityList items={item.vulnerabilities} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <FeedFooter enabled={data.feed.enabled} refreshedAt={data.feed.refreshedAt} />
          </div>
        </Card>
      )}

      {/* --------------------------------------------------------- plugins */}
      <Card title={`Plugins${data ? ` (${data.plugins.length})` : ''}`}>
        <div className="mb-3">
          <WporgPluginSearch
            placeholder="Search wordpress.org to install a plugin…"
            addedSlugs={(data?.plugins ?? []).map((p) => p.slug)}
            addedLabel="installed"
            onSelect={(p) =>
              run.mutate({
                path: `/api/sites/${slug}/wp/plugins`,
                body: { source: { kind: 'wporg', slug: p.slug } },
              })
            }
          />
        </div>
        <ComponentTable
          items={data?.plugins ?? []}
          busy={!running}
          empty={neverScanned ? 'Not scanned yet.' : 'No plugins installed.'}
          onUpdate={(item) => runOps([{ kind: 'plugin', slug: item.slug, action: 'update' }])}
          onActivate={(item) => run.mutate({ path: `/api/sites/${slug}/wp/plugins/${item.slug}/activate` })}
          onDeactivate={(item) => run.mutate({ path: `/api/sites/${slug}/wp/plugins/${item.slug}/deactivate` })}
          onDelete={(item) => setConfirmDelete(item)}
        />
      </Card>

      {/* ---------------------------------------------------------- themes */}
      <Card title={`Themes${data ? ` (${data.themes.length})` : ''}`}>
        <ComponentTable
          items={data?.themes ?? []}
          busy={!running}
          empty={neverScanned ? 'Not scanned yet.' : 'No themes installed.'}
          onUpdate={(item) => runOps([{ kind: 'theme', slug: item.slug, action: 'update' }])}
          onActivate={(item) => run.mutate({ path: `/api/sites/${slug}/wp/themes/${item.slug}/activate` })}
          onDeactivate={() => undefined}
          onDelete={(item) => setConfirmDelete(item)}
        />
      </Card>

      {!external && <SiteRecipesCard slug={slug} />}

      {/* ------------------------------------------------------ site tools */}
      {!external && (
        <Card title="Maintenance mode">
          <Toggle
            // While the PUT is in flight the switch shows where it is going, not where it was:
            // the query still holds the old answer until the refetch lands, and snapping back
            // for that second reads as a click that did not register.
            checked={maintenanceTo ?? maintenanceQuery.data ?? false}
            disabled={!running || maintenanceQuery.isLoading}
            busy={busy === 'maintenance'}
            onChange={(v) =>
              void sync('maintenance', async () => {
                setMaintenanceTo(v);
                try {
                  await api(`/api/sites/${slug}/wp/maintenance`, { method: 'PUT', body: { enabled: v } });
                  await qc.invalidateQueries({ queryKey: ['wp-maintenance', slug] });
                } finally {
                  setMaintenanceTo(null);
                }
              })
            }
            label={`Show the maintenance page to visitors${maintenanceQuery.isLoading ? ' (checking…)' : ''}`}
          />
          <p className="mt-2 text-xs text-neutral-500">
            {running
              ? 'WordPress stops honouring the marker ten minutes after it is set.'
              : 'The site container is not running, so the marker cannot be set.'}
          </p>
          <ActionError error={errorOf('maintenance')} />
        </Card>
      )}

      {!external && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Reset a user's password">
            <div className="flex gap-2">
              <input
                className={`${inputClass} max-w-sm`}
                placeholder="username or email"
                value={resetUser}
                onChange={(e) => setResetUser(e.target.value)}
              />
              <Button
                small
                disabled={!resetUser.trim() || busy === 'reset' || !running}
                onClick={() =>
                  void sync('reset', async () => {
                    const res = await api<{ newPassword: string }>(`/api/sites/${slug}/wp/users/reset-password`, {
                      method: 'POST',
                      body: { user: resetUser.trim() },
                    });
                    setResetResult(res.newPassword);
                  })
                }
              >
                {busy === 'reset' ? 'Resetting…' : 'Reset'}
              </Button>
            </div>
            {resetResult && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-neutral-600">New password (shown once):</p>
                <CopyField value={resetResult} />
              </div>
            )}
            <ActionError error={errorOf('reset')} />
          </Card>

          <Card title="Send test email">
            <div className="flex gap-2">
              <input
                className={`${inputClass} max-w-sm`}
                placeholder="you@example.com"
                value={testEmailTo}
                onChange={(e) => setTestEmailTo(e.target.value)}
              />
              <Button
                small
                disabled={!testEmailTo.trim() || busy === 'email' || !running}
                onClick={() =>
                  void sync('email', async () => {
                    const res = await api<{ accepted: boolean; detail: string }>(`/api/sites/${slug}/wp/test-email`, {
                      method: 'POST',
                      body: { to: testEmailTo.trim() },
                    });
                    setTestEmailResult(res.detail);
                  })
                }
              >
                {busy === 'email' ? 'Sending…' : 'Send'}
              </Button>
            </div>
            {testEmailResult && <p className="mt-2 text-xs text-neutral-600">{testEmailResult}</p>}
            <ActionError error={errorOf('email')} />
          </Card>
        </div>
      )}

      <Card
        title="WP-CLI console (advanced)"
        action={
          <Button small variant="ghost" onClick={() => setCliOpen(!cliOpen)}>
            {cliOpen ? 'hide' : 'show'}
          </Button>
        }
      >
        {cliOpen && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <span className="flex items-center font-mono text-sm text-neutral-400">wp</span>
              <input
                className={`${inputClass} max-w-xl`}
                placeholder="option get siteurl"
                value={cliArgs}
                onChange={(e) => setCliArgs(e.target.value)}
                // Calls the handler directly rather than synthesising a click on a node
                // inside the button: that click reached onClick even while the button was
                // disabled, so Enter during a run started the command a second time.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && cliRunnable) void runCli();
                }}
              />
              <Button small disabled={!cliRunnable || !running} onClick={() => void runCli()}>
                {busy === 'cli' ? 'Running…' : 'Run'}
              </Button>
            </div>
            {cliResult && (
              <pre className="max-h-64 overflow-auto rounded-lg bg-neutral-950 p-3 text-xs text-[#e4e4e7]">
                {cliResult.stdout}
                {cliResult.stderr && <span className="text-red-400">{cliResult.stderr}</span>}
                {`\n(exit ${cliResult.exitCode})`}
              </pre>
            )}
            <ActionError error={errorOf('cli')} />
            <p className="text-xs text-neutral-400">
              {external
                ? `Runs only commands a plugin registered with WPL7 Connect${
                    site.data?.external?.commands.length ? `: ${site.data.external.commands.join(', ')}` : '. None here does.'
                  }`
                : 'Runs inside the site container as www-data, with a 55s limit. Quoted arguments are supported.'}
            </p>
          </div>
        )}
      </Card>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirmLabel="Run it"
          onClose={() => setPending(null)}
          onConfirm={() => runOps(pending.ops)}
        >
          <BulkRunOptions
            value={runOptions}
            onChange={setRunOptions}
            backupHint={
              isLive
                ? 'On by default for a live site. Kept until you delete it.'
                : 'Database and files, kept until you delete it.'
            }
          />
        </ConfirmDialog>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.kind} “${confirmDelete.title}”`}
          message={
            <>
              The files are removed from the site.{' '}
              {confirmDelete.kind === 'plugin'
                ? 'An active plugin is deactivated first. Its database tables and options stay behind.'
                : 'Its settings and customizer data stay in the database.'}
            </>
          }
          confirmWord="delete"
          confirmLabel={`Delete ${confirmDelete.slug}`}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() =>
            run.mutate({
              path: `/api/sites/${slug}/wp/${confirmDelete.kind === 'plugin' ? 'plugins' : 'themes'}/${confirmDelete.slug}`,
              method: 'DELETE',
            })
          }
        />
      )}
    </div>
  );
}
