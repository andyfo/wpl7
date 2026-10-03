import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this build is.
 *
 * `.dockerignore` drops `.git`, so the panel cannot work out its own revision at runtime.
 * The version and commit are stamped into the image instead (`panel/Dockerfile` turns
 * `--build-arg VERSION` into `WPL7_VERSION`), and that stamp is the single record of what a
 * box is running: `/api/meta`, the sidebar, the update checker and the health gate
 * `update.sh` waits on all read it from here. A release is therefore identified by the
 * image, not by a number someone remembered to bump in two places.
 */
export const PANEL_VERSION: string = process.env.WPL7_VERSION || `${packageVersion()}-dev`;

/** Short commit of the build, or `unknown` outside an image. */
export const PANEL_GIT_SHA: string = process.env.WPL7_GIT_SHA || 'unknown';

/**
 * Fallback for everything that is not an image - `npm run dev`, the test suite.
 *
 * Found by walking up from this file rather than by a fixed relative path: package.json is
 * two directories above `src/lib` and three above `dist/src/lib`, and the two are only ever
 * exercised separately, so a hardcoded path is wrong in production exactly when nobody is
 * looking.
 */
function packageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      /* not this level */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}
