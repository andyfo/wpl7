import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMeta } from '../api/hooks';
import { Button, Card, ErrorNote, Field, inputClass, Tabs, Toggle } from '../components/ui';
import { CronField } from '../components/CronField';
import { LocaleSelect } from '../components/LocaleSelect';
import { UpdatesCard } from '../components/UpdatesCard';
import { DnsTab } from '../components/settings/DnsTab';
import { cronPatternError } from '../lib/cron';
import { MalwareScanSettingsCard, TrustedProxiesCard, trustedProxiesProblem } from '../components/security/SettingsCards';
import type { ScanOnFinding, TrustedProxiesSetting } from '../../../shared/security';
import type { MetaDto } from '../../../shared/types';

interface PanelSettings {
  backupCron: string;
  backupRetention: number;
  monitorUptimeIntervalSec: number;
  monitorStatsIntervalSec: number;
  monitorDuIntervalMin: number;
  defaultPhpVersion: string;
  defaultLocale: string;
  defaultAdminEmail: string;
  phpVersions: string[];
  defaultServerId: number;
  mailRetentionDays: number;
  trafficRetentionDays: number;
  trafficIpRetentionDays: number;
  trafficStoreIps: boolean;
  mailAlertPerSitePerHour: number;
  mailSuspendPerSitePerHour: number;
  alertEmail: string;
  siteCpuLimit: number;
  siteMemoryLimitMb: number;
  sitePidsLimit: number;
  wpScanIntervalHours: number;
  vulnerabilityFeed: boolean;
  ftpEnabled: boolean;
  ftpSftpPort: number;
  ftpOfferFtps: boolean;
  ftpPort: number;
  ftpPassivePortStart: number;
  ftpPassivePortEnd: number;
  securityTrustedProxies: TrustedProxiesSetting;
  scanEnabled: boolean;
  scanSignatures: boolean;
  scanIntervalHours: number;
  scanOnFinding: ScanOnFinding;
  scanMemoryMb: number;
  scanTimeoutMin: number;
  scanQuarantineKeepDays: number;
}

