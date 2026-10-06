// @docs reference/recipe-format
import { z } from 'zod';

/**
 * Plugin recipes: what the panel does for a plugin beyond installing it - supply and
 * activate its license, redo that when the site's URL changes, release the activation
 * when the site goes away, and check where things stand.
 *
 * Recipes are catalog entries (`type: plugin-recipe`), one JSON file per plugin under
 * `panel/catalog/recipes/`. The shape is deliberately declarative: a step is either a
 * wp-cli invocation or a PHP snippet run through `wp eval`, both executed inside the
 * site's own container as www-data - the same reach the panel already has, and no more.
 *
 * Adding a plugin means adding a file; the loader validates every file against this
 * schema at boot and skips (with a log line) anything it cannot understand, so a future
 * catalog can carry entry types this panel version does not know yet.
 */

/** A plugin directory name as `wp plugin list` reports it. */
export const wpPluginSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'not a plugin directory name');

/** Whether `source` compiles the way a step's `expect` is used. */
function isPattern(source: string): boolean {
  try {
    new RegExp(source, 'm');
    return true;
  } catch {
    return false;
  }
}

const stepBase = {
  /** Shown in the job log while the step runs; the command itself otherwise. */
  label: z.string().max(120).optional(),
  /**
   * A failing step normally fails the hook for that plugin; an optional step only warns.
   * For the nice-to-haves around the activation (a cache clear, an update to the current release).
   */
  optional: z.boolean().default(false),
  /**
   * Regular expression (JavaScript syntax, multiline) the step's stdout must match for it to
   * count as succeeded. Without it, exit code 0 is success - which for a vendor CLI that
   * exits 0 and prints "Activation: Inactive" is not enough. Compiled when the recipe loads,
   * so a broken pattern rejects the recipe instead of throwing mid-hook on a site.
   */
  expect: z.string().max(300).refine(isPattern, 'not a valid regular expression').optional(),
};

/**
 * `wp` steps take the arguments verbatim (no shell involved) with these placeholders:
 *   {{inputs.<id>}}  what the operator entered for one of the recipe's inputs
 *   {{plugin}}       the recipe's plugin slug
 *   {{url}}          the site's current URL;  {{oldUrl}} / {{newUrl}}  around a URL change
 * `php` steps get the same values as environment variables instead (WPL7_INPUT_<ID>,
 * WPL7_SITE_URL, WPL7_OLD_URL, WPL7_NEW_URL) - no string escaping into code that way. The
 * code runs through `wp eval`, so it is PHP without an opening tag; exit non-zero to fail.
 */
export const recipeStep = z.discriminatedUnion('run', [
  z.object({ run: z.literal('wp'), args: z.array(z.string().max(500)).min(1).max(30), ...stepBase }).strict(),
  z.object({ run: z.literal('php'), code: z.string().min(1).max(20_000), ...stepBase }).strict(),
]);
export type RecipeStep = z.infer<typeof recipeStep>;

/**
 * When the panel runs a recipe's steps:
 *   afterInstall    right after the site's plugins were installed (site creation), and on
 *                   "Activate" from the site page
 *   afterUrlChange  after WordPress was pointed at a new URL (go-live / domain change,
 *                   restore under another hostname, move to a server with another dev domain)
 *   beforeRemove    before a site is deleted - release the activation
 *   verify          after any of the above, and on "Check" from the site page; decides the
 *                   status the panel shows
 */
export const recipeHooks = ['afterInstall', 'afterUrlChange', 'beforeRemove', 'verify'] as const;
export type RecipeHook = (typeof recipeHooks)[number];

/** Placeholders the panel fills in itself; the recipe's own inputs are `{{inputs.<id>}}`. */
export const builtinPlaceholders = ['plugin', 'url', 'oldUrl', 'newUrl'] as const;

/** Every `{{…}}` in a `wp` step's argument. Global: use with `replace` and `matchAll` only. */
export const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** How steps and the API name an input: `{{inputs.<id>}}`, WPL7_INPUT_<ID>, `/inputs/<id>`. */
export const recipeInputId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'not an input id (lowercase letters, digits and _)');

/**
 * A value the operator enters once per recipe on the Recipes page - the license key, and
 * whatever the vendor pairs with it (WP Rocket wants the account email too) - for the
 * steps to use on every site. The page shows one field per input, in the recipe's order.
 */
export const recipeInput = z
  .object({
    /** Also what the stored value is filed under: keep it stable once published. */
    id: recipeInputId,
    /** The field's label on the Recipes page. */
    label: z.string().min(1).max(60),
    /** Where to find the value; shown in the empty field. */
    hint: z.string().max(300).optional(),
    /**
     * Secret values are write-only: masked while typed, shown by their last characters once
     * stored, never returned by the API, and redacted from job logs. An input is secret
     * unless the recipe says otherwise - which is for the likes of an account email.
     */
    secret: z.boolean().default(true),
    /**
     * PHP constant to define with the value. The panel writes it into a must-use plugin
     * every site loads before its regular plugins, which is where vendors that support
     * a wp-config constant (ACF PRO, WP Rocket, Gravity Forms…) look for it.
     */
    constant: z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/, 'not a PHP constant name').optional(),
  })
  .strict();
