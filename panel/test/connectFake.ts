import crypto from 'node:crypto';
import type { PullRequest, PullResponse } from '../src/services/pluginClient.js';
import { connectCanonical } from '../src/services/connectClient.js';
import type { ExternalProbe } from '../src/lib/httpProbe.js';
import { FakeSourceSite, type FakeFile, type FakeTable } from './importFake.js';

/**
 * A WordPress site hosted elsewhere with WPL7 Connect on it, as the panel's ConnectClient sees it
 * (docs/internal/connect-protocol.md): every request's Ed25519 signature checked against the
 * connection's public key and the site's home, the paging actions of the import's fake old site
 * (test/importFake.ts) for backups, and the actions only a connected site has - inventory,
 * updates with rollback, plugin and theme changes, the REST bridge, registered commands, login
 * links, disconnect. Plugins, themes and core live in memory. A test makes it misbehave: an update
 * that breaks the site, an address that changed, a gateway that cuts requests short.
 */

export interface FakePlugin {
  title: string;
  version: string;
  status: 'active' | 'inactive' | 'must-use' | 'dropin' | 'active-network';
  /** The version an update would bring, or null. */
  update?: string | null;
  file?: string;
  autoUpdate?: boolean;
}

export interface FakeTheme {
  title: string;
  version: string;
  status: 'active' | 'parent' | 'inactive';
  update?: string | null;
}

export type FakeCommand = (args: string[], stdin: string | null) => { stdout: string; stderr: string; exitCode: number };

export interface FakeReportExtra {
  admins?: { id: number; login: string; name: string }[];
  fs_method?: string;
  file_mods?: boolean;
  loader?: boolean;
}

const b64urlToBuf = (s: string) => Buffer.from(s, 'base64url');

export class FakeConnectedSite extends FakeSourceSite {
  /** The connection the plugin holds: its id and the panel's public key (raw, base64url). Null once disconnected. */
  connection: { id: number; publicKey: string } | null;
  plugins = new Map<string, FakePlugin>();
  themes = new Map<string, FakeTheme>();
  core = { version: '7.1.2', update: null as { version: string; type: 'major' | 'minor' } | null, dbVersion: 60421, filesDbVersion: 60421 };
  commands = new Map<string, { summary: string; help: string; run: FakeCommand }>();
  /** The site answers at this address now; requests for another home get `home_changed`. */
  currentHome: string;
  /** Plugins whose update breaks the site: after it, every request but a rescue answers 500. */
  fatalAfterUpdate = new Set<string>();
  /** The plugins whose broken update the site has now, which a rescue has to skip. */
  broken = new Set<string>();
  /** Gateway timeouts (504 without the protocol header) for the next requests of these actions. */
  gatewayTimeouts = new Map<string, number>();
  /** Every REST request the bridge ran, with the user it ran as. */
  restCalls: { method: string; route: string; query: string; body: unknown; user: string | null }[] = [];
  /** Answers of the REST bridge, by `METHOD route`. */
  restAnswers = new Map<string, { status: number; body: unknown; headers?: Record<string, string> }>();
  /** Login links minted, with the user. */
  logins: { user: string; url: string }[] = [];
  /** Updates the site ran, as `kind:slug`, and rollbacks and clean-ups the panel asked for. */
  updates: string[] = [];
  rollbacks: { op: string; items: { kind: string; slug: string }[]; skipPlugins: string[]; skipTheme: boolean }[] = [];
  cleanups: string[] = [];
  /** The update offer the last ping carried. */
  offer: { version: string; package: string; expires: number } | null = null;
  readonly extra: FakeReportExtra;
  private ops = new Map<string, { state: 'running' | 'done'; result?: Record<string, unknown>; kind: string; slug: string; previous?: FakePlugin | FakeTheme }>();

