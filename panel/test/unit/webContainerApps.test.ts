import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BackupBeforeUpdates } from '../../shared/schemas.js';
import type { AppDto, AppRouteDto } from '../../shared/types.js';
import {
  RUNS_UNEDITED,
  appBody,
  appStepOk,
  archiveChosen,
  archiveUploaded,
  createdStoppedNote,
  dataPathsHint,
  deployBody,
  deployQuestion,
  editEnv,
  editedRoutes,
  emptyAppDraft,
  envBody,
  envEdits,
  envSaveNote,
  healthPathProblem,
  portHint,
  recreateNote,
  replaceSecret,
  routeErrorLines,
  routesOf,
  runAsHint,
  runsPatch,
  runsSaveNote,
  runsShown,
  uploadPercent,
  type MountEdit,
  type RouteEdit,
} from '../../web/src/lib/appForm.js';
import type { NewAppDraft } from '../../web/src/lib/siteCreation.js';
import { databaseOwner, sendsTestMail } from '../../web/src/lib/siteKind.js';
import { moveBody, moveFreeze } from '../../web/src/pages/siteMove.js';
import { UploadButton } from '../../web/src/components/ui.js';

/**
 * A container app's pages: what its forms send, what a deploy asks first, and the places that tell
 * it apart from a WordPress site and a PHP site. The rules are the components', kept in lib/ to be
 * tested here; the upload button is drawn as the page draws it, since what is wrong there is where
 * the percentage goes.
 */

const app = (over: Partial<AppDto> = {}): AppDto => ({
  source: 'registry',
  reference: 'ghcr.io/example/shop:stable',
  digest: `sha256:${'1'.repeat(64)}`,
  imageId: `sha256:${'a'.repeat(64)}`,
  pendingDigest: '',
  registryUser: '',
  registryToken: { secret: true, set: false },
  port: 8000,
  env: [],
  routes: [],
  mounts: [],
  dataPaths: [{ path: '/data', dir: 'data', fromImage: false }],
  extraHosts: [],
  hardening: { dropAllCaps: false, readOnlyRoot: false, runAs: '', stopGraceSec: 20 },
  user: { uid: 1000, gid: 1000 },
  imageUser: { uid: 1000, gid: 1000 },
  health: { path: '/', host: '', deployCheckPath: '', timeoutSec: 60 },
  updates: { mode: 'auto', checkMinutes: 15, checkedAt: null, checkError: null },
  deployToken: { set: false, setAt: null },
  pending: null,
  routesState: 'serving',
  routesProblem: null,
  routeErrors: [],
  deploys: [],
  ...over,
});

const DEV = 'shop.dev.example.com';

describe('moving a container app', () => {
  it('offers no choice and sends no quiesce: the server always stops an app while it is copied', () => {
    expect(moveFreeze({ app: 'container', isLive: true })).toBeNull();
    expect(moveBody({ app: 'container', isLive: true }, 2, null)).toEqual({ targetServerId: 2 });
    expect(moveBody({ app: 'container', isLive: false }, 2, null)).toEqual({ targetServerId: 2 });
    // Whatever the dialog was left holding, there is no choice to send.
    expect(moveBody({ app: 'container', isLive: true }, 2, 'none')).toEqual({ targetServerId: 2 });
  });

  it('still offers a live WordPress site its maintenance page, and a live PHP site a stop', () => {
    expect(moveBody({ app: 'wordpress', isLive: true }, 2, null)).toEqual({ targetServerId: 2, quiesce: 'maintenance' });
    expect(moveBody({ app: 'wordpress', isLive: true }, 2, 'none')).toEqual({ targetServerId: 2, quiesce: 'none' });
    expect(moveBody({ app: 'php', isLive: true }, 2, null)).toEqual({ targetServerId: 2, quiesce: 'stop' });
    expect(moveBody({ app: 'wordpress', isLive: false }, 2, null)).toEqual({ targetServerId: 2 });
  });
});

