import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RecipeDto, RecipeInputDto } from '../../../shared/types';
import { useCatalogState, useRecipes } from '../api/hooks';
import { api } from '../api/client';
import { Button, Card, ConfirmDialog, ErrorNote, inputClass, Modal, Toggle } from '../components/ui';
import { timeAgo } from '../lib/format';

const CATALOG_FORMAT_URL = 'https://github.com/andyfo/wpl7-catalog#what-a-recipe-is';
/** Catalog recipes shown before "Show all": enough to browse, few enough to keep the page short. */
const PREVIEW = 6;

/** Relevance first - the plugin is on sites, or waiting in the plugin catalog - then by name. */
const byRelevance = (a: RecipeDto, b: RecipeDto): number =>
  b.sites - a.sites || Number(b.inPluginCatalog) - Number(a.inPluginCatalog) || a.name.localeCompare(b.name);
const isRelevant = (r: RecipeDto): boolean => r.sites > 0 || r.inPluginCatalog;

/**
 * What is installed comes first - it is what runs on sites and what may still be waiting for
 * a key - then the catalog, where recipes for plugins this panel already uses sort to the
 * top. A local recipe is the rare case, so it gets a dialog.
 */
export function Recipes() {
  const recipes = useRecipes();
  const qc = useQueryClient();
  const [addingLocal, setAddingLocal] = useState(false);
  const [justInstalled, setJustInstalled] = useState<string | null>(null);
  const items = recipes.data ?? [];
  const installed = items.filter((r) => r.installed);

  const refresh = () => qc.invalidateQueries({ queryKey: ['recipes'] });
  const installedNow = async (id: string) => {
    await refresh();
    setJustInstalled(id);
  };

  // After an install, the next step is the recipe's key: bring it into view, cursor in the field.
  useEffect(() => {
    if (!justInstalled) return;
    const el = document.querySelector<HTMLElement>(`[data-recipe="${justInstalled}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.querySelector('input')?.focus({ preventScroll: true });
    const t = setTimeout(() => setJustInstalled(null), 2500);
    return () => clearTimeout(t);
  }, [justInstalled, installed.length]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="page-title">Recipes</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Recipes automate what a plugin needs beyond being installed. The panel runs them on every site with that plugin
            when the site is created, when its domain changes and before it is deleted — to activate a license, update stored
            URLs or clear a cache.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setAddingLocal(true)}>
          Add local recipe
        </Button>
      </div>
      {installed.length > 0 && <InstalledCard items={installed} highlight={justInstalled} onChanged={refresh} />}
      <CatalogCard
        items={items.filter((r) => !r.installed)}
        loading={recipes.isLoading}
        onInstalled={installedNow}
        onChanged={refresh}
        onAddLocal={() => setAddingLocal(true)}
      />
      {addingLocal && <LocalRecipeDialog onClose={() => setAddingLocal(false)} onAdded={installedNow} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RecipeName({ recipe }: { recipe: RecipeDto }) {
  return (
    <span className="font-medium text-neutral-900">
      {recipe.vendorUrl ? (
        <a href={recipe.vendorUrl} target="_blank" rel="noreferrer" className="hover:underline">
          {recipe.name}
        </a>
      ) : (
        recipe.name
      )}
    </span>
  );
}

/** The line under the name: which plugin, which version, and how much this panel uses it. */
function RecipeMeta({ recipe, updated = false }: { recipe: RecipeDto; updated?: boolean }) {
  const parts: ReactNode[] = [<code key="plugin">{recipe.plugin}</code>];
  if (recipe.version) parts.push(`v${recipe.version}`);
  // Catalog and bundled copies behave the same for the operator; a local one is theirs and frozen.
  if (recipe.source === 'local') parts.push('local');
  if (recipe.sites > 0) {
    parts.push(
      <span key="sites" className="font-medium text-emerald-700">
        on {recipe.sites} {recipe.sites === 1 ? 'site' : 'sites'}
      </span>,
    );
  } else if (recipe.inPluginCatalog && !recipe.installed) {
    parts.push(
      <span key="catalog" className="font-medium text-emerald-700">
        in your plugin catalog
      </span>,
    );
  }
  if (updated && recipe.changedAt) parts.push(`updated ${timeAgo(recipe.changedAt)}`);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-neutral-500">
      {parts.map((part, i) => (
        <span key={i} className="contents">
          {i > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}

// --- installed ---------------------------------------------------------------

function InstalledCard({ items, highlight, onChanged }: { items: RecipeDto[]; highlight: string | null; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<RecipeDto | null>(null);
  const changed = async () => {
    setError(null);
    await onChanged();
  };

  return (
    <Card
      title={
        <>
          Installed recipes <span className="ml-1 font-normal text-neutral-400">{items.length}</span>
        </>
      }
    >
      {error !== null && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="space-y-3">
        {items.map((r) => (
          <InstalledRecipe
            key={r.id}
            recipe={r}
            highlight={highlight === r.id}
            onChanged={changed}
            onError={setError}
            onUninstall={() => setConfirm(r)}
          />
        ))}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Uninstall ${confirm.name}`}
          message={
            confirm.source === 'local'
              ? `Stops running it on sites${confirm.inputs.length ? ', forgets what you entered for it,' : ''} and deletes the recipe itself — copy it first if you want to keep it.`
              : `Stops running it on sites${confirm.inputs.length ? ' and forgets what you entered for it' : ''}. What it already activated stays activated.`
          }
          confirmLabel="Uninstall"
          onConfirm={() => {
            void api(`/api/recipes/${confirm.id}/install`, { method: 'DELETE' }).then(changed).catch(setError);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}

function InstalledRecipe({
  recipe,
  highlight,
  onChanged,
  onError,
  onUninstall,
}: {
  recipe: RecipeDto;
  highlight: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onUninstall: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);
  const missing = recipe.inputs.filter((i) => !i.set).length;

  const setEnabled = async (enabled: boolean) => {
    setToggling(true);
    try {
      await api(`/api/recipes/${recipe.id}/enabled`, { method: 'PUT', body: { enabled } });
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setToggling(false);
    }
  };

  const copy = async () => {
    try {
      const { recipe: def } = await api<{ recipe: unknown }>(`/api/recipes/${recipe.id}/definition`);
      await navigator.clipboard.writeText(JSON.stringify(def, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div
      data-recipe={recipe.id}
      className={`rounded-lg border p-4 transition-shadow ${highlight ? 'border-transparent ring-2 ring-(--accent)' : 'border-neutral-200'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className={`min-w-0 ${recipe.enabled ? '' : 'opacity-60'}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <RecipeName recipe={recipe} />
            {recipe.enabled && missing > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                Not set up
              </span>
            )}
          </div>
          <RecipeMeta recipe={recipe} updated />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Toggle checked={recipe.enabled} busy={toggling} onChange={(v) => void setEnabled(v)} label={recipe.enabled ? 'Enabled' : 'Disabled'} />
          <span className="ml-2 flex items-center">
            <Button small variant="ghost" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy JSON'}
            </Button>
            <Button small variant="ghost" onClick={onUninstall}>
              Uninstall
            </Button>
          </span>
        </div>
      </div>
      <p className={`mt-2 text-sm text-neutral-600 ${recipe.enabled ? '' : 'opacity-60'}`}>{recipe.description}</p>
      {recipe.inputs.length > 0 && (
        <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          {recipe.inputs.map((input) => (
            <InputField key={input.id} recipeId={recipe.id} input={input} onChanged={onChanged} onError={onError} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the recipe's inputs: a field while empty or being changed, the stored value (masked when secret) otherwise. */
function InputField({
  recipeId,
  input,
  onChanged,
  onError,
}: {
  recipeId: string;
  input: RecipeInputDto;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const showInput = !input.set || editing;
  const path = `/api/recipes/${recipeId}/inputs/${input.id}`;

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setValue('');
      setEditing(false);
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  const save = () => call(() => api(path, { method: 'PUT', body: { value: value.trim() } }));
  const remove = () => call(() => api(path, { method: 'DELETE' }));
  // A value that is not secret is shown in full, so changing it starts from it.
  const change = () => {
    setValue(input.secret ? '' : (input.display ?? ''));
    setEditing(true);
  };

  return (
    <>
      <span className="text-xs uppercase tracking-wide text-neutral-400">{input.label}</span>
      {/* The field shrinks before its buttons wrap under it. */}
      <div className={`flex items-center gap-2 ${showInput ? '' : 'flex-wrap'}`}>
        {showInput ? (
          <>
            {/* Right padding keeps a long hint clear of a password manager's field icon. */}
            <input
              className={`${inputClass} min-w-0 max-w-xl pr-9 text-ellipsis`}
              type={input.secret ? 'password' : 'text'}
              autoComplete="off"
              aria-label={input.label}
              placeholder={input.hint ?? input.label}
              title={input.hint ?? undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && value.trim() && !busy && void save()}
            />
            <Button small disabled={!value.trim() || busy} onClick={() => void save()}>
              Save
            </Button>
            {input.set && (
              <Button small variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            <code className="text-xs">{input.display}</code>
            <span className="text-xs text-neutral-400">set {timeAgo(input.updatedAt)}</span>
            <Button small variant="ghost" onClick={change}>
              Change
            </Button>
            <Button small variant="ghost" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </>
        )}
      </div>
    </>
  );
}

// --- catalog -----------------------------------------------------------------

function CatalogCard({
  items,
  loading,
  onInstalled,
  onChanged,
  onAddLocal,
}: {
  items: RecipeDto[];
  loading: boolean;
  onInstalled: (id: string) => Promise<void>;
  onChanged: () => Promise<void>;
  onAddLocal: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const ranked = [...items].sort(byRelevance);
  const matches = q ? ranked.filter((r) => [r.name, r.plugin, r.id, r.description].some((s) => s.toLowerCase().includes(q))) : ranked;
  // Every relevant recipe, and at least a preview's worth; an even count keeps the last row full.
  const relevant = ranked.filter(isRelevant).length;
  const preview = Math.max(PREVIEW, relevant + (relevant % 2));
  const shown = q || showAll ? matches : matches.slice(0, preview);

  const install = async (id: string) => {
    setError(null);
    setBusy(id);
    try {
      await api(`/api/recipes/${id}/install`, { method: 'POST' });
      await onInstalled(id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Recipe catalog" action={<CatalogLine onChanged={onChanged} onError={setError} />}>
      {error !== null && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">{loading ? 'Loading…' : 'Every recipe in the catalog is installed.'}</p>
      ) : (
        <div className="space-y-3">
          <input
            type="search"
            className={`${inputClass} max-w-md`}
            placeholder={`Search ${items.length} ${items.length === 1 ? 'recipe' : 'recipes'} by plugin…`}
            aria-label="Search the recipe catalog"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No recipe for “{query.trim()}” yet.{' '}
              <button type="button" className="underline hover:text-neutral-800" onClick={onAddLocal}>
                Write your own
              </button>
              .
            </p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {shown.map((r) => (
                <div key={r.id} className="rounded-lg border border-neutral-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <RecipeName recipe={r} />
                      <RecipeMeta recipe={r} />
                    </div>
                    <Button small variant="secondary" disabled={busy !== null} onClick={() => void install(r.id)}>
                      {busy === r.id ? 'Installing…' : 'Install'}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-sm text-neutral-600">{r.description}</p>
                </div>
              ))}
            </div>
          )}
          {!q && matches.length > preview && (
            <div className="flex justify-center">
              <Button small variant="ghost" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show fewer' : `Show all ${matches.length} recipes`}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** The catalog card's header: is the catalog fresh, and a fetch-now for right after a publish. */
function CatalogLine({ onChanged, onError }: { onChanged: () => Promise<void>; onError: (e: unknown) => void }) {
  const state = useCatalogState();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const c = state.data;
  if (!c) return null;

  const fetchNow = async () => {
    setBusy(true);
    try {
      await api('/api/catalog/refresh', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (c.url === null) return <span className="text-xs text-neutral-500">Fetching is off; bundled recipes only</span>;
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <span title={c.error ? `Last fetch failed: ${c.error}` : undefined} className={c.error ? 'text-amber-700' : ''}>
        {c.error ? 'Last fetch failed' : c.fetchedAt ? `Fetched ${timeAgo(c.fetchedAt)}` : 'Not fetched yet'}
        {c.unsupported > 0 && ` · ${c.unsupported} need a newer panel`}
      </span>
      <Button small variant="ghost" disabled={busy} onClick={() => void fetchNow()}>
        {busy ? 'Fetching…' : 'Fetch now'}
      </Button>
    </div>
  );
}

// --- local -------------------------------------------------------------------

function LocalRecipeDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const add = async () => {
    let recipe: unknown;
    try {
      recipe = JSON.parse(text);
    } catch {
      setError(new Error('That is not valid JSON.'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ recipe: RecipeDto }>('/api/recipes/local', { method: 'POST', body: { recipe } });
      onClose();
      await onAdded(res.recipe.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a local recipe" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-neutral-600">
          A recipe of your own, in the catalog’s{' '}
          <a href={CATALOG_FORMAT_URL} target="_blank" rel="noreferrer" className="underline">
            format
          </a>
          . It is installed at once and never changes with the catalog; one with the id of a catalog recipe replaces it. To start
          from an installed recipe, use its Copy JSON.
        </p>
        <textarea
          className={`${inputClass} h-72 font-mono text-xs`}
          placeholder='{ "type": "plugin-recipe", "typeVersion": 1, "id": "…", … }'
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoFocus
        />
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!text.trim() || busy} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add recipe'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
