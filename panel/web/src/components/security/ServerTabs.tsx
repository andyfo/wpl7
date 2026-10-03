import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  DETECTION_RULE_INFO,
  detectionRuleIds,
  type AutoBlockMode,
  type DetectionRuleId,
  type DetectionRules,
} from '../../../../shared/security';
import type { FirewallState, SecurityBlockDto, SecurityCheckDto } from '../../../../shared/types';
import { api } from '../../api/client';
import {
  checkAddress,
  useAddNeverBlock,
  useBlocks,
  useDetection,
  useFirewall,
  useFirewallSync,
  useNeverBlock,
  useRemoveNeverBlock,
  useSaveSecuritySettings,
  useUnblock,
} from '../../api/security';
import { formatDate, flagOf, timeAgo, timeUntil } from '../../lib/format';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNote, Field, Segmented, Spinner, Toggle, compactInputClass, inputClass } from '../ui';
import { BlockDialog } from './BlockDialog';

interface DetectionSettings {
  securityAutoBlock: AutoBlockMode;
  securityEnforcement: boolean;
  securityRules: DetectionRules;
  securityBlockMinutes: number;
  securityBlockMultiplier: number;
  securityBlockMaxDays: number;
  securityMaxActiveBlocks: number;
  securityHistoryDays: number;
}

const useSecuritySettings = () =>
  useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: DetectionSettings }>('/api/settings').then((r) => r.settings),
  });

function blockReason(b: SecurityBlockDto): string {
  if (b.rule && b.evidence) {
    return `${DETECTION_RULE_INFO[b.rule].label}: ${b.evidence.count} ${DETECTION_RULE_INFO[b.rule].unit} in ${b.evidence.windowMin} min`;
  }
  return b.reason;
}