describe("a stored secret in an app's environment", () => {
  const rows = () =>
    envEdits([
      { name: 'API_KEY', value: null, secret: true, set: true },
      { name: 'MODE', value: 'live', secret: false, set: true },
    ]);

  it('keeps its value when Secret is switched off and on again', () => {
    const [key, mode] = rows();
    const toggled = editEnv(editEnv(key!, { secret: false }), { secret: true });
    expect(envBody([toggled, mode!])).toEqual([
      { name: 'API_KEY', secret: true },
      { name: 'MODE', value: 'live', secret: false },
    ]);
    // Only switched off, it would have gone as a plain variable with no value, which is refused.
    expect(envBody([editEnv(key!, { secret: false })])).toEqual([{ name: 'API_KEY', secret: true }]);
  });

  it('keeps its name: the API finds the value it keeps by it', () => {
    const [key] = rows();
    expect(envBody([editEnv(key!, { name: 'TOKEN' })])).toEqual([{ name: 'API_KEY', secret: true }]);
  });

  it('takes a new value, name and switch once Replace is chosen', () => {
    const [key] = rows();
    const replaced = replaceSecret(key!);
    expect(replaced.value).toBe('');
    expect(envBody([editEnv(replaced, { value: 's3cret' })])).toEqual([{ name: 'API_KEY', value: 's3cret', secret: true }]);
    expect(envBody([editEnv(replaced, { name: 'TOKEN', value: 'x', secret: false })])).toEqual([{ name: 'TOKEN', value: 'x', secret: false }]);
  });
});

describe("The Environment card's note", () => {
  const env = [
    { name: 'PORT', value: '8000', secret: false, set: true },
    { name: 'MODE', value: 'live', secret: false, set: true },
  ];
  const LINE = 'PORT changes: give the new port under How it runs first.';
  const edited = (a: AppDto, change: (rows: ReturnType<typeof envEdits>) => ReturnType<typeof envEdits>) => change(envEdits(a.env));

  it('adds a line when PORT changes on an app that runs with no port staged: its recreate asks only the port it runs on', () => {
    const a = app({ env });
    const moved = edited(a, (rows) => rows.map((r) => (r.name === 'PORT' ? editEnv(r, { value: '9000' }) : r)));
    expect(envSaveNote(a, moved, true)).toBe(`Saving recreates the container.\n${LINE}`);
    // Any case, and one added or taken off.
    const lower = app({ env: [{ name: 'port', value: '8000', secret: false, set: true }] });
    expect(envSaveNote(lower, edited(lower, (rows) => rows.map((r) => editEnv(r, { value: '9000' }))), true)).toBe(`Saving recreates the container.\n${LINE}`);
    expect(envSaveNote(app(), [{ key: 1, name: 'Port', value: '9000', secret: false, kept: false }], true)).toBe(`Saving recreates the container.\n${LINE}`);
    expect(envSaveNote(a, edited(a, (rows) => rows.filter((r) => r.name !== 'PORT')), true)).toBe(`Saving recreates the container.\n${LINE}`);
  });

  it('says nothing more otherwise', () => {
    const a = app({ env });
    const moved = edited(a, (rows) => rows.map((r) => (r.name === 'PORT' ? editEnv(r, { value: '9000' }) : r)));
    // Another variable, or PORT as it was.
    expect(envSaveNote(a, edited(a, (rows) => rows.map((r) => (r.name === 'MODE' ? editEnv(r, { value: 'test' }) : r))), true)).toBe('Saving recreates the container.');
    expect(envSaveNote(a, edited(a, (rows) => rows), true)).toBe('Saving recreates the container.');
    // A port staged under How it runs: the recreate tries it.
    expect(envSaveNote(app({ env, pending: { port: 9000 } }), moved, true)).toBe('Saving recreates the container, which tries 9000.');
    // A stopped app: its recreate asks nothing.
    expect(envSaveNote(a, moved, false)).toBe('Saving recreates the container.');
    // A stored secret PORT kept as it is.
    const secret = app({ env: [{ name: 'PORT', value: null, secret: true, set: true }] });
    expect(envSaveNote(secret, envEdits(secret.env), true)).toBe('Saving recreates the container.');
  });
});

