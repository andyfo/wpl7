// @docs sites/container
/**
 * A container app's own cards on its Settings tab. A change to how its container runs (environment,
 * mounts, data paths, hardening) recreates it behind the health check, as a job the console shows;
 * routes, health and updates take effect as they are saved. A new port of an app that runs is
 * tried at the next start, deploy or recreate, and kept once the app answers there.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppDto, JobDto, SiteDetail } from '../../../../shared/types';
import type { AppRouteMatch, AppRouteScheme, AppUpdateMode } from '../../../../shared/schemas';
import { api } from '../../api/client';
import { useMeta } from '../../api/hooks';
import { clearDeployToken, makeDeployToken, patchApp, saveRegistryAuth, saveRoutes, uploadMountArchive } from '../../api/apps';
import { useFollowJob } from '../jobConsole/context';
import { Button, Card, CopyField, ErrorNote, Field, Segmented, Toggle, UploadButton, inputClass } from '../ui';
import { formatDate } from '../../lib/format';
import {
  RUNS_UNEDITED,
  dataPathsHint,
  editEnv,
  envBody,
  envEdits,
  envSaveNote,
  healthPathProblem,
  mountEdits,
  mountsBody,
  newRowKey,
  portHint,
  recreateNote,
  replaceSecret,
  routeEdits,
  routeErrorLines,
  runAsHint,
  runsPatch,
  runsSaveNote,
  runsShown,
  uploadPercent,
  type EnvEdit,
  type MountEdit,
  type RouteEdit,
  type RunsEdit,
} from '../../lib/appForm';

/**
 * One card's save: its call, the job it may start, and the site read again. An answer with the app
 * in it is the app as it is now: `keep` puts it in the site at once, so the cards show it.
 */
function useSave(slug: string) {
  const qc = useQueryClient();
  const follow = useFollowJob();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 5_000);
    return () => clearTimeout(t);
  }, [saved]);
  const keep = (app: AppDto) => qc.setQueryData<SiteDetail>(['site', slug], (old) => (old ? { ...old, container: app } : old));
  const save = (call: () => Promise<unknown>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    void call()
      .then((res) => {
        const answer = res as { job?: JobDto | null; app?: AppDto } | undefined;
        if (answer?.app) keep(answer.app);
        if (answer?.job) follow(answer.job, { refresh: [['site', slug]] });
        void qc.invalidateQueries({ queryKey: ['site', slug] });
        setSaved(true);
      })
      .catch(setError)
      .finally(() => setSaving(false));
  };
  return { save, keep, saving, saved, error };
}

function SaveRow({ label, onClick, s, disabled, note }: { label: string; onClick: () => void; s: ReturnType<typeof useSave>; disabled?: boolean; note?: string | null }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button onClick={onClick} busy={s.saving} disabled={disabled}>
        {label}
      </Button>
      {s.saved && <span className="text-sm text-emerald-700">Saved.</span>}
      {note && <span className="whitespace-pre-line text-xs text-neutral-500">{note}</span>}
      <div className="w-full">
        <ErrorNote error={s.error} />
      </div>
    </div>
  );
}

const UPDATE_OPTIONS = [
  { id: 'auto', label: 'Automatic' },
  { id: 'ask', label: 'Ask first' },
  { id: 'pinned', label: 'Pinned' },
] as const;

// --------------------------------------------------------------- Image & updates

