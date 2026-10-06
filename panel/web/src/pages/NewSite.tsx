// @docs get-started/first-site, get-started/quick-start, sites/create
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { RecipeDto, WporgPluginDto } from '../../../shared/types';
import { useMeta, usePluginCatalog, useRecipes, useRunJob, isTerminal } from '../api/hooks';
import { Button, Card, CopyField, ErrorNote, ExternalLinkIcon, Field, OutLink, Toggle, inputClass } from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { WporgPluginSearch } from '../components/WporgPluginSearch';
import { LocaleSelect } from '../components/LocaleSelect';
import { localeName } from '../lib/format';

const STEPS = ['Name & domain', 'WordPress', 'Plugins', 'Review'];

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
  const catalog = usePluginCatalog();
  // Refetched on focus: the review sends a recipe that is not set up to the Recipes page, in a new tab.
  const recipes = useRecipes({ refetchOnWindowFocus: true });
  const run = useRunJob([['sites']]);

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [slugEdited, setSlugEdited] = useState('');
  const [serverId, setServerId] = useState<number | null>(null);
  const [customDomain, setCustomDomain] = useState(false);
  const [domainsText, setDomainsText] = useState('');
  const [adminUser, setAdminUser] = useState('admin');
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [generatePw, setGeneratePw] = useState(true);
  const [adminPassword, setAdminPassword] = useState('');
  const [locale, setLocale] = useState<string | null>(null);
  const [phpVersion, setPhpVersion] = useState<string | null>(null);
  const [discourageSearch, setDiscourageSearch] = useState(true);
  const [selectedCatalog, setSelectedCatalog] = useState<Set<number>>(new Set());
  const [extraPlugins, setExtraPlugins] = useState<WporgPluginDto[]>([]);
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  const slug = slugEdited || slugPreview(title);
  const servers = meta.data?.servers ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const effServerId = serverId ?? meta.data?.defaultServerId ?? 1;
  const selectedServer = servers.find((s) => s.id === effServerId);
  const devHostname = meta.data ? `${slug || '…'}.${selectedServer?.devDomain || meta.data.devDomain}` : '…';
  const effLocale = locale ?? meta.data?.defaultLocale ?? 'en_US';
  const effPhp = phpVersion ?? meta.data?.defaultPhpVersion ?? '8.3';
  const effAdminEmail = adminEmail ?? meta.data?.defaultAdminEmail ?? '';
  const domains = useMemo(
    () => domainsText.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
    [domainsText],
  );

  // What the job's recipe run will find once the plugins are in: the enabled recipes whose
  // plugin folder is among them. A zip goes by the folder inside it, as WordPress does.
  const pluginDirs = new Set([
    ...[...selectedCatalog].map((id) => catalog.data?.find((p) => p.id === id)?.pluginDir),
    ...extraPlugins.map((p) => p.slug),
  ]);
  const siteRecipes = (recipes.data ?? []).filter((r) => r.enabled && pluginDirs.has(r.plugin));

  // Preselect catalog defaults once loaded.
  if (!defaultsApplied && catalog.data) {
    setSelectedCatalog(new Set(catalog.data.filter((p) => p.isDefault).map((p) => p.id)));
    setDefaultsApplied(true);
  }

  const canNext = [
    title.trim().length > 0 && SLUG_RE.test(slug) && (!customDomain || domains.length > 0),
    adminUser.length > 0 && /.+@.+\..+/.test(effAdminEmail) && (generatePw || adminPassword.length >= 10),
    true,
    true,
  ][step];

  const create = () => {
    run.mutate({
      path: '/api/sites',
      body: {
        title: title.trim(),
        slug: slug || undefined,
        serverId: multiServer ? effServerId : undefined,
        domainMode: customDomain ? 'custom' : 'dev',
        domains: customDomain ? domains : undefined,
        phpVersion: effPhp,
        locale: effLocale,
        adminUser,
        adminEmail: effAdminEmail,
        adminPassword: generatePw ? undefined : adminPassword,
        discourageSearchEngines: discourageSearch,
        plugins: {
          catalogIds: [...selectedCatalog],
          extraWporgSlugs: extraPlugins.map((p) => p.slug),
        },
      },
    });
  };

  const oneTimePassword = (run.job?.result as { adminPassword?: string } | null)?.adminPassword;
  const done = isTerminal(run.job?.status);

  if (run.jobId !== null) {
    return (
      <div className="space-y-6">
        <h1 className="page-title">Creating “{title}”</h1>
        <Card>
          <div className="space-y-4">
            <JobProgress job={run.job} logs={run.logs} />
            {done && run.job?.status === 'succeeded' && (
              <div className="space-y-3">
                <p className="text-sm text-emerald-700">
                  Site created:{' '}
                  <a
                    className="inline-flex items-center gap-1 underline"
                    href={(run.job.result as { url?: string })?.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {(run.job.result as { url?: string })?.url}
                    <ExternalLinkIcon />
                  </a>
                </p>
                {oneTimePassword && (
                  <div>
                    <p className="mb-1 text-sm font-medium">
                      WordPress admin password for “{adminUser}” — shown only here:
                    </p>
                    <CopyField value={oneTimePassword} />
                  </div>
                )}
                <Link to={`/sites/${slug}`}>
                  <Button>Open site page</Button>
                </Link>
              </div>
            )}
            {done && run.job?.status !== 'succeeded' && (
              <Button variant="secondary" onClick={() => run.reset()}>
                Back to the form
              </Button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="page-title">New site</h1>
      <div className="flex gap-2 text-xs">
        {STEPS.map((label, i) => (
          <span
            key={label}
            className={`rounded-full px-3 py-1 font-medium ${i === step ? 'bg-[#18191c] text-white' : i < step ? 'bg-neutral-300 text-neutral-700' : 'bg-neutral-200 text-neutral-500'}`}
          >
            {i + 1}. {label}
          </span>
        ))}
      </div>

      <Card>
        {step === 0 && (
          <div className="space-y-4">
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
            <Toggle checked={customDomain} onChange={setCustomDomain} label="Use my own domain instead of a dev subdomain" />
            {customDomain ? (
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

        {step === 1 && (
          <div className="space-y-4">
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
                <select className={inputClass} value={effPhp} onChange={(e) => setPhpVersion(e.target.value)}>
                  {(meta.data?.phpVersions ?? []).map((v) => (
                    <option key={v} value={v}>
                      PHP {v}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <Toggle
                checked={discourageSearch}
                onChange={setDiscourageSearch}
                label="Discourage search engines from indexing this site"
              />
              <p className="mt-1 text-xs text-neutral-500">
                WordPress's Search engine visibility setting. Going live does not change it.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
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
                        checked={selectedCatalog.has(p.id)}
                        onChange={(e) => {
                          const next = new Set(selectedCatalog);
                          if (e.target.checked) next.add(p.id);
                          else next.delete(p.id);
                          setSelectedCatalog(next);
                        }}
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
                  ...[...selectedCatalog].flatMap((id) => {
                    const row = catalog.data?.find((p) => p.id === id);
                    return row && row.kind === 'wporg' ? [row.slug] : [];
                  }),
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

        {step === 3 && (
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
                [
                  ...[...selectedCatalog].map((id) => catalog.data?.find((p) => p.id === id)?.name ?? `#${id}`),
                  ...extraPlugins.map((p) => p.name),
                ].join(', ') || 'none'
              }
            />
            {recipes.data && <ReviewRow label="Recipes" value={<ReviewRecipes recipes={siteRecipes} />} />}
            <ErrorNote error={run.error} />
          </div>
        )}

        <div className="mt-6 flex justify-between border-t border-neutral-100 pt-4">
          <Button variant="secondary" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!canNext}>
              Continue
            </Button>
          ) : (
            <Button onClick={create} disabled={run.isPending}>
              Create site
            </Button>
          )}
        </div>
      </Card>
    </div>
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
