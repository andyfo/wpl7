// @docs automations/reminders
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  isFlagged,
  panelDate,
  reminderCreate,
  type DomainDto,
  type ReminderDto,
  type ReminderInput,
  type ReminderOptions,
  type ReminderSuggestion,
} from '../../../shared/reminders';
import { api } from '../api/client';
import { useDomains, useReminderAction, useReminderOptions, useReminders, useReminderSummary } from '../api/reminders';
import { Button, Card, ErrorNote, Field, Modal, Toggle, inputClass, Spinner, Tabs, useTabParam } from '../components/ui';
import { Icon } from '../components/Icon';
import { ReminderTask } from '../components/ReminderTask';

const STATE: Record<string, string> = {
  upcoming: 'Upcoming',
  warning: 'Due soon',
  due: 'Due today',
  overdue: 'Overdue',
  snoozed: 'Snoozed',
  pending: 'Awaiting confirmation',
  done: 'Done',
};
const TEMPLATES: Record<string, Partial<ReminderInput>> = {
  'Plugin license': { title: 'Renew plugin license', kind: 'recurring', every: 1, unit: 'years', warningDays: [30, 7, 0] },
  'Restore test': { title: 'Test a backup restore', kind: 'recurring', every: 3, unit: 'months', warningDays: [7, 0] },
  'Client contract': { title: 'Renew maintenance contract', kind: 'recurring', every: 1, unit: 'years', warningDays: [30, 7, 0] },
  'Server bill': { title: 'Pay server bill', kind: 'recurring', every: 1, unit: 'months', warningDays: [7, 0] },
};
const TABS = [
  { id: 'reminders', label: 'Reminders' },
  { id: 'domains', label: 'Domains' },
];
export function Reminders() {
  const list = useReminders();
  const options = useReminderOptions();
  const summary = useReminderSummary();
  const action = useReminderAction();
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const [tab, setTab] = useTabParam(TABS);
  const [edit, setEdit] = useState<Partial<ReminderDto> | null>(null);
  const [snooze, setSnooze] = useState<ReminderDto | null>(null);
  const [until, setUntil] = useState('');
  const [calendar, setCalendar] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [remove, setRemove] = useState<ReminderDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const today = summary.data?.today ?? panelDate();
  const domainsTab = tab === 'domains';
  useEffect(() => {
    const id = Number(search.get('reminder'));
    const found = list.data?.find((r) => r.id === id);
    if (found) {
      setEdit(found);
      setSearch({}, { replace: true });
    }
  }, [list.data, search, setSearch]);
  const addSuggestion = async (suggestion: ReminderSuggestion) => {
    setBusy(true);
    setError(null);
    try {
      let input = suggestion.input;
      if (input.kind === 'domain' && options.data?.lookupEnabled) {
        const { domain } = await api<{ domain: DomainDto }>(`/api/domains/lookup?name=${encodeURIComponent(input.domain!)}`);
        input = { ...input, dueDate: domain.expires ?? undefined, automatic: !!domain.expires };
      }
      if (!input.dueDate) {
        setEdit(input);
        return;
      }
      await action.mutateAsync({ path: '/api/reminders', body: reminderCreate.parse(input) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await action.mutateAsync({ path: '/api/reminders/refresh' });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const run = (r: ReminderDto, command: string, body?: unknown) => action.mutate({ path: `/api/reminders/${r.id}/${command}`, body });
  const row = (r: ReminderDto) => (
    <ReminderTask
      key={r.id}
      reminder={r}
      today={today}
      serverName={options.data?.servers.find((s) => s.id === r.serverId)?.name}
      busy={action.isPending}
      canSnooze={!!summary.data}
      onComplete={() => run(r, r.state === 'done' ? 'reopen' : 'done')}
      onReopen={() => run(r, 'reopen')}
      onSnooze={() => {
        setSnooze(r);
        setUntil(addDays(today, 1));
      }}
      onEdit={() => setEdit(r)}
      onDelete={() => setRemove(r)}
    />
  );
  const due = (list.data ?? []).filter(isFlagged);
  const upcoming = (list.data ?? []).filter((r) => !isFlagged(r) && r.state !== 'done');
  const done = (list.data ?? []).filter((r) => r.state === 'done');
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Reminders</h1>
          <p className="mt-2 text-sm text-neutral-500">Track renewals, support deadlines and recurring maintenance.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCalendar(true)}>
            Calendar feed
          </Button>
          <Button onClick={() => setEdit({})}>New reminder</Button>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <ErrorNote error={list.error || options.error || summary.error || action.error || error} />
      {domainsTab ? (
        <Domains onAdd={addSuggestion} busy={busy || action.isPending} reminders={list.data ?? []} onEdit={setEdit} />
      ) : (
        <>
          {list.isLoading && <Spinner />}
          <div className="rounded-xl border border-neutral-200 bg-surface">
            {due.length > 0 && (
              <section aria-labelledby="reminders-due">
                <h2 id="reminders-due" className="flex items-center gap-2 border-b border-neutral-100 px-5 py-3 text-sm font-semibold">
                  Due <span className="text-xs font-normal text-neutral-500">{due.length}</span>
                </h2>
                <ul className="divide-y divide-neutral-100" style={{ maxWidth: 'none' }}>
                  {due.map(row)}
                </ul>
              </section>
            )}
            <section aria-labelledby="reminders-upcoming" className={due.length ? 'border-t border-neutral-200' : ''}>
              <h2 id="reminders-upcoming" className="flex items-center gap-2 border-b border-neutral-100 px-5 py-3 text-sm font-semibold">
                Upcoming <span className="text-xs font-normal text-neutral-500">{upcoming.length}</span>
              </h2>
              {upcoming.length ? (
                <ul className="divide-y divide-neutral-100" style={{ maxWidth: 'none' }}>
                  {upcoming.map(row)}
                </ul>
              ) : (
                <p className="px-5 py-4 text-sm text-neutral-500">{list.isLoading ? 'Loading reminders…' : 'No upcoming reminders.'}</p>
              )}
            </section>
            <button
              type="button"
              onClick={() => setEdit({})}
              className="flex w-full items-center gap-3 rounded-b-xl border-t border-neutral-100 px-5 py-3 text-left text-sm text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
            >
              <Icon name="plus" size={18} /> Add reminder
            </button>
          </div>
          {done.length > 0 && (
            <details className="group/completed">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-neutral-500 [&::-webkit-details-marker]:hidden">
                <span className="-rotate-90 transition-transform group-open/completed:rotate-0">
                  <Icon name="chevron" size={16} />
                </span>
                Completed <span className="text-xs">{done.length}</span>
              </summary>
              <ul className="mt-3 divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-surface" style={{ maxWidth: 'none' }}>
                {done.map(row)}
              </ul>
            </details>
          )}
          <details className="group/suggestions border-t border-neutral-200 pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-neutral-500 [&::-webkit-details-marker]:hidden">
              <span className="-rotate-90 transition-transform group-open/suggestions:rotate-0">
                <Icon name="chevron" size={16} />
              </span>
              Suggestions <span className="text-xs">{options.data?.suggestions.length ?? 0}</span>
              {options.data?.sourceError && <span className="text-amber-700">Check failed</span>}
            </summary>
            <div className="mt-3 rounded-xl border border-neutral-200 bg-surface px-5">
              <div className="flex items-center justify-between gap-3 py-3">
                <p className="text-xs text-neutral-500">From your sites and servers</p>
                <Button small variant="secondary" disabled={busy} onClick={refresh}>
                  {busy ? 'Checking…' : 'Check sources'}
                </Button>
              </div>
              {options.data?.sourceError && <p className="mb-3 text-sm text-amber-700">{options.data.sourceError}</p>}
              {options.data?.suggestions.length ? (
                <ul className="divide-y divide-neutral-100 border-t border-neutral-100" style={{ maxWidth: 'none' }}>
                  {options.data.suggestions.map((s) => (
                    <li key={s.key} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">{s.title}</p>
                        <p className="mt-1 text-xs text-neutral-500">{s.detail}</p>
                      </div>
                      <Button small variant="secondary" disabled={busy || action.isPending} onClick={() => void addSuggestion(s)}>
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pb-4 text-sm text-neutral-500">No new suggestions. Check sources for token and OS dates.</p>
              )}
            </div>
          </details>
        </>
      )}
      {edit && options.data && summary.data && (
        <ReminderEditor initial={edit} options={options.data} today={today} onClose={() => setEdit(null)} />
      )}
      {snooze && (
        <Modal title="Snooze reminder" onClose={() => setSnooze(null)}>
          <div className="space-y-4">
            <p className="text-sm">{snooze.title}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setUntil(addDays(today, 1))}>
                1 day
              </Button>
              <Button variant="secondary" onClick={() => setUntil(addDays(today, 7))}>
                1 week
              </Button>
            </div>
            <Field label="Until">
              <input className={inputClass} type="date" min={addDays(today, 1)} value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
            <ErrorNote error={action.error} />
            <div className="flex gap-2">
              <Button
                disabled={action.isPending || !until || until <= today}
                onClick={async () => {
                  await action
                    .mutateAsync({ path: `/api/reminders/${snooze.id}/snooze`, body: { until } })
                    .then(() => setSnooze(null))
                    .catch(() => {});
                }}
              >
                Snooze
              </Button>
              {snooze.snoozedUntil && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    run(snooze, 'snooze', { until: null });
                    setSnooze(null);
                  }}
                >
                  Clear snooze
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {remove && (
        <Modal title="Delete reminder?" onClose={() => setRemove(null)}>
          <p className="mb-4 text-sm">{remove.title}</p>
          <ErrorNote error={action.error} />
          <Button
            variant="danger"
            disabled={action.isPending}
            onClick={() => action.mutate({ path: `/api/reminders/${remove.id}`, method: 'DELETE' }, { onSuccess: () => setRemove(null) })}
          >
            Delete
          </Button>
        </Modal>
      )}
      {showCalendar && (
        <Modal title="Calendar feed" onClose={() => setShowCalendar(false)}>
          <div className="space-y-4">
            <p className="text-sm text-neutral-500">Anyone with this link can read your reminders. Add it as a calendar subscription.</p>
            {calendar && (
              <Field label="Calendar URL">
                <input className={inputClass} readOnly value={calendar} onFocus={(e) => e.target.select()} />
              </Field>
            )}
            <ErrorNote error={error || action.error} />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const { path } = await api<{ path: string }>('/api/reminders/calendar', { method: 'POST' });
                    setCalendar(new URL(path, location.origin).href);
                    await client.invalidateQueries({ queryKey: ['reminders'] });
                  } catch (e) {
                    setError(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {options.data?.calendarEnabled ? 'Replace link' : 'Create link'}
              </Button>
              {options.data?.calendarEnabled && (
                <Button
                  variant="danger"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ path: '/api/reminders/calendar', method: 'DELETE' }, { onSuccess: () => setCalendar(null) })
                  }
                >
                  Revoke link
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReminderEditor({
  initial,
  options,
  today,
  onClose,
}: {
  initial: Partial<ReminderDto>;
  options: ReminderOptions;
  today: string;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ReminderInput>(() => ({
    title: '',
    note: '',
    kind: 'once',
    dueDate: today,
    warningDays: [0],
    every: 1,
    unit: 'years',
    siteId: null,
    serverId: null,
    email: false,
    recipientUserId: null,
    domain: null,
    automatic: false,
    subject: null,
    ...initial,
  }));
  const [warnings, setWarnings] = useState(form.warningDays.join(', '));
  const [template, setTemplate] = useState('');
  const [recipientMissing, setRecipientMissing] = useState(!!initial.recipientMissing);
  const [error, setError] = useState<unknown>(null);
  const [lookup, setLookup] = useState<DomainDto | null>(null);
  const [checking, setChecking] = useState(false);
  const action = useReminderAction();
  const set = <K extends keyof ReminderInput>(key: K, value: ReminderInput[K]) => setForm((old) => ({ ...old, [key]: value }));
  const specialized = ['cloudflare', 'php', 'os'].includes(form.kind);
  const sourceLocked = !!initial.id && ['cloudflare', 'php', 'os'].includes(initial.kind ?? '');
  const sources = options.suggestions.filter((s) => s.input.kind === form.kind);
  const selectedSource = sources.find(
    (s) => s.input.subject === form.subject && (form.kind !== 'os' || s.input.serverId === form.serverId),
  );
  const changeKind = (kind: ReminderInput['kind']) => {
    const source = ['cloudflare', 'php', 'os'].includes(kind);
    const warningDays = kind === 'php' || kind === 'os' ? [90, 30, 7, 0] : kind === 'domain' || kind === 'cloudflare' ? [30, 7, 0] : [0];
    setForm((f) => ({
      ...f,
      kind,
      automatic: source,
      domain: kind === 'domain' ? f.domain : null,
      subject: null,
      title: source || specialized ? '' : f.title,
      dueDate: source ? '' : specialized ? today : f.dueDate,
      siteId: source || specialized ? null : f.siteId,
      serverId: source || specialized ? null : f.serverId,
      warningDays,
      ...(kind === 'domain' ? { unit: 'years', every: 1 } : {}),
    }));
    setWarnings(warningDays.join(', '));
    setTemplate('');
    setLookup(null);
    setError(null);
  };
  const chooseSource = (key: string) => {
    const source = sources.find((s) => s.key === key);
    if (!source) {
      changeKind(form.kind);
      return;
    }
    setForm((f) => ({ ...f, ...source.input, siteId: source.input.siteId ?? null, serverId: source.input.serverId ?? null }));
    setWarnings(source.input.warningDays!.join(', '));
  };
  const sourceLabel = form.kind === 'php' ? 'PHP version' : form.kind === 'os' ? 'Server operating system' : 'Cloudflare token';
  const save = async () => {
    try {
      if (form.email && recipientMissing) throw new Error('Choose an email recipient.');
      const input = reminderCreate.parse({ ...form, warningDays: warnings.split(',').map((s) => Number(s.trim())) });
      await action.mutateAsync({
        path: initial.id ? `/api/reminders/${initial.id}` : '/api/reminders',
        method: initial.id ? 'PATCH' : 'POST',
        body: input,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? new Error(e.message.startsWith('[') ? 'Check the date, title and warning days.' : e.message) : e);
    }
  };
  return (
    <Modal title={initial.id ? 'Edit reminder' : 'New reminder'} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Kind">
          <select
            className={inputClass}
            value={form.kind}
            disabled={sourceLocked}
            onChange={(e) => changeKind(e.target.value as ReminderInput['kind'])}
          >
            <option value="once">One-time</option>
            <option value="recurring">Recurring</option>
            <option value="domain">Domain renewal</option>
            <option value="php">PHP end of life</option>
            <option value="os">Server OS end of life</option>
            <option value="cloudflare">Cloudflare token expiry</option>
          </select>
        </Field>
        {specialized && !sourceLocked && (
          <div className="space-y-3">
            <Field label={sourceLabel} hint={selectedSource?.detail}>
              <select className={inputClass} required value={selectedSource?.key ?? ''} onChange={(e) => chooseSource(e.target.value)}>
                <option value="">Choose {form.kind === 'php' ? 'a PHP version' : form.kind === 'os' ? 'a server' : 'a token'}</option>
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {form.kind === 'php'
                      ? `PHP ${s.input.subject}`
                      : form.kind === 'os'
                        ? (options.servers.find((server) => server.id === s.input.serverId)?.name ?? s.title)
                        : s.title}
                  </option>
                ))}
              </select>
            </Field>
            {!sources.length && (
              <p className="text-xs text-neutral-500">
                {form.kind === 'php'
                  ? 'No untracked PHP versions with a known support date.'
                  : form.kind === 'os'
                    ? 'No untracked servers with a known support date.'
                    : 'No untracked expiring Cloudflare token found.'}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {form.kind !== 'php' && (
                <Button
                  small
                  variant="secondary"
                  disabled={checking || action.isPending}
                  onClick={async () => {
                    setChecking(true);
                    setError(null);
                    try {
                      await action.mutateAsync({ path: '/api/reminders/refresh' });
                    } catch (e) {
                      setError(e);
                    } finally {
                      setChecking(false);
                    }
                  }}
                >
                  {checking ? 'Checking…' : 'Check sources'}
                </Button>
              )}
              {!sources.length && (
                <Button small variant="ghost" onClick={() => changeKind('once')}>
                  Use a one-time reminder
                </Button>
              )}
            </div>
            {form.kind === 'cloudflare' && options.sourceError && <p className="text-xs text-amber-700">{options.sourceError}</p>}
          </div>
        )}
        {!initial.id && !specialized && (
          <Field label="Template">
            <select
              className={inputClass}
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value);
                const preset = TEMPLATES[e.target.value];
                if (preset) {
                  setForm((f) => ({ ...f, ...preset, automatic: false, domain: null, subject: null }));
                  setWarnings(preset.warningDays!.join(', '));
                  setLookup(null);
                }
              }}
            >
              <option value="">Choose a template</option>
              {Object.keys(TEMPLATES).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Title">
          <input
            autoFocus
            required
            maxLength={160}
            className={inputClass}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
        {form.kind === 'domain' && (
          <>
            <Field label="Domain">
              <input
                required
                list="reminder-domain-suggestions"
                className={inputClass}
                placeholder="example.com"
                value={form.domain ?? ''}
                onChange={(e) => {
                  set('domain', e.target.value);
                  set('automatic', false);
                  setLookup(null);
                }}
              />
              <datalist id="reminder-domain-suggestions">
                {options.suggestions
                  .filter((s) => s.input.domain)
                  .map((s) => (
                    <option key={s.key} value={s.input.domain!} />
                  ))}
              </datalist>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                disabled={checking || !form.domain || !options.lookupEnabled}
                onClick={async () => {
                  setChecking(true);
                  setError(null);
                  try {
                    const { domain } = await api<{ domain: DomainDto }>(`/api/domains/lookup?name=${encodeURIComponent(form.domain!)}`);
                    setLookup(domain);
                    if (domain.expires) setForm((f) => ({ ...f, domain: domain.domain, dueDate: domain.expires!, automatic: true }));
                  } catch (e) {
                    setError(e);
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                {checking ? 'Looking up…' : 'Look up expiry'}
              </Button>
              <Toggle
                checked={form.automatic}
                onChange={(v) => set('automatic', v)}
                label="Use registry date"
                disabled={!form.automatic && !lookup?.expires}
              />
            </div>
            {!options.lookupEnabled && <p className="text-xs text-neutral-500">Domain lookups are off in Settings → Monitoring.</p>}
            {lookup && (
              <p className="text-sm text-neutral-500">
                {lookup.error ?? `Expires ${lookup.expires}${lookup.registrar ? ` · ${lookup.registrar}` : ''}`}
              </p>
            )}
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={specialized ? 'Support or expiry date' : 'Due date'}>
            <input
              required
              className={inputClass}
              type="date"
              disabled={specialized || (form.kind === 'domain' && form.automatic)}
              value={form.dueDate}
              onChange={(e) => set('dueDate', e.target.value)}
            />
          </Field>
          <Field label="Warn days before" hint="Separate days with commas. Always warns on the due date.">
            <input className={inputClass} required value={warnings} onChange={(e) => setWarnings(e.target.value)} placeholder="30, 7, 0" />
          </Field>
        </div>
        {(form.kind === 'recurring' || (form.kind === 'domain' && !form.automatic)) && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={form.kind === 'domain' ? 'Renewal term' : 'Repeat every'}>
              <input
                type="number"
                min={1}
                max={1000}
                required
                className={inputClass}
                value={form.every}
                onChange={(e) => set('every', Number(e.target.value))}
              />
            </Field>
            <Field label="Unit">
              <select className={inputClass} value={form.unit} onChange={(e) => set('unit', e.target.value as ReminderInput['unit'])}>
                {['days', 'weeks', 'months', 'years'].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Site">
            <select className={inputClass} value={form.siteId ?? ''} onChange={(e) => set('siteId', Number(e.target.value) || null)}>
              <option value="">None</option>
              {options.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Server">
            <select
              disabled={form.kind === 'os'}
              className={inputClass}
              value={form.serverId ?? ''}
              onChange={(e) => set('serverId', Number(e.target.value) || null)}
            >
              <option value="">None</option>
              {options.servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Note">
          <textarea rows={2} maxLength={4000} className={inputClass} value={form.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <Toggle checked={form.email} onChange={(v) => set('email', v)} label="Email reminder" />
        {form.email && (
          <Field label="Send to">
            <select
              className={inputClass}
              value={recipientMissing ? 'missing' : (form.recipientUserId ?? '')}
              onChange={(e) => {
                setRecipientMissing(false);
                set('recipientUserId', Number(e.target.value) || null);
              }}
            >
              {recipientMissing && (
                <option value="missing" disabled>
                  Choose a recipient
                </option>
              )}
              <option value="">Alert address (Settings → Monitoring)</option>
              {options.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </Field>
        )}
        {(specialized || (form.kind === 'domain' && form.automatic)) && (
          <p className="text-xs text-neutral-500">Done pauses the warning for 3 days while the panel checks for a change.</p>
        )}
        <ErrorNote error={error || action.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={action.isPending || checking || (specialized && !form.subject)}>
            Save reminder
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Domains({
  onAdd,
  busy,
  reminders,
  onEdit,
}: {
  onAdd: (s: ReminderSuggestion) => Promise<void>;
  busy: boolean;
  reminders: ReminderDto[];
  onEdit: (r: ReminderDto) => void;
}) {
  const query = useDomains();
  const names = [
    ...new Set([
      ...(query.data?.items ?? []).map((d) => d.domain),
      ...(query.data?.suggestions ?? []).map((s) => s.input.domain!),
      ...reminders.filter((r) => r.kind === 'domain').map((r) => r.domain!),
    ]),
  ].sort();
  return (
    <Card title="Domains">
      <ErrorNote error={query.error} />
      {query.isLoading ? (
        <Spinner />
      ) : names.length === 0 ? (
        <p className="text-sm text-neutral-500">No domains yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th className="py-3 pr-4">Domain</th>
                <th className="pr-4">Expires</th>
                <th className="pr-4">Registrar</th>
                <th className="pr-4">Status</th>
                <th>Reminder</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const d = query.data?.items.find((d) => d.domain === name);
                const r = reminders.find((r) => r.domain === name);
                const suggestion = query.data?.suggestions.find((s) => s.input.domain === name);
                return (
                  <tr key={name} className="border-b border-neutral-100">
                    <td className="py-4 pr-4 font-medium">{name}</td>
                    <td className="pr-4 whitespace-nowrap">
                      {r?.dueDate ?? d?.expires ?? 'Unknown'}
                      {r && !r.automatic && <span className="block text-xs text-neutral-500">Manual</span>}
                    </td>
                    <td className="pr-4">{d?.registrar ?? '—'}</td>
                    <td className="pr-4 text-xs">
                      <span>{d?.statuses.join(', ') || 'Not checked'}</span>
                      {d?.error && <p className="mt-1 text-amber-700">{d.error}</p>}
                      {d?.checkedAt && <p className="mt-1 text-neutral-500">Checked {new Date(d.checkedAt).toLocaleDateString()}</p>}
                    </td>
                    <td>
                      {r ? (
                        <Button small variant="secondary" onClick={() => onEdit(r)}>
                          {r.urgent ? 'Needs attention' : STATE[r.state]}
                        </Button>
                      ) : suggestion ? (
                        <Button small variant="secondary" disabled={busy} onClick={() => void onAdd(suggestion)}>
                          Add
                        </Button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
