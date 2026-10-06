// @docs integrations/mcp
import type { Config } from '../config.js';

/**
 * Where the panel is, as the links in its emails say it: from configuration and nothing else -
 * never the Host header of the request being answered, which is the sender's to choose. A
 * reset link built from it goes wherever an attacker likes, with the victim's token in it.
 * Null without a PANEL_DOMAIN.
 */
export function panelUrl(config: Config): string | null {
  const domain = config.panelDomain;
  if (!domain) return null;
  return `${config.tlsMode === 'none' ? 'http' : 'https'}://${domain}`;
}

/**
 * The origin the MCP server and its OAuth endpoints answer at - the issuer, the resource, every
 * URL their metadata names. Same rule: configuration only.
 *
 * In production that takes a PANEL_DOMAIN served over TLS, or null: a token is a bearer
 * credential, and OAuth over plain http hands every one of them to anyone on the path.
 * Outside production an empty PANEL_DOMAIN falls back to http://localhost:<port>, which is
 * where `npm run dev` answers.
 */
export function mcpOrigin(config: Config): string | null {
  const url = panelUrl(config);
  if (config.nodeEnv !== 'production') return url ?? `http://localhost:${config.port}`;
  return url?.startsWith('https://') ? url : null;
}

/** Why MCP cannot run on this install, for the MCP page and the settings error; null when it can. */
export function mcpUnavailableReason(config: Config): string | null {
  if (mcpOrigin(config)) return null;
  if (!config.panelDomain) return 'The panel has no PANEL_DOMAIN, so an AI app would have no address to reach it at';
  return 'The panel is served without TLS (TLS_MODE=none), and MCP never hands out tokens over plain http';
}
