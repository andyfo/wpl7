// @docs automations/custom-jobs
import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ScheduleDto, SiteSummary } from '../../../../shared/types';
import { jobCategories, wpRestMethods, type WpRestMethod } from '../../../../shared/schemas';
import { JOB_CATEGORY_LABELS } from '../../../../shared/jobTypes';
import {
  SCHEDULE_ACTION_INFO,
  scheduleActions,
  scheduleCreateBody,
  wpUpdateParams,
  type ScheduleAction,
  type ScheduleTarget,
  type WpUpdatePolicy,
} from '../../../../shared/scheduleActions';
import { DEFAULT_CRON, describeCron } from '../../../../shared/cron';
import { api } from '../../api/client';
import { useMeta, useSites } from '../../api/hooks';
import { Button, Field, inputClass, Modal, Segmented, Toggle } from '../ui';
import { ActionDialog } from '../files/common';
import { CronField } from '../CronField';
import { BulkRunOptions } from '../wp/BulkRunOptions';
import { cliArgsProblem, formatCliArgs, tokenizeCli } from '../../lib/cliArgs';
import { cronPatternError, formatRunTime } from '../../lib/cron';
import {
  cronScheduleProblem,
  parseRestBody,
  restRouteProblem,
  suggestName,
  targetText,
  type ServerName,
} from '../../lib/schedules';

/** How the editor offers a target. "One site" and "Several sites" are both a `sites` target. */
type Mode = 'site' | 'sites' | 'all' | 'server' | 'panel';

const MODE_LABELS: Record<Mode, string> = {
  site: 'One site',
  sites: 'Several sites',
  all: 'All running sites',
  server: 'Server',
  panel: 'Panel',
};

const modesFor = (action: ScheduleAction): Mode[] =>
  SCHEDULE_ACTION_INFO[action].targets.flatMap((kind): Mode[] => (kind === 'sites' ? ['site', 'sites'] : [kind]));

/** The update policy's own defaults, so the editor cannot drift from what the API assumes. */
const DEFAULT_UPDATE: WpUpdatePolicy = wpUpdateParams.parse({});

interface Draft {
  name: string;
  action: ScheduleAction;
  mode: Mode;
  site: string;
  sites: string[];
  serverId: number | null;
  note: string;
  update: WpUpdatePolicy;
  cli: string;
  command: string;
  rest: RestDraft;
  /** As typed; checked on save. */
  timeoutMin: string;
  when: 'repeat' | 'once';
  cron: string;
  /** A datetime-local value, in this browser's zone. */
  runAt: string;
  enabled: boolean;
}

interface RestDraft {
  method: WpRestMethod;
  route: string;
  /** JSON, as typed; sent only for a method other than GET. */
  body: string;
  signIn: boolean;
  username: string;
  /** Empty on an existing schedule means "keep the saved one" - the panel never sends it back. */
  password: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A time as a datetime-local value, which is this browser's zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function draftFrom(s: ScheduleDto | null, serverId: number | null): Draft {
  const base: Draft = {
    name: '',
    action: 'backup',
    mode: 'site',
    site: '',
    sites: [],
    serverId,
    note: '',
    update: DEFAULT_UPDATE,
    cli: '',
    command: '',
    rest: { method: 'GET', route: '', body: '', signIn: false, username: '', password: '' },
    timeoutMin: '10',
    when: 'repeat',
    cron: DEFAULT_CRON,
    runAt: '',
    enabled: true,
  };
  if (!s || !s.action) return base;
  const p = s.params ?? {};
  const t = s.target;
  const flag = (key: keyof WpUpdatePolicy) => (typeof p[key] === 'boolean' ? (p[key] as boolean) : DEFAULT_UPDATE[key]);
  const auth = p.auth && typeof p.auth === 'object' ? (p.auth as Record<string, unknown>) : null;
  return {
    name: s.name,
    action: s.action,
    mode: !t ? 'all' : t.kind === 'sites' ? (t.slugs.length === 1 ? 'site' : 'sites') : t.kind,
    site: t?.kind === 'sites' ? (t.slugs[0] ?? '') : '',
    sites: t?.kind === 'sites' ? [...t.slugs] : [],
    serverId: t?.kind === 'server' ? t.serverId : serverId,
    note: typeof p.note === 'string' ? p.note : '',
    update: {
      plugins: flag('plugins'),
      themes: flag('themes'),
      core: flag('core'),
      onlyVulnerable: flag('onlyVulnerable'),
      backupFirst: flag('backupFirst'),
      healthCheck: flag('healthCheck'),
    },
    cli: Array.isArray(p.args) ? formatCliArgs(p.args.filter((a): a is string => typeof a === 'string')) : '',
    command: typeof p.command === 'string' ? p.command : '',
    rest: {
      method: (wpRestMethods as readonly unknown[]).includes(p.method) ? (p.method as WpRestMethod) : 'GET',
      route: typeof p.route === 'string' ? p.route : '',
      body: p.body !== undefined ? JSON.stringify(p.body, null, 2) : '',
      signIn: auth !== null,
      username: typeof auth?.username === 'string' ? auth.username : '',
      password: '',
    },
    timeoutMin: typeof p.timeoutMin === 'number' ? String(p.timeoutMin) : '10',
    when: s.cadence.cron ? 'repeat' : 'once',
    cron: s.cadence.cron ?? DEFAULT_CRON,
    // A one-off that has run keeps its old time out of the box: picking a new one is what
    // schedules it again, and until then it stays done.
    runAt: !s.finished && s.cadence.runAt ? toLocalInput(s.cadence.runAt) : '',
    enabled: s.finished ? true : s.enabled,
  };
}

