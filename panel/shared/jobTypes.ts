import type { JobCategory, JobType } from './schemas.js';

/**
 * What every job type is called and what it does, in words an operator reads.
 *
 * The ids (`wp.scanAll`) are an API contract and stay as they are; this is what the Jobs page,
 * the job detail and `GET /api/jobs/types` show instead. `satisfies Record<JobType, …>` makes
 * a new job type without a name and a description a type error rather than a raw id on screen.
 */
export interface JobTypeInfo {
  label: string;
  /** One to three sentences: what the job does, not how. */
  description: string;
  category: JobCategory;
  /** Never queued by a person (tests only); left out of the filters. */
  internal?: boolean;
}

export const JOB_TYPE_INFO = {
  demo: {
    label: 'Demo job',
    description: 'A job that only logs a few steps. The test suite uses it; nothing in the panel queues it.',
    category: 'system',
    internal: true,
  },
  'site.create': {
    label: 'Create site',
    description:
      "Creates the site's database and container, installs WordPress, and applies the plugins and recipes chosen on the New site form.",
    category: 'sites',
  },
  'site.delete': {
    label: 'Delete site',
    description: "Removes the site's container, database and files, after a final backup when one was asked for.",
    category: 'sites',
  },
  'site.start': {
    label: 'Start site',
    description: "Starts the site's container.",
    category: 'sites',
  },
  'site.stop': {
    label: 'Stop site',
    description: "Stops the site's container. The site does not answer until it is started again.",
    category: 'sites',
  },
  'site.restart': {
    label: 'Restart site',
    description: "Restarts the site's container.",
    category: 'sites',
  },
  'site.changePhp': {
    label: 'Change PHP version',
    description: "Recreates the site's container on another PHP version. Files and database stay as they are.",
    category: 'sites',
  },
  'site.reconcile': {
    label: 'Recreate site container',
    description:
      "Recreates the site's container so it runs under the current isolation policy: its networks, its container capabilities and what it may send mail as.",
    category: 'sites',
  },
  'site.updateDomains': {
    label: 'Change domains',
    description: "Changes the site's hostnames - going live, adding or removing a domain - and updates WordPress's own URLs to match.",
    category: 'sites',
  },
  'site.move': {
    label: 'Move site',
    description:
      'Copies the site to another server and switches its traffic over. The old copy is parked until every hostname points at the new server.',
    category: 'sites',
  },
  'site.moveFinalize': {
    label: 'Finish move',
    description: 'Removes the copy a move parked on the old server, once every hostname resolves to the new one.',
    category: 'sites',
  },
  'site.shell': {
    label: 'Shell command',
    description: "Runs a shell command inside the site's container as www-data and keeps its output in the job log.",
    category: 'sites',
  },
  'backup.create': {
    label: 'Back up site',
    description: "Dumps the site's database and archives its files into a new backup.",
    category: 'backups',
  },
  'backup.restore': {
    label: 'Restore backup',
    description:
      "Replaces the site's files and database with a backup, after a safety copy of the current state unless that was skipped.",
    category: 'backups',
  },
  'backup.offsite': {
    label: 'Offsite copy',
    description: 'Uploads a backup to every offsite destination that should hold it.',
    category: 'backups',
  },
  'backup.fetch': {
    label: 'Fetch offsite backup',
    description: 'Downloads a backup back from an offsite destination, so it can be restored.',
    category: 'backups',
  },
  'backup.offsitePurge': {
    label: 'Empty offsite destination',
    description: "Deletes this panel's copies from an offsite destination.",
    category: 'backups',
  },
  'backup.delete': {
    label: 'Delete backups',
    description:
      'Deletes several backups at once: their files on the server and their copies at the remote destinations. A backup that is in use is left alone and named in the log.',
    category: 'backups',
  },
  'panel.snapshot': {
    label: 'Panel snapshot',
    description:
      "Backs up the panel's own database - servers, sites, domains, DKIM keys - which is what a fleet is rebuilt from.",
    category: 'backups',
  },
  'wp.coreUpdate': {
    label: 'Update WordPress',
    description: 'Updates WordPress itself on the site, then re-reads what the site has installed.',
    category: 'wordpress',
  },
  'wp.pluginTask': {
    label: 'Plugin change',
    description: 'Installs, activates, deactivates, updates or deletes one plugin on the site.',
    category: 'wordpress',
  },
  'wp.themeTask': {
    label: 'Theme change',
    description: 'Activates, updates or deletes one theme on the site.',
    category: 'wordpress',
  },
  'wp.bulkTask': {
    label: 'WordPress updates',
    description:
      "Runs a list of plugin, theme and core operations on one site in one go, optionally after a backup and with a check that the site still answers. Bulk runs and update schedules both use it.",
    category: 'wordpress',
  },
  'wp.scanAll': {
    label: 'WordPress inventory scan',
    description:
      'Asks every running site which plugins, themes and WordPress version it has and what has an update, then checks the installed versions against the vulnerability feed.',
    category: 'wordpress',
  },
  'wp.recipes': {
    label: 'Plugin recipes',
    description: 'Runs the recipes that license and set up premium plugins on the site.',
    category: 'wordpress',
  },
  'wp.cli': {
    label: 'WP-CLI command',
    description: "Runs a WP-CLI command inside the site's container and keeps its output in the job log.",
    category: 'wordpress',
  },
  'wp.rest': {
    label: 'REST API request',
    description:
      "Sends a request to one of the site's WordPress REST API routes (/wp-json/…), signed in with an application password when it has one, and keeps the response in the job log. Anything but a 2xx answer fails the job.",
    category: 'wordpress',
  },
  'files.extract': {
    label: 'Extract archive',
    description: "Unpacks an archive among the site's files.",
    category: 'files',
  },
  'files.compress': {
    label: 'Compress files',
    description: "Packs files and folders of the site into a zip archive.",
    category: 'files',
  },
  'server.provision': {
    label: 'Set up server',
    description: "Installs or updates the server's stack: Docker services, Traefik, MariaDB and the mail relay.",
    category: 'servers',
  },
  'server.syncPlugins': {
    label: 'Sync plugin library',
    description: "Copies the panel's plugin zips to the server, so sites on it can install them.",
    category: 'servers',
  },
  'server.applySiteLimits': {
    label: 'Apply container limits',
    description:
      'Brings every site container on the server to the CPU, memory and process limits in Settings, in place, without a restart. Lifting a CPU cap is the exception: those sites each get a "Recreate site container" job.',
    category: 'servers',
  },
  'server.relocateBackups': {
    label: 'Move backups',
    description: "Copies a server's backups to a new location, verifies them, and points the server at it.",
    category: 'servers',
  },
  'system.postUpdate': {
    label: 'Finish panel update',
    description: 'What a panel update leaves for the new version to do: bringing servers and sites up to what it expects.',
    category: 'system',
  },
  'system.housekeeping': {
    label: 'Nightly housekeeping',
    description:
      'Prunes old backups, statistics, mail and API logs and finished jobs, applies offsite retention, finishes moved sites whose DNS has settled and refreshes the vulnerability feed.',
    category: 'system',
  },
  'site.malwareScan': {
    label: 'Malware scan',
    description:
      "Checks a site's files against wordpress.org's published checksums, then looks for known malware in what those cannot vouch for. Runs in a throwaway container with no network that can only read the site.",
    category: 'security',
  },
  'plugin.zipCheck': {
    label: 'Plugin zip check',
    description:
      "Unpacks a zip from the plugin catalog in a throwaway container with no network, records each file's hash and scans the files for known malware. Sites that hold its files unchanged have them vouched for.",
    category: 'security',
  },
  'wp.reinstall': {
    label: 'Reinstall original',
    description:
      "Downloads WordPress or a plugin again from wordpress.org, at the version the site has, over files a malware scan found changed. Then scans the site again.",
    category: 'security',
  },
} as const satisfies Record<JobType, JobTypeInfo>;

export const JOB_CATEGORY_LABELS: Record<JobCategory, string> = {
  sites: 'Sites',
  backups: 'Backups',
  wordpress: 'WordPress',
  files: 'Files',
  security: 'Security',
  servers: 'Servers',
  system: 'Panel',
};

const INFO: Record<string, JobTypeInfo> = JOB_TYPE_INFO;

/** The type's name; an id this build does not know (a newer panel's job) is shown as is. */
export function jobLabel(type: string): string {
  return INFO[type]?.label ?? type;
}

export function jobInfo(type: string): JobTypeInfo | null {
  return INFO[type] ?? null;
}

/** Job types whose label contains `q`, case-insensitively - what a search for "backup" means. */
export function typesMatching(q: string): JobType[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return (Object.keys(JOB_TYPE_INFO) as JobType[]).filter((t) => INFO[t]!.label.toLowerCase().includes(needle));
}

export function typesInCategories(categories: readonly JobCategory[]): JobType[] {
  const wanted = new Set(categories);
  return (Object.keys(JOB_TYPE_INFO) as JobType[]).filter((t) => wanted.has(INFO[t]!.category));
}
