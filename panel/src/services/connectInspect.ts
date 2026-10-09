// @docs sites/external
import { z } from 'zod';
import type { ConnectSourceDto, ConnectWarning } from '../../shared/types.js';
import { slugify } from '../lib/slug.js';
import { migrateReportSchema } from './importInspect.js';

/**
 * What the panel makes of a site that WPL7 Connect reported (docs/internal/connect-protocol.md,
 * section 5): the report checked and capped, the warnings the Confirm step shows, and what its
 * fields start with. Pure: no database, no network.
 */

const text = (max = 2000) => z.string().max(max);

/** The import's report, without what only a move needs, and with what managing the site needs. */
export const connectReportSchema = migrateReportSchema.extend({
  admins: z
    .array(z.object({ id: z.coerce.number().int().positive(), login: text(200), name: text(300).default('') }).loose())
    .max(50)
    .default([]),
  fs_method: text(32).default('direct'),
  file_mods: z.boolean().default(true),
  loader: z.boolean().default(false),
  commands: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(200).default([]),
});
export type ConnectReport = z.infer<typeof connectReportSchema>;

/** The major and minor of a PHP version: 8.3.35 → 8.3. */
export function phpMinor(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version.slice(0, 16);
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** What the Confirm step tells the admin about the site. */
export function connectWarnings(report: ConnectReport, opts: { allowHttp: boolean }): ConnectWarning[] {
  const out: ConnectWarning[] = [];
  if (report.multisite) {
    out.push({ code: 'multisite', blocking: true, message: 'This is a multisite network. WPL7 Connect manages single sites only.' });
  }
  if (report.windows) {
    out.push({ code: 'windows', blocking: true, message: 'The site runs on a Windows server, which WPL7 Connect does not support.' });
  }
  if (!report.file_mods) {
    out.push({ code: 'file_mods', blocking: false, message: 'Updates are switched off on this site (DISALLOW_FILE_MODS in wp-config.php).' });
  } else if (report.fs_method !== 'direct') {
    out.push({ code: 'fs_method', blocking: false, message: 'Updates need FTP details in wp-config.php: WordPress cannot write its own files here.' });
  }
  if (!report.loader) {
    out.push({ code: 'loader', blocking: false, message: 'Rollback after a broken update is off: wp-content/mu-plugins is not writable.' });
  }
  if (!report.home.startsWith('https://')) {
    out.push({
      code: 'http',
      blocking: !opts.allowHttp,
      message: opts.allowHttp ? 'The site has no HTTPS: backups and logins can be read on their way.' : 'The site has no HTTPS.',
    });
  }
  return out;
}

/** The first warning that stops the site being added, as a sentence. */
export function blockingReason(warnings: ConnectWarning[]): string | null {
  return warnings.find((w) => w.blocking)?.message ?? null;
}

/** The site as the UI shows it: what the report says. */
export function connectSourceOf(r: ConnectReport): ConnectSourceDto {
  return {
    home: r.home,
    title: r.title,
    wpVersion: r.wp,
    phpVersion: r.php,
    tablePrefix: r.table_prefix,
    locale: r.locale,
    https: r.home.startsWith('https://'),
    files: { count: r.files.count, bytes: r.files.bytes, partial: r.files.partial },
    db: { server: r.db.server, bytes: r.db.bytes, tables: r.db.tables.length },
    plugins: r.plugins.length,
    theme: r.theme ? { slug: r.theme.slug, name: r.theme.name } : null,
    pluginVersion: r.plugin,
    admins: r.admins.map((a) => ({ id: a.id, login: a.login, name: a.name })),
    fsMethod: r.fs_method,
    fileMods: r.file_mods,
    loader: r.loader,
    commands: r.commands,
  };
}

/** A name for the site in the panel, from its address: free, and allowed. */
export function suggestSlug(home: string, taken: (slug: string) => boolean): string {
  const base = slugify(hostOf(home)) || 'site';
  const stem = base.length >= 3 ? base : `${base}-site`;
  if (!taken(stem)) return stem;
  for (let n = 2; n < 100; n++) {
    const candidate = `${stem.slice(0, 29)}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return stem;
}
