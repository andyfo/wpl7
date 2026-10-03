import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useSystemVersion } from '../api/hooks';
import type { UpdateHistoryDto, UpdateStatusDto } from '../../../shared/types';
import { Button, Card, ConfirmDialog, ErrorNote } from './ui';
import { formatDate } from '../lib/format';
import { UpdateProgress } from './UpdateProgress';

/**
 * Three states, not two.
 *
 * "Up to date" and "update available" are the obvious ones. The third is "could not check",
 * and it has to be visible: GitHub answers 403 rather than an error when an anonymous
 * caller runs out of its 60 requests an hour, so a panel that folded that into "up to date"
 * would stop offering updates and never say why.
 */
export function UpdatesCard() {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const version = useSystemVersion();
  // A state file exists once an update has ever run here, and it is how a page opened after
  // the panel was replaced still shows the outcome.
  const status = useQuery({
    queryKey: ['update-status'],
    queryFn: () => api<UpdateStatusDto>('/api/system/update/status'),
  });

  const checkNow = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await api('/api/system/update/check', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['system-version'] });
      await qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  };

  const rerunTasks = async () => {
    setStartError(null);
    try {
      await api('/api/system/update/post-update', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['update-status'] });
      await qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (err) {
      setStartError(err);
    }
  };

  const startUpdate = async (target: string) => {
    setStartError(null);
    try {
      await api('/api/system/update', { method: 'POST', body: { version: target } });
      await qc.invalidateQueries({ queryKey: ['update-status'] });
      await qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (err) {
      setStartError(err);
    }
  };

  const v = version.data;
  if (!v) return null;
  const inFlight =
    status.data?.running ||
    (status.data?.maintenance != null && status.data.state?.phase !== 'failed');
  // Shown for a finished update too, until the page is reloaded: the outcome is the point.
  const showProgress = inFlight || (status.data?.state != null && status.data.maintenance != null);

  return (
    <Card
      title="Updates"
      action={
        <Button variant="secondary" onClick={checkNow} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </Button>
      }
    >
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Installed">
            <span className="font-medium">{v.version}</span>
            {v.gitSha !== 'unknown' && <span className="ml-2 text-neutral-400">{v.gitSha.slice(0, 7)}</span>}
          </Row>
          <Row label="Channel">
            {v.channel}
            <span className="ml-2 text-neutral-400">
              {v.channel === 'edge' ? 'the rolling build of main' : 'released versions'}
            </span>
          </Row>
          <Row label="Panel comes from">
            {v.source === 'image' ? 'the released image' : 'this server’s own checkout'}
          </Row>
          <Row label="Last checked">
            {v.checkedAt ? formatDate(v.checkedAt) : 'never'}
          </Row>
        </dl>

        {showProgress && (
          <UpdateProgress
            onFinished={() => {
              void qc.invalidateQueries({ queryKey: ['meta'] });
              void qc.invalidateQueries({ queryKey: ['system-version'] });
            }}
          />
        )}

        {v.error ? (
          <Note tone="warn">
            <strong>Could not check for updates.</strong> {v.error}
            {v.checkedAt && <> The last answer, from {formatDate(v.checkedAt)}, is shown above.</>}
          </Note>
        ) : v.updateAvailable && v.latest ? (
          <Note tone="ok">
            <div className="font-medium">
              {v.latest.version} is available
              {v.latest.publishedAt && <span className="font-normal"> · published {v.latest.publishedAt.slice(0, 10)}</span>}
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>The panel container is replaced, and site containers keep running throughout.</li>
              <li>Site images are pulled and retagged; existing sites keep theirs until recreated.</li>
              {v.latest.requiresDowntime && (
                <li className="font-medium">
                  This release says sites may be unreachable while it applies.
                </li>
              )}
              {v.latest.minUpgradeFrom && (
                <li>Applies to {v.latest.minUpgradeFrom} or newer.</li>
              )}
            </ul>
            {v.latest.notesUrl && (
              <a
                className="mt-2 inline-block font-medium underline"
                href={v.latest.notesUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Release notes
              </a>
            )}
            {v.source === 'image' ? (
              <div className="mt-3">
                <Button onClick={() => setConfirming(true)} disabled={inFlight}>
                  Update to {v.latest.version}
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-neutral-600">
                This install builds its panel from a checkout, so the button does not apply here.
                Deploy it with <code>./provision/deploy.sh</code>, or move to image mode first
                (docs/updating.md).
              </p>
            )}
          </Note>
        ) : (
          <Note tone="quiet">
            {v.latest ? `Up to date — ${v.latest.version} is the newest on this channel.` : 'No release found yet.'}
          </Note>
        )}

        {status.data?.history?.[0] && <PostUpdate entry={status.data.history[0]} onRerun={() => void rerunTasks()} />}

        <ErrorNote error={checkError} />
        <ErrorNote error={startError} />

        {confirming && v.latest && (
          <ConfirmDialog
            title={`Update to ${v.latest.version}?`}
            confirmLabel="Update now"
            onClose={() => setConfirming(false)}
            onConfirm={() => void startUpdate(v.latest!.version)}
            message={
              <div className="space-y-2">
                <p>
                  The panel is stopped and replaced, so this page will go quiet for a minute or
                  two and then come back on the new version. Site containers keep running
                  throughout.
                </p>
                <p>
                  Its database is copied first, and if the new panel does not come back healthy
                  the previous image, the previous files and that copy are all put back
                  automatically.
                </p>
                <p>
                  Jobs must be finished before it can start, and the panel refuses writes while
                  it runs.
                </p>
              </div>
            }
          />
        )}

        <p className="text-xs text-neutral-500">
          Checked once an hour, at a minute of the hour picked when this install was set up. Nothing
          is downloaded until an update is applied, and no page view ever contacts GitHub.
          {v.channel === 'stable'
            ? ' Set WPL7_CHANNEL=edge in deploy/.env to follow the rolling build instead.'
            : ' Set WPL7_CHANNEL=stable in deploy/.env to follow released versions instead.'}
        </p>
      </div>
    </Card>
  );
}

/**
 * What the panel did for itself after the last update. Shown whatever the outcome: these
 * steps used to be paragraphs in the docs beginning "after upgrading, run…", and the whole
 * point of moving them here is that somebody can see whether they happened.
 */
function PostUpdate({ entry, onRerun }: { entry: UpdateHistoryDto; onRerun: () => void }) {
  const failed = entry.status === 'failed';
  return (
    <Note tone={failed ? 'warn' : 'quiet'}>
      <div className="flex items-start justify-between gap-4">
        <div className="font-medium">
          Post-update tasks for {entry.fromVersion} → {entry.toVersion}:{' '}
          {entry.status === 'running' ? 'running' : failed ? 'some steps failed' : 'done'}
        </div>
        <Button variant="secondary" small onClick={onRerun}>
          Re-run
        </Button>
      </div>
      {entry.steps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {entry.steps.map((step) => (
            <li key={step.key + step.title}>
              <span className={step.outcome === 'failed' ? 'font-medium' : ''}>
                {step.outcome === 'failed' ? '✕' : '✓'} {step.title}
              </span>
              <span className="text-neutral-500"> — {step.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p className="mt-2">
          The update itself is applied and this panel is the new version. These are the steps
          that follow it; fix what they report and re-run.
        </p>
      )}
    </Note>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{children}</dd>
    </div>
  );
}

const TONES = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  quiet: 'border-neutral-200 bg-neutral-50 text-neutral-600',
};

function Note({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return <div className={`rounded-lg border px-4 py-3 text-sm ${TONES[tone]}`}>{children}</div>;
}
