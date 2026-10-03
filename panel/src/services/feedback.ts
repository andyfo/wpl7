import type { Config } from '../config.js';
import { AppError, badGateway, notFound } from '../lib/errors.js';
import type { Logger } from './index.js';

/**
 * A POST with a body. `FetchLike` in updates.ts describes GETs only, and widening it would
 * make every GET declare a method it does not have.
 */
export type PostLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 10_000;

export interface Feedback {
  summary: string;
  details: string;
  /** The build-and-machine block the dialog showed, or empty when the sender switched it off. */
  environment: string;
}

/**
 * Questions and ideas, forwarded to the project's community.
 *
 * The only feedback the panel posts anywhere. A bug report or a feature request is composed
 * in the browser and opened as a GitHub issue under the sender's own account - nothing about
 * it reaches this process (web/src/lib/feedback.ts). A question has nowhere like that to go:
 * Discussions takes no prefill and a forum wants no GitHub account. So this one is sent on,
 * and the dialog says so, and shows the exact text first.
 *
 * From the server rather than from the browser deliberately: every install answers on its
 * own domain, so a cross-origin POST would need the community to allow all of them, and a
 * refused preflight fails in a way the sender cannot act on or even see.
 */
export class FeedbackService {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: PostLike = globalThis.fetch as unknown as PostLike,
  ) {}

  /** False = this install points at no community; the panel then offers neither route to one. */
  get configured(): boolean {
    return this.config.communityUrl !== '';
  }

  async send(feedback: Feedback): Promise<void> {
    if (!this.configured) throw notFound('This install has no community to send to.');
    const url = `${this.config.communityUrl}/feedback`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'wpl7-panel' },
        // `kind` is set here, not taken from the browser: this endpoint has exactly one
        // meaning, and the community should not have to trust a client about which.
        body: JSON.stringify({ kind: 'question', ...feedback }),
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) {
        this.log.warn(`Feedback to ${url} was refused with ${res.status}`);
        throw badGateway(`The community answered ${res.status}. Nothing was posted - copy the text and try the site itself.`);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = reason(err);
      this.log.warn(`Feedback to ${url} failed: ${message}`);
      throw badGateway(`Could not reach the community (${message}). Nothing was posted - copy the text and try the site itself.`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * What actually went wrong. undici reports every transport failure as the same "fetch
 * failed" and puts the reason - ENOTFOUND, ECONNREFUSED, a TLS error - in `cause`, so the
 * bare message would tell the sender nothing they could act on.
 */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return err.message;
}