  constructor(
    opts: {
      connectionId: number;
      publicKey: string;
      host?: string;
      prefix?: string;
      files?: Record<string, FakeFile>;
      tables?: FakeTable[];
      maxBytes?: number;
    } & FakeReportExtra,
  ) {
    super(
      { token: 'unused', importId: 0, host: opts.host ?? 'shop.example.org', prefix: opts.prefix ?? 'wp_', files: opts.files ?? {}, tables: opts.tables ?? [], maxBytes: opts.maxBytes },
      { name: 'wpl7-connect', marker: 'x-wpl7-connect' },
    );
    this.connection = { id: opts.connectionId, publicKey: opts.publicKey };
    this.currentHome = this.home;
    this.extra = { admins: opts.admins, fs_method: opts.fs_method, file_mods: opts.file_mods, loader: opts.loader };
    this.plugins.set('akismet', { title: 'Akismet Anti-spam', version: '5.7.2', status: 'active', update: '5.8', file: 'akismet/akismet.php' });
    this.plugins.set('hello', { title: 'Hello Dolly', version: '1.7.2', status: 'inactive', file: 'hello.php' });
    this.plugins.set('wpl7-connect', { title: 'WPL7 Connect', version: '0.4.0', status: 'active', file: 'wpl7-connect/wpl7-connect.php' });
    this.themes.set('twentytwentyfive', { title: 'Twenty Twenty-Five', version: '1.5', status: 'active' });
    this.themes.set('twentytwentyfour', { title: 'Twenty Twenty-Four', version: '1.3', status: 'inactive', update: '1.4' });
  }

