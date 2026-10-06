/**
 * Recipes: the bundled ACF PRO and Breakdance recipes in use, their license keys entered (stand-
 * ins, not real keys), and what the last run concluded on each site that has the plugin.
 */
import { installedRecipes, recipeInputs, siteLicenses } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';
import { SITES, siteDomains } from './data.js';
import { INVENTORY } from './plugins.js';
import { createdAt, siteIds } from './sites.js';

const RECIPES: Record<string, { plugin: string; key: string }> = {
  'acf-pro': { plugin: 'advanced-custom-fields-pro', key: 'b3JkZXJfaWQ9REVNTy1BQ0YtUFJPLUtFWQ' },
  breakdance: { plugin: 'breakdance', key: 'DEMO-BREAKDANCE-0000-0000-0000' },
};

export function seedRecipes(world: TestWorld): void {
  world.db.transaction((tx) => {
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      tx.insert(installedRecipes).values({ recipeId, source: 'catalog', enabled: 1, installedAt: ago(58 * DAY), updatedAt: ago(58 * DAY) }).run();
      tx.insert(recipeInputs).values({ recipeId, inputId: 'key', value: recipe.key, createdAt: ago(58 * DAY), updatedAt: ago(58 * DAY) }).run();
      for (const site of SITES) {
        if (!INVENTORY[site.slug]?.components.some((c) => c.slug === recipe.plugin)) continue;
        const url = `https://${siteDomains(site)[0]}`;
        tx.insert(siteLicenses)
          .values({ siteId: siteIds.get(site.slug)!, recipeId, status: 'active', message: `license active for ${url}`, url, checkedAt: Math.max(createdAt(site) + 2 * MINUTE, ago(9 * DAY + HOUR)) })
          .run();
      }
    }
  });
  world.core.catalogSync.rebuild();
}
