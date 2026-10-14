// @docs automations/reminders
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { dateOnly, reminderCreate, reminderUpdate } from '../../shared/reminders.js';
import { actorName, audit } from '../lib/audit.js';
import type { AppDeps } from './deps.js';

const params = z.object({ id: z.coerce.number().int().positive() });
export function registerReminderRoutes(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const s = deps.reminders;
  r.get(
    '/api/reminders',
    {
      schema: {
        querystring: z.object({
          siteId: z.coerce.number().int().positive().optional(),
          serverId: z.coerce.number().int().positive().optional(),
        }),
      },
    },
    async (req) => ({
      items: s
        .list()
        .filter(
          (r) =>
            (!req.query.siteId || r.siteId === req.query.siteId || r.affectedSites.some((site) => site.id === req.query.siteId)) &&
            (!req.query.serverId || r.serverId === req.query.serverId),
        ),
    }),
  );
  r.get('/api/reminders/summary', async () => s.summary());
  r.get('/api/reminders/options', async () => s.options());
  r.post('/api/reminders/refresh', async () => s.refreshSources());
  r.get('/api/reminders/:id', { schema: { params } }, async (req) => ({ reminder: s.get(req.params.id) }));
  r.post('/api/reminders', { schema: { body: reminderCreate } }, async (req, reply) => {
    const reminder = s.create(req.body, actorName(req) ?? 'API');
    audit(req, 'reminder', String(reminder.id), 'create', {});
    return reply.code(201).send({ reminder });
  });
  r.patch('/api/reminders/:id', { schema: { params, body: reminderUpdate } }, async (req) => {
    const reminder = s.update(req.params.id, req.body);
    audit(req, 'reminder', String(reminder.id), 'change', {});
    return { reminder };
  });
  r.delete('/api/reminders/:id', { schema: { params } }, async (req, reply) => {
    s.remove(req.params.id);
    audit(req, 'reminder', String(req.params.id), 'delete', {});
    return reply.code(204).send();
  });
  r.post('/api/reminders/:id/done', { schema: { params } }, async (req) => {
    const reminder = s.done(req.params.id);
    audit(req, 'reminder', String(req.params.id), 'done', {});
    return { reminder };
  });
  r.post('/api/reminders/:id/reopen', { schema: { params } }, async (req) => {
    const reminder = s.reopen(req.params.id);
    audit(req, 'reminder', String(req.params.id), 'reopen', {});
    return { reminder };
  });
  r.post('/api/reminders/:id/snooze', { schema: { params, body: z.object({ until: dateOnly.nullable() }) } }, async (req) => {
    const reminder = s.snooze(req.params.id, req.body.until);
    audit(req, 'reminder', String(req.params.id), 'snooze', {});
    return { reminder };
  });
  r.get('/api/domains', async () => ({
    items: s.domains.list(),
    suggestions: s.options().suggestions.filter((r) => r.input.kind === 'domain'),
  }));
  r.get('/api/domains/lookup', { schema: { querystring: z.object({ name: z.string().min(1).max(253) }) } }, async (req) => ({
    domain: await s.domains.lookup(req.query.name),
  }));
  r.post('/api/reminders/calendar', async (req, reply) => {
    const path = s.rotateCalendar();
    audit(req, 'reminder', '-', 'rotate calendar', {});
    return reply.header('cache-control', 'no-store').send({ path });
  });
  r.delete('/api/reminders/calendar', async (req, reply) => {
    s.revokeCalendar();
    audit(req, 'reminder', '-', 'revoke calendar', {});
    return reply.code(204).send();
  });
  // Capability URL: no cookies required, token is checked here and never stored in plaintext.
  r.get(
    '/calendar/reminders/:token',
    { schema: { params: z.object({ token: z.string().max(128) }) }, logLevel: 'silent' },
    async (req, reply) => {
      return reply
        .header('cache-control', 'private, no-store')
        .header('referrer-policy', 'no-referrer')
        .type('text/calendar; charset=utf-8')
        .send(s.calendar(req.params.token));
    },
  );
}
