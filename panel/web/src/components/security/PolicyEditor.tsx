import type { ReactNode } from 'react';
import {
  CONTAINER_INFO,
  DENY_RULE_INFO,
  HEADER_INFO,
  LIMIT_INFO,
  SECURITY_LEVEL_INFO,
  denyRuleIds,
  describeLimit,
  limitIds,
  type ContainerPolicy,
  type EffectivePolicy,
  type HeaderPolicy,
  type LimitId,
  type PolicySource,
  type RateLimit,
  type SecurityOverrides,
  type WpcronMode,
  type XmlrpcMode,
} from '../../../../shared/security';
import { Button, Segmented, Toggle, compactInputClass } from '../ui';

type Section = 'rules' | 'limits' | 'headers' | 'container';

/** The overrides with one entry set - or, `undefined`, taken out again. */
function withEntry(o: SecurityOverrides, section: Section, key: string, value: unknown): SecurityOverrides {
  const current = { ...((o[section] as Record<string, unknown> | undefined) ?? {}) };
  if (value === undefined) delete current[key];
  else current[key] = value;
  const next = { ...o, [section]: current } as SecurityOverrides;
  if (Object.keys(current).length === 0) delete (next as Record<string, unknown>)[section];
  return next;
}

function withTop(o: SecurityOverrides, key: 'xmlrpc' | 'wpcron', value: string | undefined): SecurityOverrides {
  const next = { ...o } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as SecurityOverrides;
}

const XMLRPC_OPTIONS: { id: XmlrpcMode; label: string }[] = [
  { id: 'allow', label: 'Allow' },
  { id: 'limit', label: 'Limit' },
  { id: 'deny', label: 'Refuse' },
];
const WPCRON_OPTIONS: { id: WpcronMode; label: string }[] = [
  { id: 'allow', label: 'Allow' },
  { id: 'deny', label: 'Refuse' },
];

/**
 * Every rule, limit, header and in-container setting of a protection level, each with where it
 * comes from - the level, the default, or this site - and a way back to that. For a site the
 * changes are its own overrides; for the fleet's "Default protection", the default's.
 */
export function PolicyEditor({
  policy,
  overrides,
  scope,
  onChange,
  hits,
}: {
  /** What is in force with the changes so far. */
  policy: EffectivePolicy;
  /** This scope's own changes. */
  overrides: SecurityOverrides;
  scope: 'site' | 'fleet';
  onChange: (next: SecurityOverrides) => void;
  /** Requests blocked in the last seven days, by blocked-rule key. */
  hits?: Record<string, number>;
}) {
  if (policy.level === 'off') {
    return (
      <p className="text-sm text-neutral-500">
        Off: nothing is refused and nothing is limited. {SECURITY_LEVEL_INFO.off.summary}
      </p>
    );
  }
  const own = (key: string) => policy.sources[key] === scope;
  const source = (key: string) => <SourceNote source={policy.sources[key]} scope={scope} level={policy.level} />;
  const reset = (key: string, clear: () => SecurityOverrides) =>
    own(key) ? (
      <Button small variant="ghost" onClick={() => onChange(clear())} title="Go back to what the level (or the default) says">
        reset
      </Button>
    ) : null;
  const count = (key: string) => (hits && hits[key] ? hits[key] : 0);

  return (
    <div className="space-y-6">
      <Group title="Refused">
        {denyRuleIds.map((id) => (
          <Row
            key={id}
            label={DENY_RULE_INFO[id].label}
            description={DENY_RULE_INFO[id].description}
            note={source(`rules.${id}`)}
            hits={count(id)}
            reset={reset(`rules.${id}`, () => withEntry(overrides, 'rules', id, undefined))}
          >
            <Toggle checked={policy.rules[id]} onChange={(v) => onChange(withEntry(overrides, 'rules', id, v))} />
          </Row>
        ))}
        <Row
          label="XML-RPC"
          description="xmlrpc.php: the old remote API. Jetpack still uses it; almost nothing else does, and one request can carry hundreds of password guesses."
          note={source('xmlrpc')}
          hits={count('xmlrpc') + count('limit-xmlrpc')}
          reset={reset('xmlrpc', () => withTop(overrides, 'xmlrpc', undefined))}
        >
          <Segmented small options={XMLRPC_OPTIONS} value={policy.xmlrpc} onChange={(v) => onChange(withTop(overrides, 'xmlrpc', v))} label="XML-RPC" />
        </Row>
        <Row
          label="wp-cron.php from outside"
          description="The panel runs WordPress's scheduled tasks itself, so a visitor never has to."
          note={source('wpcron')}
          hits={count('wpcron')}
          reset={reset('wpcron', () => withTop(overrides, 'wpcron', undefined))}
        >
          <Segmented small options={WPCRON_OPTIONS} value={policy.wpcron} onChange={(v) => onChange(withTop(overrides, 'wpcron', v))} label="wp-cron" />
        </Row>
      </Group>

      <Group title="Limits" intro="Per visitor address. Past a limit a visitor gets 429 until the rate drops - and the attack detection notices one that keeps at it.">
        {limitIds.map((id) => (
          <Row
            key={id}
            label={LIMIT_INFO[id].label}
            description={LIMIT_INFO[id].description}
            note={source(`limits.${id}`)}
            hits={count(`limit-${id}`)}
            reset={reset(`limits.${id}`, () => withEntry(overrides, 'limits', id, undefined))}
          >
            {id === 'xmlrpc' && policy.xmlrpc !== 'limit' ? (
              <span className="text-xs text-neutral-500">Only when XML-RPC is limited</span>
            ) : (
              <LimitControl id={id} value={policy.limits[id]} onChange={(v) => onChange(withEntry(overrides, 'limits', id, v))} />
            )}
          </Row>
        ))}
      </Group>

      <Group title="Headers" intro="Sent with every answer. The browser does the work.">
        {(Object.keys(HEADER_INFO) as (keyof HeaderPolicy)[]).map((id) => (
          <Row
            key={id}
            label={HEADER_INFO[id].label}
            description={HEADER_INFO[id].description}
            note={source(`headers.${id}`)}
            reset={reset(`headers.${id}`, () => withEntry(overrides, 'headers', id, undefined))}
          >
            <Toggle checked={policy.headers[id]} onChange={(v) => onChange(withEntry(overrides, 'headers', id, v))} />
          </Row>
        ))}
      </Group>

      <Group title="Inside the container" intro="Set in files the site's container reads and cannot change.">
        {(Object.keys(CONTAINER_INFO) as (keyof ContainerPolicy)[]).map((id) => (
          <Row
            key={id}
            label={CONTAINER_INFO[id].label}
            description={CONTAINER_INFO[id].description}
            note={source(`container.${id}`)}
            reset={reset(`container.${id}`, () => withEntry(overrides, 'container', id, undefined))}
          >
            <Toggle checked={policy.container[id]} onChange={(v) => onChange(withEntry(overrides, 'container', id, v))} />
          </Row>
        ))}
      </Group>
    </div>
  );
}

