import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCESS_LABELS, allows, type AccessLevel } from '../../shared/access.js';
import {
  API_DOC_ENDPOINTS,
  API_DOC_GROUPS,
  API_DOC_RECIPES,
  API_ERROR_CODES,
  mcpToolGroup,
  type ApiDocEndpoint,
} from '../../shared/apiDocs.js';
import { TOOL_FOR_GROUP } from './call.js';

/**
 * What `wpl7_api_docs` answers with: the API catalog (shared/apiDocs.ts) as an AI client needs
 * it - searchable, one endpoint at a time, with the exact input schema of each - and only the
 * endpoints MCP can reach. The schemas are the routes' own zod schemas, the ones Fastify
 * validates with, so what the docs say an endpoint takes is what it takes.
 */

/** Each /api/ route's validation schemas, by `METHOD /api/pattern`. */
export type RouteSchemas = Map<string, { params?: unknown; querystring?: unknown; body?: unknown }>;

/**
 * Record every route's schemas as it is added. Must be registered before the route modules:
 * an onRoute hook only sees the routes added after it.
 */
export function collectRouteSchemas(app: FastifyInstance): RouteSchemas {
  const schemas: RouteSchemas = new Map();
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/') || !route.schema) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      const { params, querystring, body } = route.schema as { params?: unknown; querystring?: unknown; body?: unknown };
      schemas.set(`${method} ${route.url}`, { params, querystring, body });
    }
  });
  return schemas;
}

const key = (e: ApiDocEndpoint) => `${e.method} ${e.path}`;
const reachable = API_DOC_ENDPOINTS.filter((e) => mcpToolGroup(e) !== null);

/** One endpoint as a list entry: enough to choose it, and which tool to call it with. */
function entryOf(e: ApiDocEndpoint, access: AccessLevel) {
  return {
    endpoint: key(e),
    summary: e.summary,
    ...(e.input ? { input: e.input } : {}),
    ...(e.returns ? { returns: e.returns } : {}),
    ...(e.job ? { job: true } : {}),
    tool: TOOL_FOR_GROUP[mcpToolGroup(e)!],
    ...(allows(access, e.level) ? {} : { needs: ACCESS_LABELS[e.level] }),
  };
}

/** No arguments: how the API works, what is in it, and the worked examples. */
export function docsOverview(access: AccessLevel) {
  return {
    access: `${ACCESS_LABELS[access]}. Endpoints marked "needs" are beyond it; the tools refuse them.`,
    conventions: [
      'Paths are the REST API\'s own: GET /api/sites/my-shop, never a full URL. Put query parameters in `query`, not in the path.',
      'Anything slow answers 202 with {job}: call wpl7_wait_for_job with its id until done is true. The job\'s result and log say what happened.',
      'One job per site at a time: a second change while one runs answers 409 job_conflict naming the running job. Wait for it, then retry.',
      'Errors are {code, message, details}. validation_error comes with details saying which field; ask this tool for the endpoint\'s schema.',
      'Running commands, deleting, restoring, stopping and saving over files go through wpl7_api_dangerous, and much of it cannot be undone. Say what you are about to do before you do it.',
    ],
    groups: API_DOC_GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      intro: g.intro,
      endpoints: g.endpoints.filter((e) => mcpToolGroup(e) !== null).length,
    })).filter((g) => g.endpoints > 0),
    workflows: API_DOC_RECIPES.map((r) => ({
      title: r.title,
      steps: r.steps.map((s) => `${s.method} ${s.path} - ${s.comment}`),
    })),
    errors: API_ERROR_CODES.map((c) => `${c.status} ${c.code}: ${c.meaning}`),
    next: 'Search with {query: "backup"} or list a group with {group: "wp"}; {endpoint: "POST /api/sites"} gives one endpoint\'s exact input schema.',
  };
}

/** Endpoints matching a search and/or in a group. */
export function searchDocs(access: AccessLevel, query?: string, group?: string) {
  const inGroup = group ? API_DOC_GROUPS.find((g) => g.id === group) : null;
  if (group && !inGroup) {
    return { error: `No group "${group}". Groups: ${API_DOC_GROUPS.map((g) => g.id).join(', ')}` };
  }
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const pool = inGroup ? inGroup.endpoints.filter((e) => mcpToolGroup(e) !== null) : reachable;
  const matches = pool.filter((e) => {
    const text = `${e.method} ${e.path} ${e.summary} ${e.input ?? ''} ${e.returns ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return {
    ...(inGroup ? { group: { id: inGroup.id, title: inGroup.title, intro: inGroup.intro } } : {}),
    matches: matches.map((e) => entryOf(e, access)),
    ...(matches.length === 0 ? { hint: 'Nothing matched. Try one word, or call with no arguments to see the groups.' } : {}),
  };
}

/**
 * One endpoint in full, with the JSON Schema of its path parameters, query and body. Takes the
 * pattern (`GET /api/sites/:slug`) or a filled-in path (`GET /api/sites/my-shop`).
 */
export function endpointDocs(access: AccessLevel, schemas: RouteSchemas, wanted: string) {
  const match = /^([A-Za-z]+)\s+(\S+)$/.exec(wanted.trim());
  if (!match) return { error: 'Give the endpoint as "METHOD /api/path", e.g. "POST /api/sites"' };
  const method = match[1]!.toUpperCase();
  const path = match[2]!.split('?')[0]!;
  const endpoint =
    reachable.find((e) => e.method === method && e.path === path) ??
    reachable.find((e) => e.method === method && patternOf(e.path).test(path));
  if (!endpoint) {
    return { error: `${method} ${path} is not an endpoint MCP can reach. Search for it with {query}.` };
  }
  const schema = schemas.get(key(endpoint)) ?? {};
  return {
    ...entryOf(endpoint, access),
    level: ACCESS_LABELS[endpoint.level],
    ...(endpoint.levelReason ? { why: endpoint.levelReason } : {}),
    ...(endpoint.note ? { note: endpoint.note } : {}),
    schema: {
      ...(schema.params ? { path: jsonSchema(schema.params) } : {}),
      ...(schema.querystring ? { query: jsonSchema(schema.querystring) } : {}),
      ...(schema.body ? { body: jsonSchema(schema.body) } : {}),
    },
  };
}

const patternOf = (path: string) => new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`);

/** As GET /api/schedules/actions does it: what a client sends, not what the route makes of it. */
function jsonSchema(schema: unknown): unknown {
  try {
    const out = z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete out.$schema;
    return out;
  } catch {
    return { description: 'Not expressible as JSON Schema; see the endpoint\'s input line' };
  }
}
