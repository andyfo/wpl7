import type { WpComponentKind, WpBulkAction, WpInventoryFilter } from '../../../shared/schemas';
import type { WpInventoryRow, WpInventorySiteRow } from '../../../shared/types';

/** A component on one site: what a checkbox selects and what the API calls a target. */
export interface Target {
  siteSlug: string;
  kind: WpComponentKind;
  slug: string;
}

export const targetKey = (t: Target): string => `${t.siteSlug}|${t.kind}|${t.slug}`;

export interface VisibleRow {
  kind: WpComponentKind;
  slug: string;
  row: WpInventorySiteRow;
}

/** Every selectable row currently on screen, keyed the way the selection is. */
export function visibleRows(rows: WpInventoryRow[]): Map<string, VisibleRow> {
  const map = new Map<string, VisibleRow>();
  for (const group of rows) {
    for (const row of group.siteRows) {
      map.set(targetKey({ siteSlug: row.siteSlug, kind: group.kind, slug: group.slug }), {
        kind: group.kind,
        slug: group.slug,
        row,
      });
    }
  }
  return map;
}

/**
 * The selection, minus anything the table is no longer showing.
 *
 * This is the invariant the action bar assumes: it decides which actions to offer from the
 * visible rows only, so a selected row hidden by a later search - or dropped by a refresh -
 * would otherwise travel invisibly into the next Delete. Returns the same Map instance when
 * nothing was dropped, so it can be used directly in a setState updater.
 */
export function reconcileSelection(
  selected: Map<string, Target>,
  visible: Map<string, VisibleRow>,
): Map<string, Target> {
  if (selected.size === 0) return selected;
  const kept = new Map([...selected].filter(([key]) => visible.has(key)));
  return kept.size === selected.size ? selected : kept;
}

/** The selected targets that are still on screen, in selection order. */
export function visibleTargets(selected: Map<string, Target>, visible: Map<string, VisibleRow>): Target[] {
  return [...selected.entries()].filter(([key]) => visible.has(key)).map(([, target]) => target);
}

/** The subset of a batch's original targets that belong to the given sites. */
export function targetsForSites(targets: Target[], siteSlugs: string[]): Map<string, Target> {
  const wanted = new Set(siteSlugs);
  return new Map(targets.filter((t) => wanted.has(t.siteSlug)).map((t) => [targetKey(t), t]));
}

/**
 * Which actions the current selection can actually run, given each row's own rules.
 * Empty when the selection mixes states - the server enforces the same rules, so offering
 * an action here that it would reject is only a way to lose a click.
 */
export function allowedActions(rows: { kind: WpComponentKind; row: WpInventorySiteRow }[]): Set<WpBulkAction> {
  const out = new Set<WpBulkAction>();
  if (rows.length === 0) return out;
  if (rows.every((r) => r.kind === 'core')) {
    if (rows.every((r) => r.row.actionable.update)) out.add('core-update');
    return out;
  }
  if (rows.some((r) => r.kind === 'core')) return out; // mixing core with the rest has no one action
  if (rows.every((r) => r.row.actionable.update)) out.add('update');
  if (rows.every((r) => r.row.actionable.activate)) out.add('activate');
  if (rows.every((r) => r.row.actionable.deactivate)) out.add('deactivate');
  if (rows.every((r) => r.row.actionable.delete)) out.add('delete');
  return out;
}

/**
 * The filters that still mean something for a component kind.
 *
 * Core is never inactive and is never closed on wordpress.org, and those two chips are
 * disabled on that tab - so carrying them over from the plugins tab would filter every row
 * away with no control left to undo it.
 */
export function filtersForKind(kind: WpComponentKind, filters: WpInventoryFilter[]): WpInventoryFilter[] {
  if (kind !== 'core') return filters;
  return filters.filter((f) => f === 'updates' || f === 'vulnerable');
}
