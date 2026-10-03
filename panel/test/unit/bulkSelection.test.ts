import { describe, expect, it } from 'vitest';
import type { WpInventoryRow, WpInventorySiteRow } from '../../shared/types.js';
import {
  allowedActions,
  filtersForKind,
  reconcileSelection,
  targetKey,
  targetsForSites,
  visibleRows,
  visibleTargets,
  type Target,
} from '../../web/src/pages/bulkSelection.js';

/**
 * The bulk page's selection rules, which decide what a click on Delete actually deletes.
 * Extracted from the page so they can be tested without a browser.
 */

const siteRow = (
  siteSlug: string,
  over: Partial<WpInventorySiteRow> = {},
): WpInventorySiteRow => ({
  siteSlug,
  siteTitle: siteSlug,
  siteStatus: 'running',
  serverId: 1,
  serverName: 'local',
  scannedAt: 1,
  version: '1.0',
  updateVersion: null,
  updateState: 'none',
  status: 'active',
  autoUpdate: false,
  worstSeverity: null,
  vulnerabilities: [],
  actionable: { activate: false, deactivate: true, update: false, delete: true },
  blockedReason: null,
  ...over,
});

const group = (slug: string, sites: WpInventorySiteRow[], kind: WpInventoryRow['kind'] = 'plugin'): WpInventoryRow => ({
  kind,
  slug,
  title: slug,
  sites: sites.length,
  updates: 0,
  vulnerable: 0,
  inactive: 0,
  versions: ['1.0'],
  updateVersion: null,
  worstSeverity: null,
  closedOnWporg: false,
  closedReason: null,
  feedCoverage: 'known',
  siteRows: sites,
});

const select = (...targets: Target[]) => new Map(targets.map((t) => [targetKey(t), t]));
const target = (siteSlug: string, slug: string): Target => ({ siteSlug, kind: 'plugin', slug });

describe('bulk selection', () => {
  it('drops selections the table is no longer showing', () => {
    const before = visibleRows([group('cf7', [siteRow('alpha')]), group('seo', [siteRow('alpha')])]);
    const selected = select(target('alpha', 'cf7'), target('alpha', 'seo'));
    expect(reconcileSelection(selected, before).size).toBe(2);

    // The operator searches for "cf7": "seo" is off screen, and must not travel invisibly
    // into the next Delete (the action bar only ever reasoned about visible rows).
    const afterSearch = visibleRows([group('cf7', [siteRow('alpha')])]);
    const kept = reconcileSelection(selected, afterSearch);
    expect([...kept.values()]).toEqual([target('alpha', 'cf7')]);
    expect(visibleTargets(selected, afterSearch)).toEqual([target('alpha', 'cf7')]);
  });

  it('drops a row a refresh removed, not just one a filter hid', () => {
    const selected = select(target('alpha', 'cf7'), target('beta', 'cf7'));
    // Somebody else updated beta, so it no longer matches the "has update" filter.
    const refreshed = visibleRows([group('cf7', [siteRow('alpha')])]);
    expect([...reconcileSelection(selected, refreshed).keys()]).toEqual(['alpha|plugin|cf7']);
  });

  it('returns the same map when nothing was dropped, so it is safe in a setState updater', () => {
    const visible = visibleRows([group('cf7', [siteRow('alpha')])]);
    const selected = select(target('alpha', 'cf7'));
    expect(reconcileSelection(selected, visible)).toBe(selected);
    expect(reconcileSelection(new Map(), visible).size).toBe(0);
  });

  it('retries exactly the skipped sites\' original targets', () => {
    // One plugin was selected on two sites; beta was busy and got skipped.
    const original: Target[] = [target('alpha', 'cf7'), target('beta', 'cf7')];
    const retry = targetsForSites(original, ['beta']);
    expect([...retry.values()]).toEqual([target('beta', 'cf7')]);
    // Not "everything that site now shows": an active plugin nobody asked to delete must
    // not join the retry.
    expect([...retry.values()].some((t) => t.slug === 'seo')).toBe(false);
  });

  it('offers only the actions every selected row accepts', () => {
    const deletable = { kind: 'plugin' as const, row: siteRow('a') };
    const active = {
      kind: 'plugin' as const,
      row: siteRow('b', { actionable: { activate: false, deactivate: true, update: true, delete: true } }),
    };
    const mustUse = {
      kind: 'plugin' as const,
      row: siteRow('c', { actionable: { activate: false, deactivate: false, update: false, delete: false } }),
    };
    expect([...allowedActions([deletable])].sort()).toEqual(['deactivate', 'delete']);
    // One row that cannot be updated removes Update for the whole selection.
    expect(allowedActions([deletable, active]).has('update')).toBe(false);
    expect(allowedActions([deletable, mustUse]).size).toBe(0);
    expect(allowedActions([]).size).toBe(0);
  });

  it('never mixes core with plugins, and only offers core-update for core', () => {
    const core = {
      kind: 'core' as const,
      row: siteRow('a', { actionable: { activate: false, deactivate: false, update: true, delete: false } }),
    };
    const plugin = { kind: 'plugin' as const, row: siteRow('a') };
    expect([...allowedActions([core])]).toEqual(['core-update']);
    expect(allowedActions([core, plugin]).size).toBe(0);
  });

  it('drops filters that mean nothing for core when switching tabs', () => {
    // Otherwise the request carries chips the backend answers with nothing, while the chips
    // themselves are disabled on that tab - a dead end with no way back.
    expect(filtersForKind('core', ['updates', 'inactive', 'closed', 'vulnerable'])).toEqual([
      'updates',
      'vulnerable',
    ]);
    expect(filtersForKind('plugin', ['inactive', 'closed'])).toEqual(['inactive', 'closed']);
  });
});
