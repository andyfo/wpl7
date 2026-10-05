/**
 * The name the relay announces in HELO, and where it comes from.
 *
 * Two settings decide it, the first one present winning:
 *   1. the panel's override - `POSTFIX_myhostname=` in `${SRV_ROOT}/mail/relay.env`, which
 *      Mail -> Setup guide writes and compose hands the relay as an `env_file`;
 *   2. the default - `MAIL_HOSTNAME` in deploy/.env, which compose hands it as `HOSTNAME`.
 *
 * A container that compose has just created announces the right one: the image sets
 * `myhostname` from `HOSTNAME`, then applies every `POSTFIX_*` variable. But a container keeps
 * the environment it was created with, and the image re-applies that environment every time
 * it starts. So a restart that is not a recreate - a reboot, the Docker daemon restarting -
 * undoes an override set, or removed, since then. The panel puts the name back
 * (MailService.convergeHostname), which is why it has to read all three: both settings, and
 * what postfix announces now.
 *
 * Everything here is pure. MailService does the reads and writes.
 */

/** The relay.env key the image applies as postfix's `myhostname`. */
export const HOSTNAME_OVERRIDE_KEY = 'POSTFIX_myhostname';

/**
 * What postfix announces now, then the `HOSTNAME` the container was created with. A `docker
 * exec` runs with the container's own environment, so the second line is the default as this
 * relay knows it - and exactly what the image falls back to (`POSTFIX_myhostname="$HOSTNAME"`).
 * Fails where there is no postfix, as in local development, which runs mailpit instead.
 */
export const RELAY_HOSTNAME_PROBE = ['sh', '-c', 'postconf -h myhostname && { printenv HOSTNAME || true; }'];

export interface RelayHostnames {
  /** What postfix announces right now. */
  live: string;
  /** The `HOSTNAME` the container was created with: MAIL_HOSTNAME, the default. '' when unset. */
  fallback: string;
}

export function parseHostnameProbe(stdout: string): RelayHostnames {
  const [live = '', fallback = ''] = stdout.split('\n').map((line) => line.trim());
  return { live, fallback };
}

/** Host names are case-insensitive; a name that differs only in case is the same name. */
export const sameHostname = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `KEY=value` lines, as compose reads them; comments and blank lines are not settings. */
const settingLines = (text: string | null): string[] =>
  (text ?? '').split('\n').filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line));

const isOverrideLine = (line: string): boolean => line.startsWith(`${HOSTNAME_OVERRIDE_KEY}=`);

/** The override in a relay.env, or null when there is none. The last one wins, as in compose. */
export function hostnameOverride(text: string | null): string | null {
  const line = settingLines(text).filter(isOverrideLine).at(-1);
  if (line === undefined) return null;
  // Compose strips a pair of quotes around a value; somebody editing the file by hand may add them.
  const value = line.slice(HOSTNAME_OVERRIDE_KEY.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  return value || null;
}

const HEADER = [
  '# Written by the WPL7 panel (Mail -> Setup guide). The mail container reads it as an',
  '# optional env_file when compose creates it, and the panel applies it again whenever the',
  '# relay restarts. POSTFIX_* settings are applied after the image\'s own config, so the',
  '# hostname here wins over the MAIL_HOSTNAME default in deploy/.env.',
];

/**
 * The relay.env to write: `current` with its hostname override replaced by `hostname`, or
 * dropped when that is null. Other settings are kept. Null when no setting is left - the file
 * then goes, so the compose `env_file` is simply absent again (provision/lib.sh does the same).
 */
export function relayEnvWith(current: string | null, hostname: string | null): string | null {
  const lines = settingLines(current).filter((line) => !isOverrideLine(line));
  if (hostname !== null) lines.push(`${HOSTNAME_OVERRIDE_KEY}=${hostname}`);
  return lines.length > 0 ? [...HEADER, ...lines, ''].join('\n') : null;
}
