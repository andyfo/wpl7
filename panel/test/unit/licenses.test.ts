import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { installedRecipes, jobs, plugins, siteLicenses, sites, siteWpComponents } from '../../src/db/schema.js';
import { RecipeCatalog } from '../../src/services/catalog.js';
import { describeRecipe, LICENSES_MU_PLUGIN_FILE, LICENSES_MU_PLUGIN_PATH, maskSecret, renderDropIn, withoutStepOutput } from '../../src/services/licenses.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, zipOf, type TestWorld } from '../helpers.js';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const pluginList = (...plugins: { name: string; status?: string }[]) =>
  ok(JSON.stringify(plugins.map((p) => ({ name: p.name, status: p.status ?? 'active', version: '1.0', update_version: null }))));
const BREAKDANCE_OK = 'Setting license key...\nLicense Information:\n  Product: Breakdance Pro\n  Status: Valid\n  Activation: Active\n  Expires: December 26, 2026 (in 3 months)\nSuccess: License key set successfully.\n';
const BREAKDANCE_STATUS = 'Breakdance System Status:\n========================\nMode: breakdance\nLicense: Pro Mode\n';

/** A registered site whose container the fake daemon reports as running. */
async function siteWorld() {
  const w = await makeWorld();
  const { site } = w.deps.sites.create({
    title: 'Licensed',
    domainMode: 'dev',
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    discourageSearchEngines: true,
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  w.docker.containers.set(site.containerName, 'running');
  // A recipe runs only once installed; the tests here are about running, so both are.
  w.core.licenses.install('acf-pro');
  w.core.licenses.install('breakdance');
  const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
  const log: string[] = [];
  const hookLog = { info: (m: string) => log.push(`info ${m}`), warn: (m: string) => log.push(`warn ${m}`) };
  return { w, site: row, server: w.servers.handleFor(row.serverId), log, hookLog };
}

/** Two inputs, one of them not secret - the shape of WP Rocket's wp-config pre-activation. */
const TWO_INPUTS = {
  type: 'plugin-recipe',
  typeVersion: 1,
  id: 'rocket-like',
  name: 'Rocket-like',
  plugin: 'rocket-like',
  inputs: [
    { id: 'email', label: 'Account email', secret: false, constant: 'ROCKET_LIKE_EMAIL' },
    { id: 'key', label: 'License key', constant: 'ROCKET_LIKE_KEY' },
  ],
  hooks: {
    afterInstall: [
      { run: 'wp', args: ['rocket-like', 'activate', '--email={{inputs.email}}', '--key={{inputs.key}}'] },
      { run: 'php', code: "echo getenv('WPL7_INPUT_EMAIL');" },
    ],
  },
};

/** The wp-cli commands a hook ran - not the drop-in the panel keeps up to date beside them (`sh -c`). */
const execCmds = (w: TestWorld) =>
  w.docker.calls
    .filter((c) => c.method === 'exec' && (c.args[1] as string[])[0] !== 'sh')
    .map((c) => (c.args[1] as string[]).join(' '));
const statusRow = (w: TestWorld, siteId: number, recipeId: string) =>
  w.db.select().from(siteLicenses).where(eq(siteLicenses.siteId, siteId)).all().find((r) => r.recipeId === recipeId);

describe('recipe catalog', () => {
  it('ships ACF PRO and Breakdance recipes that validate', async () => {
    const w = await makeWorld();
    const ids = w.core.licenses.catalog.list().map((r) => r.id);
    expect(ids).toEqual(['acf-pro', 'breakdance']);
    expect(w.core.licenses.catalog.forPlugin('advanced-custom-fields-pro')?.inputs).toEqual([
      expect.objectContaining({ id: 'key', label: 'License key', secret: true, constant: 'ACF_PRO_LICENSE' }),
    ]);
    expect(w.core.licenses.catalog.skipped).toEqual([]);
  });

  it('skips entry types it does not know, invalid entries and duplicates - and says why', () => {
    const catalog = new RecipeCatalog(quiet);
    expect(catalog.add({ type: 'site-blueprint', id: 'x' }, 'future.json')).toBe(false);
    expect(catalog.add({ type: 'plugin-recipe', typeVersion: 1, id: 'bad id', name: 'x', plugin: 'x' }, 'bad.json')).toBe(false);
    expect(catalog.add({ type: 'plugin-recipe', typeVersion: 1, id: 'one', name: 'One', plugin: 'one' })).toBe(true);
    expect(catalog.add({ type: 'plugin-recipe', typeVersion: 1, id: 'one', name: 'Again', plugin: 'other' })).toBe(false);
    expect(catalog.add({ type: 'plugin-recipe', typeVersion: 1, id: 'two', name: 'Two', plugin: 'one' })).toBe(false);
    expect(catalog.skipped.map((s) => s.source)).toEqual(['future.json', 'bad.json', 'inline', 'inline']);
    expect(catalog.skipped[0]!.reason).toMatch(/not known to this panel version/);
    expect(catalog.skipped[1]!.reason).toMatch(/^id:/);
    // Hooks default to empty lists, so a recipe without them is still a complete object.
    expect(catalog.byId('one')!.hooks.afterInstall).toEqual([]);
  });

  it('refuses a recipe whose steps use a placeholder it cannot fill, or that declares an input twice', () => {
    const catalog = new RecipeCatalog(quiet);
    const recipe = (inputs: unknown[], args: string[]) => ({
      type: 'plugin-recipe', typeVersion: 1, id: 'demo', name: 'Demo', plugin: 'demo', inputs, hooks: { afterInstall: [{ run: 'wp', args }] },
    });
    const key = { id: 'key', label: 'License key' };
    expect(catalog.add(recipe([key], ['x', '{{inputs.token}}']), 'undeclared.json')).toBe(false);
    expect(catalog.add(recipe([key], ['x', '{{key}}']), 'old-style.json')).toBe(false);
    expect(catalog.add(recipe([key, { id: 'key', label: 'Again' }], ['x']), 'twice.json')).toBe(false);
    expect(catalog.skipped.map((s) => `${s.source} ${s.reason}`)).toEqual([
      'undeclared.json hooks.afterInstall.0.args.1: {{inputs.token}} names an input the recipe does not declare',
      "old-style.json hooks.afterInstall.0.args.1: unknown placeholder {{key}} (the recipe's own values are {{inputs.<id>}})",
      'twice.json inputs.1.id: input "key" is declared twice',
    ]);
    expect(catalog.add(recipe([key], ['x', '--key={{inputs.key}}', '{{plugin}}', '{{url}}']))).toBe(true);
  });

  it('refuses a step whose expect is not a regular expression, instead of throwing mid-hook later', async () => {
    const broken = {
      type: 'plugin-recipe', typeVersion: 1, id: 'demo', name: 'Demo', plugin: 'demo',
      hooks: { verify: [{ run: 'wp', args: ['demo', 'status'], expect: '[', optional: true }] },
    };
    const catalog = new RecipeCatalog(quiet);
    expect(catalog.add(broken, 'broken.json')).toBe(false);
    expect(catalog.skipped[0]!.reason).toBe('hooks.verify.0.expect: not a valid regular expression');
    const w = await makeWorld();
    expect(() => w.core.licenses.addLocal(broken)).toThrow('Not a valid recipe: hooks.verify.0.expect: not a valid regular expression');
  });
});

describe('LicenseService.rewriteDropIn', () => {
  it('puts a broken drop-in back without running WordPress, which would load it first', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('acf-pro', 'key', 'k-123');
    const file = path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<?php exit;\n');
    // Every WP-CLI call would die on it now.
    w.docker.execDefault = { stdout: '', stderr: 'PHP Parse error: in wp-content/mu-plugins/wpl7-licenses.php', exitCode: 255 };
    const asked: string[] = [];
    w.docker.ephemeral = (opts) => {
      asked.push(opts.labels?.['wpl7.scan'] ?? '?');
      const plugins = [{ slug: 'advanced-custom-fields-pro', version: '6.3.2', file: 'advanced-custom-fields-pro/acf.php' }];
      return { stdout: `${JSON.stringify({ t: 'inventory', core: { version: '6.9', locale: null }, plugins, themes: [] })}\n`, stderr: '', exitCode: 0 };
    };

    await w.core.licenses.rewriteDropIn(server, site, hookLog);

    // What is installed was read from the plugins' headers, in a throwaway container.
    expect(asked).toEqual(['inventory']);
    expect(execCmds(w)).toEqual([]);
    const dropIn = fs.readFileSync(file, 'utf8');
    expect(dropIn).toContain("define('ACF_PRO_LICENSE', 'k-123');");
    expect(w.core.panelFiles.expected(site.id)[LICENSES_MU_PLUGIN_PATH]).toEqual([crypto.createHash('sha256').update(dropIn).digest('hex')]);
  });
});

describe('LicenseService.runHook', () => {
  it('activates Breakdance through its CLI, verifies, and records the outcome', async () => {
    const { w, site, server, hookLog, log } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), ok(BREAKDANCE_OK), ok('Success: Updated 1 of 1 plugins.'), ok(BREAKDANCE_STATUS));

    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://licensed.dev.example.test' }, hookLog);

    expect(outcomes).toEqual([{ recipeId: 'breakdance', name: 'Breakdance', status: 'active', message: null }]);
    const cmds = execCmds(w);
    expect(cmds).toEqual([
      'wp plugin list --format=json --fields=name,status,version,update_version',
      'wp breakdance license abc123def456ghi7',
      'wp plugin update breakdance',
      'wp breakdance status',
    ]);
    const row = statusRow(w, site.id, 'breakdance')!;
    expect(row.status).toBe('active');
    expect(row.url).toBe('http://licensed.dev.example.test');
    // The key never reaches the job log.
    expect(log.join('\n')).not.toContain('abc123def456ghi7');
    expect(log.some((l) => l === 'info Breakdance: license active')).toBe(true);
    // Breakdance takes no constant, so no drop-in is written.
    expect(fs.existsSync(path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE))).toBe(false);
  });

  it('hands ACF PRO its constant through a drop-in and runs the PHP steps through wp eval', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('acf-pro', 'key', "key'with\\quote");
    w.docker.execQueue.push(
      pluginList({ name: 'advanced-custom-fields-pro' }),
      ok('OK: license active for http://licensed.dev.example.test'),
      ok('Success: Plugin already updated.'),
      ok('OK: license active for http://licensed.dev.example.test'),
    );

    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://licensed.dev.example.test' }, hookLog);

    expect(outcomes[0]!.status).toBe('active');
    const dropIn = fs.readFileSync(path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE), 'utf8');
    expect(dropIn).toContain("define('ACF_PRO_LICENSE', 'key\\'with\\\\quote');");
    expect(dropIn.startsWith('<?php')).toBe(true);
    // Noted as the panel's own, so a malware scan holds the file to exactly this.
    expect(w.core.panelFiles.expected(site.id)[LICENSES_MU_PLUGIN_PATH]).toEqual([crypto.createHash('sha256').update(dropIn).digest('hex')]);
    // Written inside the site's container - never through the host's copy of its files,
    // where a symlink the site planted would be followed as root.
    const write = w.docker.calls.find((c) => c.method === 'execWithInput')!;
    expect(write.args[0]).toBe(site.containerName);
    expect((write.args[1] as string[]).slice(4, 8)).toEqual([
      '/var/www/html/wp-content',
      '/var/www/html/wp-content/mu-plugins',
      LICENSES_MU_PLUGIN_FILE,
      'put',
    ]);
    expect(write.args[2]).toMatchObject({ user: '0:0' });
    const evals = w.docker.calls.filter((c) => c.method === 'exec' && (c.args[1] as string[])[1] === 'eval');
    expect(evals).toHaveLength(2);
    expect((evals[0]!.args[1] as string[])[2]).toContain('acf_pro_check_defined_license()');
    // The key travels in the environment, not in the code.
    const opts = evals[0]!.args[2] as { env?: string[] };
    expect(opts.env).toContain("WPL7_INPUT_KEY=key'with\\quote");
    expect(opts.env).toContain('WPL7_SITE_URL=http://licensed.dev.example.test');
    expect((evals[0]!.args[1] as string[])[2]).not.toContain("key'with");
  });

  it('records a key the vendor rejects as failed and stops before the follow-up steps', async () => {
    const { w, site, server, hookLog, log } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'wrong-key-000000');
    // Exit 0 with a negative answer: the CLI does not fail, the output does.
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), ok('License Information:\n  Status: Invalid\n  Activation: Inactive\n'));

    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);

    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.message).toMatch(/did not confirm success/);
    expect(execCmds(w)).not.toContain('wp plugin update breakdance');
    expect(statusRow(w, site.id, 'breakdance')!.status).toBe('failed');
    expect(log.some((l) => l.startsWith('warn Breakdance: FAILED'))).toBe(true);
  });

  it('carries on past an optional step that fails', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.docker.execQueue.push(
      pluginList({ name: 'breakdance' }),
      ok(BREAKDANCE_OK),
      { stdout: '', stderr: 'Error: no update available', exitCode: 1 },
      ok(BREAKDANCE_STATUS),
    );
    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    expect(outcomes[0]!.status).toBe('active');
  });

  it('leaves a plugin without a stored key alone, and says so', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }));
    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    expect(outcomes[0]).toMatchObject({ status: 'not-set-up', message: 'License key not entered yet (Plugins → Recipes)' });
    expect(execCmds(w)).toHaveLength(1);
  });

  it('does nothing for a plugin that is installed but inactive', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.docker.execQueue.push(pluginList({ name: 'breakdance', status: 'inactive' }));
    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    expect(outcomes[0]!.status).toBe('inactive');
    expect(execCmds(w)).toHaveLength(1);
  });

  it('answers nothing when no plugin with a recipe is on the site', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.docker.execQueue.push(pluginList({ name: 'wordpress-seo' }));
    expect(await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog)).toEqual([]);
  });

  it('substitutes the old and new URL after a URL change', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), ok('3 rows'), ok(''), ok(BREAKDANCE_OK), ok(BREAKDANCE_STATUS));
    const outcomes = await w.core.licenses.runHook(
      server,
      site,
      'afterUrlChange',
      { url: 'https://shop.example.com', oldUrl: 'http://licensed.dev.example.test', newUrl: 'https://shop.example.com' },
      hookLog,
    );
    expect(outcomes[0]!.status).toBe('active');
    expect(execCmds(w)).toContain('wp breakdance replace_url http://licensed.dev.example.test https://shop.example.com');
    expect(execCmds(w)).toContain('wp breakdance clear_cache');
    expect(statusRow(w, site.id, 'breakdance')!.url).toBe('https://shop.example.com');
  });

  it('removes the drop-in once no plugin on the site takes a constant', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    const file = path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderDropIn([{ constant: 'ACF_PRO_LICENSE', value: 'old' }]));
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), ok(BREAKDANCE_OK), ok(''), ok(BREAKDANCE_STATUS));
    await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('runs only the requested recipe on demand, and still keeps every installed constant defined', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.core.licenses.setInput('acf-pro', 'key', 'acfacfacfacf');
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }, { name: 'advanced-custom-fields-pro' }), ok(BREAKDANCE_STATUS));
    const outcomes = await w.core.licenses.runHook(server, site, 'verify', { url: 'http://x' }, hookLog, { only: 'breakdance' });
    expect(outcomes.map((o) => o.recipeId)).toEqual(['breakdance']);
    expect(outcomes[0]!.status).toBe('active');
    // The drop-in is built from everything on the site, not from the one recipe being run:
    // activating Breakdance must not take ACF PRO's constant away.
    const dropIn = fs.readFileSync(path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE), 'utf8');
    expect(dropIn).toContain("define('ACF_PRO_LICENSE', 'acfacfacfacf');");
  });

  it('removes the drop-in once no plugin with a recipe is installed any more', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    const file = path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderDropIn([{ constant: 'ACF_PRO_LICENSE', value: 'old' }]));
    w.core.licenses.setInput('acf-pro', 'key', 'acfacfacfacf');
    // ACF PRO was uninstalled by the customer; the next hook run must not leave its key behind.
    w.docker.execQueue.push(pluginList({ name: 'wordpress-seo' }));
    expect(await w.core.licenses.runHook(server, site, 'verify', { url: 'http://x' }, hookLog)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('uses every input a recipe declares - as constants, placeholders and environment - and hides only the secret ones', async () => {
    const { w, site, server, hookLog, log } = await siteWorld();
    expect(w.core.licenses.catalog.add(TWO_INPUTS)).toBe(true);
    w.core.licenses.install('rocket-like');
    const file = path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE);

    // One of the two entered: nothing runs, and no half set of constants reaches the site.
    w.core.licenses.setInput('rocket-like', 'email', 'ops@agency.example');
    w.docker.execQueue.push(pluginList({ name: 'rocket-like' }));
    let outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    expect(outcomes[0]).toMatchObject({ status: 'not-set-up', message: 'License key not entered yet (Plugins → Recipes)' });
    expect(execCmds(w)).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(w.core.licenses.siteStatus(site.id, new Map([['rocket-like', 'active']]))[0]).toMatchObject({ ready: false, status: 'not-set-up' });

    w.core.licenses.setInput('rocket-like', 'key', 'rk-secret-123456');
    expect(w.core.licenses.list().find((r) => r.id === 'rocket-like')!.inputs.map((i) => i.display)).toEqual([
      'ops@agency.example',
      '••••••••••••3456',
    ]);
    w.docker.execQueue.push(pluginList({ name: 'rocket-like' }), ok('Activated.'), ok('ops@agency.example'));
    outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);

    expect(outcomes[0]!.status).toBe('active');
    expect(execCmds(w)).toContain('wp rocket-like activate --email=ops@agency.example --key=rk-secret-123456');
    const dropIn = fs.readFileSync(file, 'utf8');
    expect(dropIn).toContain("define('ROCKET_LIKE_EMAIL', 'ops@agency.example');");
    expect(dropIn).toContain("define('ROCKET_LIKE_KEY', 'rk-secret-123456');");
    const evalCall = w.docker.calls.find((c) => c.method === 'exec' && (c.args[1] as string[])[1] === 'eval')!;
    expect((evalCall.args[2] as { env: string[] }).env).toEqual(
      expect.arrayContaining(['WPL7_INPUT_EMAIL=ops@agency.example', 'WPL7_INPUT_KEY=rk-secret-123456']),
    );
    expect(log.join('\n')).not.toContain('rk-secret-123456');
    expect(log).toContain('info Rocket-like: wp rocket-like activate --email=ops@agency.example --key=••••…');
  });

  it('redacts a key the vendor echoes back before cutting its output down', async () => {
    const { w, site, server, hookLog, log } = await siteWorld();
    const key = 'abc123def456ghi7';
    w.core.licenses.setInput('breakdance', 'key', key);
    // The key followed by 490 characters: cut to the last 500 first, its last ten would survive.
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), { stdout: '', stderr: `Error: license ${key}${'.'.repeat(490)}`, exitCode: 1 });

    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);

    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.message).toContain('••••');
    for (const text of [outcomes[0]!.message!, statusRow(w, site.id, 'breakdance')!.message!, log.join('\n')]) {
      expect(text).not.toContain(key.slice(-10));
    }
  });

  it('gives each line holding what a step printed a version without it, and the outcome one too', async () => {
    const { w, site, server } = await siteWorld();
    const key = 'abc123def456ghi7';
    w.core.licenses.setInput('breakdance', 'key', key);
    const lines: { message: string; withoutOutput?: string }[] = [];
    const hookLog = {
      info: (message: string) => lines.push({ message }),
      warn: (message: string, withoutOutput?: string) => lines.push({ message, withoutOutput }),
    };
    // The key comes back upper-cased - from the optional update and from the check - which
    // hiding it where it is repeated exactly does not catch.
    w.docker.execQueue.push(
      pluginList({ name: 'breakdance' }),
      ok(BREAKDANCE_OK),
      { stdout: '', stderr: `Error: ${key.toUpperCase()} has no update`, exitCode: 1 },
      { stdout: '', stderr: `Error: licence ${key.toUpperCase()} not found`, exitCode: 1 },
    );

    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);

    expect(outcomes[0]!.status).toBe('failed');
    expect(lines.map((l) => l.message).join('\n')).toContain(key.toUpperCase());
    // What a caller who may not read a command's output is shown instead.
    expect(lines.filter((l) => l.withoutOutput !== undefined).map((l) => l.withoutOutput)).toEqual([
      'Breakdance: Updating Breakdance to the current release did not succeed; continuing.',
      'Breakdance: FAILED - what the step printed is not shown at Read only access',
    ]);
    expect(lines.map((l) => l.withoutOutput ?? l.message).join('\n')).not.toContain(key.toUpperCase());
    expect(withoutStepOutput(outcomes[0]!).message).toBe('what the step printed is not shown at Read only access');
    // The panel's own words stay.
    const notSetUp = { recipeId: 'acf-pro', name: 'ACF PRO', status: 'not-set-up' as const, message: 'License key not entered yet' };
    expect(withoutStepOutput(notSetUp)).toEqual(notSetUp);
  });

  it('treats a step that cannot finish as that step failing: an optional one is passed, the next recipe still runs', async () => {
    const { w, site, server, hookLog, log } = await siteWorld();
    w.core.licenses.setInput('acf-pro', 'key', 'acfacfacfacf');
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    const exec = w.docker.exec.bind(w.docker);
    vi.spyOn(w.docker, 'exec').mockImplementation(async (name, cmd, opts) => {
      // ACF PRO's activation and Breakdance's optional update both run into wp-cli's deadline.
      if ((cmd[1] === 'eval' && cmd[2]?.includes('acf_pro_check_defined_license()')) || cmd.join(' ') === 'wp plugin update breakdance') {
        throw new Error('wp timed out after 180000ms (process terminated)');
      }
      return exec(name, cmd, opts);
    });
    w.docker.execQueue.push(pluginList({ name: 'advanced-custom-fields-pro' }, { name: 'breakdance' }), ok(BREAKDANCE_OK), ok(BREAKDANCE_STATUS));

    const outcomes = await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);

    expect(outcomes.map((o) => `${o.recipeId}:${o.status}`)).toEqual(['acf-pro:failed', 'breakdance:active']);
    expect(outcomes[0]!.message).toBe('wp timed out after 180000ms (process terminated)');
    expect(statusRow(w, site.id, 'acf-pro')!.status).toBe('failed');
    expect(log).toContain(
      'warn Breakdance: Updating Breakdance to the current release did not succeed (wp timed out after 180000ms (process terminated)); continuing.',
    );
  });
});

