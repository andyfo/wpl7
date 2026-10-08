import { restRouteText, type JobType } from '../../shared/schemas.js';

/**
 * One line about a particular job - "Update plugin akismet", "wp cache flush" - for the Jobs
 * list, where the type's label alone ("Plugin change") does not tell two rows apart.
 *
 * Written once, when the job is queued, and stored: it is searchable that way, and nobody has
 * to parse old payloads of a shape the code has since moved on from. It never names the site
 * or the server (those are columns of their own) and never repeats a secret: `site.create`
 * carries the admin password, and a command line can carry anything.
 */

const MAX = 160;

type Payload = Record<string, unknown>;
type Names = { server?: (id: number) => string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function clip(text: string, max = MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A size as the job lists and logs put it: `1 byte`, `740 bytes`, `64.0 KB`, `1.2 MB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What a command was handed on stdin, as its summary and its log put it: how much, never what.
 * Stdin is where a command is given what should not be written down (`--prompt=user_pass`).
 */
export function stdinNote(stdin: string): string {
  return `+ stdin, ${sizeText(Buffer.byteLength(stdin, 'utf8'))}`;
}

/** A word that says the value next to it is a credential. */
const SECRET_WORD = /pass|secret|token|key|salt|auth/i;
const MASK = '•••';

/**
 * wp-cli arguments with credentials masked: the value of `--user_pass=…` or `--key=…`, and
 * the argument after one that names a secret (`config set DB_PASSWORD hunter2`).
 */
export function maskCliArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext && !arg.startsWith('-')) {
      out.push(MASK);
      maskNext = false;
      continue;
    }
    maskNext = false;
    const flag = /^(--?[^=]+)=(.*)$/s.exec(arg);
    if (flag) {
      out.push(SECRET_WORD.test(flag[1]!) ? `${flag[1]}=${MASK}` : arg);
      continue;
    }
    if (SECRET_WORD.test(arg)) maskNext = true;
    out.push(arg);
  }
  return out;
}

/**
 * A job's result with the value of every key named like a credential masked, at any depth -
 * what a Read only caller gets (lib/dto.ts). `site.create` answers with the admin password it
 * generated, and a key that may only read must not be the way to collect it.
 */
export function maskResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskResult(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_WORD.test(key) ? MASK : maskResult(item)]),
  ) as T;
}

/** A shell command with `password=…`-style values masked. */
export function maskShell(command: string): string {
  return command.replace(
    /((?:pass(?:word)?|passwd|secret|token|api[_-]?key|access[_-]?key|salt)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1${MASK}`,
  );
}

/**
 * A REST route as `/wp-json/…`, with the value of every query parameter named like a
 * credential masked: `?api_key=•••`.
 */
export function maskRestRoute(input: string): string {
  const text = restRouteText(input);
  const q = text.indexOf('?');
  if (q === -1) return text;
  const pairs = text
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq !== -1 && SECRET_WORD.test(pair.slice(0, eq)) ? `${pair.slice(0, eq)}=${MASK}` : pair;
    });
  return `${text.slice(0, q)}?${pairs.join('&')}`;
}