  /** What the plugin sends to `enroll` and answers to `info`. */
  report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protocol: 1,
      plugin: this.plugins.get('wpl7-connect')?.version ?? '0.4.0',
      time: Math.floor(Date.now() / 1000),
      endpoint: this.endpoint,
      home: this.currentHome,
      siteurl: this.currentHome,
      abspath: '/var/www/html/',
      content_dir: '/var/www/html/wp-content',
      uploads_dir: '/var/www/html/wp-content/uploads',
      multisite: false,
      windows: false,
      table_prefix: this.opts.prefix ?? 'wp_',
      wp: this.core.version,
      php: '8.3.35',
      locale: 'en_US',
      blog_public: 1,
      admin_email: 'admin@shop.example.org',
      title: 'Example Shop',
      https: this.currentHome.startsWith('https://'),
      db: { server: 'MariaDB 11.4.5', bytes: 2_000_000, tables: (this.opts.tables ?? []).map((t) => ({ name: t.name, rows: t.rows.length, bytes: 1000, pk: t.pk })) },
      files: { count: Object.keys(this.opts.files).length, bytes: 4096, dirs: 3, links: 0, unreadable: 0, excluded: [] },
      dropins: [],
      mu_plugins: [],
      plugins: [...this.plugins.entries()].map(([slug, p]) => ({ file: p.file ?? `${slug}/${slug}.php`, slug, name: p.title, version: p.version, active: p.status === 'active' })),
      theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.5' },
      admins: this.extra.admins ?? [{ id: 1, login: 'admin', name: 'Admin' }, { id: 7, login: 'editor-in-chief', name: 'Chief' }],
      fs_method: this.extra.fs_method ?? 'direct',
      file_mods: this.extra.file_mods ?? true,
      loader: this.extra.loader ?? true,
      commands: [...this.commands.keys()],
      warnings: [],
      ...overrides,
    };
  }

  /** The home page answers 503 (another plugin's maintenance page), while WPL7 Connect still answers. */
  homeDown = false;

  /** The panel's uptime probe of the site's home page. */
  probe: ExternalProbe = async () => {
    if (this.broken.size > 0) return { ok: false, status: 500, ms: 12, certExpiresAt: null };
    if (this.homeDown) return { ok: false, status: 503, ms: 12, certExpiresAt: this.certExpiresAt };
    return { ok: true, status: 200, ms: 12, certExpiresAt: this.certExpiresAt };
  };
  certExpiresAt: number | null = Date.now() + 60 * 24 * 3600_000;

  /** A broken update answers 500 before the plugin is reached, unless the loader skips what broke it. */
  protected override beforeSignature(action: string, req: PullRequest, via: 'rest' | 'query'): PullResponse | null {
    const timeouts = this.gatewayTimeouts.get(action) ?? 0;
    if (timeouts > 0) {
      this.gatewayTimeouts.set(action, timeouts - 1);
      return { status: 504, headers: { 'content-type': 'text/html' }, body: Buffer.from('<h1>Gateway Timeout</h1>') };
    }
    if (this.broken.size === 0) return null;
    const params = JSON.parse(req.body.toString('utf8') || '{}') as { skip_plugins?: string[] };
    const skipped = new Set(params.skip_plugins ?? []);
    const rescued = via === 'query' && [...this.broken].every((slug) => skipped.has(this.plugins.get(slug)?.file ?? `${slug}/${slug}.php`));
    if (rescued) return null;
    return { status: 500, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>There has been a critical error on this website.</p>') };
  }

  protected override verify(action: string, req: PullRequest, now: number): PullResponse | null {
    if (!this.connection) return this.error(401, 'unauthorized');
    const site = req.headers['x-wpl7-site'];
    const homeHeader = req.headers['x-wpl7-home'] ?? '';
    const ts = Number(req.headers['x-wpl7-timestamp']);
    const nonce = req.headers['x-wpl7-nonce'] ?? '';
    const sig = req.headers['x-wpl7-signature'] ?? '';
    if (site !== String(this.connection.id) || !/^[0-9a-f]{32}$/.test(nonce) || !/^ed25519=[A-Za-z0-9_-]{86}$/.test(sig)) {
      return this.error(401, 'unauthorized');
    }
    const home = decodeURIComponent(homeHeader);
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: this.connection.publicKey }, format: 'jwk' });
    const canonical = connectCanonical(this.connection.id, home, action, ts, nonce, req.body);
    if (!crypto.verify(null, Buffer.from(canonical, 'utf8'), key, b64urlToBuf(sig.slice('ed25519='.length)))) {
      return this.error(401, 'unauthorized');
    }
    if (home !== this.currentHome) return this.error(409, 'home_changed', { home: this.currentHome });
    if (Math.abs(now - ts) > 300) return this.error(401, 'stale', { time: now });
    return null;
  }

  registerCommand(name: string, summary: string, run: FakeCommand, help = `NAME\n\n  wp ${name}\n\nDESCRIPTION\n\n  ${summary}\n`): void {
    this.commands.set(name, { summary, help, run });
  }

  protected override answer(action: string, p: Record<string, unknown>, now: number, via: 'rest' | 'query' = 'rest'): PullResponse {
    switch (action) {
      case 'ping': {
        if (p.offer && typeof p.offer === 'object') this.offer = p.offer as FakeConnectedSite['offer'];
        return this.json(200, {
          protocol: 1,
          plugin: this.plugins.get('wpl7-connect')?.version ?? '0.4.0',
          time: now,
          limits: { max_ms: 10000, max_bytes: this.maxBytes, max_row_bytes: 15 * 1024 * 1024 },
          transports: ['rest', 'query'],
          encodings: ['raw', 'base64', 'gzip'],
          actions: ['ping', 'info', 'snapshot', 'files', 'range', 'bundle', 'tables', 'sql', 'inventory', 'update', 'op', 'rollback', 'cleanup', 'component', 'rest', 'commands', 'help', 'run', 'login', 'disconnect'],
          home: this.currentHome,
          wp: this.core.version,
          php: '8.3.35',
          commands: [...this.commands.keys()],
          loader: this.extra.loader ?? true,
          fs_method: this.extra.fs_method ?? 'direct',
          file_mods: this.extra.file_mods ?? true,
          offer_seen: this.offer?.version ?? null,
        });
      }
      case 'info':
        return this.json(200, this.report());
      case 'inventory':
        return this.json(200, this.inventory());
      case 'update':
        return this.update(p);
      case 'op': {
        const op = this.ops.get(String(p.op));
        if (!op) return this.error(404, 'not_found', { detail: 'op' });
        return this.json(200, { op: p.op, state: op.state, ...(op.result ? { result: op.result } : {}) });
      }
      case 'rollback': {
        const items = (p.items as { kind: string; slug: string }[]) ?? [];
        const op = this.ops.get(String(p.op));
        this.rollbacks.push({ op: String(p.op), items, skipPlugins: (p.skip_plugins as string[]) ?? [], skipTheme: p.skip_theme === true });
        const out = items.map((item) => {
          if (!op?.previous || op.slug !== item.slug) return { kind: item.kind, slug: item.slug, ok: false, error: 'No copy to roll back to.' };
          if (item.kind === 'plugin') this.plugins.set(item.slug, op.previous as FakePlugin);
          else this.themes.set(item.slug, op.previous as FakeTheme);
          this.broken.delete(item.slug);
          return { kind: item.kind, slug: item.slug, ok: true };
        });
        return this.json(200, { items: out });
      }
      case 'cleanup':
        this.cleanups.push(String(p.op));
        return this.json(200, { ok: true });
      case 'component':
        return this.component(p);
      case 'rest': {
        const call = { method: String(p.method), route: String(p.route), query: String(p.query ?? ''), body: p.body, user: typeof p.user === 'string' ? p.user : null };
        this.restCalls.push(call);
        const answer = this.restAnswers.get(`${call.method} ${call.route}`) ?? { status: 404, body: { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' } };
        return this.json(200, { status: answer.status, headers: { 'content-type': 'application/json; charset=UTF-8', ...(answer.headers ?? {}) }, body: JSON.stringify(answer.body), truncated: false });
      }
      case 'commands':
        return this.json(200, { commands: [...this.commands.entries()].map(([name, c]) => ({ name, summary: c.summary })) });
      case 'help': {
        const words = (p.words as string[]) ?? [];
        if (words.length === 0) {
          return this.json(200, { text: `usage: wp <command>\n\n${[...this.commands.entries()].map(([n, c]) => `  ${n}  ${c.summary}`).join('\n')}\n` });
        }
        const cmd = this.commands.get(words[0]!);
        if (!cmd) return this.error(404, 'not_found', { detail: 'command' });
        return this.json(200, { text: cmd.help });
      }
      case 'run': {
        const args = (p.args as string[]) ?? [];
        const cmd = this.commands.get(args[0] ?? '');
        if (!cmd) return this.error(404, 'not_found', { detail: 'command' });
        const res = cmd.run(args, typeof p.stdin === 'string' ? p.stdin : null);
        return this.json(200, { stdout: res.stdout, stderr: res.stderr, exit_code: res.exitCode });
      }
      case 'login': {
        const user = typeof p.user === 'string' ? p.user : 'admin';
        const url = `${this.currentHome}/?wpl7-connect-login=${crypto.randomBytes(12).toString('hex')}.${crypto.randomBytes(32).toString('base64url')}`;
        this.logins.push({ user, url });
        return this.json(200, { url, user, expires_in: 120 });
      }
      case 'disconnect':
        this.connection = null;
        return this.json(200, { ok: true });
      default:
        return super.answer(action, p, now, via);
    }
  }

  private inventory(): Record<string, unknown> {
    const plugin = ([name, p]: [string, FakePlugin]) => ({
      name,
      title: p.title,
      status: p.status,
      version: p.version,
      update: p.update ? 'available' : 'none',
      update_version: p.update ?? '',
      auto_update: p.autoUpdate ? 'on' : 'off',
      file: p.file ?? `${name}/${name}.php`,
    });
    const theme = ([name, t]: [string, FakeTheme]) => ({
      name,
      title: t.title,
      status: t.status,
      version: t.version,
      update: t.update ? 'available' : 'none',
      update_version: t.update ?? '',
      auto_update: 'off',
    });
    return {
      core: { version: this.core.version, update: this.core.update },
      plugins: [...this.plugins.entries()].map(plugin),
      themes: [...this.themes.entries()].map(theme),
      partial: false,
    };
  }

  private update(p: Record<string, unknown>): PullResponse {
    const op = String(p.op ?? '');
    if (!/^[a-z0-9]{16,64}$/.test(op)) return this.error(422, 'unsupported', { detail: 'op' });
    if ((this.extra.fs_method ?? 'direct') !== 'direct') return this.error(422, 'unsupported', { detail: 'filesystem' });
    const kind = String(p.kind);
    const slug = String(p.slug ?? '');
    const done = (result: Record<string, unknown>, previous?: FakePlugin | FakeTheme) => {
      this.ops.set(op, { state: 'done', result, kind, slug, previous });
      return this.json(200, { op, state: 'done', result });
    };
    if (kind === 'plugin' || kind === 'theme') {
      const list = kind === 'plugin' ? this.plugins : this.themes;
      const item = list.get(slug) as FakePlugin | FakeTheme | undefined;
      if (!item) return this.error(404, 'not_found', { detail: kind });
      if (!item.update) return done({ ok: false, from: item.version, to: null, error: 'No update is available.', rollback: false });
      const previous = { ...item };
      const to = item.update;
      list.set(slug, { ...item, version: to, update: null } as never);
      this.updates.push(`${kind}:${slug}`);
      if (kind === 'plugin' && this.fatalAfterUpdate.has(slug)) this.broken.add(slug);
      return done({ ok: true, from: previous.version, to, rollback: true }, previous);
    }
    if (kind === 'core') {
      const from = this.core.version;
      if (!this.core.update || this.core.update.version !== p.version) return done({ ok: false, from, to: null, error: `WordPress ${String(p.version)} is not on offer.`, rollback: false });
      this.core.version = this.core.update.version;
      this.core.update = null;
      this.core.filesDbVersion++;
      this.updates.push('core');
      // A core update answers `running` at once; the panel asks `op` for the outcome.
      this.ops.set(op, { state: 'done', result: { ok: true, from, to: this.core.version, rollback: false }, kind, slug: '' });
      return this.json(200, { op, state: 'running' });
    }
    if (kind === 'db') {
      const from = this.core.dbVersion;
      this.core.dbVersion = this.core.filesDbVersion;
      this.updates.push('db');
      return done({ ok: true, from: String(from), to: String(this.core.dbVersion), rollback: false });
    }
    return this.error(422, 'unsupported', { detail: 'kind' });
  }

  private component(p: Record<string, unknown>): PullResponse {
    const kind = String(p.kind);
    const slug = String(p.slug);
    const action = String(p.action);
    if (kind === 'plugin' && slug === 'wpl7-connect' && (action === 'deactivate' || action === 'delete')) {
      return this.json(200, { ok: false, error: 'WPL7 Connect connects this site to the panel.' });
    }
    if (action === 'install') {
      const source = (p.source ?? {}) as { wporg?: string; url?: string };
      if (source.url !== undefined && !source.url.includes('/api/connect/catalog/')) return this.error(422, 'unsupported', { detail: 'source' });
      const name = source.wporg ?? slug;
      if (kind === 'plugin') this.plugins.set(name, { title: name, version: '1.0', status: p.activate === false ? 'inactive' : 'active' });
      else this.themes.set(name, { title: name, version: '1.0', status: 'inactive' });
      return this.json(200, { ok: true, status: kind === 'plugin' && p.activate !== false ? 'active' : 'inactive' });
    }
    const list = kind === 'plugin' ? this.plugins : this.themes;
    const item = list.get(slug);
    if (!item) return this.error(404, 'not_found', { detail: kind });
    if (action === 'delete') {
      if (kind === 'theme' && (item.status === 'active' || item.status === 'parent')) return this.json(200, { ok: false, error: 'The active theme cannot be deleted.' });
      list.delete(slug);
      return this.json(200, { ok: true, status: 'deleted' });
    }
    if (kind === 'theme' && action === 'activate') {
      for (const [n, t] of this.themes) if (t.status === 'active') this.themes.set(n, { ...t, status: 'inactive' });
    }
    list.set(slug, { ...item, status: action === 'activate' ? 'active' : 'inactive' } as never);
    return this.json(200, { ok: true, status: action === 'activate' ? 'active' : 'inactive' });
  }
}
