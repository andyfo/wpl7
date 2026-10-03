import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupCopies, backupDestinations, backups, sites } from '../../src/db/schema.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

async function authedApp() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  return { app, world, headers };
}

const S3 = {
  name: 'bucket',
  provider: 's3',
  config: { accessKeyId: 'AKIA', region: 'eu-central-1', bucket: 'b', prefix: 'panel.example.com' },
  secrets: { secretAccessKey: 'sekrit' },
};

/** A complete backup row with a completed copy, without touching a filesystem. */
function seedBackupWithCopy(world: TestWorld, destinationId: number) {
  const site = world.db
    .insert(sites)
    .values({
      slug: 'demo',
      title: 'Demo',
      domains: JSON.stringify(['demo.dev.example.test']),
      phpVersion: '8.3',
      status: 'running',
      dbName: 'wp_demo',
      dbUser: 'wp_demo',
      dbPassword: 'pw',
      containerName: 'wp-demo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  const backup = world.db
    .insert(backups)
    .values({
      siteId: site.id,
      siteSlug: site.slug,
      serverId: 1,
      type: 'scheduled',
      status: 'complete',
      path: `${world.config.paths.backups}/demo/20260920-030000`,
      rootPath: world.config.paths.backups,
      sizeBytes: 1024,
      createdAt: Date.now(),
    })
    .returning()
    .get();
  const copy = world.db
    .insert(backupCopies)
    .values({
      backupId: backup.id,
      destinationId,
      status: 'complete',
      remotePath: 'b/panel.example.com/demo/20260920-030000',
      completedAt: Date.now(),
      createdAt: Date.now(),
    })
    .returning()
    .get();
  return { site, backup, copy };
}

describe('backup destinations API', () => {
  it('creates a destination and never returns its credentials', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto).toMatchObject({ name: 'bucket', provider: 's3', enabled: true, retentionMode: 'panel' });
    expect(dto.config).toMatchObject({ bucket: 'b', prefix: 'panel.example.com' });
    // Which secrets are set, never what they are.
    expect(dto.secretsSet).toEqual(['secretAccessKey']);
    expect(JSON.stringify(dto)).not.toContain('sekrit');

    const list = await app.inject({ method: 'GET', url: '/api/backup-destinations', headers });
    expect(JSON.stringify(list.json())).not.toContain('sekrit');
  });

  it('rejects an incomplete configuration with a sentence, not a stack trace', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup-destinations',
      headers,
      payload: { ...S3, secrets: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Secret access key is required.');
  });

  it('rejects a field the provider does not define', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup-destinations',
      headers,
      payload: { ...S3, config: { ...S3.config, container: 'azure-ism' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps an omitted secret and clears one sent empty', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/backup-destinations/${created.id}`,
      headers,
      payload: { config: { bucket: 'other' }, retentionScheduled: 90 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ retentionScheduled: 90, secretsSet: ['secretAccessKey'] });
    expect(patched.json().config.bucket).toBe('other');
    expect(world.offsite.secretsOf(world.offsite.byId(created.id)).secretAccessKey).toBe('sekrit');

    // An explicit empty string is how a credential is removed - and then it is incomplete.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/backup-destinations/${created.id}`,
      headers,
      payload: { secrets: { secretAccessKey: '' } },
    });
    expect(cleared.statusCode).toBe(400);
  });

  it('refuses to change the provider of an existing destination', async () => {
    const { app, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/backup-destinations/${created.id}`,
      headers,
      payload: { provider: 'sftp' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/cannot be changed/);
  });

  it('removing a destination leaves the objects alone unless asked otherwise', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    seedBackupWithCopy(world, created.id);

    const res = await app.inject({ method: 'DELETE', url: `/api/backup-destinations/${created.id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: 'bucket', forgotten: 1 });
    expect(world.db.select().from(backupDestinations).all()).toHaveLength(0);
    // Nothing was purged: no rclone container ran.
    expect(world.docker.calls.filter((c) => c.method === 'runEphemeral')).toHaveLength(0);
  });

  it('?deleteRemote=true hands the purge to a job instead of doing it in the request', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    seedBackupWithCopy(world, created.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/backup-destinations/${created.id}?deleteRemote=true`,
      headers,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().job.type).toBe('backup.offsitePurge');
    // Still there until the job says otherwise.
    expect(world.db.select().from(backupDestinations).all()).toHaveLength(1);
  });

  it('lists a destination\'s copies for the failures view', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    seedBackupWithCopy(world, created.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/backup-destinations/${created.id}/copies?status=complete`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0]).toMatchObject({ siteSlug: 'demo', backupType: 'scheduled', status: 'complete' });
  });

  it('the overview drives the Backups page and the Dashboard line', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const { copy } = seedBackupWithCopy(world, created.id);
    world.db
      .update(backupCopies)
      .set({ status: 'failed', error: 'AccessDenied', attempts: 4 })
      .where(eq(backupCopies.id, copy.id))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/backups/overview', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().destinations).toHaveLength(1);
    expect(res.json().last24h.failed).toBe(1);
    expect(res.json().failures[0]).toMatchObject({ destinationName: 'bucket', error: 'AccessDenied' });
  });

  it('meta says whether offsite is configured at all, so the UI can stay out of the way', async () => {
    const { app, headers } = await authedApp();
    expect((await app.inject({ method: 'GET', url: '/api/meta', headers })).json().offsiteConfigured).toBe(false);
    await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 });
    expect((await app.inject({ method: 'GET', url: '/api/meta', headers })).json().offsiteConfigured).toBe(true);
  });

  it('a site can be taken out of the offsite copies', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    seedBackupWithCopy(world, created.id);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/demo/offsite-enabled',
      headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().offsiteEnabled).toBe(false);
    // Copies already made are kept: switching off means "stop sending new ones".
    expect(world.db.select().from(backupCopies).all()).toHaveLength(1);
  });
});

