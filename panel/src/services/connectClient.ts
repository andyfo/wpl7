// @docs sites/external
import crypto from 'node:crypto';
import { PluginClient, PluginSourceError, sha256, type PingAnswer, type PluginClientOptions, type PluginProtocol, type Transport } from './pluginClient.js';

/**
 * The panel's side of the Connect protocol (docs/internal/connect-protocol.md): every request to
 * WPL7 Connect on a site hosted elsewhere, signed with the connection's Ed25519 key. The
 * transport, the retries and the paging actions a backup pulls with are PluginClient's; this adds
 * the signature, the site's home in every request, and the actions only a connected site has.
 */

export const CONNECT_PROTOCOL = { min: 1, max: 1 } as const;

/** The canonical string a request's signature covers (section 3). */
export function connectCanonical(connectionId: number, home: string, action: string, timestamp: number, nonce: string, body: Buffer): string {
  return ['WPL7-CONNECT-V1', String(connectionId), home, action, String(timestamp), nonce, sha256(body)].join('\n');
}

/** `ed25519=<base64url>` over the canonical string. */
export function connectSignature(privateKeyPem: string, canonical: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return `ed25519=${crypto.sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64url')}`;
}

/** A fresh key pair: the private key as PKCS8 PEM for the panel, the public one raw in base64url for the plugin. */
export function connectKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Could not read the new public key');
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: jwk.x };
}

export function connectProtocol(connectionId: number, home: string, privateKeyPem: string): PluginProtocol {
  const key = crypto.createPrivateKey(privateKeyPem);
  const encodedHome = encodeURIComponent(home);
  return {
    marker: 'x-wpl7-connect',
    queryVar: 'wpl7-connect',
    version: 1,
    budgeted: ['snapshot', 'files', 'bundle', 'sql'],
    sign(action, timestamp, nonce, body) {
      const canonical = connectCanonical(connectionId, home, action, timestamp, nonce, body);
      const signature = `ed25519=${crypto.sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64url')}`;
      return {
        headers: {
          'x-wpl7-site': String(connectionId),
          'x-wpl7-home': encodedHome,
          'x-wpl7-timestamp': String(timestamp),
          'x-wpl7-nonce': nonce,
          'x-wpl7-signature': signature,
        },
        query: { _site: String(connectionId), _home: encodedHome, _ts: String(timestamp), _nonce: nonce, _sig: signature },
      };
    },
    words: {
      site: 'the site',
      Site: 'The site',
      host: "the site's host",
      Host: "The site's host",
      refused: 'WPL7 Connect on the site refused the panel. It was disconnected or replaced there: reconnect the site from its Settings tab.',
      paths: '/wp-json/wpl7-connect/ and ?wpl7-connect=',
    },
  };
}

export interface ConnectPing extends PingAnswer {
  home?: string;
  wp?: string;
  php?: string;
  commands?: string[];
  loader?: boolean;
  fs_method?: string;
  file_mods?: boolean;
  offer_seen?: string | null;
}

/** One row of the inventory, in WP-CLI's `plugin list` / `theme list` words. */
export type InventoryRow = Record<string, unknown>;

export interface InventoryAnswer {
  core: { version: string | null; update: { version: string; type: 'major' | 'minor' | null } | null } | null;
  plugins: InventoryRow[];
  themes: InventoryRow[];
  partial: boolean;
}

export interface UpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  error?: string;
  rollback: boolean;
}

export interface OpAnswer {
  op: string;
  state: 'running' | 'done';
  result?: UpdateResult;
}

export interface RestAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface RunAnswer {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Skip these, for this one request (section 10): what the must-use loader takes. */
export interface Rescue {
  skipPlugins?: string[];
  skipTheme?: boolean;
}

export interface ConnectClientOptions extends PluginClientOptions {
  connectionId: number;
  privateKey: string;
}

/** A registered command nobody registered: the 404 of `help` and `run`. */
export class UnknownCommandError extends Error {
  constructor(readonly command: string) {
    super(`'${command}' is not a registered command on this site`);
    this.name = 'UnknownCommandError';
  }
}

export class ConnectClient extends PluginClient {
  constructor(opts: ConnectClientOptions) {
    super(connectProtocol(opts.connectionId, opts.home, opts.privateKey), opts);
  }

  /** `ping`, with the panel's update offer when there is one (section 12). */
  override ping(body: { offer?: { version: string; package: string; expires: number } } = {}): Promise<ConnectPing> {
    return super.ping(body) as Promise<ConnectPing>;
  }

  async info(): Promise<unknown> {
    return (await this.call('info', {})).json;
  }

  async inventory(opts: { check?: boolean; rescue?: Rescue } = {}): Promise<InventoryAnswer> {
    const answer = await this.call('inventory', { check: opts.check ?? true, ...rescueParams(opts.rescue) }, rescueOptions(opts.rescue, 180_000));
    const json = answer.json as Partial<InventoryAnswer> | null;
    return {
      core: json?.core ?? null,
      plugins: Array.isArray(json?.plugins) ? json.plugins : [],
      themes: Array.isArray(json?.themes) ? json.themes : [],
      partial: json?.partial === true,
    };
  }

