// @docs servers/add
import { PassThrough, Readable, Writable } from 'node:stream';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { servers, sites } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { JobContext } from '../context.js';
import { PluginSyncService } from '../../services/pluginSync.js';
import { CLOUDFLARE } from '../../services/dns.js';
import { limitsChange, siteRuntimeFrom, type SiteRuntime } from '../../services/siteSpec.js';
import { ServerUnreachableError, SshConnection } from '../../servers/sshConnection.js';
import { shellQuote } from '../../servers/sshExec.js';
import { readPanelPrivateKey, readPanelPublicKey } from '../../servers/keys.js';
import { hostExec } from '../../lib/exec.js';
import { PANEL_VERSION } from '../../lib/version.js';
import { hostedSites } from '../../lib/siteKind.js';

export const serverSyncPluginsPayload = z.object({
  serverId: z.number().int(),
});

export async function serverSyncPlugins(
  ctx: JobContext<z.infer<typeof serverSyncPluginsPayload>>,
  s: CoreServices,
): Promise<void> {
  const handle = s.servers.handleFor(ctx.payload.serverId);
  ctx.info(`Syncing plugin zips to "${handle.name}"…`);
  const sync = new PluginSyncService(s.db, s.config, s.servers);
  const { pushed, skipped } = await sync.syncAllToServer(ctx.payload.serverId, (m) => ctx.info(m));
  ctx.info(`Plugin sync done (${pushed} pushed, ${skipped} already up to date).`);
  ctx.setResult({ pushed, skipped });
}

// ---------------------------------------------------------------------------

export const serverApplySiteLimitsPayload = z.object({
  serverId: z.number().int(),
});

const describeLimits = (l: SiteRuntime): string =>
  [
    l.nanoCpus ? `${l.nanoCpus / 1e9} CPU core(s)` : 'no CPU cap',
    `${Math.round(l.memoryBytes / 1024 / 1024)} MB of memory`,
    l.pidsLimit ? `${l.pidsLimit} processes` : 'no process cap',
  ].join(', ');

/**
 * Bring every site container on one server to the CPU, memory and process ceilings in
 * Settings, which otherwise only reach a container when it is built. In place, running or
 * stopped, so no site goes down for it - except to lift a CPU cap, which Docker cannot do to
 * an existing container: those sites are queued a Recreate container of their own. A site
 * that already has a job waiting cannot be queued another, so it is recorded as `deferred`
 * and Schedulers.siteLimitsTick comes back for it once that job has run.
 *
 * The limits are read when this starts, not when it was queued, so a second save made while
 * it waited is applied as well. It holds the server's lane, so no container on the server is
 * being rebuilt from the previous settings while it runs.
 */
