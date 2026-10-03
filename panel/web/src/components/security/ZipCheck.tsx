import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PluginDto, PluginZipCheckDto, PluginZipFindingDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { timeAgo } from '../../lib/format';
import { Button, ErrorNote, Modal, Spinner } from '../ui';

const SEVERITY_CLASS: Record<PluginZipFindingDto['severity'], string> = {
  high: 'text-red-700',
  medium: 'text-amber-700',
  low: 'text-neutral-600',
};

/** A catalog entry's malware check, in a word or two, with what can be done about it. */
export function ZipCheckCell({ plugin, onOpen }: { plugin: PluginDto; onOpen: () => void }) {
  if (plugin.kind !== 'zip') {
    return (
      <span className="text-xs text-neutral-400" title="Checked on every site against wordpress.org's checksums">
        on each site
      </span>
    );
  }
  const check = plugin.check;
  const open = (label: string) => (
    <Button small variant="ghost" onClick={onOpen}>
      {label}
    </Button>
  );
  if (check?.checking) return <span className="text-xs text-sky-700">Checking…</span>;
  if (!check || check.status === 'pending') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-500">Not checked</span>
        {open('Check')}
      </div>
    );
  }
  if (check.status === 'failed') {
    return (
      <div className="flex items-center gap-2" title={check.problem ?? undefined}>
        <span className="text-xs text-red-700">Could not be checked</span>
        {open('Details')}
      </div>
    );
  }
  if (check.status === 'incomplete') {
    return (
      <div className="flex items-center gap-2" title={check.problem ?? undefined}>
        <span className="text-xs text-amber-700">Checked in part</span>
        {open('Details')}
      </div>
    );
  }
  if (check.needsReview) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-red-700">
          {check.confirmed > 0 ? `${check.confirmed} known malware` : `${check.flagged} flagged`}
        </span>
        {open('Review')}
      </div>
    );
  }
  if (check.flagged > 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-600">Reviewed</span>
        {open('Details')}
      </div>
    );
  }
  return (
    <span className="text-xs text-emerald-700" title={checkedLine(check)}>
      Nothing found
    </span>
  );
}

function checkedLine(check: PluginZipCheckDto): string {
  return [
    check.files !== null ? `${check.files.toLocaleString()} files` : null,
    check.version ? `version ${check.version}` : 'no Version in its header',
    check.checkedAt ? `checked ${timeAgo(check.checkedAt)}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * One zip's check: what it holds, what AMWScan flagged, and the review that lets sites'
 * unchanged copies of the flagged files be vouched for too.
 */
export function ZipCheckDialog({ plugin, onClose }: { plugin: PluginDto; onClose: () => void }) {
  const qc = useQueryClient();
  const details = useQuery({
    queryKey: ['plugin-zip-check', plugin.id],
    queryFn: () => api<{ check: PluginZipCheckDto | null; findings: PluginZipFindingDto[] }>(`/api/plugins/${plugin.id}/check`),
    refetchInterval: (q) => (q.state.data?.check?.checking ? 4000 : false),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['plugin-catalog'] }), qc.invalidateQueries({ queryKey: ['plugin-zip-check', plugin.id] })]);
  };
  const act = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const check = details.data?.check ?? null;
  const findings = details.data?.findings ?? [];
  return (
    <Modal title={`Malware check: ${plugin.name}`} onClose={onClose} wide>
      {!details.data ? (
        details.error ? (
          <ErrorNote error={details.error} />
        ) : (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )
      ) : (
        <div className="space-y-4 text-sm">
          {!check || check.status === 'pending' ? (
            <p className="text-neutral-600">Not checked yet. A check unpacks the zip in a throwaway container with no network and scans every file.</p>
          ) : (
            <>
              <p className="text-neutral-600">
                {checkedLine(check)}. In a site&rsquo;s <b>{check.folder}</b>, at any version, each file unchanged from this zip is vouched for, like
                a wordpress.org plugin&rsquo;s.
                {check.flagged > 0 && !check.reviewed && ' The files below are not, until you say they are the plugin\u2019s own.'}
              </p>
              {check.problem && <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">{check.problem}</div>}
              {check.status !== 'done' && <p className="text-neutral-600">A zip that was not checked through vouches for nothing.</p>}

            </>
          )}

          {findings.length > 0 && (
            <ul className="divide-y divide-neutral-100 border-y border-neutral-100">
              {findings.map((f, i) => (
                <li key={`${f.path}-${f.rule}-${i}`} className="py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`whitespace-nowrap text-xs font-medium ${SEVERITY_CLASS[f.severity]}`}>{f.label}</span>
                    <span className="break-all font-mono text-xs">
                      {f.path}
                      {f.line ? `:${f.line}` : ''}
                    </span>
                  </div>
                  <div className="mt-0.5 break-words text-xs text-neutral-500">{f.detail ?? f.rule}</div>
                </li>
              ))}
            </ul>
          )}

          {check?.reviewed && (
            <p className="text-neutral-600">
              Reviewed by {check.reviewed.by ?? 'someone'} {timeAgo(check.reviewed.at)}: sites&rsquo; unchanged copies of these files are vouched for too.
            </p>
          )}
          {check?.needsReview && (
            <p className="text-neutral-600">
              Some plugins trip a signature with their own code - a library that mentions <code>.ssh/authorized_keys</code>, say. Say these are the
              plugin&rsquo;s own only if you trust where the zip came from. If you do not, remove it from the catalog.
            </p>
          )}

          <ErrorNote error={error} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" disabled={busy || check?.checking} onClick={() => void act(`/api/plugins/${plugin.id}/check`)}>
              {check?.checking ? 'Checking…' : check && check.status !== 'pending' ? 'Check again' : 'Check now'}
            </Button>
            {check?.needsReview && (
              <Button disabled={busy} onClick={() => void act(`/api/plugins/${plugin.id}/check/review`)}>
                They are the plugin&rsquo;s own code
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
