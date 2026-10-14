import { domainLookups, sites } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { addDays, DAY, panelDate } from '../../shared/reminders.js';

export function seedReminders(w: TestWorld) {
  const today = panelDate();
  const site = w.db
    .select()
    .from(sites)
    .all()
    .find((s) => s.slug === 'northwind-bakery')!;
  w.core.settings.set('domainLookups', false);
  w.core.settings.setRaw('reminders.sources', {
    at: Date.now(),
    cloudflare: null,
    servers: w.core.servers.listRows().map((s) => ({ id: s.id, os: 'Ubuntu 26.04 LTS', release: 'ubuntu:26.04', error: null })),
  });
  w.core.reminders.create(
    {
      title: 'Test a backup restore',
      kind: 'recurring',
      dueDate: addDays(today, -2),
      unit: 'months',
      every: 3,
      siteId: site.id,
      note: 'Restore to a temporary site and check the latest orders.',
    },
    'admin',
  );
  w.core.reminders.create(
    {
      title: 'Renew plugin license',
      kind: 'recurring',
      dueDate: addDays(today, 7),
      unit: 'years',
      warningDays: [30, 7, 0],
      email: true,
      siteId: site.id,
    },
    'admin',
  );
  w.core.reminders.create({ title: 'Review maintenance contract', dueDate: addDays(today, 42), warningDays: [14, 0] }, 'admin');
  w.core.reminders.create(
    { title: 'Pay server bill', kind: 'recurring', dueDate: addDays(today, 20), unit: 'months', serverId: 1 },
    'admin',
  );
  const data = {
    domain: 'example.com',
    expires: addDays(today, 90),
    registrar: 'Example Registrar',
    statuses: ['active'],
    checkedAt: Date.now(),
    nextCheckAt: Date.now() + DAY,
    source: 'https://rdap.example.net/',
    error: null,
    observed: true,
    missing: false,
  };
  w.db
    .insert(domainLookups)
    .values({ domain: data.domain, data: JSON.stringify(data) })
    .run();
  w.core.reminders.create(
    { title: 'Renew example.com', kind: 'domain', domain: 'example.com', dueDate: data.expires, automatic: true, warningDays: [30, 7, 0] },
    'admin',
  );
  const done = w.core.reminders.create({ title: 'Check recovery contacts', dueDate: addDays(today, -7) }, 'admin');
  w.core.reminders.done(done.id);
}
