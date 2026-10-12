import { describe, expect, it } from 'vitest';
import { siteHealth } from '../../web/src/lib/siteHealth.js';

describe('site health', () => {
  it('does not call a site that answers nothing "running"', () => {
    // The screenshot this was written from: registry status "running" beside a red dot,
    // because a half-applied PHP switch left Traefik with no router for the hostname.
    const health = siteHealth({ status: 'running', up: false, httpStatus: 404, lastCheckedAt: Date.now() });
    expect(health.label).toBe('Offline');
    expect(health.tone).toBe('bad');
    expect(health.detail).toContain('404');
    expect(health.fix).toMatch(/Recreating its container/);
  });

  it('separates "nothing answered" from "answered the wrong thing"', () => {
    expect(siteHealth({ status: 'running', up: false, httpStatus: null }).detail).toContain('nothing answered');
    expect(siteHealth({ status: 'running', up: false, httpStatus: 502 }).detail).toContain('502');
  });

  it('is Online only when the probe actually passed', () => {
    expect(siteHealth({ status: 'running', up: true }).tone).toBe('ok');
    expect(siteHealth({ status: 'running', up: null }).label).toBe('Checking');
    expect(siteHealth({ status: 'running', up: null }).tone).toBe('unknown');
  });

  it('reads a deliberately stopped site as idle, not as an outage', () => {
    // tickUptime records up=false for every non-running site, which is true and useless:
    // the old dot painted a site somebody stopped on purpose the same red as a dead one.
    const health = siteHealth({ status: 'stopped', up: false });
    expect(health.label).toBe('Stopped');
    expect(health.tone).toBe('idle');
  });

  it('names the disagreement when Docker contradicts the registry', () => {
    expect(siteHealth({ status: 'running', up: false, containerState: 'missing' }).label).toBe('No container');
    expect(siteHealth({ status: 'error', up: null, containerState: 'created' }).detail).toContain('never run');
    expect(siteHealth({ status: 'running', up: false, containerState: 'exited' }).label).toBe('Offline');
    expect(siteHealth({ status: 'stopped', containerState: 'running' }).detail).toContain('outside the panel');
  });

  it('does not report an unreachable server as a dead site', () => {
    const health = siteHealth({ status: 'running', up: false, containerState: 'unknown' });
    expect(health.label).toBe('Unknown');
    expect(health.tone).toBe('unknown');
  });

  it('says whether a site left half-applied is still serving', () => {
    // Only claimable because MonitorService probes error-state sites for real; see
    // test/unit/monitorUptime.test.ts.
    expect(siteHealth({ status: 'error', up: true }).detail).toContain('still serving');
    expect(siteHealth({ status: 'error', up: false }).detail).toContain('not serving');
    expect(siteHealth({ status: 'error', up: null }).detail).not.toContain('serving');
  });

  it('never offers the recreate for an exited container, which reconcile leaves stopped', () => {
    // shouldSiteRun reads `exited` as "stopped on purpose", so a recreate rebuilds the
    // container, reports success and leaves the site dark. Starting it is the repair.
    const exited = siteHealth({ status: 'running', up: false, containerState: 'exited' });
    expect(exited.action).toEqual({ label: 'Start', path: 'start' });
    expect(exited.fix).not.toMatch(/Recreating/);
  });

  it('separates a container that never ran from one that stopped on purpose', () => {
    // `created` is a start that FAILED (docker ps -a shows Created). Different diagnosis
    // from `exited`, same repair - docs/troubleshooting.md says press Start for both.
    const created = siteHealth({ status: 'running', up: false, containerState: 'created' });
    expect(created.label).toBe('Offline');
    expect(created.detail).toContain('never run');
    expect(created.action).toEqual({ label: 'Start', path: 'start' });
    expect(siteHealth({ status: 'running', up: false, containerState: 'exited' }).detail).toContain(
      'exited on its own',
    );
  });

  it('rebuilds for a routing failure and restarts for one the site itself produced', () => {
    // 404 is Traefik answering, not the site: a restart cannot put the labels back.
    expect(siteHealth({ status: 'running', up: false, httpStatus: 404 }).action?.path).toBe('reconcile');
    expect(siteHealth({ status: 'running', up: false, httpStatus: 502 }).action?.path).toBe('restart');
    expect(siteHealth({ status: 'running', up: false, containerState: 'created' }).action?.path).toBe('start');
    expect(siteHealth({ status: 'running', up: false, httpStatus: null }).action?.path).toBe('restart');
    expect(siteHealth({ status: 'running', up: false, containerState: 'missing' }).action?.path).toBe('reconcile');
  });

  it('keeps transitional states out of the alarm colours', () => {
    expect(siteHealth({ status: 'provisioning', up: false }).tone).toBe('busy');
    expect(siteHealth({ status: 'deleting', up: false }).tone).toBe('busy');
  });

  it('offers a fix and a working button for every state it paints red', () => {
    const bad = [
      siteHealth({ status: 'running', up: false, httpStatus: 404 }),
      siteHealth({ status: 'running', up: false, httpStatus: 502 }),
      siteHealth({ status: 'running', up: false, containerState: 'missing' }),
      siteHealth({ status: 'running', up: false, containerState: 'exited' }),
      siteHealth({ status: 'running', up: false, containerState: 'created' }),
      siteHealth({ status: 'error', up: false }),
    ];
    expect(bad.every((h) => h.tone === 'bad' && !!h.fix && !!h.action)).toBe(true);
  });

  it('keeps its buttons to endpoints that exist', () => {
    const paths = new Set(['start', 'restart', 'reconcile']);
    const every = [
      siteHealth({ status: 'running', up: true }),
      siteHealth({ status: 'running', up: null }),
      siteHealth({ status: 'running', up: false, httpStatus: 404 }),
      siteHealth({ status: 'running', up: false, httpStatus: 500 }),
      siteHealth({ status: 'running', up: false, containerState: 'missing' }),
      siteHealth({ status: 'running', up: false, containerState: 'exited' }),
      siteHealth({ status: 'running', up: false, containerState: 'created' }),
      siteHealth({ status: 'running', up: false, containerState: 'unknown' }),
      siteHealth({ status: 'stopped' }),
      siteHealth({ status: 'error' }),
      siteHealth({ status: 'provisioning' }),
      siteHealth({ status: 'deleting' }),
    ];
    expect(every.every((h) => !h.action || paths.has(h.action.path))).toBe(true);
  });

  it('reads a site hosted elsewhere by its own address and its plugin, with nothing to repair from here', () => {
    const external = (reachable: boolean | null) => ({ reachable });
    // No container to read: the detail page's 'missing' must not turn it into "No container".
    expect(siteHealth({ status: 'connected', up: true, containerState: 'missing', external: external(true) })).toMatchObject({ label: 'Online', tone: 'ok' });
    expect(siteHealth({ status: 'connected', up: null, external: external(null) }).label).toBe('Checking');
    const down = siteHealth({ status: 'connected', up: false, httpStatus: 503, external: external(true) });
    expect(down).toMatchObject({ label: 'Offline', tone: 'bad' });
    expect(down.detail).toContain('503');
    expect(down.action).toBeUndefined();
    const plugin = siteHealth({ status: 'connected', up: true, external: external(false) });
    expect(plugin).toMatchObject({ label: 'Plugin unreachable', tone: 'bad' });
    expect(plugin.fix).toContain('/wp-json/wpl7-connect/');
    expect(siteHealth({ status: 'disconnected', up: null, external: external(null) })).toMatchObject({ label: 'Disconnected', tone: 'idle' });
    expect(siteHealth({ status: 'deleting', up: true, external: external(true) }).tone).toBe('busy');
  });
});