export function BlockedTab() {
  const [state, setState] = useState<'active' | 'history'>('active');
  const [q, setQ] = useState('');
  const blocks = useBlocks(state, q.trim());
  const unblock = useUnblock();
  const [adding, setAdding] = useState(false);
  const [lifting, setLifting] = useState<SecurityBlockDto | null>(null);
  const list = blocks.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Which blocks"
          options={[
            { id: 'active', label: `In force${list && state === 'active' ? ` (${list.activeCount})` : ''}` },
            { id: 'history', label: 'History' },
          ]}
          value={state}
          onChange={setState}
        />
        <input className={`${inputClass} max-w-56`} type="search" placeholder="Find an address" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto">
          <Button onClick={() => setAdding(true)}>Block an address</Button>
        </div>
      </div>
      <ErrorNote error={blocks.error ?? unblock.error} />
      {list && list.activeCount >= list.maxActive * 0.9 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {list.activeCount.toLocaleString()} of at most {list.maxActive.toLocaleString()} blocks are in force. Past that the detector stops adding more.
        </p>
      )}
      {!list ? (
        <Spinner />
      ) : list.items.length === 0 ? (
        <EmptyState>{state === 'active' ? 'No address is blocked.' : 'No block has ended yet.'}</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Address</th>
                <th className="pb-2">Why</th>
                <th className="pb-2">Seen on</th>
                <th className="pb-2">{state === 'active' ? 'Until' : 'Ended'}</th>
                <th className="pb-2 pr-3 text-right">Refused</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {list.items.map((b) => (
                <tr key={b.id} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs">{b.address}</span>
                    {b.country && <span className="ml-1">{flagOf(b.country)}</span>}
                    <div className="text-[11px] text-neutral-400">
                      {b.source === 'detector' ? 'detected' : `by ${b.createdBy ?? b.source}`} {timeAgo(b.createdAt)}
                      {b.strike > 1 && ` · repeat ${b.strike}`}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    <div>{blockReason(b)}</div>
                    {b.note && <div className="text-neutral-500">{b.note}</div>}
                    {b.evidence?.samplePaths.length ? (
                      <div className="max-w-sm truncate font-mono text-[11px] text-neutral-400" title={b.evidence.samplePaths.join('\n')}>
                        {b.evidence.samplePaths.join(' ')}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-xs text-neutral-600">
                    {b.siteSlug ? <Link className="underline decoration-neutral-300" to={`/sites/${b.siteSlug}?tab=security`}>{b.siteSlug}</Link> : '–'}
                    {b.serverName && <div className="text-neutral-400">{b.serverName}</div>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-neutral-600">
                    {state === 'active'
                      ? b.expiresAt
                        ? timeUntil(b.expiresAt)
                        : 'until lifted'
                      : `${formatDate(b.endedAt)} (${b.endReason === 'lifted' ? `lifted${b.endedBy ? ` by ${b.endedBy}` : ''}` : b.endReason})`}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-xs">{b.hits > 0 ? b.hits.toLocaleString() : '–'}</td>
                  <td className="py-2 text-right">
                    {b.active && (
                      <Button small variant="secondary" onClick={() => setLifting(b)}>
                        Unblock
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.total > list.items.length && <p className="mt-2 text-xs text-neutral-500">The newest {list.items.length} of {list.total.toLocaleString()}.</p>}
        </div>
      )}
      <p className="text-xs text-neutral-500">
        The network layer drops a blocked visitor&rsquo;s connections without counting them; &ldquo;Refused&rdquo; counts the requests Traefik answered 403,
        behind a trusted proxy.
      </p>
      {adding && <BlockDialog onClose={() => setAdding(false)} />}
      {lifting && (
        <ConfirmDialog
          title="Unblock"
          confirmLabel="Unblock"
          message={
            <>
              Let <code>{lifting.address}</code> reach every site again, within a minute. A block lifted by hand does not count as a repeat.
            </>
          }
          onConfirm={() => unblock.mutate(lifting.id)}
          onClose={() => setLifting(null)}
        />
      )}
    </div>
  );
}

export function DetectionTab() {
  const settings = useSecuritySettings();
  const detection = useDetection();
  const save = useSaveSecuritySettings();
  const [patch, setPatch] = useState<Partial<DetectionSettings>>({});
  useEffect(() => setPatch({}), [settings.data]);
  if (!settings.data) return <Spinner />;
  const s = { ...settings.data, ...patch };
  const setRule = (id: DetectionRuleId, next: Partial<DetectionRules[DetectionRuleId]>) =>
    setPatch({ ...patch, securityRules: { ...s.securityRules, [id]: { ...s.securityRules[id], ...next } } });
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v)) || min));
  const dirty = Object.keys(patch).length > 0;

  return (
    <div className="space-y-6">
      <Card title="Automatic blocking">
        <div className="space-y-4">
          <Segmented
            label="Automatic blocking"
            options={[
              { id: 'on', label: 'On' },
              { id: 'observe', label: 'Observe', title: 'Record what it would block, and block nothing' },
              { id: 'off', label: 'Off' },
            ]}
            value={s.securityAutoBlock}
            onChange={(securityAutoBlock) => setPatch({ ...patch, securityAutoBlock })}
          />
          <p className="measure text-sm text-neutral-600">
            {s.securityAutoBlock === 'on'
              ? 'An address that crosses a line below is blocked on every server - an hour the first time, four times longer each time within 30 days.'
              : s.securityAutoBlock === 'observe'
                ? 'Addresses are watched and what would have been blocked is written down below, but nothing is blocked.'
                : 'Nothing is watched. Blocks made by hand still work.'}{' '}
            Never blocked: private addresses, the fleet&rsquo;s servers, trusted proxies, Jetpack, AI assistants (ChatGPT, Claude, Gemini, Perplexity,
            Mistral, DuckDuckGo) by the addresses they publish, the never-block list and every address an admin used the panel from in the last 30
            days. A search engine&rsquo;s crawler is checked by reverse DNS first.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Rule</th>
                <th className="pb-2">Blocks at</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {detectionRuleIds.map((id) => (
                <tr key={id} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{DETECTION_RULE_INFO[id].label}</div>
                    <div className="measure text-xs text-neutral-500">{DETECTION_RULE_INFO[id].counts}</div>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    <div className="flex items-center gap-2 text-xs text-neutral-600">
                      <input
                        aria-label={`${DETECTION_RULE_INFO[id].label}: how many`}
                        className={`${compactInputClass} w-24`}
                        type="number"
                        value={s.securityRules[id].threshold}
                        onChange={(e) => setRule(id, { threshold: num(e.target.value, 2, 100_000) })}
                      />
                      {DETECTION_RULE_INFO[id].unit} in
                      <input
                        aria-label={`${DETECTION_RULE_INFO[id].label}: minutes`}
                        className={`${compactInputClass} w-20`}
                        type="number"
                        value={s.securityRules[id].windowMin}
                        onChange={(e) => setRule(id, { windowMin: num(e.target.value, 1, 1440) })}
                      />
                      min
                    </div>
                  </td>
                  <td className="py-2 text-right">
                    <Toggle checked={s.securityRules[id].enabled} onChange={(enabled) => setRule(id, { enabled })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="First block, minutes" width="sm">
              <input className={inputClass} type="number" value={s.securityBlockMinutes} onChange={(e) => setPatch({ ...patch, securityBlockMinutes: num(e.target.value, 5, 10080) })} />
            </Field>
            <Field label="Each repeat, times as long" width="sm">
              <input className={inputClass} type="number" value={s.securityBlockMultiplier} onChange={(e) => setPatch({ ...patch, securityBlockMultiplier: num(e.target.value, 1, 10) })} />
            </Field>
            <Field label="Longest block, days" width="sm">
              <input className={inputClass} type="number" value={s.securityBlockMaxDays} onChange={(e) => setPatch({ ...patch, securityBlockMaxDays: num(e.target.value, 1, 365) })} />
            </Field>
            <Field label="Blocks in force, at most" width="sm">
              <input className={inputClass} type="number" value={s.securityMaxActiveBlocks} onChange={(e) => setPatch({ ...patch, securityMaxActiveBlocks: num(e.target.value, 100, 50_000) })} />
            </Field>
          </div>
          {dirty && (
            <div className="flex items-center justify-end gap-3">
              <ErrorNote error={save.error} />
              <Button variant="secondary" onClick={() => setPatch({})}>
                Discard
              </Button>
              <Button disabled={save.isPending} onClick={() => save.mutate(patch)}>
                Save
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="What the detector decided"
        action={detection.data && <span className="text-xs text-neutral-400">watching {detection.data.tracked.toLocaleString()} addresses</span>}
      >
        {!detection.data ? (
          <Spinner />
        ) : detection.data.decisions.length === 0 ? (
          <EmptyState>Nothing yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {detection.data.decisions.map((d, i) => (
                <tr key={`${d.at}-${i}`} className="border-t border-neutral-100 align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-neutral-500">{timeAgo(d.at)}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{d.address}</td>
                  <td className="py-1.5 pr-3 text-xs">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-[11px] ${
                        d.action === 'blocked' ? 'bg-red-100 text-red-800' : d.action === 'observed' ? 'bg-sky-100 text-sky-800' : 'bg-neutral-100 text-neutral-600'
                      }`}
                    >
                      {d.action === 'blocked' ? 'blocked' : d.action === 'observed' ? 'would block' : 'not blocked'}
                    </span>
                    {DETECTION_RULE_INFO[d.rule].label}: {d.action === 'skipped' ? d.reason.replace(/^Not blocked: /, '') : d.reason}
                  </td>
                  <td className="py-1.5 text-xs text-neutral-500">{d.sites.slice(0, 3).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function NeverBlockTab() {
  const list = useNeverBlock();
  const add = useAddNeverBlock();
  const remove = useRemoveNeverBlock();
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [probe, setProbe] = useState('');
  const [checked, setChecked] = useState<SecurityCheckDto | null>(null);
  return (
    <div className="space-y-6">
      <Card title="Never block">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ address: address.trim(), ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: () => (setAddress(''), setNote('')) });
          }}
        >
          <Field label="Address or range" width="sm">
            <input className={`${inputClass} font-mono`} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.0.2.0/24" />
          </Field>
          <Field label="Note" width="md">
            <input className={inputClass} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="The office" />
          </Field>
          <Button type="submit" disabled={!address.trim() || add.isPending}>
            Add
          </Button>
        </form>
        <p className="mt-2 text-xs text-neutral-500">Blocks on an address added here are lifted, and it is neither limited by the detector nor blocked by hand.</p>
        <ErrorNote error={add.error ?? remove.error ?? list.error} />
        {list.data && list.data.items.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <tbody>
              {list.data.items.map((n) => (
                <tr key={n.id} className="border-t border-neutral-100">
                  <td className="py-2 pr-3 font-mono text-xs">{n.address}</td>
                  <td className="py-2 pr-3 text-xs text-neutral-600">{n.note}</td>
                  <td className="py-2 pr-3 text-xs text-neutral-400">
                    {n.createdBy && `by ${n.createdBy} `}
                    {timeAgo(n.createdAt)}
                  </td>
                  <td className="py-2 text-right">
                    <Button small variant="ghost" onClick={() => remove.mutate(n.id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Where admins use the panel from">
        <p className="mb-3 text-xs text-neutral-500">Never blocked for 30 days after they were last used, so nobody locks themselves out.</p>
        {list.data && list.data.admins.length === 0 ? (
          <EmptyState>None recorded yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {(list.data?.admins ?? []).map((a) => (
                <tr key={`${a.address}-${a.username}`} className="border-t border-neutral-100">
                  <td className="py-1.5 pr-3 font-mono text-xs">{a.address}</td>
                  <td className="py-1.5 pr-3 text-xs">{a.username}</td>
                  <td className="py-1.5 text-xs text-neutral-500">last {timeAgo(a.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Check an address">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void checkAddress(probe.trim()).then(setChecked);
          }}
        >
          <Field label="Address" width="sm">
            <input className={`${inputClass} font-mono`} value={probe} onChange={(e) => setProbe(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!probe.trim()}>
            Check
          </Button>
        </form>
        {checked && (
          <p className="mt-3 text-sm text-neutral-700">
            {!checked.valid
              ? checked.problem
              : checked.blockedBy
                ? `${checked.address} is blocked (${blockReason(checked.blockedBy)}).`
                : checked.protectedBecause
                  ? `${checked.address} is never blocked: ${checked.protectedBecause}.`
                  : `${checked.address} is not blocked, and could be.`}
            {checked.country && ` ${flagOf(checked.country)} ${checked.country}`}
          </p>
        )}
      </Card>
    </div>
  );
}

const FIREWALL_STATE: Record<FirewallState, { label: string; tone: string; help?: string }> = {
  ok: { label: 'In force', tone: 'bg-emerald-100 text-emerald-800' },
  'http-only': {
    label: 'HTTP only',
    tone: 'bg-amber-100 text-amber-800',
    help: 'The network layer could not be loaded, so Traefik refuses direct visitors instead - at most 2,000 of them.',
  },
  off: { label: 'Off on the server', tone: 'bg-neutral-200 text-neutral-700', help: 'Switched off there with "sudo wpl7-firewall off"; "sudo wpl7-firewall on" brings it back.' },
  'not-installed': {
    label: 'Not installed',
    tone: 'bg-amber-100 text-amber-800',
    help: 'The server has not been set up since Security arrived. Run provision/setup.sh on it (Update does this for workers).',
  },
  unreachable: { label: 'Unreachable', tone: 'bg-red-100 text-red-800' },
  error: { label: 'Error', tone: 'bg-red-100 text-red-800' },
  unknown: { label: 'Not checked yet', tone: 'bg-neutral-100 text-neutral-500' },
};

export function EnforcementTab() {
  const firewall = useFirewall();
  const sync = useFirewallSync();
  const settings = useSecuritySettings();
  const save = useSaveSecuritySettings();
  const f = firewall.data;
  return (
    <div className="space-y-6">
      <Card title="Blocks in force">
        {settings.data && (
          <Toggle
            checked={settings.data.securityEnforcement !== false}
            busy={save.isPending}
            onChange={(securityEnforcement) => save.mutate({ securityEnforcement })}
            label={
              <span>
                Blocked addresses reach the servers
                <span className="measure block text-xs text-neutral-500">
                  Off: the list is kept, and nothing on it is refused anywhere - the quickest way back if blocking ever gets in the way.
                </span>
              </span>
            }
          />
        )}
        <ErrorNote error={save.error} />
      </Card>
      <Card
        title="Servers"
        action={
          <Button small variant="secondary" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Loading…' : 'Load on every server now'}
          </Button>
        }
      >
        <ErrorNote error={firewall.error ?? sync.error} />
        {!f ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Server</th>
                <th className="pb-2">Network layer</th>
                <th className="pb-2 pr-3 text-right">Direct</th>
                <th className="pb-2 text-right">Behind a proxy</th>
              </tr>
            </thead>
            <tbody>
              {f.servers.map((s) => {
                const st = FIREWALL_STATE[s.state];
                return (
                  <tr key={s.serverId} className="border-t border-neutral-100 align-top">
                    <td className="py-2 pr-3 font-medium">{s.serverName}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${st.tone}`}>{st.label}</span>
                      {s.appliedAt && <span className="ml-2 text-xs text-neutral-400">loaded {timeAgo(s.appliedAt)}</span>}
                      {(st.help || s.message) && <div className="measure mt-1 text-xs text-neutral-500">{s.message ?? st.help}</div>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-xs">
                      {s.state === 'ok' ? s.networkEntries.toLocaleString() : s.httpDirect.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-xs">
                      {s.httpProxied.toLocaleString()}
                      {s.httpSkipped > 0 && <div className="text-amber-700">{s.httpSkipped} left out</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          Direct visitors are dropped by the server&rsquo;s own firewall, on ports 80 and 443 only - SSH and FTP keep their own protection. Visitors
          behind a trusted proxy are refused by Traefik, which reads the proxy&rsquo;s header.
        </p>
      </Card>
    </div>
  );
}
