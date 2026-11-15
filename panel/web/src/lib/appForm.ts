// @docs sites/container
/**
 * A container app's forms, kept apart from the components so they can be tested without a browser:
 * the lists New site's steps and the Settings tab edit, and what each of them sends.
 */
import type { AppDto, AppRouteDto } from '../../../shared/types';
import type { AppRouteMatch, AppRouteScheme } from '../../../shared/schemas';
import { describeRoute, parseAppRouterName, routeIdOfKind } from '../../../shared/apps';
import type { NewAppDraft } from './siteCreation';

/** `key`: the row's own, for React; `id`: a saved route's, which names its routers. */
export interface RouteEdit {
  key: number;
  id?: number;
  host: string;
  match: AppRouteMatch;
  path: string;
  scheme: AppRouteScheme;
  enabled: boolean;
  /** The site whose domain it takes a path of. */
  borrowedFrom?: string | null;
  /** New site's route on the dev hostname: it follows the name and the server until its host is typed over. */
  devHost?: boolean;
}

/**
 * `kept`: a stored secret, sent without a value so that it keeps the one it has. The API finds that
 * value by the name, as a secret's, so the name and the Secret switch stay as they are until Replace.
 */
export interface EnvEdit {
  key: number;
  name: string;
  value: string;
  secret: boolean;
  kept: boolean;
}

/** `saved`: the app has it already, so it can be filled, and its name stays. */
export interface MountEdit {
  key: number;
  name: string;
  path: string;
  writable: boolean;
  inBackups: boolean;
  filledAt: number | null;
  saved: boolean;
}

let nextKey = 1;
/** A new row's key, unique in the tab. */
export const newRowKey = (): number => nextKey++;

// --------------------------------------------------------------- Routes

export const routeEdits = (routes: AppRouteDto[]): RouteEdit[] => routes.map((r) => ({ ...r, key: newRowKey() }));

/** One line of what Traefik refused, and when it last said so. */
export interface RouteErrorLine {
  key: string;
  text: string;
  at: number;
}

/** Where a route answers, without its scheme: describeRoute names none for https. */
const placeOf = (route: AppRouteDto): string => describeRoute({ ...route, scheme: 'https' });

/**
 * Traefik's refusals of the app's routers, one line a route, naming the side it refused: the other
 * may still answer. `r<id>` is a route's https router (on a panel without TLS, its one plain http
 * router) and `r<id>-http` its plain http one (services/appRoutes.ts buildAppRoutes). A route
 * refused on both sides says what Traefik said last; a router of no route here goes by its name.
 */
export function routeErrorLines(errors: AppDto['routeErrors'], routes: AppRouteDto[], tls: boolean): RouteErrorLine[] {
  const lines = new Map<string, { route?: AppRouteDto; router: string; sides: Set<string>; message: string; at: number }>();
  for (const e of errors) {
    const kind = parseAppRouterName(e.router)?.kind ?? '';
    const id = routeIdOfKind(kind);
    const route = id === null ? undefined : routes.find((r) => r.id === id);
    const key = route ? `route-${route.id}` : `router-${e.router}`;
    const line = lines.get(key) ?? { route, router: e.router, sides: new Set<string>(), message: e.message, at: e.at };
    if (route) line.sides.add(kind.endsWith('-http') || !tls ? 'http' : 'https');
    if (e.at >= line.at) {
      line.message = e.message;
      line.at = e.at;
    }
    lines.set(key, line);
  }
  return [...lines].map(([key, l]) => {
    const what = l.route ? `${placeOf(l.route)} (${['https', 'http'].filter((s) => l.sides.has(s)).join(' and ')})` : l.router;
    return { key, text: `Traefik refused ${what}: ${l.message}`, at: l.at };
  });
}

// --------------------------------------------------------------- Environment

export const envEdits = (env: AppDto['env']): EnvEdit[] =>
  env.map((v) => ({ key: newRowKey(), name: v.name, value: v.value ?? '', secret: v.secret, kept: v.secret && v.set }));

/** A row's change. A kept secret takes none: switched off and on again, it would go with an empty value. */
export const editEnv = (row: EnvEdit, patch: Partial<Pick<EnvEdit, 'name' | 'value' | 'secret'>>): EnvEdit => (row.kept ? row : { ...row, ...patch });

/** Replace: an empty value to type the new one in, and the name and the switch the row's own again. */
export const replaceSecret = (row: EnvEdit): EnvEdit => ({ ...row, kept: false, value: '' });

/** What the API takes: a kept secret goes without its value, which it keeps (services/apps.ts planEnv). */
export const envBody = (rows: EnvEdit[]) => rows.map((r) => (r.kept ? { name: r.name, secret: true } : { name: r.name, value: r.value, secret: r.secret }));

// --------------------------------------------------------------- Mounts

export const mountEdits = (mounts: AppDto['mounts']): MountEdit[] => mounts.map((m) => ({ key: newRowKey(), ...m, saved: true }));

export const mountsBody = (rows: MountEdit[]) => rows.map(({ name, path, writable, inBackups }) => ({ name, path, writable, inBackups }));

// --------------------------------------------------------------- How it runs

/** How it runs, as its card has it typed in. A field still null shows what the app has, as it is now. */
export interface RunsEdit {
  port: string | null;
  runAs: string | null;
  dropAllCaps: boolean | null;
  readOnlyRoot: boolean | null;
  stopGraceSec: string | null;
  dataPaths: string | null;
}

