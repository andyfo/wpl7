import { getCollection } from 'astro:content';
import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';
import { isEdge } from './lib/since';

/** Folder names that autogenerate a sidebar subgroup, and the label the group should carry. */
const GROUP_LABELS: Record<string, string> = { 'api-reference': 'API reference' };

let sinceBySlug: Map<string, string> | undefined;

async function sinceMap(): Promise<Map<string, string>> {
  if (!sinceBySlug) {
    const docs = await getCollection('docs');
    sinceBySlug = new Map(docs.filter((d) => d.data.since).map((d) => [d.id === 'index' ? '' : d.id, d.data.since!]));
  }
  return sinceBySlug;
}

/** '/docs/sites/create/' -> 'sites/create'. */
function slugOf(href: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return href.replace(base, '').replace(/^\/|\/$/g, '');
}

function decorate(entries: StarlightRouteData['sidebar'], since: Map<string, string>): void {
  for (const entry of entries) {
    if (entry.type === 'group') {
      entry.label = GROUP_LABELS[entry.label] ?? entry.label;
      decorate(entry.entries, since);
    } else if (!entry.badge && isEdge(since.get(slugOf(entry.href)))) {
      entry.badge = { text: 'Edge', variant: 'note' };
    }
  }
}

/**
 * A page whose `since` is newer than the latest release documents something only the edge
 * channel has: it gets an Edge badge in the sidebar and a banner saying when it ships. The
 * release workflow republishes the site, and the badges fall away on their own.
 */
export const onRequest = defineRouteMiddleware(async (context) => {
  const route = context.locals.starlightRoute;
  decorate(route.sidebar, await sinceMap());
  const since = route.entry.data.since;
  if (isEdge(since) && !route.entry.data.banner) {
    const channels = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/panel/updating/#channels`;
    route.entry.data.banner = {
      content: `Available on the <a href="${channels}">edge channel</a>. Ships in ${since}.`,
    };
  }
});
