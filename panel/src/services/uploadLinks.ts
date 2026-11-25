// @docs sites/files, integrations/mcp
import crypto from 'node:crypto';
import type { SiteUploadChunkDto } from '../../shared/types.js';
import { tooManyRequests } from '../lib/errors.js';

/**
 * Upload links: one file onto a site, sent by whoever holds the link - in practice an AI app's
 * own shell, which has no key of its own (the MCP tool wpl7_upload_site_file asks for them).
 * MCP has no way to hand a tool a file; the bytes would otherwise go through the model itself.
 *
 * A link names its file up front: where it goes, its size and its SHA-256. The upload is held
 * to all three before the file takes its place (SCRIPTS.append), so a link that leaks - into a
 * log, a transcript - puts nothing on the site but that very file. It is spent once the file is
 * in place, ends an hour after it was made, and stops at once when whoever made it is revoked
 * or lowered below Manage, which every request checks again. In memory only: a restart ends
 * every link, and the app asks for another.
 */

/** The header the token travels in, rather than the URL: URLs end up in logs. */
export const UPLOAD_TOKEN_HEADER = 'x-wpl7-upload-token';
const TOKEN_PREFIX = 'wpl7up_';
const TTL_MS = 60 * 60_000;
/** Links open at once, across the panel. An app makes one per file, and uses it at once. */
const MAX_LINKS = 100;

/** Who made a link, to check on every request that they still may - and to name them in the log. */
export interface UploadLinkMaker {
  kind: 'user' | 'apiKey' | 'connection';
  id: number;
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
  /**
   * Set once the file is in place: the chunk that put it there and the answer it got, for a
   * client that sends that chunk again because the answer was lost on the way.
   */
  done: { offset: number; chunkSha: string; result: UploadLinkAnswer } | null;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class UploadLinksService {
  /** By the SHA-256 of the token: the token itself is never kept, and a lookup leaks no timing. */
  private links = new Map<string, UploadLink>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(fields: Omit<UploadLink, 'id' | 'expiresAt' | 'done'>): { token: string; link: UploadLink } {
    this.sweep();
    if (this.links.size >= MAX_LINKS) {
      throw tooManyRequests(`${MAX_LINKS} upload links are open already; wait for some to be used or to run out (an hour)`);
    }
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    // 24 characters of A-Z, a-z, 0-9, _ and -: an upload id as UPLOAD_ID_RE takes it.
    const link: UploadLink = { ...fields, id: crypto.randomBytes(18).toString('base64url'), expiresAt: this.now() + TTL_MS, done: null };
    this.links.set(hash(token), link);
    return { token, link };
  }

  /** The link a token opens, or null: unknown, or run out. */
  find(token: string): UploadLink | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const key = hash(token);
    const link = this.links.get(key);
    if (!link) return null;
    if (link.expiresAt <= this.now()) {
      this.links.delete(key);
      return null;
    }
    return link;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, link] of this.links) if (link.expiresAt <= now) this.links.delete(key);
  }
}
