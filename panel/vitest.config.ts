import os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Makes argon2 and RSA keys cheap; see the file for why they would be most of the runtime.
    setupFiles: ['test/setup.ts'],
    // Better-sqlite3 memory DBs are per-instance; parallel files are fine. The default `forks`
    // pool is also the fast one here - under `threads` the native modules re-initialise per
    // thread and import time triples.
    //
    // One process per worker, not per file: a fresh process re-imports drizzle, Fastify, the
    // MCP SDK and all of src/ - about 1.3 s a file, as long as the tests themselves took. Every
    // test builds its own world (makeWorld), so files share nothing but test/setup.ts's patches,
    // which are written to run more than once. A test that changes something module-wide (a
    // registry entry, a spy on Date) must put it back, as the ones that do already do.
    isolate: false,
    // Vitest's default is one fork fewer than the cores, which on CI's two-core runner means a
    // single fork. Much of a test is waiting on timers and child processes, so three forks
    // finish there in 48 s against 86 s for one, and 54 s for two; four is slower again.
    maxWorkers: Math.max(3, os.availableParallelism() - 1),
  },
});
