// @docs sites/container
/**
 * New site's steps for a container app: Image, Settings, Routes, and its part of Review. The form
 * is kept as a draft (lib/siteCreation.ts), so Back to the form brings it back as it was sent.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNote, Field, Segmented, Toggle, inputClass } from '../ui';
import { uploadAppImage } from '../../api/apps';
import { EnvEditor, MountsEditor, RoutesEditor, envBody, mountsBody } from './AppSettings';
import type { NewAppDraft } from '../../lib/siteCreation';

export const emptyAppDraft = (): NewAppDraft => ({
  source: 'registry',
  reference: '',
  registryUser: '',
  registryToken: '',
  upload: null,
  port: '',
  env: [],
  database: false,
  mounts: [],
  dropAllCaps: false,
  readOnlyRoot: false,
  routes: null,
  healthPath: '/',
});

const IMAGE_REFERENCE_RE = /^[a-z0-9][a-z0-9._\-/:]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

/** The route a new app starts with: its dev hostname, over HTTPS. */
const firstRoute = (devHostname: string) => [{ key: 0, host: devHostname, match: 'none' as const, path: '', scheme: 'https' as const, enabled: true }];

export const routesOf = (draft: NewAppDraft, devHostname: string) => draft.routes ?? firstRoute(devHostname);

/** Whether a step may be left for the next one. */
export function appStepOk(step: 'image' | 'settings' | 'routes', draft: NewAppDraft, devHostname: string): boolean {
  if (step === 'image') return draft.source === 'registry' ? IMAGE_REFERENCE_RE.test(draft.reference.trim()) && (draft.registryUser === '') === (draft.registryToken === '') : draft.upload !== null;
  if (step === 'settings') {
    const port = draft.port.trim();
    return (port === '' || (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) && draft.env.every((v) => v.name !== '') && draft.mounts.every((m) => m.name !== '' && m.path !== '') && draft.healthPath.startsWith('/');
  }
  const routes = routesOf(draft, devHostname);
  return routes.length > 0 && routes.every((r) => r.host !== '');
}

/** What POST /api/sites takes for it, beside the fields every site has. */
export function appBody(draft: NewAppDraft, devHostname: string) {
  const port = draft.port.trim();
  return {
    app: 'container' as const,
    image:
      draft.source === 'upload'
        ? { uploadId: draft.upload!.id }
        : {
            reference: draft.reference.trim(),
            ...(draft.registryUser ? { registryUser: draft.registryUser, registryToken: draft.registryToken } : {}),
          },
    ...(port ? { port: Number(port) } : {}),
    database: draft.database,
    env: envBody(draft.env),
    mounts: mountsBody(draft.mounts),
    routes: routesOf(draft, devHostname).map(({ host, match, path, scheme, enabled }) => ({ host, match, path: match === 'none' ? '' : path, scheme, enabled })),
    hardening: { dropAllCaps: draft.dropAllCaps, readOnlyRoot: draft.readOnlyRoot },
    health: { path: draft.healthPath },
  };
}

const SOURCES = [
  { id: 'registry', label: 'From a registry' },
  { id: 'upload', label: 'Upload an archive' },
] as const;

export function AppImageStep({ draft, onChange }: { draft: NewAppDraft; onChange: (d: NewAppDraft) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pick = (file: File) => {
    setError(null);
    void uploadAppImage(file, (sent, total) => setProgress(Math.round((sent / Math.max(1, total)) * 100)))
      .then((id) => onChange({ ...draft, upload: { id, name: file.name } }))
      .catch(setError)
      .finally(() => setProgress(null));
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
          <input ref={input} type="file" className="hidden" accept=".tar" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          <div className="flex items-center gap-3">
            <Button variant="secondary" busy={progress !== null} onClick={() => input.current?.click()}>
              {progress !== null ? `Uploading ${progress} %` : draft.upload ? 'Choose another' : 'Choose archive'}
            </Button>
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
  return (
    <div className="space-y-6">
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Port" hint="Empty: the one the image exposes.">
          <input className={inputClass} value={draft.port} onChange={(e) => onChange({ ...draft, port: e.target.value })} placeholder="8000" />
        </Field>
        <Field label="Health path" hint="A deploy waits for it to answer 2xx.">
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
      <RoutesEditor rows={routesOf(draft, devHostname)} onChange={(routes) => onChange({ ...draft, routes })} />
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
