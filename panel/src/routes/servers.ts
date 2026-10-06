// @docs servers/add
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { backups, moveCleanups, servers, serverStats } from '../db/schema.js';
import {
  backupRelocateBody,
  serverCreateBody,
  serverDeleteQuery,
  serverInfoQuery,
  serverStorageQuery,
  serverUpdateBody,
} from '../../shared/schemas.js';
import { backupRootProblem, normalizeAbsolutePath } from '../../shared/backupRoot.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { jobToDto, serverToDto, viewerOf } from '../lib/dto.js';
import { readPanelPublicKey } from '../servers/keys.js';
import { CLOUDFLARE } from '../services/dns.js';
import { sweepWildcardSites, wildcardProblem } from '../services/wildcardSites.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export function registerServerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/servers', async () => ({
    items: deps.servers.listRows().map((row) => serverToDto(row, deps.servers.sitesCountFor(row.id))),
  }));

  r.get('/api/servers/ssh-public-key', async () => {
    try {
      return { publicKey: readPanelPublicKey(deps.config) };
    } catch {
      return { publicKey: null };
    }
  });

  r.get('/api/servers/:id', { schema: { params: idParams } }, async (req) => {
    const row = deps.servers.rowById(req.params.id);
    if (!row) throw notFound(`Server #${req.params.id} not found`);
    return serverToDto(row, deps.servers.sitesCountFor(row.id));
  });

  r.post('/api/servers', { schema: { body: serverCreateBody } }, async (req, reply) => {
    const body = req.body;
    for (const existing of deps.servers.listRows()) {
      if (existing.name === body.name) throw conflict(`Server name "${body.name}" is already taken`);
      if (existing.kind === 'ssh' && existing.sshHost === body.sshHost && existing.sshPort === body.sshPort) {
        throw conflict(`${body.sshHost}:${body.sshPort} is already registered as "${existing.name}"`);
      }
    }
    // Only a wildcard certificate the token can get (Settings -> DNS). Without it the server
    // starts with a certificate per site, and is switched over there once the token reaches its
    // dev domain's records - adding a server is not refused over an optional certificate.
    let dnsProvider = body.dnsProvider;
    if (dnsProvider === CLOUDFLARE) {
      // Not registered yet, so no Traefik of its own to read: the token and the zone only.
      const problem = await wildcardProblem(deps, { id: 0, devDomain: body.devDomain }, dnsProvider);
      if (problem) {
        deps.log.warn(`Server "${body.name}" starts without a wildcard certificate. ${problem}`);
        dnsProvider = '';
      }
    }
    const now = Date.now();
    const row = deps.db
      .insert(servers)
      .values({
        name: body.name,
        kind: 'ssh',
        sshHost: body.sshHost,
        sshPort: body.sshPort,
        sshUser: body.sshUser,
        publicIp: body.publicIp ?? '',
        devDomain: body.devDomain,
        dnsProvider,
        status: body.provision ? 'provisioning' : 'ok',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    if (body.provision) {
      if (!body.acmeEmail) {
        deps.db.delete(servers).where(eq(servers.id, row.id)).run();
        throw badRequest('acmeEmail is required when provisioning a blank server');
      }
      // Blank VPS: connect as root and run the provisioner; verification happens inside the job.
      const job = deps.worker.enqueue(
        'server.provision',
        { serverId: row.id, rootUser: body.rootUser, acmeEmail: body.acmeEmail },
        undefined,
        { serverId: row.id },
      );
      return reply
        .status(202)
        .header('location', `/api/jobs/${job.id}`)
        .send({ server: serverToDto(row, 0), job: jobToDto(job, viewerOf(req)) });
    }

    // Already-provisioned server: verify now; only keep the row when the checks pass.
    const { ok, checks } = await deps.servers.verify(row.id, {
      defaultPhpVersion: deps.settings.get('defaultPhpVersion'),
    });
    if (!ok) {
      deps.servers.invalidate(row.id);
      deps.db.delete(servers).where(eq(servers.id, row.id)).run();
      return reply
        .status(502)
        .send({ error: { code: 'bad_gateway', message: 'Server verification failed', details: { checks } } });
    }
    const job = deps.worker.enqueue('server.syncPlugins', { serverId: row.id }, undefined, { serverId: row.id });
    // Its Traefik's copy of the Cloudflare token (Settings -> DNS), now rather than at the next tick.
    void deps.traefikDns.kick(row.id);
    const fresh = deps.servers.rowById(row.id)!;
    return reply.status(201).send({ server: serverToDto(fresh, 0), checks, job: jobToDto(job, viewerOf(req)) });
  });

  /**
   * What the machine itself is: OS, kernel, CPU, memory, uptime, Docker. Cached for a
   * minute behind the service, so the detail page can ask for it on every mount.
   */
  r.get(
    '/api/servers/:id/info',
    { schema: { params: idParams, querystring: serverInfoQuery } },
    async (req) => deps.serverInfo.describe(req.params.id, { refresh: req.query.refresh }),
  );

  /**
   * Where this server keeps its backups, what disk that is, how full it is, and which
   * filesystems it has to offer. `?path=` validates a candidate instead, which is what the
   * Storage form's live validation calls on every keystroke.
   */
  r.get('/api/servers/:id/storage', { schema: { params: idParams, querystring: serverStorageQuery } }, async (req) =>
    deps.storage.describe(req.params.id, req.query.path),
  );

  /**
   * Move the backups that are already on this server to a new location, then point the
   * server at it. A job, not a request: it is a verified copy of every backup on the disk.
   */
  r.post(
    '/api/servers/:id/backups/relocate',
    { schema: { params: idParams, body: backupRelocateBody } },
    async (req, reply) => {
      const row = deps.servers.rowById(req.params.id);
      if (!row) throw notFound(`Server #${req.params.id} not found`);
      const problem = backupRootProblem(req.body.to, deps.config.srvRoot);
      if (problem) throw badRequest(problem);
      const job = deps.worker.enqueue(
        'server.relocateBackups',
        { serverId: row.id, to: normalizeAbsolutePath(req.body.to.trim()) },
        undefined,
        { serverId: row.id },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  r.post('/api/servers/:id/test', { schema: { params: idParams } }, async (req) => {
    const row = deps.servers.rowById(req.params.id);
    if (!row) throw notFound(`Server #${req.params.id} not found`);
    return deps.servers.verify(row.id, { defaultPhpVersion: deps.settings.get('defaultPhpVersion') });
  });

  // Re-push the provision bundle + re-run setup.sh (idempotent) - stack updates and provision retries.
  const updateBody = z.object({ rootUser: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('root') }).strict();
  r.post('/api/servers/:id/update', { schema: { params: idParams, body: updateBody } }, async (req, reply) => {
    const row = deps.servers.rowById(req.params.id);
    if (!row) throw notFound(`Server #${req.params.id} not found`);
    if (row.kind === 'local') throw badRequest('The local server updates via git pull + setup.sh (see docs)');
    const job = deps.worker.enqueue(
      'server.provision',
      { serverId: row.id, rootUser: req.body.rootUser, acmeEmail: '' },
      undefined,
      { serverId: row.id },
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.patch('/api/servers/:id', { schema: { params: idParams, body: serverUpdateBody } }, async (req) => {
    const row = deps.servers.rowById(req.params.id);
    if (!row) throw notFound(`Server #${req.params.id} not found`);
    const body = req.body;
    // retrustHostKey stays allowed for the local row: the web terminal TOFU-pins the
    // host key of server 1 too, and after an OS reinstall that pin must be clearable.
    if (row.kind === 'local' && (body.sshHost || body.sshPort || body.sshUser)) {
      throw badRequest('The local server has no SSH settings');
    }
    if (body.name && body.name !== row.name) {
      const taken = deps.servers.listRows().some((s) => s.id !== row.id && s.name === body.name);
      if (taken) throw conflict(`Server name "${body.name}" is already taken`);
    }
    // The wildcard certificate, as Settings -> DNS switches it (routes/dns.ts): only where the
    // server's Traefik can answer the challenge - for Cloudflare, with a token reaching the zone's records.
    // Asked when it is switched on, and when the dev domain under one in force changes.
    const nextProvider = body.dnsProvider ?? row.dnsProvider;
    const nextDevDomain = body.devDomain ?? row.devDomain;
    const switchedOn = nextProvider !== '' && nextProvider !== row.dnsProvider;
    const movedUnder = nextDevDomain !== row.devDomain && deps.dns.wildcardProvider(nextProvider) !== '';
    if (switchedOn || movedUnder) {
      const problem = await wildcardProblem(deps, { id: row.id, devDomain: nextDevDomain }, nextProvider);
      if (problem) throw conflict(`"${row.name}" can't use a wildcard certificate. ${problem}`, { reason: problem });
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of ['name', 'sshHost', 'sshPort', 'sshUser', 'publicIp', 'devDomain', 'dnsProvider'] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.retrustHostKey) patch.hostKeySha256 = null;
    deps.db.update(servers).set(patch).where(eq(servers.id, row.id)).run();
    deps.servers.invalidate(row.id);
    // FTP's passive mode hands clients this address; a gateway still announcing the old one
    // would send every data connection somewhere else.
    if (body.publicIp !== undefined && body.publicIp !== row.publicIp) void deps.ftp.recheck(row.id);
    // Switched off: the dev sites sharing the wildcard certificate are rebuilt onto certificates
    // of their own (services/wildcardSites.ts).
    if (body.dnsProvider !== undefined && body.dnsProvider !== row.dnsProvider) {
      await sweepWildcardSites(deps, deps.worker, [row.id]);
    }
    // Last, and on its own: it creates the directory and probes it for writability, and a
    // failure there must not roll back the rest of the edit (or be lost in it).
    if (body.backupRoot !== undefined) await deps.storage.setRoot(row.id, body.backupRoot);
    return serverToDto(deps.servers.rowById(row.id)!, deps.servers.sitesCountFor(row.id));
  });

  r.delete('/api/servers/:id', { schema: { params: idParams, querystring: serverDeleteQuery } }, async (req, reply) => {
    const row = deps.servers.rowById(req.params.id);
    if (!row) throw notFound(`Server #${req.params.id} not found`);
    if (row.id === 1) throw conflict('The local server cannot be removed');
    const sitesCount = deps.servers.sitesCountFor(row.id);
    if (sitesCount > 0) throw conflict(`Server hosts ${sitesCount} site(s); move or delete them first`);
    // A parked source copy from a move still lives on this machine; deleting the server
    // strands the container, database and files with nothing left that knows how to
    // remove them (and the daily auto-finalize would keep queueing jobs for a server
    // that no longer resolves).
    const stranded = deps.db
      .select({ slug: moveCleanups.siteSlug })
      .from(moveCleanups)
      .where(and(eq(moveCleanups.sourceServerId, row.id), eq(moveCleanups.status, 'pending')))
      .all();
    if (stranded.length > 0) {
      throw conflict(
        `${stranded.length} moved site(s) still have their old copy parked here ` +
          `(${stranded.map((c) => c.slug).join(', ')}). Finalize those moves first ` +
          `("Finalize move" on the site page), then remove the server.`,
      );
    }

    const backupRows = deps.db.select({ id: backups.id }).from(backups).where(eq(backups.serverId, row.id)).all();
    if (backupRows.length > 0 && !req.query.force) {
      throw conflict(
        `${backupRows.length} backup(s) still live on this server. ` +
          `Delete them, or pass ?force=true to drop the records (files on the server are left untouched).`,
      );
    }
    // While the panel can still reach it: a gateway left running there would keep every
    // login's password hash, and nothing would ever come back to remove it.
    const ftpLeft = await deps.ftp.forgetServer(row.id);
    deps.servers.invalidate(row.id);
    deps.db.transaction(() => {
      if (backupRows.length > 0) deps.db.delete(backups).where(eq(backups.serverId, row.id)).run();
      // server_stats references servers(id) with no ON DELETE, and the monitor writes a
      // row per server per minute - so without this the DELETE below always failed the
      // foreign-key check (500) once the server had been registered for a minute.
      deps.db.delete(serverStats).where(eq(serverStats.serverId, row.id)).run();
      deps.db.delete(servers).where(eq(servers.id, row.id)).run();
    });
    return reply.send({
      removed: row.name,
      note:
        `To revoke the panel's access, remove its key from ~${row.sshUser}/.ssh/authorized_keys on ${row.sshHost}.` +
        (ftpLeft ? ` ${ftpLeft}` : ''),
    });
  });
}