function targetOf(d: Draft, servers: readonly ServerName[]): ScheduleTarget | null {
  switch (d.mode) {
    case 'site':
      return d.site ? { kind: 'sites', slugs: [d.site] } : null;
    case 'sites':
      return d.sites.length > 0 ? { kind: 'sites', slugs: d.sites } : null;
    case 'all':
      return { kind: 'all' };
    case 'server': {
      // With one server there is nothing to choose, and nothing may have been chosen.
      const id = d.serverId ?? (servers.length === 1 ? servers[0]!.id : null);
      return id !== null ? { kind: 'server', serverId: id } : null;
    }
    case 'panel':
      return { kind: 'panel' };
  }
}

const timeoutOf = (d: Draft): number => Number(d.timeoutMin);

function paramsOf(d: Draft): Record<string, unknown> {
  switch (d.action) {
    case 'backup':
      return d.note.trim() ? { note: d.note.trim() } : {};
    case 'wp.update':
      return { ...d.update };
    case 'wp.cli':
      return { args: tokenizeCli(d.cli), timeoutMin: timeoutOf(d) };
    case 'site.shell':
      return { command: d.command, timeoutMin: timeoutOf(d) };
    case 'wp.rest': {
      const { method, route, body, signIn, username, password } = d.rest;
      const json: { value?: unknown } = method === 'GET' ? {} : parseRestBody(body);
      return {
        method,
        route: route.trim(),
        ...(json.value !== undefined ? { body: json.value } : {}),
        // No password = keep the one the panel has (it merges it back in); see keepsPassword.
        ...(signIn ? { auth: { username: username.trim(), ...(password ? { applicationPassword: password } : {}) } } : {}),
        timeoutMin: timeoutOf(d),
      };
    }
    default:
      return {};
  }
}

/**
 * The edit keeps the application password already saved: signed in as before, as the same user,
 * with nothing typed in the box. A new user needs a new password - the panel refuses otherwise.
 */
const keepsPassword = (d: Draft, initial: Draft, editing: boolean): boolean =>
  editing &&
  d.action === 'wp.rest' &&
  initial.action === 'wp.rest' &&
  d.rest.signIn &&
  initial.rest.signIn &&
  d.rest.password === '' &&
  d.rest.username.trim() === initial.rest.username.trim();

