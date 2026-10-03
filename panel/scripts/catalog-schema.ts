/**
 * Print the plugin-recipe schema as JSON Schema (draft 2020-12), for the public catalog
 * repository to validate contributions with - the one place the format is defined is
 * shared/recipes.ts, and this keeps the copy there generated rather than hand-written.
 *
 *   npx tsx scripts/catalog-schema.ts > ../../wpl7-catalog/schema/plugin-recipe.v1.schema.json
 */
import { z } from 'zod';
import { pluginRecipe } from '../shared/recipes.js';

// `io: 'input'`: the schema describes what a contributor writes, where a field with a default
// may be left out - the output-side view would list every defaulted field as required.
const schema = z.toJSONSchema(pluginRecipe, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
delete schema.$schema;
process.stdout.write(
  JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://andyfo.github.io/wpl7-catalog/schema/plugin-recipe.v1.schema.json',
      title: 'WPL7 plugin recipe, version 1',
      ...schema,
    },
    null,
    2,
  ) + '\n',
);
