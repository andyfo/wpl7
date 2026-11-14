/**
 * The deploy folder's compose files, read the way the tests need them: test/unit/composeFlags.test.ts
 * checks Traefik's flags, and the engine tests start a Traefik from the same list, so that what they
 * prove holds for the one every server runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPLOY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy');

/** One key of the `traefik` service (`command:`, `environment:`, `volumes:`), as written: quotes stripped, comments skipped. */
export function traefikList(file: string, key: string): string[] {
  const lines = fs.readFileSync(path.join(DEPLOY, file), 'utf8').split('\n');
  const items: string[] = [];
  let inTraefik = false;
  let inKey = false;
  for (const line of lines) {
    if (/^ {2}\S/.test(line)) {
      inTraefik = /^ {2}traefik:\s*$/.test(line);
      inKey = false;
      continue;
    }
    if (!inTraefik) continue;
    if (/^ {4}\S/.test(line)) {
      inKey = new RegExp(`^ {4}${key}:\\s*$`).test(line);
      continue;
    }
    if (!inKey || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s+"?(.*?)"?\s*$/.exec(line) ?? /^ {6}(\S.*?)\s*$/.exec(line);
    if (item) items.push(item[1]!);
  }
  return items;
}

export const traefikFlags = (file: string) => traefikList(file, 'command');

/** The `image:` of the `traefik` service. */
export function traefikImage(file = 'docker-compose.yml'): string {
  const compose = fs.readFileSync(path.join(DEPLOY, file), 'utf8');
  const image = /^ {2}traefik:\s*\n(?: {4}.*\n|\s*\n)*? {4}image:\s*(\S+)/m.exec(compose)?.[1];
  if (!image) throw new Error(`No traefik image in ${file}`);
  return image;
}

/**
 * Compose's interpolation of `${NAME}` and `${NAME:-default}`, from `env` alone: a value the test
 * did not give is empty, as compose makes it with nothing in .env.
 */
export function interpolate(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_all, name: string, fallback: string | undefined) => {
    const given = env[name];
    return given !== undefined && given !== '' ? given : (fallback ?? '');
  });
}