function runAtOf(d: Draft): number | null {
  if (!d.runAt) return null;
  const ms = new Date(d.runAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The box holds minutes; a time set through the API may carry seconds it cannot show. */
const sameMinute = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.floor(a / 60_000) === Math.floor(b / 60_000);

const sameTarget = (a: ScheduleTarget | null, b: ScheduleTarget | null): boolean => {
  if (!a || !b || a.kind !== b.kind) return a === b;
  if (a.kind === 'sites' && b.kind === 'sites') return a.slugs.join(',') === b.slugs.join(',');
  if (a.kind === 'server' && b.kind === 'server') return a.serverId === b.serverId;
  return true;
};

/** Why a site would be left out of a run of this action, or null. Mirrors ineligible() in src/jobs/actions.ts. */
function skipReason(action: ScheduleAction, site: SiteSummary): string | null {
  if (site.status === 'provisioning' || site.status === 'deleting') return site.status;
  if (site.kind === 'external') {
    const info: { external: boolean; externalRefusal?: string } = SCHEDULE_ACTION_INFO[action];
    if (!info.external) return `external: ${info.externalRefusal ?? 'cannot take this'}`;
    return site.status === 'connected' ? null : site.status;
  }
  if (action === 'backup') return null;
  if (action === 'site.start') return site.status === 'running' ? 'already running' : null;
  return site.status === 'running' ? null : site.status;
}

const FIELD_NAMES: Record<string, string> = {
  name: 'Name',
  action: 'What',
  target: 'On',
  params: 'Options',
  cron: 'When',
  runAt: 'When',
};

/** A labelled group of controls - Field is a <label>, which may hold only one. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-neutral-700">{title}</h4>
      {children}
    </section>
  );
}

/**
 * The sites a schedule names, one by one: a filterable checklist with a count. A site the
 * action would skip right now (a stopped one, for most actions) is flagged but can still be
 * chosen - it may be started again before the schedule fires.
 */
function SiteChecklist({
  sites,
  action,
  selected,
  onChange,
  multiServer,
}: {
  sites: SiteSummary[];
  action: ScheduleAction;
  selected: string[];
  onChange: (slugs: string[]) => void;
  multiServer: boolean;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const known = new Set(sites.map((s) => s.slug));
  const gone = selected.filter((slug) => !known.has(slug));
  const shown = sites.filter(
    (s) => !needle || s.slug.includes(needle) || s.title.toLowerCase().includes(needle) || s.serverName.toLowerCase().includes(needle),
  );
  const allShown = shown.length > 0 && shown.every((s) => selected.includes(s.slug));
  const toggle = (slug: string, on: boolean) =>
    onChange(on ? [...selected.filter((x) => x !== slug), slug] : selected.filter((x) => x !== slug));
  return (
    <div className="rounded-lg border border-neutral-200">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 p-2">
        <input
          className={`${inputClass} min-w-0 flex-1 py-1.5`}
          placeholder="Filter sites"
          aria-label="Filter sites"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // Enter here means "that one", not "save the schedule".
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
        />
        <span className="text-xs text-neutral-500 tabular-nums">{selected.length} selected</span>
        <Button
          small
          variant="ghost"
          disabled={shown.length === 0}
          onClick={() =>
            onChange(
              allShown
                ? selected.filter((slug) => !shown.some((s) => s.slug === slug))
                : [...selected, ...shown.map((s) => s.slug).filter((slug) => !selected.includes(slug))],
            )
          }
        >
          {allShown ? 'Clear shown' : 'Select all shown'}
        </Button>
      </div>
      <ul className="max-h-56 overflow-y-auto p-1">
        {gone.map((slug) => (
          <li key={slug}>
            <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-50">
              <input type="checkbox" checked onChange={() => toggle(slug, false)} />
              <span className="font-medium">{slug}</span>
              <span className="ml-auto text-[11px] text-amber-700">deleted — runs skip it</span>
            </label>
          </li>
        ))}
        {shown.map((site) => {
          const skip = skipReason(action, site);
          return (
            <li key={site.slug}>
              <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-50">
                <input
                  type="checkbox"
                  checked={selected.includes(site.slug)}
                  onChange={(e) => toggle(site.slug, e.target.checked)}
                />
                <span className="font-medium">{site.slug}</span>
                <span className="min-w-0 truncate text-xs text-neutral-500">{site.title}</span>
                {multiServer && (
                  <span className="shrink-0 text-xs text-neutral-400">{site.kind === 'external' ? 'External' : site.serverName}</span>
                )}
                {skip && <span className="ml-auto shrink-0 text-[11px] text-amber-700">{skip} — skipped</span>}
              </label>
            </li>
          );
        })}
        {shown.length === 0 && gone.length === 0 && (
          <li className="px-2 py-3 text-center text-xs text-neutral-500">{sites.length === 0 ? 'No sites yet.' : 'No site matches.'}</li>
        )}
      </ul>
    </div>
  );
}

/**
 * Create or change a custom schedule: what it does, to what, and when. Checked here the way
 * the panel checks it (scheduleCreateBody, the five-minute gap), so a save that would be
 * refused says why before it is sent; a change sends only what changed.
 */
export function ScheduleEditor({
  schedule,
  onClose,
  onSaved,
}: {
  /** null = a new schedule. */
  schedule: ScheduleDto | null;
  onClose: () => void;
  onSaved?: (schedule: ScheduleDto) => void;
}) {
  const meta = useMeta();
  const sitesQuery = useSites();
  const qc = useQueryClient();
  const tz = meta.data?.timezone;
  const servers = meta.data?.servers ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const readOnly = meta.data?.maintenance ? 'The panel is read-only while it updates' : undefined;
  const known = !schedule || (schedule.action !== null && (scheduleActions as readonly string[]).includes(schedule.action));

  const [initial] = useState(() => draftFrom(schedule, meta.data?.defaultServerId ?? null));
  const [d, setD] = useState(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);

  const sites = useMemo(
    () => [...(sitesQuery.data ?? [])].sort((a, b) => a.serverName.localeCompare(b.serverName) || a.slug.localeCompare(b.slug)),
    [sitesQuery.data],
  );
  const siteBySlug = useMemo(() => new Map(sites.map((s) => [s.slug, s])), [sites]);

  if (!known) {
    return (
      <Modal title={schedule?.name ?? 'Schedule'} onClose={onClose}>
        <div className="space-y-4 text-sm text-neutral-700">
          <p>
            This schedule runs <code>{schedule?.action ?? 'an unknown action'}</code>, which this version of the panel does not
            know: it was created by a newer client. Edit it through the API, or delete it here.
          </p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const info = SCHEDULE_ACTION_INFO[d.action];
  const modes = modesFor(d.action);
  const target = targetOf(d, servers);
  const params = paramsOf(d);
  const suggestion = suggestName(d.action, target, { servers, params });
  const name = d.name.trim() || suggestion;
  const runAt = runAtOf(d);
  const needsTimeout = d.action === 'wp.cli' || d.action === 'site.shell' || d.action === 'wp.rest';
  const cronProblem = d.when === 'repeat' ? cronScheduleProblem(d.cron, tz) : null;
  const cliProblem = d.action === 'wp.cli' && d.cli.trim() !== '' ? cliArgsProblem(d.cli) : null;
  const routeProblem = d.action === 'wp.rest' && d.rest.route.trim() !== '' ? restRouteProblem(d.rest.route) : null;
  const bodyProblem = d.action === 'wp.rest' && d.rest.method !== 'GET' ? parseRestBody(d.rest.body).problem : null;
  const keeping = keepsPassword(d, initial, !!schedule);
  const setRest = (patch: Partial<RestDraft>) => setD((prev) => ({ ...prev, rest: { ...prev.rest, ...patch } }));
  const finishedOnce = !!schedule?.finished && initial.when === 'once';
  const runAtChanged = !schedule || !sameMinute(runAt, schedule.cadence.runAt);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const changeAction = (action: ScheduleAction) => {
    setD((prev) => {
      const allowed = modesFor(action);
      return { ...prev, action, mode: allowed.includes(prev.mode) ? prev.mode : allowed[0]! };
    });
  };
  const changeMode = (mode: Mode) =>
    setD((prev) => ({
      ...prev,
      mode,
      // Carry the choice across One site / Several sites.
      site: mode === 'site' && !prev.site ? (prev.sites[0] ?? '') : prev.site,
      sites: mode === 'sites' && prev.sites.length === 0 && prev.site ? [prev.site] : prev.sites,
    }));

  /** The first thing wrong with the draft, in the editor's own words. */
  const problem = (): string | null => {
    if (!target) {
      return d.mode === 'site' ? 'Choose the site it runs on.' : d.mode === 'sites' ? 'Choose at least one site.' : 'Choose a server.';
    }
    if (d.action === 'wp.update' && !(d.update.plugins || d.update.themes || d.update.core)) {
      return 'Choose plugins, themes or WordPress core (or several).';
    }
    if (d.action === 'wp.cli') {
      const p = cliArgsProblem(d.cli);
      if (p) return p;
    }
    if (d.action === 'site.shell' && !d.command.trim()) return 'Type the command to run.';
    if (d.action === 'wp.rest') {
      const p = restRouteProblem(d.rest.route) ?? bodyProblem;
      if (p) return p;
      if (d.rest.signIn && !d.rest.username.trim()) return 'Type the username to sign in as.';
      if (d.rest.signIn && !d.rest.password && !keeping) return 'Paste the application password to sign in with.';
    }
    if (needsTimeout) {
      const t = timeoutOf(d);
      if (!Number.isInteger(t) || t < 1 || t > 60) return 'The time limit is a whole number of minutes, from 1 to 60.';
    }
    if (d.when === 'repeat') return cronProblem;
    if (runAt === null) return finishedOnce ? null : 'Pick the date and time it runs.';
    if (runAtChanged && runAt <= Date.now()) return 'That time has already passed.';
    return null;
  };

  /** Only what changed; `null` clears the timing field the other mode used. */
  const changes = (s: ScheduleDto): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (name !== s.name) out.name = name;
    if (d.action !== s.action) out.action = d.action;
    if (d.action !== s.action || JSON.stringify(params) !== JSON.stringify(paramsOf(initial))) out.params = params;
    if (!sameTarget(target, s.target)) out.target = target;
    let timing = false;
    if (d.when === 'repeat') {
      if (s.cadence.cron !== d.cron.trim()) {
        out.cron = d.cron.trim();
        if (s.cadence.runAt !== null) out.runAt = null;
        timing = true;
      }
    } else if (runAt !== null && !sameMinute(runAt, s.cadence.runAt)) {
      out.runAt = runAt;
      if (s.cadence.cron !== null) out.cron = null;
      timing = true;
    }
    // A one-off that has run is off without being paused; it is switched back on only
    // together with the new time that gives it something to do.
    if (s.finished) {
      if (timing) out.enabled = d.enabled;
    } else if (d.enabled !== s.enabled) {
      out.enabled = d.enabled;
    }
    return out;
  };

  const submit = async () => {
    const first = problem();
    if (first) throw new Error(first);
    const timing =
      d.when === 'repeat' ? { cron: d.cron.trim() } : { runAt: runAt ?? schedule?.cadence.runAt ?? undefined };
    const whole = { name, action: d.action, params, target, enabled: d.enabled, ...timing };
    // The same check the panel makes, so its refusal never comes as a surprise - with a stand-in
    // for a kept password, which the panel fills in from what it has.
    const checked =
      keeping && params.auth
        ? { ...whole, params: { ...params, auth: { ...(params.auth as object), applicationPassword: 'kept' } } }
        : whole;
    const parsed = scheduleCreateBody.safeParse(checked);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? FIELD_NAMES[String(issue.path[0])] : undefined;
      throw new Error(issue ? `${where ? `${where}: ` : ''}${issue.message}` : 'This schedule is not valid.');
    }
    let saved: ScheduleDto;
    if (!schedule) {
      saved = (await api<{ schedule: ScheduleDto }>('/api/schedules', { method: 'POST', body: whole })).schedule;
    } else {
      const patch = changes(schedule);
      if (Object.keys(patch).length === 0) return;
      saved = (await api<{ schedule: ScheduleDto }>(`/api/schedules/${schedule.id}`, { method: 'PATCH', body: patch }))
        .schedule;
    }
    await qc.invalidateQueries({ queryKey: ['schedules'] });
    onSaved?.(saved);
  };

  const whenText =
    d.when === 'repeat'
      ? (describeCron(d.cron) ?? d.cron)
      : runAt !== null
        ? `Once, ${formatRunTime(new Date(runAt), tz)}${tz ? ` (${tz})` : ''}.`
        : finishedOnce
          ? 'Once — it has run; pick a new time to run it again.'
          : 'Once, at a time still to pick.';
  const summary = [
    info.label,
    target && target.kind !== 'panel' ? targetText(target, servers, d.action) : null,
    whenText,
    d.enabled ? null : schedule ? 'Paused.' : 'Starts paused.',
  ]
    .filter(Boolean)
    .join(' · ');

  const runningCount = sites.filter((s) => s.status === 'running').length;
  const externalCount = sites.filter((s) => s.kind === 'external' && s.status === 'connected').length;
  const serverSites = (id: number | null) =>
    sites.filter((s) => s.serverId === id && (d.action === 'site.start' ? s.status === 'stopped' : s.status === 'running')).length;
  const chosenSite = siteBySlug.get(d.site);
  const chosenSkip = chosenSite ? skipReason(d.action, chosenSite) : null;
  const groupOf = (s: SiteSummary) => (s.kind === 'external' ? 'External' : s.serverName);
  const serverGroups = [...new Set(sites.map(groupOf))];

  return (
    <ActionDialog
      title={schedule ? `Edit “${schedule.name}”` : 'New schedule'}
      submitLabel={schedule ? 'Save changes' : 'Create schedule'}
      wide
      dismissible={!dirty}
      disabled={!!readOnly}
      disabledReason={readOnly}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="space-y-5">
        <Field label="Name" width="full" hint={d.name.trim() ? undefined : 'Left empty, it takes the name shown in the box.'}>
          <input className={inputClass} value={d.name} placeholder={suggestion} maxLength={100} onChange={(e) => set('name', e.target.value)} />
        </Field>

        <Section title="What">
          <select
            className={inputClass}
            aria-label="What it does"
            value={d.action}
            onChange={(e) => changeAction(e.target.value as ScheduleAction)}
          >
            {jobCategories.map((category) => {
              const actions = scheduleActions.filter((a) => SCHEDULE_ACTION_INFO[a].category === category);
              if (actions.length === 0) return null;
              return (
                <optgroup key={category} label={JOB_CATEGORY_LABELS[category]}>
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {SCHEDULE_ACTION_INFO[a].label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <p className="text-xs text-neutral-500">{info.description}</p>
        </Section>

        <Section title="On">
          {modes.length > 1 && (
            <Segmented
              small
              label="What it runs on"
              value={d.mode}
              onChange={changeMode}
              options={modes.map((m) => ({ id: m, label: MODE_LABELS[m] }))}
            />
          )}
          {d.mode === 'site' && (
            <>
              <select className={inputClass} aria-label="Site" value={d.site} onChange={(e) => set('site', e.target.value)}>
                <option value="">Choose a site…</option>
                {d.site && !siteBySlug.has(d.site) && sitesQuery.data && <option value={d.site}>{d.site} (deleted)</option>}
                {multiServer
                  ? serverGroups.map((group) => (
                      <optgroup key={group} label={group}>
                        {sites
                          .filter((s) => groupOf(s) === group)
                          .map((s) => (
                            <option key={s.slug} value={s.slug}>
                              {s.slug}
                              {s.status !== 'running' ? ` (${s.status})` : ''}
                            </option>
                          ))}
                      </optgroup>
                    ))
                  : sites.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.slug}
                        {s.status !== 'running' ? ` (${s.status})` : ''}
                      </option>
                    ))}
              </select>
              {chosenSite && chosenSkip && (
                <p className="text-xs text-amber-700">
                  {chosenSite.slug} is {chosenSkip}: a run skips it while it stays that way.
                </p>
              )}
            </>
          )}
          {d.mode === 'sites' && (
            <SiteChecklist
              sites={sites}
              action={d.action}
              selected={d.sites}
              onChange={(slugs) => set('sites', slugs)}
              multiServer={multiServer}
            />
          )}
          {d.mode === 'all' && (
            <p className="text-sm text-neutral-600">
              {runningCount} {runningCount === 1 ? 'site is' : 'sites are'} running right now. Each run takes the sites running
              at that moment, so a site created later is included and a stopped one is left out
              {d.action === 'backup' ? ', as is a site with scheduled backups switched off' : ''}.
              {externalCount > 0 &&
                (info.external
                  ? ` Connected external sites are included too (${externalCount} now).`
                  : ' External sites are left out.')}
            </p>
          )}
          {d.mode === 'server' && (
            <>
              {servers.length === 1 ? (
                <p className="text-sm font-medium text-neutral-700">{servers[0]!.name}</p>
              ) : (
                <select
                  className={inputClass}
                  aria-label="Server"
                  value={d.serverId ?? ''}
                  onChange={(e) => set('serverId', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Choose a server…</option>
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              {target?.kind === 'server' && (
                <p className="text-xs text-neutral-500">
                  {serverSites(target.serverId)} {d.action === 'site.start' ? 'stopped' : 'running'}{' '}
                  {serverSites(target.serverId) === 1 ? 'site' : 'sites'} there right now; each run takes the ones{' '}
                  {d.action === 'site.start' ? 'stopped' : 'running'} at that moment.
                </p>
              )}
            </>
          )}
          {d.mode === 'panel' && <p className="text-sm text-neutral-600">The panel itself — nothing to choose.</p>}
        </Section>

        {d.action === 'backup' && (
          <Field label="Note (optional)" width="full" hint="Kept with each backup this makes, like the note on a manual backup.">
            <input className={inputClass} value={d.note} maxLength={200} onChange={(e) => set('note', e.target.value)} />
          </Field>
        )}

        {d.action === 'wp.update' && (
          <Section title="Options">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-neutral-700">
              {(
                [
                  ['plugins', 'Plugins'],
                  ['themes', 'Themes'],
                  ['core', 'WordPress core'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={d.update[key]}
                    onChange={(e) => set('update', { ...d.update, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={d.update.onlyVulnerable}
                onChange={(e) => set('update', { ...d.update, onlyVulnerable: e.target.checked })}
              />
              Only updates that fix a known vulnerability
            </label>
            <p className="text-xs text-neutral-500">
              What to update is decided when each job runs, from a fresh scan of the site.
            </p>
            <div className="pt-1">
              <BulkRunOptions
                value={{ backupFirst: d.update.backupFirst, healthCheck: d.update.healthCheck }}
                onChange={(v) => set('update', { ...d.update, ...v })}
                backupHint="Kept like a scheduled backup, so retention removes the old ones."
              />
            </div>
          </Section>
        )}

        {d.action === 'wp.cli' && (
          <Section title="Command">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-neutral-400">wp</span>
              <input
                className={`${inputClass} font-mono`}
                aria-label="WP-CLI arguments"
                placeholder="cache flush"
                spellCheck={false}
                autoComplete="off"
                value={d.cli}
                onChange={(e) => set('cli', e.target.value)}
              />
            </div>
            {cliProblem ? (
              <p className="text-xs text-red-700">{cliProblem}</p>
            ) : (
              tokenizeCli(d.cli).length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
                  <span>Runs as:</span>
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5">wp</code>
                  {tokenizeCli(d.cli).map((arg, i) => (
                    <code key={i} className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-800">
                      {arg === '' ? '""' : arg}
                    </code>
                  ))}
                </div>
              )
            )}
          </Section>
        )}

        {d.action === 'site.shell' && (
          <Section title="Command">
            <textarea
              className={`${inputClass} font-mono`}
              aria-label="Shell command"
              rows={4}
              spellCheck={false}
              placeholder="ls -la wp-content/uploads"
              value={d.command}
              onChange={(e) => set('command', e.target.value)}
            />
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Runs as www-data inside the site's container, in the WordPress folder. Output goes to the job log; keep secrets out
              of it.
            </p>
          </Section>
        )}

        {d.action === 'wp.rest' && (
          <Section title="Request">
            <div className="flex items-center gap-2">
              {/* inputClass is w-full; the box around the select is what gives it its width. */}
              <div className="w-28 shrink-0">
                <select
                  className={`${inputClass} font-mono`}
                  aria-label="Method"
                  value={d.rest.method}
                  onChange={(e) => setRest({ method: e.target.value as WpRestMethod })}
                >
                  {wpRestMethods.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <span className="shrink-0 font-mono text-sm text-neutral-400">/wp-json/</span>
              <input
                className={`${inputClass} min-w-0 font-mono`}
                aria-label="REST route"
                placeholder="wp/v2/posts?per_page=5"
                spellCheck={false}
                autoComplete="off"
                value={d.rest.route}
                onChange={(e) => setRest({ route: e.target.value })}
              />
            </div>
            {routeProblem && <p className="text-xs text-red-700">{routeProblem}</p>}
            {d.rest.method !== 'GET' && (
              <div className="space-y-1">
                <textarea
                  className={`${inputClass} font-mono`}
                  aria-label="JSON body"
                  rows={4}
                  spellCheck={false}
                  placeholder={'{"status": "publish"}'}
                  value={d.rest.body}
                  onChange={(e) => setRest({ body: e.target.value })}
                />
                {bodyProblem ? (
                  <p className="text-xs text-red-700">{bodyProblem}</p>
                ) : (
                  <p className="text-xs text-neutral-500">Optional. Sent as application/json.</p>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 pt-1 text-sm text-neutral-700">
              <input type="checkbox" checked={d.rest.signIn} onChange={(e) => setRest({ signIn: e.target.checked })} />
              Sign in with an application password
            </label>
            {d.rest.signIn && (
              <div className="space-y-2 pl-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Username" width="full">
                    <input
                      className={inputClass}
                      value={d.rest.username}
                      maxLength={100}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setRest({ username: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="Application password"
                    width="full"
                    hint={keeping ? 'Saved. Leave it empty to keep it.' : undefined}
                  >
                    <input
                      className={`${inputClass} font-mono`}
                      type="password"
                      value={d.rest.password}
                      maxLength={200}
                      autoComplete="new-password"
                      placeholder={keeping ? '••••••••••••••••' : 'abcd efgh ijkl mnop qrst uvwx'}
                      onChange={(e) => setRest({ password: e.target.value })}
                    />
                  </Field>
                </div>
                <p className="text-xs text-neutral-500">
                  Make one in the site's WordPress admin under Users → Profile → Application Passwords; the login password does
                  not work here. It is stored with the schedule and never shown again.
                </p>
              </div>
            )}
          </Section>
        )}

        {needsTimeout && (
          <Field
            label="Stop it after (minutes)"
            width="sm"
            hint={
              d.action === 'wp.rest'
                ? '1 to 60. A request still waiting for its answer then is given up, and its job fails.'
                : '1 to 60. A command still running then is stopped, and its job fails.'
            }
          >
            <input
              className={inputClass}
              type="number"
              min={1}
              max={60}
              value={d.timeoutMin}
              onChange={(e) => set('timeoutMin', e.target.value)}
            />
          </Field>
        )}

        <Section title="When">
          <Segmented
            small
            label="How often"
            value={d.when}
            onChange={(when) => set('when', when)}
            options={[
              { id: 'repeat', label: 'Repeat' },
              { id: 'once', label: 'Once' },
            ]}
          />
          {d.when === 'repeat' ? (
            <>
              <CronField label="Cron schedule" value={d.cron} onChange={(cron) => set('cron', cron)} timezone={tz} />
              {/*
                CronField reports what croner refuses; what croner takes but a custom schedule
                may not have - runs too close together, a sixth field - is this form's to say.
              */}
              {cronProblem && cronPatternError(d.cron, tz) === null && (
                <p className="text-xs text-red-700">{cronProblem}</p>
              )}
            </>
          ) : (
            <div className="space-y-1">
              <input
                className={`${inputClass} max-w-xs`}
                type="datetime-local"
                aria-label="Date and time"
                min={toLocalInput(Date.now())}
                value={d.runAt}
                onChange={(e) => set('runAt', e.target.value)}
              />
              {finishedOnce && d.runAt === '' && schedule?.lastRunAt && (
                <p className="text-xs text-neutral-500">
                  It ran {formatRunTime(new Date(schedule.lastRunAt), tz)}. Pick a new time to run it again.
                </p>
              )}
              {tz && browserZone !== tz && (
                <p className="text-xs text-neutral-500">
                  In your browser's time zone ({browserZone}).
                  {runAt !== null && ` On the server's clock (${tz}) that is ${formatRunTime(new Date(runAt), tz)}.`}
                </p>
              )}
            </div>
          )}
        </Section>

        <div>
          <Toggle
            checked={d.enabled}
            onChange={(enabled) => set('enabled', enabled)}
            label={d.enabled ? 'Active' : schedule ? 'Paused' : 'Start paused'}
          />
          {!d.enabled && (
            <p className="mt-1 pl-11 text-xs text-neutral-500">It runs only when you resume it, or with Run now.</p>
          )}
        </div>

        <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">{summary}</p>
      </div>
    </ActionDialog>
  );
}
