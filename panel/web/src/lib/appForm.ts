// @docs sites/container
/** A container app's lists as its forms edit them: New site's steps and its Settings tab. */
import type { AppRouteMatch, AppRouteScheme } from '../../../shared/schemas';

/** `key`: the row's own, for React; `id`: a saved route's, which names its routers. */
export interface RouteEdit {
  key: number;
  id?: number;
  host: string;
  match: AppRouteMatch;
  path: string;
  scheme: AppRouteScheme;
  enabled: boolean;
  /** The site whose domain it takes a path of. */
  borrowedFrom?: string | null;
}

/** `kept`: a secret with a value the page never sees, sent without one so that it keeps it. */
export interface EnvEdit {
  key: number;
  name: string;
  value: string;
  secret: boolean;
  kept: boolean;
}

/** `saved`: the app has it already, so it can be filled, and its name stays. */
export interface MountEdit {
  key: number;
  name: string;
  path: string;
  writable: boolean;
  inBackups: boolean;
  filledAt: number | null;
  saved: boolean;
}
