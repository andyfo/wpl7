// @docs plugins/recipes, reference/recipe-format
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  catalogEntries,
  installedRecipes,
  plugins,
  recipeInputs,
  siteLicenses,
  siteWpComponents,
  type InstalledRecipeRow,
  type RecipeInputRow,
  type SiteLicenseRow,
  type SiteRow,
} from '../db/schema.js';
import type { Config } from '../config.js';
import type { ServerHandle } from '../servers/registry.js';
import type { RunResult } from './docker.js';
import { PLACEHOLDER, pluginRecipe, type PluginRecipe, type RecipeHook, type RecipeStep } from '../../shared/recipes.js';
import type { LicenseStatus, RecipeDto, SiteLicenseDto } from '../../shared/types.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { PanelFileLog } from './adminLogin.js';
import type { RecipeCatalog } from './catalog.js';
import { pluginDirOf } from './pluginCatalog.js';
import { runInventory } from './scanEngines.js';
import { siteImage, sitePaths } from './siteSpec.js';

/** Reading what a site has installed, for rewriting the drop-in without WordPress. */
const INVENTORY_TIMEOUT_MS = 2 * 60_000;

/** The drop-in that defines the recipes' constants; lives next to the one-click-login one. */
export const LICENSES_MU_PLUGIN_FILE = 'wpl7-licenses.php';
/** Where it is, relative to the site's WordPress folder: what a malware scan holds to it. */
export const LICENSES_MU_PLUGIN_PATH = `wp-content/mu-plugins/${LICENSES_MU_PLUGIN_FILE}`;

/** Values a hook run substitutes into steps. */
export interface HookVars {
  /** The site's current URL (home). */
  url: string;
  /** Around a URL change only. */
  oldUrl?: string;
  newUrl?: string;
}

export interface HookLog {
  info(msg: string): void;
  /**
   * `withoutOutput`: the same line without what a step printed, for a caller who may not read a
   * command's output (lib/dto.ts seesCommands). Given only where the line holds some.
   */
  warn(msg: string, withoutOutput?: string): void;
}

export interface RecipeOutcome {
  recipeId: string;
  name: string;
  status: LicenseStatus;
  message: string | null;
}

/** What stands in for a failed step's output where it is withheld. */
const OUTPUT_WITHHELD = 'what the step printed is not shown at Read only access';

/**
 * An outcome, or where a recipe stands on a site, for a caller who may not read a command's
 * output (lib/dto.ts seesCommands). A failure's message ends in what its step printed, and the
 * runner hides a key there only where the plugin repeats it exactly - not upper-cased, escaped
 * or cut short - so the message is left out. The other statuses' messages are the panel's own.
 */
export function withoutStepOutput<T extends { status: string; message: string | null }>(item: T): T {
  return item.status === 'failed' ? { ...item, message: OUTPUT_WITHHELD } : item;
}

interface StepResult {
  ok: boolean;
  /** Why it failed (redacted, trimmed) - empty on success. */
  detail: string;
}

/**
 * Plugin recipes in action: which recipes the operator installed and enabled, what was
 * entered for their inputs (license keys, mostly), the drop-in that hands constants to the
 * site, and the runner that executes a hook's steps and records what it concluded.
 *
 * Knowing a recipe (the catalog) and using it are two things. A recipe runs on sites only
 * once it is installed and enabled here. A catalog recipe is installed by reference and
 * follows the catalog's copy - a corrected recipe published there reaches this panel at
 * the next fetch, which is the point of the catalog. A local recipe is the operator's own
 * (written here, or a catalog recipe forked to change it) and is never touched by a fetch.
 *
 * Everything a recipe does happens inside the site's container through the existing
 * wp-cli path (docker exec as www-data): a step can do what a site administrator could,
 * and nothing on the host.
 */
