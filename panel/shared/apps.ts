/**
 * Container apps' names and numbers, shared by the panel and its pages (services/appRoutes.ts,
 * services/apps.ts).
 */
// @docs sites/container
import type { AppRouteMatch, AppRouteScheme } from './schemas.js';

/**
 * Routers in an app's routes file are `wpl7app_<kind>_<slug>`: an underscore is in no slug, so the
 * name splits back apart, as the protection's do (shared/security.ts securityName). `r<id>` is a
 * route's https router, `r<id>-http` its plain http one, `svc` the service they share.
 */
export const APP_ROUTER_PREFIX = 'wpl7app';
const KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function appRouterName(kind: string, slug: string): string {
  if (!KIND_RE.test(kind)) throw new Error(`Not an app router kind: "${kind}"`);
  if (!SLUG_RE.test(slug)) throw new Error(`Not a site slug: "${slug}"`);
  return `${APP_ROUTER_PREFIX}_${kind}_${slug}`;
}

/** `wpl7app_r3-http_shop@file` -> { kind: 'r3-http', slug: 'shop' }; null for any other name. */
export function parseAppRouterName(name: string): { kind: string; slug: string } | null {
  const parts = (name.split('@')[0] ?? '').split('_');
  if (parts.length !== 3 || parts[0] !== APP_ROUTER_PREFIX) return null;
  const [, kind, slug] = parts as [string, string, string];
  return KIND_RE.test(kind) && SLUG_RE.test(slug) ? { kind, slug } : null;
}

/** The route id a router is for: `r3-http` -> 3. */
export const routeIdOfKind = (kind: string): number | null => {
  const m = /^r(\d+)(?:-http)?$/.exec(kind);
  return m ? Number(m[1]) : null;
};

/**
 * Where an app's routers sit among everything else in Traefik (services/securityConfig.ts
 * PRIORITY): above every router of a site's protection file, which reaches 900,030, so that a path
 * on another site's domain wins over that site; below the block list. Within the band a longer
 * path beats a shorter one and an exact one beats a prefix, as Traefik's rule length would.
 */
export const APP_ROUTE_PRIORITY = 950_000;
export const MAX_APP_ROUTE_PATH = 200;

export function appRoutePriority(route: { match: AppRouteMatch; path: string }): number {
  const length = Math.min(route.path.length, 9_999);
  if (route.match === 'exact') return APP_ROUTE_PRIORITY + 20_000 + length;
  if (route.match === 'prefix') return APP_ROUTE_PRIORITY + 10_000 + length;
  return APP_ROUTE_PRIORITY;
}

/** At most this many routes, environment variables, mounts and host aliases per app. */
export const APP_LIMITS = { routes: 100, env: 100, mounts: 20, extraHosts: 20, dataPaths: 20, envValueBytes: 32 * 1024 } as const;

/** What a route takes, in words: `www.example.com/api/…, both`. */
export function describeRoute(route: { host: string; match: AppRouteMatch; path: string; scheme: AppRouteScheme }): string {
  const where = route.match === 'none' ? route.host : route.match === 'prefix' ? `${route.host}${route.path}…` : `${route.host}${route.path}`;
  return route.scheme === 'both' ? `${where} (https and http)` : route.scheme === 'http' ? `${where} (http)` : where;
}
