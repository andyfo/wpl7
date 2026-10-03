import type { EphemeralLockdown } from './docker.js';
import type { ServerHandle } from '../servers/registry.js';
import { CHECK_SCRIPT, LOCAL_RULES_DIR, REDUCER_SCRIPT, RULES_SCRIPT, SIGNATURES_SHELL, ZIP_CHECK_SHELL, ZIP_MANIFEST_SCRIPT } from './scanScripts.js';
import { TUNING_VERSION, tuningArg } from './scanTuning.js';
import {
  engineFailed,
  parseCheck,
  parseInventory,
  parseSignatures,
  parseZipCheck,
  type EngineResult,
  type InventoryResult,
  type PackageCount,
  type ZipCheckResult,
} from './scanReport.js';

/**
 * The containers a malware scan runs in (docs/security.md). Each is thrown away when it is
 * done and has only what it needs: that one site's files, read-only, at /var/www/html; no
 * network; no capabilities; a read-only root with a small tmpfs; one CPU; a memory ceiling;
 * uid 33 - the site's own user, so it reads what the site can and nothing more.
 *
 *   inventory, check   the site's own image, the panel's script (scanScripts.ts)
 *   signatures         AMWScan, pinned by digest (GPL-3.0, run unmodified as its own process),
 *                      with WPL7's tuning of it (scanTuning.ts)
 */

/** AMWScan 0.21.12, linux/amd64 and linux/arm64. Changing it is a release, not a setting. */
export const SCANNER_IMAGE =
  'marcocesarato/php-antimalware-scanner@sha256:920fb974c5e743556b5eff8d58dac988d97f611806b6b38f3e4513f17e75d944';
export const SCANNER_VERSION = '0.21.12';
/**
 * What a result of the scanner is good for: its version and WPL7's tuning of it. A catalog zip
 * checked under another profile is checked again.
 */
export const SCAN_PROFILE = `${SCANNER_VERSION}+wpl7.${TUNING_VERSION}`;

export const SITE_IN_CONTAINER = '/var/www/html';
export const INPUT_IN_CONTAINER = '/wpl7-scan';
const MIB = 1024 * 1024;
/** What an engine may print; the scripts keep well under it (MAX_REPORTED_FINDINGS). */
const OUTPUT_CAP = MIB;

