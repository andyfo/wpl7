// @docs automations/reminders
import { z } from 'zod';

export const dateOnly = z.iso.date().refine((s) => {
  const time = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === s;
}, 'Enter a valid date');
export const reminderFields = z.object({
  title: z.string().trim().min(1).max(160),
  note: z.string().max(4000).default(''),
  kind: z.enum(['once', 'recurring', 'domain', 'cloudflare', 'php', 'os']).default('once'),
  dueDate: dateOnly,
  warningDays: z.array(z.number().int().min(0).max(3650)).min(1).max(12).default([0]),
  every: z.number().int().min(1).max(1000).default(1),
  unit: z.enum(['days', 'weeks', 'months', 'years']).default('years'),
  siteId: z.number().int().positive().nullable().default(null),
  serverId: z.number().int().positive().nullable().default(null),
  email: z.boolean().default(false),
  recipientUserId: z.number().int().positive().nullable().default(null),
  domain: z.string().trim().max(253).nullable().default(null),
  automatic: z.boolean().default(false),
  subject: z.string().max(160).nullable().default(null),
});
// PATCH must not apply create defaults to fields the caller omitted.
export const reminderUpdate = z.object({
  title: reminderFields.shape.title.optional(),
  dueDate: dateOnly.optional(),
  note: reminderFields.shape.note.removeDefault().optional(),
  kind: reminderFields.shape.kind.removeDefault().optional(),
  warningDays: reminderFields.shape.warningDays.removeDefault().optional(),
  every: reminderFields.shape.every.removeDefault().optional(),
  unit: reminderFields.shape.unit.removeDefault().optional(),
  siteId: reminderFields.shape.siteId.removeDefault().optional(),
  serverId: reminderFields.shape.serverId.removeDefault().optional(),
  email: reminderFields.shape.email.removeDefault().optional(),
  recipientUserId: reminderFields.shape.recipientUserId.removeDefault().optional(),
  domain: reminderFields.shape.domain.removeDefault().optional(),
  automatic: reminderFields.shape.automatic.removeDefault().optional(),
  subject: reminderFields.shape.subject.removeDefault().optional(),
});
export const reminderCreate = reminderFields.superRefine((v, ctx) => {
  if (v.kind === 'domain' && !v.domain) ctx.addIssue({ code: 'custom', path: ['domain'], message: 'Enter a domain' });
  if (['php', 'os', 'cloudflare'].includes(v.kind) && !v.subject)
    ctx.addIssue({ code: 'custom', path: ['subject'], message: 'Choose a suggestion' });
});
export type ReminderInput = z.infer<typeof reminderCreate>;
export type ReminderState = 'upcoming' | 'warning' | 'due' | 'overdue' | 'snoozed' | 'pending' | 'done';
export interface ReminderDto extends ReminderInput {
  id: number;
  state: ReminderState;
  urgent: boolean;
  snoozedUntil: string | null;
  pendingUntil: number | null;
  doneAt: number | null;
  problem: string | null;
  recipientMissing: boolean;
  siteSlug: string | null;
  affectedSites: { id: number; slug: string; title: string }[];
}
export interface DomainDto {
  domain: string;
  expires: string | null;
  registrar: string | null;
  statuses: string[];
  checkedAt: number | null;
  nextCheckAt: number;
  source: string | null;
  error: string | null;
  observed: boolean;
  missing: boolean;
}
export interface ReminderSuggestion {
  key: string;
  title: string;
  detail: string;
  input: Partial<ReminderInput>;
}
export interface ReminderOptions {
  suggestions: ReminderSuggestion[];
  sites: { id: number; slug: string; title: string }[];
  servers: { id: number; name: string }[];
  users: { id: number; username: string }[];
  lookupEnabled: boolean;
  calendarEnabled: boolean;
  sourceError: string | null;
}

export const DAY = 86_400_000;
/** The same local calendar the panel's schedules use, independent of the browser's timezone. */
export function panelDate(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
export const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

/** Calculate from the original anchor: Jan 31 -> Feb 28 -> Mar 31, and leap days return. */
export function nextOccurrence(anchor: string, every: number, unit: ReminderInput['unit'], after: string): string {
  const start = new Date(`${anchor}T00:00:00Z`);
  const at = (n: number) => {
    if (unit === 'days' || unit === 'weeks') return addDays(anchor, n * every * (unit === 'weeks' ? 7 : 1));
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n * every * (unit === 'years' ? 12 : 1), 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(start.getUTCDate(), last));
    return d.toISOString().slice(0, 10);
  };
  let n = 1;
  if (unit === 'days' || unit === 'weeks')
    n = Math.max(1, Math.floor(daysBetween(anchor, after) / (every * (unit === 'weeks' ? 7 : 1))) + 1);
  else
    n = Math.max(
      1,
      Math.floor(
        ((Number(after.slice(0, 4)) - start.getUTCFullYear()) * 12 + Number(after.slice(5, 7)) - 1 - start.getUTCMonth()) /
          (every * (unit === 'years' ? 12 : 1)),
      ),
    );
  while (at(n) <= after) n++;
  return at(n);
}

export function stateOf(
  r: Pick<ReminderDto, 'dueDate' | 'warningDays' | 'doneAt' | 'pendingUntil' | 'snoozedUntil' | 'urgent'>,
  now = Date.now(),
): ReminderState {
  if (r.doneAt !== null) return 'done';
  if (r.urgent) return 'overdue';
  const today = panelDate(now);
  if (r.snoozedUntil && r.snoozedUntil > today) return 'snoozed';
  if (r.pendingUntil && r.pendingUntil > now) return 'pending';
  const left = daysBetween(today, r.dueDate);
  if (left < 0) return 'overdue';
  if (left === 0) return 'due';
  return left <= Math.max(...r.warningDays) ? 'warning' : 'upcoming';
}

export const isFlagged = (r: { state: ReminderState }) => ['warning', 'due', 'overdue'].includes(r.state);
