import type { z } from 'zod';
import { z as zod } from 'zod';
import type { JobType } from '../../shared/schemas.js';
import type { CoreServices } from '../services/index.js';
import type { JobContext } from './context.js';
import {
  siteChangePhp,
  siteReconcile,
  siteReconcilePayload,
  siteChangePhpPayload,
  siteCreate,
  siteCreatePayload,
  siteCreateQueuedCancel,
  siteDelete,
  siteDeletePayload,
  siteIdPayload,
  siteRestart,
  siteStart,
  siteStop,
  siteUpdateDomains,
  siteUpdateDomainsPayload,
} from './handlers/sites.js';
import {
  backupCreate,
  backupCreatePayload,
  backupDelete,
  backupDeletePayload,
  backupRestore,
  backupRestorePayload,
} from './handlers/backups.js';
import {
  backupFetch,
  backupFetchPayload,
  backupOffsite,
  backupOffsitePayload,
  backupOffsitePurge,
  backupOffsitePurgePayload,
  panelSnapshot,
  panelSnapshotPayload,
} from './handlers/offsite.js';
import { serverRelocateBackups, serverRelocateBackupsPayload } from './handlers/storage.js';
import {
  wpBulkTask,
  wpBulkTaskPayload,
  wpCoreUpdate,
  wpCoreUpdatePayload,
  wpRecipes,
  wpRecipesPayload,
  wpPluginTask,
  wpPluginTaskPayload,
  wpScanAll,
  wpScanAllPayload,
  wpThemeTask,
  wpThemeTaskPayload,
} from './handlers/wp.js';
import {
  serverApplySiteLimits,
  serverApplySiteLimitsPayload,
  serverProvision,
  serverProvisionPayload,
  serverProvisionQueuedCancel,
  serverSyncPlugins,
  serverSyncPluginsPayload,
} from './handlers/servers.js';
import { siteMove, siteMoveFinalize, siteMoveFinalizePayload, siteMovePayload } from './handlers/move.js';
import { siteImport, siteImportFinish, siteImportFinishPayload, siteImportPayload, siteImportQueuedCancel } from './handlers/import.js';
import { systemPostUpdate, systemPostUpdatePayload } from './handlers/systemUpdate.js';
import { filesCompress, filesCompressPayload, filesExtract, filesExtractPayload } from './handlers/files.js';
import { siteShell, siteShellPayload, wpCli, wpCliPayload, wpRest, wpRestPayload } from './handlers/exec.js';
import { housekeepingPayload, systemHousekeeping } from './handlers/housekeeping.js';
import { pluginZipCheck, pluginZipCheckPayload, siteMalwareScan, siteMalwareScanPayload, wpReinstall, wpReinstallPayload } from './handlers/security.js';

export interface RegistryEntry<TSchema extends z.ZodType = z.ZodType> {
  payloadSchema: TSchema;
  handler: (ctx: JobContext<z.infer<TSchema>>, services: CoreServices) => Promise<void>;
  timeoutMs?: number;
  /** Synchronous undo of state the enqueueing request reserved, when the job is canceled before it ran. */
  onQueuedCancel?: (payload: z.infer<TSchema>, services: CoreServices) => void;
}

const entry = <TSchema extends z.ZodType>(
  payloadSchema: TSchema,
  handler: (ctx: JobContext<z.infer<TSchema>>, services: CoreServices) => Promise<void>,
  timeoutMs?: number,
  onQueuedCancel?: (payload: z.infer<TSchema>, services: CoreServices) => void,
): RegistryEntry<TSchema> => ({ payloadSchema, handler, timeoutMs, onQueuedCancel });

// Only tests queue it. `stepMs` lets one that just needs a job to have run skip the wait.
const demoPayload = zod.object({
  steps: zod.number().int().min(1).max(20).default(3),
  stepMs: zod.number().int().min(0).max(1000).default(200),
});

