// @docs automations/reminders
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DAY } from '../../shared/reminders.js';
import type { CoreServices } from './index.js';
import type { SystemInfoService } from '../servers/systemInfo.js';
import { readPublicJson, type JsonReader } from './domainLookups.js';

// Upstream security support, not active support or paid extensions. Watchlist tracks updates.
// https://www.php.net/supported-versions.php and https://www.php.net/eol.php
export const PHP_EOL: Record<string, string> = {
  '7.0': '2019-01-10',
  '7.1': '2019-12-01',
  '7.2': '2020-11-30',
  '7.3': '2021-12-06',
  '7.4': '2022-11-28',
  '8.0': '2023-11-26',
  '8.1': '2025-12-31',
  '8.2': '2026-12-31',
  '8.3': '2027-12-31',
  '8.4': '2028-12-31',
  '8.5': '2029-12-31',
};
// Ubuntu publishes a month. Warn on its first day rather than inventing a last supported day.
// https://ubuntu.com/about/release-cycle and https://wiki.debian.org/LTS
export const OS_EOL: Record<string, string> = {
  'ubuntu:18.04': '2023-05-01',
  'ubuntu:20.04': '2025-05-01',
  'ubuntu:22.04': '2027-05-01',
  'ubuntu:24.04': '2029-05-01',
  'ubuntu:26.04': '2031-05-01',
  'debian:10': '2024-06-30',
  'debian:11': '2026-08-31',
  'debian:12': '2028-06-30',
  'debian:13': '2030-06-30',
};
export function osRelease(os: string | null): string | null {
  const ubuntu = /^Ubuntu (\d+\.\d+)/i.exec(os ?? '');
  if (ubuntu) return `ubuntu:${ubuntu[1]}`;
  const debian = /^Debian GNU\/Linux (\d+)/i.exec(os ?? '');
  return debian ? `debian:${debian[1]}` : null;
}
export interface SourceFacts {
  at: number;
  cloudflare: { subject: string; expires: string | null; invalid: boolean; error: string | null } | null;
  servers: { id: number; os: string | null; release: string | null; error: string | null }[];
}
export class ReminderSources {
  private pending: Promise<SourceFacts> | null = null;
  constructor(
    private s: CoreServices,
    private info: SystemInfoService,
    private read: JsonReader = readPublicJson,
  ) {}
  cached(): SourceFacts {
    return (this.s.settings.getRaw('reminders.sources') as SourceFacts) ?? { at: 0, cloudflare: null, servers: [] };
  }
  async refresh(): Promise<SourceFacts> {
    const old = this.cached();
    const token = this.s.dnsAccount.token();
    const subject = token ? createHash('sha256').update(token).digest('hex') : null;
    if (Date.now() - old.at < DAY && old.cloudflare?.subject === subject) return old;
    if (!token && !old.cloudflare && Date.now() - old.at < DAY) return old;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const next: SourceFacts = { at: Date.now(), cloudflare: null, servers: [] };
      if (token && subject) {
        const prior = old.cloudflare?.subject === subject ? old.cloudflare : null;
        next.cloudflare = prior ?? { subject, expires: null, invalid: false, error: null };
        try {
          const headers = { authorization: `Bearer ${token}` };
          let response = token.startsWith('cfat_')
            ? { status: 403, body: null }
            : await this.read('https://api.cloudflare.com/client/v4/user/tokens/verify', headers);
          // Account-owned tokens need their account endpoint. Zone Read is already required by DNS.
          if ([400, 401, 403].includes(response.status)) {
            const zones = await this.read('https://api.cloudflare.com/client/v4/zones?per_page=5', headers);
            if (zones.status === 200) {
              const doc = z
                .object({
                  success: z.literal(true),
                  result: z.array(z.object({ account: z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }) })),
                })
                .parse(zones.body);
              const account = doc.result[0]?.account.id;
              if (!account) throw new Error('No account visible');
              response = await this.read(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, headers);
              if (response.status !== 200) throw new Error('Token verification unavailable');
            } else if (![401, 403].includes(zones.status)) throw new Error('Cloudflare unavailable');
          }
          if ([401, 403].includes(response.status))
            next.cloudflare = { ...next.cloudflare, invalid: true, error: 'Cloudflare token was refused' };
          else {
            if (response.status !== 200) throw new Error('Cloudflare unavailable');
            const doc = z
              .object({
                success: z.literal(true),
                result: z.object({ status: z.string(), expires_on: z.iso.datetime({ offset: true }).nullish() }),
              })
              .parse(response.body);
            const expiry = doc.result.expires_on;
            next.cloudflare = {
              subject,
              expires: expiry && Number.isFinite(Date.parse(expiry)) ? new Date(expiry).toISOString().slice(0, 10) : null,
              invalid: doc.result.status !== 'active',
              error: null,
            };
          }
        } catch {
          next.cloudflare = { ...next.cloudflare, error: 'Token check failed. Keeping the last known date.' };
        }
      }
      for (const server of this.s.servers.listRows()) {
        const info = await this.info.describe(server.id);
        const prior = old.servers.find((r) => r.id === server.id);
        next.servers.push(
          info.reachable
            ? { id: server.id, os: info.os, release: osRelease(info.os), error: null }
            : { id: server.id, os: prior?.os ?? null, release: prior?.release ?? null, error: 'Server unavailable' },
        );
      }
      this.s.settings.setRaw('reminders.sources', next);
      return next;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}
