import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { addDays, DAY, nextOccurrence, panelDate, reminderCreate, stateOf } from '../../shared/reminders.js';
import { domainLookups, reminders, sites, users } from '../../src/db/schema.js';
import { ReminderService, calendarText } from '../../src/services/reminders.js';
import { DomainLookupService, type JsonReader } from '../../src/services/domainLookups.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

const clock = (day = '2028-01-01') => vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${day}T12:00:00`).getTime() });
function domain(w: TestWorld, expires: string | null, statuses: string[] = [], missing = false) {
  const data = JSON.stringify({
    domain: 'example.com',
    expires,
    statuses,
    missing,
    observed: true,
    error: null,
    registrar: 'Example Registrar',
    source: 'https://rdap.example.net/',
    checkedAt: Date.now(),
    nextCheckAt: Date.now() + DAY,
  });
  w.db
    .insert(domainLookups)
    .values({ domain: 'example.com', data })
    .onConflictDoUpdate({ target: domainLookups.domain, set: { data } })
    .run();
}
function create(w: TestWorld, patch: object = {}) {
  return w.core.reminders.create({ title: 'Renew license', dueDate: panelDate(), ...patch }, 'admin');
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reminder dates and lifecycle', () => {
  it('keeps monthly and leap-year anchors, skips missed periods, and advances future completions once', () => {
    expect(nextOccurrence('2028-01-31', 1, 'months', '2028-01-31')).toBe('2028-02-29');
    expect(nextOccurrence('2028-01-31', 1, 'months', '2028-02-29')).toBe('2028-03-31');
    expect(nextOccurrence('2024-02-29', 1, 'years', '2027-03-01')).toBe('2028-02-29');
    expect(nextOccurrence('2020-01-01', 2, 'weeks', '2028-01-01')).toBe('2028-01-05');
    expect(nextOccurrence('2028-06-01', 1, 'months', '2028-01-01')).toBe('2028-07-01');
  });
  it('validates real dates and classifies warnings on the panel calendar', () => {
    expect(reminderCreate.safeParse({ title: 'x', dueDate: '2027-02-29' }).success).toBe(false);
    expect(reminderCreate.safeParse({ title: 'x', dueDate: '2027-99-99' }).success).toBe(false);
    expect(reminderCreate.safeParse({ title: 'x', dueDate: 'not a date' }).success).toBe(false);
    clock();
    const r = { dueDate: '2028-01-31', warningDays: [30, 7, 0], doneAt: null, pendingUntil: null, snoozedUntil: null, urgent: false };
    expect(stateOf(r)).toBe('warning');
    expect(stateOf({ ...r, snoozedUntil: '2028-01-02' })).toBe('snoozed');
    expect(stateOf({ ...r, snoozedUntil: '2028-01-02', urgent: true })).toBe('overdue');
    expect(stateOf({ ...r, dueDate: '2028-01-01' })).toBe('due');
  });
  it('completes one-time reminders, reopens them and preserves recurrence anchors after restart', async () => {
    clock('2028-01-31');
    const w = await makeWorld();
    const once = create(w);
    expect(w.core.reminders.done(once.id).state).toBe('done');
    expect(w.core.reminders.reopen(once.id).state).toBe('due');
    const repeat = create(w, { kind: 'recurring', every: 1, unit: 'months' });
    expect(w.core.reminders.done(repeat.id).dueDate).toBe('2028-02-29');
    clock('2028-02-29');
    const again = new ReminderService(w.core, w.deps.serverInfo);
    expect(again.done(repeat.id).dueDate).toBe('2028-03-31');
    expect(again.snooze(once.id, '2028-03-02').state).toBe('snoozed');
    expect(() => again.snooze(once.id, '2028-02-29')).toThrow();
  });
  it('advances manual domain renewals and uses one record per registrable domain', async () => {
    clock();
    const w = await makeWorld();
    const r = create(w, { kind: 'domain', domain: 'www.example.com', unit: 'years' });
    expect(r.domain).toBe('example.com');
    expect(w.core.reminders.done(r.id).dueDate).toBe('2029-01-01');
    expect(() => create(w, { kind: 'domain', domain: 'shop.example.com' })).toThrow(/already tracks/);
  });
  it('waits three days for renewal, rejects auto-renew grace and notices renewal without Done', async () => {
    clock();
    const w = await makeWorld();
    domain(w, '2028-01-01');
    const r = create(w, { kind: 'domain', domain: 'example.com', automatic: true });
    expect(w.core.reminders.done(r.id).state).toBe('pending');
    clock('2028-01-05');
    expect(w.core.reminders.get(r.id).state).toBe('overdue');
    domain(w, '2029-01-01', ['auto renew period']);
    expect(w.core.reminders.update(r.id, { note: 'Payment submitted' }).dueDate).toBe('2028-01-01');
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id)).toMatchObject({ dueDate: '2028-01-01', urgent: true });
    domain(w, '2029-01-01');
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id)).toMatchObject({ dueDate: '2029-01-01', state: 'upcoming', pendingUntil: null });
    domain(w, '2030-01-01');
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id).dueDate).toBe('2030-01-01');
    domain(w, '2030-01-01', ['redemption period']);
    expect(w.core.reminders.snooze(r.id, '2028-02-01').state).toBe('overdue');
    domain(w, '2030-01-01', [], true);
    expect(w.core.reminders.get(r.id).urgent).toBe(true);
  });
  it('undoes an accidental renewal completion without changing the date or hiding registry problems', async () => {
    clock();
    const w = await makeWorld();
    domain(w, '2028-11-01');
    const r = create(w, { kind: 'domain', domain: 'example.com', automatic: true });
    expect(w.core.reminders.done(r.id)).toMatchObject({ state: 'pending', dueDate: '2028-11-01' });
    expect(w.core.reminders.reopen(r.id)).toMatchObject({ state: 'upcoming', dueDate: '2028-11-01', pendingUntil: null });
    w.core.reminders.done(r.id);
    clock('2028-01-05');
    expect(w.core.reminders.get(r.id)).toMatchObject({ state: 'upcoming', dueDate: '2028-11-01' });
    domain(w, '2028-11-01', ['client hold']);
    w.core.reminders.done(r.id);
    expect(w.core.reminders.reopen(r.id)).toMatchObject({ state: 'overdue', urgent: true, dueDate: '2028-11-01', pendingUntil: null });
    domain(w, '2029-11-01');
    w.core.reminders.reconcile();
    expect(w.core.reminders.reopen(r.id)).toMatchObject({ state: 'upcoming', dueDate: '2029-11-01', pendingUntil: null });
  });
  it('resolves PHP support reminders when sites upgrade and flags a regression again', async () => {
    clock();
    const w = await makeWorld();
    const site = w.db
      .insert(sites)
      .values({
        slug: 'shop',
        title: 'Shop',
        domains: '["shop.example.com"]',
        phpVersion: '8.2.18',
        status: 'running',
        dbName: 'shop',
        dbUser: 'shop',
        dbPassword: 'x',
        containerName: 'wp-shop',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning()
      .get();
    const suggestion = w.core.reminders.options().suggestions.find((s) => s.input.kind === 'php')!;
    const r = w.core.reminders.create(suggestion.input, 'admin');
    expect(r.affectedSites.map((s) => s.id)).toEqual([site.id]);
    w.db.update(sites).set({ phpVersion: '8.4' }).where(eq(sites.id, site.id)).run();
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id).state).toBe('done');
    w.db.update(sites).set({ phpVersion: '8.2' }).where(eq(sites.id, site.id)).run();
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id).state).toBe('overdue');
  });
});

describe('tracked source changes', () => {
  it.each(['client hold', 'redemption period'])(
    'refreshes a manual domain after %s clears, preserving its entered date',
    async (status) => {
      clock();
      const w = await makeWorld();
      domain(w, null, [status]);
      const r = create(w, { kind: 'domain', domain: 'example.com', dueDate: '2028-11-01', automatic: false });
      const read = vi
        .fn<JsonReader>()
        .mockResolvedValueOnce({ status: 200, body: { services: [[['com'], ['https://rdap.example.net/']]] } })
        .mockResolvedValueOnce({ status: 200, body: { objectClassName: 'domain', status: ['active'], events: [] } })
        .mockResolvedValueOnce({
          status: 200,
          body: {
            objectClassName: 'domain',
            status: ['active'],
            events: [{ eventAction: 'expiration', eventDate: '2029-11-01T00:00:00Z' }],
          },
        });
      const domains = new DomainLookupService(w.db, w.core.settings, read);
      vi.spyOn(w.core.reminders.domains, 'lookup').mockImplementation((name) => domains.lookup(name));
      expect(w.core.reminders.get(r.id)).toMatchObject({ state: 'overdue', urgent: true });
      await w.core.reminders.lookupTick();
      expect(read).not.toHaveBeenCalled();
      clock('2028-01-02');
      await w.core.reminders.lookupTick();
      expect(w.core.reminders.get(r.id)).toMatchObject({ state: 'upcoming', urgent: false, dueDate: '2028-11-01', automatic: false });
      expect(domains.cached('example.com')).toMatchObject({ statuses: ['active'], expires: null });
      expect(read).toHaveBeenCalledTimes(2);
      await w.core.reminders.lookupTick();
      expect(read).toHaveBeenCalledTimes(2);
      clock('2028-01-03');
      w.core.settings.set('domainLookups', false);
      await w.core.reminders.lookupTick();
      expect(read).toHaveBeenCalledTimes(2);
      w.core.settings.set('domainLookups', true);
      await w.core.reminders.lookupTick();
      expect(domains.cached('example.com')?.expires).toBe('2029-11-01');
      expect(w.core.reminders.get(r.id)).toMatchObject({ state: 'upcoming', urgent: false, dueDate: '2028-11-01', automatic: false });
    },
  );
  it('resolves OS reminders after an upgrade, but retains them while a server is unavailable', async () => {
    clock();
    const w = await makeWorld();
    const facts = {
      at: Date.now(),
      cloudflare: null,
      servers: [{ id: 1, os: 'Ubuntu 22.04 LTS', release: 'ubuntu:22.04', error: null as string | null }],
    };
    w.core.settings.setRaw('reminders.sources', facts);
    const suggestion = w.core.reminders.options().suggestions.find((s) => s.input.kind === 'os')!;
    const r = w.core.reminders.create(suggestion.input, 'admin');
    facts.servers[0]!.error = 'Server unavailable';
    w.core.settings.setRaw('reminders.sources', facts);
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id).state).not.toBe('done');
    facts.servers[0] = { id: 1, os: 'Ubuntu 24.04 LTS', release: 'ubuntu:24.04', error: null };
    w.core.settings.setRaw('reminders.sources', facts);
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id).state).toBe('done');
  });
  it('keeps an inactive token red and resolves a confirmed removal of its expiry', async () => {
    clock();
    const w = await makeWorld();
    const facts = {
      at: Date.now(),
      cloudflare: { subject: 'token-fingerprint', expires: '2028-01-01' as string | null, invalid: true, error: null },
      servers: [],
    };
    w.core.settings.setRaw('reminders.sources', facts);
    const suggestion = w.core.reminders.options().suggestions.find((s) => s.input.kind === 'cloudflare')!;
    const r = w.core.reminders.create(suggestion.input, 'admin');
    expect(w.core.reminders.done(r.id).state).toBe('overdue');
    facts.cloudflare.invalid = false;
    facts.cloudflare.expires = null;
    w.core.settings.setRaw('reminders.sources', facts);
    w.core.reminders.reconcile();
    expect(w.core.reminders.get(r.id).state).toBe('done');
  });
});

describe('daily digest', () => {
  it('groups by actual recipient, persists daily deduplication and repeats overdue weekly', async () => {
    clock();
    const w = await makeWorld();
    w.core.settings.set('alertEmail', 'ops@example.com');
    const user = w.db
      .insert(users)
      .values({ username: 'operator', passwordHash: '', email: 'ops@example.com', createdAt: Date.now(), updatedAt: Date.now() })
      .returning()
      .get();
    create(w, { email: true });
    create(w, { email: true, recipientUserId: user.id, title: 'Pay invoice' });
    const send = vi.spyOn(w.core.mail, 'sendPanelMail').mockResolvedValue(true);
    await w.core.reminders.digest();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![2]).toContain('Pay invoice');
    const again = new ReminderService(w.core, w.deps.serverInfo);
    create(w, { email: true, title: 'New today' });
    await again.digest();
    expect(send).toHaveBeenCalledTimes(1);
    clock('2028-01-02');
    await again.digest();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![2]).not.toContain('Pay invoice');
    clock('2028-01-07');
    await again.digest();
    expect(send).toHaveBeenCalledTimes(2);
    clock('2028-01-08');
    await again.digest();
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('waits seven days after the first overdue email, even when added midweek', async () => {
    clock('2028-01-05');
    const w = await makeWorld();
    w.core.settings.set('alertEmail', 'ops@example.com');
    create(w, { email: true, dueDate: '2028-01-01' });
    const send = vi.spyOn(w.core.mail, 'sendPanelMail').mockResolvedValue(true);
    await w.core.reminders.digest();
    clock('2028-01-08');
    await w.core.reminders.digest();
    expect(send).toHaveBeenCalledTimes(1);
    clock('2028-01-12');
    await w.core.reminders.digest();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries relay refusal after a delay and skips completed or snoozed reminders', async () => {
    clock();
    const w = await makeWorld();
    w.core.settings.set('alertEmail', 'ops@example.com');
    create(w, { email: true });
    const hidden = create(w, { title: 'Hidden', email: true });
    w.core.reminders.snooze(hidden.id, '2028-01-03');
    const done = create(w, { title: 'Done already', email: true });
    w.core.reminders.done(done.id);
    const send = vi.spyOn(w.core.mail, 'sendPanelMail').mockResolvedValueOnce(false).mockResolvedValue(true);
    await w.core.reminders.digest();
    await w.core.reminders.digest();
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await w.core.reminders.digest();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![2]).not.toMatch(/Hidden|Done already/);
  });
  it('never reroutes a deleted user recipient to the alert address', async () => {
    clock();
    const w = await makeWorld();
    w.core.settings.set('alertEmail', 'ops@example.com');
    const user = w.db
      .insert(users)
      .values({ username: 'operator', passwordHash: '', email: 'user@example.com', createdAt: Date.now(), updatedAt: Date.now() })
      .returning()
      .get();
    create(w, { email: true, recipientUserId: user.id });
    w.db.delete(users).where(eq(users.id, user.id)).run();
    const send = vi.spyOn(w.core.mail, 'sendPanelMail').mockResolvedValue(true);
    await w.core.reminders.digest();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('reminder API and calendar', () => {
  it('requires Full for mutations, exposes safe reads, and patches without resetting unspecified fields', async () => {
    const { app, world: w } = await makeApp();
    const full = w.deps.apiKeys.create('full', 'full');
    const read = w.deps.apiKeys.create('read', 'read');
    const headers = { authorization: `Bearer ${full.token}` };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/reminders',
          headers: { authorization: `Bearer ${read.token}` },
          payload: { title: 'x', dueDate: '2028-01-01' },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/reminders',
      headers,
      payload: {
        title: 'Quarterly test',
        dueDate: '2028-01-31',
        kind: 'recurring',
        every: 3,
        unit: 'months',
        warningDays: [7, 0],
        email: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().reminder.id;
    const changed = await app.inject({ method: 'PATCH', url: `/api/reminders/${id}`, headers, payload: { note: 'Test the restore' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().reminder).toMatchObject({
      kind: 'recurring',
      every: 3,
      unit: 'months',
      warningDays: [7, 0],
      email: true,
      note: 'Test the restore',
    });
    const response = await app.inject({ url: '/api/reminders', headers: { authorization: `Bearer ${read.token}` } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
  it('uses revocable capability URLs and escapes and folds calendar text', async () => {
    clock();
    const { app, world: w } = await makeApp();
    const r = create(w, { title: 'Renew, license; test', note: 'First\nSecond\\line ' + 'é'.repeat(100) });
    const path = w.core.reminders.rotateCalendar();
    const result = await app.inject({ url: path });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('text/calendar');
    expect(result.body).toContain('Renew\\, license\\; test');
    expect(result.body).toContain('First\\nSecond\\\\line');
    for (const line of result.body.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(calendarText([w.core.reminders.done(r.id)])).not.toContain('BEGIN:VEVENT');
    w.core.reminders.rotateCalendar();
    expect((await app.inject({ url: path })).statusCode).toBe(404);
    const next = w.core.reminders.rotateCalendar();
    w.core.reminders.revokeCalendar();
    expect((await app.inject({ url: next })).statusCode).toBe(404);
    await app.close();
  });
  it('pauses both background tasks through Schedules', async () => {
    const w = await makeWorld();
    const tick = vi.spyOn(w.core.reminders, 'tick').mockResolvedValue();
    const lookup = vi.spyOn(w.core.reminders, 'lookupTick').mockResolvedValue();
    w.deps.schedulers.update('reminders', { enabled: false });
    w.deps.schedulers.update('domain-lookups', { enabled: false });
    await w.deps.schedulers.run('reminders', 'timer');
    await w.deps.schedulers.run('domain-lookups', 'timer');
    expect(tick).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
});
