// @docs sites/files, integrations/mcp
import crypto from 'node:crypto';
import type { SiteUploadChunkDto } from '../../shared/types.js';
import { conflict } from '../lib/errors.js';

/**
 * Upload links: one file onto a site, sent by whoever holds the link - in practice an AI app's
 * own shell, which has no key of its own (the MCP tool wpl7_upload_site_file asks for them).
 * MCP has no way to hand a tool a file; the bytes would otherwise go through the model itself.
 *
 * A link names its file up front: where it goes, its size and its SHA-256. The upload is held
 * to all three before the file takes its place (SCRIPTS.append), so a link that leaks - into a
 * log, a transcript - puts nothing at its path but that very file. It is spent once the file is
 * in place, ends when an hour passes without a piece arriving, and stops at once when whoever
 * made it is revoked or lowered below Manage, which every request checks again. In memory only:
 * a restart ends every link, and the app asks for another.
 */

/** The header the token travels in, rather than the URL: URLs end up in logs. */
export const UPLOAD_TOKEN_HEADER = 'x-wpl7-upload-token';
const TOKEN_PREFIX = 'wpl7up_';
/** How long a link lasts without a piece arriving: from when it is made, then from each piece. */
const IDLE_MS = 60 * 60_000;
/** How long a spent link still answers its last piece, sent again because the answer was lost. */
const SPENT_MS = 10 * 60_000;
/** Links one key or connection may have open, unspent. An app makes one per file and uses it. */
const OPEN_PER_MAKER = 20;
/** Links of any kind in memory, whoever made them. */
const MAX_LINKS = 1000;
const SWEEP_MS = 5 * 60_000;

/** Who made a link, to check on every request that they still may - and to name them in the log. */
export interface UploadLinkMaker {
  kind: 'user' | 'apiKey' | 'connection';
  id: number;
  /** For an admin's session: the account's session generation, which signing out everywhere raises. */
  generation?: number;
  /** Made through MCP, which switching MCP off stops. */
  viaMcp: boolean;
  /** As lib/audit.ts actorOf named them when they made it. */
  actor: Record<string, string>;
}

/** What a piece sent to a link is answered with: the upload's progress, and the file once it is in place. */
export type UploadLinkAnswer = SiteUploadChunkDto & { size: number };

export interface UploadLink {
  /** The upload's id, which names its part file beside the target (siteFiles.uploadPartPath). */
  id: string;
  siteId: number;
  slug: string;
  path: string;
  size: number;
  sha256: string;
  overwrite: boolean;
  maker: UploadLinkMaker;
  expiresAt: number;
  /** A piece was sent: there may be a part file to remove if the link runs out. */
  started: boolean;
  /** A piece is arriving. One at a time: a link must not hold the panel's memory for uploads. */
  busy: boolean;
  /**
   * Set once the file is in place: the piece that put it there and the answer it got, for a
   * client that sends that piece again because the answer was lost on the way.
   */
  done: { offset: number; length: number; chunkSha: string; result: UploadLinkAnswer } | null;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class UploadLinksService {
  /** By the SHA-256 of the token: the token itself is never kept, and a lookup leaks no timing. */
  private links = new Map<string, UploadLink>();
  private timer: NodeJS.Timeout | null = null;
  /** Told of each link that ran out with part of its file sent, so the part can be removed. */
  onAbandoned: ((link: UploadLink) => void) | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(fields: Omit<UploadLink, 'id' | 'expiresAt' | 'started' | 'busy' | 'done'>): { token: string; link: UploadLink } {
    this.sweep();
    const { kind, id } = fields.maker;
    const open = [...this.links.values()].filter((l) => !l.done && l.maker.kind === kind && l.maker.id === id).length;
    if (open >= OPEN_PER_MAKER) {
      throw conflict(`${OPEN_PER_MAKER} upload links are open already; send their files first, or wait for them to run out (an hour without use)`);
    }
    if (this.links.size >= MAX_LINKS) throw conflict('Too many upload links are open on the panel; try again in a few minutes');
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const link: UploadLink = {
      ...fields,
      // 24 characters of A-Z, a-z, 0-9, _ and -: an upload id as UPLOAD_ID_RE takes it.
      id: crypto.randomBytes(18).toString('base64url'),
      expiresAt: this.now() + IDLE_MS,
      started: false,
      busy: false,
      done: null,
    };
    this.links.set(hash(token), link);
    this.timer ??= setInterval(() => this.sweep(), SWEEP_MS).unref();
    return { token, link };
  }

  /** The link a token opens, or null: unknown, or run out. */
  find(token: string): UploadLink | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    this.sweep();
    return this.links.get(hash(token)) ?? null;
  }

  /** A piece arrived: the link lasts another hour from now. */
  used(link: UploadLink): void {
    if (!link.done) link.expiresAt = this.now() + IDLE_MS;
  }

  /** The file is in place: the link answers its last piece again for a while, then goes. */
  finished(link: UploadLink, done: NonNullable<UploadLink['done']>): void {
    link.done = done;
    link.expiresAt = this.now() + SPENT_MS;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, link] of this.links) {
      // Never while a piece arrives: the piece itself makes the link last longer.
      if (link.expiresAt > now || link.busy) continue;
      this.links.delete(key);
      if (!link.done && link.started) this.onAbandoned?.(link);
    }
    if (this.links.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
