// @docs sites/container
/**
 * A container app's forms, kept apart from the components so they can be tested without a browser:
 * the lists New site's steps and the Settings tab edit, what each of them sends, and what a deploy
 * from the page asks first.
 */
import type { AppDto, AppRouteDto, SiteDetail } from '../../../shared/types';
import { appHealthPathSchema, type AppRouteMatch, type AppRouteScheme } from '../../../shared/schemas';
import { describeRoute, parseAppRouterName, routeIdOfKind } from '../../../shared/apps';
import { backupBeforeUpdatesOf } from '../../../shared/updateBackups';
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

/**
 * The port the field edits: the one staged, which the next start, deploy or recreate tries, or else
 * the one that runs. `app.port` stays the running one until the app has answered on the staged one.
 */
const portOf = (app: AppDto): number => app.pending?.port ?? app.port;
/** The user going in with a recreate that has not passed its health check yet, or the app's. */
const runAsOf = (app: AppDto): string => app.pending?.runAs ?? app.hardening.runAs;
/** The data folders the card edits: the app's own. The panel keeps the image's VOLUMEs whatever a save sends. */
const ownPaths = (app: AppDto): string[] => app.dataPaths.filter((d) => !d.fromImage).map((d) => d.path);
const imagePaths = (app: AppDto): string[] => app.dataPaths.filter((d) => d.fromImage).map((d) => d.path);

/**
 * What the card shows: what was typed in, or else what the app has. A user going in shows as it
 * is, whatever was typed: its recreate holds the site until it is done, so a change to it now
 * would be refused, and a save leaves it out. A staged port waits for no job, so it can be typed
 * over. While a start, a move, or a job that makes the app's container again, is queued or
 * running the panel refuses any port (409): the card leaves that to the save's error, which shows
 * as any other.
 */
export function runsShown(app: AppDto, edit: RunsEdit) {
  return {
    port: edit.port ?? String(portOf(app)),
    runAs: app.pending?.runAs ?? edit.runAs ?? app.hardening.runAs,
    dropAllCaps: edit.dropAllCaps ?? app.hardening.dropAllCaps,
    readOnlyRoot: edit.readOnlyRoot ?? app.hardening.readOnlyRoot,
    stopGraceSec: edit.stopGraceSec ?? String(app.hardening.stopGraceSec),
    dataPaths: edit.dataPaths ?? ownPaths(app).join('\n'),
  };
}

export interface RunsPatch {
  port?: number;
  hardening?: Partial<AppDto['hardening']>;
  dataPaths?: string[];
}

/**
 * What a save sends: only what differs from what the app has. The running port sent back while
 * another is staged takes that one back. The data folders go without the image's: the panel keeps
 * those, one a deploy added since the card opened too, so one typed in is no change. Null while
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
  const fromImage = new Set(imagePaths(app));
  const paths = shown.dataPaths
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '' && !fromImage.has(p));
  return {
    ...(port !== portOf(app) ? { port } : {}),
    ...(Object.keys(hardening).length > 0 ? { hardening } : {}),
    ...(paths.join('\n') !== ownPaths(app).join('\n') ? { dataPaths: paths } : {}),
  };
}

/**
 * The Port field's hint: what runs, and the port staged while one is. Every start, deploy and
 * recreate tries it first, a settings change's too, and keeps the one that runs while the app does
 * not answer there.
 */
export function portHint(app: AppDto): string {
  const next = app.pending?.port;
  return next === undefined ? 'Where the container listens.' : `Runs on ${app.port}. The next start, deploy or recreate tries ${next}.`;
}

/** What a save that recreates the container says, and the port its new container tries when it tries a staged one. */
const recreates = (tries: number | undefined): string => (tries !== undefined ? `Saving recreates the container, which tries ${tries}.` : 'Saving recreates the container.');

/** Beside Save on a card whose save recreates the container (Environment, Mounts): the port staged on an app that runs is tried. */
export function recreateNote(app: AppDto, running: boolean): string {
  return recreates(running ? app.pending?.port : undefined);
}

/** The PORT variables, whatever their case, as a list to compare: a kept secret by its name alone. */
const portVars = (rows: { name: string; value: string | null; kept: boolean }[]): string =>
  rows
    .filter((r) => r.name.toUpperCase() === 'PORT')
    .map((r) => (r.kept ? `${r.name} kept` : `${r.name}=${r.value ?? ''}`))
    .sort()
    .join('\n');

/**
 * Beside Save on the Environment card. A PORT changed on an app that runs with no port staged may
 * move where it listens, and its recreate asks only the port it runs on: it would fail, after the
 * whole health wait. Staged first under How it runs, the new port is tried by that recreate.
 */