describe('How it runs', () => {
  it('sends only what changed, and nothing while a field is not valid', () => {
    expect(runsPatch(app(), RUNS_UNEDITED)).toEqual({});
    expect(runsPatch(app(), { ...RUNS_UNEDITED, port: '8080', dropAllCaps: true })).toEqual({ port: 8080, hardening: { dropAllCaps: true } });
    expect(runsPatch(app(), { ...RUNS_UNEDITED, port: '70000' })).toBeNull();
    expect(runsPatch(app(), { ...RUNS_UNEDITED, port: '' })).toBeNull();
    expect(runsPatch(app(), { ...RUNS_UNEDITED, stopGraceSec: '' })).toBeNull();
    expect(runsPatch(app(), { ...RUNS_UNEDITED, runAs: 'www-data' })).toBeNull();
  });
});

describe("How it runs: the app's data folders", () => {
  // An image with a VOLUME: the app has its folder, which the panel keeps whatever a save sends.
  const withVolume = () => app({ dataPaths: [...app().dataPaths, { path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true }] });

  it("edits the app's own, and names the image's as kept", () => {
    expect(runsShown(withVolume(), RUNS_UNEDITED).dataPaths).toBe('/data');
    expect(dataPathsHint(withVolume())).toBe('One path a line: kept across deploys, and in backups. From the image, always kept: /var/lib/shop.');
    expect(dataPathsHint(app())).toBe('One path a line: kept across deploys, and in backups.');
  });

  it("sends them without the image's", () => {
    expect(runsPatch(withVolume(), { ...RUNS_UNEDITED, dataPaths: '/data\n /cache \n\n' })).toEqual({ dataPaths: ['/data', '/cache'] });
    // One of the image's typed in is kept anyway: it is not sent, and alone it is no change.
    expect(runsPatch(withVolume(), { ...RUNS_UNEDITED, dataPaths: '/data\n/var/lib/shop\n/cache' })).toEqual({ dataPaths: ['/data', '/cache'] });
    expect(runsPatch(withVolume(), { ...RUNS_UNEDITED, dataPaths: '/var/lib/shop\n/data' })).toEqual({});
    // The app's own taken out: the image's stays.
    expect(runsPatch(withVolume(), { ...RUNS_UNEDITED, dataPaths: '' })).toEqual({ dataPaths: [] });
  });

  it('sends none unless they were changed, so one a deploy added since the card opened stays', () => {
    const edit = { ...RUNS_UNEDITED, stopGraceSec: '30' };
    expect(runsPatch(withVolume(), edit)).toEqual({ hardening: { stopGraceSec: 30 } });
    expect(runsPatch(app(), { ...RUNS_UNEDITED, dataPaths: '/data\n' })).toEqual({});
  });
});

