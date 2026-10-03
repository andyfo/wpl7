import { STATUS_CODES } from 'node:http';
import { splitRestRoute, type WpRestMethod } from '../../shared/schemas.js';
import type { Config } from '../config.js';
import type { SiteRow } from '../db/schema.js';
import type { DockerPort, RunResult } from './docker.js';
import { siteScheme } from './labels.js';

/**
 * A request to a site's WordPress REST API, made from inside the site's own container: curl
 * against its Apache on 127.0.0.1, with the site's hostname in `Host`.
 *
 * From inside rather than through Traefik, so that nothing in between can decide the outcome -
 * DNS not pointing here yet, a certificate still being issued, a CDN in front - and so that the
 * request and its credentials ride the same `docker exec` as every wp-cli call: over the pinned
 * SSH connection for a remote server, never across the internet to a certificate the probe
 * would have to leave unverified.
 *
 * The route goes in as `/?rest_route=`, which WordPress answers whatever the site's permalink
 * setting - `/wp-json/` exists only with pretty permalinks and the rewrite rules behind them.
 *
 * The whole request - address, headers, the application password, the body - reaches curl as
 * its config file on stdin (`--config -`), never on its command line, which anything in the
 * container can read in /proc. `-q` comes first so that no `.curlrc` a plugin managed to drop
 * in $HOME is read on top of it.
 */

export interface WpRestCall {
  method: WpRestMethod;
  /** As the user typed it: `wp/v2/posts?per_page=5`, or with `/wp-json/` in front. */
  route: string;
  /** Sent as JSON. */
  body?: unknown;
  auth?: { username: string; applicationPassword: string };
  /** The site's primary hostname, which is what its WordPress URLs are. */
  host: string;
  /** The site is served over HTTPS. */
  https: boolean;
  /** How long curl waits for the whole answer. */
  timeoutMs: number;
  /** Bytes of the body kept; the rest is counted, not held. */
  bodyCap: number;
}

export interface WpRestResponse {
  /** null when no answer came at all (nothing listening, a timeout before the headers). */
  status: number | null;
  statusText: string;
  contentType: string | null;
  /** Response headers, lower-case names; a repeated one joined with ", ". */
  headers: Record<string, string>;
  body: string;
  /** The body went past `bodyCap` and was cut there. */
  truncated: boolean;
  /** The whole body's size, whether or not all of it was kept. */
  sizeBytes: number;
  durationMs: number;
  /** curl's reason when the exchange did not complete - with or without a status. */
  error: string | null;
}

const CURL = ['curl', '-q', '--config', '-'];
const META = '@@wpl7-meta@@';
const HEADERS = '@@wpl7-headers@@';
/** What lib/demux.ts appends to output it had to cut. */
const CUT_MARK = '\n…[output truncated]';
/** Beyond curl's own limit: the exec's deadline is only there for a curl that hangs anyway. */
const EXEC_GRACE_MS = 10_000;

/** Where a site's requests are addressed: its primary hostname, and the scheme it is served on. */
export function restTargetOf(site: Pick<SiteRow, 'domains'>, config: Pick<Config, 'tlsMode'>): { host: string; https: boolean } {
  const [host] = JSON.parse(site.domains) as string[];
  if (!host) throw new Error('The site has no hostname');
  return { host, https: siteScheme(config.tlsMode) === 'https' };
}

/** A value in curl's config file: double-quoted, with the escapes curl(1) documents for -K. */
function quote(value: string): string {
  const escapes: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };
  return `"${value.replace(/[\\"\n\r\t\v]/g, (c) => escapes[c]!)}"`;
}

/**
 * The route as a query value: every character that would mean something else there is
 * escaped, `%XX` escapes already in it are kept - WordPress decodes the value once, as it
 * would have decoded the path.
 */
