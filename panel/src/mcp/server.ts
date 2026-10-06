// @docs integrations/mcp
import type { FastifyInstance } from 'fastify';
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { ACCESS_LABELS } from '../../shared/access.js';
import { mcpOrigin } from '../lib/panelUrl.js';
import { PANEL_VERSION } from '../lib/version.js';
import type { AppDeps } from '../routes/deps.js';
import type { McpPrincipal } from './call.js';
import type { RouteSchemas } from './docs.js';
import { registerTools, type ToolContext } from './tools.js';

/** What the /mcp route hands the SDK about the request it is serving. */
export interface McpRequestInfo {
  principal: McpPrincipal;
  ip: string;
  userAgent: string | undefined;
}

/**
 * The MCP server: stateless, built afresh for every request by the SDK
 * (`@modelcontextprotocol/server`), which serves both the 2025-era protocol and the 2026-07-28
 * one from the same factory. Fresh per request is also what lets the tool list follow the
 * caller: a connection whose level was lowered a second ago is offered less on its next call.
 *
 * JSON answers only (`responseMode: 'json'`): no tool reports progress, so there is nothing a
 * stream would carry. Built on first use, so a panel with MCP switched off never makes one.
 */
export function mcpHandler(app: FastifyInstance, deps: AppDeps, schemas: RouteSchemas): () => McpHttpHandler {
  let handler: McpHttpHandler | null = null;
  return () =>
    (handler ??= createMcpHandler(
      (ctx) => {
        const info = ctx.authInfo?.extra?.info as McpRequestInfo | undefined;
        // The route never calls the handler without one; a request that got here otherwise
        // is served nothing at all.
        if (!info) throw new Error('MCP request without a principal');
        return buildServer({ app, deps, schemas, ...info });
      },
      {
        responseMode: 'json',
        onerror: (err) => deps.log.warn(`MCP: ${err.message}`),
      },
    ));
}

function buildServer(c: ToolContext): McpServer {
  // Never null here: /mcp answers only where there is an origin (routes/mcp.ts mcpAvailable).
  const origin = mcpOrigin(c.deps.config)!;
  const server = new McpServer(
    // An app can hold several panels, under names its user picks: the title and the website
    // are what says which panel this one is.
    { name: 'wpl7', title: `WPL7 · ${new URL(origin).host}`, version: PANEL_VERSION, websiteUrl: origin },
    {
      instructions: instructionsFor(c.principal, origin),
      // The tool list depends on who asks, so no cache may share it between callers.
      cacheHints: { 'tools/list': { cacheScope: 'private' } },
    },
  );
  registerTools(server, c);
  return server;
}

/**
 * Read once per session by most clients; the tool descriptions stand alone for the rest. Claude Code
 * keeps the first 2,048 characters: a test holds them under that for the longest address and name
 * there can be.
 */
function instructionsFor(principal: McpPrincipal, origin: string): string {
  return [
    `This is the WPL7 panel at ${origin}. WPL7 is a self-hosted WordPress hosting panel: every site runs in its own`,
    "container on one of the panel's servers, with backups, mail, visitor statistics and a job queue for anything slow.",
    `These tools call its REST API as ${principal.label}, with ${ACCESS_LABELS[principal.access]} access.`,
    '',
    'Other WPL7 panels may be connected alongside this one, each under its own name. They share nothing: a site called',
    'the same on two panels is two sites, and a job or backup id from one means nothing to another. When the user names',
    'a site, check which panel holds it before changing anything.',
    '',
    'Find an endpoint and its exact input with wpl7_api_docs first: it names the tool for each. Read with',
    'wpl7_api_get. Change things with wpl7_api_change, or with wpl7_api_dangerous where the change runs a command,',
    'deletes, restores, stops or overwrites. A 202 answer names a job: follow it with wpl7_wait_for_job until done.',
    'Before anything destructive, tell the user what you are about to do and wait for their go-ahead: much of it',
    'cannot be undone.',
    '',
    'Plugins can add WP-CLI commands of their own. Before running one, read its help:',
    'wpl7_api_get /api/sites/{site}/wp/cli/help?command=<command>. Without a command it lists them all.',
    // The plugin's guide cannot know the panel: followed alone, every wait would ask the user first.
    'WP Godmode (`wp godmode`, an AI agent inside the site): send and answer with wpl7_api_dangerous; wait and',
    'read with wpl7_api_get /api/sites/{site}/godmode/chats/{chatId}?wait=40, which needs no approval.',
  ].join('\n');
}
