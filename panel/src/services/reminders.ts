// @docs automations/reminders
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { reminders, sites, users, type ReminderRow } from '../db/schema.js';
import type { CoreServices } from './index.js';
import type { SystemInfoService } from '../servers/systemInfo.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { DomainLookupService, DANGER_STATUSES, registrableDomain } from './domainLookups.js';
import { ReminderSources, PHP_EOL, OS_EOL } from './reminderSources.js';
import {
  DAY,
  addDays,
  daysBetween,
  dateOnly,
  isFlagged,
  nextOccurrence,
  panelDate,
  reminderCreate,
  stateOf,
  type ReminderDto,
  type ReminderInput,
  type ReminderOptions,
  type ReminderSuggestion,
} from '../../shared/reminders.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const branch = (v: string) => /^\d+\.\d+/.exec(v)?.[0] ?? v;
const dataOf = (r: ReminderRow) =>
  ({ ...JSON.parse(r.data), siteId: r.siteId, serverId: r.serverId, recipientUserId: r.recipientUserId }) as ReminderInput;
export class ReminderService {
  readonly domains: DomainLookupService;
  readonly sources: ReminderSources;
  private digestRunning = false;
  constructor(
    private s: CoreServices,
    info: SystemInfoService,
  ) {
    this.domains = new DomainLookupService(s.db, s.settings);
    this.sources = new ReminderSources(s, info);
  }
  private rows() {
    return this.s.db.select().from(reminders).all();
  }
  private row(id: number) {
    const row = this.s.db.select().from(reminders).where(eq(reminders.id, id)).get();
    if (!row) throw notFound('Reminder not found');
    return row;
  }
  private put(id: number, patch: Partial<typeof reminders.$inferInsert>) {
    this.s.db
      .update(reminders)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(reminders.id, id))
      .run();
  }
  private siteRows() {
    return this.s.db
      .select()
      .from(sites)
      .all()
      .filter((s) => s.status !== 'deleting');
  }
  private dto(row: ReminderRow, now = Date.now(), siteRows = this.siteRows()): ReminderDto {
    const input = dataOf(row);
    const domain = input.domain ? this.domains.cached(input.domain) : null;
    const cf = this.sources.cached().cloudflare;
    let problem: string | null = null;
    let urgent = false;
    if (input.kind === 'domain' && domain) {
      urgent = domain.missing || domain.statuses.includes('auto renew period') || domain.statuses.some((s) => DANGER_STATUSES.has(s));
      problem = urgent
        ? domain.missing
          ? 'Domain no longer found at the registry'
          : domain.statuses.filter((s) => DANGER_STATUSES.has(s) || s === 'auto renew period').join(', ')
        : domain.error;
      if (domain.statuses.includes('auto renew period') && !domain.missing)
        problem = 'Registry auto-renew period. Renewal is not confirmed.';
    }
    if (input.kind === 'cloudflare' && cf?.subject === input.subject) {
      urgent = cf.invalid;
      problem = cf.invalid ? 'Cloudflare token is inactive' : cf.error;
    }
    const recipientMissing =
      !!row.recipientSelected &&
      (!row.recipientUserId || !this.s.db.select().from(users).where(eq(users.id, row.recipientUserId)).get()?.email);
    if (recipientMissing && input.email) problem = 'Email recipient is unavailable. Choose another recipient.';
    const affected = siteRows.filter(
      (s) =>
        s.id === row.siteId ||
        (input.kind === 'php' && branch(s.phpVersion) === input.subject) ||
        (input.kind === 'os' && s.serverId === row.serverId) ||
        (input.kind === 'domain' && (JSON.parse(s.domains) as string[]).some((d) => registrableDomain(d) === input.domain)),
    );
    const dto = {
      ...input,
      id: row.id,
      snoozedUntil: row.snoozedUntil,
      pendingUntil: row.pendingUntil,
      doneAt: row.doneAt,
      urgent,
      problem,
      recipientMissing,
      siteSlug: affected.find((s) => s.id === row.siteId)?.slug ?? null,
      affectedSites: affected.map(({ id, slug, title }) => ({ id, slug, title })),
      state: 'upcoming' as const,
    };
    return { ...dto, state: stateOf(dto, now) };
  }
  list(now = Date.now()) {
    const siteRows = this.siteRows();
    return this.rows()
      .map((r) => this.dto(r, now, siteRows))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id - b.id);
  }
  get(id: number) {
    return this.dto(this.row(id));
  }
  summary() {
    const due = this.list().filter(isFlagged);
    return {
      count: due.length,
      tone: due.some((r) => r.state === 'due' || r.state === 'overdue') ? 'red' : 'amber',
      today: panelDate(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  private validated(raw: unknown, current?: ReminderInput): ReminderInput {
    const input = reminderCreate.parse(raw);
    input.warningDays = [...new Set([...input.warningDays, 0])].sort((a, b) => b - a);
    if (input.domain) {
      input.domain = registrableDomain(input.domain);
      if (!input.domain) throw badRequest('Enter a public domain name');
    }
    if (input.siteId && !this.siteRows().some((s) => s.id === input.siteId)) throw badRequest('Site not found');
    if (input.serverId && !this.s.servers.rowById(input.serverId)) throw badRequest('Server not found');
    if (input.recipientUserId) {
      const recipient = this.s.db.select().from(users).where(eq(users.id, input.recipientUserId)).get();
      if (!recipient || (input.email && !recipient.email)) throw badRequest('Choose a user with a confirmed email address');
    }
    if (input.kind === 'domain' && input.automatic) {
      const lookup = this.domains.cached(input.domain!);
      if (!lookup?.expires) throw badRequest('Look up the domain first, or enter a manual date');
      input.dueDate = current?.kind === 'domain' && current.domain === input.domain && current.automatic ? current.dueDate : lookup.expires;
    }
    if (['php', 'os', 'cloudflare'].includes(input.kind)) {
      const suggestion = this.allSuggestions().find(
        (s) =>
          s.input.kind === input.kind && s.input.subject === input.subject && (input.kind !== 'os' || s.input.serverId === input.serverId),
      );
      const due =
        suggestion?.input.dueDate ??
        (current?.kind === input.kind && current.subject === input.subject && current.serverId === input.serverId ? current.dueDate : null);
      if (!due) throw badRequest('This source has no known expiry date. Use a one-time reminder.');
      input.dueDate = due;
      input.automatic = true;
    }
    return input;
  }
  private key(input: ReminderInput) {
    if (input.kind === 'domain') return `domain:${input.domain}`;
    if (['php', 'os', 'cloudflare'].includes(input.kind))
      return `${input.kind}:${input.subject}:${input.kind === 'os' ? (input.serverId ?? '') : ''}`;
    return null;
  }
  create(raw: unknown, actor: string) {
    const input = this.validated(raw);
    const key = this.key(input);
    if (key && this.rows().some((r) => r.subjectKey === key)) throw conflict('A reminder already tracks this item');
    const now = Date.now();
    const row = this.s.db
      .insert(reminders)
      .values({
        data: JSON.stringify(input),
        anchor: input.dueDate,
        subjectKey: key,
        siteId: input.siteId,
        serverId: input.serverId,
        recipientUserId: input.recipientUserId,
        recipientSelected: input.recipientUserId ? 1 : 0,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return this.dto(row);
  }
  update(id: number, patch: Partial<ReminderInput>) {
    const row = this.row(id);
    const old = dataOf(row);
    const input = this.validated({ ...old, ...patch }, old);
    const key = this.key(input);
    if (key && this.rows().some((r) => r.id !== id && r.subjectKey === key)) throw conflict('A reminder already tracks this item');
    const changed = input.dueDate !== old.dueDate || input.every !== old.every || input.unit !== old.unit || input.kind !== old.kind;
    this.put(id, {
      data: JSON.stringify(input),
      subjectKey: key,
      siteId: input.siteId,
      serverId: input.serverId,
      recipientUserId: input.recipientUserId,
      recipientSelected: 'recipientUserId' in patch ? (input.recipientUserId ? 1 : 0) : row.recipientSelected,
      ...(changed ? { anchor: input.dueDate, doneAt: null, snoozedUntil: null, pendingUntil: null, emailKey: null, emailedAt: null } : {}),
    });
    return this.get(id);
  }
  remove(id: number) {
    this.row(id);
    this.s.db.delete(reminders).where(eq(reminders.id, id)).run();
  }
  done(id: number) {
    const row = this.row(id);
    const input = dataOf(row);
    if ((input.kind === 'domain' && input.automatic) || ['php', 'os', 'cloudflare'].includes(input.kind)) {
      this.put(id, { pendingUntil: Date.now() + 3 * DAY, snoozedUntil: null });
    } else if (input.kind === 'recurring' || input.kind === 'domain') {
      const next = nextOccurrence(row.anchor, input.every, input.unit, [panelDate(), input.dueDate].sort().at(-1)!);
      if (!dateOnly.safeParse(next).success) throw badRequest('The next occurrence is outside the supported date range');
      input.dueDate = next;
      this.put(id, { data: JSON.stringify(input), doneAt: null, snoozedUntil: null, pendingUntil: null, emailKey: null, emailedAt: null });
    } else this.put(id, { doneAt: Date.now(), snoozedUntil: null });
    return this.get(id);
  }
  snooze(id: number, until: string | null) {
    this.row(id);
    if (until && until <= panelDate()) throw badRequest('Choose a date after today');
    this.put(id, { snoozedUntil: until, pendingUntil: null });
    return this.get(id);
  }
  reopen(id: number) {
    this.row(id);
    this.put(id, { doneAt: null, pendingUntil: null, snoozedUntil: null });
    return this.get(id);
  }
  private allSuggestions(): ReminderSuggestion[] {
    const list: ReminderSuggestion[] = [];
    const byDomain = new Map<string, number | null>();
    for (const site of this.siteRows())
      for (const host of [...(JSON.parse(site.domains) as string[]), ...(site.devHostname ? [site.devHostname] : [])]) {
        const domain = registrableDomain(host);
        if (domain && !byDomain.has(domain)) byDomain.set(domain, site.id);
      }
    for (const host of [this.s.config.panelDomain, ...this.s.servers.listRows().map((s) => s.devDomain)]) {
      const d = registrableDomain(host);
      if (d && !byDomain.has(d)) byDomain.set(d, null);
    }
    for (const [domain, siteId] of byDomain) {
      const cached = this.domains.cached(domain);
      list.push({
        key: `domain:${domain}`,
        title: `Renew ${domain}`,
        detail: cached?.expires ?? 'Look up expiry or enter a date',
        input: {
          kind: 'domain',
          title: `Renew ${domain}`,
          domain,
          siteId,
          warningDays: [30, 7, 0],
          every: 1,
          unit: 'years',
          ...(cached?.expires ? { dueDate: cached.expires, automatic: true } : {}),
        },
      });
    }
    for (const version of new Set(this.siteRows().map((s) => branch(s.phpVersion)))) {
      if (!PHP_EOL[version]) continue;
      const count = this.siteRows().filter((s) => branch(s.phpVersion) === version).length;
      list.push({
        key: `php:${version}`,
        title: `PHP ${version} security support ends`,
        detail: `${count} ${count === 1 ? 'site' : 'sites'} · ${PHP_EOL[version]}`,
        input: {
          kind: 'php',
          title: `PHP ${version} security support ends`,
          dueDate: PHP_EOL[version],
          subject: version,
          automatic: true,
          warningDays: [90, 30, 7, 0],
        },
      });
    }
    const facts = this.sources.cached();
    for (const server of facts.servers) {
      const due = server.release ? OS_EOL[server.release] : null;
      if (!due) continue;
      const name = this.s.servers.rowById(server.id)?.name;
      if (!name) continue;
      list.push({
        key: `os:${server.id}:${server.release}`,
        title: `${name}: OS support ends`,
        detail: `${server.os} · ${due}${server.release?.startsWith('ubuntu:') ? ' (start of final month)' : ''}`,
        input: {
          kind: 'os',
          title: `${name}: OS support ends`,
          dueDate: due,
          serverId: server.id,
          subject: server.release,
          warningDays: [90, 30, 7, 0],
          automatic: true,
        },
      });
    }
    const cf = facts.cloudflare;
    if (cf && (cf.expires || cf.invalid))
      list.push({
        key: `cloudflare:${cf.subject}`,
        title: 'Cloudflare token expires',
        detail: cf.invalid ? 'Token is inactive' : cf.expires!,
        input: {
          kind: 'cloudflare',
          title: 'Cloudflare token expires',
          dueDate: cf.expires ?? panelDate(),
          subject: cf.subject,
          warningDays: [30, 7, 0],
          automatic: true,
        },
      });
    return list;
  }
  options(): ReminderOptions {
    const existing = new Set(this.rows().map((r) => r.subjectKey));
    return {
      suggestions: this.allSuggestions().filter((s) => !existing.has(this.key(s.input as ReminderInput))),
      sites: this.siteRows().map(({ id, slug, title }) => ({ id, slug, title })),
      servers: this.s.servers.listRows().map(({ id, name }) => ({ id, name })),
      users: this.s.db
        .select()
        .from(users)
        .all()
        .filter((u) => u.email)
        .map(({ id, username }) => ({ id, username })),
      lookupEnabled: this.domains.enabled(),
      calendarEnabled: !!this.s.settings.getRaw('reminders.calendarHash'),
      sourceError: this.sources.cached().cloudflare?.error ?? null,
    };
  }
  async refreshSources() {
    await this.sources.refresh();
    this.reconcile();
    return this.options();
  }
  /** Refresh status for every tracked domain; only automatic dates change in reconcile(). One domain per pass spreads traffic. */
  async lookupTick() {
    if (!this.domains.enabled()) return;
    const next = this.rows()
      .map(dataOf)
      .filter((r) => r.kind === 'domain' && r.domain)
      .map((r) => r.domain!)
      .find((d) => (this.domains.cached(d)?.nextCheckAt ?? 0) <= Date.now());
    if (next) await this.domains.lookup(next);
    this.reconcile();
  }
  reconcile() {
    const facts = this.sources.cached();
    for (const row of this.rows()) {
      const r = dataOf(row);
      let date: string | null = null;
      let resolved = false;
      if (r.kind === 'domain' && r.automatic && r.domain) {
        const d = this.domains.cached(r.domain);
        if (d?.expires && !d.missing && !d.statuses.includes('auto renew period') && !d.statuses.some((s) => DANGER_STATUSES.has(s)))
          date = d.expires;
      } else if (r.kind === 'php') {
        resolved = !this.siteRows().some((s) => branch(s.phpVersion) === r.subject);
        date = PHP_EOL[r.subject!] ?? null;
      } else if (r.kind === 'os') {
        const server = facts.servers.find((s) => s.id === row.serverId);
        resolved = !row.serverId || (!!server && !server.error && !!server.release && server.release !== r.subject);
        date = OS_EOL[r.subject!] ?? null;
      } else if (r.kind === 'cloudflare' && facts.at) {
        resolved =
          !facts.cloudflare ||
          facts.cloudflare.subject !== r.subject ||
          (!facts.cloudflare.invalid && !facts.cloudflare.error && !facts.cloudflare.expires);
        if (!resolved && !facts.cloudflare?.invalid) date = facts.cloudflare?.expires ?? null;
      }
      if (resolved) {
        if (!row.doneAt) this.put(row.id, { doneAt: Date.now(), pendingUntil: null });
        continue;
      }
      if (row.doneAt && ['php', 'os', 'cloudflare'].includes(r.kind)) this.put(row.id, { doneAt: null });
      if (date && date !== r.dueDate) {
        this.put(row.id, {
          data: JSON.stringify({ ...r, dueDate: date }),
          anchor: date,
          pendingUntil: null,
          snoozedUntil: null,
          doneAt: null,
          emailKey: null,
          emailedAt: null,
        });
      }
    }
  }
  async tick() {
    await this.refreshSources();
    await this.digest();
  }
  /** The stage catches missed warning days once; each recipient gets at most one accepted digest per local day. */
  async digest(now = Date.now()) {
    if (this.digestRunning || new Date(now).getHours() < 9) return;
    this.digestRunning = true;
    try {
      const today = panelDate(now);
      const grouped = new Map<string, { row: ReminderRow; dto: ReminderDto; key: string }[]>();
      for (const row of this.rows()) {
        const dto = this.dto(row, now);
        if (!dto.email || !isFlagged(dto)) continue;
        const to = row.recipientSelected
          ? row.recipientUserId
            ? this.s.db.select().from(users).where(eq(users.id, row.recipientUserId)).get()?.email
            : null
          : this.s.settings.get('alertEmail');
        if (!to) continue;
        const left = daysBetween(today, dto.dueDate);
        const stage = dto.urgent
          ? `urgent:${Math.floor(daysBetween(panelDate(row.createdAt), today) / 7)}`
          : left <= 0
            ? `due:${Math.floor(-left / 7)}`
            : `warn:${Math.min(...dto.warningDays.filter((d) => left <= d))}`;
        const key = `${hash(to.toLowerCase())}:${dto.dueDate}:${stage}`;
        if (row.emailKey === key) continue;
        // A reminder first added while overdue still waits a full week after its last email.
        if (
          row.emailedAt &&
          now - row.emailedAt < 7 * DAY &&
          row.emailKey?.startsWith(`${hash(to.toLowerCase())}:${dto.dueDate}:`) &&
          ((dto.urgent && row.emailKey.includes(':urgent:')) || (!dto.urgent && left < 0 && row.emailKey.includes(':due:')))
        )
          continue;
        const address = to.toLowerCase();
        grouped.set(address, [...(grouped.get(address) ?? []), { row, dto, key }]);
      }
      for (const [to, items] of grouped) {
        const ledgerKey = `reminders.digest:${hash(to)}`;
        const ledger = this.s.settings.getRaw(ledgerKey) as { sentDay?: string; retryAt?: number } | undefined;
        if (ledger?.sentDay === today || (ledger?.retryAt ?? 0) > now) continue;
        this.s.settings.setRaw(ledgerKey, { ...ledger, retryAt: now + 15 * 60_000 });
        const body = items
          .map(({ dto }) => `${dto.dueDate} — ${dto.title}${dto.problem ? ` (${dto.problem})` : ''}${dto.note ? `\n${dto.note}` : ''}`)
          .join('\n\n');
        let sent = false;
        try {
          sent = await this.s.mail.sendPanelMail(to, `${items.length} reminder${items.length === 1 ? '' : 's'}`, body);
        } catch {
          /* retained for retry */
        }
        if (!sent) continue;
        this.s.db.transaction(() => {
          this.s.settings.setRaw(ledgerKey, { sentDay: today, retryAt: 0 });
          for (const item of items) {
            const current = this.s.db.select().from(reminders).where(eq(reminders.id, item.row.id)).get();
            if (current?.updatedAt === item.row.updatedAt) this.put(item.row.id, { emailKey: item.key, emailedAt: now });
          }
        });
      }
    } finally {
      this.digestRunning = false;
    }
  }
  rotateCalendar() {
    const token = randomBytes(32).toString('hex');
    this.s.settings.setRaw('reminders.calendarHash', hash(token));
    return `/calendar/reminders/${token}`;
  }
  revokeCalendar() {
    this.s.settings.setRaw('reminders.calendarHash', null);
  }
  calendar(token: string) {
    const expected = this.s.settings.getRaw('reminders.calendarHash');
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(expected)))
      throw notFound('Calendar not found');
    return calendarText(this.list());
  }
}

export function calendarText(items: ReminderDto[]) {
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r/g, '');
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WPL7//Reminders//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:WPL7 reminders'];
  for (const r of items.filter((r) => r.state !== 'done'))
    lines.push(
      'BEGIN:VEVENT',
      `UID:reminder-${r.id}@wpl7`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${r.dueDate.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${addDays(r.dueDate, 1).replace(/-/g, '')}`,
      `SUMMARY:${escape(r.title)}`,
      `DESCRIPTION:${escape(r.note)}`,
      'END:VEVENT',
    );
  lines.push('END:VCALENDAR');
  // RFC 5545 folds at 75 octets, never inside a UTF-8 character.
  return (
    lines
      .map((line) => {
        let out = '',
          bytes = 0;
        for (const c of line) {
          const n = Buffer.byteLength(c);
          if (bytes + n > 75) {
            out += '\r\n ';
            bytes = 1;
          }
          out += c;
          bytes += n;
        }
        return out;
      })
      .join('\r\n') + '\r\n'
  );
}
