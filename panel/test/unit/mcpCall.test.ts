/**
 * How a tool call reaches the auth gate: in async context, around an `app.inject()`, and
 * nowhere else. If a Node release ever changes how that context travels, these fail - rather
 * than every tool call quietly turning into a 401, or worse, context turning up somewhere it
 * was never sent.
 */
import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { currentMcpCall, injectAs, type McpCall } from '../../src/mcp/call.js';

const call = (tool: string): McpCall => ({
  principal: { kind: 'apiKey', access: 'read', label: 'API key "t" via MCP', apiKey: { id: 1, name: 't', prefix: 'wpl7_x' }, connection: null },
  group: 'read',
  tool,
  matched: null,
});

async function probeApp() {
  const app = fastify();
  const seen: (string | null)[] = [];
  app.addHook('onRequest', async (req) => {
    seen.push(currentMcpCall()?.tool ?? null);
    // A slow hook, so a request from outside can land while a tool call is in flight.
    if (req.url === '/slow') await new Promise((resolve) => setTimeout(resolve, 20));
  });
  app.get('/slow', async () => ({ tool: currentMcpCall()?.tool ?? null }));
  app.get('/fast', async () => ({ tool: currentMcpCall()?.tool ?? null }));
  await app.ready();
  return { app, seen };
}

describe('injectAs', () => {
  it("reaches the injected request's onRequest hook and its handler", async () => {
    const { app, seen } = await probeApp();
    const res = await injectAs(app, call('wpl7_api_get'), { method: 'GET', url: '/fast' });
    expect(res.json()).toEqual({ tool: 'wpl7_api_get' });
    expect(seen).toEqual(['wpl7_api_get']);
  });

  it('reaches no other request, even one handled while the call is in flight', async () => {
    const { app, seen } = await probeApp();
    const inFlight = injectAs(app, call('wpl7_api_get'), { method: 'GET', url: '/slow' });
    const outside = await app.inject({ method: 'GET', url: '/fast' });
    expect(outside.json()).toEqual({ tool: null });
    expect((await inFlight).json()).toEqual({ tool: 'wpl7_api_get' });
    expect(seen.sort()).toEqual([null, 'wpl7_api_get'].sort());
  });

  it('is gone once the call has answered', async () => {
    const { app } = await probeApp();
    await injectAs(app, call('wpl7_api_get'), { method: 'GET', url: '/fast' });
    expect(currentMcpCall()).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/fast' })).json()).toEqual({ tool: null });
  });

  it("keeps two calls' contexts apart", async () => {
    const { app } = await probeApp();
    const [a, b] = await Promise.all([
      injectAs(app, call('one'), { method: 'GET', url: '/slow' }),
      injectAs(app, call('two'), { method: 'GET', url: '/fast' }),
    ]);
    expect(a.json()).toEqual({ tool: 'one' });
    expect(b.json()).toEqual({ tool: 'two' });
  });
});
