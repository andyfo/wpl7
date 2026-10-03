export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '–';
  return new Date(ts).toLocaleString();
}

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '–';
  const s = Math.floor((now - ts) / 1000);
  // A time a moment ahead of this browser's clock - the server's runs a little fast, or the
  // row was written this very second - is "just now", not "-2s ago".
  if (s <= 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * How long until `ts`, for a next run: "in 45s", "in 12m", "in 3h", "in 2d" - rounded, since
 * the exact time goes in a title. "any moment" once it is due, or late by a tick.
 */
export function timeUntil(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '–';
  const ms = ts - now;
  if (ms < 5_000) return 'any moment';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}

/** How long something took: "850 ms", "12s", "3m 20s", "1h 5m" - never more than two units. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '–';
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** HH:MM:SS on a 24-hour clock, for log lines: the date is the same for nearly all of them. */
export function formatClock(ts: number): string {
  return CLOCK.format(ts);
}

/**
 * Uptime the way an operator reads it: the two largest units and no more. "37d 4h" is the
 * answer to "has this been rebooted recently"; the remaining minutes and seconds are noise.
 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * How a WordPress language reads in a picker: native name the way WordPress labels it,
 * the English name when it differs (so the list can be scanned either way), and the code
 * itself - the operator needs it when reading wp-cli output.
 */
export function localeLabel(locale: { code: string; label: string; english: string }): string {
  const name = locale.english === locale.label ? locale.label : `${locale.label} (${locale.english})`;
  return `${name} — ${locale.code}`;
}

/** Display name for a locale code, falling back to the bare code for an unknown one. */
export function localeName(
  locales: { code: string; label: string; english: string }[] | undefined,
  code: string,
): string {
  const hit = locales?.find((l) => l.code === code);
  return hit ? localeLabel(hit) : code;
}

/**
 * ISO 3166-1 alpha-2 -> the flag emoji, by mapping each letter to its regional indicator.
 * Nothing to ship and nothing to keep up to date: the code point arithmetic is the table.
 */
export function flagOf(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '🏳️';
  const base = 0x1f1e6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => base + c.charCodeAt(0)));
}

/**
 * Country name in the browser's language, from the platform's own CLDR data - so a German
 * operator reads "Österreich" without the panel shipping a translation table. Falls back to
 * the bare code on a runtime without Intl.DisplayNames, or for a code it does not know.
 */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
