import { useEffect, useId, useRef, useState } from 'react';
import type { WporgPluginDto } from '../../../shared/types';
import { useWporgSearch } from '../api/hooks';
import { ErrorNote, inputClass, Spinner } from './ui';

/** Directory counts are rounded buckets ("4000000" means "4+ million"). */
function installCount(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+ installs`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k+ installs`;
  if (n > 0) return `${n}+ installs`;
  return 'new';
}

function Stars({ rating }: { rating: number }) {
  const outOfFive = Math.round((rating / 100) * 5);
  if (!rating) return null;
  return (
    <span className="text-amber-500" title={`${(rating / 20).toFixed(1)} out of 5`}>
      {'★'.repeat(outOfFive)}
      <span className="text-neutral-300">{'★'.repeat(5 - outOfFive)}</span>
    </span>
  );
}

/**
 * Typeahead over the wordpress.org plugin directory. Every selection is a real directory
 * entry, which is the point: slugs typed from memory are how a catalog ends up with
 * plugins that no site can ever install.
 */
export function WporgPluginSearch({
  onSelect,
  placeholder = 'Search wordpress.org — try “seo”, “backup”, “woocommerce”…',
  /** Slugs already chosen; shown as "added" and not selectable. */
  addedSlugs = [],
  addedLabel = 'added',
  busySlug = null,
  /** Keep the results up after a pick, for surfaces where several plugins get added in a row. */
  keepOpenOnSelect = false,
  autoFocus = false,
}: {
  onSelect: (plugin: WporgPluginDto) => void;
  placeholder?: string;
  addedSlugs?: string[];
  addedLabel?: string;
  busySlug?: string | null;
  keepOpenOnSelect?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const search = useWporgSearch(query);
  const results = search.data?.items ?? [];
  const added = new Set(addedSlugs);

  // Clicking anywhere else closes the dropdown; without this it hangs over the page.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  const choose = (plugin: WporgPluginDto) => {
    if (added.has(plugin.slug) || busySlug !== null) return;
    onSelect(plugin);
    if (keepOpenOnSelect) return;
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (results.length === 0) return;
      setCursor((c) => (e.key === 'ArrowDown' ? (c + 1) % results.length : (c - 1 + results.length) % results.length));
      return;
    }
    if (e.key === 'Enter' && open && results[cursor]) {
      e.preventDefault();
      choose(results[cursor]);
    }
  };

  const tooShort = query.trim().length > 0 && query.trim().length < 2;
  const showDropdown = open && query.trim().length >= 2;

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <input
          className={`${inputClass} max-w-xl`}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {search.isFetching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            <Spinner />
          </span>
        )}
      </div>
      {tooShort && <p className="mt-1 text-xs text-neutral-400">Keep typing — at least 2 characters.</p>}

      {showDropdown && (
        <div
          id={listId}
          role="listbox"
          className="mt-1 max-h-96 overflow-y-auto rounded-lg border border-neutral-200 bg-surface shadow-sm"
        >
          {search.isError ? (
            <div className="p-3">
              <ErrorNote error={search.error} />
            </div>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-sm text-neutral-500">
              {search.isPending ? 'Searching wordpress.org…' : `No plugins on wordpress.org match “${query.trim()}”.`}
            </p>
          ) : (
            results.map((p, i) => {
              const isAdded = added.has(p.slug);
              return (
                <button
                  key={p.slug}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  disabled={isAdded}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(p)}
                  className={`flex w-full gap-3 border-b border-neutral-100 px-3 py-2.5 text-left last:border-b-0 ${
                    isAdded ? 'cursor-not-allowed opacity-60' : i === cursor ? 'bg-neutral-50' : ''
                  }`}
                >
                  {p.icon ? (
                    <img src={p.icon} alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded" loading="lazy" />
                  ) : (
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-neutral-100 text-xs font-semibold text-neutral-500">
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-neutral-900">{p.name}</span>
                      {isAdded && <span className="shrink-0 text-xs text-emerald-600">{addedLabel}</span>}
                      {busySlug === p.slug && <span className="shrink-0 text-xs text-neutral-400">adding…</span>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-neutral-500">{p.shortDescription}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-400">
                      <code className="text-neutral-500">{p.slug}</code>
                      <Stars rating={p.rating} />
                      <span>{installCount(p.activeInstalls)}</span>
                      {p.testedUpTo && <span>tested to WP {p.testedUpTo}</span>}
                      {p.author && <span className="truncate">by {p.author}</span>}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
