import type { FastifyRequest } from 'fastify';

/**
 * Who a request came from: the admin signed in, the API key it carried, or the MCP caller a
 * tool made it for. An unknown key never gets this far (the auth gate refuses it), so one of
 * them is always there on a route that changes something.
 */
export function actorOf(
  req: FastifyRequest,
): { user: string } | { apiKey: string } | { mcp: string } | Record<string, never> {
  if (req.mcp) return { mcp: req.mcp.principal.label };
  if (req.user) return { user: req.user.username };
  if (req.apiKeyUsed) return { apiKey: `${req.apiKeyUsed.name} (${req.apiKeyUsed.prefix}…)` };
  return {};
}

/**
 * The name a row keeps of who made it ("created by"): an admin, `API key "ci"`, or an MCP
 * caller as `API key "ci" via MCP` / `Claude via MCP (approved by andy)`.
 */
export function actorName(req: FastifyRequest): string | null {
  if (req.mcp) return req.mcp.principal.label;
  if (req.user) return req.user.username;
  if (req.apiKeyUsed) return `API key "${req.apiKeyUsed.name}"`;
  return null;
}

/**
 * One structured line per change to a site, naming who. The API activity log records Bearer
 * calls but not what they changed - and strips the query string, where a file's path is - so
 * this is where "who edited wp-config.php" or "who gave out that FTP login" is answered.
 */
export function audit(req: FastifyRequest, area: string, site: string, op: string, fields: Record<string, unknown>): void {
  req.log.info({ [area]: { site, op, ...fields }, ...actorOf(req) }, `${area}: ${op} on site "${site}"`);
}