const quoteArg = (arg: string) => (arg === '' || /[\s"']/.test(arg) ? (arg.includes('"') ? `'${arg}'` : `"${arg}"`) : arg);

function bulkOps(ops: unknown[]): string | null {
  const parsed = ops
    .map((op) => (op && typeof op === 'object' ? (op as Payload) : null))
    .filter((op): op is Payload => op !== null);
  if (parsed.length === 0) return null;
  if (parsed.length === 1) {
    const op = parsed[0]!;
    const action = str(op.action) ?? 'change';
    if (op.kind === 'core') return `${capitalize(action)} WordPress`;
    return `${capitalize(action)} ${str(op.kind) ?? 'component'} ${str(op.slug) ?? ''}`.trim();
  }
  // "Update 3 plugins, 1 theme and WordPress" - grouped by action, in the order first seen.
  const groups = new Map<string, Map<string, number>>();
  for (const op of parsed) {
    const action = str(op.action) ?? 'change';
    const kinds = groups.get(action) ?? new Map<string, number>();
    const kind = str(op.kind) ?? 'component';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    groups.set(action, kinds);
  }
  const phrases = [...groups.entries()].map(([action, kinds]) => {
    const parts = [...kinds.entries()].map(([kind, n]) => (kind === 'core' ? 'WordPress' : plural(n, kind)));
    return `${action} ${parts.join(', ')}`;
  });
  return capitalize(phrases.join('; '));
}

function policyText(policy: Payload): string {
  const kinds = [policy.plugins ? 'plugins' : null, policy.themes ? 'themes' : null, policy.core ? 'WordPress' : null].filter(
    (k): k is string => k !== null,
  );
  const what = kinds.length === 0 ? 'nothing' : kinds.length === 1 ? kinds[0]! : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
  return `Update ${what}${policy.onlyVulnerable ? ' that fix a vulnerability' : ''}`;
}

export function summarizeJob(type: JobType | string, payload: unknown, names: Names = {}): string | null {
  const p: Payload = payload && typeof payload === 'object' ? (payload as Payload) : {};
  const text = ((): string | null => {
    switch (type as JobType) {
      case 'demo':
        return num(p.steps) !== null ? plural(num(p.steps)!, 'step') : null;
      case 'site.create': {
        const plugins = (Array.isArray(p.pluginSlugs) ? p.pluginSlugs.length : 0) + (Array.isArray(p.pluginZipPaths) ? p.pluginZipPaths.length : 0);
        return plugins > 0 ? `With ${plural(plugins, 'plugin')}` : null;
      }
      case 'site.delete':
        if (p.deleteBackups === true) {
          return p.finalBackup === true ? 'Keeping only a final backup' : 'With its backups, no final one';
        }
        return p.finalBackup === true ? 'After a final backup' : p.finalBackup === false ? 'Without a final backup' : null;
      case 'site.changePhp':
        return str(p.phpVersion) ? `To PHP ${str(p.phpVersion)}` : null;
      case 'site.updateDomains': {
        const domains = Array.isArray(p.domains) ? p.domains.filter((d): d is string => typeof d === 'string') : [];
        if (domains.length === 0) return null;
        return `${domains.join(', ')}${p.goLive === true ? ' (going live)' : ''}`;
      }
      case 'site.move': {
        const target = num(p.targetServerId);
        if (target === null) return null;
        return `To ${names.server?.(target) ?? `server #${target}`}`;
      }
      case 'site.import':
      case 'site.importFinish':
      case 'site.importRefresh':
        return str(p.sourceHost) ? `From ${str(p.sourceHost)}` : null;
      case 'site.shell':
        return str(p.command) ? maskShell(str(p.command)!) : null;
      case 'backup.create': {
        const kind = p.type === 'manual' ? 'Manual' : p.type === 'scheduled' ? 'Scheduled' : null;
        const note = str(p.note);
        if (kind && note) return `${kind}: ${note}`;
        return kind ?? note;
      }
      case 'backup.restore':
        return num(p.backupId) !== null
          ? `Backup #${num(p.backupId)}${p.skipPreRestoreBackup === true ? ', without a safety copy' : ''}`
          : null;
      case 'backup.offsite':
      case 'backup.fetch':
        return num(p.backupId) !== null ? `Backup #${num(p.backupId)}` : null;
      case 'backup.offsitePurge':
        return num(p.destinationId) !== null ? `Destination #${num(p.destinationId)}` : null;
      case 'backup.delete': {
        const ids = Array.isArray(p.backupIds) ? p.backupIds.length : null;
        if (ids === null) return null;
        const parent = num(p.parentJobId);
        return parent !== null ? `${plural(ids, 'backup')}, after job #${parent} deleted the site` : plural(ids, 'backup');
      }
      case 'wp.pluginTask': {
        const action = str(p.action);
        if (!action) return null;
        const source = p.source && typeof p.source === 'object' ? (p.source as Payload) : null;
        const name =
          str(p.name) ?? (source?.kind === 'wporg' ? str(source.slug) : source?.kind === 'catalog' ? `catalog plugin #${num(source.id)}` : null);
        return `${capitalize(action)} plugin${name ? ` ${name}` : ''}`;
      }
      case 'wp.themeTask':
        return str(p.action) ? `${capitalize(str(p.action)!)} theme${str(p.name) ? ` ${str(p.name)}` : ''}` : null;
      case 'wp.bulkTask':
        if (p.policy && typeof p.policy === 'object') return policyText(p.policy as Payload);
        return Array.isArray(p.ops) ? bulkOps(p.ops) : null;
      case 'wp.scanAll':
        return Array.isArray(p.siteIds) ? plural(p.siteIds.length, 'site') : 'Every running site';
      case 'wp.recipes':
        if (str(p.recipeId)) return `Recipe ${str(p.recipeId)}`;
        return p.hook === 'verify' ? 'Check every recipe' : 'Every recipe for its plugins';
      case 'wp.cli': {
        if (!Array.isArray(p.args)) return null;
        const line = `wp ${maskCliArgs(p.args.filter((a): a is string => typeof a === 'string')).map(quoteArg).join(' ')}`;
        if (typeof p.stdin !== 'string') return line;
        // Kept in view however long the command line is: it is the one sign the job had any.
        const note = ` ${stdinNote(p.stdin)}`;
        return `${clip(line, MAX - note.length)}${note}`;
      }
      case 'wp.rest': {
        if (!str(p.route)) return null;
        const user = p.auth && typeof p.auth === 'object' ? str((p.auth as Payload).username) : null;
        return `${str(p.method) ?? 'GET'} ${maskRestRoute(str(p.route)!)}${user ? ` as ${user}` : ''}`;
      }
      case 'files.extract':
        return str(p.path) && str(p.to) ? `${str(p.path)} → ${str(p.to)}` : null;
      case 'files.compress': {
        const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
        if (paths.length === 0 || !str(p.to)) return null;
        return `${paths.length === 1 ? paths[0] : plural(paths.length, 'item')} → ${str(p.to)}`;
      }
      case 'server.relocateBackups':
        return str(p.to) ? `To ${str(p.to)}` : null;
      case 'system.postUpdate':
        return str(p.from) && str(p.to) ? `${str(p.from)} → ${str(p.to)}` : null;
      case 'wp.reinstall':
        return p.package === 'core' ? 'WordPress' : str(p.package)?.startsWith('plugin:') ? `Plugin ${str(p.package)!.slice(7)}` : null;
      case 'plugin.zipCheck':
        return typeof p.pluginId === 'number' ? `Catalog zip #${p.pluginId}` : null;
      case 'site.malwareScan':
        return p.trigger === 'schedule'
          ? 'On schedule'
          : p.trigger === 'rescan'
            ? 'Again, after its files changed'
            : p.trigger === 'manual'
              ? 'Asked for'
              : p.trigger === 'import'
                ? 'After the import'
                : null;
      default:
        return null;
    }
  })();
  return text ? clip(text) : null;
}
