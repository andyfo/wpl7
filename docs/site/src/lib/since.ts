import semver from 'semver';
import releases from '../data/releases.json';

/**
 * The release GitHub marks Latest, from src/data/releases.json (refreshed by the publish
 * workflow; scripts/gen-changelog.ts). Null when there is none: then nothing is "edge".
 */
export const LATEST_RELEASE: string | null = releases.latest ? semver.clean(releases.latest) : null;

/** True while `since` names a release newer than the latest one: the feature is edge-only. */
export function isEdge(since: string | undefined): boolean {
  if (!since || !LATEST_RELEASE) return false;
  const v = semver.clean(since);
  return v !== null && semver.gt(v, LATEST_RELEASE);
}