export function envSaveNote(app: AppDto, rows: EnvEdit[], running: boolean): string {
  const note = recreateNote(app, running);
  const before = portVars(app.env.map((v) => ({ name: v.name, value: v.value, kept: v.secret && v.set })));
  if (!running || app.pending?.port !== undefined || portVars(rows) === before) return note;
  return `${note}\nPORT changes: give the new port under How it runs first.`;
}

/** The Run as field's hint: the image's own user, which an empty field comes to, or the user going in. */
export function runAsHint(app: AppDto): string {
  const going = app.pending?.runAs;
  if (going !== undefined) return `${going || "The image's user"} is going in. Change it once that is done.`;
  return `uid:gid. Empty: the image's user (${app.imageUser.uid}:${app.imageUser.gid}).`;
}

/** The Data folders hint: the image's VOLUMEs are named, not edited, as the panel keeps them. */
export function dataPathsHint(app: AppDto): string {
  const fromImage = imagePaths(app);
  return `One path a line: kept across deploys, and in backups.${fromImage.length > 0 ? ` From the image, always kept: ${fromImage.join(', ')}.` : ''}`;
}

/**
 * What a save does, beside Save. Null while there is nothing to save: after a save the card is
 * back to the app, and a note there would read as what that save did. A port starts no job. An
 * app that runs stages it: the next start, deploy or recreate tries it, the one the rest of this
 * save starts too. The running port sent back takes the staged one back. An app that does not run
 * takes a port as it is saved.
 */
export function runsSaveNote(app: AppDto, patch: RunsPatch | null, running: boolean): string | null {
  if (!patch || Object.keys(patch).length === 0) return null;
  const recreating = Object.keys(patch).some((k) => k !== 'port');
  if (!running) return recreating ? recreates(undefined) : 'A port alone goes in when the app starts.';
  // The port the next container tries: the one this save stages, or one staged before; none once the running port is sent back.
  const tries = patch.port === undefined ? app.pending?.port : patch.port !== app.port ? patch.port : undefined;
  if (recreating) return recreates(tries);
  return tries !== undefined ? `The next start, deploy or recreate tries ${tries}.` : `It stays on ${app.port}: nothing restarts.`;
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

/**
 * Why a health path or a deploy check path would be refused, or null: the panel's own check, so
 * that a path it refuses never gets past the form. `emptyOk`: the deploy check's, where empty is none.
 */
export function healthPathProblem(path: string, emptyOk = false): string | null {
  if (emptyOk && path === '') return null;
  const parsed = appHealthPathSchema.safeParse(path);
  if (parsed.success) return null;
  const message = parsed.error.issues[0]?.message ?? 'not a path the panel can ask';
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
}

/** Whether a step may be left for the next one. */
export function appStepOk(step: 'image' | 'settings' | 'routes', draft: NewAppDraft, devHostname: string): boolean {
  if (step === 'image') return draft.source === 'registry' ? IMAGE_REFERENCE_RE.test(draft.reference.trim()) && (draft.registryUser === '') === (draft.registryToken === '') : draft.upload !== null;
  if (step === 'settings') {
    const port = draft.port.trim();
    return (
      (port === '' || (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) &&
      draft.env.every((v) => v.name !== '') &&
      draft.mounts.every((m) => m.name !== '' && m.path !== '') &&
      healthPathProblem(draft.healthPath) === null
    );
  }
  const routes = routesOf(draft, devHostname);
  return routes.length > 0 && routes.every((r) => r.host !== '');
}

/**
 * The Review step's line for an app with mounts: it is made stopped, as its mounts are empty until
 * they are filled, which only works once it exists.
 */
export const createdStoppedNote = (draft: NewAppDraft): string | null =>
  draft.mounts.length > 0 ? 'Created stopped: fill its mounts, then Start it.' : null;

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

// --------------------------------------------------------------- Deploys

/**
 * Whether a deploy from the page (Deploy now, Update, Roll back, an uploaded image) asks about a
 * backup first, and where its switch starts: on for a live app, off for a dev copy, as WordPress
 * updates have it. Only an app set to ask each time is asked: the panel reads no answer as yes.
 * Before the panel's own setting is read, it asks. Null: the setting decides, and the deploy goes
 * at once.
 */
export function deployQuestion(site: Pick<SiteDetail, 'backupBeforeUpdates' | 'isLive'>, panelSetting: unknown): { backupFirst: boolean } | null {
  return backupBeforeUpdatesOf(site.backupBeforeUpdates, panelSetting) === 'ask' ? { backupFirst: site.isLive } : null;
}

/** A deploy's body: with the answer where the app was asked, as it is where its setting decides. */
export const deployBody = <T extends object>(body: T, backupFirst: boolean | undefined): T & { backupFirst?: boolean } =>
  backupFirst === undefined ? body : { ...body, backupFirst };

/** How far an upload has gone, in whole percent. */
export const uploadPercent = (sent: number, total: number): number => Math.round((sent / Math.max(1, total)) * 100);
