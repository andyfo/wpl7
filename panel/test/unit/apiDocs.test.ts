/**
 * The Docs tab is generated from `shared/apiDocs.ts`, so the only thing standing between
 * it and a confident lie is this file: it reads Fastify's own route table and insists the
 * two agree in both directions.
 */
import { describe, expect, it } from 'vitest';
import {
  API_DOC_ENDPOINTS,
  API_DOC_GROUPS,
  API_DOC_RECIPES,
  API_ERROR_CODES,
  curlSnippet,
} from '../../shared/apiDocs.js';
import { errorCodes } from '../../shared/schemas.js';
import { makeApp } from '../helpers.js';

/**
 * `printRoutes` draws a tree whose children hold only their own segment, and whose
 * branches are merged by prefix (`/api/auth/logout` + `-all`). Concatenating the stack
 * down to a line's depth is what turns it back into a path. Indentation is four columns
 * per level, and HEAD is dropped: Fastify adds it to every GET on its own.
 */
function registeredRoutes(tree: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const marker = line.search(/[├└]/);
    if (marker === -1) continue;
    const depth = marker / 4;
    const content = line.slice(marker + 4);
    const withMethods = /^(.*?) \(([A-Z, ]+)\)$/.exec(content);
    stack[depth] = withMethods ? withMethods[1]! : content;
    stack.length = depth + 1;
    if (!withMethods) continue;
    const path = stack.join('');
    for (const method of withMethods[2]!.split(', ')) {
      if (method !== 'HEAD') out.add(`${method} ${path}`);
    }
  }
  return out;
}

async function routeTable(): Promise<Set<string>> {
  const { app } = await makeApp();
  return registeredRoutes(app.printRoutes({ commonPrefix: false }));
}

describe('API documentation', () => {
  it('documents an endpoint that really exists', async () => {
    const routes = await routeTable();
    const invented = API_DOC_ENDPOINTS.map((e) => `${e.method} ${e.path}`).filter((r) => !routes.has(r));
    expect(invented).toEqual([]);
  });

  it('documents every API endpoint there is', async () => {
    const routes = await routeTable();
    const documented = new Set(API_DOC_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    const undocumented = [...routes].filter((r) => r.includes(' /api/') && !documented.has(r));
    expect(undocumented).toEqual([]);
  });

  it('lists each endpoint once', () => {
    const seen = new Map<string, number>();
    for (const e of API_DOC_ENDPOINTS) {
      const key = `${e.method} ${e.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('explains every error code the API can answer with, and no other', () => {
    expect(API_ERROR_CODES.map((c) => c.code).sort()).toEqual([...errorCodes].sort());
  });

  it('keeps the summaries short enough to scan', () => {
    const rambling = API_DOC_ENDPOINTS.filter((e) => e.summary.length > 110 || e.summary.endsWith('.'));
    expect(rambling.map((e) => `${e.method} ${e.path}`)).toEqual([]);
    expect(API_DOC_GROUPS.every((g) => g.title && g.intro)).toBe(true);
  });

  /**
   * The copied command has to be the request that was sent. Compacting the body by
   * collapsing whitespace also rewrote the whitespace inside string values, which turned
   * a password with two spaces in it into a different password.
   */
  it('copies a body out of the console without editing its values', () => {
    const body = JSON.stringify({ adminUser: 'boss', adminPassword: 'two  spaces\ttab' }, null, 2);
    const curl = curlSnippet({ method: 'POST', path: '/api/sites', baseUrl: 'https://panel.example.com', body });

    const sent = /-d '(.*)'$/s.exec(curl)?.[1];
    expect(JSON.parse(sent!)).toEqual({ adminUser: 'boss', adminPassword: 'two  spaces\ttab' });
    // Compact, but only between the tokens - the indentation is gone, the value is not.
    expect(sent).not.toContain('\n');
  });

  it('shell-quotes an apostrophe rather than ending the argument', () => {
    const curl = curlSnippet({
      method: 'POST',
      path: '/api/sites',
      baseUrl: 'https://panel.example.com',
      body: JSON.stringify({ title: "Bob's Bikes" }),
    });
    expect(curl).toContain(`'\\''`);
    // Everything after -d stays inside one shell argument.
    expect(curl.endsWith("'")).toBe(true);
  });

  it('passes a body that is not JSON through untouched', () => {
    const curl = curlSnippet({ method: 'POST', path: '/api/sites', baseUrl: 'https://p.example', body: 'not json' });
    expect(curl).toContain(`-d 'not json'`);
  });

  it('only offers recipe steps the console can run', async () => {
    const routes = await routeTable();
    // Recipes carry filled-in ids and slugs, so each one is matched against the route
    // patterns rather than looked up: `/api/jobs/1` has to reach `/api/jobs/:id`.
    for (const recipe of API_DOC_RECIPES) {
      for (const step of recipe.steps) {
        const path = step.path.split('?')[0]!;
        const runnable = [...routes].some((route) => {
          const [method, pattern] = route.split(' ') as [string, string];
          return method === step.method && new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '[^/]+')}$`).test(path);
        });
        expect(runnable, `${recipe.id}: ${step.method} ${step.path} matches no route`).toBe(true);
      }
    }
  });
});