describe('How it runs: the port', () => {
  // 9000 is staged: the next start, deploy or recreate tries it, and the app runs on 8000 until it answers there.
  const staged = () => app({ port: 8000, pending: { port: 9000 } });

  it('shows the staged port, and what runs until it goes in', () => {
    expect(runsShown(staged(), RUNS_UNEDITED).port).toBe('9000');
    expect(portHint(staged())).toBe('Runs on 8000. The next start, deploy or recreate tries 9000.');
    expect(portHint(app())).toBe('Where the container listens.');
    expect(runsShown(app(), RUNS_UNEDITED).port).toBe('8000');
  });

  it('takes another over the staged one: no job holds it', () => {
    expect(runsShown(staged(), { ...RUNS_UNEDITED, port: '9500' }).port).toBe('9500');
    expect(runsPatch(staged(), { ...RUNS_UNEDITED, port: '9500' })).toEqual({ port: 9500 });
    // The staged one again is no change.
    expect(runsPatch(staged(), { ...RUNS_UNEDITED, port: '9000' })).toEqual({});
    expect(runsPatch(staged(), RUNS_UNEDITED)).toEqual({});
  });

  it('sends the running port back, which takes the staged one back', () => {
    expect(runsPatch(staged(), { ...RUNS_UNEDITED, port: '8000' })).toEqual({ port: 8000 });
  });

  it('says a port starts no job, and that the recreate the rest starts tries it', () => {
    expect(runsSaveNote(app(), { port: 9000 }, true)).toBe('The next start, deploy or recreate tries 9000.');
    expect(runsSaveNote(app(), { port: 9000, hardening: { readOnlyRoot: true } }, true)).toBe('Saving recreates the container, which tries 9000.');
    // One staged before is tried too.
    expect(runsSaveNote(staged(), { dataPaths: [] }, true)).toBe('Saving recreates the container, which tries 9000.');
    // The running port sent back takes the staged one back: nothing waits for a deploy.
    expect(runsSaveNote(staged(), { port: 8000 }, true)).toBe('It stays on 8000: nothing restarts.');
    expect(runsSaveNote(staged(), { port: 8000, dataPaths: [] }, true)).toBe('Saving recreates the container.');
    // A stopped app takes it as it is saved, and starts on it.
    expect(runsSaveNote(app(), { port: 9000 }, false)).toBe('A port alone goes in when the app starts.');
    expect(runsSaveNote(app(), { port: 9000, hardening: { readOnlyRoot: true } }, false)).toBe('Saving recreates the container.');
    expect(runsSaveNote(app(), { dataPaths: ['/data'] }, true)).toBe('Saving recreates the container.');
  });

  it('says beside the environment and the mounts that their recreate tries a staged port', () => {
    expect(recreateNote(staged(), true)).toBe('Saving recreates the container, which tries 9000.');
    expect(recreateNote(app(), true)).toBe('Saving recreates the container.');
    // A stopped app's recreate makes the container without starting it: nothing is tried.
    expect(recreateNote(staged(), false)).toBe('Saving recreates the container.');
  });

  it('says nothing beside Save while there is nothing to save, as once a port alone was saved', () => {
    // The card after that save: what was typed is reset, and the app has 9000 staged. "Saved." stands alone.
    expect(runsSaveNote(staged(), runsPatch(staged(), RUNS_UNEDITED), true)).toBeNull();
    // A stopped app took it as it was saved.
    const stopped = app({ port: 9000 });
    expect(runsSaveNote(stopped, runsPatch(stopped, RUNS_UNEDITED), false)).toBeNull();
    // Nothing valid typed in is nothing to save either: Save is off.
    expect(runsSaveNote(app(), runsPatch(app(), { ...RUNS_UNEDITED, port: '' }), true)).toBeNull();
  });
});

describe('How it runs: the user', () => {
  it('shows a user going in with a recreate, and sends no other until it is done: that job holds the site', () => {
    const going = app({ port: 8000, pending: { runAs: '2000:2000' } });
    const typed = { ...RUNS_UNEDITED, runAs: '3000:3000', readOnlyRoot: true };
    expect(runsShown(going, typed).runAs).toBe('2000:2000');
    expect(runsPatch(going, typed)).toEqual({ hardening: { readOnlyRoot: true } });
    expect(runAsHint(going)).toBe('2000:2000 is going in. Change it once that is done.');
    // A port goes as typed: the panel refuses one while that job is queued or running (409), and the card shows why as any save error.
    expect(runsPatch(going, { ...typed, port: '9000' })).toEqual({ port: 9000, hardening: { readOnlyRoot: true } });
    // Back to the image's user, going in: an empty user is one too.
    const back = app({ hardening: { ...app().hardening, runAs: '2000:2000' }, pending: { runAs: '' } });
    expect(runsPatch(back, { ...RUNS_UNEDITED, runAs: '3000:3000' })).toEqual({});
    expect(runAsHint(back)).toBe("The image's user is going in. Change it once that is done.");
    // Once it is done, what was typed is the card's again.
    expect(runsPatch(app({ hardening: { ...app().hardening, runAs: '2000:2000' } }), typed)).toEqual({ hardening: { runAs: '3000:3000', readOnlyRoot: true } });
  });

  it("names the image's own user as what an empty Run as comes to, not the one it runs as now", () => {
    const overridden = app({ hardening: { ...app().hardening, runAs: '2000:2000' }, user: { uid: 2000, gid: 2000 }, imageUser: { uid: 1000, gid: 1000 } });
    expect(runAsHint(overridden)).toBe("uid:gid. Empty: the image's user (1000:1000).");
  });
});