  /**
   * One update (section 6). A plugin or theme answers when it is done; a core update may answer
   * `running`, and is polled with `op` until it is done or `timeoutMs` passes.
   */
  async update(
    params: { op: string; kind: 'plugin' | 'theme' | 'core' | 'db'; slug?: string; version?: string },
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<OpAnswer> {
    let answer: OpAnswer;
    try {
      answer = (await this.call('update', params, { attempts: 1, timeoutMs: 15 * 60_000 })).json as unknown as OpAnswer;
    } catch (err) {
      // The answer was lost on its way (a proxy gave up, the connection dropped): the plugin
      // keeps the op's state, and says how it went.
      if (err instanceof PluginSourceError && err.fatal) throw err;
      answer = { op: params.op, state: 'running' };
    }
    const deadline = this.now() + (opts.timeoutMs ?? 15 * 60_000);
    while (answer.state !== 'done') {
      if (this.now() > deadline) {
        return { op: params.op, state: 'done', result: { ok: false, from: null, to: null, rollback: false, error: 'The update did not finish within 15 minutes.' } };
      }
      await this.sleep(opts.pollMs ?? 5000);
      const polled = await this.call('op', { op: params.op }, { pass: [404] });
      if (polled.status === 404) {
        return { op: params.op, state: 'done', result: { ok: false, from: null, to: null, rollback: false, error: 'The site does not know this update: it never started.' } };
      }
      answer = polled.json as unknown as OpAnswer;
    }
    return answer;
  }

  async rollback(op: string, items: { kind: 'plugin' | 'theme'; slug: string }[], rescue?: Rescue): Promise<{ kind: string; slug: string; ok: boolean; error?: string }[]> {
    const answer = await this.call('rollback', { op, items, ...rescueParams(rescue) }, rescueOptions(rescue, 300_000));
    const json = answer.json as { items?: { kind: string; slug: string; ok: boolean; error?: string }[] } | null;
    return json?.items ?? [];
  }

  async cleanup(op: string): Promise<void> {
    await this.call('cleanup', { op });
  }

  async component(params: {
    kind: 'plugin' | 'theme';
    slug: string;
    action: 'activate' | 'deactivate' | 'delete' | 'install';
    source?: { wporg: string } | { url: string };
    activate?: boolean;
  }): Promise<{ ok: boolean; status?: string; error?: string }> {
    const answer = await this.call('component', params, { attempts: 2, timeoutMs: 10 * 60_000, pass: [404] });
    if (answer.status === 404) return { ok: false, error: `${params.kind === 'plugin' ? 'Plugin' : 'Theme'} "${params.slug}" is not installed on the site.` };
    return answer.json as unknown as { ok: boolean; status?: string; error?: string };
  }

  async rest(params: { method: string; route: string; query?: string; body?: unknown; user?: string }, timeoutMs = 50_000): Promise<RestAnswer> {
    const answer = await this.call('rest', params, { attempts: 1, timeoutMs });
    const json = answer.json as Partial<RestAnswer> | null;
    return {
      status: Number(json?.status ?? 0),
      headers: (json?.headers ?? {}) as Record<string, string>,
      body: typeof json?.body === 'string' ? json.body : '',
      truncated: json?.truncated === true,
    };
  }

  async commands(): Promise<{ name: string; summary: string }[]> {
    const json = (await this.call('commands', {})).json as { commands?: { name: string; summary: string }[] } | null;
    return json?.commands ?? [];
  }

  /** The text a registered command's help gives for these words; UnknownCommandError for none. */
  async help(words: string[]): Promise<string> {
    const answer = await this.call('help', { words }, { pass: [404] });
    if (answer.status === 404) throw new UnknownCommandError(words.join(' '));
    return String((answer.json as { text?: unknown } | null)?.text ?? '');
  }

  /** Run a registered command; UnknownCommandError when nobody registered `args[0]`. */
  async run(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunAnswer> {
    const answer = await this.call(
      'run',
      { args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) },
      { attempts: 1, pass: [404], timeoutMs: opts.timeoutMs ?? 58_000 },
    );
    if (answer.status === 404) throw new UnknownCommandError(args[0] ?? '');
    const json = answer.json as { stdout?: unknown; stderr?: unknown; exit_code?: unknown } | null;
    return {
      stdout: typeof json?.stdout === 'string' ? json.stdout : '',
      stderr: typeof json?.stderr === 'string' ? json.stderr : '',
      exitCode: typeof json?.exit_code === 'number' ? json.exit_code : 1,
    };
  }

  async login(user: string | null, rescue?: Rescue): Promise<{ url: string; user: string; expiresIn: number }> {
    const answer = await this.call('login', { ...(user ? { user } : {}), ...rescueParams(rescue) }, rescueOptions(rescue, 30_000));
    const json = answer.json as { url?: string; user?: string; expires_in?: number } | null;
    if (!json?.url) throw new PluginSourceError('The site did not send a login link.', false, 'login');
    return { url: json.url, user: String(json.user ?? user ?? ''), expiresIn: Number(json.expires_in ?? 120) };
  }

  async disconnect(): Promise<void> {
    await this.call('disconnect', {}, { attempts: 2 });
  }

  /** The transport that worked last, for the connection's record. */
  get transportUsed(): Transport | null {
    return this.state.transport;
  }
}

function rescueParams(rescue?: Rescue): Record<string, unknown> {
  if (!rescue) return {};
  return {
    ...(rescue.skipPlugins?.length ? { skip_plugins: rescue.skipPlugins } : {}),
    ...(rescue.skipTheme ? { skip_theme: true } : {}),
  };
}

/** A rescue goes through the must-use loader, which only the query transport reaches. */
function rescueOptions(rescue: Rescue | undefined, timeoutMs: number) {
  return rescue ? { only: 'query' as const, attempts: 2, timeoutMs } : { timeoutMs };
}
