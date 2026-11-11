// @docs sites/php
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { webRootSchema } from '../../../../shared/schemas';
import type { SiteDetail } from '../../../../shared/types';
import { api } from '../../api/client';
import { Button, Card, ErrorNote, Field, inputClass } from '../ui';

/** A slash typed at either end is no folder. */
const clean = (raw: string) => raw.trim().replace(/^\/+|\/+$/g, '');

/** What a missing web root means for visitors, on this card and the site's Overview. */
export function webRootMissingText(webRoot: string): string {
  return `${webRoot} does not exist. Visitors get 404 until it does.`;
}

/**
 * A PHP site's web root: the folder visitors reach. Saved at once, in force on a running site
 * within seconds (the panel's sync writes Apache's file and reloads it).
 */
export function WebRootCard({ site }: { site: SiteDetail }) {
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const value = clean(text ?? site.webRoot);
  const valid = webRootSchema.safeParse(value).success;
  const changed = value !== site.webRoot;

  const save = () => {
    setSaving(true);
    setError(null);
    void api<SiteDetail>(`/api/sites/${site.slug}/web-root`, { method: 'PUT', body: { webRoot: value } })
      .then((next) => {
        qc.setQueryData(['site', site.slug], next);
        setText(null);
      })
      .catch(setError)
      .finally(() => setSaving(false));
  };

  return (
    <Card title="Web root">
      {/* The hint under the row, as on the PHP version card, so Save lines up with the field. */}
      <div className="flex items-end gap-2">
        <Field label="Folder" width="sm">
          <input className={inputClass} value={text ?? site.webRoot} placeholder="public" onChange={(e) => setText(e.target.value)} />
        </Field>
        <Button disabled={!changed || !valid} busy={saving} onClick={save}>
          Save
        </Button>
      </div>
      <p className={`mt-2 text-xs ${valid ? 'text-neutral-500' : 'text-red-700'}`}>
        {valid ? "The folder visitors reach. Empty: the site's folder." : 'A folder in the site, such as public: letters, digits, ".", "_" and "-", with "/" between folders.'}
      </p>
      {site.webRootMissing && <p className="mt-2 text-sm text-amber-800">{webRootMissingText(site.webRoot)}</p>}
      <ErrorNote error={error} />
    </Card>
  );
}