describe('A health path', () => {
  // The panel's own words, as the field shows them.
  const refused = /^A path from \/ with .+\.$/;

  it('takes a query, as the panel does', () => {
    expect(healthPathProblem('/healthz')).toBeNull();
    expect(healthPathProblem('/health?deep=1')).toBeNull();
    expect(healthPathProblem('/ready?check=db,cache&x=1;y=2')).toBeNull();
  });

  it('says why the panel would refuse one', () => {
    for (const path of ['', 'health', '/health#top', '/health?q=a b', "/health?q='1'", '/health?q="1"', '/a=b']) {
      expect(healthPathProblem(path), path).toMatch(refused);
    }
  });

  it('lets the deploy check be empty, which asks none', () => {
    expect(healthPathProblem('', true)).toBeNull();
    expect(healthPathProblem('/ready?full=1', true)).toBeNull();
    expect(healthPathProblem('ready', true)).toMatch(refused);
  });

  it("keeps New site's Settings step until the panel would take it", () => {
    const draft: NewAppDraft = { ...emptyAppDraft(), healthPath: '/health?deep=1' };
    expect(appStepOk('settings', draft, DEV)).toBe(true);
    expect(appBody(draft, DEV)?.health).toEqual({ path: '/health?deep=1' });
    // A leading / was all it asked for: these went on to a create the panel refused.
    expect(appStepOk('settings', { ...draft, healthPath: '/health#top' }, DEV)).toBe(false);
    expect(appStepOk('settings', { ...draft, healthPath: '/health?q="1"' }, DEV)).toBe(false);
  });
});

describe("New site's review of an app with mounts", () => {
  const mount: MountEdit = { key: 1, name: 'keys', path: '/run/secrets/app', writable: false, inBackups: true, filledAt: null, saved: false };

  it('says it is made stopped: its mounts are filled once it exists', () => {
    expect(createdStoppedNote({ ...emptyAppDraft(), mounts: [mount] })).toBe('Created stopped: fill its mounts, then Start it.');
    expect(createdStoppedNote(emptyAppDraft())).toBeNull();
  });
});

describe('A deploy from the page', () => {
  const site = (backupBeforeUpdates: BackupBeforeUpdates | null, isLive = true) => ({ backupBeforeUpdates, isLive });

  it('asks about a backup first only where the app asks each time: the panel reads no answer as yes', () => {
    expect(deployQuestion(site(null), 'ask')).not.toBeNull();
    expect(deployQuestion(site('ask'), 'always')).not.toBeNull();
    expect(deployQuestion(site(null), 'always')).toBeNull();
    expect(deployQuestion(site(null), 'never')).toBeNull();
    expect(deployQuestion(site('always'), 'ask')).toBeNull();
    expect(deployQuestion(site('never'), 'ask')).toBeNull();
    // The panel's setting not read yet: it asks.
    expect(deployQuestion(site(null), undefined)).not.toBeNull();
  });

  it('starts the switch on for a live app and off for a dev copy', () => {
    expect(deployQuestion(site(null, true), 'ask')).toEqual({ backupFirst: true });
    expect(deployQuestion(site(null, false), 'ask')).toEqual({ backupFirst: false });
  });

  it('sends the answer where it asked, and nothing where the setting decides', () => {
    expect(deployBody({}, false)).toEqual({ backupFirst: false });
    expect(deployBody({ deployId: 4 }, true)).toEqual({ deployId: 4, backupFirst: true });
    expect(deployBody({}, undefined)).toEqual({});
    expect(deployBody({ uploadId: 'image-upload-0001' }, undefined)).toEqual({ uploadId: 'image-upload-0001' });
  });
});