export type RecipeInput = z.infer<typeof recipeInput>;

const emptyHooks = { afterInstall: [], afterUrlChange: [], beforeRemove: [], verify: [] };

export const pluginRecipe = z
  .object({
    type: z.literal('plugin-recipe'),
    typeVersion: z.literal(1),
    /** Stable identity the stored license key is filed under; never changes once published. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'not a recipe id'),
    name: z.string().min(1).max(100),
    /** The plugin directory this recipe applies to when it is active on a site. */
    plugin: wpPluginSlugSchema,
    /** Shown to the operator; bump it when the recipe changes so the change is legible. */
    version: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,19}$/, 'not a version').optional(),
    /** One plain sentence on what the recipe does for the operator, no mechanics. */
    description: z.string().max(500).optional(),
    vendorUrl: z.url().optional(),
    /**
     * What the operator enters for the plugin, one field each: its license key, and
     * whatever else the vendor needs. The recipe runs once every input has a value. A
     * recipe without inputs only automates.
     */
    inputs: z.array(recipeInput).max(10).default([]),
    hooks: z
      .object({
        afterInstall: z.array(recipeStep).max(20).default([]),
        afterUrlChange: z.array(recipeStep).max(20).default([]),
        beforeRemove: z.array(recipeStep).max(20).default([]),
        verify: z.array(recipeStep).max(20).default([]),
      })
      .strict()
      .default(emptyHooks),
  })
  .strict()
  // What a JSON Schema cannot say, checked here so a mistake shows when the recipe is
  // loaded or published rather than on a customer's site: inputs are unique, and every
  // placeholder is one the panel can fill.
  .superRefine((recipe, ctx) => {
    const ids = new Set<string>();
    const constants = new Set<string>();
    recipe.inputs.forEach((input, i) => {
      if (ids.has(input.id)) ctx.addIssue({ code: 'custom', path: ['inputs', i, 'id'], message: `input "${input.id}" is declared twice` });
      if (input.constant && constants.has(input.constant)) {
        ctx.addIssue({ code: 'custom', path: ['inputs', i, 'constant'], message: `constant ${input.constant} is already defined by another input` });
      }
      ids.add(input.id);
      if (input.constant) constants.add(input.constant);
    });
    for (const hook of recipeHooks) {
      recipe.hooks[hook].forEach((step, s) => {
        if (step.run !== 'wp') return;
        step.args.forEach((arg, a) => {
          for (const [, name = ''] of arg.matchAll(PLACEHOLDER)) {
            if ((builtinPlaceholders as readonly string[]).includes(name)) continue;
            if (name.startsWith('inputs.') && ids.has(name.slice('inputs.'.length))) continue;
            ctx.addIssue({
              code: 'custom',
              path: ['hooks', hook, s, 'args', a],
              message: name.startsWith('inputs.')
                ? `{{${name}}} names an input the recipe does not declare`
                : `unknown placeholder {{${name}}} (the recipe's own values are {{inputs.<id>}})`,
            });
          }
        });
      });
    }
  });
export type PluginRecipe = z.infer<typeof pluginRecipe>;

/**
 * Every kind of entry a catalog file can hold. A file whose `type` is not listed here is
 * skipped by the loader rather than rejected: that is how a catalog published for a newer
 * panel stays loadable by an older one.
 */
export const catalogEntry = z.discriminatedUnion('type', [pluginRecipe]);
export type CatalogEntry = z.infer<typeof catalogEntry>;
export const knownCatalogTypes = ['plugin-recipe'] as const;

/**
 * The published catalog index (`v1/index.json` of the catalog repository). Entries are
 * validated one by one with `catalogEntry` - an entry of a type this version does not
 * know is counted, not rejected, so the index as a whole still loads.
 */
export const catalogIndex = z
  .object({
    format: z.literal('wpl7-catalog'),
    formatVersion: z.literal(1),
    generatedAt: z.string().max(40),
    source: z.string().max(300).optional(),
    commit: z.string().max(64).nullable().optional(),
    entries: z.array(z.unknown()).max(5000),
  })
  .loose();
export type CatalogIndex = z.infer<typeof catalogIndex>;

/** `index.json.sig`, published next to the index. */
export const catalogSignature = z
  .object({
    alg: z.literal('ed25519'),
    keyId: z.string().max(64),
    signature: z.string().min(1).max(200),
  })
  .loose();