describe('backup deletion with offsite copies', () => {
  it('deletes everywhere by default and purges the remote first', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const { backup } = seedBackupWithCopy(world, created.id);

    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${backup.id}`, headers });
    expect(res.statusCode).toBe(204);
    expect(world.db.select().from(backups).all()).toHaveLength(0);
    const purge = world.docker.calls
      .filter((c) => c.method === 'runEphemeral')
      .map((c) => (c.args[0] as { cmd: string[] }).cmd.join(' '));
    expect(purge.some((cmd) => cmd.includes('rclone purge'))).toBe(true);
  });

  it('?keepOffsite=true frees the disk and leaves the archive', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const { backup } = seedBackupWithCopy(world, created.id);

    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${backup.id}?keepOffsite=true`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keptOffsite: 1 });
    const row = world.db.select().from(backups).where(eq(backups.id, backup.id)).get()!;
    expect(row.filesPresent).toBe(0);
    expect(world.db.select().from(backupCopies).all()).toHaveLength(1);
  });

  it('refuses ?keepOffsite=true when there is no offsite copy to keep', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const { backup, copy } = seedBackupWithCopy(world, created.id);
    world.db.update(backupCopies).set({ status: 'pending' }).where(eq(backupCopies.id, copy.id)).run();

    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${backup.id}?keepOffsite=true`, headers });
    expect(res.statusCode).toBe(400);
    expect(world.db.select().from(backups).all()).toHaveLength(1);
  });

  it('will not download or restore a backup that is only offsite', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const { backup } = seedBackupWithCopy(world, created.id);
    world.db.update(backups).set({ filesPresent: 0 }).where(eq(backups.id, backup.id)).run();

    const download = await app.inject({ method: 'GET', url: `/api/backups/${backup.id}/download`, headers });
    expect(download.statusCode).toBe(409);
    expect(download.json().error.message).toMatch(/fetch it back/);

    const restore = await app.inject({
      method: 'POST',
      url: `/api/backups/${backup.id}/restore`,
      headers,
      payload: {},
    });
    expect(restore.statusCode).toBe(409);

    const fetchBack = await app.inject({
      method: 'POST',
      url: `/api/backups/${backup.id}/fetch`,
      headers,
      payload: { destinationId: created.id },
    });
    expect(fetchBack.statusCode).toBe(202);
    expect(fetchBack.json().job.type).toBe('backup.fetch');
  });

  it('"Copy now" queues an upload, and says so when there is nothing to do', async () => {
    const { app, world, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const { backup } = seedBackupWithCopy(world, created.id);

    const done = await app.inject({ method: 'POST', url: `/api/backups/${backup.id}/offsite`, headers, payload: {} });
    expect(done.statusCode).toBe(400);
    expect(done.json().error.message).toMatch(/already has this backup/);

    world.db.update(backupCopies).set({ status: 'failed', nextAttemptAt: null }).run();
    const retry = await app.inject({ method: 'POST', url: `/api/backups/${backup.id}/offsite`, headers, payload: {} });
    expect(retry.statusCode).toBe(202);
    // Retrying clears the give-up state so the reconciler picks it up too.
    expect(world.db.select().from(backupCopies).all()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('server storage API', () => {
  it('describes the current location and validates a candidate', async () => {
    const { app, world, headers } = await authedApp();
    const current = await app.inject({ method: 'GET', url: '/api/servers/1/storage', headers });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ backupRoot: world.config.paths.backups, isDefault: true });

    const bad = await app.inject({
      method: 'GET',
      url: `/api/servers/1/storage?path=${encodeURIComponent(`${world.config.srvRoot}/sites`)}`,
      headers,
    });
    expect(bad.json().reason).toMatch(/live data/);
  });

  it('PATCH sets the location, and refuses a reserved one', async () => {
    const { app, world, headers } = await authedApp();
    const root = `${world.config.srvRoot}-alt/backups`;
    const ok = await app.inject({ method: 'PATCH', url: '/api/servers/1', headers, payload: { backupRoot: root } });
    expect(ok.statusCode).toBe(200);
    expect(world.servers.rowById(1)!.backupRoot).toBe(root);

    const bad = await app.inject({ method: 'PATCH', url: '/api/servers/1', headers, payload: { backupRoot: '/' } });
    expect(bad.statusCode).toBe(400);
    expect(world.servers.rowById(1)!.backupRoot).toBe(root);

    const back = await app.inject({ method: 'PATCH', url: '/api/servers/1', headers, payload: { backupRoot: null } });
    expect(back.statusCode).toBe(200);
    expect(world.servers.rowById(1)!.backupRoot).toBeNull();
  });

  it('relocating is a job, and its target is validated before one is queued', async () => {
    const { app, world, headers } = await authedApp();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/servers/1/backups/relocate',
      headers,
      payload: { to: `${world.config.srvRoot}/mysql` },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/servers/1/backups/relocate',
      headers,
      payload: { to: `${world.config.srvRoot}-relocated/backups` },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().job.type).toBe('server.relocateBackups');
  });

  it('meta carries each server\'s location for the Settings hint', async () => {
    const { app, world, headers } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/api/meta', headers });
    expect(res.json().backupRoots).toEqual([
      { serverId: 1, serverName: 'local', root: world.config.paths.backups, isDefault: true, backups: 0 },
    ]);
  });
});

describe('encrypted destinations API', () => {
  const ENCRYPTED = { ...S3, name: 'vault', encryption: 'crypt' };

  it('returns the generated passphrase exactly once, on creation', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: ENCRYPTED });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto.encryption).toBe('crypt');
    expect(dto.crypt.password).toEqual(expect.any(String));
    expect(dto.crypt.salt).toEqual(expect.any(String));

    // Never again from the list or the overview - it is not part of the destination shape.
    const list = await app.inject({ method: 'GET', url: '/api/backup-destinations', headers });
    expect(list.json().items[0].crypt).toBeUndefined();
    expect(JSON.stringify(list.json())).not.toContain(dto.crypt.password);
  });

  it('hands the passphrase back on demand, because the alternative is losing the backups', async () => {
    const { app, headers } = await authedApp();
    const created = (
      await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: ENCRYPTED })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/backup-destinations/${created.id}/passphrase`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ password: created.crypt.password, salt: created.crypt.salt });
  });

  it('has no passphrase to reveal when encryption is off', async () => {
    const { app, headers } = await authedApp();
    const created = (await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: S3 })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/backup-destinations/${created.id}/passphrase`,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to change encryption once the destination holds a copy', async () => {
    const { app, world, headers } = await authedApp();
    const created = (
      await app.inject({ method: 'POST', url: '/api/backup-destinations', headers, payload: ENCRYPTED })
    ).json();
    seedBackupWithCopy(world, created.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/backup-destinations/${created.id}`,
      headers,
      payload: { encryption: 'none' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already holds backups/);
  });
});
