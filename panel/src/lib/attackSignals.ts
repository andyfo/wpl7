/**
 * What a request says about its sender, for attack detection (services/attackDetector.ts).
 * Pure: an access-log event in, the rules it counts towards out.
 *
 *   login     POST wp-login.php answered 200 (the form again: a wrong password), 401, 403, 429
 *   xmlrpc    POST xmlrpc.php - one request can carry hundreds of password guesses
 *   probing   a path only an attacker asks for (4 points), or a request a rule refused (1)
 *   deadUrls  404 on something that is not an asset - guessing at what exists
 *   flooding  the rate limit's own 429, on something that is not an asset
 *
 * Probing and dead URLs count each path once: a broken link on a busy page is one 404 per
 * visitor, not one attacker.
 */
import type { DetectionRuleId } from '../../shared/security.js';
import type { AccessEvent } from './accessLog.js';

export interface Signal {
  rule: DetectionRuleId;
  points: number;
  /** Counted once per distinct value within the rule's window; absent = every time. */
  distinct?: string;
}

/**
 * Paths no visitor and no WordPress feature ever asks for: secrets, other applications'
 * admin pages, shells left behind by earlier break-ins. Asking for one is the intent.
 */
const TRAP_PATH =
  /^(?:\/\.env(?:[.-][^/]*)?$|\/\.git\/|\/\.(?:aws|ssh|docker)\/|\/\.?wp-config\.php[.~_-]|\/wp-config\.(?:bak|old|txt|save|orig)$|\/(?:phpmyadmin|pma|myadmin|mysqladmin|adminer)(?:[/.]|$)|\/(?:shell|wso|c99|r57|alfa|marijuana|up|upload|x|xx|0x|mini)\.php$|\/cgi-bin\/|\/vendor\/phpunit\/|\/(?:server-status|actuator|solr|jenkins|manager\/html)(?:\/|$)|\/wp-content\/(?:debug\.log|backup-db|uploads\/[^?]*\.php\d?$))/i;

/** Assets a page pulls in: never a sign of anything, and plentiful on every 404 page. */
const ASSET = /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|pdf|txt|xml|json)$/i;

export const isTrapPath = (path: string): boolean => TRAP_PATH.test(path.split('?')[0] ?? '');
export const isAssetPath = (path: string): boolean => ASSET.test(path.split('?')[0] ?? '');

/** `refusedBy`: the rule that refused the request (services/securityEvents.ts), if one did. */
export function signalsOf(event: AccessEvent, refusedBy: string | null): Signal[] {
  const path = (event.path.split('?')[0] ?? '/').toLowerCase();
  const out: Signal[] = [];
  if (event.method === 'POST' && /^\/wp-login\.php/.test(path) && [200, 401, 403, 429].includes(event.status)) {
    out.push({ rule: 'login', points: 1 });
  }
  if (event.method === 'POST' && /^\/xmlrpc\.php/.test(path)) out.push({ rule: 'xmlrpc', points: 1 });
  const refused = refusedBy !== null && !refusedBy.startsWith('limit-') && refusedBy !== 'blocked-address';
  if (isTrapPath(path)) out.push({ rule: 'probing', points: 4, distinct: path });
  else if (refused) out.push({ rule: 'probing', points: 1, distinct: path });
  if (event.status === 404 && !isAssetPath(path)) out.push({ rule: 'deadUrls', points: 1, distinct: path });
  if (event.status === 429 && event.originStatus === 0 && !isAssetPath(path)) out.push({ rule: 'flooding', points: 1 });
  return out;
}
