// @docs sites/overview
import type { SiteSummary } from '../../../shared/types';

/** Sites hosted elsewhere in a card of their own under the others, or every site in one list. */
export type SitesLayout = 'split' | 'single';

/** A layout this browser stored, read back: anything but `single` is the default. */
export function layoutFrom(stored: string | null): SitesLayout {
  return stored === 'single' ? 'single' : 'split';
}

/**
 * What the Sites list shows. The layout is a choice only while there are sites of both kinds.
 * An external site's server only keeps its backups: the server filter is for sites hosted here,
 * and one server's list holds none hosted elsewhere.
 */
export function sitesView<T extends Pick<SiteSummary, 'kind' | 'serverId'>>(all: T[], layout: SitesLayout, serverFilter: number | 'all') {
  const external = all.filter((s) => s.kind === 'external');
  const choice = external.length > 0 && external.length < all.length;
  const single = choice && layout === 'single';
  const main = all.filter((s) =>
    s.kind === 'external' ? single && serverFilter === 'all' : serverFilter === 'all' || s.serverId === serverFilter,
  );
  return {
    /** Whether the switch between the layouts shows. */
    choice,
    single,
    /** The first list. */
    main,
    /** Left out when it would say "No sites yet" above sites hosted elsewhere. */
    showMain: single || main.length > 0 || external.length === 0 || serverFilter !== 'all',
    /** The External card under it, when there is one. */
    externalCard: single ? [] : external,
  };
}