describe('An upload under way', () => {
  // A busy Button draws its label clear under its spinner (components/ui.tsx): what is in it is not seen.
  const clear = (html: string) => /<span class="[^"]*\bopacity-0\b[^"]*">(.*?)<\/span>/.exec(html)?.[1];
  const rendered = (percent: number | null) => renderToStaticMarkup(createElement(UploadButton, { accept: '.tar', onFile: () => undefined, percent, children: 'Upload' }));

  it('shows how far it has gone beside its button, where it is seen', () => {
    const html = rendered(uploadPercent(420, 1000));
    expect(html).toContain('aria-busy="true"');
    expect(clear(html)).toBe('Upload');
    expect(html).toContain('>Uploading 42 %</span>');
  });

  it('shows the label alone while nothing goes up', () => {
    const html = rendered(null);
    expect(clear(html)).toBeUndefined();
    expect(html).not.toContain('Uploading');
  });
});

describe("New site's uploaded image", () => {
  const uploaded = (name: string): NewAppDraft => ({ ...emptyAppDraft(), source: 'upload', upload: { id: `${name}-upload-0001`, name: `${name}.tar` } });

  it('waits for the archive chosen last: Continue stays off until it is up', () => {
    let draft = uploaded('old');
    expect(appStepOk('image', draft, DEV)).toBe(true);
    draft = archiveChosen(draft);
    expect(appStepOk('image', draft, DEV)).toBe(false);
    draft = archiveUploaded('new-upload-0001', 'new.tar')(draft);
    expect(appStepOk('image', draft, DEV)).toBe(true);
    expect(appBody(draft, DEV)?.image).toEqual({ uploadId: 'new-upload-0001' });
  });

  it('makes no body while there is no archive to send, so the page that builds it as it renders stays up', () => {
    // "Upload an archive" clicked, nothing chosen yet.
    const picked: NewAppDraft = { ...emptyAppDraft(), source: 'upload' };
    expect(appBody(picked, DEV)).toBeNull();
    expect(appStepOk('image', picked, DEV)).toBe(false);
    // Another archive chosen, still going up.
    const going = archiveChosen(uploaded('old'));
    expect(appBody(going, DEV)).toBeNull();
    expect(appStepOk('image', going, DEV)).toBe(false);
    // An image from a registry needs no archive.
    expect(appBody({ ...going, source: 'registry', reference: 'ghcr.io/example/shop:stable' }, DEV)?.image).toEqual({ reference: 'ghcr.io/example/shop:stable' });
  });

  it('keeps what was changed while it went up', () => {
    const started = archiveChosen(uploaded('old'));
    // Meanwhile the admin switched to a registry and typed a reference in.
    const meanwhile: NewAppDraft = { ...started, source: 'registry', reference: 'ghcr.io/example/shop:stable' };
    const done = archiveUploaded('new-upload-0001', 'new.tar')(meanwhile);
    expect(done).toMatchObject({ source: 'registry', reference: 'ghcr.io/example/shop:stable' });
  });
});