export const RUNS_UNEDITED: RunsEdit = { port: null, runAs: null, dropAllCaps: null, readOnlyRoot: null, stopGraceSec: null, dataPaths: null };

/** The port and user the app has, or the ones going in with a recreate that has not passed its health check yet. */
const portOf = (app: AppDto): number => app.pending?.port ?? app.port;
const runAsOf = (app: AppDto): string => app.pending?.runAs ?? app.hardening.runAs;
const pathsOf = (app: AppDto) => app.dataPaths.map((d) => d.path);

/**
 * What the card shows: what was typed in, or else what the app has. A port or user going in shows
 * as it is, whatever was typed: its recreate holds the site until it is done, so a change to it
 * now would be refused, and a save leaves it out.
 */
export function runsShown(app: AppDto, edit: RunsEdit) {
  return {
    port: app.pending?.port !== undefined ? String(app.pending.port) : (edit.port ?? String(app.port)),
    runAs: app.pending?.runAs ?? edit.runAs ?? app.hardening.runAs,
    dropAllCaps: edit.dropAllCaps ?? app.hardening.dropAllCaps,
    readOnlyRoot: edit.readOnlyRoot ?? app.hardening.readOnlyRoot,
    stopGraceSec: edit.stopGraceSec ?? String(app.hardening.stopGraceSec),
    dataPaths: edit.dataPaths ?? pathsOf(app).join('\n'),
  };
}

export interface RunsPatch {
  port?: number;
  hardening?: Partial<AppDto['hardening']>;
  dataPaths?: string[];
}

/**
 * What a save sends: only what differs from what the app has. The data folders as the card opened
 * with them would take back a folder a deploy added since, from a VOLUME of its image. Null while
 * something typed in is not valid.
 */
export function runsPatch(app: AppDto, edit: RunsEdit): RunsPatch | null {
  const shown = runsShown(app, edit);
  const port = Number(shown.port);
  const grace = Number(shown.stopGraceSec);
  if (shown.port.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (shown.stopGraceSec.trim() === '' || !Number.isInteger(grace) || grace < 0 || grace > 300) return null;
  if (!/^(\d+:\d+)?$/.test(shown.runAs)) return null;
  const hardening: Partial<AppDto['hardening']> = {};
  if (shown.runAs !== runAsOf(app)) hardening.runAs = shown.runAs;
  if (shown.dropAllCaps !== app.hardening.dropAllCaps) hardening.dropAllCaps = shown.dropAllCaps;
  if (shown.readOnlyRoot !== app.hardening.readOnlyRoot) hardening.readOnlyRoot = shown.readOnlyRoot;
  if (grace !== app.hardening.stopGraceSec) hardening.stopGraceSec = grace;
  const paths = shown.dataPaths.split('\n').map((p) => p.trim()).filter(Boolean);
  return {
    ...(port !== portOf(app) ? { port } : {}),
    ...(Object.keys(hardening).length > 0 ? { hardening } : {}),
    ...(paths.join('\n') !== pathsOf(app).join('\n') ? { dataPaths: paths } : {}),
  };
}

// --------------------------------------------------------------- New site

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
const firstRoute = (devHostname: string): RouteEdit[] => [{ key: 0, host: devHostname, match: 'none', path: '', scheme: 'https', enabled: true, devHost: true }];

/** The routes as they go: the dev hostname's on the one there is now, though the name or the server changed after the list was edited. */
export const routesOf = (draft: NewAppDraft, devHostname: string): RouteEdit[] =>
  (draft.routes ?? firstRoute(devHostname)).map((r) => (r.devHost ? { ...r, host: devHostname } : r));

/** The list as the Routes step edited it: the dev hostname's route is the admin's own once its host is typed over. */
export const editedRoutes = (rows: RouteEdit[], devHostname: string): RouteEdit[] =>
  rows.map((r) => (r.devHost && r.host !== devHostname ? { ...r, devHost: false } : r));

/** Another archive was chosen: the one before is not the one to send, so Continue waits for this one. */
export const archiveChosen = (draft: NewAppDraft): NewAppDraft => ({ ...draft, upload: null });

/** Its upload is done: into the form as it is now, so what was changed while it went up stays. */
export const archiveUploaded =
  (id: string, name: string) =>
  (draft: NewAppDraft): NewAppDraft => ({ ...draft, upload: { id, name } });

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

/** The image as the API takes it. Null while there is no archive to send: none chosen yet, or one still going up. */
const imageBody = (draft: NewAppDraft) =>
  draft.source === 'registry'
    ? { reference: draft.reference.trim(), ...(draft.registryUser ? { registryUser: draft.registryUser, registryToken: draft.registryToken } : {}) }
    : draft.upload && { uploadId: draft.upload.id };

/** What POST /api/sites takes for it, beside the fields every site has. Null while its image cannot be sent yet. */
export function appBody(draft: NewAppDraft, devHostname: string) {
  const image = imageBody(draft);
  if (!image) return null;
  const port = draft.port.trim();
  return {
    app: 'container' as const,
    image,
    ...(port ? { port: Number(port) } : {}),
    database: draft.database,
    env: envBody(draft.env),
    mounts: mountsBody(draft.mounts),
    routes: routesOf(draft, devHostname).map(({ host, match, path, scheme, enabled }) => ({ host, match, path: match === 'none' ? '' : path, scheme, enabled })),
    hardening: { dropAllCaps: draft.dropAllCaps, readOnlyRoot: draft.readOnlyRoot },
    health: { path: draft.healthPath },
  };
}
