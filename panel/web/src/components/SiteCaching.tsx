// @docs sites/caching
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CACHE_RULE_GROUPS,
  CACHE_RULE_MATCHES,
  MAX_OWN_COPY_RULES,
  cacheRuleKinds,
  cacheRuleProblem,
  type CacheRule,
  type CacheRuleKind,
  type CacheRuleMatch,
} from '../../../shared/cacheRules';
import type { JobDto, SiteCacheCheck, SiteDetail } from '../../../shared/types';
import { api } from '../api/client';
import { useFollowJob, useJobSnapshots } from './jobConsole/context';
import { Button, Card, ErrorNote, Field, Segmented, Toggle, inputClass } from './ui';

const hours = (seconds: number) => (seconds >= 3600 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : `${Math.round(seconds / 60)} minutes`);

/** What "Keep pages for" offers, here and in Settings. */
export const KEEP_CHOICES = [300, 1800, 3600, 10800, 21600, 36000];
export const keepLabel = hours;

const KIND_LABEL: Record<CacheRuleKind, string> = {
  skip: 'Skip the cache',
  copy: 'Separate copy per value',
  keep: 'Keep for a set time',
  ignore: 'Ignore this parameter',
};

const MATCH_LABEL: Record<CacheRuleMatch, string> = {
  path: 'URL path',
  cookie: 'Cookie',
  query: 'Query parameter',
  agent: 'User agent',
  postType: 'Post type',
  phone: 'Phones',
};

const PLACEHOLDER: Record<CacheRuleMatch, string> = {
  path: '/members/*',
  cookie: 'my_cookie',
  query: 'lang',
  agent: 'MyBot',
  postType: 'product',
  phone: '',
};

/** "Skip the cache: cookie wordpress_logged_in_", one line of a group or of the site's own. */
const ruleText = (rule: CacheRule) => {
  const what = rule.match === 'phone' ? 'phones' : `${MATCH_LABEL[rule.match].toLowerCase()} ${rule.value}`;
  return `${KIND_LABEL[rule.kind]}: ${what}${rule.seconds ? ` (${hours(rule.seconds)})` : ''}`;
};

/** A switch with its reason beside it and on the tooltip, because Toggle has no title of its own. */
function Reasoned({ reason, children }: { reason: string | null; children: ReactNode }) {
  return (
    <div>
      <span title={reason ?? undefined} className="inline-block">
        {children}
      </span>
      {reason && <p className="mt-1 text-xs text-neutral-500">{reason}</p>}
    </div>
  );
}

/**
 * A site's caches, on its Settings tab. Every control saves as it changes: the page cache and the
 * rules apply in the container at once, and the object cache runs as a job in the job console.
 */
