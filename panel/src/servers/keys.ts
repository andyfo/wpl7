import fs from 'node:fs';
import fsp from 'node:fs/promises';
// Default import on purpose: ssh2 is CJS and newer Node versions' named-export
// detection misses `utils`, which crashes ESM named imports at runtime.
import ssh2 from 'ssh2';
import type { Config } from '../config.js';

const { utils } = ssh2;

/**
 * Ensure the panel's SSH identity exists (generated once, at first boot).
 * The public key goes into each worker's wpl7-panel authorized_keys.
 */
export async function ensurePanelSshKey(config: Config): Promise<{ publicKey: string }> {
  const { sshDir, sshKey, sshPubKey } = config.paths;
  if (!fs.existsSync(sshKey)) {
    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });
    const comment = `wpl7-panel@${config.panelDomain || 'panel'}`;
    const pair = utils.generateKeyPairSync('ed25519', { comment });
    await fsp.writeFile(sshKey, pair.private, { mode: 0o600 });
    await fsp.writeFile(sshPubKey, pair.public.endsWith('\n') ? pair.public : pair.public + '\n', {
      mode: 0o644,
    });
  }
  return { publicKey: (await fsp.readFile(sshPubKey, 'utf8')).trim() };
}

export function readPanelPrivateKey(config: Config): string {
  return fs.readFileSync(config.paths.sshKey, 'utf8');
}

export function readPanelPublicKey(config: Config): string {
  return fs.readFileSync(config.paths.sshPubKey, 'utf8').trim();
}