export class LicenseService {
  /** Reloads the known recipes after a local one was added or removed; wired by the catalog sync. */
  reload: () => void = () => undefined;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    readonly catalog: RecipeCatalog,
    private readonly panelFiles?: PanelFileLog,
  ) {}

  // --- installed recipes ------------------------------------------------------

  private installRows(): Map<string, InstalledRecipeRow> {
    return new Map(this.db.select().from(installedRecipes).all().map((r) => [r.recipeId, r]));
  }

  /** The recipes that run on sites: installed and enabled. */
  activeRecipes(): PluginRecipe[] {
    const installs = this.installRows();
    return this.catalog.list().filter((r) => installs.get(r.id)?.enabled === 1);
  }

  /** Every recipe the panel knows, with whether and how it is in use. */
  list(): RecipeDto[] {
    const installs = this.installRows();
    const stored = this.storedInputs();
    const catalogChanges = new Map(
      this.db.select({ id: catalogEntries.id, changedAt: catalogEntries.changedAt }).from(catalogEntries).all().map((r) => [r.id, r.changedAt]),
    );
    // Which recipes matter here: the plugin is on sites already, or waiting in the plugin catalog.
    const sitesByPlugin = new Map(
      this.db
        .select({ slug: siteWpComponents.slug, sites: sql<number>`count(distinct ${siteWpComponents.siteId})` })
        .from(siteWpComponents)
        .where(eq(siteWpComponents.kind, 'plugin'))
        .groupBy(siteWpComponents.slug)
        .all()
        .map((r) => [r.slug, r.sites]),
    );
    const pluginCatalog = new Set(this.db.select().from(plugins).all().map(pluginDirOf));
    return this.catalog.list().map((recipe) => {
      const install = installs.get(recipe.id) ?? null;
      const values = install ? stored.get(recipe.id) : undefined;
      const source = this.catalog.sourceOf(recipe.id);
      return {
        id: recipe.id,
        name: recipe.name,
        plugin: recipe.plugin,
        version: recipe.version ?? null,
        description: describeRecipe(recipe),
        vendorUrl: recipe.vendorUrl ?? null,
        source,
        installed: install !== null,
        enabled: install?.enabled === 1,
        changedAt: source === 'local' ? (install?.updatedAt ?? null) : source === 'catalog' ? (catalogChanges.get(recipe.id) ?? null) : null,
        sites: sitesByPlugin.get(recipe.plugin) ?? 0,
        inPluginCatalog: pluginCatalog.has(recipe.plugin),
        inputs: recipe.inputs.map((input) => {
          const row = values?.get(input.id);
          return {
            id: input.id,
            label: input.label,
            hint: input.hint ?? null,
            secret: input.secret,
            constant: input.constant ?? null,
            set: !!row,
            display: row ? (input.secret ? maskSecret(row.value) : row.value) : null,
            updatedAt: row?.updatedAt ?? null,
          };
        }),
        hooks: {
          afterInstall: recipe.hooks.afterInstall.length,
          afterUrlChange: recipe.hooks.afterUrlChange.length,
          beforeRemove: recipe.hooks.beforeRemove.length,
          verify: recipe.hooks.verify.length,
        },
      };
    });
  }

  private dto(recipeId: string): RecipeDto {
    return this.list().find((l) => l.id === recipeId)!;
  }

  /** Take a catalog (or bundled) recipe into use, by reference. Enabled from the start. */
  install(recipeId: string): RecipeDto {
    this.requireRecipe(recipeId);
    const now = Date.now();
    this.db
      .insert(installedRecipes)
      .values({ recipeId, source: 'catalog', enabled: 1, payload: null, installedAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
    return this.dto(recipeId);
  }

  /** Stop using a recipe. What was entered for it goes with it; a local recipe is gone entirely. */
  uninstall(recipeId: string): void {
    const row = this.installRows().get(recipeId);
    if (!row) throw notFound(`Recipe "${recipeId}" is not installed`);
    this.db.delete(recipeInputs).where(eq(recipeInputs.recipeId, recipeId)).run();
    this.db.delete(installedRecipes).where(eq(installedRecipes.recipeId, recipeId)).run();
    if (row.source === 'local') this.reload();
  }

  setEnabled(recipeId: string, enabled: boolean): RecipeDto {
    if (!this.installRows().has(recipeId)) throw notFound(`Recipe "${recipeId}" is not installed`);
    this.db
      .update(installedRecipes)
      .set({ enabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(installedRecipes.recipeId, recipeId))
      .run();
    return this.dto(recipeId);
  }

  /**
   * Add (or replace) a recipe of the operator's own, in the catalog's format. It is
   * installed and enabled at once, and it shadows a catalog recipe of the same id - which
   * is how a catalog recipe is forked: copy its definition, change it, add it here.
   */
  addLocal(raw: unknown): RecipeDto {
    const parsed = pluginRecipe.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`Not a valid recipe: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`);
    }
    const recipe = parsed.data;
    // One recipe per plugin: a second local recipe for the same plugin would be stored, then
    // skipped at load - installed but invisible, and never run. Replacing by the same id is fine.
    const holder = this.catalog.forPlugin(recipe.plugin);
    if (holder && holder.id !== recipe.id && this.catalog.sourceOf(holder.id) === 'local') {
      throw badRequest(
        `The local recipe "${holder.id}" already covers the plugin ${recipe.plugin}: uninstall it first, or use its id to replace it`,
      );
    }
    const now = Date.now();
    const existing = this.installRows().get(recipe.id);
    this.db
      .insert(installedRecipes)
      .values({ recipeId: recipe.id, source: 'local', enabled: 1, payload: JSON.stringify(raw), installedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: installedRecipes.recipeId,
        set: { source: 'local', enabled: existing?.enabled ?? 1, payload: JSON.stringify(raw), updatedAt: now },
      })
      .run();
    this.reload();
    return this.dto(recipe.id);
  }

  /** The recipe as the panel has it - what to copy to make a local fork. */
  definition(recipeId: string): PluginRecipe {
    return this.requireRecipe(recipeId);
  }

  // --- inputs ---------------------------------------------------------------

  setInput(recipeId: string, inputId: string, value: string): RecipeDto {
    const recipe = this.requireRecipe(recipeId);
    if (!recipe.inputs.some((i) => i.id === inputId)) throw notFound(`The "${recipe.name}" recipe has no input "${inputId}"`);
    if (!this.installRows().has(recipeId)) throw badRequest(`Install the "${recipe.name}" recipe before entering its values`);
    const now = Date.now();
    this.db
      .insert(recipeInputs)
      .values({ recipeId, inputId, value, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [recipeInputs.recipeId, recipeInputs.inputId], set: { value, updatedAt: now } })
      .run();
    return this.dto(recipeId);
  }

  deleteInput(recipeId: string, inputId: string): void {
    this.requireRecipe(recipeId);
    this.db
      .delete(recipeInputs)
      .where(and(eq(recipeInputs.recipeId, recipeId), eq(recipeInputs.inputId, inputId)))
      .run();
  }

  /** What is stored for a recipe, by input id - including values of inputs it no longer declares. */
  valuesFor(recipeId: string): Map<string, string> {
    return new Map(
      this.db.select().from(recipeInputs).where(eq(recipeInputs.recipeId, recipeId)).all().map((r) => [r.inputId, r.value]),
    );
  }

  private storedInputs(): Map<string, Map<string, RecipeInputRow>> {
    const out = new Map<string, Map<string, RecipeInputRow>>();
    for (const row of this.db.select().from(recipeInputs).all()) {
      const forRecipe = out.get(row.recipeId) ?? new Map<string, RecipeInputRow>();
      forRecipe.set(row.inputId, row);
      out.set(row.recipeId, forRecipe);
    }
    return out;
  }

  private requireRecipe(recipeId: string): PluginRecipe {
    const recipe = this.catalog.byId(recipeId);
    if (!recipe) throw notFound(`No recipe "${recipeId}" in the catalog`);
    return recipe;
  }

  // --- per-site view ---------------------------------------------------------

  /**
   * The active recipes that matter for one site: those whose plugin the last inventory
   * snapshot lists, plus any the panel has run here before (a plugin since removed still
   * shows its last outcome, which is the honest thing to show).
   */
  siteStatus(siteId: number, installed: Map<string, string>): SiteLicenseDto[] {
    const rows = new Map(
      this.db.select().from(siteLicenses).where(eq(siteLicenses.siteId, siteId)).all().map((r) => [r.recipeId, r]),
    );
    const stored = this.storedInputs();
    const out: SiteLicenseDto[] = [];
    for (const recipe of this.activeRecipes()) {
      const pluginStatus = installed.get(recipe.plugin) ?? null;
      const row = rows.get(recipe.id) ?? null;
      if (pluginStatus === null && !row) continue;
      out.push(toSiteDto(recipe, pluginStatus, missingInputs(recipe, stored.get(recipe.id)).length === 0, row));
    }
    return out;
  }

  // --- running ---------------------------------------------------------------

  /**
   * Run one hook for every active recipe whose plugin is on the site (`only` narrows it to
   * one recipe). The container must be running. A recipe that fails is recorded and reported,
   * never thrown: the caller is a job in the middle of something bigger (creating the
   * site, taking it live) and a vendor's licensing server being down is a warning there.
   * What does throw is wp-cli itself being unusable, which the caller treats the same way.
   */
  async runHook(
    server: ServerHandle,
    site: SiteRow,
    hook: RecipeHook,
    vars: HookVars,
    log: HookLog,
    opts: { only?: string } = {},
  ): Promise<RecipeOutcome[]> {
    const installed = new Map((await server.wp.listPlugins(site.containerName)).map((p) => [p.name, p.status]));
    const applicable = this.activeRecipes().filter((r) => installed.has(r.plugin));

    // The drop-in is reconciled against everything on the site, whatever this run is for:
    // building it from one recipe would drop the constants of the others, and an empty set
    // is exactly how a key leaves a site once its plugin did - or once its recipe was
    // disabled or uninstalled here.
    await this.ensureDropIn(server, site, applicable, log);

    const targets = opts.only ? applicable.filter((r) => r.id === opts.only) : applicable;
    if (targets.length === 0) return [];

    const outcomes: RecipeOutcome[] = [];
    for (const recipe of targets) {
      outcomes.push(await this.runRecipe(server, site, recipe, installed.get(recipe.plugin) ?? '', hook, vars, log));
    }
    return outcomes;
  }

  private async runRecipe(
    server: ServerHandle,
    site: SiteRow,
    recipe: PluginRecipe,
    pluginStatus: string,
    hook: RecipeHook,
    vars: HookVars,
    log: HookLog,
  ): Promise<RecipeOutcome> {
    const values = this.valuesFor(recipe.id);
    const conclude = (status: LicenseStatus, message: string | null): RecipeOutcome => {
      this.record(site.id, recipe.id, status, message, status === 'active' ? vars.newUrl ?? vars.url : null);
      const line = `${recipe.name}: ${describe(status, message)}`;
      if (status === 'active' || status === 'released') log.info(line);
      else if (status === 'failed') log.warn(line, `${recipe.name}: ${describe(status, OUTPUT_WITHHELD)}`);
      else log.warn(line);
      return { recipeId: recipe.id, name: recipe.name, status, message };
    };

    const missing = missingInputs(recipe, values);
    if (missing.length > 0) {
      return conclude('not-set-up', `${listLabels(missing)} not entered yet (Plugins → Recipes)`);
    }
    if (!isActive(pluginStatus) && hook !== 'beforeRemove') {
      return conclude('inactive', `${recipe.plugin} is installed but not active, so its license was left alone`);
    }

    const failure = await this.runSteps(server, site, recipe, recipe.hooks[hook], values, vars, log);
    if (failure !== null) return conclude('failed', failure);

    if (hook === 'beforeRemove') return conclude('released', null);
    if (hook !== 'verify' && recipe.hooks.verify.length > 0) {
      const verifyFailure = await this.runSteps(server, site, recipe, recipe.hooks.verify, values, vars, log);
      if (verifyFailure !== null) return conclude('failed', `steps ran, but the check afterwards failed: ${verifyFailure}`);
    }
    return conclude('active', null);
  }

  /** Runs steps in order; the first non-optional failure ends the run. Null = all good. */
  private async runSteps(
    server: ServerHandle,
    site: SiteRow,
    recipe: PluginRecipe,
    steps: RecipeStep[],
    values: Map<string, string>,
    vars: HookVars,
    log: HookLog,
  ): Promise<string | null> {
    for (const step of steps) {
      const res = await this.runStep(server, site, recipe, step, values, vars, log);
      if (res.ok) continue;
      if (step.optional) {
        const failed = `${recipe.name}: ${step.label ?? 'optional step'} did not succeed`;
        log.warn(`${failed} (${res.detail}); continuing.`, `${failed}; continuing.`);
        continue;
      }
      return res.detail;
    }
    return null;
  }

  private async runStep(
    server: ServerHandle,
    site: SiteRow,
    recipe: PluginRecipe,
    step: RecipeStep,
    values: Map<string, string>,
    vars: HookVars,
    log: HookLog,
  ): Promise<StepResult> {
    // Longest first, so a secret that contains another is hidden whole.
    const secrets = recipe.inputs
      .filter((i) => i.secret)
      .map((i) => values.get(i.id) ?? '')
      .filter((v) => v !== '')
      .sort((a, b) => b.length - a.length);
    const redact = (text: string): string => secrets.reduce((t, secret) => t.split(secret).join('••••'), text);
    let args: string[];
    let env: string[] = [];
    try {
      if (step.run === 'wp') {
        args = step.args.map((a) => substitute(a, recipe, values, vars));
      } else {
        args = ['eval', step.code];
        env = phpEnv(recipe, values, vars);
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    log.info(`${recipe.name}: ${step.label ?? redact(`wp ${args.join(' ')}`)}…`);
    // A step that cannot finish (wp-cli timing out, the container going away) is that step
    // failing, not the whole hook: an optional one is skipped past, a required one fails
    // its recipe, and the other recipes still run.
    let res: RunResult;
    try {
      res = await server.wp.run(site.containerName, args, 180_000, env.length > 0 ? { env } : {});
    } catch (err) {
      return { ok: false, detail: redact(err instanceof Error ? err.message : String(err)) };
    }
    // Redacted before it is cut down: a key straddling the cut would otherwise survive in part.
    const tail = (s: string): string => redact(s).trim().split('\n').slice(-6).join(' ').slice(-500);
    if (res.exitCode !== 0) {
      return { ok: false, detail: tail(res.stderr || res.stdout) || `exit code ${res.exitCode}` };
    }
    if (step.expect && !new RegExp(step.expect, 'm').test(res.stdout)) {
      return { ok: false, detail: `output did not confirm success: ${tail(res.stdout) || '(empty)'}` };
    }
    return { ok: true, detail: '' };
  }

  /**
   * Keep the constants drop-in in step with the recipes that apply to this site: defined
   * for the plugins it has (with every input entered), absent otherwise. Only plugins
   * present on the site get their values - a key is readable by that site's administrators,
   * so a site without ACF PRO has no business holding the ACF PRO key.
   */
  private async ensureDropIn(server: ServerHandle, site: SiteRow, targets: PluginRecipe[], log: HookLog): Promise<void> {
    const defines: { constant: string; value: string }[] = [];
    for (const recipe of targets) {
      const values = this.valuesFor(recipe.id);
      if (missingInputs(recipe, values).length > 0) continue;
      for (const input of recipe.inputs) {
        if (input.constant) defines.push({ constant: input.constant, value: values.get(input.id)! });
      }
    }
    // Inside the site's container, like every write to a site's files (see adminLogin's
    // ensureMuPlugin for why not through the host's copy of it).
    if (defines.length === 0) {
      const done = await server.siteFiles.putDropIn(site.containerName, LICENSES_MU_PLUGIN_FILE, null);
      if (done === 'removed') log.info('Removed the license constants drop-in; no plugin on this site needs one.');
      return;
    }
    const content = renderDropIn(defines);
    const done = await server.siteFiles.putDropIn(site.containerName, LICENSES_MU_PLUGIN_FILE, content);
    if (done === 'written' || done === 'same') this.panelFiles?.wrote(site.id, LICENSES_MU_PLUGIN_PATH, content);
    if (done !== 'written') return;
    log.info(`Defined ${defines.map((d) => d.constant).join(', ')} for the site (${LICENSES_MU_PLUGIN_PATH}).`);
  }

  /**
   * The constants drop-in written again from the recipes that apply to the site now - how a
   * changed one is put back from the malware scan's findings. The container must be running.
   * Which plugins the site has is read from their files' headers, the way a scan reads them,
   * never through WordPress: every WP-CLI call loads the drop-in, and a broken one would stop
   * the very call that is to replace it.
   */
  async rewriteDropIn(server: ServerHandle, site: SiteRow, log: HookLog): Promise<void> {
    const inventory = await runInventory(server, siteImage(site.phpVersion), sitePaths(this.config, site.slug).wordpress, INVENTORY_TIMEOUT_MS);
    const installed = new Set(inventory.plugins.map((p) => p.slug));
    await this.ensureDropIn(server, site, this.activeRecipes().filter((r) => installed.has(r.plugin)), log);
  }

  private record(siteId: number, recipeId: string, status: LicenseStatus, message: string | null, url: string | null): void {
    const now = Date.now();
    this.db
      .insert(siteLicenses)
      .values({ siteId, recipeId, status, message, url, checkedAt: now })
      .onConflictDoUpdate({
        target: [siteLicenses.siteId, siteLicenses.recipeId],
        set: { status, message, url, checkedAt: now },
      })
      .run();
  }
}

// ---------------------------------------------------------------------------

const isActive = (status: string): boolean => status === 'active' || status === 'active-network';

/** The inputs of a recipe that nothing is entered for yet. */
function missingInputs(recipe: PluginRecipe, stored: ReadonlyMap<string, unknown> | undefined): PluginRecipe['inputs'] {
  return recipe.inputs.filter((i) => !stored?.has(i.id));
}

const listLabels = (inputs: PluginRecipe['inputs']): string => {
  const labels = inputs.map((i) => i.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : (labels[0] ?? '');
};

/** Placeholders are checked against the recipe when it loads (shared/recipes.ts); this fills them. */
function substitute(arg: string, recipe: PluginRecipe, values: Map<string, string>, vars: HookVars): string {
  return arg.replace(PLACEHOLDER, (_m, name: string) => {
    if (name.startsWith('inputs.')) {
      const value = values.get(name.slice('inputs.'.length));
      if (value === undefined) throw new Error(`the step needs {{${name}}} and nothing is entered for it`);
      return value;
    }
    switch (name) {
      case 'plugin':
        return recipe.plugin;
      case 'url':
        return vars.url;
      case 'oldUrl':
      case 'newUrl': {
        const v = vars[name];
        if (!v) throw new Error(`the step needs {{${name}}}, which only a URL change provides`);
        return v;
      }
      default:
        return _m;
    }
  });
}

function phpEnv(recipe: PluginRecipe, values: Map<string, string>, vars: HookVars): string[] {
  const env = [`WPL7_SITE_URL=${vars.url}`];
  for (const input of recipe.inputs) {
    const value = values.get(input.id);
    if (value !== undefined) env.push(`WPL7_INPUT_${input.id.toUpperCase()}=${value}`);
  }
  if (vars.oldUrl) env.push(`WPL7_OLD_URL=${vars.oldUrl}`);
  if (vars.newUrl) env.push(`WPL7_NEW_URL=${vars.newUrl}`);
  return env;
}

const phpString = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function renderDropIn(defines: { constant: string; value: string }[]): string {
  const lines = defines.map(
    (d) => `if (!defined(${phpString(d.constant)})) {\n    define(${phpString(d.constant)}, ${phpString(d.value)});\n}`,
  );
  return `<?php
/**
 * Plugin Name: WPL7 plugin licenses
 * Description: License constants for plugins the WPL7 control panel manages on this
 *              site. Managed file - the panel rewrites it; edits are lost.
 * Version: 1
 */

if (!defined('ABSPATH')) {
    exit;
}

${lines.join('\n')}
`;
}

/** Enough of a secret to recognise it on the Recipes page, and no more. */
export function maskSecret(secret: string): string {
  const shown = secret.length >= 8 ? secret.slice(-4) : '';
  return `${'•'.repeat(Math.max(4, Math.min(12, secret.length - shown.length)))}${shown}`;
}

function describe(status: LicenseStatus, message: string | null): string {
  switch (status) {
    case 'active':
      return 'license active';
    case 'released':
      return 'activation released';
    case 'failed':
      return `FAILED - ${message ?? 'unknown error'}`;
    default:
      return message ?? status;
  }
}

/** The recipe's own sentence, or one made from what its hooks do - never the mechanics. */
export function describeRecipe(recipe: PluginRecipe): string {
  if (recipe.description) return recipe.description;
  const what = recipe.inputs.length > 0 ? 'the license' : 'its steps';
  const parts: string[] = [];
  if (recipe.hooks.afterInstall.length > 0) parts.push(`activates ${what} on every new site`);
  if (recipe.hooks.afterUrlChange.length > 0) parts.push(`${parts.length ? 'again ' : `${what} `}when a site moves to its own domain`);
  if (recipe.hooks.beforeRemove.length > 0) parts.push(`releases ${recipe.inputs.length > 0 ? 'it' : 'them'} when a site is deleted`);
  if (parts.length === 0) return 'Does nothing on its own yet.';
  const sentence = parts.join(', ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function toSiteDto(recipe: PluginRecipe, pluginStatus: string | null, ready: boolean, row: SiteLicenseRow | null): SiteLicenseDto {
  return {
    recipeId: recipe.id,
    name: recipe.name,
    plugin: recipe.plugin,
    installed: pluginStatus !== null,
    pluginStatus,
    ready,
    status: (row?.status as LicenseStatus | undefined) ?? 'unknown',
    message: row?.message ?? null,
    url: row?.url ?? null,
    checkedAt: row?.checkedAt ?? null,
  };
}
