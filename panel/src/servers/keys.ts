import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Config } from '../config.js';
import { newSshKeyPair } from '../services/ftpKeys.js';

/**
 * The panel's SSH identity, made here when there is none. The public key goes into each
 * worker's wpl7-panel authorized_keys. An install has one already: setup.sh makes it with
 * ssh-keygen before the panel first starts, and the panel adopts it.
 */
export async function ensurePanelSshKey(config: Config): Promise<{ publicKey: string }> {
  const { sshDir, sshKey, sshPubKey } = config.paths;
  if (!fs.existsSync(sshKey)) {
    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });
    // Not ssh2's generator, which cuts 1 ed25519 key in 256 short (newSshKeyPair says how).
    const pair = await newSshKeyPair('ed25519', `wpl7-panel@${config.panelDomain || 'panel'}`);
    await fsp.writeFile(sshKey, pair.privateKey, { mode: 0o600 });
    await fsp.writeFile(sshPubKey, `${pair.publicKey}\n`, { mode: 0o644 });
  }
  return { publicKey: (await fsp.readFile(sshPubKey, 'utf8')).trim() };
}

export function readPanelPrivateKey(config: Config): string {
  return fs.readFileSync(config.paths.sshKey, 'utf8');
}

export function readPanelPublicKey(config: Config): string {
  return fs.readFileSync(config.paths.sshPubKey, 'utf8').trim();
}
