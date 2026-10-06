// @docs security/malware-scans, security/site-protection
import { useState } from 'react';
import { Link } from 'react-router';
import { FINDING_KIND_INFO, type FindingStatus } from '../../../../shared/security';
import type { FindingDto, QuarantineItemDto, ScanDto, SiteScanDto } from '../../../../shared/types';
import { useFindingAction, useFindings, useQuarantine, useQuarantineAction, useScanNow, useSiteScanHistory } from '../../api/security';
import { formatBytes, formatDate, formatDuration, timeAgo, timeUntil } from '../../lib/format';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNote, Segmented, Spinner } from '../ui';

const OUTCOME: Record<string, { label: string; tone: string }> = {
  running: { label: 'Scanning', tone: 'bg-sky-100 text-sky-800' },
  clean: { label: 'Nothing found', tone: 'bg-emerald-100 text-emerald-800' },
  findings: { label: 'Findings', tone: 'bg-red-100 text-red-800' },
  incomplete: { label: 'Incomplete', tone: 'bg-amber-100 text-amber-800' },
  failed: { label: 'Failed', tone: 'bg-red-100 text-red-800' },
  superseded: { label: 'Superseded', tone: 'bg-neutral-200 text-neutral-700' },
};

export function ScanOutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-xs text-neutral-400">never scanned</span>;
  const o = OUTCOME[outcome] ?? { label: outcome, tone: 'bg-neutral-200 text-neutral-700' };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${o.tone}`}>{o.label}</span>;
}

/** "3 plugins and 2 themes have", "1 plugin has": what a clean result still has not been held to. */
function uncheckedText(noChecksums: string[]): string | null {
  const plugins = noChecksums.filter((p) => p.startsWith('plugin:')).length;
  const themes = noChecksums.filter((p) => p.startsWith('theme:')).length;
  const core = noChecksums.includes('core');
  const parts = [
    core ? 'WordPress itself' : null,
    plugins ? `${plugins} plugin${plugins === 1 ? '' : 's'}` : null,
    themes ? `${themes} theme${themes === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} ${Number(core) + plugins + themes === 1 ? 'has' : 'have'}`;
}

/** "2 files only partly scanned (too large): wp-content/x/app.js and 1 more." - or no name, when none was kept. */
function partlyText(partly: ScanDto['partlyScanned']): string | null {
  if (partly.count === 0) return null;
  const files = `${partly.count} file${partly.count === 1 ? '' : 's'} only partly scanned (too large)`;
  const first = partly.files[0]?.path;
  return first ? `${files}: ${first}${partly.count > 1 ? ` and ${partly.count - 1} more` : ''}.` : `${files}.`;
}

function LastScan({ scan }: { scan: ScanDto }) {
  const unchecked = uncheckedText(scan.noChecksums);
  const partly = partlyText(scan.partlyScanned);
  const took = scan.finishedAt ? formatDuration(scan.finishedAt - scan.startedAt) : null;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ScanOutcomeBadge outcome={scan.status} />
        <span className="text-neutral-600">
          {timeAgo(scan.finishedAt ?? scan.startedAt)}
          {scan.filesScanned !== null && ` · ${scan.filesScanned.toLocaleString()} files`}
          {took && ` · took ${took}`}
        </span>
        {scan.jobId && (
          <Link className="text-xs text-neutral-500 underline" to={`/jobs/${scan.jobId}`}>
            job #{scan.jobId}
          </Link>
        )}
      </div>
      {scan.error && <p className="text-xs text-amber-800">{scan.error}</p>}
      {unchecked && (scan.status === 'clean' || scan.status === 'findings' || scan.status === 'incomplete') && (
        <p className="text-xs text-neutral-500" title={scan.noChecksums.join(', ')}>
          {unchecked} no published checksums: the known-malware scan read them, nothing could say they are unchanged.
        </p>
      )}
      {partly && (
        <p className="text-xs text-neutral-500" title={scan.partlyScanned.files.map((f) => f.path).join('\n')}>
          {partly}
        </p>
      )}
    </div>
  );
}

/**
 * The site's scans: the one under way, the last, the next and the earlier ones. Whether it is
 * scanned, and what a finding does, are in its settings (SiteSecuritySettings).
 */
export function MalwareScanCard({ slug, scan }: { slug: string; scan: SiteScanDto }) {
  const scanNow = useScanNow(slug);
  const history = useSiteScanHistory(slug);
  // The history starts with the scan under way and the last one, which the card already shows.
  const earlier = history.data?.history.filter((s) => s.id !== scan.last?.id && s.status !== 'running');
  const next = !scan.effective.enabled
    ? 'Scans are off for this site.'
    : scan.nextDueAt
      ? `Next scan ${scan.nextDueAt <= Date.now() ? 'as soon as there is room' : timeUntil(scan.nextDueAt)}.`
      : null;

  return (
    <Card
      title="Malware scan"
      action={
        <Button small variant="secondary" disabled={!!scan.active || scanNow.isPending} onClick={() => scanNow.mutate()}>
          {scan.active ? (scan.active.status === 'running' ? 'Scanning…' : 'Queued…') : 'Scan now'}
        </Button>
      }
    >
      <div className="space-y-4">
        {scan.active && (
          <p className="flex items-center gap-2 text-sm text-neutral-600">
            <Spinner /> {scan.active.status === 'running' ? 'Scanning' : 'Waiting for its turn'} -{' '}
            <Link className="underline" to={`/jobs/${scan.active.jobId}`}>
              job #{scan.active.jobId}
            </Link>
          </p>
        )}
        {scan.last ? <LastScan scan={scan.last} /> : !scan.active && <p className="text-sm text-neutral-500">Not scanned yet.</p>}
        {(next || !scan.effective.signatures || scan.failures >= 2) && (
          <p className="text-xs text-neutral-500">
            {next}
            {!scan.effective.signatures && ' Signatures are off (Settings): only the checksum check runs.'}
            {scan.failures >= 2 && <span className="text-amber-800"> The last {scan.failures} scans failed.</span>}
          </p>
        )}
        <ErrorNote error={scanNow.error} />

        <details>
          <summary className="cursor-pointer select-none text-sm text-neutral-600 hover:text-neutral-900">Earlier scans</summary>
          <ul className="mt-2 space-y-2">
            {(earlier ?? []).map((s) => (
              <li key={s.id} className="border-t border-neutral-100 pt-2">
                <LastScan scan={s} />
              </li>
            ))}
            {earlier && earlier.length === 0 && <li className="text-xs text-neutral-500">None yet.</li>}
          </ul>
        </details>
      </div>
    </Card>
  );
}

const SEVERITY_DOT: Record<string, string> = { high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-neutral-300' };

function fileLink(slug: string, f: FindingDto): string {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  const params = new URLSearchParams({ tab: 'files', dir, file: f.path, ...(f.line ? { line: String(f.line) } : {}) });
  return `/sites/${slug}?${params.toString()}`;
}

export function FindingsCard({ slug }: { slug: string }) {
  const [status, setStatus] = useState<FindingStatus | 'all'>('open');
  const findings = useFindings(slug, status);
  const act = useFindingAction(slug);
  const [confirm, setConfirm] = useState<{ finding: FindingDto; action: 'quarantine' | 'reinstall' | 'put-back' } | null>(null);
  const counts = findings.data?.counts;
  const label = (s: FindingStatus, text: string) => `${text}${counts ? ` (${counts[s]})` : ''}`;

  return (
    <Card title="Findings">
      <div className="space-y-3">
        <Segmented
          small
          label="Which findings"
          options={[
            { id: 'open', label: label('open', 'Open') },
            { id: 'ignored', label: label('ignored', 'Ignored') },
            { id: 'quarantined', label: label('quarantined', 'Quarantined') },
            { id: 'resolved', label: label('resolved', 'Resolved') },
            { id: 'all', label: 'All' },
          ]}
          value={status}
          onChange={setStatus}
        />
        <ErrorNote error={findings.error ?? act.error} />
        {!findings.data ? (
          <Spinner />
        ) : findings.data.items.length === 0 ? (
          <EmptyState>{status === 'open' ? 'Nothing open.' : 'None.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2">What</th>
                  <th className="pb-2">File</th>
                  <th className="pb-2">Found</th>
                  <th className="pb-2 text-right" />
                </tr>
              </thead>
              <tbody>
                {findings.data.items.map((f) => (
                  <tr key={f.id} className="border-t border-neutral-100 align-top">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[f.severity]}`} title={f.severity} />
                        <span className="font-medium">{FINDING_KIND_INFO[f.kind]?.label ?? f.kind}</span>
                      </div>
                      {f.detail && <div className="measure mt-0.5 break-words text-xs text-neutral-500">{f.detail}</div>}
                      {f.package && f.package !== 'core' && <div className="text-[11px] text-neutral-400">{f.package.replace(/^plugin:/, 'plugin ')} {f.packageVersion}</div>}
                      {f.zipReview && (
                        <div className="measure mt-1 text-xs text-neutral-600">
                          Also flagged in catalog zip &ldquo;{f.zipReview.name}&rdquo; -{' '}
                          <Link className="underline" to={`/plugins?check=${f.zipReview.pluginId}`}>
                            review it
                          </Link>{' '}
                          to clear it on every site.
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Link className="break-all font-mono text-xs underline decoration-neutral-300" to={fileLink(slug, f)}>
                        {f.path}
                        {f.line ? `:${f.line}` : ''}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-xs text-neutral-500">
                      {timeAgo(f.firstSeenAt)}
                      {f.status !== 'open' && f.statusBy && (
                        <div>
                          {f.status} by {f.statusBy}
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {f.canReinstall && (
                          <Button small variant="secondary" onClick={() => setConfirm({ finding: f, action: 'reinstall' })}>
                            Reinstall original
                          </Button>
                        )}
                        {f.canPutBack && (
                          <Button small variant="secondary" onClick={() => setConfirm({ finding: f, action: 'put-back' })}>
                            Put back
                          </Button>
                        )}
                        {f.quarantineProblem === null && (
                          <Button small variant="secondary" onClick={() => setConfirm({ finding: f, action: 'quarantine' })}>
                            Quarantine
                          </Button>
                        )}
                        {f.status === 'open' && (
                          <Button small variant="ghost" onClick={() => act.mutate({ id: f.id, action: 'ignore' })}>
                            Ignore
                          </Button>
                        )}
                        {f.status === 'ignored' && (
                          <Button small variant="ghost" onClick={() => act.mutate({ id: f.id, action: 'unignore' })}>
                            Unignore
                          </Button>
                        )}
                        {(f.status === 'open' || f.status === 'ignored') && (
                          <Button small variant="ghost" onClick={() => act.mutate({ id: f.id, action: 'resolve' })} title="Say it has been dealt with; a scan reopens it if it is still there">
                            Resolved
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'reinstall' ? 'Reinstall original' : confirm.action === 'put-back' ? 'Put back' : 'Move to quarantine'}
          confirmLabel={confirm.action === 'reinstall' ? 'Reinstall' : confirm.action === 'put-back' ? 'Put back' : 'Move it'}
          message={
            confirm.action === 'put-back' ? (
              <>
                Overwrite <code>{confirm.finding.path}</code> with the panel&rsquo;s own, then scan again. If nobody here changed it, check the
                other findings too.
              </>
            ) : confirm.action === 'reinstall' ? (
              <>
                Download {confirm.finding.package === 'core' ? 'WordPress' : confirm.finding.package?.replace(/^plugin:/, 'the plugin ')} again from
                wordpress.org, at the version the site has, over its files - then scan again. Changes anyone made to its files are lost.
              </>
            ) : (
              <>
                Move <code>{confirm.finding.path}</code> out of the site, into its quarantine. It is kept there, and can be put back from the Quarantine
                card.
              </>
            )
          }
          onConfirm={() => act.mutate({ id: confirm.finding.id, action: confirm.action })}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}

export function QuarantineCard({ slug }: { slug: string }) {
  const items = useQuarantine(slug);
  const act = useQuarantineAction(slug);
  const [confirm, setConfirm] = useState<{ item: QuarantineItemDto; action: 'restore' | 'delete' } | null>(null);
  const kept = (items.data ?? []).filter((i) => i.state === 'kept');
  const done = (items.data ?? []).filter((i) => i.state !== 'kept').slice(0, 10);

  return (
    <Card title="Quarantine">
      <div className="space-y-3">
        <ErrorNote error={items.error ?? act.error} />
        {!items.data ? (
          <Spinner />
        ) : kept.length === 0 ? (
          <EmptyState>Nothing in quarantine.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {kept.map((i) => (
                <tr key={i.id} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="break-all font-mono text-xs">{i.path}</div>
                    <div className="text-xs text-neutral-500">
                      {i.reason} · {formatBytes(i.sizeBytes)} · moved {timeAgo(i.movedAt)} by {i.movedBy}
                    </div>
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button small variant="secondary" onClick={() => setConfirm({ item: i, action: 'restore' })}>
                        Put back
                      </Button>
                      <Button small variant="danger" onClick={() => setConfirm({ item: i, action: 'delete' })}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {done.length > 0 && (
          <details className="text-xs text-neutral-500">
            <summary className="cursor-pointer">Put back or deleted</summary>
            <ul className="mt-1 space-y-1">
              {done.map((i) => (
                <li key={i.id}>
                  <span className="font-mono">{i.path}</span> - {i.state === 'restored' ? `put back ${formatDate(i.restoredAt)} by ${i.restoredBy}` : `deleted ${formatDate(i.deletedAt)} by ${i.deletedBy}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'restore' ? 'Put the file back' : 'Delete for good'}
          confirmLabel={confirm.action === 'restore' ? 'Put it back' : 'Delete'}
          message={
            confirm.action === 'restore' ? (
              <>
                Put <code>{confirm.item.path}</code> back where it was. Its findings become ignored, so a scan does not move it again - until the
                file changes.
              </>
            ) : (
              <>
                Delete the quarantined copy of <code>{confirm.item.path}</code>. It cannot be put back afterwards.
              </>
            )
          }
          onConfirm={() => act.mutate({ id: confirm.item.id, action: confirm.action })}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}
