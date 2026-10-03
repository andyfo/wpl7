import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { backups, servers } from '../db/schema.js';
import type { Config } from '../config.js';
import { backupRootProblem, normalizeAbsolutePath } from '../../shared/backupRoot.js';
import type { MountOption, ServerStorageDto } from '../../shared/types.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { ExecPort } from '../lib/exec.js';
import { shellQuotePath } from '../lib/files.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import type { BackupService } from './backup.js';
import type { Logger } from './index.js';

/** Pseudo/virtual filesystems: real, but not somewhere a backup can live. */
const IGNORED_FSTYPES = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fuse.gvfsd-fuse',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'pstore',
  'ramfs',
  'securityfs',
  'squashfs',
  'sysfs',
  'proc',
  'tmpfs',
  'tracefs',
]);

/** Mount points that belong to the system or to Docker itself. */
const IGNORED_TARGET_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/var/lib/docker', '/snap', '/boot/efi'];

/** `findmnt -rnb` escapes spaces and backslashes in octal; undo that. */
function unescapeFindmnt(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Parse `findmnt -rnb -o TARGET,SOURCE,FSTYPE,SIZE,AVAIL`, keeping only filesystems that
 * could sensibly hold backups. Exported so the filtering is testable without a server.
 */
export function parseMounts(stdout: string): MountOption[] {
  const seen = new Set<string>();
  const out: MountOption[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [rawTarget, rawSource, fstype, size, avail] = cols as [string, string, string, string, string];
    const target = unescapeFindmnt(rawTarget);
    if (IGNORED_FSTYPES.has(fstype)) continue;
    if (IGNORED_TARGET_PREFIXES.some((p) => target === p || target.startsWith(`${p}/`))) continue;
    const totalBytes = Number(size);
    const freeBytes = Number(avail);
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) continue;
    // A bind mount shows the same device twice; the first (shortest) target wins.
    const key = `${unescapeFindmnt(rawSource)}|${totalBytes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      target,
      source: unescapeFindmnt(rawSource),
      fstype,
      totalBytes,
      freeBytes,
      suggested: normalizeAbsolutePath(`${target}/backups`),
    });
  }
  return out.sort((a, b) => b.freeBytes - a.freeBytes);
}

/**
 * Everything the Storage form needs about one server's backup location, and the one place
 * that writes a new one.
 *
 * Two views of the same machine have to agree for server 1: what exists on the host (which
 * disks, how full) and what the panel container can see (which is only what compose mounted
 * at an identical path). A location the host has and the container has not is legal but
 * unusable, and saying so with the exact two commands to fix it is more useful than a
 * validation error.
 */
export class StorageService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly backup: BackupService,
    private readonly log: Logger,
    /** Read-only root shell on the panel's own host; absent in tests that don't need it. */
    private readonly hostExec: ExecPort | null = null,
  ) {}

  /**
   * Report on a server's location, or on `candidate` if one is being typed. The DTO is the
   * same either way, so the form renders one component for "where we are" and "where you
   * are pointing".
   */
  async describe(serverId: number, candidate?: string): Promise<ServerStorageDto> {
    const row = this.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    const handle = this.servers.handleFor(serverId);
    const defaultRoot = this.config.paths.backups;
    const current = row.backupRoot || defaultRoot;

    let root = current;
    let problem: string | null = null;
    if (candidate !== undefined && candidate !== '') {
      problem = backupRootProblem(candidate, this.config.srvRoot);
      root = problem ? candidate.trim() : normalizeAbsolutePath(candidate.trim());
    }

    const stored = this.storedBackups(serverId, root);
    const dto: ServerStorageDto = {
      serverId,
      serverName: row.name,
      kind: row.kind as 'local' | 'ssh',
      backupRoot: root,
      defaultRoot,
      isDefault: root === defaultRoot,
      exists: false,
      writable: false,
      visibleInPanel: true,
      reason: problem,
      mountInstructions: null,
      disk: null,
      backups: stored,
      mounts: [],
      discovered: false,
      discoveryError: null,
    };
    if (problem) return dto;

    try {
      const probe = await this.probe(handle, root);
      Object.assign(dto, probe);
      dto.mounts = await this.mounts(handle);
      dto.discovered = true;
    } catch (err) {
      dto.discoveryError = err instanceof Error ? err.message : String(err);
      this.log.warn(`Storage discovery on "${row.name}" failed: ${dto.discoveryError}`);
    }
    if (!dto.visibleInPanel) dto.mountInstructions = mountInstructionsFor(root);
    return dto;
  }

  /** How many backups this server already has at `root`, and how much they weigh. */
  private storedBackups(serverId: number, root: string): { count: number; bytes: number } {
    const rows = this.db
      .select({ path: backups.path, rootPath: backups.rootPath, sizeBytes: backups.sizeBytes })
      .from(backups)
      .where(and(eq(backups.serverId, serverId), eq(backups.filesPresent, 1)))
      .all();
    let count = 0;
    let bytes = 0;
    for (const r of rows) {
      const rowRoot = r.rootPath || path.dirname(path.dirname(r.path));
      if (rowRoot !== root) continue;
      count++;
      bytes += r.sizeBytes ?? 0;
    }
    return { count, bytes };
  }

  /** Does the path exist on the server, can it be written to, can the panel see it. */
  private async probe(
    handle: ServerHandle,
    root: string,
  ): Promise<Pick<ServerStorageDto, 'exists' | 'writable' | 'visibleInPanel' | 'reason' | 'disk'>> {
    const exec = this.execFor(handle);
    const quoted = shellQuotePath(root);
    const res = await exec.run(
      'sh',
      [
        '-c',
        // One round trip: exists, writable, and the filesystem it sits on. `findmnt -T`
        // resolves the path to its mount point, which is what "which disk is this" means.
        `if [ -d ${quoted} ]; then echo exists; [ -w ${quoted} ] && echo writable; ` +
          `findmnt -rnb -T ${quoted} -o TARGET,SOURCE,FSTYPE,SIZE,AVAIL; fi`,
      ],
      { timeoutMs: 30_000 },
    );
    const lines = res.stdout.split('\n').map((l) => l.trim());
    const exists = lines.includes('exists');
    const writable = lines.includes('writable');
    const disk = parseMounts(lines.filter((l) => l !== 'exists' && l !== 'writable').join('\n'))[0] ?? null;

    const visibleInPanel = await this.sameDirectoryInPanel(handle, root);

    // Order matters: the container question outranks the others, because "it will be
    // created" is not true of a path the panel has no way to write to - saying both at
    // once (which this did) reads as the form contradicting itself.
    let reason: string | null = null;
    if (!visibleInPanel) {
      reason = exists
        ? `${root} exists on this server but is not mounted into the panel container, so the ` +
          `panel cannot write backups there yet.`
        : `${root} is not mounted into the panel container, so the panel cannot write backups ` +
          `there yet. Recreating the panel with BACKUP_ROOT set creates it and mounts it.`;
    } else if (!exists) reason = `${root} does not exist on this server yet; it will be created.`;
    else if (!writable) reason = `${root} exists but is not writable.`;
    return { exists, writable, visibleInPanel, reason, disk };
  }

  /**
   * Is this path, inside the panel container, the *same directory* the host has there?
   *
   * Not "does a directory of that name exist": `mkdir -p /mnt/backups` inside the container
   * cheerfully succeeds against its own writable layer, which looks identical from in here
   * and loses every backup written to it the next time the container is recreated. Device
   * plus inode tells the two apart - a bind mount shares the host's superblock, an
   * overlayfs directory does not.
   *
   * Only server 1 has the question at all; a worker's files port already runs on its host.
   */
  private async sameDirectoryInPanel(handle: ServerHandle, root: string): Promise<boolean> {
    if (handle.kind !== 'local' || !this.hostBridged() || !this.hostExec) return true;
    const host = await this.hostExec.run('stat', ['-c', '%d %i', root], { timeoutMs: 30_000 });
    if (host.exitCode !== 0) return false;
    try {
      const inside = fs.statSync(root);
      return host.stdout.trim() === `${inside.dev} ${inside.ino}`;
    } catch {
      return false; // not mounted in here at all
    }
  }

  private async mounts(handle: ServerHandle): Promise<MountOption[]> {
    const exec = this.execFor(handle);
    const res = await exec.run('findmnt', ['-rnb', '-o', 'TARGET,SOURCE,FSTYPE,SIZE,AVAIL'], { timeoutMs: 30_000 });
    if (res.exitCode !== 0) return [];
    return parseMounts(res.stdout);
  }

  /** Host view of a server: the SSH hop for server 1, the ordinary exec port otherwise. */
  private execFor(handle: ServerHandle): ExecPort {
    if (handle.kind === 'local' && this.hostExec) return this.hostExec;
    return handle.exec;
  }

  /** True when the panel runs in a container and therefore has its own path namespace. */
  private hostBridged(): boolean {
    const he = this.hostExec as { needsSsh?: () => boolean } | null;
    return he?.needsSsh?.() ?? false;
  }

  /**
   * Write a new location. `null` goes back to the default. The directory is created (700)
   * and probed for writability first: a root that turns out to be unusable is a failed
   * backup at 03:00, and there is no reason to find out then.
   */
  async setRoot(serverId: number, input: string | null): Promise<void> {
    const row = this.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    const handle = this.servers.handleFor(serverId);

    if (input === null || input.trim() === '' || normalizeAbsolutePath(input.trim()) === this.config.paths.backups) {
      this.db.update(servers).set({ backupRoot: null, updatedAt: Date.now() }).where(eq(servers.id, serverId)).run();
      this.servers.invalidate(serverId);
      return;
    }
    const problem = backupRootProblem(input, this.config.srvRoot);
    if (problem) throw badRequest(problem);
    const root = normalizeAbsolutePath(input.trim());

    // Before creating anything: on server 1 a directory the panel can make but the host
    // cannot see is worse than no directory at all - backups would land in the container's
    // writable layer and vanish with it.
    if (!(await this.sameDirectoryInPanel(handle, root))) {
      throw badRequest(
        `${root} is not mounted into the panel container, so the panel cannot write backups there. ` +
          `Add it to the compose overlay and recreate the panel, then apply this again.`,
        mountInstructionsFor(root),
      );
    }
    // Create it where the backups actually get written from: through the bind mount for
    // server 1, on the host over SSH for a worker. Either way this lands on the host.
    await handle.files.mkdirp(root, { mode: 0o700 }).catch((err: unknown) => {
      throw badRequest(
        `Could not create ${root} on "${row.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const probe = await handle.exec.run(
      'sh',
      ['-c', `t=$(mktemp -p ${shellQuotePath(root)} .ceo-write-test.XXXXXX) && rm -f "$t"`],
      { timeoutMs: 30_000 },
    );
    if (probe.exitCode !== 0) {
      throw badRequest(
        `${root} on "${row.name}" is not writable: ${(probe.stderr || probe.stdout).trim().slice(0, 200)}`,
      );
    }
    this.db.update(servers).set({ backupRoot: root, updatedAt: Date.now() }).where(eq(servers.id, serverId)).run();
    this.servers.invalidate(serverId);
    this.log.info(`Server "${row.name}": backups now stored in ${root}`);
  }

  /** Per-server locations for the Settings hint and the Storage page. */
  roots(): { serverId: number; serverName: string; root: string; isDefault: boolean; backups: number }[] {
    const counts = new Map<number, number>(
      this.db
        .select({ serverId: backups.serverId, n: sql<number>`count(*)` })
        .from(backups)
        .groupBy(backups.serverId)
        .all()
        .map((r) => [r.serverId, Number(r.n)] as const),
    );
    return this.servers.listRows().map((row) => ({
      serverId: row.id,
      serverName: row.name,
      root: this.backup.rootFor(row),
      isDefault: !row.backupRoot,
      backups: counts.get(row.id) ?? 0,
    }));
  }
}

/**
 * The panel container cannot mount a directory into itself — that needs a compose change
 * and a recreate, which is the one thing a process cannot do to its own container. So the
 * modal shows the two commands instead of an Apply button.
 */
export function mountInstructionsFor(root: string): { envLine: string; command: string } {
  return {
    envLine: `BACKUP_ROOT=${root}`,
    command: './provision/compose.sh up -d panel',
  };
}
