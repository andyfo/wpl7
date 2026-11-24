// @docs get-started/first-site, get-started/quick-start, sites/container, sites/create, sites/duplicator, sites/php
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PluginDto, RecipeDto, WporgPluginDto } from '../../../shared/types';
import { useMeta, usePluginCatalog, useRecipes, useRunJob } from '../api/hooks';
import { webRootSchema, type SiteApp } from '../../../shared/schemas';
import { Button, Card, ErrorNote, Field, OutLink, Segmented, Toggle, inputClass } from '../components/ui';
import { WporgPluginSearch } from '../components/WporgPluginSearch';
import { LocaleSelect } from '../components/LocaleSelect';
import { formatBytes, localeName } from '../lib/format';
import { draftOf, keepDraft, type NewAppDraft, type NewSiteDraft } from '../lib/siteCreation';
import { AppImageStep, AppRoutesStep, AppSettingsStep, appReviewRows } from '../components/app/NewAppSteps';
import { appBody, appStepOk, createdStoppedNote, emptyAppDraft } from '../lib/appForm';
import { usePackageInspection } from '../api/packages';
import { PackageUpload, type PackageUploadValue } from '../components/duplicator/PackageUpload';
import { LeaveBehind, OldSiteFacts, WarningList, choicesBody, suggestedChoices, type LeaveBehindChoices } from '../components/imports/OldSite';

type StepId = 'name' | 'wordpress' | 'plugins' | 'leave' | 'php' | 'image' | 'settings' | 'routes' | 'review';

const STEP_LABELS: Record<StepId, string> = {
  name: 'Name & domain',
  wordpress: 'WordPress',
  plugins: 'Plugins',
  leave: 'From the old host',
  php: 'PHP',
  image: 'Image',
  settings: 'Settings',
  routes: 'Routes',
  review: 'Review',
};

/** Each type's steps. The first and the last are the same for every type, so the type can change on the first. */
const STEPS: Record<SiteApp, StepId[]> = {
  wordpress: ['name', 'wordpress', 'plugins', 'review'],
  php: ['name', 'php', 'review'],
  container: ['name', 'image', 'settings', 'routes', 'review'],
};

/** A WordPress site from a Duplicator package skips Plugins: it brings its own, and the old host's are what to leave behind. */
const PACKAGE_STEPS: StepId[] = ['name', 'wordpress', 'leave', 'review'];

const SOURCE_OPTIONS = [
  { id: 'install', label: 'New install' },
  { id: 'package', label: 'Duplicator package' },
] as const;

const APP_OPTIONS = [
  { id: 'wordpress', label: 'WordPress' },
  { id: 'php', label: 'PHP' },
  { id: 'container', label: 'Container' },
] as const;

/** A web root as the API takes it: a slash typed at either end is no folder. */
const cleanWebRoot = (raw: string) => raw.trim().replace(/^\/+|\/+$/g, '');

