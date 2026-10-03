import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PluginDto, WporgPluginDto } from '../../../shared/types';
import { usePluginCatalog } from '../api/hooks';
import { api, ApiError } from '../api/client';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNote, inputClass, Toggle } from '../components/ui';
import { Icon } from '../components/Icon';
import { WporgPluginSearch } from '../components/WporgPluginSearch';
import { ZipCheckCell, ZipCheckDialog } from '../components/security/ZipCheck';
import { timeAgo } from '../lib/format';

/** The plugins every new site can start with: from wordpress.org or an uploaded zip. */
export function Plugins() {
  const catalog = usePluginCatalog();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [manualSlug, setManualSlug] = useState('');
  /** Set after the API reports the directory unreachable, to offer the unchecked add. */
  const [offerForce, setOfferForce] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [checkOf, setCheckOf] = useState<PluginDto | null>(null);
  // ?check=<id>: a site's finding linking to the review of the zip that flagged the same file.
  const [params, setParams] = useSearchParams();
  const linked = Number(params.get('check')) || null;
  const shownCheck = checkOf ?? (linked !== null ? ((catalog.data ?? []).find((p) => p.id === linked && p.kind === 'zip') ?? null) : null);
  const closeCheck = () => {
    setCheckOf(null);
    if (params.has('check')) {
      params.delete('check');
      setParams(params, { replace: true });
    }
  };
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['plugin-catalog'] });
  const wporgSlugs = (catalog.data ?? []).filter((p) => p.kind === 'wporg').map((p) => p.slug);

  const add = async (body: { slug: string; name?: string; force?: boolean }) => {
    setError(null);
    setAdding(body.slug);
    try {
      await api('/api/plugins', { method: 'POST', body: { kind: 'wporg', ...body } });
      setManualSlug('');
      setOfferForce(null);
      await refresh();
    } catch (err) {
      setError(err);
      // Only a directory we could not reach earns the "add it anyway" escape hatch;
      // a slug the directory positively does not have stays rejected.
      setOfferForce(err instanceof ApiError && err.code === 'bad_gateway' ? body.slug : null);
    } finally {
      setAdding(null);
    }
  };

  const upload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api('/api/plugins/upload', { method: 'POST', formData: fd });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Plugins</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Plugins available at site creation. Entries marked <b>default</b> are preselected in the wizard.
          </p>
        </div>
        <Link
          to="/plugins/recipes"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-900"
        >
          Recipes
          <Icon name="arrow" size={14} />
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Add from wordpress.org">
          <WporgPluginSearch
            onSelect={(p: WporgPluginDto) => void add({ slug: p.slug, name: p.name })}
            addedSlugs={wporgSlugs}
            addedLabel="in catalog"
            busySlug={adding}
            keepOpenOnSelect
          />
          <details className="mt-3 text-xs text-neutral-500">
            <summary className="cursor-pointer select-none">Know the slug? Add it directly</summary>
            <div className="mt-2 flex gap-2">
              <input
                className={`${inputClass} max-w-xs`}
                placeholder="wordpress-seo"
                value={manualSlug}
                onChange={(e) => {
                  setManualSlug(e.target.value);
                  setOfferForce(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && manualSlug.trim() && void add({ slug: manualSlug.trim() })}
              />
              <Button small disabled={!manualSlug.trim() || adding !== null} onClick={() => void add({ slug: manualSlug.trim() })}>
                Add
              </Button>
            </div>
            <p className="mt-2">The slug is checked against wordpress.org before it is saved.</p>
            {offerForce && (
              <div className="mt-2">
                <Button small variant="secondary" onClick={() => void add({ slug: offerForce, force: true })}>
                  Add “{offerForce}” without checking
                </Button>
              </div>
            )}
          </details>
        </Card>
        <Card title="Upload custom zip">
          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
          <Button variant="secondary" disabled={uploading} onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={16} /> {uploading ? 'Uploading…' : 'Choose zip'}
          </Button>
          <p className="mt-2 text-xs text-neutral-400">Max 100 MB.</p>
        </Card>
      </div>

      <ErrorNote error={error} />

      <Card title="Catalog">
        {(catalog.data ?? []).length === 0 ? (
          <EmptyState>Catalog is empty.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Plugin</th>
                <th className="pb-2">Source</th>
                <th className="pb-2">Malware check</th>
                <th className="pb-2">Default</th>
                <th className="pb-2 text-right">Added</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {(catalog.data ?? []).map((p) => (
                <tr key={p.id} className="border-t border-neutral-100">
                  <td className="py-2.5 pr-3 font-medium">{p.name}</td>
                  <td className="py-2.5 pr-3 text-neutral-500">{p.kind === 'zip' ? 'uploaded zip' : `wp.org/${p.slug}`}</td>
                  <td className="py-2.5 pr-3">
                    <ZipCheckCell plugin={p} onOpen={() => setCheckOf(p)} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Toggle
                      checked={p.isDefault}
                      onChange={(v) => {
                        setError(null);
                        void api(`/api/plugins/${p.id}`, { method: 'PUT', body: { isDefault: v } })
                          .then(refresh)
                          .catch(setError);
                      }}
                    />
                  </td>
                  <td className="py-2.5 pr-3 text-right text-xs text-neutral-500">{timeAgo(p.createdAt)}</td>
                  <td className="py-2.5 text-right">
                    <Button small variant="ghost" onClick={() => setDeleteId(p.id)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {shownCheck && <ZipCheckDialog plugin={(catalog.data ?? []).find((p) => p.id === shownCheck.id) ?? shownCheck} onClose={closeCheck} />}

      {deleteId !== null && (
        <ConfirmDialog
          title="Remove from catalog"
          message="Removes the catalog entry. Sites that already installed it keep it."
          confirmLabel="Remove"
          onConfirm={() => {
            setError(null);
            void api(`/api/plugins/${deleteId}`, { method: 'DELETE' }).then(refresh).catch(setError);
          }}
          onClose={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
