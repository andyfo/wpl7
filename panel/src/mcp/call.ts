import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { AccessLevel } from '../../shared/access.js';
import type { McpToolGroup } from '../../shared/apiDocs.js';

/**
 * Who is calling over MCP: an API key sent as the bearer token, or an app an admin connected
 * through OAuth (services/oauth.ts). Either way the level is the credential's own, never the
 * admin's - an approval lends an app nothing but what the admin picked for it.
 */
export interface McpPrincipal {
  kind: 'apiKey' | 'connection';
  access: AccessLevel;
  /** How jobs and logs name it: `API key "ci" via MCP`, `Claude via MCP (approved by andy)`. */
  label: string;
  apiKey: { id: number; name: string; prefix: string } | null;
  connection: { id: number; client: string; approvedBy: string } | null;
}

/**
 * One tool's request into the panel's own API. The tool says which of the tool groups it is
 * (shared/apiDocs.ts `mcpToolGroup`); the auth gate holds the matched route to that, to the
 * endpoint's level and to the MCP exclusions, and writes back the route it matched.
 */
export interface McpCall {
  principal: McpPrincipal;
  group: McpToolGroup;
  /** The tool's name, for the activity log. */
  tool: string;
  /** Set by the gate: the route pattern the request matched, or null when it matched none. */
  matched: string | null;
}

/** The tool that reaches each group - what a refusal points to. */
export const TOOL_FOR_GROUP: Record<McpToolGroup, string> = {
  get: 'wpl7_api_get',
  change: 'wpl7_api_change',
  dangerous: 'wpl7_api_dangerous',
  file: 'wpl7_read_site_file / wpl7_write_site_file',
};

const storage = new AsyncLocalStorage<McpCall>();

/**
 * The call a request belongs to - read by the auth gate alone (plugins/auth.ts), which copies
 * it onto the request for everything after it. No token or header carries it: nothing that
 * reaches the panel from the network can claim to be a tool call.
 */
export function currentMcpCall(): McpCall | undefined {
  return storage.getStore();
}

/**
 * Send one request through the panel's API as `call`: every hook, validation, rate limit,
 * maintenance lock and log line an API request gets, and nothing a tool could decide on its own.
 *
 * inject's callback form, on purpose. Its promise form returns a chain that only starts when
 * awaited, which is outside `run` - the gate would see no call at all and refuse (safe, but
 * useless). `test/unit/mcpCall.test.ts` pins this on the Node the panel runs on.
 */
export function injectAs(app: FastifyInstance, call: McpCall, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return storage.run(
    call,
    () =>
      new Promise<LightMyRequestResponse>((resolve, reject) => {
        app.inject(opts, (err, res) => (err || !res ? reject(err ?? new Error('inject gave no response')) : resolve(res)));
      }),
  );
}
