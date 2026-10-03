import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { API_DOC_ENDPOINTS, mcpToolGroup } from '../../shared/apiDocs.js';
import { docsOverview, endpointDocs, searchDocs, type RouteSchemas } from '../../src/mcp/docs.js';

const excluded = API_DOC_ENDPOINTS.filter((e) => mcpToolGroup(e) === null);

/** Stand-ins for what collectRouteSchemas records; test/api/mcpTools.test.ts reads the real ones. */
const schemas: RouteSchemas = new Map([
  [
    'POST /api/sites/:slug/backups',
    { params: z.object({ slug: z.string() }), body: z.object({ note: z.string().max(200).optional() }).strict() },
  ],
  ['GET /api/sites/:slug/files/search', { querystring: z.object({ q: z.string(), limit: z.coerce.number().default(50) }) }],
]);

describe('the MCP API reference', () => {
  it('opens with the conventions, the groups and the worked examples, in a few thousand characters', () => {
    const overview = docsOverview('read');
    expect(overview.groups.map((g) => g.id)).toContain('sites');
    // Accounts and keys are never reachable, so their groups are not offered at all.
    expect(overview.groups.map((g) => g.id)).not.toContain('users');
    expect(overview.workflows.length).toBeGreaterThan(0);
    expect(JSON.stringify(overview).length).toBeLessThan(12_000);
  });

  it('never shows an endpoint MCP cannot reach', () => {
    const everything = JSON.stringify([searchDocs('full', ''), ...['auth', 'users', 'panel', 'files'].map((g) => searchDocs('full', '', g))]);
    for (const e of excluded) expect(everything, `${e.method} ${e.path}`).not.toContain(`"${e.method} ${e.path}"`);
    expect(endpointDocs('full', new Map(), 'POST /api/auth/login')).toMatchObject({ error: expect.stringContaining('not an endpoint') });
  });

  it('searches every word, lists a group, and marks what is beyond the caller', () => {
    const found = searchDocs('read', 'plugin update');
    expect(found.matches!.map((m) => m.endpoint)).toContain('POST /api/sites/:slug/wp/plugins/:name/update');
    const update = found.matches!.find((m) => m.endpoint === 'POST /api/sites/:slug/wp/plugins/:name/update')!;
    expect(update).toMatchObject({ tool: 'wpl7_api_change', needs: 'Manage' });
    expect(searchDocs('full', 'plugin update').matches!.find((m) => m.endpoint === update.endpoint)).not.toHaveProperty('needs');
    expect(searchDocs('read', undefined, 'nope')).toMatchObject({ error: expect.stringContaining('Groups:') });
  });

  it('gives one endpoint with the JSON Schema of what it takes, by pattern or by a filled-in path', () => {
    const byPattern = endpointDocs('manage', schemas, 'POST /api/sites/:slug/backups');
    const byPath = endpointDocs('manage', schemas, 'POST /api/sites/my-shop/backups');
    expect(byPath).toEqual(byPattern);
    expect(byPattern).toMatchObject({
      endpoint: 'POST /api/sites/:slug/backups',
      tool: 'wpl7_api_change',
      level: 'Manage',
      schema: {
        path: { type: 'object', properties: { slug: { type: 'string' } } },
        body: { type: 'object', properties: { note: { type: 'string' } } },
      },
    });
    const files = endpointDocs('full', schemas, 'GET /api/sites/:slug/files/search');
    expect(files).toMatchObject({ level: 'Manage', why: expect.stringContaining('matching lines'), schema: { query: { type: 'object' } } });
    // What a client sends, not what the route makes of it: a coerced number with a default is optional.
    expect((files as { schema: { query: { required?: string[] } } }).schema.query.required).toEqual(['q']);
  });
});
