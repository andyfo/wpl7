import { useState } from 'react';
import type { SiteFileSearchDto, SiteFileSearchMatchDto } from '../../../../shared/types';
import { search } from '../../api/files';
import { Button, ErrorNote, inputClass, Spinner } from '../ui';
import { Icon } from '../Icon';

/**
 * Find files under the current folder, by name or by what is in them. Content search is what
 * an infected site needs ("which files call eval(base64_decode("), so plain text is the
 * default and a regular expression is one tick away.
 */
export function SearchPanel({
  slug,
  dir,
  onOpenFile,
  onOpenFolder,
  onClose,
}: {
  slug: string;
  dir: string;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFolder: (path: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'name' | 'content'>('name');
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<SiteFileSearchDto | null>(null);

  const run = () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    search(slug, { path: dir, q, mode, case: matchCase, regex: mode === 'content' && regex, include: mode === 'content' ? include : '' })
      .then(setResult)
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-neutral-300 text-sm">
            {(['name', 'content'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 ${mode === m ? 'bg-neutral-800 text-white' : 'bg-surface text-neutral-600 hover:bg-neutral-100'}`}
              >
                {m === 'name' ? 'File names' : 'Contents'}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <input
              className={`${inputClass} font-mono text-xs`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={mode === 'name' ? 'Part of a name, e.g. config' : regex ? 'A regular expression' : 'Text, e.g. base64_decode('}
              maxLength={200}
              autoFocus
            />
          </div>
          <Button type="submit" small disabled={!q.trim() || busy}>
            {busy ? <Spinner /> : <Icon name="search" size={14} />} Search
          </Button>
          <Button small variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-600">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
          </label>
          {mode === 'content' && (
            <>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression
              </label>
              <label className="flex items-center gap-1.5">
                Only in
                <span className="w-40">
                  <input
                    className={`${inputClass} py-1 font-mono text-xs`}
                    value={include}
                    onChange={(e) => setInclude(e.target.value)}
                    placeholder="*.php,*.js"
                    aria-label="Only in files matching"
                  />
                </span>
              </label>
            </>
          )}
          <span className="text-neutral-500">
            in <span className="font-mono">{dir === '' ? 'the whole site' : dir}</span> and everything under it
            {mode === 'content' && ' (binary files skipped)'}
          </span>
        </div>
      </form>
      <ErrorNote error={error} />
      {result && <Results result={result} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} />}
    </div>
  );
}

function Results({
  result,
  onOpenFile,
  onOpenFolder,
}: {
  result: SiteFileSearchDto;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFolder: (path: string) => void;
}) {
  const notes = [
    result.truncated && `only the first ${result.matches.length} are shown`,
    result.timedOut && 'the search ran out of time, so there may be more - search a smaller folder',
  ].filter(Boolean);
  const header = (
    <p className="text-xs text-neutral-600">
      {result.matches.length === 0 ? 'Nothing found' : `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'}`}
      {notes.length > 0 && ` - ${notes.join('; ')}`}
    </p>
  );
  if (result.mode === 'name') {
    return (
      <div className="space-y-1">
        {header}
        <ul className="max-h-80 overflow-y-auto text-sm">
          {result.matches.map((m) => (
            <li key={m.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-neutral-100"
                onClick={() => (m.type === 'dir' ? onOpenFolder(m.path) : onOpenFile(m.path))}
              >
                <Icon name={m.type === 'dir' ? 'folder' : 'file'} size={15} />
                <span className="font-mono text-xs">
                  <bdi>{m.path}</bdi>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const byFile = new Map<string, SiteFileSearchMatchDto[]>();
  for (const m of result.matches) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
  return (
    <div className="space-y-2">
      {header}
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {[...byFile].map(([path, lines]) => (
          <div key={path}>
            <button
              type="button"
              className="font-mono text-xs font-semibold text-neutral-800 hover:underline"
              onClick={() => onOpenFile(path)}
            >
              <bdi>{path}</bdi>
            </button>
            <ul className="mt-0.5">
              {lines.map((m) => (
                <li key={m.line}>
                  <button
                    type="button"
                    onClick={() => onOpenFile(path, m.line)}
                    className="flex w-full gap-3 rounded px-2 py-0.5 text-left hover:bg-neutral-100"
                  >
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-neutral-400">{m.line}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-neutral-700">{m.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
