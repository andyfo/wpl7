import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { useMeta } from '../../api/hooks';
import { formatBytes } from '../../lib/format';
import { Button, Card, ConfirmDialog, ErrorNote, Field, Toggle, inputClass } from '../ui';
import { LocaleSelect } from '../LocaleSelect';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Why Start import is off in this version, whatever the site. */
const NOT_YET = 'Available in the next version';

/**
 * Step 2: what the old site reported, what stands in the way, and the choices - the new site's
 * name and PHP, and what of the old host to leave behind.
 */
export function ImportConfirm({ imp }: { imp: ImportDto }) {
  const meta = useMeta();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const report = imp.report!;
  const s = imp.suggestions!;
  const [title, setTitle] = useState(s.title);
  const [slug, setSlug] = useState(s.slug);
  const [serverId, setServerId] = useState<number | null>(null);
  const [phpVersion, setPhpVersion] = useState<string | null>(s.phpVersion);
  const [locale, setLocale] = useState(s.locale);
  const [constants, setConstants] = useState(() => new Set(imp.constants.filter((c) => c.ticked).map((c) => c.name)));
  const [plugins, setPlugins] = useState(() => new Set(s.deactivatePlugins));
  const [dropins, setDropins] = useState(() => new Set(s.removeDropins));
  const [muPlugins, setMuPlugins] = useState(() => new Set(s.removeMuPlugins));
  const [rewritePaths, setRewritePaths] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const remove = useMutation({
    mutationFn: () => api(`/api/imports/${imp.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void navigate('/sites/import');
    },
  });

  const servers = meta.data?.servers ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const effServerId = serverId ?? meta.data?.defaultServerId ?? 1;
  const blocking = imp.warnings.filter((w) => w.blocking);
  const others = imp.warnings.filter((w) => !w.blocking);
  const activePlugins = report.plugins.filter((p) => p.active);
  const reason = imp.blockedReason ?? (!SLUG_RE.test(slug) ? 'The site name is not valid.' : !title.trim() ? 'The site needs a title.' : NOT_YET);
  const oldPhp = /^(\d+\.\d+)/.exec(report.phpVersion)?.[1] ?? report.phpVersion;

  return (
    <div className="space-y-6">
      <Card title="The old site">
        <dl className="space-y-2 text-sm">
          <Fact label="Source" value={report.home} />
          <Fact label="WordPress" value={report.wpVersion} />
          <Fact label="PHP" value={report.phpVersion} />
          <Fact label="Table prefix" value={report.tablePrefix} />
          <Fact
            label="Files"
            value={`${report.files.count.toLocaleString('en-US')} · ${formatBytes(report.files.bytes)}${report.files.partial ? ' (estimate)' : ''}`}
          />
          <Fact label="Database" value={`${report.db.tables} tables · ${formatBytes(report.db.bytes)} · ${report.db.server}`} />
          <Fact label="Plugins" value={`${report.plugins.length}, ${activePlugins.length} active`} />
          <Fact
            label="Search engines"
            value={report.searchEnginesAllowed ? 'Allowed on the old site; discouraged here until you go live' : 'Discouraged'}
          />
        </dl>
      </Card>

      {imp.warnings.length > 0 && (
        <Card title="Before you import">
          <ul className="space-y-2 text-sm">
            {blocking.map((w) => (
              <li key={w.code} className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
                {w.message}
              </li>
            ))}
            {others.map((w) => (
              <li key={w.code} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                {w.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="The new site">
        <div className="space-y-4">
          <Field label="Site title">
            <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label="Site name (slug)"
            hint={SLUG_RE.test(slug) ? 'Used for the container, database and dev address.' : '3-32 characters: a-z, 0-9 and dashes, not at either end.'}
          >
            <input className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          {multiServer && (
            <Field label="Server">
              <select className={inputClass} value={effServerId} onChange={(e) => setServerId(Number(e.target.value))}>
                {servers.map((srv) => (
                  <option key={srv.id} value={srv.id} disabled={srv.status !== 'ok'}>
                    {srv.name}
                    {srv.status !== 'ok' ? ` (${srv.status})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="grid max-w-2xl grid-cols-2 gap-4">
            <Field label="PHP version" hint={`The old site runs PHP ${oldPhp}.`}>
              <select className={inputClass} value={phpVersion ?? ''} onChange={(e) => setPhpVersion(e.target.value)}>
                {(meta.data?.phpVersions ?? []).map((v) => (
                  <option key={v} value={v}>
                    PHP {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language">
              <LocaleSelect value={locale} onChange={setLocale} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="From the old host">
        <div className="space-y-6">
          <CheckList
            title="Settings to carry over"
            hint="From the old wp-config.php. Database settings, keys and paths are never carried."
            empty="The old wp-config.php has none that can be carried."
            items={imp.constants.map((c) => ({ id: c.name, label: <code>{c.name}</code>, sub: c.note ?? c.preview }))}
            checked={constants}
            onChange={setConstants}
          />
          <CheckList
            title="Plugins to deactivate"
            hint="Active plugins that need the old host. Deactivated, not deleted."
            empty="No active plugins."
            items={activePlugins.map((p) => ({ id: p.slug, label: p.name || p.slug, sub: p.slug }))}
            checked={plugins}
            onChange={setPlugins}
          />
          {report.dropins.length > 0 && (
            <CheckList
              title="Drop-ins to remove"
              hint="Files in wp-content that plug a cache or database layer of the old host in."
              items={report.dropins.map((d) => ({ id: d, label: <code>{d}</code> }))}
              checked={dropins}
              onChange={setDropins}
            />
          )}
          {report.muPlugins.length > 0 && (
            <CheckList
              title="Must-use plugins to remove"
              hint="Hosts install their own here."
              items={report.muPlugins.map((m) => ({ id: m.file, label: <code>{m.file}</code>, sub: m.name || undefined }))}
              checked={muPlugins}
              onChange={setMuPlugins}
            />
          )}
          <Toggle
            checked={rewritePaths}
            onChange={setRewritePaths}
            label={
              <span>
                Rewrite file paths
                <span className="block text-xs text-neutral-500">
                  Replaces <code>{report.abspath.replace(/\/$/, '')}</code> with <code>/var/www/html</code> in the database.
                </span>
              </span>
            }
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <span title={reason} className="inline-block">
          <Button disabled>Start import</Button>
        </span>
        <Button variant="secondary" onClick={() => setDeleting(true)}>
          Delete import
        </Button>
      </div>
      <p className={`text-sm ${blocking.length > 0 ? 'text-red-700' : 'text-neutral-500'}`}>{reason}</p>
      <ErrorNote error={remove.error} />
      {deleting && (
        <ConfirmDialog
          title="Delete import"
          message="The old site's plugin stops answering this import. Nothing was copied yet."
          confirmLabel="Delete import"
          onConfirm={() => remove.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
      <dd className="break-all font-medium">{value}</dd>
    </div>
  );
}

/** A titled list of checkboxes over a set of ids. */
function CheckList({
  title,
  hint,
  empty,
  items,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  empty?: string;
  items: { id: string; label: ReactNode; sub?: string }[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const toggle = (id: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };
  return (
    <div>
      <div className="text-sm font-medium">{title}</div>
      <div className="mb-2 text-xs text-neutral-500">{hint}</div>
      {items.length === 0 ? (
        <div className="text-sm text-neutral-500">{empty}</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <label key={item.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checked.has(item.id)}
                onChange={(e) => toggle(item.id, e.target.checked)}
              />
              <span>
                {item.label}
                {item.sub && <span className="block break-all text-xs text-neutral-500">{item.sub}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