export async function serverApplySiteLimits(
  ctx: JobContext<z.infer<typeof serverApplySiteLimitsPayload>>,
  s: CoreServices,
): Promise<void> {
  const handle = s.servers.handleFor(ctx.payload.serverId);
  const limits = siteRuntimeFrom(s.settings);
  // Mid-create or mid-delete: the create builds from the settings as they are when it runs.
  const rows = s.db
    .select()
    .from(sites)
    .where(and(eq(sites.serverId, handle.id), hostedSites()))
    .orderBy(asc(sites.id))
    .all()
    .filter((site) => site.status !== 'provisioning' && site.status !== 'deleting');
  ctx.info(`Applying ${describeLimits(limits)} to the ${rows.length} site(s) on "${handle.name}"…`);

  const updated: string[] = [];
  const recreating: string[] = [];
  const deferred: string[] = [];
  const failed: string[] = [];
  let current = 0;
  for (const [i, site] of rows.entries()) {
    ctx.checkCanceled();
    try {
      const now = await handle.docker.containerLimits(site.containerName);
      // No container to change; whatever builds one reads the settings then.
      if (!now) continue;
      const change = limitsChange(now, limits);
      if (change === 'none') {
        current++;
      } else if (change === 'in-place') {
        await handle.docker.updateContainerLimits(site.containerName, limits);
        updated.push(site.slug);
      } else {
        // Typically queued behind this job in the same lane - a restart, a backup.
        const busy = s.worker.activeSiteJob(site.id);
        if (busy) {
          ctx.warn(
            `${site.slug}: a CPU cap only comes off with a new container, and the site is busy with ` +
              `job #${busy.id} (${busy.type}) - it is recreated once that has run.`,
          );
          deferred.push(site.slug);
          continue;
        }
        // Runs after this job, in the same lane.
        const job = s.worker.enqueue(
          'site.reconcile',
          { siteId: site.id },
          { id: site.id, slug: site.slug, serverId: site.serverId },
        );
        ctx.info(`${site.slug}: a CPU cap only comes off with a new container - recreating it (job #${job.id}).`);
        recreating.push(site.slug);
      }
    } catch (err) {
      ctx.warn(`${site.slug}: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof ServerUnreachableError) {
        // Every site after this one would wait out the same SSH timeout.
        failed.push(...rows.slice(i).map((r) => r.slug));
        break;
      }
      failed.push(site.slug);
    }
  }

  // `deferred` is what siteLimitsTick reads back.
  ctx.setResult({ updated, recreating, deferred, current, failed });
  ctx.info(
    `${updated.length} updated in place, ${current} already current` +
      (recreating.length > 0 ? `, ${recreating.length} being recreated` : '') +
      (deferred.length > 0 ? `, ${deferred.length} to be recreated after their own job` : '') +
      '.',
  );
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} site(s) kept their previous limits: ${failed.join(', ')}. ` +
        'Recreate container on each applies the current ones.',
    );
  }
}

// ---------------------------------------------------------------------------

export const serverProvisionPayload = z.object({
  serverId: z.number().int(),
  rootUser: z.string(),
  acmeEmail: z.string(),
});

/**
 * The release this panel is running, in the form `provision/setup.sh` reads it.
 *
 * A worker has no checkout, no `.git` and no release of its own, so it defaults to image mode
 * with an empty version - and setup.sh refuses that, deliberately, because it will not invent
 * a version. This is the only place the answer exists. It is sent on every provision run, not
 * just the first: "Update" on a worker means "make this machine match the panel", and the
 * fleet is only homogeneous if the worker's version moves when the panel's does.
 */
export function releaseIdentity(config: CoreServices['config']): string {
  // A panel compiled on the box has no published image to hand anyone. Its workers build
  // their site images from the pushed Dockerfile, exactly as they did before image mode.
  // The version is recorded but never used there - a worker has no panel, and cannot derive
  // one either, since the bundle it is given has no panel/package.json in it. It is the
  // answer to "which panel build pushed this", which is otherwise unanswerable on the box.
  if (config.source === 'build') return `WPL7_SOURCE=build\nWPL7_VERSION=${PANEL_VERSION}\n`;
  const lines = [
    'WPL7_SOURCE=image',
    `WPL7_VERSION=${PANEL_VERSION}`,
    // The tag is not the version on edge, where every build is published as the moving
    // `edge` while calling itself 0.3.0-edge.<commit>. .env normally says so outright; the
    // fallback is the same rule update.sh applies when it writes it.
    `WPL7_IMAGE_TAG=${config.imageTag || (config.channel === 'edge' ? 'edge' : PANEL_VERSION)}`,
    `WPL7_CHANNEL=${config.channel}`,
    `WPL7_REPO=${config.updateRepo}`,
  ];
  // Only when this install actually overrides it. An empty value written here would have
  // the worker pull `<registry>/wordpress:php8.3-` instead of falling back to setup.sh's
  // own default.
  if (config.wordpressImage) lines.push(`WPL7_WORDPRESS_IMAGE=${config.wordpressImage}`);
  return lines.join('\n') + '\n';
}

/** Entries pushed to the server (explicit list - never the whole repo or a .env). */
const BUNDLE_ENTRIES = [
  'provision',
  'deploy/docker-compose.yml',
  'deploy/docker-compose.worker.yml',
  'deploy/.env.example',
  'deploy/wordpress-image',
];

/**
 * A provision canceled while still queued never touched the machine. Leaving the row on
 * `provisioning` made the server unusable with no hint that nothing had happened; `error`
 * is what "Update / retry" and Remove act on.
 */
export function serverProvisionQueuedCancel(payload: z.infer<typeof serverProvisionPayload>, s: CoreServices): void {
  const row = s.servers.rowById(payload.serverId);
  if (!row || row.status !== 'provisioning') return;
  s.db
    .update(servers)
    .set({
      status: 'error',
      lastError: 'Provisioning was canceled before it started - retry it (Update) or remove the server',
      updatedAt: Date.now(),
    })
    .where(eq(servers.id, row.id))
    .run();
  s.log.info(`Server "${row.name}": provisioning canceled before it started`);
}

/**
 * Blank Ubuntu VPS -> running worker stack, driven entirely over SSH as root:
 * push the baked provision bundle, run setup.sh --role=worker (streaming its output
 * into the job log), then verify via the regular wpl7-panel channel and sync plugins.
 * Idempotent - setup.sh is guarded, so Retry/Update re-runs are safe.
 */
export async function serverProvision(
  ctx: JobContext<z.infer<typeof serverProvisionPayload>>,
  s: CoreServices,
): Promise<void> {
  const row = s.servers.rowById(ctx.payload.serverId);
  if (!row) throw new Error(`Server #${ctx.payload.serverId} no longer exists`);
  if (row.kind !== 'ssh') throw new Error('The local server cannot be provisioned over SSH');

  try {
    await provisionOverSsh(ctx, s, row);
  } catch (err) {
    s.db
      .update(servers)
      .set({
        status: 'error',
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        updatedAt: Date.now(),
      })
      .where(eq(servers.id, row.id))
      .run();
    throw err;
  }
}

async function provisionOverSsh(
  ctx: JobContext<z.infer<typeof serverProvisionPayload>>,
  s: CoreServices,
  row: NonNullable<ReturnType<CoreServices['servers']['rowById']>>,
): Promise<void> {
  const conn = new SshConnection(
    {
      serverId: row.id,
      serverName: row.name,
      host: row.sshHost ?? '',
      port: row.sshPort,
      username: ctx.payload.rootUser,
      privateKey: () => readPanelPrivateKey(s.config),
      pinnedHostKey: () => s.servers.rowById(row.id)?.hostKeySha256 ?? null,
      onHostKeyCaptured: (fp) => {
        s.db.update(servers).set({ hostKeySha256: fp, updatedAt: Date.now() }).where(eq(servers.id, row.id)).run();
        ctx.info(`Pinned host key ${fp}`);
      },
    },
    (m) => ctx.warn(m),
  );

  try {
    ctx.info(`Connecting to ${ctx.payload.rootUser}@${row.sshHost}:${row.sshPort}…`);
    const who = await conn.exec('id -u', { timeoutMs: 30_000 });
    if (who.exitCode !== 0 || who.stdout.trim() !== '0') {
      throw new Error(
        who.exitCode !== 0
          ? `SSH command failed: ${who.stderr.trim().slice(0, 200)}`
          : `Connected as uid ${who.stdout.trim()}, but provisioning needs root. ` +
            `Add the panel's SSH key to root's authorized_keys (VPS providers inject account keys at creation).`,
      );
    }
    ctx.checkCanceled();

    ctx.info('Pushing provisioning files to /opt/wpl7…');
    const pipe = new PassThrough();
    await Promise.all([
      hostExec
        .runToStream('tar', ['-C', s.config.provisionBundle, '-cf', '-', ...BUNDLE_ENTRIES], pipe, {
          timeoutMs: 5 * 60_000,
        })
        // Checked, not assumed: a local tar that dies part-way still produces a stream the
        // remote extracts happily, so ignoring this leg turns a partial bundle into a
        // "successful" push and setup.sh then runs against missing files.
        .then((res) => {
          if (res.exitCode !== 0) {
            throw new Error(`bundling the provision files failed (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`);
          }
        }),
      conn
        .exec(
          // LEGACY(ceo) - delete the move in 0.3.0. A worker provisioned before the rename
          // holds this server's `deploy/.env` at the old path, and that file is the only
          // copy of its MariaDB root password. Extracting the bundle somewhere else would
          // leave setup.sh writing a fresh .env and every site on the box unable to reach
          // its database.
          'if [ -d /opt/ceo-server ] && [ ! -d /opt/wpl7 ]; then mv /opt/ceo-server /opt/wpl7; fi; ' +
            'mkdir -p /opt/wpl7 && tar -xf - -C /opt/wpl7',
          { input: pipe, timeoutMs: 5 * 60_000 },
        )
        .then((res) => {
          if (res.exitCode !== 0) throw new Error(`push failed (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`);
        }),
    ]);
    ctx.checkCanceled();

    // setup.sh reads and then deletes this; it is how the machine learns what to install.
    const release = releaseIdentity(s.config);
    const recorded = await conn.exec('cat > /opt/wpl7/.wpl7-install', {
      input: Readable.from([release]),
      timeoutMs: 60_000,
    });
    if (recorded.exitCode !== 0) {
      throw new Error(`could not record the release on the server: ${recorded.stderr.trim().slice(0, 300)}`);
    }
    ctx.info(`This worker will run: ${release.trim().split('\n').join(', ')}`);

    const publicKey = readPanelPublicKey(s.config);
    const args = [
      '/opt/wpl7/provision/setup.sh',
      '--role=worker',
      '--non-interactive',
      `--dev-domain=${row.devDomain}`,
      `--panel-key=${publicKey}`,
      // setup.sh enables a default-deny firewall; it must know the port this very
      // connection (and every later one) uses, or a non-22 sshd is cut off for good.
      `--ssh-port=${row.sshPort}`,
    ];
    // Update/retry runs carry no address (only the initial "Add server" call does). Passing
    // `--acme-email=` anyway made setup.sh reject the empty value whenever the first attempt
    // had died before writing .env; omitting it lets setup.sh reuse the .env it already has,
    // and fail with its own clear prompt when there is none.
    if (ctx.payload.acmeEmail) args.push(`--acme-email=${ctx.payload.acmeEmail}`);
    // Not Cloudflare's token: the panel gives every server's Traefik a copy of its own, kept in
    // step with Settings -> DNS (services/traefikDns.ts, below). Another provider's still goes
    // into the worker's .env - when it is the provider this install's .env has a token for.
    const dnsToken =
      row.dnsProvider && row.dnsProvider !== CLOUDFLARE && row.dnsProvider === s.config.dnsProvider ? s.config.otherDnsToken : '';
    if (row.dnsProvider) {
      args.push(`--dns-provider=${row.dnsProvider}`);
      if (dnsToken) args.push('--dns-token-stdin');
    }

    ctx.info('Running setup.sh --role=worker (Docker install + stack boot; several minutes on first run)…');
    // Setup output streams into the job log; the DNS token travels over stdin, never argv.
    // stderr is merged into it, so the reason for a failure is the last line it printed.
    let lineBuf = '';
    let lastLine = '';
    const logLine = (line: string) => {
      const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!trimmed) return;
      ctx.info(trimmed);
      lastLine = trimmed.trim();
    };
    const logSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) logLine(line);
        cb();
      },
    });
    const setupRes = await conn.exec(`bash ${shellQuote(args)} 2>&1`, {
      input: Readable.from([dnsToken ? dnsToken + '\n' : '\n']),
      stdout: logSink,
      timeoutMs: 25 * 60_000,
    });
    logLine(lineBuf);
    if (setupRes.exitCode !== 0) {
      const reason = setupRes.stderr.trim() || lastLine;
      throw new Error(`setup.sh failed (exit ${setupRes.exitCode}): ${reason.slice(0, 500)}`);
    }
    ctx.checkCanceled();
  } finally {
    conn.close();
  }

  ctx.info('Verifying the server through the regular panel channel (wpl7-panel user)…');
  s.servers.invalidate(row.id);
  const { ok, checks } = await s.servers.verify(row.id, {
    defaultPhpVersion: s.settings.get('defaultPhpVersion'),
  });
  for (const c of checks) ctx.log(c.ok ? 'info' : 'error', `check ${c.name}: ${c.detail}`);
  if (!ok) {
    s.db
      .update(servers)
      .set({ status: 'error', lastError: 'post-provision verification failed', updatedAt: Date.now() })
      .where(eq(servers.id, row.id))
      .run();
    throw new Error('Provisioning finished but verification failed - see the checks above; Retry is safe');
  }

  const sync = new PluginSyncService(s.db, s.config, s.servers);
  const { pushed } = await sync.syncAllToServer(row.id, (m) => ctx.info(m));

  s.db.update(servers).set({ status: 'ok', updatedAt: Date.now() }).where(eq(servers.id, row.id)).run();
  // In the server's queue of syncs, so a token changed meanwhile cannot restart Traefik twice.
  await s.traefikDns.kick(row.id);
  const traefik = s.traefikDns.statusOf(row.id);
  if (traefik.state === 'error') {
    ctx.warn(`Traefik's copy of the Cloudflare token could not be put in place (${traefik.message}); the panel tries again every minute.`);
  } else if (s.dnsAccount.token()) {
    ctx.info('Traefik has its copy of the Cloudflare token, for the wildcard certificate (Settings -> DNS).');
  }
  const fresh = s.servers.rowById(row.id)!;
  ctx.info(`Server "${row.name}" is ready (${fresh.publicIp}).`);
  ctx.setResult({ serverId: row.id, publicIp: fresh.publicIp, pluginsPushed: pushed, checks });
}

