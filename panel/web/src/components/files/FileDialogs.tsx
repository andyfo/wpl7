import { useState } from 'react';
import type { SiteFileEntryDto } from '../../../../shared/types';
import {
  joinSiteFilePath,
  newFileNameProblem,
  parseSiteFilePath,
  siteFileBase,
  siteFileParent,
} from '../../../../shared/siteFilePath';
import { Field, inputClass, Toggle } from '../ui';
import { ActionDialog, permissionString } from './common';

/** The problem with a typed path, or null: the shared rules plus the new-name rules. */
function pathProblem(input: string, opts: { allowRoot?: boolean; newName?: boolean } = {}): string | null {
  const parsed = parseSiteFilePath(input.trim());
  if (!parsed.ok) return parsed.problem;
  if (parsed.path === '' && !opts.allowRoot) return 'Enter a name.';
  if (opts.newName && parsed.path !== '') return newFileNameProblem(siteFileBase(parsed.path));
  return null;
}

const clean = (input: string) => {
  const parsed = parseSiteFilePath(input.trim());
  return parsed.ok ? parsed.path : input.trim();
};

/** A new file or folder in `dir`. */
export function NewEntryDialog({
  kind,
  dir,
  onCreate,
  onClose,
}: {
  kind: 'file' | 'folder';
  dir: string;
  onCreate: (path: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const problem = name ? newFileNameProblem(name.trim()) : null;
  return (
    <ActionDialog
      title={kind === 'file' ? 'New file' : 'New folder'}
      submitLabel="Create"
      disabled={!name.trim() || problem !== null}
      onSubmit={() => onCreate(joinSiteFilePath(dir, name.trim()))}
      onClose={onClose}
    >
      <Field label="Name" hint={problem ?? `In ${dir === '' ? 'the site folder' : dir}`} width="full">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'file' ? 'e.g. custom.css' : 'e.g. assets'}
          autoFocus
        />
      </Field>
    </ActionDialog>
  );
}

/**
 * Rename, move or duplicate - all one gesture: edit where the entry should be. The path is
 * relative to the site folder, so moving is changing the folder part.
 */
export function MoveDialog({
  mode,
  entryPath,
  onSubmit,
  onClose,
}: {
  mode: 'move' | 'copy';
  entryPath: string;
  onSubmit: (to: string, overwrite: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const initial = mode === 'move' ? entryPath : duplicateName(entryPath);
  const [to, setTo] = useState(initial);
  const [overwrite, setOverwrite] = useState(false);
  const problem = pathProblem(to, { newName: true });
  const unchanged = clean(to) === entryPath;
  return (
    <ActionDialog
      title={mode === 'move' ? 'Rename or move' : 'Duplicate'}
      submitLabel={mode === 'move' ? 'Move' : 'Duplicate'}
      danger={overwrite}
      disabled={problem !== null || unchanged}
      onSubmit={() => onSubmit(clean(to), overwrite)}
      onClose={onClose}
    >
      <Field
        label="New path, from the site folder"
        hint={problem ?? `Now: ${entryPath}`}
        width="full"
      >
        <input className={`${inputClass} font-mono text-xs`} value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
      </Field>
      {mode === 'move' && (
        <Toggle
          checked={overwrite}
          onChange={setOverwrite}
          label="Replace a file that already has that name (never a folder)"
        />
      )}
    </ActionDialog>
  );
}

/** `a/b.php` -> `a/b copy.php`; a folder or a name without an extension gets " copy" at the end. */
function duplicateName(p: string): string {
  const name = siteFileBase(p);
  const dot = name.lastIndexOf('.');
  const copy = dot > 0 ? `${name.slice(0, dot)} copy${name.slice(dot)}` : `${name} copy`;
  return joinSiteFilePath(siteFileParent(p), copy);
}

const BITS = [
  { who: 'Owner', shift: 6 },
  { who: 'Group', shift: 3 },
  { who: 'Others', shift: 0 },
] as const;
const KINDS = [
  { what: 'Read', bit: 4 },
  { what: 'Write', bit: 2 },
  { what: 'Execute', bit: 1 },
] as const;

export function ChmodDialog({
  entry,
  path,
  onSubmit,
  onClose,
}: {
  entry: SiteFileEntryDto;
  path: string;
  onSubmit: (mode: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => parseInt(entry.mode.slice(-3), 8));
  const octal = value.toString(8).padStart(3, '0');
  const [typed, setTyped] = useState(octal);
  const toggle = (bit: number) => {
    const next = value ^ bit;
    setValue(next);
    setTyped(next.toString(8).padStart(3, '0'));
  };
  const valid = /^[0-7]{3}$/.test(typed);
  return (
    <ActionDialog
      title="Permissions"
      submitLabel="Apply"
      disabled={!valid}
      onSubmit={() => onSubmit(typed)}
      onClose={onClose}
    >
      <p className="text-neutral-600">
        <span className="font-mono">{path}</span> is now <span className="font-mono">{entry.mode}</span> (
        <span className="font-mono">{permissionString(entry.mode)}</span>).
        {entry.mode.length > 3 && ' Its special bits (setuid, setgid, sticky) are cleared by a change here.'}
      </p>
      <table className="text-sm">
        <thead>
          <tr className="text-xs text-neutral-500">
            <th />
            {KINDS.map((k) => (
              <th key={k.what} className="px-3 pb-1 font-medium">
                {k.what}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BITS.map((b) => (
            <tr key={b.who}>
              <td className="pr-3 text-neutral-600">{b.who}</td>
              {KINDS.map((k) => {
                const bit = k.bit << b.shift;
                return (
                  <td key={k.what} className="px-3 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${b.who} ${k.what}`}
                      checked={(value & bit) !== 0}
                      onChange={() => toggle(bit)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="Octal" hint="WordPress's own defaults are 644 for files and 755 for folders." width="sm">
        <input
          className={`${inputClass} font-mono`}
          value={typed}
          maxLength={3}
          onChange={(e) => {
            setTyped(e.target.value);
            if (/^[0-7]{3}$/.test(e.target.value)) setValue(parseInt(e.target.value, 8));
          }}
        />
      </Field>
    </ActionDialog>
  );
}

export function ExtractDialog({
  path,
  onSubmit,
  onClose,
}: {
  path: string;
  onSubmit: (to: string, overwrite: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const [to, setTo] = useState(siteFileParent(path));
  const [overwrite, setOverwrite] = useState(false);
  const problem = pathProblem(to, { allowRoot: true });
  return (
    <ActionDialog
      title={`Extract ${siteFileBase(path)}`}
      submitLabel="Extract"
      danger={overwrite}
      disabled={problem !== null}
      onSubmit={() => onSubmit(clean(to), overwrite)}
      onClose={onClose}
    >
      <Field
        label="Into the folder (it must exist)"
        hint={problem ?? 'Leave empty for the site folder. A plugin or theme zip usually holds its own folder already.'}
        width="full"
      >
        <input className={`${inputClass} font-mono text-xs`} value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Toggle checked={overwrite} onChange={setOverwrite} label="Replace files that are already there" />
      <p className="text-xs text-neutral-500">
        An archive whose entries would land outside the folder is refused whole, and links inside it are skipped.
      </p>
    </ActionDialog>
  );
}

export function CompressDialog({
  dir,
  paths,
  onSubmit,
  onClose,
}: {
  dir: string;
  paths: string[];
  onSubmit: (to: string, overwrite: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(paths.length === 1 ? `${siteFileBase(paths[0]!)}.zip` : 'archive.zip');
  const [overwrite, setOverwrite] = useState(false);
  const problem = newFileNameProblem(name.trim()) ?? (/\.zip$/i.test(name.trim()) ? null : 'The name must end in .zip.');
  return (
    <ActionDialog
      title={paths.length === 1 ? `Compress ${siteFileBase(paths[0]!)}` : `Compress ${paths.length} items`}
      submitLabel="Compress"
      disabled={problem !== null}
      onSubmit={() => onSubmit(joinSiteFilePath(dir, name.trim()), overwrite)}
      onClose={onClose}
    >
      <Field label="Archive name" hint={problem ?? `Written to ${dir === '' ? 'the site folder' : dir}`} width="full">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Toggle checked={overwrite} onChange={setOverwrite} label="Replace an archive with that name" />
    </ActionDialog>
  );
}
