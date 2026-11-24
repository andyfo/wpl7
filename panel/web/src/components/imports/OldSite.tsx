// @docs sites/import, sites/duplicator
import type { ReactNode } from 'react';
import type { ImportConstantDto, ImportSuggestionsDto, ImportWarning, PackageSourceDto } from '../../../../shared/types';
import { formatBytes } from '../../lib/format';
import { Toggle } from '../ui';

/**
 * The old site, as an import's Confirm step and New site's Duplicator package show it: what it
 * is, what stands in the way, and what of the old host to leave behind.
 */

/** What of the old host stays behind: the choices both send. */
export interface LeaveBehindChoices {
  constants: Set<string>;
  plugins: Set<string>;
  dropins: Set<string>;
  muPlugins: Set<string>;
  rewritePaths: boolean;
}

/** The choices the suggestions start with. */
export function suggestedChoices(suggestions: ImportSuggestionsDto | null, constants: ImportConstantDto[]): LeaveBehindChoices {
  return {
    constants: new Set(constants.filter((c) => c.ticked).map((c) => c.name)),
    plugins: new Set(suggestions?.deactivatePlugins ?? []),
    dropins: new Set(suggestions?.removeDropins ?? []),
    muPlugins: new Set(suggestions?.removeMuPlugins ?? []),
    rewritePaths: true,
  };
}

/** The choices as the API takes them. */
export function choicesBody(c: LeaveBehindChoices) {
  return {
    carryConstants: [...c.constants],
    deactivatePlugins: [...c.plugins],
    removeDropins: [...c.dropins],
    removeMuPlugins: [...c.muPlugins],
    rewritePaths: c.rewritePaths,
  };
}

/** The old site's facts. `rows` come first; the language and search engines only where the source says. */
export function OldSiteFacts({ report, rows = [], language, searchEnginesAllowed }: {
  report: PackageSourceDto;
  rows?: [string, string][];
  /** Its name, when the source says which it is. */
  language?: string;
  /** The old site's setting, when the source says it. */
  searchEnginesAllowed?: boolean;
}) {
  const active = report.plugins.filter((p) => p.active);
  return (
    <dl className="space-y-2 text-sm">
      {rows.map(([label, value]) => (
        <Fact key={label} label={label} value={value} />
      ))}
      <Fact label="Source" value={report.home} />
      <Fact label="WordPress" value={report.wpVersion} />
      <Fact label="PHP" value={report.phpVersion} />
      <Fact label="Table prefix" value={report.tablePrefix} />
      {language !== undefined && <Fact label="Language" value={language} />}
      <Fact
        label="Files"
        value={`${report.files.count.toLocaleString('en-US')} · ${formatBytes(report.files.bytes)}${report.files.partial ? ' (estimate)' : ''}`}
      />
      <Fact label="Database" value={`${report.db.tables} tables · ${formatBytes(report.db.bytes)} · ${report.db.server}`} />
      <Fact label="Plugins" value={`${report.plugins.length}, ${active.length} active`} />
      {searchEnginesAllowed !== undefined && (
        <Fact label="Search engines" value={searchEnginesAllowed ? 'Allowed on the old site; discouraged here until you go live' : 'Discouraged'} />
      )}
    </dl>
  );
}

/** Blocking warnings first, in red; the rest in amber. */
export function WarningList({ warnings }: { warnings: ImportWarning[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {warnings
        .filter((w) => w.blocking)
        .map((w) => (
          <li key={w.code} className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
            {w.message}
          </li>
        ))}
      {warnings
        .filter((w) => !w.blocking)
        .map((w) => (
          <li key={w.code} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
            {w.message}
          </li>
        ))}
    </ul>
  );
}

/** Settings to carry over, plugins to deactivate, drop-ins and must-use plugins to remove, paths to rewrite. */
export function LeaveBehind({ report, constants, value, onChange }: {
  report: PackageSourceDto;
  constants: ImportConstantDto[];
  value: LeaveBehindChoices;
  onChange: (next: LeaveBehindChoices) => void;
}) {
  const active = report.plugins.filter((p) => p.active);
  return (
    <div className="space-y-6">
      <CheckList
        title="Settings to carry over"
        hint="From the old wp-config.php. Database settings and keys are never carried."
        empty="The old wp-config.php has none that can be carried."
        items={constants.map((c) => ({ id: c.name, label: <code>{c.name}</code>, sub: c.note ?? c.preview }))}
        checked={value.constants}
        onChange={(constants) => onChange({ ...value, constants })}
      />
      <CheckList
        title="Plugins to deactivate"
        hint="Active plugins that need the old host. Deactivated, not deleted."
        empty="No active plugins."
        items={active.map((p) => ({ id: p.slug, label: p.name || p.slug, sub: p.slug }))}
        checked={value.plugins}
        onChange={(plugins) => onChange({ ...value, plugins })}
      />
      {report.dropins.length > 0 && (
        <CheckList
          title="Drop-ins to remove"
          hint="Files in wp-content that plug a cache or database layer of the old host in."
          items={report.dropins.map((d) => ({ id: d, label: <code>{d}</code> }))}
          checked={value.dropins}
          onChange={(dropins) => onChange({ ...value, dropins })}
        />
      )}
      {report.muPlugins.length > 0 && (
        <CheckList
          title="Must-use plugins to remove"
          hint="Hosts install their own here."
          items={report.muPlugins.map((m) => ({ id: m.file, label: <code>{m.file}</code>, sub: m.name || undefined }))}
          checked={value.muPlugins}
          onChange={(muPlugins) => onChange({ ...value, muPlugins })}
        />
      )}
      <Toggle
        checked={value.rewritePaths}
        onChange={(rewritePaths) => onChange({ ...value, rewritePaths })}
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
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
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
              <input type="checkbox" className="mt-0.5" checked={checked.has(item.id)} onChange={(e) => toggle(item.id, e.target.checked)} />
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