describe('wp.recipes job', () => {
  it('re-reads the site inventory afterwards, also when a recipe failed', async () => {
    const w = await makeWorld();
    const now = Date.now();
    const site = w.db
      .insert(sites)
      .values({
        slug: 'shop', serverId: 1, title: 'Shop', domains: JSON.stringify(['shop.test']), phpVersion: '8.3', status: 'running',
        dbName: 'shop', dbUser: 'shop', dbPassword: 'x', containerName: 'wp-shop', createdAt: now, updatedAt: now,
      })
      .returning()
      .get();
    w.docker.containers.set(site.containerName, 'running');
    w.core.licenses.install('breakdance');
    w.core.licenses.setInput('breakdance', 'key', 'wrong-key-000000');
    const scan = vi.spyOn(w.core.wpInventory, 'scanSite').mockResolvedValue();
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), ok('License Information:\n  Status: Invalid\n  Activation: Inactive\n'));

    const job = w.worker.enqueue('wp.recipes', { siteId: site.id, hook: 'afterInstall' }, { id: site.id, slug: site.slug, serverId: 1 });
    w.worker.start();
    await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status), 15_000);
    await w.worker.stop();

    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('failed');
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]![0].id).toBe(site.id);
  });
});

describe('recipe inputs', () => {
  it('lists a secret input masked, and refuses a value for an input the recipe does not have', async () => {
    const w = await makeWorld();
    w.core.licenses.install('breakdance');
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    const item = w.core.licenses.list().find((l) => l.id === 'breakdance')!;
    expect(item.inputs).toEqual([
      expect.objectContaining({ id: 'key', label: 'License key', secret: true, set: true, display: expect.stringMatching(/^•+ghi7$/) }),
    ]);
    expect(JSON.stringify(w.core.licenses.list())).not.toContain('abc123def456ghi7');
    w.core.licenses.catalog.add({ type: 'plugin-recipe', typeVersion: 1, id: 'plain', name: 'Plain', plugin: 'plain' });
    w.core.licenses.install('plain');
    expect(() => w.core.licenses.setInput('plain', 'key', 'whatever-key')).toThrow(/has no input "key"/);
    expect(() => w.core.licenses.setInput('breakdance', 'email', 'me@example.com')).toThrow(/has no input "email"/);
    expect(() => w.core.licenses.setInput('acf-pro', 'key', 'acfacfacfacf')).toThrow(/Install the "ACF PRO" recipe/);
    expect(() => w.core.licenses.setInput('nope', 'key', 'whatever-key')).toThrow(/No recipe/);
    w.core.licenses.deleteInput('breakdance', 'key');
    expect(w.core.licenses.valuesFor('breakdance').size).toBe(0);
  });

  it('says which recipes matter here: how many sites have the plugin, and whether the plugin catalog does', async () => {
    const w = await makeWorld();
    const now = Date.now();
    const site = (slug: string) =>
      w.db
        .insert(sites)
        .values({
          slug, serverId: 1, title: slug, domains: JSON.stringify([`${slug}.test`]), phpVersion: '8.3', status: 'running',
          dbName: slug, dbUser: slug, dbPassword: 'x', containerName: `wp-${slug}`, createdAt: now, updatedAt: now,
        })
        .returning()
        .get();
    for (const s of [site('one'), site('two')]) {
      w.db.insert(siteWpComponents).values({ siteId: s.id, kind: 'plugin', slug: 'breakdance', status: 'active', seenAt: now }).run();
    }
    // A theme of the same name is not the plugin.
    w.db.insert(siteWpComponents).values({ siteId: 1, kind: 'theme', slug: 'advanced-custom-fields-pro', status: 'inactive', seenAt: now }).run();
    // A zip counts by the folder inside it, not by its file name.
    const upload = (slug: string, folder: string) => {
      const zipPath = path.join(w.config.paths.plugins, `${slug}.zip`);
      fs.mkdirSync(w.config.paths.plugins, { recursive: true });
      fs.writeFileSync(zipPath, zipOf({ [`${folder}/plugin.php`]: '<?php' }));
      w.db.insert(plugins).values({ kind: 'zip', slug, name: slug, zipPath, createdAt: now }).run();
    };
    upload('acf-pro-6-3-2', 'advanced-custom-fields-pro');
    upload('breakdance', 'breakdance-builder-addons');

    const byId = new Map(w.core.licenses.list().map((r) => [r.id, r]));
    expect(byId.get('breakdance')).toMatchObject({ sites: 2, inPluginCatalog: false });
    expect(byId.get('acf-pro')).toMatchObject({ sites: 0, inPluginCatalog: true });
  });

  it('masks short secrets entirely', () => {
    expect(maskSecret('abc')).toBe('••••');
    expect(maskSecret('abcdefgh')).toBe('••••efgh');
  });

  it('reports site status from the inventory plus the last run', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    // Nothing run yet, inventory knows Breakdance: shown as unknown, installed.
    let items = w.core.licenses.siteStatus(site.id, new Map([['breakdance', 'active']]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ recipeId: 'breakdance', installed: true, ready: true, status: 'unknown' });
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }), ok(BREAKDANCE_OK), ok(''), ok(BREAKDANCE_STATUS));
    await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    // Removed from the site since: the last outcome still shows, marked not installed.
    items = w.core.licenses.siteStatus(site.id, new Map());
    expect(items[0]).toMatchObject({ installed: false, status: 'active' });
  });
});