export function AppImageSettings({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const ref = useSave(site.slug);
  const login = useSave(site.slug);
  const updates = useSave(site.slug);
  const [reference, setReference] = useState(app.reference);
  // Null until typed in: it shows the stored user, which a reference on another registry clears.
  const [username, setUsername] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<AppUpdateMode>(app.updates.mode);
  const [minutes, setMinutes] = useState(String(app.updates.checkMinutes));
  if (app.source !== 'registry') {
    return (
      <Card title="Image">
        <p className="text-sm text-neutral-600">This app runs uploaded images. Upload a new one on its Overview.</p>
      </Card>
    );
  }
  const n = Number(minutes);
  const user = username ?? app.registryUser;
  const newReference = reference.trim() !== app.reference;
  const saveLogin = () =>
    login.save(async () => {
      // The reference first: one on another registry clears the login, so saved after it, this one stays.
      if (newReference) login.keep((await patchApp(site.slug, { reference: reference.trim() })).app);
      const saved = await saveRegistryAuth(site.slug, user.trim(), token);
      setToken('');
      setUsername(null);
      return { app: saved };
    });
  return (
    <Card title="Image and updates">
      <Field label="Image reference" hint="What Deploy now and the update check pull. One on another registry clears the login." width="lg">
        <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ghcr.io/example/app:stable" />
      </Field>
      <SaveRow label="Save reference" s={ref} disabled={!newReference} onClick={() => ref.save(() => patchApp(site.slug, { reference: reference.trim() }))} />

      <div className="mt-6 grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Registry user">
          <input className={inputClass} value={user} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Registry token" hint={app.registryToken.set ? 'Set. Type a new one to replace it.' : 'For a private image.'}>
          <input className={inputClass} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button busy={login.saving} disabled={user.trim() === '' || token === ''} onClick={saveLogin}>
          {newReference ? 'Save reference and login' : 'Save login'}
        </Button>
        {app.registryToken.set && (
          <Button variant="secondary" disabled={login.saving} onClick={() => login.save(() => saveRegistryAuth(site.slug, '', '').then((saved) => (setUsername(null), { app: saved })))}>
            Remove login
          </Button>
        )}
        {login.saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
      <ErrorNote error={login.error} />

      <div className="mt-6">
        <div className="mb-1 text-sm font-medium text-neutral-700">New images under the tag</div>
        <Segmented options={UPDATE_OPTIONS} value={mode} onChange={setMode} label="New images under the tag" />
        <p className="measure mt-1 text-xs text-neutral-500">
          {mode === 'auto' ? 'Deployed when found.' : mode === 'ask' ? 'An email, and an Update button on the Overview.' : 'Nothing is checked. Deploy now still works.'}
        </p>
      </div>
      {mode !== 'pinned' && (
        <div className="mt-4">
          <Field label="Check every (minutes)" hint="Each check is one request to the registry. Docker Hub limits them: give it a login." width="sm">
            <input className={inputClass} type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
        </div>
      )}
      <SaveRow
        label="Save updates"
        s={updates}
        disabled={(mode === app.updates.mode && n === app.updates.checkMinutes) || !Number.isInteger(n) || n < 5 || n > 1440}
        onClick={() => updates.save(() => patchApp(site.slug, { updates: { mode, checkMinutes: n } }))}
      />
    </Card>
  );
}

// --------------------------------------------------------------- Deploy hook

export function DeployHookCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const s = useSave(site.slug);
  const [token, setToken] = useState<string | null>(null);
  const url = `${window.location.origin}/api/hooks/app-deploy`;
  // An uploaded image has no tag to pull a newer one of, so the panel makes it no token (409).
  const registry = app.source === 'registry';
  return (
    <Card title="Deploy hook">
      <p className="measure text-sm text-neutral-600">
        {registry
          ? 'Your CI calls it after a push, with the token in a header. The app then deploys what its reference names.'
          : 'An app with an uploaded image has no hook. Upload a new image on the Overview.'}
      </p>
      {(registry || app.deployToken.set) && (
        <p className="mt-2 text-sm">{app.deployToken.set ? `On, token made ${formatDate(app.deployToken.setAt!)}.` : 'Off.'}</p>
      )}
      {token && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-amber-800">Shown this once. Keep it in your CI's secrets.</p>
          <CopyField value={token} />
          <CopyField value={`curl -fsS -X POST -H "X-WPL7-Deploy-Token: ${token}" ${url}`} />
        </div>
      )}
      {(registry || app.deployToken.set) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {registry && (
            <Button busy={s.saving} onClick={() => s.save(() => makeDeployToken(site.slug).then((r) => setToken(r.token)))}>
              {app.deployToken.set ? 'Replace token' : 'Make token'}
            </Button>
          )}
          {app.deployToken.set && (
            <Button variant="secondary" disabled={s.saving} onClick={() => s.save(() => clearDeployToken(site.slug).then(() => setToken(null)))}>
              Switch off
            </Button>
          )}
        </div>
      )}
      <ErrorNote error={s.error} />
    </Card>
  );
}

