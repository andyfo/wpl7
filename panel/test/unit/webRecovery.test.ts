import { describe, expect, it } from 'vitest';
import type { RecoveryBackupDto, ServerRecoveryDto, SiteRecoveryDto } from '../../shared/types.js';
import { backupFrom, defaultServerTarget, newestFor, recoveryLine } from '../../web/src/lib/recovery.js';

const backup = (id: number, patch: Partial<RecoveryBackupDto> = {}): RecoveryBackupDto => ({
  id,
  createdAt: 1_800_000_000_000 - id,
  type: 'scheduled',
  sizeBytes: 1000,
  phpVersion: '8.3',
  note: null,
  copies: [],
  localServerId: null,
  ...patch,
});
const names = (id: number) => ({ 1: 'local', 2: 'lost', 3: 'spare' })[id] ?? `server #${id}`;

describe('recovery dialogs', () => {
  it('takes a backup from the target when its files are there, else from its first copy', () => {
    const both = backup(1, { localServerId: 3, copies: [{ destinationId: 5, name: 'bucket' }] });
    expect(backupFrom(both, 3, names)).toBe('spare');
    expect(backupFrom(both, 1, names)).toBe('bucket');
    expect(backupFrom(backup(2, { localServerId: 2 }), 3, names)).toBeNull();
  });

  it('picks the newest backup that can reach the target', () => {
    const list = [backup(1, { localServerId: 2 }), backup(2, { copies: [{ destinationId: 5, name: 'bucket' }] })];
    expect(newestFor(list, 3)?.id).toBe(2);
    expect(newestFor(list, 2)?.id).toBe(1);
    expect(newestFor([backup(1, { localServerId: 2 })], 3)).toBeNull();
  });

  it('brings a server back onto itself while it answers, else onto another one', () => {
    const report = (answers: boolean): ServerRecoveryDto => ({
      server: { id: 2, name: 'lost', status: answers ? 'ok' : 'unreachable', answers },
      sites: [],
      external: [],
      targets: [
        { id: 1, name: 'local', publicIp: '' },
        { id: 2, name: 'lost', publicIp: '' },
      ].filter((t) => answers || t.id !== 2),
    });
    expect(defaultServerTarget(report(true))?.id).toBe(2);
    expect(defaultServerTarget(report(false))?.id).toBe(1);
  });

  it('says why a site does not come back on the target', () => {
    const site = (patch: Partial<SiteRecoveryDto>): SiteRecoveryDto => ({
      slug: 'shop',
      title: 'Shop',
      app: 'wordpress',
      serverId: 2,
      serverName: 'lost',
      state: 'unreachable',
      refusal: null,
      backups: [backup(1, { copies: [{ destinationId: 5, name: 'bucket' }] })],
      targets: [{ id: 1, name: 'local', publicIp: '' }],
      ...patch,
    });
    const local = { id: 1, name: 'local', publicIp: '' };
    expect(recoveryLine(site({}), local, names)).toMatchObject({ slug: 'shop', from: 'bucket' });
    expect(recoveryLine(site({ refusal: 'It is being made.' }), local, names)).toEqual({ slug: 'shop', title: 'Shop', reason: 'It is being made.' });
    expect(recoveryLine(site({ backups: [backup(1, { localServerId: 2 })] }), local, names)).toMatchObject({ reason: 'No backup of it can reach local.' });
    expect(recoveryLine(site({ targets: [] }), local, names)).toMatchObject({ reason: "It can't come back on local." });
  });
});
