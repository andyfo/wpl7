import { useState } from 'react';
import { Link } from 'react-router';
import {
  MAX_CUSTOM_PROXIES,
  PROXY_HEADERS,
  SCAN_ON_FINDING_INFO,
  scanOnFindingModes,
  trustedProxiesSchema,
  type ProxyHeader,
  type ScanOnFinding,
  type TrustedProxiesSetting,
} from '../../../../shared/security';
import { Button, Card, Field, Toggle, inputClass } from '../ui';

export interface ScanSettings {
  scanEnabled: boolean;
  scanSignatures: boolean;
  scanIntervalHours: number;
  scanOnFinding: ScanOnFinding;
  scanMemoryMb: number;
  scanTimeoutMin: number;
  scanQuarantineKeepDays: number;
}

/** The fleet's malware scan settings; a site can say otherwise on its Security tab. */
export function MalwareScanSettingsCard({ s, set }: { s: ScanSettings; set: <K extends keyof ScanSettings>(key: K, value: ScanSettings[K]) => void }) {
  return (
    <Card title="Malware scans" id="security">
      <div className="space-y-4">
        <Toggle
          checked={s.scanEnabled}
          onChange={(v) => set('scanEnabled', v)}
          label={
            <span>
              Scan every site
              <span className="block text-xs text-neutral-500">A site can be switched on or off on its own Security tab.</span>
            </span>
          }
        />
        <Toggle
          checked={s.scanSignatures}
          onChange={(v) => set('scanSignatures', v)}
          label={
            <span>
              Look for known malware with AMWScan&rsquo;s signatures
              <span className="block text-xs text-neutral-500">
                Off: only the check against wordpress.org&rsquo;s published checksums, and for PHP in uploads.
              </span>
            </span>
          }
        />
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="Scan each site every (hours)" width="sm">
            <input className={inputClass} type="number" min={1} max={720} value={s.scanIntervalHours} onChange={(e) => set('scanIntervalHours', Number(e.target.value))} />
          </Field>
          <Field label="On a finding" hint={SCAN_ON_FINDING_INFO[s.scanOnFinding].description}>
            <select className={inputClass} value={s.scanOnFinding} onChange={(e) => set('scanOnFinding', e.target.value as ScanOnFinding)}>
              {scanOnFindingModes.map((m) => (
                <option key={m} value={m}>
                  {SCAN_ON_FINDING_INFO[m].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Memory per scan (MB)" hint="The scanner runs in a container of its own, capped at this." width="sm">
            <input className={inputClass} type="number" min={256} max={4096} step={128} value={s.scanMemoryMb} onChange={(e) => set('scanMemoryMb', Number(e.target.value))} />
          </Field>
          <Field label="Time per scan (minutes)" hint="A scan still going after this is stopped and shown as incomplete." width="sm">
            <input className={inputClass} type="number" min={5} max={240} value={s.scanTimeoutMin} onChange={(e) => set('scanTimeoutMin', Number(e.target.value))} />
          </Field>
          <Field label="Keep quarantined files (days)" hint="0 keeps them until someone deletes them." width="sm">
            <input className={inputClass} type="number" min={0} max={3650} value={s.scanQuarantineKeepDays} onChange={(e) => set('scanQuarantineKeepDays', Number(e.target.value))} />
          </Field>
        </div>
        <p className="measure text-xs text-neutral-500">
          At most three scans run at a time across all servers, one per server, and none on a server using more than 90% of its memory. What they
          found is on <Link className="underline" to="/sites/security">Sites → Security</Link>. New serious findings are emailed to the alert address -
          at most once every six hours per site.
        </p>
      </div>
    </Card>
  );
}

const rangesOf = (text: string) => text.split('\n').map((r) => r.trim()).filter(Boolean);

/**
 * One address or range per line. The text stays as typed - a line just begun, a blank one -
 * while the ranges in it go up with every keystroke; it is tidied when the field is left.
 */
function RangesField({ ranges, onChange }: { ranges: string[]; onChange: (ranges: string[]) => void }) {
  const [text, setText] = useState(() => ranges.join('\n'));
  // Ranges that changed some other way - the settings loaded again, a proxy above removed - win.
  const shown = rangesOf(text).join('\n') === ranges.join('\n') ? text : ranges.join('\n');
  return (
    <textarea
      className={`${inputClass} font-mono text-xs`}
      rows={3}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        onChange(rangesOf(e.target.value));
      }}
      onBlur={() => setText(ranges.join('\n'))}
    />
  );
}

/** Why a trusted-proxies value would be refused, or null. */
export function trustedProxiesProblem(value: TrustedProxiesSetting): string | null {
  const res = trustedProxiesSchema.safeParse(value);
  return res.success ? null : (res.error.issues[0]?.message ?? 'Not valid');
}

/**
 * Proxies whose header names the visitor. Believed only from the proxy's own addresses, so a
 * header sent by anyone else changes nothing.
 */
export function TrustedProxiesCard({ value, onChange }: { value: TrustedProxiesSetting; onChange: (next: TrustedProxiesSetting) => void }) {
  const problem = trustedProxiesProblem(value);
  const setProxy = (i: number, next: TrustedProxiesSetting['custom'][number]) => onChange({ ...value, custom: value.custom.map((p, j) => (j === i ? next : p)) });
  return (
    <Card title="Trusted proxies" id="proxies">
      <div className="space-y-4">
        <p className="measure text-sm text-neutral-600">
          A site behind a CDN or a load balancer sees the proxy&rsquo;s address, not the visitor&rsquo;s. For the proxies below, the visitor&rsquo;s own
          address is read from the header the proxy sends - but only when the connection itself comes from that proxy. Visitor statistics, limits and
          blocked addresses all use it.
        </p>
        <Toggle
          checked={value.cloudflare}
          onChange={(cloudflare) => onChange({ ...value, cloudflare })}
          label={
            <span>
              Cloudflare
              <span className="block text-xs text-neutral-500">Its published ranges, kept current by the panel. Harmless on a site that is not behind it.</span>
            </span>
          }
        />
        {value.custom.map((p, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-neutral-200 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name" width="sm">
                <input className={inputClass} value={p.name} maxLength={40} onChange={(e) => setProxy(i, { ...p, name: e.target.value })} />
              </Field>
              <Field label="Visitor header" width="sm">
                <select className={inputClass} value={p.header} onChange={(e) => setProxy(i, { ...p, header: e.target.value as ProxyHeader })}>
                  {PROXY_HEADERS.map((h) => (
                    <option key={h}>{h}</option>
                  ))}
                </select>
              </Field>
              <Button small variant="ghost" onClick={() => onChange({ ...value, custom: value.custom.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
            <Field label="Addresses it connects from, one per line" width="lg">
              <RangesField ranges={p.ranges} onChange={(ranges) => setProxy(i, { ...p, ranges })} />
            </Field>
          </div>
        ))}
        {value.custom.length < MAX_CUSTOM_PROXIES && (
          <Button small variant="secondary" onClick={() => onChange({ ...value, custom: [...value.custom, { name: '', ranges: [], header: 'True-Client-Ip' }] })}>
            Add a proxy
          </Button>
        )}
        {problem && <p className="text-xs text-red-700">{problem}</p>}
        <p className="text-xs text-neutral-500">A proxy that only sends X-Forwarded-For cannot be trusted this way: anyone can send that header.</p>
      </div>
    </Card>
  );
}
