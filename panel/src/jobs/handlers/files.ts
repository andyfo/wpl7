import { z } from 'zod';
import type { CoreServices } from '../../services/index.js';
import type { JobContext } from '../context.js';
import { loadSite } from './shared.js';
import { requireRunning } from './wp.js';

/**
 * Zip archives in the Files tab. Jobs rather than requests because an archive can take
 * minutes, and because the job log is where its progress - and, when it is refused, the
 * entries that were in the way - end up. The work itself runs inside the site's container
 * as www-data, like every other file operation (services/siteFiles.ts).
 */

export const filesExtractPayload = z.object({
  siteId: z.number().int(),
  path: z.string(),
  to: z.string(),
  overwrite: z.boolean(),
});

export async function filesExtract(ctx: JobContext<z.infer<typeof filesExtractPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const { path, to, overwrite } = ctx.payload;
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    ctx.info(`Extracting ${path} into ${to === '' ? 'the site folder' : to}${overwrite ? ', replacing existing files' : ''}…`);
    const result = await server.siteFiles.extractZip(site.containerName, { path, to, overwrite }, ctx.info);
    ctx.info(
      `Extracted ${result.files} files and ${result.folders} folders (${result.bytes} bytes)` +
        (result.skipped ? `; skipped ${result.skipped} symlinks or reserved names` : ''),
    );
    ctx.setResult({ ...result });
  } finally {
    await restoreState();
  }
}

export const filesCompressPayload = z.object({
  siteId: z.number().int(),
  paths: z.array(z.string()).min(1),
  to: z.string(),
  overwrite: z.boolean(),
});

export async function filesCompress(ctx: JobContext<z.infer<typeof filesCompressPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const { paths, to, overwrite } = ctx.payload;
  const restoreState = await requireRunning(ctx, server, s, site);
  try {
    ctx.info(`Compressing ${paths.length === 1 ? paths[0] : `${paths.length} entries`} into ${to}…`);
    const result = await server.siteFiles.compressZip(site.containerName, { paths, to, overwrite }, ctx.info);
    ctx.info(
      `Wrote ${to}: ${result.files} files, ${result.folders} folders (${result.bytes} bytes before compression)` +
        (result.skipped ? `; left out ${result.skipped} symlinks or unreadable entries` : ''),
    );
    ctx.setResult({ ...result, archive: to });
  } finally {
    await restoreState();
  }
}
