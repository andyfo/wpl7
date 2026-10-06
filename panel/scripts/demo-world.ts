/**
 * The demo world: a fictional, well-used WPL7 install, served by the real panel over the test
 * suite's fakes. It is what the docs' screenshots are taken from (docs/site/scripts/shoot.ts),
 * and a way to look at the panel with data in it without Docker, a server or the network.
 *
 *   npm run demo -- [--port 3999] [--web-dist ../web/dist]
 *
 * Sign in as admin / correct-horse-battery. Everything it shows is invented (demo/data.ts), and
 * nothing it does leaves the process: no Docker, no SSH, no outbound request, no file outside a
 * temporary directory. It never starts the job worker or the schedulers, so what it shows stays
 * as seeded. See demo/README.md.
 */
import './demo/env.js';
import './demo/clock.js';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildServer } from '../src/server.js';
import { seedAll } from './demo/seed.js';
import { buildWorld } from './demo/world.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '3999' },
    host: { type: 'string', default: '127.0.0.1' },
    'web-dist': { type: 'string' },
  },
});

const world = await buildWorld();
await seedAll(world);
const webDist = values['web-dist'] ? path.resolve(values['web-dist']) : null;
const app = await buildServer(world.deps, { webDist });
// The panel sets its session cookie Secure, as behind Traefik, and sends it only over what it
// takes for HTTPS. The demo has no proxy in front, so it says so itself: a browser on localhost
// keeps a Secure cookie over plain HTTP.
app.server.prependListener('request', (req) => {
  req.headers['x-forwarded-proto'] ??= 'https';
});
await app.listen({ port: Number(values.port), host: values.host });
console.log(`demo ready on http://${values.host}:${values.port}${webDist ? '' : ' (API only: pass --web-dist for the panel)'}`);
