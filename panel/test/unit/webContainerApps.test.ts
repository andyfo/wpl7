import { describe, expect, it } from 'vitest';
import type { AppDto, AppRouteDto } from '../../shared/types.js';
import {
  RUNS_UNEDITED,
  appBody,
  appStepOk,
  archiveChosen,
  archiveUploaded,
  editEnv,
  editedRoutes,
  emptyAppDraft,
  envBody,
  envEdits,
  replaceSecret,
  routeErrorLines,
  routesOf,
  runsPatch,
  runsShown,
  type RouteEdit,
} from '../../web/src/lib/appForm.js';
import type { NewAppDraft } from '../../web/src/lib/siteCreation.js';
import { databaseOwner, sendsTestMail } from '../../web/src/lib/siteKind.js';
import { moveBody, moveFreeze } from '../../web/src/pages/siteMove.js';

/**
 * A container app's pages: what its forms send, and the places that tell it apart from a
 * WordPress site and a PHP site. The rules are the components', kept in lib/ to be tested here.
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

describe('How it runs', () => {
  it('sends no data folders unless they were changed, so one a deploy added since the card opened stays', () => {
    // An image with a VOLUME was deployed while the card was open: the app has its folder now.
    const now = app({ dataPaths: [...app().dataPaths, { path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true }] });
    const edit = { ...RUNS_UNEDITED, stopGraceSec: '30' };
    expect(runsPatch(now, edit)).toEqual({ hardening: { stopGraceSec: 30 } });
    expect(runsShown(now, edit).dataPaths).toBe('/data\n/var/lib/shop');
  });

  it('sends the data folders as they were typed in once they were changed', () => {
    expect(runsPatch(app(), { ...RUNS_UNEDITED, dataPaths: '/data\n /cache \n\n' })).toEqual({ dataPaths: ['/data', '/cache'] });
    expect(runsPatch(app(), { ...RUNS_UNEDITED, dataPaths: '/data\n' })).toEqual({});
  });

  it('sends only what changed, and nothing while a field is not valid', () => {
    expect(runsPatch(app(), RUNS_UNEDITED)).toEqual({});
    expect(runsPatch(app(), { ...RUNS_UNEDITED, port: '8080', dropAllCaps: true })).toEqual({ port: 8080, hardening: { dropAllCaps: true } });
    expect(runsPatch(app(), { ...RUNS_UNEDITED, port: '70000' })).toBeNull();
    expect(runsPatch(app(), { ...RUNS_UNEDITED, port: '' })).toBeNull();
    expect(runsPatch(app(), { ...RUNS_UNEDITED, stopGraceSec: '' })).toBeNull();
    expect(runsPatch(app(), { ...RUNS_UNEDITED, runAs: 'www-data' })).toBeNull();
  });

  it('shows a port and a user going in with a recreate, and does not send them again', () => {
    const going = app({ port: 8000, pending: { port: 8080, runAs: '2000:2000' } });
    expect(runsShown(going, RUNS_UNEDITED)).toMatchObject({ port: '8080', runAs: '2000:2000' });
    expect(runsPatch(going, { ...RUNS_UNEDITED, readOnlyRoot: true })).toEqual({ hardening: { readOnlyRoot: true } });
    // The recreate failed: the app keeps its port, and the card shows it.
    expect(runsShown(app({ port: 8000, pending: null }), RUNS_UNEDITED).port).toBe('8000');
  });

  it('sends no port or user while one is going in: its recreate holds the site, so the change would be refused', () => {
    const going = app({ port: 8000, pending: { port: 8080, runAs: '2000:2000' } });
    // Typed in before the recreate began: the card shows what is going in, and a save leaves both out.
    const typed = { ...RUNS_UNEDITED, port: '9000', runAs: '3000:3000', readOnlyRoot: true };
    expect(runsShown(going, typed)).toMatchObject({ port: '8080', runAs: '2000:2000' });
    expect(runsPatch(going, typed)).toEqual({ hardening: { readOnlyRoot: true } });
    // The port that runs now is another change too.
    expect(runsPatch(going, { ...RUNS_UNEDITED, port: '8000', runAs: '' })).toEqual({});
    // Back to the image's user, going in: an empty user is one too.
    expect(runsPatch(app({ hardening: { ...app().hardening, runAs: '2000:2000' }, pending: { runAs: '' } }), { ...RUNS_UNEDITED, runAs: '3000:3000' })).toEqual({});
    // Once it is done, what was typed is the card's again.
    expect(runsPatch(app({ port: 8080 }), typed)).toEqual({ port: 9000, hardening: { runAs: '3000:3000', readOnlyRoot: true } });
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
