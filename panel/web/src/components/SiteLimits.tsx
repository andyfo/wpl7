// @docs sites/settings
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SITE_LIMIT_RANGES, siteLimitProblem } from '../../../shared/schemas';
import type { JobDto, SiteDetail, SiteLimits } from '../../../shared/types';
import { api } from '../api/client';
import { useFollowJob, useJobSnapshots } from './jobConsole/context';
import { Button, Card, ErrorNote, Field, inputClass } from './ui';

type LimitKey = keyof SiteLimits<number>;

const FIELDS: { key: LimitKey; label: string; step: number; zeroUncaps: boolean }[] = [
  { key: 'cpuLimit', label: 'CPU cores', step: 0.5, zeroUncaps: true },
  { key: 'memoryLimitMb', label: 'Memory (MB)', step: 128, zeroUncaps: false },
  { key: 'pidsLimit', label: 'Processes', step: 64, zeroUncaps: true },
];

const textOf = (own: SiteLimits<number | null>): SiteLimits<string> => ({
  cpuLimit: own.cpuLimit === null ? '' : String(own.cpuLimit),
  memoryLimitMb: own.memoryLimitMb === null ? '' : String(own.memoryLimitMb),
  pidsLimit: own.pidsLimit === null ? '' : String(own.pidsLimit),
});

/** What a field holds: null when it is empty (the default), NaN when it is not a number. */
const valueOf = (text: string): number | null => (text.trim() === '' ? null : Number(text));

/** Why a field cannot be saved as it is, or null. Empty is the default, which always can. */
function problemOf(field: (typeof FIELDS)[number], text: string): string | null {
  const n = valueOf(text);
  return n === null ? null : siteLimitProblem(field.key, field.label, n);
}

/**
 * A site's own CPU, memory and process limits, on its Settings tab: an empty field follows the
 * default in Settings. Saving queues the job that changes the container, which the job console
 * shows; the button spins until it has run. What the fields show is what is stored, once saved
 * here or elsewhere.
 */
export function SiteLimitsCard({ site }: { site: SiteDetail }) {
  const qc = useQueryClient();
  const follow = useFollowJob();
  const snapshots = useJobSnapshots();
  const own = site.limits?.own ?? { cpuLimit: null, memoryLimitMb: null, pidsLimit: null };
  const [text, setText] = useState(() => textOf(own));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  useEffect(() => {
    setText(textOf({ cpuLimit: own.cpuLimit, memoryLimitMb: own.memoryLimitMb, pidsLimit: own.pidsLimit }));
  }, [own.cpuLimit, own.memoryLimitMb, own.pidsLimit]);
  // "Saved." is a moment, as on the Settings page.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 5_000);
    return () => clearTimeout(timer);
  }, [saved]);

  if (!site.limits) return null;
  const defaults = site.limits.defaults;
  // Compared as numbers: "2.50" is the 2.5 stored. Only these are sent, so a limit changed
  // elsewhere meanwhile is not put back.
  const changed = FIELDS.filter((f) => valueOf(text[f.key]) !== own[f.key]);
  const dirty = changed.length > 0;
  const problem = FIELDS.map((f) => problemOf(f, text[f.key])).find((p) => p !== null) ?? null;
  const applying = jobId !== null && snapshots.get(jobId)?.refreshed !== true;

  const edit = (key: LimitKey, value: string) => {
    setSaved(false);
    setText((t) => ({ ...t, [key]: value }));
  };
  const save = () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    void api<{ site: SiteDetail; job: JobDto | null }>(`/api/sites/${site.slug}/limits`, {
      method: 'PUT',
      body: Object.fromEntries(changed.map((f) => [f.key, valueOf(text[f.key])])),
    })
      .then((res) => {
        qc.setQueryData(['site', site.slug], res.site);
        if (res.site.limits) setText(textOf(res.site.limits.own));
        if (res.job) {
          follow(res.job, { refresh: [['site', site.slug]] });
          setJobId(res.job.id);
        }
        setSaved(true);
      })
      .catch(setError)
      .finally(() => setSaving(false));
  };
  const shown = (key: LimitKey, n: number) => (n === 0 && key !== 'memoryLimitMb' ? 'uncapped' : String(n));

  return (
    <Card title="Container limits">
      <p className="measure mb-4 text-sm text-neutral-600">
        An empty field uses the default from{' '}
        <Link className="underline" to="/settings#limits">
          Settings
        </Link>
        . Changes apply right away, without a restart, except lifting the CPU cap (0), which restarts the site once.
      </p>
      <div className="grid max-w-2xl gap-4 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            hint={`Default: ${shown(f.key, defaults[f.key])}.${f.zeroUncaps ? ' 0 = uncapped.' : ''}`}
          >
            <input
              className={inputClass}
              type="number"
              min={SITE_LIMIT_RANGES[f.key].min}
              max={SITE_LIMIT_RANGES[f.key].max}
              step={f.step}
              placeholder="Default"
              value={text[f.key]}
              onChange={(e) => edit(f.key, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span title={problem ?? undefined}>
          <Button disabled={!dirty || problem !== null} busy={saving || applying} onClick={save}>
            Save limits
          </Button>
        </span>
        {problem ? (
          <span className="text-xs text-red-700">{problem}</span>
        ) : saved && !dirty ? (
          <span className="text-xs text-emerald-700">Saved.</span>
        ) : null}
      </div>
      {error !== null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
    </Card>
  );
}
