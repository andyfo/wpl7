import { execFileSync } from 'node:child_process';

/**
 * The commit this build was made from, as the site footer shows it ("Built from a1b2c3d"). The
 * publish smoke test reads it back from the live page to know the new build is the one served.
 * DOCS_BUILD_ID wins (CI sets it); otherwise git; otherwise "local".
 */
function readBuildId(): string {
  const fromEnv = process.env.DOCS_BUILD_ID?.trim();
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'local';
  }
}

export const BUILD_ID = readBuildId();
