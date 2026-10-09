// @docs panel/settings, plugins/updates, sites/external
import { and, eq, inArray } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { alertStates, siteConnections, sites, vulnNotices, type AlertStateRow, type SiteConnectionRow, type SiteRow } from '../db/schema.js';
import { panelUrl } from '../lib/panelUrl.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import type { VulnFinding, WpInventoryService } from './wpInventory.js';

/**
 * Emails about sites, to the alert address in Settings (MailService.notifyOperator): a site that
 * stopped answering and came back, a new vulnerability, a backup that failed, and for sites
 * hosted elsewhere a plugin that stopped answering and a certificate about to expire. Each kind
 * has a switch in Settings → Monitoring. Without an address they are only logged.
 *
 * What was said is kept in the database (`alert_states`, `vuln_notices`), so a restart neither
 * repeats an alert nor misses a recovery.
 */

/** Failed probes in a row before a site counts as down: three minutes at the default interval. */
export const DOWN_AFTER = 3;
/** Hourly checks of WPL7 Connect that failed in a row before it counts as unreachable. */
export const CONNECTOR_AFTER = 3;
/** A certificate this close to expiring is worth an email; one renewed beyond RENEWED is fine again. */
const CERT_WARN_MS = 7 * 24 * 3600_000;
const CERT_RENEWED_MS = 14 * 24 * 3600_000;
/** At most one failed-backup email per site in this long. */
const BACKUP_QUIET_MS = 24 * 3600_000;
/** Raw errors in an email are cut here. */
const MAX_ERROR = 500;

export interface AlertDeps {
  db: Db;
  config: Config;
  settings: SettingsService;
  mail: { notifyOperator(subject: string, body: string): Promise<boolean> };
  wpInventory: Pick<WpInventoryService, 'findings'>;
  log: Logger;
}

interface DownDetail {
  fails: number;
  /** The alert was due: sent, or logged for want of an address. */
  raised?: boolean;
  status?: number | null;
  error?: string | null;
}