const TABS = [
  { id: 'sites', label: 'Sites' },
  { id: 'backups', label: 'Backups' },
  { id: 'security', label: 'Security' },
  { id: 'mail', label: 'Mail' },
  { id: 'dns', label: 'DNS' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'updates', label: 'Updates' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const isTab = (id: string | null): id is TabId => TABS.some((t) => t.id === id);

/**
 * The tab each card is on. A link to a card - /settings#limits from the Schedules page, the
 * sidebar's /settings#updates - opens its tab, and lands on it.
 */
const CARD_TAB: Record<string, TabId> = {
  defaults: 'sites',
  limits: 'sites',
  ftp: 'sites',
  backups: 'backups',
  wordpress: 'security',
  security: 'security',
  proxies: 'security',
  mail: 'mail',
  cloudflare: 'dns',
  wildcard: 'dns',
  monitoring: 'monitoring',
  statistics: 'monitoring',
  updates: 'updates',
};

/** The tab each setting is changed on: what says which tabs hold changes not saved yet. */
const SETTING_TAB: Record<keyof PanelSettings, TabId> = {
  defaultPhpVersion: 'sites',
  defaultLocale: 'sites',
  defaultAdminEmail: 'sites',
  phpVersions: 'sites',
  defaultServerId: 'sites',
  siteCpuLimit: 'sites',
  siteMemoryLimitMb: 'sites',
  sitePidsLimit: 'sites',
  ftpEnabled: 'sites',
  ftpSftpPort: 'sites',
  ftpOfferFtps: 'sites',
  ftpPort: 'sites',
  ftpPassivePortStart: 'sites',
  ftpPassivePortEnd: 'sites',
  backupCron: 'backups',
  backupRetention: 'backups',
  wpScanIntervalHours: 'security',
  vulnerabilityFeed: 'security',
  securityTrustedProxies: 'security',
  scanEnabled: 'security',
  scanSignatures: 'security',
  scanIntervalHours: 'security',
  scanOnFinding: 'security',
  scanMemoryMb: 'security',
  scanTimeoutMin: 'security',
  scanQuarantineKeepDays: 'security',
  mailRetentionDays: 'mail',
  mailAlertPerSitePerHour: 'mail',
  mailSuspendPerSitePerHour: 'mail',
  alertEmail: 'mail',
  monitorUptimeIntervalSec: 'monitoring',
  monitorStatsIntervalSec: 'monitoring',
  monitorDuIntervalMin: 'monitoring',
  trafficRetentionDays: 'monitoring',
  trafficIpRetentionDays: 'monitoring',
  trafficStoreIps: 'monitoring',
};

type SetSetting = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => void;

interface TabProps {
  s: PanelSettings;
  set: SetSetting;
  meta: MetaDto | undefined;
}

export function Settings() {
  const qc = useQueryClient();
  const meta = useMeta();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: PanelSettings }>('/api/settings').then((r) => r.settings),
  });
  // The page's, not a tab's: a change not saved yet outlives a look at another tab, and the
  // one Save takes the changes on every tab.
  const [patch, setPatch] = useState<Partial<PanelSettings>>({});
  const [saveError, setSaveError] = useState<unknown>(null);
  // What the last save did; the save queued jobs that bring existing sites to new container limits.
  const [saved, setSaved] = useState<{ applying: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const requested = params.get('tab');
  const tab: TabId = isTab(requested) ? requested : (CARD_TAB[location.hash.slice(1)] ?? 'sites');
  const setTab = (id: string) => setParams(id === 'sites' ? {} : { tab: id });

  // Links land on a card. The cards only exist once the settings have loaded, which is later
  // than the browser looks for the anchor.
  const scrolledTo = useRef<string | null>(null);
  const loaded = settings.data !== undefined;
  useEffect(() => {
    if (!loaded || !location.hash || scrolledTo.current === location.hash) return;
    let id = location.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape in a hand-typed URL: look for it as written.
    }
    const el = document.getElementById(id);
    if (!el) return;
    scrolledTo.current = location.hash;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loaded, location.hash, tab]);

  // "Saved." is a moment, not a state; the jobs link stays long enough to be followed.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), saved.applying ? 15_000 : 5_000);
    return () => clearTimeout(timer);
  }, [saved]);

  if (!settings.data) {
    return (
      <div className="space-y-6">
        <h1 className="page-title">Settings</h1>
        <ErrorNote error={settings.error} />
      </div>
    );
  }
  const stored = settings.data;
  const s = { ...stored, ...patch };
  // A value put back to what is saved is no change: the bar goes when nothing differs.
  const set: SetSetting = (key, value) => {
    setSaved(null);
    setPatch((p) => {
      const next = { ...p, [key]: value };
      if (JSON.stringify(value) === JSON.stringify(stored[key])) delete next[key];
      return next;
    });
  };
  // The panel would reject it anyway; refusing here keeps the rest of the form saveable.
  const cronProblem = cronPatternError(s.backupCron, meta.data?.timezone);
  const proxiesProblem = s.securityTrustedProxies ? trustedProxiesProblem(s.securityTrustedProxies) : null;
  const dirtyTabs = new Set(Object.keys(patch).map((key) => SETTING_TAB[key as keyof PanelSettings]));
  const dirty = dirtyTabs.size > 0;
  const canSave = dirty && cronProblem === null && proxiesProblem === null && !saving;

  const save = async () => {
    setSaveError(null);
    setSaved(null);
    setSaving(true);
    try {
      const res = await api<{ jobs: unknown[] }>('/api/settings', { method: 'PUT', body: patch });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      // Other pages read the site defaults and the backup schedule from meta: the New Site
      // wizard opened next has to start from what was just saved.
      void qc.invalidateQueries({ queryKey: ['meta'] });
      setPatch({});
      setSaved({ applying: res.jobs.length > 0 });
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const props: TabProps = { s, set, meta: meta.data };
  const formTab = tab !== 'dns' && tab !== 'updates';

  return (
    <div className="space-y-6">
      <h1 className="page-title">Settings</h1>

      <Tabs
        tabs={TABS.map((t) => ({
          id: t.id,
          label: dirtyTabs.has(t.id) ? (
            <>
              {t.label}
              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" title="Changes not saved yet" />
            </>
          ) : (
            t.label
          ),
        }))}
        active={tab}
        onChange={setTab}
      />

      {formTab && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save();
          }}
        >
          {/* Half-width cards that pair up on a wide screen and stack on a narrow one. */}
          <div className="grid gap-6 xl:grid-cols-2">
            {tab === 'sites' && <SitesTab {...props} />}
            {tab === 'backups' && <BackupsTab {...props} />}
            {tab === 'security' && <SecurityTab {...props} />}
            {tab === 'mail' && <MailTab {...props} />}
            {tab === 'monitoring' && <MonitoringTab {...props} />}
          </div>
        </form>
      )}
      {tab === 'dns' && <DnsTab />}
      {/* Update is an action, not a setting to save, and /settings#updates has to land on it. */}
      {tab === 'updates' && (
        <div id="updates">
          <UpdatesCard />
        </div>
      )}

      {(dirty || saved || saveError !== null) && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-neutral-200 bg-surface p-3 shadow-lg">
          <span className="mr-auto text-sm text-neutral-600">
            {dirty ? (
              <>Changes not saved yet: {listOf([...dirtyTabs].map((id) => TABS.find((t) => t.id === id)!.label))}.</>
            ) : saved ? (
              <span className="text-emerald-700">
                Saved.
                {saved.applying && (
                  <>
                    {' '}
                    Applying the new limits to every site —{' '}
                    <Link to="/jobs" className="underline">
                      see Jobs
                    </Link>
                    .
                  </>
                )}
              </span>
            ) : null}
          </span>
          {cronProblem && <span className="text-sm text-red-700">Fix the backup schedule first.</span>}
          {proxiesProblem && <span className="text-sm text-red-700">Fix the trusted proxies first.</span>}
          <ErrorNote error={saveError} />
          {dirty && (
            <>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setPatch({});
                  setSaveError(null);
                }}
              >
                Discard
              </Button>
              <Button disabled={!canSave} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save settings'}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "Sites", "Sites and Mail", "Sites, Mail and DNS". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Sites: what a new site starts with, what any site may use, and FTP

function SitesTab({ s, set, meta }: TabProps) {
  return (
    <>
      <Card title="Site defaults" id="defaults">
        <div className="space-y-4">
          <Field label="Default PHP version">
            <select
              className={inputClass}
              value={s.defaultPhpVersion}
              onChange={(e) => set('defaultPhpVersion', e.target.value)}
            >
              {s.phpVersions.map((v) => (
                <option key={v} value={v}>PHP {v}</option>
              ))}
            </select>
          </Field>
          <Field label="Default language" hint="Preselected in the new-site wizard.">
            <LocaleSelect value={s.defaultLocale} onChange={(code) => set('defaultLocale', code)} />
          </Field>
          <Field
            label="Default admin email"
            hint="Prefilled in the new-site wizard, and used when an API request leaves it out."
          >
            <input className={inputClass} type="email" placeholder="you@example.com" value={s.defaultAdminEmail ?? ''}
              onChange={(e) => set('defaultAdminEmail', e.target.value)} />
          </Field>
          {(meta?.multiServer ?? false) && (
            <Field label="Default server" hint="Where new sites deploy unless picked explicitly.">
              <select
                className={inputClass}
                value={s.defaultServerId}
                onChange={(e) => set('defaultServerId', Number(e.target.value))}
              >
                {(meta?.servers ?? []).map((srv) => (
                  <option key={srv.id} value={srv.id}>
                    {srv.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </Card>

      <Card title="Site container limits" id="limits">
        <p className="mb-4 text-sm text-neutral-600">
          Saved changes reach every site right away, without a restart — except lifting the CPU cap (0),
          which restarts each site once.
        </p>
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="CPU cores per site" hint="Fractions allowed (0.5 = half a core). 0 = uncapped.">
            <input className={inputClass} type="number" min={0} max={64} step={0.5} value={s.siteCpuLimit}
              onChange={(e) => set('siteCpuLimit', Number(e.target.value))} />
          </Field>
          <Field label="Memory per site (MB)" hint="The container is killed if it exceeds this.">
            <input className={inputClass} type="number" min={128} max={65536} step={128} value={s.siteMemoryLimitMb}
              onChange={(e) => set('siteMemoryLimitMb', Number(e.target.value))} />
          </Field>
          <Field label="Processes per site" hint="Apache needs a few hundred. 0 = uncapped.">
            <input className={inputClass} type="number" min={0} max={100000} step={64} value={s.sitePidsLimit}
              onChange={(e) => set('sitePidsLimit', Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      <Card title="FTP & SFTP" id="ftp">
        <Toggle
          checked={s.ftpEnabled}
          onChange={(v) => set('ftpEnabled', v)}
          label="Allow FTP and SFTP logins (each site's FTP tab)"
        />
        <p className="mt-1 text-xs text-neutral-500">
          Off takes FTP off every server: at once where the panel can reach it, and as soon as it can
          otherwise - each site&apos;s FTP tab says when. The logins are kept, and work again when this is back
          on.
        </p>
        <div className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="SFTP port" hint="Not 22: that is the server's own SSH, which the panel uses.">
            <input className={inputClass} type="number" min={1} max={65535} value={s.ftpSftpPort}
              onChange={(e) => set('ftpSftpPort', Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-4">
          <Toggle
            checked={s.ftpOfferFtps}
            onChange={(v) => set('ftpOfferFtps', v)}
            label="Also offer FTP (explicit TLS; plain FTP is always refused)"
          />
        </div>
        <div className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-3">
          <Field label="FTP port">
            <input className={inputClass} type="number" min={1} max={65535} value={s.ftpPort}
              disabled={!s.ftpOfferFtps}
              onChange={(e) => set('ftpPort', Number(e.target.value))} />
          </Field>
          <Field label="Passive from">
            <input className={inputClass} type="number" min={1024} max={65535} value={s.ftpPassivePortStart}
              disabled={!s.ftpOfferFtps}
              onChange={(e) => set('ftpPassivePortStart', Number(e.target.value))} />
          </Field>
          <Field label="Passive to" hint="2 to 100 ports.">
            <input className={inputClass} type="number" min={1024} max={65535} value={s.ftpPassivePortEnd}
              disabled={!s.ftpOfferFtps}
              onChange={(e) => set('ftpPassivePortEnd', Number(e.target.value))} />
          </Field>
        </div>
        <p className="measure mt-3 text-xs text-neutral-500">
          These ports open on a server only once one of its sites has a login. Docker publishes them past the
          server&apos;s own firewall; a cloud provider&apos;s firewall in front of it has to allow them.
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Backups

function BackupsTab({ s, set, meta }: TabProps) {
  return (
    <Card title="Backups" id="backups">
      {meta?.backupsPaused && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Scheduled backups are paused, so this schedule is not running.{' '}
          <Link className="font-medium underline" to="/jobs/schedules#schedule-backups">
            Resume them on the Schedules page
          </Link>
          .
        </div>
      )}
      <div className="space-y-4">
        <CronField
          label="Schedule (cron)"
          value={s.backupCron}
          onChange={(expr) => set('backupCron', expr)}
          timezone={meta?.timezone}
        />
        <Field label="Keep last N scheduled backups per site" width="sm">
          <input
            className={inputClass}
            type="number"
            min={1}
            value={s.backupRetention}
            onChange={(e) => set('backupRetention', Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="measure mt-4 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
        Stored on each server's own disk. Locations and remote copies live under{' '}
        <Link className="underline" to="/backups/storage">Backups → Storage</Link>.
        <ul className="mt-1 space-y-0.5">
          {(meta?.backupRoots ?? []).map((row) => (
            <li key={row.serverId}>
              <span className="font-medium text-neutral-600">{row.serverName}</span>{' '}
              <code>{row.root}</code>
              {row.isDefault && <span className="text-neutral-400"> (default)</span>}
              <span className="text-neutral-400"> · {row.backups} backup(s)</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Security: what the panel learns about the sites, scans them for, and believes about visitors

function SecurityTab({ s, set }: TabProps) {
  return (
    <>
      <Card title="WordPress updates & security" id="wordpress">
        <div>
          <Field
            label="Re-check every (hours)"
            hint="Between passes the panel shows the last result."
            width="sm"
          >
            <input
              className={inputClass}
              type="number"
              min={1}
              max={168}
              value={s.wpScanIntervalHours}
              onChange={(e) => set('wpScanIntervalHours', Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Toggle
            checked={s.vulnerabilityFeed}
            onChange={(v) => set('vulnerabilityFeed', v)}
            label="Rate installed plugins and themes against known vulnerabilities"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Sends plugin and theme slugs and versions — nothing else — to{' '}
            <a
              href="https://www.wpvulnerability.net/"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-neutral-700"
            >
              wpvulnerability.net
            </a>
            , once per slug per day. Off clears the severities shown.
          </p>
        </div>
      </Card>

      <MalwareScanSettingsCard s={s} set={(key, value) => set(key, value as PanelSettings[typeof key])} />

      {s.securityTrustedProxies && (
        <TrustedProxiesCard value={s.securityTrustedProxies} onChange={(v) => set('securityTrustedProxies', v)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mail

function MailTab({ s, set }: TabProps) {
  return (
    <Card title="Mail" id="mail">
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Keep traffic history for (days)" hint="Parsed from each server's mail relay log.">
          <input className={inputClass} type="number" min={1} max={365} value={s.mailRetentionDays}
            onChange={(e) => set('mailRetentionDays', Number(e.target.value))} />
        </Field>
        <Field label="Flag a site above (messages / hour)">
          <input className={inputClass} type="number" min={10} value={s.mailAlertPerSitePerHour}
            onChange={(e) => set('mailAlertPerSitePerHour', Number(e.target.value))} />
        </Field>
        <Field
          label="Suspend a site above (messages / hour)"
          hint="0 = never. A suspended site keeps serving pages."
        >
          <input className={inputClass} type="number" min={0} value={s.mailSuspendPerSitePerHour}
            onChange={(e) => set('mailSuspendPerSitePerHour', Number(e.target.value))} />
        </Field>
        <Field
          label="Send alerts to"
          hint="Empty = log only."
        >
          <input className={inputClass} type="email" placeholder="you@example.com" value={s.alertEmail ?? ''}
            onChange={(e) => set('alertEmail', e.target.value)} />
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Monitoring: how often the panel looks, and what it keeps about visitors

function MonitoringTab({ s, set }: TabProps) {
  return (
    <>
      <Card title="Monitoring" id="monitoring">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="Uptime check (seconds)">
            <input className={inputClass} type="number" min={15} value={s.monitorUptimeIntervalSec}
              onChange={(e) => set('monitorUptimeIntervalSec', Number(e.target.value))} />
          </Field>
          <Field label="Container stats (seconds)">
            <input className={inputClass} type="number" min={15} value={s.monitorStatsIntervalSec}
              onChange={(e) => set('monitorStatsIntervalSec', Number(e.target.value))} />
          </Field>
          <Field label="Disk scan (minutes)">
            <input className={inputClass} type="number" min={5} value={s.monitorDuIntervalMin}
              onChange={(e) => set('monitorDuIntervalMin', Number(e.target.value))} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-neutral-500">Interval changes apply after a panel restart.</p>
      </Card>

      <Card title="Visitor statistics" id="statistics">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field
            label="Keep visitor statistics for (days)"
            hint="Counters, not request logs, so a long window is cheap."
          >
            <input className={inputClass} type="number" min={1} max={730} value={s.trafficRetentionDays}
              onChange={(e) => set('trafficRetentionDays', Number(e.target.value))} />
          </Field>
          <Field
            label="Keep visitor addresses for (days)"
            hint="Kept separately from the anonymous counts, and deliberately short."
          >
            <input className={inputClass} type="number" min={1} max={90} value={s.trafficIpRetentionDays}
              disabled={!s.trafficStoreIps}
              onChange={(e) => set('trafficIpRetentionDays', Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-4">
          <Toggle
            checked={s.trafficStoreIps}
            onChange={(v) => set('trafficStoreIps', v)}
            label="Record visitor addresses (Busiest addresses, per-site)"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Off deletes the addresses already stored. Counts, countries, pages and crawlers keep working.
          </p>
        </div>
      </Card>
    </>
  );
}