// Partial: entries land with their milestone; the worker rejects unknown types at run time.
const registry: Partial<Record<JobType, RegistryEntry>> = {
  demo: entry(demoPayload, async (ctx) => {
    for (let i = 1; i <= ctx.payload.steps; i++) {
      ctx.checkCanceled();
      ctx.info(`Demo step ${i}/${ctx.payload.steps}`);
      await new Promise((r) => setTimeout(r, ctx.payload.stepMs));
    }
    ctx.setResult({ steps: ctx.payload.steps });
  }, 60_000) as RegistryEntry,
  'site.create': entry(siteCreatePayload, siteCreate, 30 * 60_000, siteCreateQueuedCancel) as RegistryEntry,
  'site.delete': entry(siteDeletePayload, siteDelete, 60 * 60_000) as RegistryEntry,
  'site.start': entry(siteIdPayload, siteStart, 5 * 60_000) as RegistryEntry,
  'site.stop': entry(siteIdPayload, siteStop, 5 * 60_000) as RegistryEntry,
  'site.restart': entry(siteIdPayload, siteRestart, 5 * 60_000) as RegistryEntry,
  'site.changePhp': entry(siteChangePhpPayload, siteChangePhp, 20 * 60_000) as RegistryEntry,
  'site.reconcile': entry(siteReconcilePayload, siteReconcile, 20 * 60_000) as RegistryEntry,
  'site.updateDomains': entry(siteUpdateDomainsPayload, siteUpdateDomains, 20 * 60_000) as RegistryEntry,
  'backup.create': entry(backupCreatePayload, backupCreate, 60 * 60_000) as RegistryEntry,
  'backup.restore': entry(backupRestorePayload, backupRestore, 60 * 60_000) as RegistryEntry,
  // Twelve hours: a first backfill of a year of backups over a domestic uplink is a real
  // thing to ask for, and the lane means nothing else is waiting on it.
  'backup.offsite': entry(backupOffsitePayload, backupOffsite, 12 * 3600_000) as RegistryEntry,
  'backup.fetch': entry(backupFetchPayload, backupFetch, 12 * 3600_000) as RegistryEntry,
  'backup.offsitePurge': entry(backupOffsitePurgePayload, backupOffsitePurge, 6 * 3600_000) as RegistryEntry,
  // Each backup at a destination is one rclone purge; hundreds of them, at several
  // destinations, is hours rather than minutes.
  'backup.delete': entry(backupDeletePayload, backupDelete, 6 * 3600_000) as RegistryEntry,
  'panel.snapshot': entry(panelSnapshotPayload, panelSnapshot, 10 * 60_000) as RegistryEntry,
  'wp.coreUpdate': entry(wpCoreUpdatePayload, wpCoreUpdate, 20 * 60_000) as RegistryEntry,
  'wp.pluginTask': entry(wpPluginTaskPayload, wpPluginTask, 10 * 60_000) as RegistryEntry,
  'wp.themeTask': entry(wpThemeTaskPayload, wpThemeTask, 10 * 60_000) as RegistryEntry,
  // Long: a bulk run can take a pre-update backup, update thirty plugins and probe the
  // site afterwards, all inside this one job.
  'wp.bulkTask': entry(wpBulkTaskPayload, wpBulkTask, 30 * 60_000) as RegistryEntry,
  // A fleet pass touches every running site on every server; the per-site work is small
  // but the sum of it on a big install is not.
  'wp.scanAll': entry(wpScanAllPayload, wpScanAll, 60 * 60_000) as RegistryEntry,
  // A few wp-cli calls per plugin, each a round trip to a vendor's licensing server.
  'wp.recipes': entry(wpRecipesPayload, wpRecipes, 15 * 60_000) as RegistryEntry,
  // A big archive is minutes of work; the exec inside has its own 30-minute deadline.
  'files.extract': entry(filesExtractPayload, filesExtract, 35 * 60_000) as RegistryEntry,
  'files.compress': entry(filesCompressPayload, filesCompress, 35 * 60_000) as RegistryEntry,
  'server.syncPlugins': entry(serverSyncPluginsPayload, serverSyncPlugins, 10 * 60_000) as RegistryEntry,
  'server.provision': entry(serverProvisionPayload, serverProvision, 30 * 60_000, serverProvisionQueuedCancel) as RegistryEntry,
  'server.relocateBackups': entry(serverRelocateBackupsPayload, serverRelocateBackups, 12 * 3600_000) as RegistryEntry,
  'server.applySiteLimits': entry(serverApplySiteLimitsPayload, serverApplySiteLimits, 10 * 60_000) as RegistryEntry,
  'site.move': entry(siteMovePayload, siteMove, 180 * 60_000) as RegistryEntry,
  'site.moveFinalize': entry(siteMoveFinalizePayload, siteMoveFinalize, 15 * 60_000) as RegistryEntry,
  // A whole day: a big site over a slow old host is hours of requests, in a lane of its own.
  'site.import': entry(siteImportPayload, siteImport, 24 * 3600_000, siteImportQueuedCancel) as RegistryEntry,
  // Bounded like a restore: everything it reads is on the server already.
  'site.importFinish': entry(siteImportFinishPayload, siteImportFinish, 60 * 60_000) as RegistryEntry,
  // Lane-less: it queues per-server work rather than doing any, so holding a server's lane
  // would only stop the jobs it just created from starting.
  'system.postUpdate': entry(systemPostUpdatePayload, systemPostUpdate, 30 * 60_000) as RegistryEntry,
  // A command carries its own 1-60 minute limit, enforced by `timeout` inside the container;
  // this is only the backstop behind it.
  'wp.cli': entry(wpCliPayload, wpCli, 65 * 60_000) as RegistryEntry,
  'site.shell': entry(siteShellPayload, siteShell, 65 * 60_000) as RegistryEntry,
  // The same 1-60 minutes, as curl's own --max-time.
  'wp.rest': entry(wpRestPayload, wpRest, 65 * 60_000) as RegistryEntry,
  // Its own `housekeeping` lane: pruning must neither wait behind an hour-long fleet scan in
  // the lane-less queue nor hold that queue up.
  'system.housekeeping': entry(housekeepingPayload, systemHousekeeping, 60 * 60_000) as RegistryEntry,
  // The scan keeps to `scan.timeoutMin` (at most four hours) itself; this is the backstop.
  'site.malwareScan': entry(siteMalwareScanPayload, siteMalwareScan, 5 * 3600_000) as RegistryEntry,
  // One zip, unpacked and scanned once; the scan's own time limit applies inside.
  'plugin.zipCheck': entry(pluginZipCheckPayload, pluginZipCheck, 2 * 3600_000) as RegistryEntry,
  // A download of WordPress or one plugin; WP-CLI's own call has a ten-minute deadline.
  'wp.reinstall': entry(wpReinstallPayload, wpReinstall, 15 * 60_000) as RegistryEntry,
};