// --------------------------------------------------------------- Routes


const MATCHES: { id: AppRouteMatch; label: string }[] = [
  { id: 'none', label: 'Any path' },
  { id: 'prefix', label: 'Starts with' },
  { id: 'exact', label: 'Exactly' },
];
const SCHEMES: { id: AppRouteScheme; label: string }[] = [
  { id: 'https', label: 'HTTPS' },
  { id: 'http', label: 'HTTP' },
  { id: 'both', label: 'Both' },
];

/** The route table: also New site's Routes step, with `onChange` and no save. */
export function RoutesEditor({ rows, onChange }: { rows: RouteEdit[]; onChange: (rows: RouteEdit[]) => void }) {
  const edit = (key: number, patch: Partial<RouteEdit>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-start gap-2">
          <div className="min-w-[14rem] flex-1">
            <input className={inputClass} value={r.host} onChange={(e) => edit(r.key, { host: e.target.value.trim().toLowerCase() })} placeholder="app.example.com" aria-label="Host" />
            {r.borrowedFrom && <div className="mt-0.5 text-xs text-neutral-500">A path of {r.borrowedFrom}'s domain</div>}
          </div>
          <select className={`${inputClass} w-auto`} value={r.match} aria-label="Path" onChange={(e) => edit(r.key, { match: e.target.value as AppRouteMatch, path: e.target.value === 'none' ? '' : r.path || '/' })}>
            {MATCHES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <input className={`${inputClass} w-56`} value={r.path} disabled={r.match === 'none'} onChange={(e) => edit(r.key, { path: e.target.value.trim() })} placeholder={r.match === 'none' ? '' : '/api'} aria-label="Path" />
          <select className={`${inputClass} w-auto`} value={r.scheme} aria-label="Scheme" onChange={(e) => edit(r.key, { scheme: e.target.value as AppRouteScheme })}>
            {SCHEMES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="pt-2">
            <Toggle checked={r.enabled} onChange={(v) => edit(r.key, { enabled: v })} label="On" />
          </div>
          <button type="button" className="px-2 pt-2 text-neutral-400 hover:text-neutral-700" aria-label={`Remove ${r.host || 'route'}`} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
            ✕
          </button>
        </div>
      ))}
      <Button small variant="secondary" onClick={() => onChange([...rows, { host: '', match: 'none', path: '', scheme: 'https', enabled: true, key: newRowKey() }])}>
        Add route
      </Button>
    </div>
  );
}

export function RoutesCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const s = useSave(site.slug);
  // Without TLS a route's https router is on plain http too (services/appRoutes.ts).
  const tls = useMeta().data?.tlsMode !== 'none';
  const [rows, setRows] = useState(() => routeEdits(app.routes));
  const refused = routeErrorLines(app.routeErrors, app.routes, tls);
  return (
    <Card title="Routes">
      {refused.length > 0 && (
        <div className="mb-4 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {refused.map((line) => (
            <p key={line.key} title={formatDate(line.at)}>
              {line.text}
            </p>
          ))}
        </div>
      )}
      <p className="measure mb-4 text-sm text-neutral-600">
        A host no other site has is the app's own. On another site's host, a route takes a path. Plain HTTP answers on port 80 without the redirect.
      </p>
      <RoutesEditor rows={rows} onChange={setRows} />
      <SaveRow
        label="Save routes"
        s={s}
        disabled={rows.length === 0 || rows.some((r) => r.host === '')}
        note="Nothing restarts."
        onClick={() =>
          s.save(() =>
            saveRoutes(site.slug, rows.map(({ id, host, match, path, scheme, enabled }) => ({ ...(id ? { id } : {}), host, match, path: match === 'none' ? '' : path, scheme, enabled }))).then(
              (dto: AppDto) => (setRows(routeEdits(dto.routes)), { app: dto }),
            ),
          )
        }
      />
    </Card>
  );
}

