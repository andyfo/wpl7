import { describe, expect, it } from 'vitest';
import { layoutFrom, sitesView } from '../../web/src/pages/sitesLayout.js';

/** Sites hosted here on servers 1 and 2, and two hosted elsewhere (whose backups server 1 keeps). */
const hosted = [
  { slug: 'bakery', kind: 'hosted' as const, serverId: 1 },
  { slug: 'florist', kind: 'hosted' as const, serverId: 2 },
];
const external = [
  { slug: 'vet', kind: 'external' as const, serverId: 1 },
  { slug: 'gym', kind: 'external' as const, serverId: 1 },
];
const all = [hosted[0]!, external[0]!, hosted[1]!, external[1]!];
const slugs = (sites: { slug: string }[]) => sites.map((s) => s.slug);

describe('the Sites list layout', () => {
  it('splits by default: the sites hosted here, then those hosted elsewhere in a card of their own', () => {
    const view = sitesView(all, layoutFrom(null), 'all');
    expect(view).toMatchObject({ choice: true, single: false, showMain: true });
    expect(slugs(view.main)).toEqual(['bakery', 'florist']);
    expect(slugs(view.externalCard)).toEqual(['vet', 'gym']);
  });

  it('puts every site in one list, in the order they come, when the single list is chosen', () => {
    const view = sitesView(all, 'single', 'all');
    expect(view).toMatchObject({ choice: true, single: true, showMain: true });
    expect(slugs(view.main)).toEqual(['bakery', 'vet', 'florist', 'gym']);
    expect(view.externalCard).toEqual([]);
  });

  it('offers no choice with sites of one kind, whatever was chosen before', () => {
    const onlyHosted = sitesView(hosted, 'single', 'all');
    expect(onlyHosted).toMatchObject({ choice: false, single: false, showMain: true });
    expect(slugs(onlyHosted.main)).toEqual(['bakery', 'florist']);
    expect(onlyHosted.externalCard).toEqual([]);

    // No empty list above the External card.
    const onlyExternal = sitesView(external, 'single', 'all');
    expect(onlyExternal).toMatchObject({ choice: false, single: false, showMain: false });
    expect(slugs(onlyExternal.externalCard)).toEqual(['vet', 'gym']);
  });

  it('shows one server its own sites only: none hosted elsewhere in the single list', () => {
    const single = sitesView(all, 'single', 2);
    expect(slugs(single.main)).toEqual(['florist']);
    expect(single.externalCard).toEqual([]);
    // Split, the External card stays: the menu is for sites hosted here.
    const split = sitesView(all, 'split', 2);
    expect(slugs(split.main)).toEqual(['florist']);
    expect(slugs(split.externalCard)).toEqual(['vet', 'gym']);
    // A server without sites says so, in either layout.
    expect(sitesView(all, 'single', 3)).toMatchObject({ showMain: true, main: [] });
    expect(sitesView(all, 'split', 3)).toMatchObject({ showMain: true, main: [] });
  });

  it('reads anything stored but the single list as the default', () => {
    expect(layoutFrom('single')).toBe('single');
    for (const stored of [null, 'split', '', 'SINGLE', 'grid']) expect(layoutFrom(stored)).toBe('split');
  });
});