export function getRegistry(): Partial<Record<JobType, RegistryEntry>> {
  return registry;
}

/**
 * Payload fields a job needs while it runs and nobody needs after: what a command was handed on
 * stdin (a password for `--prompt`, a prompt for WP Godmode) and a REST request's application
 * password. The worker drops them from the stored payload once the job has ended - succeeded,
 * failed, canceled or cut short by a restart - so they do not sit in panel.db, and in every panel
 * snapshot copied offsite, for as long as finished jobs are kept.
 */
export const SECRET_PAYLOAD_KEYS: Partial<Record<JobType, readonly string[]>> = {
  'wp.cli': ['stdin'],
  'wp.rest': ['auth'],
};

/**
 * Jobs that start, stop or replace their site's container, or change its WordPress code (an
 * update holds the site in maintenance mode while it runs). While one runs, the uptime check
 * leaves the site alone, and the site is checked as the job ends (MonitorService.holdChecks).
 * Without it, a check that landed in a container swap read Traefik's 404, and the site page
 * said Offline - offering a repair - for a site that was only going live, until the next check
 * a minute later.
 */
export const SITE_INTERRUPTING_JOBS: ReadonlySet<JobType> = new Set<JobType>([
  'site.create',
  'site.start',
  'site.stop',
  'site.restart',
  'site.changePhp',
  'site.reconcile',
  'site.updateDomains',
  'site.move',
  'site.importFinish',
  'backup.restore',
  'wp.coreUpdate',
  'wp.pluginTask',
  'wp.themeTask',
  'wp.bulkTask',
]);