describe('installing recipes', () => {
  it('knows a recipe without using it: nothing runs until it is installed and enabled', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.core.licenses.uninstall('breakdance');
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }));
    expect(await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog)).toEqual([]);
    // Uninstalling forgot the key too.
    expect(w.core.licenses.valuesFor('breakdance').size).toBe(0);
    const item = w.core.licenses.list().find((r) => r.id === 'breakdance')!;
    expect(item).toMatchObject({ installed: false, enabled: false });
    expect(item.inputs[0]).toMatchObject({ set: false, display: null });

    w.core.licenses.install('breakdance');
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    w.core.licenses.setEnabled('breakdance', false);
    w.docker.execQueue.push(pluginList({ name: 'breakdance' }));
    expect(await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog)).toEqual([]);
    expect(w.core.licenses.siteStatus(site.id, new Map([['breakdance', 'active']]))).toEqual([]);
  });

  it('takes a disabled recipe\'s constant out of the drop-in', async () => {
    const { w, site, server, hookLog } = await siteWorld();
    w.core.licenses.setInput('acf-pro', 'key', 'acfacfacfacf');
    const file = path.join(sitePaths(w.config, site.slug).muPlugins, LICENSES_MU_PLUGIN_FILE);
    w.docker.execQueue.push(pluginList({ name: 'advanced-custom-fields-pro' }), ok('OK: active'), ok(''), ok('OK: active'));
    await w.core.licenses.runHook(server, site, 'afterInstall', { url: 'http://x' }, hookLog);
    expect(fs.existsSync(file)).toBe(true);

    w.core.licenses.setEnabled('acf-pro', false);
    w.docker.execQueue.push(pluginList({ name: 'advanced-custom-fields-pro' }));
    expect(await w.core.licenses.runHook(server, site, 'verify', { url: 'http://x' }, hookLog)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('adds a local recipe, which shadows the catalog copy and survives a rebuild; uninstalling deletes it', async () => {
    const w = await makeWorld();
    const local = {
      type: 'plugin-recipe',
      typeVersion: 1,
      id: 'breakdance',
      name: 'Breakdance (ours)',
      plugin: 'breakdance',
      version: '1.1',
      inputs: [{ id: 'key', label: 'License key' }],
      hooks: { afterInstall: [{ run: 'wp', args: ['breakdance', 'license', '{{inputs.key}}'] }] },
    };
    const dto = w.core.licenses.addLocal(local);
    expect(dto).toMatchObject({ id: 'breakdance', name: 'Breakdance (ours)', source: 'local', installed: true, enabled: true, version: '1.1' });
    expect(dto.inputs).toEqual([expect.objectContaining({ id: 'key', secret: true, set: false })]);
    expect(dto.description).toBe('Activates the license on every new site.');
    expect(w.core.licenses.catalog.superseded).toContain('breakdance');

    w.core.catalogSync.rebuild();
    expect(w.core.licenses.catalog.byId('breakdance')?.name).toBe('Breakdance (ours)');
    expect(w.core.licenses.definition('breakdance').version).toBe('1.1');

    w.core.licenses.uninstall('breakdance');
    expect(w.core.licenses.catalog.byId('breakdance')?.name).toBe('Breakdance');
    expect(w.core.licenses.catalog.sourceOf('breakdance')).toBe('bundled');
  });

  it('refuses a second local recipe for a plugin another local recipe covers, and still replaces by id', async () => {
    const w = await makeWorld();
    const local = (id: string, name: string) => ({ type: 'plugin-recipe', typeVersion: 1, id, name, plugin: 'shared-plugin' });
    w.core.licenses.addLocal(local('ours-a', 'Ours A'));
    expect(() => w.core.licenses.addLocal(local('ours-b', 'Ours B'))).toThrow(
      'The local recipe "ours-a" already covers the plugin shared-plugin: uninstall it first, or use its id to replace it',
    );
    // Nothing half-installed behind the refusal.
    expect(w.db.select().from(installedRecipes).all().map((r) => r.recipeId)).not.toContain('ours-b');
    expect(w.core.licenses.addLocal(local('ours-a', 'Ours A, revised')).name).toBe('Ours A, revised');
  });

  it('rejects a local recipe that does not validate, with the reason', async () => {
    const w = await makeWorld();
    expect(() => w.core.licenses.addLocal({ type: 'plugin-recipe', typeVersion: 1, id: 'Bad Id', name: 'x', plugin: 'x' })).toThrow(/Not a valid recipe: id/);
    expect(() => w.core.licenses.addLocal('nope')).toThrow(/Not a valid recipe/);
    // The shape before inputs existed is refused outright, not half-understood.
    expect(() =>
      w.core.licenses.addLocal({ type: 'plugin-recipe', typeVersion: 1, id: 'old', name: 'Old', plugin: 'old', license: { constant: 'OLD_LICENSE' } }),
    ).toThrow(/Not a valid recipe: \(root\): Unrecognized key: "license"/);
    expect(() => w.core.licenses.setEnabled('nope', true)).toThrow(/not installed/);
    expect(() => w.core.licenses.uninstall('nope')).toThrow(/not installed/);
  });

  it('describes a recipe in plain words when it has no description', () => {
    const base = { type: 'plugin-recipe' as const, typeVersion: 1 as const, id: 'x', name: 'X', plugin: 'x' };
    const step = { run: 'wp' as const, args: ['x'], optional: false };
    const hooks = (h: Partial<Record<'afterInstall' | 'afterUrlChange' | 'beforeRemove' | 'verify', typeof step[]>>) => ({
      afterInstall: [], afterUrlChange: [], beforeRemove: [], verify: [], ...h,
    });
    const key = { id: 'key', label: 'License key', secret: true };
    expect(describeRecipe({ ...base, inputs: [key], hooks: hooks({ afterInstall: [step], afterUrlChange: [step], beforeRemove: [step] }) })).toBe(
      'Activates the license on every new site, again when a site moves to its own domain, releases it when a site is deleted.',
    );
    expect(describeRecipe({ ...base, inputs: [], hooks: hooks({ afterUrlChange: [step] }) })).toBe('Its steps when a site moves to its own domain.');
    expect(describeRecipe({ ...base, inputs: [], hooks: hooks({}) })).toBe('Does nothing on its own yet.');
    expect(describeRecipe({ ...base, inputs: [], description: 'Given.', hooks: hooks({}) })).toBe('Given.');
  });
});