// Mirrors slugify() in src/lib/slug.ts - note the trailing-dash trim happens AFTER the
// truncation, otherwise a long title can produce a slug the API rejects at the last step.
function slugPreview(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function NewSite() {
  const meta = useMeta();
  // Refetched on focus: a plugin made a default in another tab is ticked here too.
  const catalog = usePluginCatalog({ refetchOnWindowFocus: true });
  // Refetched on focus: the review sends a recipe that is not set up to the Recipes page, in a new tab.
  const recipes = useRecipes({ refetchOnWindowFocus: true });
  const run = useRunJob([['sites']]);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  // Back to the form, from the page of a site that was not made: the form as it was sent, at its
  // review. Nothing to bring back after a reload, which forgets it.
  const [draft] = useState(() => {
    const jobId = (location.state as { draftOf?: unknown } | null)?.draftOf;
    return typeof jobId === 'number' ? draftOf(jobId) : null;
  });
  const [app, setApp] = useState<SiteApp>(draft?.app ?? 'wordpress');
  const [stepId, setStepId] = useState<StepId>(draft ? 'review' : 'name');
  const [title, setTitle] = useState(draft?.title ?? '');
  const [slugEdited, setSlugEdited] = useState(draft?.slugEdited ?? '');
  const [serverId, setServerId] = useState<number | null>(draft?.serverId ?? null);
  const [customDomain, setCustomDomain] = useState(draft?.customDomain ?? false);
  const [domainsText, setDomainsText] = useState(draft?.domainsText ?? '');
  const [adminUser, setAdminUser] = useState(draft?.adminUser ?? 'admin');
  const [adminEmail, setAdminEmail] = useState<string | null>(draft?.adminEmail ?? null);
  const [generatePw, setGeneratePw] = useState(draft?.generatePw ?? true);
  const [adminPassword, setAdminPassword] = useState(draft?.adminPassword ?? '');
  const [locale, setLocale] = useState<string | null>(draft?.locale ?? null);
  const [phpVersion, setPhpVersion] = useState<string | null>(draft?.phpVersion ?? null);
  const [discourageSearch, setDiscourageSearch] = useState(draft?.discourageSearch ?? true);
  /** Catalog plugins ticked or unticked by hand. The others follow the catalog's defaults. */
  const [catalogTicks, setCatalogTicks] = useState<ReadonlyMap<number, boolean>>(new Map(draft?.catalogTicks));
  const [extraPlugins, setExtraPlugins] = useState<WporgPluginDto[]>(draft?.extraPlugins ?? []);
  const [database, setDatabase] = useState(draft?.database ?? false);
  const [webRoot, setWebRoot] = useState(draft?.webRoot ?? '');
  const [container, setContainer] = useState<NewAppDraft>(draft?.container ?? emptyAppDraft());
  const [source, setSource] = useState<'install' | 'package'>(draft?.source ?? 'install');
  const [pkgUpload, setPkgUpload] = useState<PackageUploadValue | null>(draft?.pkgUpload ?? null);
  /** What of the old host to leave behind, for the upload it was chosen for; the suggestions until then. */
  const [leave, setLeave] = useState<{ for: string; choices: LeaveBehindChoices } | null>(draft?.leave ?? null);
  const fromPackage = app === 'wordpress' && source === 'package';
  const inspection = usePackageInspection(fromPackage ? (pkgUpload?.id ?? null) : null);
  const pkg = inspection.data && inspection.data.uploadId === pkgUpload?.id ? inspection.data : null;
  const leaveChoices = pkg && leave?.for === pkg.uploadId ? leave.choices : suggestedChoices(pkg?.suggestions ?? null, pkg?.constants ?? []);

  const steps = fromPackage ? PACKAGE_STEPS : STEPS[app];
  const step = Math.max(0, steps.indexOf(stepId));
  const webRootValue = cleanWebRoot(webRoot);
  const webRootOk = webRootSchema.safeParse(webRootValue).success;

  const slug = slugEdited || slugPreview(title);
  const servers = meta.data?.servers ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const effServerId = serverId ?? meta.data?.defaultServerId ?? 1;
  const selectedServer = servers.find((s) => s.id === effServerId);
  const devHostname = meta.data ? `${slug || '…'}.${selectedServer?.devDomain || meta.data.devDomain}` : '…';
  const effLocale = locale ?? meta.data?.defaultLocale ?? 'en_US';
  // A package's site starts on the offered version nearest the old site's.
  const effPhp = phpVersion ?? (fromPackage ? pkg?.suggestions?.phpVersion : null) ?? meta.data?.defaultPhpVersion ?? '8.3';
  const effAdminEmail = adminEmail ?? meta.data?.defaultAdminEmail ?? '';
  const domains = useMemo(
    () => domainsText.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
    [domainsText],
  );

  // Worked out from the catalog as it is now. Taking the defaults once, when the list first
  // loaded, left out a plugin made a default after that - in another tab, or while its switch
  // was still saving - though the list labelled it "default".
  const ticked = (p: PluginDto) => catalogTicks.get(p.id) ?? p.isDefault;
  const selectedCatalog = (catalog.data ?? []).filter(ticked);

  // What the job's recipe run will find once the plugins are in: the enabled recipes whose
  // plugin folder is among them. A zip goes by the folder inside it, as WordPress does.
  const pluginDirs = new Set([...selectedCatalog.map((p) => p.pluginDir), ...extraPlugins.map((p) => p.slug)]);
  const siteRecipes = (recipes.data ?? []).filter((r) => r.enabled && pluginDirs.has(r.plugin));

  const canNext: Record<StepId, boolean> = {
    name: title.trim().length > 0 && SLUG_RE.test(slug) && (app === 'container' || !customDomain || domains.length > 0),
    wordpress: fromPackage
      ? pkg !== null && pkg.blockedReason === null
      : adminUser.length > 0 && /.+@.+\..+/.test(effAdminEmail) && (generatePw || adminPassword.length >= 10),
    plugins: true,
    leave: true,
    php: webRootOk,
    image: appStepOk('image', container, devHostname),
    settings: appStepOk('settings', container, devHostname),
    routes: appStepOk('routes', container, devHostname),
    review: true,
  };

  const common = {
    title: title.trim(),
    slug: slug || undefined,
    serverId: multiServer ? effServerId : undefined,
    domainMode: customDomain ? 'custom' : 'dev',
    domains: customDomain ? domains : undefined,
    phpVersion: effPhp,
  };
  // A container app's is null while it has no archive to send: none chosen yet, or one still going up.
  const appPart = app === 'container' ? appBody(container, devHostname) : null;
  const appStopped = createdStoppedNote(container);
  const body =
    app === 'container'
      ? appPart && { title: common.title, slug: common.slug, serverId: common.serverId, ...appPart }
      : app === 'php'
      ? { ...common, app, database, ...(webRootValue ? { webRoot: webRootValue } : {}) }
      : fromPackage
      ? pkg && pkgUpload && {
          ...common,
          discourageSearchEngines: discourageSearch,
          package: { uploadId: pkgUpload.id, ...choicesBody(leaveChoices) },
        }
      : {
          ...common,
          locale: effLocale,
          adminUser,
          adminEmail: effAdminEmail,
          adminPassword: generatePw ? undefined : adminPassword,
          discourageSearchEngines: discourageSearch,
          plugins: {
            catalogIds: selectedCatalog.map((p) => p.id),
            extraWporgSlugs: extraPlugins.map((p) => p.slug),
          },
        };

  const create = () => {
    if (!body) return;
    const sent: NewSiteDraft = {
      app,
      title,
      slugEdited,
      serverId,
      customDomain,
      domainsText,
      adminUser,
      adminEmail,
      generatePw,
      adminPassword,
      locale,
      phpVersion,
      discourageSearch,
      catalogTicks: [...catalogTicks],
      extraPlugins,
      database,
      webRoot,
      container,
      source,
      pkgUpload,
      leave,
    };
    run.mutate(
      { path: '/api/sites', body },
      {
        // The site's own page shows it being made, then the password; the form is done with.
        onSuccess: (job) => {
          keepDraft(job.id, sent);
          const created = job.siteSlug ?? slug;
          // A read kept from an earlier site of this name, one that rolled back, is not this one.
          qc.removeQueries({ queryKey: ['site', created], exact: true });
          void navigate(`/sites/${created}`, { replace: true });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="page-title">New site</h1>
      <div className="flex gap-2 text-xs">
        {steps.map((id, i) => (
          <span
            key={id}
            className={`rounded-full px-3 py-1 font-medium ${i === step ? 'bg-[#18191c] text-white' : i < step ? 'bg-neutral-300 text-neutral-700' : 'bg-neutral-200 text-neutral-500'}`}
          >
            {i + 1}. {STEP_LABELS[id]}
          </span>
        ))}
      </div>

      <Card>
        {stepId === 'name' && (
          <div className="space-y-4">
            {/* Not a Field: a <label> hands a click anywhere on it to its first button, WordPress. */}
            <div>
              <div className="mb-1 text-sm font-medium text-neutral-700">Type</div>
              <Segmented options={APP_OPTIONS} value={app} onChange={setApp} label="Type" />
              {app === 'php' && <p className="measure mt-1 text-xs text-neutral-500">An empty site for your own PHP or HTML files.</p>}
              {app === 'container' && <p className="measure mt-1 text-xs text-neutral-500">Your own image, built elsewhere.</p>}
            </div>
            <Field label="Site title">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="My Customer's Site" />
            </Field>
            <Field
              label="Site name (slug)"
              hint={
                SLUG_RE.test(slug) || !title
                  ? 'Used for the container, database and dev hostname.'
                  : '3-32 characters: lowercase letters, digits and dashes, not starting or ending with a dash.'
              }
            >
              <input className={inputClass} value={slug} onChange={(e) => setSlugEdited(e.target.value)} />
            </Field>
            {multiServer && (
              <Field label="Server" hint="Where the site's container, files and database will live.">
                <select
                  className={inputClass}
                  value={effServerId}
                  onChange={(e) => setServerId(Number(e.target.value))}
                >
                  {servers.map((s) => (
                    <option key={s.id} value={s.id} disabled={s.status !== 'ok'}>
                      {s.name}
                      {s.status !== 'ok' ? ` (${s.status})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {app === 'container' ? (
              <div className="rounded-lg bg-neutral-50 px-4 py-3 text-sm">
                Answers at <code className="font-semibold">{devHostname}</code>
                <div className="mt-1 text-xs text-neutral-500">Its own domains come from its routes, a step further on.</div>
              </div>
            ) : (
              <Toggle checked={customDomain} onChange={setCustomDomain} label="Use my own domain instead of a dev subdomain" />
            )}
            {app === 'container' ? null : customDomain ? (
              <Field
                label="Domains (first = primary)"
                hint="Space or comma separated. DNS must point at this server for HTTPS."
                width="lg"
              >
                <input className={inputClass} value={domainsText} onChange={(e) => setDomainsText(e.target.value)} placeholder="example.com www.example.com" />
              </Field>
            ) : (
              <div className="rounded-lg bg-neutral-50 px-4 py-3 text-sm">
                Will deploy instantly at <code className="font-semibold">{devHostname}</code>
                <div className="mt-1 text-xs text-neutral-500">You can go live on a custom domain later.</div>
              </div>
            )}
          </div>
        )}

        {stepId === 'php' && (
          <div className="space-y-4">
            <Field label="PHP version">
              <PhpVersionSelect value={effPhp} versions={meta.data?.phpVersions ?? []} onChange={setPhpVersion} />
            </Field>
            <div>
              <Toggle checked={database} onChange={setDatabase} label="Database" />
              <p className="mt-1 text-xs text-neutral-500">A MariaDB database for this site. You can add one later.</p>
            </div>
            <Field
              label="Web root"
              hint={webRootOk ? 'The folder visitors reach. Empty: the site\'s folder.' : 'A folder in the site, such as public: letters, digits, ".", "_" and "-", with "/" between folders.'}
            >
              <input className={inputClass} value={webRoot} onChange={(e) => setWebRoot(e.target.value)} placeholder="public" />
            </Field>
          </div>
        )}

        {stepId === 'wordpress' && (
          <div className="space-y-4">
            {/* Not a Field: a <label> hands a click anywhere on it to its first button, New install. */}
            <div>
              <div className="mb-1 text-sm font-medium text-neutral-700">Start from</div>
              <Segmented options={SOURCE_OPTIONS} value={source} onChange={setSource} label="Start from" />
            </div>
            {source === 'package' ? (
              <>
                <PackageUpload value={pkgUpload} onChange={setPkgUpload} />
                {pkgUpload && inspection.isPending && <p className="text-sm text-neutral-500">Reading the package…</p>}
                <ErrorNote error={inspection.error} />
                {pkg?.report && (
                  <div className="rounded-lg bg-neutral-50 px-4 py-3">
                    <OldSiteFacts
                      report={pkg.report}
                      rows={[['Made by', `Duplicator ${pkg.duplicator ?? ''}${pkg.created ? ` on ${pkg.created.slice(0, 10)}` : ''}`.trim()]]}
                    />
                  </div>
                )}
                {pkg && pkg.warnings.length > 0 && <WarningList warnings={pkg.warnings} />}
                {pkg?.report && (
                  <Field label="PHP version" hint={`The old site runs PHP ${pkg.report.phpVersion.replace(/^(\d+\.\d+).*$/, '$1')}.`}>
                    <PhpVersionSelect value={effPhp} versions={meta.data?.phpVersions ?? []} onChange={setPhpVersion} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <div className="grid max-w-2xl grid-cols-2 gap-4">
                  <Field label="Admin username">
                    <input className={inputClass} value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
                  </Field>
                  <Field label="Admin email">
                    <input className={inputClass} type="email" value={effAdminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
                  </Field>
                </div>
                <Toggle checked={generatePw} onChange={setGeneratePw} label="Generate a strong admin password (shown once after creation)" />
                {!generatePw && (
                  <Field label="Admin password" hint="Minimum 10 characters.">
                    <input className={inputClass} type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
                  </Field>
                )}
                <div className="grid max-w-2xl grid-cols-2 gap-4">
                  <Field label="Language" hint="The matching WordPress language pack is installed and activated.">
                    <LocaleSelect value={effLocale} onChange={setLocale} />
                  </Field>
                  <Field label="PHP version">
                    <PhpVersionSelect value={effPhp} versions={meta.data?.phpVersions ?? []} onChange={setPhpVersion} />
                  </Field>
                </div>
              </>
            )}
            <div>
              <Toggle
                checked={discourageSearch}
                onChange={setDiscourageSearch}
                label="Discourage search engines from indexing this site"
              />
              <p className="mt-1 text-xs text-neutral-500">
                WordPress's Search engine visibility setting. Going live allows them again unless you untick it there.
              </p>
            </div>
          </div>
        )}

        {stepId === 'leave' && pkg?.report && (
          <LeaveBehind
            report={pkg.report}
            constants={pkg.constants}
            value={leaveChoices}
            onChange={(choices) => setLeave({ for: pkg.uploadId, choices })}
          />
        )}

        {stepId === 'plugins' && (
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-sm font-medium">Catalog plugins</div>
              {(catalog.data ?? []).length === 0 ? (
                <p className="text-sm text-neutral-500">
                  Catalog is empty — add wp.org slugs or upload zips on the <Link className="underline" to="/plugins">Plugins page</Link>.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {(catalog.data ?? []).map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={ticked(p)}
                        onChange={(e) => setCatalogTicks((prev) => new Map(prev).set(p.id, e.target.checked))}
                      />
                      {p.name}
                      <span className="text-xs text-neutral-400">{p.kind === 'zip' ? 'uploaded zip' : `wp.org/${p.slug}`}</span>
                      {p.isDefault && <span className="text-xs text-emerald-600">default</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">More plugins from wordpress.org</div>
              <WporgPluginSearch
                onSelect={(p) => setExtraPlugins((prev) => (prev.some((x) => x.slug === p.slug) ? prev : [...prev, p]))}
                addedSlugs={[
                  ...extraPlugins.map((p) => p.slug),
                  ...selectedCatalog.filter((p) => p.kind === 'wporg').map((p) => p.slug),
                ]}
                addedLabel="selected"
                keepOpenOnSelect
              />
              {extraPlugins.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {extraPlugins.map((p) => (
                    <span
                      key={p.slug}
                      className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-1 pl-3 pr-1.5 text-xs text-neutral-700"
                    >
                      {p.name}
                      <button
                        type="button"
                        aria-label={`Remove ${p.name}`}
                        className="rounded-full px-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
                        onClick={() => setExtraPlugins((prev) => prev.filter((x) => x.slug !== p.slug))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-neutral-500">Installed and activated during site creation.</p>
            </div>
          </div>
        )}

        {stepId === 'image' && <AppImageStep draft={container} onChange={setContainer} />}
        {stepId === 'settings' && <AppSettingsStep draft={container} onChange={setContainer} />}
        {stepId === 'routes' && <AppRoutesStep draft={container} onChange={setContainer} devHostname={devHostname} />}

        {stepId === 'review' && app === 'container' && (
          <div className="space-y-3 text-sm">
            <ReviewRow label="Title" value={title} />
            {multiServer && <ReviewRow label="Server" value={selectedServer?.name ?? `#${effServerId}`} />}
            {appReviewRows(container, devHostname, `wp_${slug.replace(/-/g, '_')}`).map(([label, value]) => (
              <ReviewRow key={label} label={label} value={value} />
            ))}
            {appStopped && <p className="text-neutral-600">{appStopped}</p>}
            <ErrorNote error={run.error} />
          </div>
        )}

        {stepId === 'review' && app === 'php' && (
          <div className="space-y-3 text-sm">
            <ReviewRow label="Type" value="PHP" />
            <ReviewRow label="Title" value={title} />
            {multiServer && <ReviewRow label="Server" value={selectedServer?.name ?? `#${effServerId}`} />}
            <ReviewRow label="Address" value={customDomain ? domains.join(', ') : devHostname} />
            <ReviewRow label="PHP" value={effPhp} />
            <ReviewRow label="Database" value={database ? `wp_${slug.replace(/-/g, '_')}` : 'None'} />
            <ReviewRow label="Web root" value={webRootValue || "The site's folder"} />
            <ErrorNote error={run.error} />
          </div>
        )}

        {stepId === 'review' && fromPackage && pkg?.report && (
          <div className="space-y-3 text-sm">
            <ReviewRow label="Title" value={title} />
            {multiServer && <ReviewRow label="Server" value={selectedServer?.name ?? `#${effServerId}`} />}
            <ReviewRow label="Address" value={customDomain ? domains.join(', ') : devHostname} />
            <ReviewRow label="Package" value={`${pkgUpload?.name ?? ''} · ${formatBytes(pkg.bytes)}`} />
            <ReviewRow label="Old address" value={pkg.report.home} />
            <ReviewRow label="PHP" value={effPhp} />
            <ReviewRow label="Search engines" value={discourageSearch ? 'discouraged (noindex)' : 'allowed to index'} />
            <ReviewRow label="Left behind" value={leftBehind(leaveChoices)} />
            <ReviewRow label="Settings" value={leaveChoices.constants.size > 0 ? [...leaveChoices.constants].join(', ') : 'none carried over'} />
            {!leaveChoices.rewritePaths && <ReviewRow label="File paths" value="kept as the old site had them" />}
            <ErrorNote error={run.error} />
          </div>
        )}

        {stepId === 'review' && app === 'wordpress' && !fromPackage && (
          <div className="space-y-3 text-sm">
            <ReviewRow label="Title" value={title} />
            {multiServer && <ReviewRow label="Server" value={selectedServer?.name ?? `#${effServerId}`} />}
            <ReviewRow label="Address" value={customDomain ? domains.join(', ') : devHostname} />
            <ReviewRow label="Admin" value={`${adminUser} <${effAdminEmail}>`} />
            <ReviewRow label="Password" value={generatePw ? 'generated (shown once)' : 'set manually'} />
            <ReviewRow label="Language" value={localeName(meta.data?.locales, effLocale)} />
            <ReviewRow label="PHP" value={effPhp} />
            <ReviewRow label="Search engines" value={discourageSearch ? 'discouraged (noindex)' : 'allowed to index'} />
            <ReviewRow
              label="Plugins"
              value={
                [...selectedCatalog.map((p) => p.name), ...extraPlugins.map((p) => p.name)].join(', ') || 'none'
              }
            />
            {recipes.data && <ReviewRow label="Recipes" value={<ReviewRecipes recipes={siteRecipes} />} />}
            <ErrorNote error={run.error} />
          </div>
        )}

        <div className="mt-6 flex justify-between border-t border-neutral-100 pt-4">
          <Button variant="secondary" onClick={() => setStepId(steps[Math.max(0, step - 1)]!)} disabled={step === 0}>
            Back
          </Button>
          {step < steps.length - 1 ? (
            <Button
              onClick={() => setStepId(steps[step + 1]!)}
              disabled={!canNext[stepId]}
              title={stepId === 'wordpress' && fromPackage && !canNext.wordpress ? (pkg?.blockedReason ?? 'Choose the package first.') : undefined}
            >
              Continue
            </Button>
          ) : (
            <Button onClick={create} busy={run.active} disabled={!body} title={body ? undefined : fromPackage ? 'Choose the package first.' : 'Choose the image archive first.'}>
              Create site
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function PhpVersionSelect({ value, versions, onChange }: { value: string; versions: string[]; onChange: (version: string) => void }) {
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {versions.map((v) => (
        <option key={v} value={v}>
          PHP {v}
        </option>
      ))}
    </select>
  );
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-neutral-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/** The recipes the new site gets, one per line; one with a value still to enter is skipped. */
function ReviewRecipes({ recipes }: { recipes: RecipeDto[] }) {
  if (recipes.length === 0) return 'none';
  return (
    <span className="block space-y-1">
      {recipes.map((r) => {
        const missing = r.inputs.filter((i) => !i.set).map((i) => i.label);
        return (
          <span key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {r.name}
            {missing.length > 0 && (
              <>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                  Not set up
                </span>
                <span className="text-xs font-normal text-neutral-500">
                  {listLabels(missing)} not entered yet, so it will be skipped.{' '}
                  <OutLink href="/plugins/recipes">Set up</OutLink>
                </span>
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** "A", "A and B", "A, B and C" - as the job log names them. */
const listLabels = (labels: string[]): string =>
  labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : (labels[0] ?? '');

/** What of the old host stays behind, in a line. */
function leftBehind(c: LeaveBehindChoices): string {
  const parts: string[] = [];
  if (c.plugins.size > 0) parts.push(`${[...c.plugins].join(', ')} deactivated`);
  const removed = [...c.dropins, ...c.muPlugins];
  if (removed.length > 0) parts.push(`${removed.join(', ')} removed`);
  return parts.join('; ') || 'nothing';
}
