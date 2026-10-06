// @docs integrations/mcp
import crypto from 'node:crypto';
import { and, count, eq, lt, notExists } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { oauthClients, oauthGrants, oauthTokens, users, type OAuthClientRow } from '../db/schema.js';
import type { Config } from '../config.js';
import { sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { mcpOrigin } from '../lib/panelUrl.js';
import type { McpPrincipal } from '../mcp/call.js';
import type { Logger } from './index.js';
import type { SettingsService } from './settings.js';
import { allows, isAccessLevel, type AccessLevel } from '../../shared/access.js';
import {
  checkRedirectUri,
  cleanClientName,
  levelOfScope,
  MAX_REDIRECT_URI_LENGTH,
  redirectMatches,
  scopeOfLevel,
  type RedirectKind,
} from '../../shared/oauth.js';
import type { McpConnectionDto, McpWindowDto, OAuthCheckDto } from '../../shared/types.js';

/**
 * OAuth sign-in for the MCP server (docs/mcp.md): how claude.ai, ChatGPT and the other apps
 * that cannot be handed an API key connect. The panel is its own authorization server - public
 * clients, dynamic registration (RFC 7591), the authorization code with PKCE, rotating refresh
 * tokens and revocation (RFC 7009) - and the MCP endpoint is its only resource.
 *
 * The danger it is built around is an admin lured into approving a fake "Claude": anybody can
 * register a client under any name. So nothing can register or be approved until an admin
 * presses **Connect an app** on the MCP page. That opens a window of ten minutes in which one
 * app may register and that same admin may approve it, once. A link that reaches an admin at
 * any other moment is shown "no connection is being set up".
 *
 * Tokens are opaque and stored as sha256, with prefixes the REST gate never takes for an API
 * key: they work at /mcp and nowhere else. An approval lends the app what the admin picked for
 * it - Read only unless they chose more - and the app acts as itself, never as the admin.
 */

const ACCESS_TTL_MS = 3600_000;
/** Sliding: every refresh starts it again, so an app in use never has to sign in again. */
const REFRESH_TTL_MS = 60 * 24 * 3600_000;
const CODE_TTL_MS = 120_000;
export const WINDOW_TTL_MS = 10 * 60_000;
/**
 * How long a refresh token that was just exchanged may be exchanged again: a response lost on
 * the way back, or two copies of one app refreshing at once. After that, the old token coming
 * back means someone else has it - and the connection ends.
 */
const REFRESH_GRACE_MS = 60_000;
export const MAX_CLIENTS = 100;
const MAX_REDIRECT_URIS = 5;
/** An app with no connection is gone a day after it registered: it can never be approved again. */
const ORPHAN_CLIENT_TTL_MS = 24 * 3600_000;

export const ACCESS_TOKEN_PREFIX = 'wpl7at_';
const REFRESH_TOKEN_PREFIX = 'wpl7rt_';
const CODE_PREFIX = 'wpl7ac_';
const CLIENT_ID_PREFIX = 'wpl7ci_';

const WINDOW_KEY = 'mcp.connectWindow';

interface ConnectWindow {
  userId: number;
  until: number;
  /** The one app that registered in this window, once one has. */
  clientId: string | null;
}

/** An OAuth protocol error: RFC 6749's `{error, error_description}`, not the panel's envelope. */
export class OAuthProblem extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

interface PendingCode {
  clientId: string;
  userId: number;
  access: AccessLevel;
  resource: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
  /** Set once redeemed: the grant it produced, which a second redemption ends. */
  grantId: number | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** An authorization request as the approval page sent it, checked. */
type Checked =
  | { status: 'ready'; client: OAuthClientRow; redirect: string; kind: RedirectKind; host: string; state: string | null; requested: AccessLevel | null; challenge: string }
  | { status: 'closed'; reason: string }
  | { status: 'error'; message: string; returnTo: string | null };

const token = (prefix: string) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class OAuthService {
  /** Authorization codes live two minutes, so they live here: a restart fails closed. */
  private readonly codes = new Map<string, PendingCode>();
  private readonly lastUsedWrites = new Map<number, number>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Where all of it lives: the issuer, the resource, every endpoint. Null when MCP cannot run. */
  origin(): string | null {
    return mcpOrigin(this.config);
  }

  private resource(): string {
    return `${this.origin()}/mcp`;
  }

  // ---------------------------------------------------------------- the connection window

  private currentWindow(): ConnectWindow | null {
    const window = this.settings.getRaw(WINDOW_KEY) as ConnectWindow | undefined;
    return window && window.until > this.now() ? window : null;
  }

  openWindow(userId: number): void {
    this.settings.setRaw(WINDOW_KEY, { userId, until: this.now() + WINDOW_TTL_MS, clientId: null } satisfies ConnectWindow);
  }

  closeWindow(): void {
    this.settings.setRaw(WINDOW_KEY, null);
  }

  /**
   * Take back the app that registered in this admin's window, and keep the window open for the
   * right one. Anybody can register while a window is open - a stranger may get in first - and an
   * app that went wrong halfway wants to register again. False when there is nothing to discard.
   */
  discardRegistration(userId: number): boolean {
    return this.db.transaction(() => {
      const window = this.currentWindow();
      if (!window || window.userId !== userId || !window.clientId) return false;
      const connected = this.db.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, window.clientId)).get();
      if (!connected) this.db.delete(oauthClients).where(eq(oauthClients.clientId, window.clientId)).run();
      this.settings.setRaw(WINDOW_KEY, { ...window, clientId: null } satisfies ConnectWindow);
      return true;
    });
  }

  /** The window as the MCP page shows it, to the admin looking. */
  windowFor(viewerId: number | null): McpWindowDto | null {
    const window = this.currentWindow();
    if (!window) return null;
    const owner = this.db.select({ username: users.username }).from(users).where(eq(users.id, window.userId)).get();
    const client = window.clientId ? this.client(window.clientId) : null;
    return {
      until: window.until,
      byMe: viewerId === window.userId,
      openedBy: owner?.username ?? null,
      registered: client
        ? { name: client.name, redirectHosts: this.redirectUris(client).map((u) => hostOf(u)) }
        : null,
    };
  }

  // ---------------------------------------------------------------- registration

  /**
   * RFC 7591, public clients only. Fields it does not know are ignored, as the RFC asks; a
   * client asking for a secret gets none and `token_endpoint_auth_method: "none"` says so.
   */
  register(body: unknown, ip: string | null): Record<string, unknown> {
    const window = this.currentWindow();
    if (!window) {
      throw new OAuthProblem(403, 'access_denied', 'No connection is being set up. An admin has to press "Connect an app" on the MCP page of the panel first');
    }
    if (window.clientId) {
      throw new OAuthProblem(403, 'access_denied', 'An app has already registered in this connection window. Open a new one to connect another');
    }
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const uris = input.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => typeof u === 'string')) {
      throw new OAuthProblem(400, 'invalid_redirect_uri', `Send redirect_uris: between 1 and ${MAX_REDIRECT_URIS} URLs`);
    }
    for (const uri of uris as string[]) {
      if (uri.length > MAX_REDIRECT_URI_LENGTH) {
        throw new OAuthProblem(400, 'invalid_redirect_uri', `A redirect URI is longer than ${MAX_REDIRECT_URI_LENGTH} characters`);
      }
      const checked = checkRedirectUri(uri);
      if (!checked.ok) throw new OAuthProblem(400, 'invalid_redirect_uri', `${uri} ${checked.problem}`);
    }
    const grantTypes = input.grant_types;
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))) {
      throw new OAuthProblem(400, 'invalid_client_metadata', 'Only the authorization_code grant (with refresh_token) is offered');
    }
    const responseTypes = input.response_types;
    if (responseTypes !== undefined && (!Array.isArray(responseTypes) || !responseTypes.includes('code'))) {
      throw new OAuthProblem(400, 'invalid_client_metadata', 'Only response_type "code" is offered');
    }

    this.prune();
    const clients = this.db.select({ n: count() }).from(oauthClients).get()?.n ?? 0;
    if (clients >= MAX_CLIENTS) {
      throw new OAuthProblem(503, 'temporarily_unavailable', `This panel already has ${MAX_CLIENTS} registered apps; remove unused connections first`);
    }

    const now = this.now();
    const clientId = token(CLIENT_ID_PREFIX).slice(0, CLIENT_ID_PREFIX.length + 22);
    const name = cleanClientName(input.client_name);
    // Read, decide and write in one turn: two registrations racing for one window cannot both win.
    const won = this.db.transaction(() => {
      const current = this.currentWindow();
      if (!current || current.clientId) return false;
      this.db.insert(oauthClients).values({ clientId, name, redirectUris: JSON.stringify(uris), createdIp: ip, createdAt: now }).run();
      this.settings.setRaw(WINDOW_KEY, { ...current, clientId } satisfies ConnectWindow);
      return true;
    });
    if (!won) throw new OAuthProblem(403, 'access_denied', 'An app has already registered in this connection window');
    this.log.info(`MCP: app "${name}" registered from ${ip ?? 'an unknown address'}`);
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // ---------------------------------------------------------------- authorization (the page)

  /** What the approval page shows for an authorization request, before anyone clicks. */
  check(rawQuery: string, userId: number): OAuthCheckDto {
    const checked = this.checkRequest(rawQuery, userId);
    if (checked.status !== 'ready') return checked;
    return {
      status: 'ready',
      client: { name: checked.client.name },
      redirect: { kind: checked.kind, host: checked.host },
      requested: checked.requested,
    };
  }

  /**
   * The admin's click. Approving consumes the window and hands back where to send the browser
   * with a code; denying sends it back with `access_denied`. Either way the page navigates
   * because of the click - the panel never sends a browser anywhere on its own.
   */
  decide(rawQuery: string, userId: number, approve: boolean, access: AccessLevel): { redirectTo: string } {
    const checked = this.checkRequest(rawQuery, userId);
    if (checked.status === 'error') {
      if (checked.returnTo) return { redirectTo: checked.returnTo };
      throw badRequest(checked.message);
    }
    if (checked.status === 'closed') throw conflict(checked.reason);
    const back = (params: Record<string, string>) => this.redirectWith(checked.redirect, { ...params, ...(checked.state !== null ? { state: checked.state } : {}) });
    if (!approve) return { redirectTo: back({ error: 'access_denied', error_description: 'The admin declined' }) };

    const consumed = this.db.transaction(() => {
      const window = this.currentWindow();
      if (!window || !this.windowAdmits(window, userId, checked.client)) return false;
      this.closeWindow();
      return true;
    });
    if (!consumed) throw conflict('The connection window closed meanwhile; open a new one');

    const code = token(CODE_PREFIX);
    this.pruneCodes();
    this.codes.set(sha256Hex(code), {
      clientId: checked.client.clientId,
      userId,
      access,
      resource: this.resource(),
      redirectUri: checked.redirect,
      challenge: checked.challenge,
      expiresAt: this.now() + CODE_TTL_MS,
      grantId: null,
    });
    this.log.info(`MCP: app "${checked.client.name}" approved with ${access} access (user #${userId})`);
    return { redirectTo: back({ code }) };
  }

  /**
   * A window lets its own admin approve the app that registered in it - or, when none did, an
   * app this admin has connected right now, asking again with the registration it kept (Claude
   * Code, VS Code and mcp-remote keep theirs). Never one whose connection has ended: revoking
   * forgets the app (endConnection), and a registration nobody approved stays useless.
   */
  private windowAdmits(window: ConnectWindow, userId: number, client: OAuthClientRow): boolean {
    if (window.userId !== userId) return false;
    if (window.clientId) return window.clientId === client.clientId;
    const connected = this.db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.clientId, client.clientId), eq(oauthGrants.userId, userId)))
      .get();
    return connected !== undefined;
  }

  private checkRequest(rawQuery: string, userId: number): Checked {
    const params = new Map<string, string>();
    const repeated = new Set<string>();
    for (const [k, v] of new URLSearchParams(rawQuery.replace(/^\?/, ''))) {
      if (params.has(k)) repeated.add(k);
      params.set(k, v);
    }
    // Without a known app and one of its own redirect URIs there is nowhere safe to send an
    // error: it is shown here, and the browser stays.
    const clientId = params.get('client_id');
    const client = clientId && !repeated.has('client_id') ? this.client(clientId) : null;
    if (!client) return { status: 'error', message: 'This link names no app registered here', returnTo: null };
    const registered = this.redirectUris(client);
    const asked = params.get('redirect_uri');
    let redirect: string | null = null;
    if (repeated.has('redirect_uri')) redirect = null;
    else if (asked === undefined) redirect = registered.length === 1 ? registered[0]! : null;
    else redirect = registered.some((r) => redirectMatches(r, asked)) ? asked : null;
    const checked = redirect ? checkRedirectUri(redirect) : null;
    if (!redirect || !checked?.ok) {
      return { status: 'error', message: `This link would send you somewhere "${client.name}" did not register`, returnTo: null };
    }

    const state = repeated.has('state') ? null : (params.get('state') ?? null);
    const fail = (error: string, description: string): Checked => ({
      status: 'error',
      message: description,
      returnTo: this.redirectWith(redirect, { error, error_description: description, ...(state !== null ? { state } : {}) }),
    });
    if (repeated.size > 0) return fail('invalid_request', `Sent more than once: ${[...repeated].join(', ')}`);
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is offered');
    const challenge = params.get('code_challenge') ?? '';
    // An absent method means "plain" (RFC 7636), which is not PKCE at all.
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const resource = params.get('resource');
    if (resource !== undefined && !this.isOurResource(resource)) {
      return fail('invalid_target', `This server's only resource is ${this.resource()}`);
    }
    if (state !== null && state.length > 2000) return fail('invalid_request', 'state is longer than 2000 characters');

    const window = this.currentWindow();
    if (!window || !this.windowAdmits(window, userId, client)) {
      return { status: 'closed', reason: closedReason(window, userId, client) };
    }
    return {
      status: 'ready',
      client,
      redirect,
      kind: checked.kind,
      host: checked.host,
      state,
      requested: levelOfScope(params.get('scope')),
      challenge,
    };
  }

  /** The redirect URI with parameters added - and `iss`, so an app talking to several can tell (RFC 9207). */
  private redirectWith(redirect: string, params: Record<string, string>): string {
    const url = new URL(redirect);
    for (const [k, v] of Object.entries({ ...params, iss: this.origin() ?? '' })) url.searchParams.set(k, v);
    return url.toString();
  }

  private isOurResource(resource: string): boolean {
    try {
      const want = new URL(this.resource());
      const got = new URL(resource);
      return got.origin === want.origin && got.pathname.replace(/\/$/, '') === want.pathname && !got.search && !got.hash;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- the token endpoint

  exchangeCode(p: Record<string, string>): TokenResponse {
    const client = this.clientFor(p);
    const code = p.code ?? '';
    const key = sha256Hex(code);
    const pending = code.startsWith(CODE_PREFIX) ? this.codes.get(key) : undefined;
    if (!pending || pending.expiresAt <= this.now()) {
      this.codes.delete(key);
      throw new OAuthProblem(400, 'invalid_grant', 'The code is unknown or has expired');
    }
    if (pending.grantId !== null) {
      // A code redeemed twice: whoever has it now may not be the app it was for, so the
      // connection the first redemption made ends too (RFC 6749 section 4.1.2).
      this.codes.delete(key);
      this.endConnection(pending.grantId);
      this.log.warn(`MCP: an authorization code was used twice; connection #${pending.grantId} revoked`);
      throw new OAuthProblem(400, 'invalid_grant', 'The code was already used');
    }
    if (pending.clientId !== client.clientId) throw new OAuthProblem(400, 'invalid_grant', 'The code was issued to another app');
    if (p.redirect_uri !== undefined && p.redirect_uri !== pending.redirectUri) {
      throw new OAuthProblem(400, 'invalid_grant', 'redirect_uri is not the one the code was issued for');
    }
    if (p.resource !== undefined && !this.isOurResource(p.resource)) {
      throw new OAuthProblem(400, 'invalid_target', `This server's only resource is ${this.resource()}`);
    }
    const verifier = p.code_verifier ?? '';
    const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameSecret(computed, pending.challenge)) {
      // A wrong verifier burns the code: it has been seen by someone who does not hold the secret.
      this.codes.delete(key);
      throw new OAuthProblem(400, 'invalid_grant', 'code_verifier does not match the code_challenge');
    }
    const approver = this.db.select({ id: users.id }).from(users).where(eq(users.id, pending.userId)).get();
    if (!approver) {
      this.codes.delete(key);
      throw new OAuthProblem(400, 'invalid_grant', 'The admin who approved this app no longer exists');
    }

    const now = this.now();
    const { grantId, tokens } = this.db.transaction(() => {
      // One connection per app per admin: approving again replaces the earlier one.
      this.db
        .delete(oauthGrants)
        .where(and(eq(oauthGrants.clientId, client.clientId), eq(oauthGrants.userId, pending.userId)))
        .run();
      const grant = this.db
        .insert(oauthGrants)
        .values({
          clientId: client.clientId,
          userId: pending.userId,
          access: pending.access,
          resource: pending.resource,
          redirectUri: pending.redirectUri,
          createdAt: now,
          lastUsedAt: now,
        })
        .returning()
        .get();
      this.db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.clientId, client.clientId)).run();
      return { grantId: grant.id, tokens: this.issue(grant.id, pending.access) };
    });
    pending.grantId = grantId;
    return tokens;
  }

  refresh(p: Record<string, string>): TokenResponse {
    const client = this.clientFor(p);
    const presented = p.refresh_token ?? '';
    if (!presented.startsWith(REFRESH_TOKEN_PREFIX)) throw new OAuthProblem(400, 'invalid_grant', 'Unknown refresh token');
    // Read, decide and write in one turn (better-sqlite3 is synchronous): two refreshes racing
    // cannot both rotate the same token, or both slip through the reuse check. What a refusal
    // deletes is deleted after the transaction, which would roll it back on the throw.
    type Outcome = { tokens: TokenResponse } | { problem: OAuthProblem; revokeGrant?: number; dropToken?: number };
    const outcome = this.db.transaction((): Outcome => {
      const row = this.db
        .select({ token: oauthTokens, grant: oauthGrants })
        .from(oauthTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
        .where(and(eq(oauthTokens.tokenHash, sha256Hex(presented)), eq(oauthTokens.kind, 'refresh')))
        .get();
      if (!row || row.grant.clientId !== client.clientId) {
        return { problem: new OAuthProblem(400, 'invalid_grant', 'Unknown refresh token') };
      }
      const now = this.now();
      if (row.token.expiresAt <= now) {
        return { problem: new OAuthProblem(400, 'invalid_grant', 'The refresh token has expired; sign in again'), dropToken: row.token.id };
      }
      if (row.token.rotatedAt !== null && now - row.token.rotatedAt > REFRESH_GRACE_MS) {
        // A token already exchanged, back long after: it was copied. End the connection.
        return {
          problem: new OAuthProblem(400, 'invalid_grant', 'The refresh token was already used; sign in again'),
          revokeGrant: row.grant.id,
        };
      }
      const granted = isAccessLevel(row.grant.access) ? row.grant.access : 'read';
      const asked = p.scope ? levelOfScope(p.scope) : null;
      if (p.scope && (!asked || !allows(granted, asked))) {
        return { problem: new OAuthProblem(400, 'invalid_scope', `This connection is limited to ${scopeOfLevel(granted)}`) };
      }
      if (p.resource !== undefined && !this.isOurResource(p.resource)) {
        return { problem: new OAuthProblem(400, 'invalid_target', `This server's only resource is ${this.resource()}`) };
      }
      if (row.token.rotatedAt === null) {
        this.db.update(oauthTokens).set({ rotatedAt: now }).where(eq(oauthTokens.id, row.token.id)).run();
      }
      this.db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, row.grant.id)).run();
      this.db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.clientId, client.clientId)).run();
      return { tokens: this.issue(row.grant.id, granted) };
    });
    if ('tokens' in outcome) return outcome.tokens;
    if (outcome.revokeGrant !== undefined) {
      this.endConnection(outcome.revokeGrant);
      this.log.warn(`MCP: a refresh token was used again after it was rotated; connection #${outcome.revokeGrant} revoked`);
    }
    if (outcome.dropToken !== undefined) this.db.delete(oauthTokens).where(eq(oauthTokens.id, outcome.dropToken)).run();
    throw outcome.problem;
  }

  /**
   * RFC 7009: always "done", whatever was sent, so a revocation says nothing about which tokens
   * exist. A refresh token ends the whole connection; an access token only itself.
   */
  revoke(p: Record<string, string>): void {
    const presented = p.token ?? '';
    if (!presented.startsWith(ACCESS_TOKEN_PREFIX) && !presented.startsWith(REFRESH_TOKEN_PREFIX)) return;
    const row = this.db
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(eq(oauthTokens.tokenHash, sha256Hex(presented)))
      .get();
    if (!row) return;
    if (p.client_id !== undefined && p.client_id !== row.grant.clientId) return;
    if (row.token.kind === 'refresh') {
      this.endConnection(row.grant.id);
      this.log.info(`MCP: connection #${row.grant.id} disconnected by its app`);
    } else {
      this.db.delete(oauthTokens).where(eq(oauthTokens.id, row.token.id)).run();
    }
  }

  private clientFor(p: Record<string, string>): OAuthClientRow {
    const client = p.client_id ? this.client(p.client_id) : null;
    if (!client) throw new OAuthProblem(401, 'invalid_client', 'Unknown client_id');
    return client;
  }

  private issue(grantId: number, access: AccessLevel): TokenResponse {
    const now = this.now();
    const access_token = token(ACCESS_TOKEN_PREFIX);
    const refresh_token = token(REFRESH_TOKEN_PREFIX);
    this.db
      .insert(oauthTokens)
      .values([
        { grantId, kind: 'access', tokenHash: sha256Hex(access_token), expiresAt: now + ACCESS_TTL_MS, createdAt: now },
        { grantId, kind: 'refresh', tokenHash: sha256Hex(refresh_token), expiresAt: now + REFRESH_TTL_MS, createdAt: now },
      ])
      .run();
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token, scope: scopeOfLevel(access) };
  }

  // ---------------------------------------------------------------- the resource

  /** Who an access token at /mcp is: its connection, at the level the connection has right now. */
  principalFor(accessToken: string): McpPrincipal | null {
    if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const row = this.db
      .select({ token: oauthTokens, grant: oauthGrants, client: oauthClients, username: users.username })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthGrants.clientId))
      .innerJoin(users, eq(users.id, oauthGrants.userId))
      .where(and(eq(oauthTokens.tokenHash, sha256Hex(accessToken)), eq(oauthTokens.kind, 'access')))
      .get();
    const now = this.now();
    if (!row || row.token.expiresAt <= now || !this.isOurResource(row.grant.resource)) return null;
    const last = this.lastUsedWrites.get(row.grant.id) ?? 0;
    if (now - last > 60_000) {
      this.lastUsedWrites.set(row.grant.id, now);
      this.db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, row.grant.id)).run();
    }
    return {
      kind: 'connection',
      access: isAccessLevel(row.grant.access) ? row.grant.access : 'read',
      label: `${row.client.name} via MCP (approved by ${row.username})`,
      apiKey: null,
      connection: { id: row.grant.id, client: row.client.name, approvedBy: row.username },
    };
  }

  // ---------------------------------------------------------------- the MCP page

  connections(): McpConnectionDto[] {
    return this.db
      .select({ grant: oauthGrants, client: oauthClients, user: { id: users.id, username: users.username } })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthGrants.clientId))
      .innerJoin(users, eq(users.id, oauthGrants.userId))
      .all()
      .map(({ grant, client, user }) => ({
        id: grant.id,
        app: client.name,
        redirectHost: hostOf(grant.redirectUri),
        approvedBy: user,
        access: isAccessLevel(grant.access) ? grant.access : 'read',
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Takes effect on the connection's very next call: the level is read on every one. */
  setAccess(grantId: number, access: AccessLevel): boolean {
    return this.db.update(oauthGrants).set({ access }).where(eq(oauthGrants.id, grantId)).run().changes > 0;
  }

  /** Revoking deletes: the connection and every token it had, at once. */
  revokeConnection(grantId: number): boolean {
    return this.endConnection(grantId);
  }

  /**
   * End a connection, and forget its app once no admin is connected with it any more - so that
   * connecting it again means registering again, in a window someone opened for it.
   */
  private endConnection(grantId: number): boolean {
    return this.db.transaction(() => {
      const grant = this.db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId)).get();
      if (!grant) return false;
      this.db.delete(oauthGrants).where(eq(oauthGrants.id, grantId)).run();
      const others = this.db.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, grant.clientId)).get();
      if (!others && this.currentWindow()?.clientId !== grant.clientId) {
        this.db.delete(oauthClients).where(eq(oauthClients.clientId, grant.clientId)).run();
      }
      return true;
    });
  }

  // ---------------------------------------------------------------- housekeeping

  prune(): number {
    this.pruneCodes();
    return pruneOAuth(this.db, this.now());
  }

  private pruneCodes(): void {
    const now = this.now();
    for (const [key, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(key);
  }

  private client(clientId: string): OAuthClientRow | null {
    return this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get() ?? null;
  }

  private redirectUris(client: OAuthClientRow): string[] {
    try {
      const parsed = JSON.parse(client.redirectUris) as unknown;
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }
}

/**
 * Expired tokens; connections left with none (their refresh token ran out after two months
 * unused); and apps with no connection that registered more than a day ago - nobody approved
 * them, or their connections have all ended, and either way they can never be approved again.
 * Run nightly (services/housekeeping.ts) and before every registration.
 */
export function pruneOAuth(db: Db, now = Date.now()): number {
  let removed = db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now)).run().changes;
  removed += db
    .delete(oauthGrants)
    .where(
      and(
        lt(oauthGrants.createdAt, now - CODE_TTL_MS),
        notExists(db.select({ id: oauthTokens.id }).from(oauthTokens).where(eq(oauthTokens.grantId, oauthGrants.id))),
      ),
    )
    .run().changes;
  removed += db
    .delete(oauthClients)
    .where(
      and(
        notExists(db.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, oauthClients.clientId))),
        lt(oauthClients.createdAt, now - ORPHAN_CLIENT_TTL_MS),
      ),
    )
    .run().changes;
  return removed;
}

function hostOf(uri: string): string {
  const checked = checkRedirectUri(uri);
  return checked.ok ? checked.host : uri;
}

function closedReason(window: ConnectWindow | null, userId: number, client: OAuthClientRow): string {
  if (!window) return 'No connection window is open';
  if (window.userId !== userId) return 'The connection window open now is another admin’s, and only they can approve in it';
  if (window.clientId && window.clientId !== client.clientId) return 'Another app registered in the connection window';
  return `“${client.name}” did not register in this connection window; remove it in the app and add it again, so that it does`;
}