const clip = (text: string) => (text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR)}…` : text);

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** "12 min", "3 h 5 min", "2 days" */
export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export class AlertService {
  constructor(private readonly s: AlertDeps) {}

  private enabled(key: 'alertsSiteDown' | 'alertsVulnerabilities' | 'alertsBackups' | 'alertsConnector'): boolean {
    return this.s.settings.get(key) !== false;
  }

  private state(key: string): AlertStateRow | undefined {
    return this.s.db.select().from(alertStates).where(eq(alertStates.key, key)).get();
  }

  private put(row: typeof alertStates.$inferInsert): void {
    this.s.db.insert(alertStates).values(row).onConflictDoUpdate({ target: alertStates.key, set: row }).run();
  }

  private drop(key: string): void {
    this.s.db.delete(alertStates).where(eq(alertStates.key, key)).run();
  }

  /** Where a site's page is, for the last line of an email. */
  private pageOf(site: SiteRow): string {
    const base = panelUrl(this.s.config);
    return base ? `${base}/sites/${site.slug}` : `Sites → ${site.slug}`;
  }

  /** The address a person knows the site by. */
  private addressOf(site: SiteRow): string {
    if (site.kind === 'external') {
      const home = this.s.db.select({ home: siteConnections.homeUrl }).from(siteConnections).where(eq(siteConnections.siteId, site.id)).get()?.home;
      if (home) return home;
    }
    return (JSON.parse(site.domains) as string[])[0] ?? site.slug;
  }

  private async send(subject: string, lines: string[]): Promise<boolean> {
    try {
      return await this.s.mail.notifyOperator(subject, lines.join('\n'));
    } catch (err) {
      this.s.log.warn(`Alert not sent (${subject}): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * One uptime probe of a site, hosted or not, that actually ran. Down after DOWN_AFTER failures
   * in a row; back up at the first good answer after an alert went out.
   */
  async probed(site: SiteRow, reading: { ok: boolean; status: number | null; error?: string | null }): Promise<void> {
    const key = `down:${site.id}`;
    const row = this.state(key);
    const detail: DownDetail = row?.detail ? (JSON.parse(row.detail) as DownDetail) : { fails: 0 };
    if (reading.ok) {
      if (!row) return;
      this.drop(key);
      if (row.notifiedAt && this.enabled('alertsSiteDown')) {
        await this.send(`${site.title} is back up`, [
          `${this.addressOf(site)} answers again. It was down for ${duration(Date.now() - row.since)}, from ${utc(row.since)}.`,
          '',
          this.pageOf(site),
        ]);
      }
      return;
    }
    const now = Date.now();
    const next: DownDetail = { ...detail, fails: detail.fails + 1, status: reading.status, error: reading.error ?? null };
    let notifiedAt = row?.notifiedAt ?? null;
    if (next.fails >= DOWN_AFTER && !detail.raised) {
      next.raised = true;
      if (this.enabled('alertsSiteDown')) {
        const what = reading.status !== null ? `HTTP ${reading.status}` : `no answer${reading.error ? `: ${clip(reading.error)}` : ''}`;
        const sent = await this.send(`${site.title} is down`, [
          `${this.addressOf(site)} did not answer the panel's last ${next.fails} checks (${what}).`,
          `The first failed check was at ${utc(row?.since ?? now)}.`,
          '',
          this.pageOf(site),
        ]);
        if (sent) notifiedAt = now;
      }
    }
    this.put({ key, siteId: site.id, since: row?.since ?? now, notifiedAt, detail: JSON.stringify(next) });
  }

  /** A backup job that failed: one email per site a day at most. */
  async backupFailed(site: SiteRow, error: string): Promise<void> {
    if (!this.enabled('alertsBackups')) return;
    const key = `backup:${site.id}`;
    const row = this.state(key);
    const now = Date.now();
    if (row?.notifiedAt && now - row.notifiedAt < BACKUP_QUIET_MS) return;
    const sent = await this.send(`The backup of ${site.title} failed`, [
      `The backup of ${this.addressOf(site)} failed at ${utc(now)}:`,
      clip(error),
      '',
      'Another failure in the next 24 hours sends no email; the Backups tab shows every attempt.',
      '',
      this.pageOf(site),
    ]);
    this.put({ key, siteId: site.id, since: row?.since ?? now, notifiedAt: sent ? now : (row?.notifiedAt ?? null), detail: clip(error) });
  }

  /** The hourly check of WPL7 Connect on a site hosted elsewhere. */
  async connectorChecked(site: SiteRow, conn: SiteConnectionRow): Promise<void> {
    const key = `connector:${site.id}`;
    const row = this.state(key);
    if (conn.failCount === 0) {
      if (!row) return;
      this.drop(key);
      if (row.notifiedAt && this.enabled('alertsConnector')) {
        await this.send(`WPL7 Connect on ${site.title} answers again`, [
          `The panel reaches ${this.addressOf(site)} again, after ${duration(Date.now() - row.since)}.`,
          '',
          this.pageOf(site),
        ]);
      }
      return;
    }
    if (conn.failCount < CONNECTOR_AFTER || row) return;
    const now = Date.now();
    const since = conn.lastContactAt ?? now;
    let notifiedAt: number | null = null;
    if (this.enabled('alertsConnector')) {
      const sent = await this.send(`WPL7 Connect on ${site.title} does not answer`, [
        `The panel could not reach WPL7 Connect on ${this.addressOf(site)} in its last ${conn.failCount} hourly checks.`,
        conn.lastError ? `The last answer: ${clip(conn.lastError)}` : '',
        '',
        "Until it answers, the site gets no backups and no updates. Check that the site is up and the plugin active; if the plugin was replaced, reconnect the site from its Settings tab.",
        '',
        this.pageOf(site),
      ].filter((line, i, all) => line !== '' || all[i - 1] !== ''));
      if (sent) notifiedAt = now;
    }
    this.put({ key, siteId: site.id, since, notifiedAt, detail: conn.lastError ? clip(conn.lastError) : null });
  }

  /** The certificate the uptime probe saw on a site hosted elsewhere. */
  async certificate(site: SiteRow, expiresAt: number | null): Promise<void> {
    if (expiresAt === null) return;
    const key = `cert:${site.id}`;
    const row = this.state(key);
    const left = expiresAt - Date.now();
    if (row && left > CERT_RENEWED_MS) {
      this.drop(key);
      return;
    }
    if (row || left > CERT_WARN_MS) return;
    const now = Date.now();
    let notifiedAt: number | null = null;
    if (this.enabled('alertsConnector')) {
      const sent = await this.send(`The certificate of ${site.title} expires ${left <= 0 ? 'now' : `in ${duration(left)}`}`, [
        `The TLS certificate of ${this.addressOf(site)} ${left <= 0 ? 'expired' : 'expires'} at ${utc(expiresAt)}. Visitors then see a warning instead of the site.`,
        'Renew it where the site is hosted.',
        '',
        this.pageOf(site),
      ]);
      if (sent) notifiedAt = now;
    }
    this.put({ key, siteId: site.id, since: now, notifiedAt, detail: String(expiresAt) });
  }

  /**
   * After a scan pass or a feed refresh: one email naming every vulnerability no email has named
   * yet, by site. The first pass names everything vulnerable at that moment. A finding that is
   * gone (updated, removed) is forgotten, so if it comes back it is new again.
   */
  async vulnerabilities(siteIds?: number[]): Promise<number> {
    const findings = this.s.wpInventory.findings(siteIds);
    const rows = this.s.db
      .select()
      .from(sites)
      .where(siteIds ? inArray(sites.id, siteIds) : undefined)
      .all()
      .filter((site) => site.status !== 'deleting' && site.status !== 'provisioning');
    const known = this.s.db
      .select()
      .from(vulnNotices)
      .where(siteIds ? inArray(vulnNotices.siteId, siteIds) : undefined)
      .all();
    const noticeKey = (siteId: number, f: { kind: string; slug: string; advisory: string }) => `${siteId}|${f.kind}|${f.slug}|${f.advisory}`;
    const said = new Set(known.map((n) => noticeKey(n.siteId, n)));
    const now = new Set<string>();
    const fresh: { site: SiteRow; findings: VulnFinding[] }[] = [];
    for (const site of rows) {
      const list = findings.get(site.id) ?? [];
      const newOnes = list.filter((f) => {
        const k = noticeKey(site.id, f);
        now.add(k);
        return !said.has(k);
      });
      if (newOnes.length > 0) fresh.push({ site, findings: newOnes });
    }
    // Gone now: forgotten, so a regression is news again.
    for (const n of known) {
      if (now.has(noticeKey(n.siteId, n))) continue;
      this.s.db
        .delete(vulnNotices)
        .where(and(eq(vulnNotices.siteId, n.siteId), eq(vulnNotices.kind, n.kind), eq(vulnNotices.slug, n.slug), eq(vulnNotices.advisory, n.advisory)))
        .run();
    }
    if (fresh.length === 0) return 0;
    const count = fresh.reduce((n, f) => n + f.findings.length, 0);
    let sent = true;
    if (this.enabled('alertsVulnerabilities')) {
      const lines: string[] = [];
      for (const { site, findings: list } of fresh) {
        lines.push(`${site.title} (${this.addressOf(site)}):`);
        for (const f of list) {
          const what = f.kind === 'core' ? `WordPress ${f.version}` : `${f.title} ${f.version}`;
          const fix = f.advisory === 'closed' ? 'closed on wordpress.org, no fix will come' : f.fixedIn ? `fixed in ${f.fixedIn}` : 'no fix yet';
          lines.push(`  - ${what}: ${f.advisoryTitle}${f.severity ? ` (${f.severity})` : ''}; ${fix}`);
        }
        lines.push(`  ${this.pageOf(site)}`, '');
      }
      sent = await this.send(count === 1 ? 'A new vulnerability on your sites' : `${count} new vulnerabilities on your sites`, lines);
    }
    // Recorded once it was said (or it would say it every pass), and when alerts are off: switching
    // them on later does not mail a backlog.
    if (sent || !this.enabled('alertsVulnerabilities')) {
      const at = Date.now();
      for (const { site, findings: list } of fresh) {
        for (const f of list) {
          this.s.db.insert(vulnNotices).values({ siteId: site.id, kind: f.kind, slug: f.slug, advisory: f.advisory, notifiedAt: at }).onConflictDoNothing().run();
        }
      }
    }
    return count;
  }
}
