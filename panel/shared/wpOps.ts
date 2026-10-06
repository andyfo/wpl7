// @docs plugins/updates
import type { WpComponentKind } from './schemas.js';
import type { SiteWpStatusDto } from './types.js';

/**
 * Which updates a site's snapshot calls for. Shared because two places must agree on it: the
 * site page's "Update all" and "Fix vulnerable" buttons, and an update schedule deciding
 * what to do the moment its job runs.
 */
export interface WpUpdateOp {
  kind: WpComponentKind;
  slug?: string;
  action: 'update';
}

/** Everything the snapshot says is out of date, core included. */
export function updateAllOps(status: SiteWpStatusDto): WpUpdateOp[] {
  const ops: WpUpdateOp[] = [];
  for (const item of [...status.plugins, ...status.themes]) {
    if (item.actionable.update) ops.push({ kind: item.kind, slug: item.slug, action: 'update' });
  }
  if (status.core.updateVersion) ops.push({ kind: 'core', action: 'update' });
  return ops;
}

/**
 * Everything whose available update actually clears what is known against it.
 *
 * `updateFixes` is computed on the server by re-running the version matcher against the
 * offered release, which is the only way to keep this button's promise: an advisory fixed
 * in 2.0 is not fixed by the 1.1 the directory happens to offer, and an advisory with no
 * fix at all is not fixed by anything - the honest remedy there ("deactivate it") is a
 * decision, not a button.
 */
export function fixVulnerableOps(status: SiteWpStatusDto): WpUpdateOp[] {
  const ops: WpUpdateOp[] = [];
  for (const item of [...status.plugins, ...status.themes]) {
    if (item.updateFixes) ops.push({ kind: item.kind, slug: item.slug, action: 'update' });
  }
  if (status.core.updateVersion && status.core.vulnerabilities.length > 0) {
    ops.push({ kind: 'core', action: 'update' });
  }
  return ops;
}

/** What an update policy (a `wp.update` schedule) means for one site's snapshot. */
export function policyOps(
  status: SiteWpStatusDto,
  policy: { plugins: boolean; themes: boolean; core: boolean; onlyVulnerable: boolean },
): WpUpdateOp[] {
  const ops = policy.onlyVulnerable ? fixVulnerableOps(status) : updateAllOps(status);
  return ops.filter((op) => (op.kind === 'plugin' ? policy.plugins : op.kind === 'theme' ? policy.themes : policy.core));
}
