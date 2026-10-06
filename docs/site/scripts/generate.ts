/**
 * npm run docs:generate
 *
 * Runs every generator: the API reference, the MCP tools, the deploy/.env reference, the job
 * types, the protection and key levels, the known limits (from every page's Limits section),
 * and the changelog (from the committed releases.json;
 * `npm run docs:releases` refreshes that, this does not). CI runs this and fails when the
 * committed pages differ from what it writes.
 */
import { generateChangelog } from './gen-changelog.js';

// `--only changelog`: the publish job, which refreshes releases.json, needs no more than that.
// The other generators import panel modules, so they are loaded only when they run.
if (process.argv.includes('--only') && process.argv.includes('changelog')) {
  generateChangelog();
} else {
  (await import('./gen-api.js')).generateApi();
  await (await import('./gen-mcp-tools.js')).generateMcpTools();
  (await import('./gen-config.js')).generateConfig();
  (await import('./gen-job-types.js')).generateJobTypes();
  (await import('./gen-levels.js')).generateLevels();
  generateChangelog();
  await (await import('./gen-limits.js')).generateLimits();
}
