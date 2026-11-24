import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { ensurePanelSshKey, readPanelPrivateKey, readPanelPublicKey } from '../../src/servers/keys.js';
import { newSshKeyPair, sshKeyFacts } from '../../src/services/ftpKeys.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The panel's key paths, in a folder of their own. */
function config(): Config {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-panel-key-'));
  dirs.push(root);
  const sshDir = path.join(root, 'panel', 'ssh');
  return {
    panelDomain: 'panel.example.com',
    paths: { sshDir, sshKey: path.join(sshDir, 'id_ed25519'), sshPubKey: path.join(sshDir, 'id_ed25519.pub') },
  } as unknown as Config;
}

describe("the panel's SSH key", () => {
  it('is made when there is none, as a pair ssh2 reads', async () => {
    const c = config();
    const { publicKey } = await ensurePanelSshKey(c);
    expect(publicKey).toMatch(/^ssh-ed25519 AAAA\S+ wpl7-panel@panel\.example\.com$/);
    // What every connection reads, and the public key that belongs to it.
    expect(sshKeyFacts(readPanelPrivateKey(c)).publicKey).toBe(publicKey);
    expect(readPanelPublicKey(c)).toBe(publicKey);
    expect(fs.statSync(c.paths.sshKey).mode & 0o777).toBe(0o600);
  });

  it('keeps the one setup.sh made', async () => {
    const c = config();
    const setup = await newSshKeyPair('ed25519', 'wpl7-panel@setup');
    fs.mkdirSync(c.paths.sshDir, { recursive: true });
    fs.writeFileSync(c.paths.sshKey, setup.privateKey, { mode: 0o600 });
    fs.writeFileSync(c.paths.sshPubKey, `${setup.publicKey}\n`);
    expect(await ensurePanelSshKey(c)).toEqual({ publicKey: setup.publicKey });
    expect(readPanelPrivateKey(c)).toBe(setup.privateKey);
  });
});