describe("New site's routes", () => {
  const route = (host: string): RouteEdit => ({ key: 9, host, match: 'prefix', path: '/api', scheme: 'https', enabled: true });

  it('start on the dev hostname, which they follow to a new name or server after the list was edited', () => {
    const draft = emptyAppDraft();
    const first = routesOf(draft, DEV);
    expect(first.map((r) => r.host)).toEqual([DEV]);
    const edited = { ...draft, routes: editedRoutes([...first, route('shop.example.com')], DEV) };
    // Back on the first step, the name changes.
    const next = 'store.dev.example.com';
    expect(routesOf(edited, next).map((r) => r.host)).toEqual([next, 'shop.example.com']);
    expect(appBody(edited, next)?.routes.map((r) => r.host)).toEqual([next, 'shop.example.com']);
  });

  it('stop following it once its host is typed over', () => {
    const draft = emptyAppDraft();
    const typed = routesOf(draft, DEV).map((r) => ({ ...r, host: 'app.example.com' }));
    const edited = { ...draft, routes: editedRoutes(typed, DEV) };
    expect(routesOf(edited, 'store.dev.example.com').map((r) => r.host)).toEqual(['app.example.com']);
  });
});

describe("Traefik's refusals on the Routes card", () => {
  // Scheme both: wpl7app_r3_shop on websecure, wpl7app_r3-http_shop on web (services/appRoutes.ts).
  const routes: AppRouteDto[] = [
    { id: 3, host: 'shop.example.com', match: 'prefix', path: '/api', scheme: 'both', enabled: true, borrowedFrom: null },
    { id: 4, host: 'hooks.example.com', match: 'none', path: '', scheme: 'http', enabled: true, borrowedFrom: null },
  ];
  const refused = (router: string, message = 'bad rule', at = 1_000) => ({ router, message, at });
  const texts = (errors: AppDto['routeErrors'], tls = true) => routeErrorLines(errors, routes, tls).map((l) => l.text);

  it('name the side of the route refused: the other still answers', () => {
    expect(texts([refused('wpl7app_r3_shop')])).toEqual(['Traefik refused shop.example.com/api… (https): bad rule']);
    expect(texts([refused('wpl7app_r3-http_shop@file')])).toEqual(['Traefik refused shop.example.com/api… (http): bad rule']);
    expect(texts([refused('wpl7app_r4-http_shop')])).toEqual(['Traefik refused hooks.example.com (http): bad rule']);
    // Without TLS a route's one router is on plain http.
    expect(texts([refused('wpl7app_r3_shop')], false)).toEqual(['Traefik refused shop.example.com/api… (http): bad rule']);
  });

  it('fold a route refused on both sides into one line, with what Traefik said last', () => {
    const both = [refused('wpl7app_r3-http_shop', 'on web', 2_000), refused('wpl7app_r3_shop', 'on websecure', 1_000), refused('wpl7app_r4-http_shop')];
    expect(routeErrorLines(both, routes, true)).toEqual([
      { key: 'route-3', text: 'Traefik refused shop.example.com/api… (https and http): on web', at: 2_000 },
      { key: 'route-4', text: 'Traefik refused hooks.example.com (http): bad rule', at: 1_000 },
    ]);
  });

  it('name a router of no route here as it is', () => {
    expect(texts([refused('wpl7app_r9_shop@file'), refused('wpl7app_svc_shop')])).toEqual([
      'Traefik refused wpl7app_r9_shop@file: bad rule',
      'Traefik refused wpl7app_svc_shop: bad rule',
    ]);
  });
});

describe('what a container app is not', () => {
  it("has a database of the app's, not of WordPress", () => {
    expect(databaseOwner('container')).toBe('App');
    expect(databaseOwner('php')).toBe('Site');
    expect(databaseOwner('wordpress')).toBe('WordPress');
  });

  it("sends no test message: it has neither wp_mail() nor the site image's mail()", () => {
    expect(sendsTestMail({ app: 'container', status: 'running' })).toBe(false);
    expect(sendsTestMail({ app: 'php', status: 'running' })).toBe(true);
    expect(sendsTestMail({ app: 'wordpress', status: 'running' })).toBe(true);
    expect(sendsTestMail({ app: 'wordpress', status: 'stopped' })).toBe(false);
  });
});
