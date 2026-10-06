import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

/**
 * Starlight's front matter plus ours. `description` is required here: it is the sentence a page
 * is found by, shown under the title, in link cards and in search results.
 */
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        description: z.string().min(20, 'Every page needs a one-sentence description.'),
        /** The first release with this feature. Newer than the latest release: an Edge badge. */
        since: z
          .string()
          .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, 'since: is a release number such as 0.4.0')
          .optional(),
        /** Repository globs this page documents. scripts/docs-map.ts reads them; see README.md. */
        sources: z.array(z.string()).optional(),
      }),
    }),
  }),
  // Starlight's interface strings, overridden in src/content/i18n/en.json.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