function lockdown(memoryBytes: number, tmpfsMb: number): EphemeralLockdown {
  return { memoryBytes, nanoCpus: 1e9, pidsLimit: 64, tmpfs: { '/tmp': tmpfsMb } };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What is installed, read from the files' own headers. Throws when it cannot say. */
export async function runInventory(handle: ServerHandle, image: string, wordpressDir: string, timeoutMs: number): Promise<InventoryResult> {
  const res = await handle.docker.runEphemeral({
    image,
    entrypoint: ['php'],
    cmd: ['-d', 'memory_limit=64M', '-r', CHECK_SCRIPT, 'inventory'],
    user: '33:33',
    binds: [`${wordpressDir}:${SITE_IN_CONTAINER}:ro`],
    labels: { 'wpl7.scan': 'inventory' },
    timeoutMs,
    outputCap: OUTPUT_CAP,
    lockdown: lockdown(128 * MIB, 8),
  });
  return parseInventory(res);
}

/** The panel's own check against the checksums in `inputDir/input.json`. */
export async function runCheck(handle: ServerHandle, image: string, wordpressDir: string, inputDir: string, timeoutMs: number): Promise<EngineResult> {
  try {
    const res = await handle.docker.runEphemeral({
      image,
      entrypoint: ['php'],
      cmd: ['-d', 'memory_limit=192M', '-r', CHECK_SCRIPT, 'check', `${INPUT_IN_CONTAINER}/input.json`],
      user: '33:33',
      binds: [`${wordpressDir}:${SITE_IN_CONTAINER}:ro`, `${inputDir}:${INPUT_IN_CONTAINER}:ro`],
      labels: { 'wpl7.scan': 'check' },
      timeoutMs,
      outputCap: OUTPUT_CAP,
      lockdown: lockdown(256 * MIB, 8),
    });
    return parseCheck(res);
  } catch (err) {
    const text = errorText(err);
    if (/timed out/i.test(text)) return { ...engineFailed('check', 'The file check ran out of time and was stopped.'), state: 'incomplete' };
    return engineFailed('check', `The file check could not run: ${text}`);
  }
}

/**
 * Folders the scanner can leave out: packages whose every file is the published one and that
 * hold nothing else. Only from a check that finished - otherwise nothing is known about them.
 * Slugs come from the checksums the panel fetched, so none can smuggle a comma or a wildcard
 * into the list.
 */
export function publishedFolders(check: EngineResult): string[] {
  if (check.state !== 'complete') return [];
  const clean = (key: string) => {
    const c: PackageCount | undefined = check.packages[key];
    return c !== undefined && c.files > 0 && c.modified === 0 && c.extra === 0;
  };
  const out: string[] = [];
  for (const dir of ['wp-admin', 'wp-includes']) {
    if (clean(`core:${dir}`)) {
      out.push(`${SITE_IN_CONTAINER}/${dir}/*`);
      continue;
    }
    // Not all of it: then each of its subfolders that is.
    for (const key of Object.keys(check.packages)) {
      const sub = key.startsWith(`core:${dir}/`) ? key.slice(`core:${dir}/`.length) : null;
      if (sub && /^[A-Za-z0-9_.-]+$/.test(sub) && clean(key)) out.push(`${SITE_IN_CONTAINER}/${dir}/${sub}/*`);
    }
  }
  for (const key of Object.keys(check.packages)) {
    const slug = key.startsWith('plugin:') ? key.slice('plugin:'.length) : null;
    if (slug && /^[a-z0-9][a-z0-9_.-]*$/.test(slug) && clean(key)) out.push(`${SITE_IN_CONTAINER}/wp-content/plugins/${slug}/*`);
  }
  return out.sort();
}

/** Pull the scanner where it is missing. Throws with the reason. */
export async function ensureScannerImage(handle: ServerHandle, onProgress?: (line: string) => void): Promise<void> {
  if (await handle.docker.imageExists(SCANNER_IMAGE)) return;
  await handle.docker.pullImage(SCANNER_IMAGE, onProgress);
}

/** AMWScan's arguments: report only, to a file the reducer reads; everything it writes in its tmpfs. */
function scannerArgs(skip: string[]): string[] {
  return [
    SITE_IN_CONTAINER,
    '--lite',
    '--report-only',
    '--report-format=json',
    '--path-report=/tmp/amwscan/report',
    '--disable-checksum',
    '--disable-definitions-update',
    '--disable-cache',
    '--disable-colors',
    '--silent',
    '--jobs',
    '1',
    // Everything it might write, somewhere it can: its defaults are next to the program.
    '--path-whitelist=/tmp/amwscan/whitelist.json',
    '--path-logs=/tmp/amwscan/scanner.log',
    '--path-backups=/tmp/amwscan/backups',
    '--path-quarantine=/tmp/amwscan/quarantine',
    '--path-deobfuscate=/tmp/amwscan/deobfuscated',
    '--path-definitions=/tmp/amwscan/definitions',
    `--path-local-rules=${LOCAL_RULES_DIR}`,
    ...(skip.length > 0 ? [`--ignore-paths=${skip.join(',')}`] : []),
  ];
}

export async function runSignatures(
  handle: ServerHandle,
  wordpressDir: string,
  opts: { memoryBytes: number; timeoutMs: number; skip: string[] },
): Promise<EngineResult> {
  // PHP gets most of the ceiling; the rest is the tmpfs its report goes to, and the shell.
  const phpMb = Math.max(128, Math.floor(opts.memoryBytes / MIB) - 96);
  const args = scannerArgs(opts.skip);
  try {
    const res = await handle.docker.runEphemeral({
      image: SCANNER_IMAGE,
      entrypoint: ['/bin/sh'],
      cmd: ['-c', SIGNATURES_SHELL, 'sh', RULES_SCRIPT, tuningArg(), REDUCER_SCRIPT, `${phpMb}M`, ...args],
      user: '33:33',
      binds: [`${wordpressDir}:${SITE_IN_CONTAINER}:ro`],
      labels: { 'wpl7.scan': 'signatures' },
      timeoutMs: opts.timeoutMs,
      outputCap: OUTPUT_CAP,
      lockdown: lockdown(opts.memoryBytes, 64),
    });
    return parseSignatures(res);
  } catch (err) {
    const text = errorText(err);
    if (/timed out/i.test(text)) {
      return { ...engineFailed('signatures', 'The signature scan ran out of time and was stopped.'), state: 'incomplete' };
    }
    return engineFailed('signatures', `The signature scan could not run: ${text}`);
  }
}

/** What a catalog zip may unpack to; past it the zip is not checked. */
export const MAX_UNPACKED_MB = 1024;

/**
 * A catalog zip's check, in AMWScan's container: only the zip, read-only, unpacked into a
 * tmpfs at /var/www/html sized to it - the memory ceiling grows by as much - then hashed and
 * scanned there. No network, as for a site, and nothing of it is written to the host.
 */
export async function runZipCheck(
  handle: ServerHandle,
  zipPath: string,
  folder: string,
  opts: { memoryBytes: number; timeoutMs: number; unpackedMb: number },
): Promise<ZipCheckResult> {
  const phpMb = Math.max(128, Math.floor(opts.memoryBytes / MIB) - 96);
  try {
    const res = await handle.docker.runEphemeral({
      image: SCANNER_IMAGE,
      entrypoint: ['/bin/sh'],
      cmd: ['-c', ZIP_CHECK_SHELL, 'sh', ZIP_MANIFEST_SCRIPT, RULES_SCRIPT, tuningArg(), REDUCER_SCRIPT, `${phpMb}M`, folder, ...scannerArgs([])],
      user: '33:33',
      binds: [`${zipPath}:/wpl7-zip/plugin.zip:ro`],
      labels: { 'wpl7.scan': 'zip' },
      timeoutMs: opts.timeoutMs,
      // A line per file: 20,000 of them is a couple of MiB.
      outputCap: 8 * MIB,
      lockdown: { ...lockdown(opts.memoryBytes + opts.unpackedMb * MIB, 64), tmpfs: { '/tmp': 64, [SITE_IN_CONTAINER]: opts.unpackedMb } },
    });
    return parseZipCheck(res, folder);
  } catch (err) {
    const text = errorText(err);
    return {
      state: 'failed',
      problem: /timed out/i.test(text) ? 'The zip check ran out of time and was stopped.' : `The zip check could not run: ${text}`,
      name: null,
      version: null,
      files: {},
      findings: [],
      scanned: null,
    };
  }
}