const routeValue = (route: string) => route.replace(/[^A-Za-z0-9\-._~!$'()*,;:@/%]/gu, (c) => encodeURIComponent(c));
/** The typed query string as it is, only anything outside printable ASCII escaped. */
const queryValue = (query: string) => query.replace(/[^\x21-\x7e]/gu, (c) => encodeURIComponent(c));

export function restRequestUrl(input: string): string {
  const { route, query } = splitRestRoute(input);
  return `http://127.0.0.1/?rest_route=${routeValue(route)}${query ? `&${queryValue(query)}` : ''}`;
}

/** What curl reads on stdin: one option per line. */
export function curlConfig(call: WpRestCall): string {
  const lines = [
    `url = ${quote(restRequestUrl(call.route))}`,
    `request = ${quote(call.method)}`,
    `header = ${quote(`Host: ${call.host}`)}`,
    'header = "Accept: application/json"',
    `user-agent = "wpl7"`,
  ];
  // What Traefik would have said for a site behind TLS. Said for a signed-in request on a plain
  // HTTP install too: WordPress accepts application passwords only on a request it believes is
  // HTTPS (wp_is_application_passwords_supported), and ignores them *silently* otherwise, so the
  // request would run as nobody. One that never leaves the container is as private as HTTPS.
  if (call.https || call.auth) lines.push('header = "X-Forwarded-Proto: https"');
  if (call.auth) {
    const token = Buffer.from(`${call.auth.username}:${call.auth.applicationPassword}`, 'utf8').toString('base64');
    lines.push(`header = ${quote(`Authorization: Basic ${token}`)}`);
  }
  if (call.body !== undefined) {
    lines.push('header = "Content-Type: application/json"');
    // --data-raw, not --data: a body starting with "@" must be sent, not read from a file.
    lines.push(`data-raw = ${quote(JSON.stringify(call.body))}`);
  }
  lines.push(
    // [ ] { } in a query string (filter[status]=draft) are data, not curl's URL globbing.
    'globoff',
    // An HTTP_PROXY Docker handed the container must not carry a request for 127.0.0.1 away.
    'noproxy = "*"',
    'silent',
    'show-error',
    'connect-timeout = 10',
    `max-time = ${Math.max(1, Math.round(call.timeoutMs / 1000))}`,
    // The body goes to stdout; everything about the exchange to stderr, after markers, so a
    // body can never be mistaken for it.
    `write-out = ${quote(`%{stderr}\n${META}%{json}\n${HEADERS}%{header_json}\n`)}`,
  );
  return `${lines.join('\n')}\n`;
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read curl's answer: the body from stdout, the rest from the markers on stderr. */
export function parseCurlOutput(res: RunResult): WpRestResponse {
  const at = res.stderr.lastIndexOf(META);
  const own = (at === -1 ? res.stderr : res.stderr.slice(0, at)).trim();
  let meta: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  if (at !== -1) {
    const rest = res.stderr.slice(at + META.length);
    const split = rest.indexOf(HEADERS);
    meta = record(parseJson((split === -1 ? rest : rest.slice(0, split)).trim()));
    if (split !== -1) {
      for (const [name, value] of Object.entries(record(parseJson(rest.slice(split + HEADERS.length).trim())))) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
      }
    }
  }

  let body = res.stdout;
  const cut = body.endsWith(CUT_MARK);
  if (cut) body = body.slice(0, -CUT_MARK.length);
  const kept = Buffer.byteLength(body);
  const sizeBytes = typeof meta.size_download === 'number' ? meta.size_download : kept;
  const code = typeof meta.http_code === 'number' ? meta.http_code : 0;
  const status = code > 0 ? code : null;

  let error: string | null = null;
  if (res.exitCode !== 0) {
    error =
      (typeof meta.errormsg === 'string' && meta.errormsg) ||
      own.replace(/^curl: \(\d+\)\s*/, '') ||
      `curl exited with code ${res.exitCode}`;
  }
  return {
    status,
    statusText: status !== null ? (STATUS_CODES[status] ?? '') : '',
    contentType: typeof meta.content_type === 'string' && meta.content_type ? meta.content_type : null,
    headers,
    body,
    truncated: cut || sizeBytes > kept,
    sizeBytes,
    durationMs: typeof meta.time_total === 'number' ? Math.round(meta.time_total * 1000) : 0,
    error,
  };
}

/** Make the request. Throws only when the container could not be reached at all. */
export async function sendWpRest(docker: DockerPort, container: string, call: WpRestCall): Promise<WpRestResponse> {
  const res = await docker.execWithInput(container, CURL, Buffer.from(curlConfig(call), 'utf8'), {
    // www-data, like wp-cli: curl needs nothing more, and the container has no-new-privileges.
    user: '33:33',
    env: ['HOME=/tmp'],
    timeoutMs: call.timeoutMs + EXEC_GRACE_MS,
    outputCap: call.bodyCap,
  });
  return parseCurlOutput(res);
}

/** `Sorry, you are not allowed to do that. (rest_forbidden)` - WordPress's own error, if the body is one. */
export function wpErrorOf(res: Pick<WpRestResponse, 'body' | 'contentType'>): string | null {
  if (!res.contentType?.includes('json')) return null;
  const err = record(parseJson(res.body));
  const message = typeof err.message === 'string' ? err.message.trim() : '';
  const code = typeof err.code === 'string' ? err.code : '';
  if (!message && !code) return null;
  return code && message ? `${message} (${code})` : message || code;
}
