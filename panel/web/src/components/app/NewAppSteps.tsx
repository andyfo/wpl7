// @docs sites/container
/**
 * New site's steps for a container app: Image, Settings, Routes, and its part of Review. The form
 * is kept as a draft (lib/siteCreation.ts), so Back to the form brings it back as it was sent. What
 * the steps check and send is in lib/appForm.ts.
 */
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ErrorNote, Field, Segmented, Toggle, UploadButton, inputClass } from '../ui';
import { uploadAppImage } from '../../api/apps';
import { EnvEditor, MountsEditor, RoutesEditor, problemHint } from './AppSettings';
import { archiveChosen, archiveUploaded, editedRoutes, healthPathProblem, routesOf, uploadPercent } from '../../lib/appForm';
import type { NewAppDraft } from '../../lib/siteCreation';

const SOURCES = [
  { id: 'registry', label: 'From a registry' },
  { id: 'upload', label: 'Upload an archive' },
] as const;

export function AppImageStep({ draft, onChange }: { draft: NewAppDraft; onChange: Dispatch<SetStateAction<NewAppDraft>> }) {
  const upload = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Leaving the step stops an upload still going, as leaving the Files tab does.
  useEffect(() => () => upload.current?.abort(), []);
  const pick = (file: File) => {
    upload.current?.abort();
    const controller = new AbortController();
    upload.current = controller;
    setError(null);
    setProgress(0);
    onChange(archiveChosen);
    void uploadAppImage(file, (sent, total) => setProgress(uploadPercent(sent, total)), controller.signal)
      .then((id) => {
        if (!controller.signal.aborted) onChange(archiveUploaded(id, file.name));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      })
      .finally(() => {
        if (upload.current !== controller) return;
        upload.current = null;
        setProgress(null);
      });
  };
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-sm font-medium text-neutral-700">Image</div>
        <Segmented options={SOURCES} value={draft.source} onChange={(source) => onChange({ ...draft, source })} label="Image" />
      </div>
      {draft.source === 'registry' ? (
        <>
          <Field label="Image reference" hint="Pinned by its digest when it is deployed. New images under the tag deploy by themselves." width="lg">
            <input className={inputClass} value={draft.reference} onChange={(e) => onChange({ ...draft, reference: e.target.value })} placeholder="ghcr.io/example/app:stable" autoFocus />
          </Field>
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Field label="Registry user" hint="For a private image.">
              <input className={inputClass} value={draft.registryUser} onChange={(e) => onChange({ ...draft, registryUser: e.target.value.trim() })} autoComplete="off" />
            </Field>
            <Field label="Registry token">
              <input className={inputClass} type="password" value={draft.registryToken} onChange={(e) => onChange({ ...draft, registryToken: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <UploadButton accept=".tar" percent={progress} onFile={pick}>
              {draft.upload ? 'Choose another' : 'Choose archive'}
            </UploadButton>
            {draft.upload && <span className="text-sm">{draft.upload.name}</span>}
          </div>
          <p className="measure text-xs text-neutral-500">
            A <code>docker save</code> archive of one image, built for this server's platform. It gets a name of the panel's.
          </p>
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

export function AppSettingsStep({ draft, onChange }: { draft: NewAppDraft; onChange: (d: NewAppDraft) => void }) {
  // Continue waits for a path the panel takes (lib/appForm.ts appStepOk): this says why it waits.
  const healthProblem = healthPathProblem(draft.healthPath);
  return (
    <div className="space-y-6">
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Port" hint="Empty: the one the image exposes.">
          <input className={inputClass} value={draft.port} onChange={(e) => onChange({ ...draft, port: e.target.value })} placeholder="8000" />
        </Field>
        <Field label="Health path" hint={problemHint(healthProblem, 'A deploy waits for it to answer 2xx.')}>
          <input className={inputClass} value={draft.healthPath} onChange={(e) => onChange({ ...draft, healthPath: e.target.value.trim() })} />
        </Field>
      </div>
      <div>
        <Toggle checked={draft.database} onChange={(database) => onChange({ ...draft, database })} label="Database" />
        <p className="mt-1 text-xs text-neutral-500">A MariaDB database of its own. Its address and login are in the placeholders below.</p>
      </div>
      <Section title="Environment">
        <EnvEditor rows={draft.env} onChange={(env) => onChange({ ...draft, env })} />
      </Section>
      <Section title="Mounts">
        <MountsEditor rows={draft.mounts} onChange={(mounts) => onChange({ ...draft, mounts })} />
        <p className="mt-1 text-xs text-neutral-500">Fill them from an archive on the app's Settings tab, once it is made.</p>
      </Section>
      <Section title="Hardening">
        <div className="space-y-2">
          <Toggle checked={draft.dropAllCaps} onChange={(dropAllCaps) => onChange({ ...draft, dropAllCaps })} label="Drop every capability" />
          <Toggle checked={draft.readOnlyRoot} onChange={(readOnlyRoot) => onChange({ ...draft, readOnlyRoot })} label="Read-only root (with a writable /tmp)" />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-neutral-700">{title}</div>
      {children}
    </div>
  );
}

export function AppRoutesStep({ draft, onChange, devHostname }: { draft: NewAppDraft; onChange: (d: NewAppDraft) => void; devHostname: string }) {
  return (
    <div className="space-y-3">
      <p className="measure text-sm text-neutral-600">
        Where the app answers. A host no other site has becomes its own; on another site's host, a route takes a path. Plain HTTP answers on port 80 without the redirect.
      </p>
      <RoutesEditor rows={routesOf(draft, devHostname)} onChange={(routes) => onChange({ ...draft, routes: editedRoutes(routes, devHostname) })} />
    </div>
  );
}

/** The app's rows of the Review step. */
export function appReviewRows(draft: NewAppDraft, devHostname: string, database: string): [string, ReactNode][] {
  const routes = routesOf(draft, devHostname);
  return [
    ['Type', 'Container app'],
    ['Image', draft.source === 'registry' ? <code key="i">{draft.reference.trim()}</code> : (draft.upload?.name ?? '')],
    ['Login', draft.registryUser ? draft.registryUser : 'None'],
    ['Port', draft.port.trim() || 'from the image'],
    ['Routes', routes.map((r) => `${r.host}${r.match === 'none' ? '' : r.path}${r.match === 'prefix' ? '…' : ''}${r.scheme === 'https' ? '' : r.scheme === 'http' ? ' (http)' : ' (https and http)'}`).join(', ')],
    ['Environment', draft.env.length > 0 ? draft.env.map((v) => v.name).join(', ') : 'None'],
    ['Mounts', draft.mounts.length > 0 ? draft.mounts.map((m) => `${m.name} at ${m.path}`).join(', ') : 'None'],
    ['Database', draft.database ? database : 'None'],
    ['Health path', draft.healthPath],
  ];
}