export function SiteCachingCard({ site }: { site: SiteDetail }) {
  const qc = useQueryClient();
  const follow = useFollowJob();
  const snapshots = useJobSnapshots();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [objectJob, setObjectJob] = useState<number | null>(null);
  const cache = site.cache;
  if (!cache) return null;

  /** Resolves to whether it saved: the error itself is shown here. */
  const save = (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    return api<{ site: SiteDetail; job: JobDto | null }>(`/api/sites/${site.slug}/cache`, { method: 'PUT', body })
      .then((res) => {
        qc.setQueryData(['site', site.slug], res.site);
        if (res.job) {
          follow(res.job, { refresh: [['site', site.slug]] });
          setObjectJob(res.job.id);
        }
        return true;
      })
      .catch((err: unknown) => {
        setError(err);
        return false;
      })
      .finally(() => setSaving(false));
  };
  const switching = objectJob !== null && snapshots.get(objectJob)?.refreshed !== true;
  const keepChoices = [...new Set([...KEEP_CHOICES, ...(cache.keepSeconds ? [cache.keepSeconds] : [])])].sort((a, b) => a - b);

  return (
    <Card title="Caching">
      <div className="space-y-5">
        {site.stack === 1 && <p className="text-sm text-amber-800">This site still runs the old PHP setup. These settings apply once it has moved.</p>}
        <div>
          <div className="mb-1 text-sm font-medium text-neutral-700">Page cache</div>
          <Segmented
            small
            label="Page cache"
            options={[
              { id: 'default', label: `Follow the default (${cache.pageDefault ? 'on' : 'off'})` },
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
            ]}
            value={cache.page}
            onChange={(page) => void save({ page })}
          />
          {cache.offReason && <p className="measure mt-1 text-xs text-amber-800">{cache.offReason}</p>}
        </div>

        {cache.pageOn && (
          <Field label="Keep pages for" width="sm">
            <select
              className={inputClass}
              disabled={saving}
              value={cache.keepSeconds ?? 'default'}
              onChange={(e) => void save({ keepSeconds: e.target.value === 'default' ? null : Number(e.target.value) })}
            >
              <option value="default">Default ({hours(cache.keepDefaultSeconds)})</option>
              {keepChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {hours(seconds)}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Reasoned reason={cache.object ? null : cache.objectBlocked}>
          <Toggle
            checked={cache.object}
            disabled={cache.object ? false : cache.objectBlocked !== null}
            busy={saving || switching}
            label="Object cache (Redis)"
            onChange={(object) => void save({ object })}
          />
        </Reasoned>

        {cache.pageOn && <CheckUrl site={site} />}

        {cache.pageOn && (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-neutral-700">Rules</summary>
            <div className="mt-3 space-y-4">
              <BuiltInGroups cache={cache} saving={saving} save={save} />
              <OwnRules cache={cache} saving={saving} save={save} />
            </div>
          </details>
        )}

        {error !== null && <ErrorNote error={error} />}
      </div>
    </Card>
  );
}

type CardParts = { cache: NonNullable<SiteDetail['cache']>; saving: boolean; save: (body: Record<string, unknown>) => Promise<boolean> };

function BuiltInGroups({ cache, saving, save }: CardParts) {
  const off = new Set(cache.off);
  const toggle = (id: string, on: boolean) => void save({ off: on ? cache.off.filter((other) => other !== id) : [...cache.off, id] });
  return (
    <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 text-sm">
      {CACHE_RULE_GROUPS.map((group) => {
        const groupOn = group.lockedReason !== undefined || !off.has(group.id);
        return (
          <li key={group.id} className="p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium text-neutral-800">{group.label}</span>
                {cache.groupsInUse.includes(group.id) && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">In use</span>}
                <p className="measure text-xs text-neutral-500">{group.lockedReason ?? group.description}</p>
              </div>
              <span title={group.lockedReason}>
                <Toggle checked={groupOn} disabled={group.lockedReason !== undefined} busy={saving} onChange={(on) => toggle(group.id, on)} />
              </span>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-neutral-500">{group.rules.length === 1 ? '1 rule' : `${group.rules.length} rules`}</summary>
              <ul className="mt-2 space-y-1.5">
                {group.rules.map((rule) => (
                  <li key={rule.id} className="flex items-center justify-between gap-2 text-xs text-neutral-700">
                    <code className="break-all">{ruleText(rule)}</code>
                    <span title={group.lockedReason}>
                      <Toggle checked={groupOn && !off.has(rule.id)} disabled={group.lockedReason !== undefined || !groupOn} busy={saving} onChange={(on) => toggle(rule.id, on)} />
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function OwnRules({ cache, saving, save }: CardParts) {
  const [kind, setKind] = useState<CacheRuleKind>('skip');
  const [match, setMatch] = useState<CacheRuleMatch>('path');
  const [value, setValue] = useState('');
  const [seconds, setSeconds] = useState(300);

  // A phone has a switch of its own, among the built-in groups.
  const matches: readonly CacheRuleMatch[] = CACHE_RULE_MATCHES[kind].filter((m) => m !== 'phone');
  const shownMatch = matches.includes(match) ? match : matches[0]!;
  const rule = { kind, match: shownMatch, value: value.trim(), ...(kind === 'keep' ? { seconds } : {}) };
  const copies = cache.own.filter((r) => r.kind === 'copy').length;
  const problem =
    kind === 'copy' && copies >= MAX_OWN_COPY_RULES ? `At most ${MAX_OWN_COPY_RULES} separate-copy rules: each multiplies the copies of every page.` : rule.value === '' ? null : cacheRuleProblem(rule);

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-neutral-700">This site's rules</div>
      {cache.own.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {cache.own.map((own) => (
            <li key={own.id} className="flex items-center justify-between gap-2 text-xs text-neutral-700">
              <code className="break-all">{ruleText(own)}</code>
              <Button small variant="secondary" disabled={saving} onClick={() => void save({ own: cache.own.filter((r) => r.id !== own.id) })}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="What">
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as CacheRuleKind)}>
            {cacheRuleKinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Matches">
          <select className={inputClass} value={shownMatch} onChange={(e) => setMatch(e.target.value as CacheRuleMatch)}>
            {matches.map((m) => (
              <option key={m} value={m}>
                {MATCH_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Value">
          <input className={inputClass} placeholder={PLACEHOLDER[shownMatch]} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {kind === 'keep' && (
          <Field label="Seconds" width="sm">
            <input className={inputClass} type="number" min={1} max={36000} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
          </Field>
        )}
        <span title={problem ?? undefined}>
          <Button
            variant="secondary"
            disabled={rule.value === '' || problem !== null || saving}
            onClick={() => void save({ own: [...cache.own, rule] }).then((saved) => saved && setValue(''))}
          >
            Add rule
          </Button>
        </span>
      </div>
      {problem && <p className="mt-1 text-xs text-red-700">{problem}</p>}
    </div>
  );
}

const CHECK_LINE: Record<SiteCacheCheck['state'], (reason: string | null) => string> = {
  cached: () => 'Cached.',
  stale: () => "An old copy: PHP or the database isn't answering.",
  skipped: (reason) => `Skipped: ${reason}.`,
  'not-stored': (reason) => `Not stored: ${reason}.`,
  off: () => 'The page cache is off.',
};

function CheckUrl({ site }: { site: SiteDetail }) {
  const [path, setPath] = useState('/');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SiteCacheCheck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const blocked = site.cache?.liveBlocked ?? null;
  const check = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    void api<SiteCacheCheck>(`/api/sites/${site.slug}/cache/check`, { method: 'POST', body: { path } })
      .then(setResult)
      .catch(setError)
      .finally(() => setBusy(false));
  };
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Check a URL">
          <input className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <span title={blocked ?? undefined}>
          <Button variant="secondary" disabled={blocked !== null || !path.startsWith('/')} busy={busy} onClick={check}>
            Check
          </Button>
        </span>
      </div>
      {blocked && <p className="mt-1 text-xs text-neutral-500">{blocked}</p>}
      {result && (
        <p className="mt-1 text-sm text-neutral-700">
          {CHECK_LINE[result.state](result.reason)}
          {result.status !== null && result.status !== 200 && ` (HTTP ${result.status})`}
        </p>
      )}
      {error !== null && (
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

/** Beside Recreate container on the site's Overview. */
export function ClearCacheButton({ site }: { site: SiteDetail }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const blocked = site.cache?.liveBlocked ?? null;
  if (!site.cache) return null;
  const clear = () => {
    setBusy(true);
    setDone(false);
    setError(null);
    void api(`/api/sites/${site.slug}/cache/clear`, { method: 'POST' })
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 3000);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };
  return (
    <>
      <span title={blocked ?? undefined}>
        <Button small variant="secondary" disabled={blocked !== null} busy={busy} onClick={clear}>
          {done ? 'Cleared' : 'Clear cache'}
        </Button>
      </span>
      {error !== null && <ErrorNote error={error} />}
    </>
  );
}
