// @docs plugins/recipes, reference/recipe-format
import fs from 'node:fs';
import path from 'node:path';
import { catalogEntry, knownCatalogTypes, type PluginRecipe } from '../../shared/recipes.js';
import type { Logger } from './index.js';

export type RecipeSource = 'local' | 'catalog' | 'bundled';

/**
 * The recipes this panel knows, from three layers:
 *
 *   1. the operator's own local recipes (services/licenses.ts), which win outright - a
 *      recipe someone wrote or forked here is theirs, and no fetch ever touches it;
 *   2. the public catalog's last verified copy (services/catalogSync.ts) - a corrected
 *      recipe published there must reach a panel without a release;
 *   3. the files bundled with this version (`panel/catalog/`, `/app/catalog` in the
 *      image), which are the floor: what a panel has offline, and what a fresh install
 *      has before its first fetch.
 *
 * Knowing a recipe is not using it: which of these run on sites is the operator's choice
 * (installed and enabled, see services/licenses.ts).
 *
 * Files are the unit of contribution - one plugin, one file - and the loader is lenient on
 * purpose: an entry that fails validation, or carries a type this version does not know,
 * is reported and skipped rather than taking the panel down. That is what lets a catalog
 * published for a newer panel still load in an older one.
 */
export class RecipeCatalog {
  private byIdMap = new Map<string, PluginRecipe>();
  private byPluginMap = new Map<string, PluginRecipe>();
  private sourceMap = new Map<string, RecipeSource>();
  /** What was left out, and why - shown in the log at every load. */
  skipped: { source: string; reason: string }[] = [];
  /** Recipes a higher layer took precedence over (bundled under catalog, catalog under local). */
  superseded: string[] = [];

  constructor(private readonly log: Logger) {}

  static fromDir(dir: string, log: Logger): RecipeCatalog {
    const catalog = new RecipeCatalog(log);
    catalog.load({ bundledDir: dir, remote: [], local: [] });
    return catalog;
  }

  /**
   * Replace everything, highest layer first: local, then the catalog's entries, then the
   * bundled files - so a lower copy of an id a higher layer carries is superseded rather
   * than duplicated.
   */
  load(input: { bundledDir: string; remote: unknown[]; local: unknown[] }): void {
    this.byIdMap = new Map();
    this.byPluginMap = new Map();
    this.sourceMap = new Map();
    this.skipped = [];
    this.superseded = [];
    const idOf = (raw: unknown): string =>
      typeof raw === 'object' && raw !== null && 'id' in raw ? String((raw as { id: unknown }).id) : '?';
    for (const raw of input.local) this.add(raw, `local recipe "${idOf(raw)}"`, 'local');
    for (const raw of input.remote) this.add(raw, `catalog entry "${idOf(raw)}"`, 'catalog');
    this.loadBundled(input.bundledDir);
    const c = this.counts();
    this.log.info(
      `Recipe catalog: ${this.byIdMap.size} plugin recipe(s) known (${c.catalog} from the catalog, ${c.bundled} bundled, ${c.local} local)` +
        (this.skipped.length ? `, ${this.skipped.length} skipped` : ''),
    );
  }

  private loadBundled(dir: string): void {
    if (!fs.existsSync(dir)) {
      this.log.warn(`Recipe catalog directory ${dir} does not exist; no bundled recipes loaded`);
      return;
    }
    for (const file of listJsonFiles(dir).sort()) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        this.skip(path.relative(dir, file), `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      this.add(raw, path.relative(dir, file), 'bundled');
    }
  }

  /** Validate and register one entry. Returns false (and records why) when it was skipped. */
  add(raw: unknown, source = 'inline', origin: RecipeSource = 'bundled'): boolean {
    const type = typeof raw === 'object' && raw !== null && 'type' in raw ? (raw as { type: unknown }).type : undefined;
    if (typeof type !== 'string' || !(knownCatalogTypes as readonly string[]).includes(type)) {
      this.skip(source, `entry type ${JSON.stringify(type ?? null)} is not known to this panel version`);
      return false;
    }
    const parsed = catalogEntry.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.skip(source, `${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`);
      return false;
    }
    const recipe = parsed.data;
    const clashId = this.byIdMap.get(recipe.id);
    const clashPlugin = this.byPluginMap.get(recipe.plugin);
    if (clashId || clashPlugin) {
      // A lower layer's copy of what a higher one already provided is the expected case, not
      // a problem: the catalog over the bundled files, a local fork over the catalog.
      const above = this.sourceMap.get((clashId ?? clashPlugin)!.id);
      if ((origin === 'bundled' && above !== 'bundled') || (origin === 'catalog' && above === 'local')) {
        this.superseded.push(recipe.id);
        return false;
      }
      this.skip(source, clashId ? `recipe id "${recipe.id}" is already taken` : `plugin "${recipe.plugin}" already has a recipe`);
      return false;
    }
    this.byIdMap.set(recipe.id, recipe);
    this.byPluginMap.set(recipe.plugin, recipe);
    this.sourceMap.set(recipe.id, origin);
    return true;
  }

  list(): PluginRecipe[] {
    return [...this.byIdMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  byId(id: string): PluginRecipe | null {
    return this.byIdMap.get(id) ?? null;
  }

  forPlugin(slug: string): PluginRecipe | null {
    return this.byPluginMap.get(slug) ?? null;
  }

  sourceOf(id: string): RecipeSource {
    return this.sourceMap.get(id) ?? 'bundled';
  }

  /** How many known recipes come from each layer. */
  counts(): { local: number; catalog: number; bundled: number } {
    const c = { local: 0, catalog: 0, bundled: 0 };
    for (const s of this.sourceMap.values()) c[s]++;
    return c;
  }

  private skip(source: string, reason: string): void {
    this.skipped.push({ source, reason });
    this.log.warn(`Recipe catalog: skipping ${source} - ${reason}`);
  }
}

function listJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}
