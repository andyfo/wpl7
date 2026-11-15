// @docs sites/move
import type { SiteApp } from '../../../shared/schemas';

export type MoveQuiesce = 'maintenance' | 'stop' | 'none';

/**
 * What the Move dialog offers a live site instead of keeping it serving while it is copied: a
 * WordPress site's maintenance page, or a stop for a PHP site, which has none. A container app is
 * always stopped while it is copied (services/sites.ts move), so it is offered nothing, as a site
 * that is not live is: null.
 */
export function moveFreeze(site: { app: SiteApp; isLive: boolean }): 'maintenance' | 'stop' | null {
  if (site.app === 'container' || !site.isLive) return null;
  return site.app === 'php' ? 'stop' : 'maintenance';
}

/** POST /api/sites/:slug/move's body: a quiesce only where the dialog offered a choice, the freeze unless another was picked. */
export function moveBody(site: { app: SiteApp; isLive: boolean }, targetServerId: number, picked: MoveQuiesce | null) {
  const freeze = moveFreeze(site);
  return { targetServerId, ...(freeze ? { quiesce: picked ?? freeze } : {}) };
}