// --------------------------------------------------------------- Environment


const PLACEHOLDERS = ['db.host', 'db.port', 'db.name', 'db.user', 'db.password', 'mail.host', 'mail.port', 'mail.user', 'mail.password', 'site.domain'];

/** Why a kept secret's name and switch do not move: the API keeps its value by both. */
const KEPT_HINT = 'Replace it to rename it or switch Secret off.';

/** The environment list: also New site's Settings step. A kept secret has a value the page never sees. */
export function EnvEditor({ rows, onChange }: { rows: EnvEdit[]; onChange: (rows: EnvEdit[]) => void }) {
  const edit = (key: number, patch: Partial<Pick<EnvEdit, 'name' | 'value' | 'secret'>>) => onChange(rows.map((r) => (r.key === key ? editEnv(r, patch) : r)));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} w-56 font-mono text-xs`}
            value={r.name}
            disabled={r.kept}
            title={r.kept ? KEPT_HINT : undefined}
            onChange={(e) => edit(r.key, { name: e.target.value.trim() })}
            placeholder="NAME"
            aria-label="Name"
          />
          {r.kept ? (
            <span className="flex flex-1 items-center gap-2 text-sm text-neutral-500">
              •••••• set
              <Button small variant="secondary" onClick={() => onChange(rows.map((x) => (x.key === r.key ? replaceSecret(x) : x)))}>
                Replace
              </Button>
            </span>
          ) : (
            <input className={`${inputClass} min-w-[12rem] flex-1 font-mono text-xs`} type={r.secret ? 'password' : 'text'} value={r.value} onChange={(e) => edit(r.key, { value: e.target.value })} aria-label="Value" autoComplete="off" />
          )}
          <span title={r.kept ? KEPT_HINT : undefined}>
            <Toggle checked={r.secret} disabled={r.kept} onChange={(v) => edit(r.key, { secret: v })} label="Secret" />
          </span>
          <button type="button" className="px-2 text-neutral-400 hover:text-neutral-700" aria-label={`Remove ${r.name || 'variable'}`} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
            ✕
          </button>
        </div>
      ))}
      <Button small variant="secondary" onClick={() => onChange([...rows, { key: newRowKey(), name: '', value: '', secret: false, kept: false }])}>
        Add variable
      </Button>
      <p className="measure text-xs text-neutral-500">
        Filled in at every start: {PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}. A secret is never shown again.
        {rows.some((r) => r.kept) && ` ${KEPT_HINT}`}
      </p>
    </div>
  );
}

export function EnvCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const s = useSave(site.slug);
  const [rows, setRows] = useState(() => envEdits(app.env));
  return (
    <Card title="Environment">
      <EnvEditor rows={rows} onChange={setRows} />
      <SaveRow
        label="Save environment"
        s={s}
        disabled={rows.some((r) => r.name === '')}
        note={envSaveNote(app, rows, site.status === 'running')}
        onClick={() => s.save(() => patchApp(site.slug, { env: envBody(rows) }).then((res) => (setRows(envEdits(res.app.env)), res)))}
      />
    </Card>
  );
}

// --------------------------------------------------------------- Mounts


/** The mount list: also New site's Settings step, where nothing can be uploaded yet. */
export function MountsEditor({ rows, onChange, upload }: { rows: MountEdit[]; onChange: (rows: MountEdit[]) => void; upload?: (name: string) => React.ReactNode }) {
  const edit = (key: number, patch: Partial<MountEdit>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-center gap-2">
          <input className={`${inputClass} w-36`} value={r.name} disabled={r.saved} onChange={(e) => edit(r.key, { name: e.target.value.trim().toLowerCase() })} placeholder="name" aria-label="Name" />
          <input className={`${inputClass} min-w-[12rem] flex-1 font-mono text-xs`} value={r.path} onChange={(e) => edit(r.key, { path: e.target.value.trim() })} placeholder="/run/secrets/app" aria-label="Path in the container" />
          <Toggle checked={r.writable} onChange={(v) => edit(r.key, { writable: v })} label="Writable" />
          <Toggle checked={r.inBackups} onChange={(v) => edit(r.key, { inBackups: v })} label="In backups" />
          {upload && r.saved && upload(r.name)}
          <button type="button" className="px-2 text-neutral-400 hover:text-neutral-700" aria-label={`Remove ${r.name || 'mount'}`} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
            ✕
          </button>
        </div>
      ))}
      <Button small variant="secondary" onClick={() => onChange([...rows, { key: newRowKey(), name: '', path: '', writable: false, inBackups: true, filledAt: null, saved: false }])}>
        Add mount
      </Button>
    </div>
  );
}

export function MountsCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const s = useSave(site.slug);
  const [rows, setRows] = useState(() => mountEdits(app.mounts));
  const filled = (name: string) => app.mounts.find((m) => m.name === name)?.filledAt ?? null;
  return (
    <Card title="Mounts">
      <p className="measure mb-4 text-sm text-neutral-600">
        Folders of files you give the app, such as keys or a certificate. Upload a .tar.gz or .zip to fill one: it replaces what is there, and the app restarts.
      </p>
      <MountsEditor rows={rows} onChange={setRows} upload={(name) => <MountUpload slug={site.slug} name={name} filledAt={filled(name)} />} />
      <SaveRow
        label="Save mounts"
        s={s}
        disabled={rows.some((r) => r.name === '' || r.path === '')}
        note={recreateNote(app, site.status === 'running')}
        onClick={() => s.save(() => patchApp(site.slug, { mounts: mountsBody(rows) }).then((res) => (setRows(mountEdits(res.app.mounts)), res)))}
      />
    </Card>
  );
}

function MountUpload({ slug, name, filledAt }: { slug: string; name: string; filledAt: number | null }) {
  const follow = useFollowJob();
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pick = (file: File) => {
    setError(null);
    setPercent(0);
    void uploadMountArchive(slug, file, (sent, total) => setPercent(uploadPercent(sent, total)))
      .then((uploadId) => api<{ job: JobDto }>(`/api/sites/${slug}/app/mounts/${name}`, { method: 'PUT', body: { uploadId } }))
      .then((res) => follow(res.job, { refresh: [['site', slug]] }))
      .catch(setError)
      .finally(() => setPercent(null));
  };
  return (
    <span className="flex items-center gap-2">
      <UploadButton small accept=".tar.gz,.tgz,.zip" percent={percent} onFile={pick}>
        Upload
      </UploadButton>
      {percent === null && <span className="text-xs text-neutral-500">{filledAt ? `Filled ${formatDate(filledAt)}` : 'Empty'}</span>}
      <ErrorNote error={error} />
    </span>
  );
}

// --------------------------------------------------------------- Health check

/** A field's hint, or why what was typed in would be refused, in its place: also New site's Settings step. */
export const problemHint = (problem: string | null, hint?: string) => (problem ? <span className="text-red-700">{problem}</span> : hint);

export function HealthCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const s = useSave(site.slug);
  const [path, setPath] = useState(app.health.path);
  const [host, setHost] = useState(app.health.host);
  const [check, setCheck] = useState(app.health.deployCheckPath);
  const [timeout, setTimeoutSec] = useState(String(app.health.timeoutSec));
  const t = Number(timeout);
  const pathProblem = healthPathProblem(path);
  const checkProblem = healthPathProblem(check, true);
  return (
    <Card title="Health check">
      <p className="measure mb-4 text-sm text-neutral-600">
        A deploy keeps the new container only once this path answers 2xx, asked on the app's own network. The uptime check asks it too.
      </p>
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Path" hint={problemHint(pathProblem)}>
          <input className={inputClass} value={path} onChange={(e) => setPath(e.target.value.trim())} placeholder="/healthz" />
        </Field>
        <Field label="Host" hint="Empty: the app's first host.">
          <input className={inputClass} value={host} onChange={(e) => setHost(e.target.value.trim().toLowerCase())} />
        </Field>
        <Field label="Deploy check path" hint={problemHint(checkProblem, 'Asked once after the health path, at a deploy. Empty: none.')}>
          <input className={inputClass} value={check} onChange={(e) => setCheck(e.target.value.trim())} placeholder="/ready" />
        </Field>
        <Field label="Wait for it (seconds)">
          <input className={inputClass} type="number" min={5} max={600} value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} />
        </Field>
      </div>
      <SaveRow
        label="Save health check"
        s={s}
        disabled={pathProblem !== null || checkProblem !== null || !Number.isInteger(t) || t < 5 || t > 600}
        onClick={() => s.save(() => patchApp(site.slug, { health: { path, host, deployCheckPath: check, timeoutSec: t } }))}
      />
    </Card>
  );
}

// --------------------------------------------------------------- How it runs

export function RunsCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const s = useSave(site.slug);
  // What was typed in. The rest shows the app as it is now, with a staged port or a user that is going in.
  const [edit, setEdit] = useState<RunsEdit>(RUNS_UNEDITED);
  const set = (field: Partial<RunsEdit>) => setEdit((e) => ({ ...e, ...field }));
  const shown = runsShown(app, edit);
  const patch = runsPatch(app, edit);
  // A user going in stays as it is until its recreate is done: that job holds the site, so a change now is refused.
  const runAsHeld = app.pending?.runAs !== undefined ? runAsHint(app) : undefined;
  return (
    <Card title="How it runs">
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Port" hint={portHint(app)}>
          <input className={inputClass} type="number" min={1} max={65535} value={shown.port} onChange={(e) => set({ port: e.target.value })} />
        </Field>
        <Field label="Run as" hint={runAsHint(app)}>
          <input className={inputClass} value={shown.runAs} disabled={!!runAsHeld} title={runAsHeld} onChange={(e) => set({ runAs: e.target.value.trim() })} placeholder="1000:1000" />
        </Field>
        <Field label="Stop grace (seconds)" hint="How long a stop waits for it to finish.">
          <input className={inputClass} type="number" min={0} max={300} value={shown.stopGraceSec} onChange={(e) => set({ stopGraceSec: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        <Toggle checked={shown.dropAllCaps} onChange={(v) => set({ dropAllCaps: v })} label="Drop every capability" />
        <Toggle checked={shown.readOnlyRoot} onChange={(v) => set({ readOnlyRoot: v })} label="Read-only root (with a writable /tmp)" />
      </div>
      <div className="mt-4">
        <Field label="Data folders" hint={dataPathsHint(app)} width="lg">
          <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={shown.dataPaths} onChange={(e) => set({ dataPaths: e.target.value })} />
        </Field>
      </div>
      <SaveRow
        label="Save"
        s={s}
        disabled={!patch || Object.keys(patch).length === 0}
        note={runsSaveNote(app, patch, site.status === 'running')}
        onClick={() => patch && s.save(() => patchApp(site.slug, { ...patch }).then((res) => (setEdit(RUNS_UNEDITED), res)))}
      />
    </Card>
  );
}
