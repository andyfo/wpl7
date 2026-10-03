import { describe, expect, it } from 'vitest';
import type { PostLike } from '../../src/services/feedback.js';
import { makeApp, makeTestConfig, makeWorld } from '../helpers.js';

/** Records what the panel posted, and answers with whatever the test scripted. */
function community(answer: { status: number } | { throws: string; cause?: string } = { status: 202 }) {
  const posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const post: PostLike = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) as unknown, headers: init.headers });
    if ('throws' in answer) {
      throw answer.cause === undefined
        ? new Error(answer.throws)
        : new Error(answer.throws, { cause: new Error(answer.cause) });
    }
    return { status: answer.status, text: async () => '' };
  };
  return { posts, post };
}

async function feedbackWorld(opts: { post?: PostLike; communityUrl?: string } = {}) {
  const world = await makeWorld({
    config: makeTestConfig(opts.communityUrl === undefined ? {} : { WPL7_COMMUNITY_URL: opts.communityUrl }),
    communityPost: opts.post,
  });
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

const QUESTION = { summary: 'Can a site keep its dev hostname?', details: 'After go-live, I mean.' };

describe('POST /api/feedback', () => {
  it("posts the question to this install's community, and says what kind it is", async () => {
    const { posts, post } = community();
    const { app, headers } = await feedbackWorld({ post });

    const res = await app.inject({ method: 'POST', url: '/api/feedback', headers, payload: QUESTION });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://wpl7.com/community/feedback');
    expect(posts[0]!.body).toEqual({ kind: 'question', ...QUESTION, environment: '' });
  });

  it('carries the environment block when the sender left it switched on', async () => {
    const { posts, post } = community();
    const { app, headers } = await feedbackWorld({ post });

    await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers,
      payload: { ...QUESTION, environment: '```\nWPL7 0.2.0\n```' },
    });

    expect(posts[0]!.body).toMatchObject({ environment: '```\nWPL7 0.2.0\n```' });
  });

  /**
   * `kind` is the panel's word, not the browser's: this endpoint has one meaning, and the
   * community should not have to trust a client about which.
   */
  it('refuses a body that tries to say what kind of feedback it is', async () => {
    const { posts, post } = community();
    const { app, headers } = await feedbackWorld({ post });

    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers,
      payload: { ...QUESTION, kind: 'bug' },
    });

    expect(res.statusCode).toBe(400);
    expect(posts).toHaveLength(0);
  });

  it('reports a refusal as a bad gateway rather than swallowing it', async () => {
    const { app, headers } = await feedbackWorld({ post: community({ status: 503 }).post });

    const res = await app.inject({ method: 'POST', url: '/api/feedback', headers, payload: QUESTION });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('503');
  });

  /**
   * undici reports every transport failure as the same "fetch failed" and puts the reason in
   * `cause`, so the bare message would tell the sender nothing they could act on.
   */
  it('reports why it could not reach the community, not just that it could not', async () => {
    const answer = community({ throws: 'fetch failed', cause: 'getaddrinfo ENOTFOUND wpl7.com' });
    const { app, headers } = await feedbackWorld({ post: answer.post });

    const res = await app.inject({ method: 'POST', url: '/api/feedback', headers, payload: QUESTION });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('ENOTFOUND wpl7.com');
  });

  /** A fork that points at no community must not post its operators' questions to ours. */
  it('has nowhere to send when the install points at no community', async () => {
    const { posts, post } = community();
    const { app, headers } = await feedbackWorld({ post, communityUrl: '' });

    const res = await app.inject({ method: 'POST', url: '/api/feedback', headers, payload: QUESTION });

    expect(res.statusCode).toBe(404);
    expect(posts).toHaveLength(0);
  });

  it('is not open without a session', async () => {
    const { app } = await feedbackWorld({ post: community().post });
    const res = await app.inject({ method: 'POST', url: '/api/feedback', payload: QUESTION });
    expect(res.statusCode).toBe(401);
  });
});
