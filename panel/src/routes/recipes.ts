// @docs plugins/recipes
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { recipeInputId } from '../../shared/recipes.js';
import {
  licenseApplyBody,
  localRecipeBody,
  recipeEnabledBody,
  recipeIdSchema,
  recipeInputBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { jobToDto, seesCommands, viewerOf } from '../lib/dto.js';
import { withoutStepOutput } from '../services/licenses.js';
import { allows } from '../../shared/access.js';
import { notFound } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

const recipeParams = z.object({ id: recipeIdSchema });
const inputParams = z.object({ id: recipeIdSchema, input: recipeInputId });
const slugParams = z.object({ slug: siteSlugParam });

/**
 * Plugin recipes: the ones the panel knows (catalog, bundled, local), which of them the
 * operator installed and enabled, what was entered for their inputs, and the catalog they
 * come from. Secret inputs - license keys - are written, never read back: the list carries
 * a masked tail so a key can be recognised, and the sites are the only place the panel
 * ever hands the key to.
 */
export function registerRecipeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // The last four characters of a licence key are how the Recipes page tells keys apart - and
  // still four characters of a key, so below Full a secret input says only that it is set.
  r.get('/api/recipes', async (req) => {
    const items = deps.licenses.list();
    if (allows(viewerOf(req), 'full')) return { items };
    return {
      items: items.map((recipe) => ({
        ...recipe,
        inputs: recipe.inputs.map((input) => (input.secret ? { ...input, display: null } : input)),
      })),
    };
  });

  r.get('/api/recipes/:id/definition', { schema: { params: recipeParams } }, async (req) => ({
    recipe: deps.licenses.definition(req.params.id),
  }));

  r.post('/api/recipes/:id/install', { schema: { params: recipeParams } }, async (req) => ({
    recipe: deps.licenses.install(req.params.id),
  }));

  r.delete('/api/recipes/:id/install', { schema: { params: recipeParams } }, async (req, reply) => {
    deps.licenses.uninstall(req.params.id);
    return reply.status(204).send();
  });

  r.put('/api/recipes/:id/enabled', { schema: { params: recipeParams, body: recipeEnabledBody } }, async (req) => ({
    recipe: deps.licenses.setEnabled(req.params.id, req.body.enabled),
  }));

  /** A recipe of the operator's own; installed and enabled on arrival. `400` when it does not validate. */
  r.post('/api/recipes/local', { schema: { body: localRecipeBody } }, async (req, reply) =>
    reply.status(201).send({ recipe: deps.licenses.addLocal(req.body.recipe) }),
  );

  r.put('/api/recipes/:id/inputs/:input', { schema: { params: inputParams, body: recipeInputBody } }, async (req) => ({
    recipe: deps.licenses.setInput(req.params.id, req.params.input, req.body.value),
  }));

  r.delete('/api/recipes/:id/inputs/:input', { schema: { params: inputParams } }, async (req, reply) => {
    deps.licenses.deleteInput(req.params.id, req.params.input);
    return reply.status(204).send();
  });

  /** The public catalog as this panel sees it, and a fetch-now for after a recipe was published. */
  r.get('/api/catalog', async () => deps.catalogSync.state());

  r.post('/api/catalog/refresh', async () => {
    const outcome = await deps.catalogSync.refresh({ force: true });
    return { outcome, catalog: deps.catalogSync.state() };
  });

  /**
   * Where each active recipe stands on one site, from the inventory snapshot and the last
   * run - a database read, so it answers for a stopped site and costs nothing per page load.
   * A failure is told in what its step printed, which Read only is not shown.
   */
  r.get('/api/sites/:slug/wp/recipes', { schema: { params: slugParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    const installed = new Map<string, string>();
    for (const row of deps.wpInventory.componentsFor(site.id).values()) {
      if (row.kind === 'plugin') installed.set(row.slug, row.status);
    }
    const items = deps.licenses.siteStatus(site.id, installed);
    return { items: seesCommands(viewerOf(req)) ? items : items.map(withoutStepOutput) };
  });

  r.post(
    '/api/sites/:slug/wp/recipes/apply',
    { schema: { params: slugParams, body: licenseApplyBody } },
    async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      if (req.body.recipeId && !deps.licenses.catalog.byId(req.body.recipeId)) {
        throw notFound(`No recipe "${req.body.recipeId}" in the catalog`);
      }
      const job = deps.worker.enqueue(
        'wp.recipes',
        { siteId: site.id, hook: req.body.hook, recipeId: req.body.recipeId },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );
}