function SourceNote({ source, scope, level }: { source: PolicySource | undefined; scope: 'site' | 'fleet'; level: EffectivePolicy['level'] }) {
  if (source === scope) return <span className="text-amber-700">{scope === 'site' ? 'changed for this site' : 'changed in the default'}</span>;
  if (source === 'fleet') return <span>from the default</span>;
  return <span>{SECURITY_LEVEL_INFO[level].label}</span>;
}

function Group({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-neutral-800">{title}</h3>
      {intro && <p className="measure mt-0.5 text-xs text-neutral-500">{intro}</p>}
      <div className="mt-2 divide-y divide-neutral-100">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  note,
  hits,
  reset,
  children,
}: {
  label: string;
  description: string;
  note: ReactNode;
  hits?: number;
  reset: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1 basis-72">
        <div className="text-sm font-medium text-neutral-800">{label}</div>
        <div className="measure text-xs text-neutral-500">{description}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-neutral-400">
          {note}
          {hits !== undefined && hits > 0 && <span>{hits.toLocaleString()} blocked in 7 days</span>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {reset}
        {children}
      </div>
    </div>
  );
}

function LimitControl({ id, value, onChange }: { id: LimitId; value: RateLimit | null; onChange: (v: RateLimit | null) => void }) {
  const fallback: RateLimit = id === 'login' || id === 'xmlrpc' ? { average: 20, burst: 2, per: 'minute' } : { average: 50, burst: 500, per: 'second' };
  const num = (s: string) => Math.max(1, Math.min(100_000, Math.round(Number(s)) || 1));
  return (
    <div className="flex flex-wrap items-center gap-2" title={describeLimit(value)}>
      <Toggle checked={value !== null} onChange={(on) => onChange(on ? fallback : null)} label={value ? undefined : <span className="text-xs text-neutral-500">No limit</span>} />
      {value && (
        <>
          <input
            aria-label={`${LIMIT_INFO[id].label}: requests`}
            className={`${compactInputClass} w-24`}
            type="number"
            min={1}
            value={value.average}
            onChange={(e) => onChange({ ...value, average: num(e.target.value) })}
          />
          <span className="text-xs text-neutral-500">a</span>
          <select aria-label={`${LIMIT_INFO[id].label}: per`} className={`${compactInputClass} w-24`} value={value.per} onChange={(e) => onChange({ ...value, per: e.target.value as RateLimit['per'] })}>
            <option value="second">second</option>
            <option value="minute">minute</option>
          </select>
          <span className="text-xs text-neutral-500">bursts of</span>
          <input
            aria-label={`${LIMIT_INFO[id].label}: burst`}
            className={`${compactInputClass} w-24`}
            type="number"
            min={1}
            value={value.burst}
            onChange={(e) => onChange({ ...value, burst: num(e.target.value) })}
          />
        </>
      )}
    </div>
  );
}
