import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  SCAN_ON_FINDING_INFO,
  SECURITY_LEVEL_INFO,
  effectivePolicy,
  scanOnFindingModes,
  type CustomRule,
  type ScanOnFinding,
  type SecurityLevel,
  type SecurityOverrides,
} from '../../../../shared/security';
import type { SiteSecurityDto } from '../../../../shared/types';
import { useScanSettings, useSiteSecurity, useUpdateSiteSecurity } from '../../api/security';
import { Button, ErrorNote, Modal, Segmented, Spinner, inputClass } from '../ui';
import { CustomRulesEditor, ruleProblems, type DraftRule } from './CustomRules';
import { PolicyEditor } from './PolicyEditor';

interface Draft {
  level: SecurityLevel | null;
  overrides: SecurityOverrides;
  customRules: DraftRule[];
  scanEnabled: boolean | null;
  scanOnFinding: ScanOnFinding | null;
}

const draftOf = (s: SiteSecurityDto): Draft => ({
  level: s.level,
  overrides: s.overrides,
  customRules: s.customRules,
  scanEnabled: s.scan.enabled,
  scanOnFinding: s.scan.onFinding,
});
const protectionOf = (d: Draft) => JSON.stringify([d.level, d.overrides, d.customRules]);
const scanOf = (d: Draft) => JSON.stringify([d.scanEnabled, d.scanOnFinding]);

/** Why a site's protection is not what it says - on its tab, and over the form that changes it. */
export function ProtectionNotices({ s }: { s: SiteSecurityDto }) {
  return (
    <>
      {s.status.unprotected && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>Not protected as set.</b> {s.status.unprotected}
        </div>
      )}
      {s.rejections.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <b>Traefik would not use {s.rejections.length === 1 ? 'one of this site’s rules' : `${s.rejections.length} of this site’s rules`}</b>
          ; everything else is in force.
          <ul className="mt-1 list-disc pl-5 text-xs">
            {s.rejections.map((r) => (
              <li key={r.router} className="break-words">
                <code>{r.router}</code>: {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * A site's security settings, in a sheet over the page that opened it - its Security tab, or
 * the list on Sites -> Security of the sites with settings of their own: the protection level,
 * every rule and limit with where it comes from, the site's own rules, and its malware scans.
 * One Save for all of it.
 */
export function SiteSecuritySettings({ slug, title, onClose }: { slug: string; title: string; onClose: () => void }) {
  const sec = useSiteSecurity(slug);
  const update = useUpdateSiteSecurity(slug);
  const scanSettings = useScanSettings(slug);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A fresh answer from the server (the minute's poll, a change elsewhere) replaces the form
  // only while the form holds nothing unsaved - that is, while it still equals the last answer.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (!sec.data) return;
    const next = draftOf(sec.data);
    setDraft((d) => (d === null || JSON.stringify(d) === lastSaved.current ? next : d));
    lastSaved.current = JSON.stringify(next);
  }, [sec.data]);

  const preview = useMemo(() => {
    if (!sec.data || !draft) return null;
    return effectivePolicy(sec.data.fleet, {
      level: draft.level,
      overrides: draft.overrides,
      customRules: draft.customRules.map((r, i) => ({ ...r, id: r.id ?? `new${i}` })) as CustomRule[],
    });
  }, [sec.data, draft]);

  const saved = sec.data ? draftOf(sec.data) : null;
  const protectionDirty = draft !== null && saved !== null && protectionOf(draft) !== protectionOf(saved);
  const scanDirty = draft !== null && saved !== null && scanOf(draft) !== scanOf(saved);
  const dirty = protectionDirty || scanDirty;
  const invalid = draft !== null && draft.customRules.some((r) => ruleProblems(r).length > 0);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      // The protection first, then the scans. Whichever went through stays saved if the other
      // fails: the form then differs from what is stored only in what is still to save.
      if (protectionDirty) {
        const stored = draftOf(await update.mutateAsync({ level: draft.level, overrides: draft.overrides, customRules: draft.customRules }));
        // What came back is what is stored now - new rules have their ids - so a second Save,
        // after the scans' failed, sends them as the same rules rather than as new ones.
        lastSaved.current = JSON.stringify(stored);
        setDraft((d) => (d ? { ...d, level: stored.level, overrides: stored.overrides, customRules: stored.customRules } : d));
      }
      if (scanDirty) await scanSettings.mutateAsync({ enabled: draft.scanEnabled, onFinding: draft.scanOnFinding });
      onClose();
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  };

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <div className="mr-auto min-w-0">
        <ErrorNote error={error} />
        {invalid && <span className="text-xs text-red-700">A rule needs fixing first.</span>}
      </div>
      <Button variant="secondary" onClick={onClose}>
        {dirty ? 'Cancel' : 'Close'}
      </Button>
      <Button disabled={!dirty || invalid || saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );

  return (
    <Modal sheet title={`Security settings: ${title}`} onClose={onClose} dismissible={!dirty} footer={footer}>
      {sec.error ? (
        <ErrorNote error={sec.error} />
      ) : !sec.data || !draft || !preview ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          <ProtectionNotices s={sec.data} />
          <div className="space-y-8">
            <Section title="Protection">
              <Segmented
                label="Protection level"
                options={[
                  { id: 'default', label: `Use the default (${SECURITY_LEVEL_INFO[sec.data.fleet.level].label})` },
                  { id: 'off', label: 'Off' },
                  { id: 'standard', label: 'Standard' },
                  { id: 'strict', label: 'Strict' },
                ]}
                value={draft.level ?? 'default'}
                onChange={(v) => setDraft({ ...draft, level: v === 'default' ? null : (v as SecurityLevel) })}
              />
              <p className="measure mt-2 text-sm text-neutral-600">{SECURITY_LEVEL_INFO[preview.level].summary}</p>
              {draft.level === null && sec.data.fleet.level !== 'off' && (
                <p className="mt-1 text-xs text-neutral-500">The default is set on Sites → Security → Settings; changes made there reach this site at once.</p>
              )}
              <div className="mt-5">
                <PolicyEditor
                  policy={preview}
                  overrides={draft.overrides}
                  scope="site"
                  onChange={(overrides) => setDraft({ ...draft, overrides })}
                  hits={sec.data.blocked7d}
                />
              </div>
            </Section>

            <Section title="This site's own rules">
              <CustomRulesEditor rules={draft.customRules} onChange={(customRules) => setDraft({ ...draft, customRules })} hits={sec.data.blocked7d} />
              {preview.level === 'off' && draft.customRules.length > 0 && (
                <p className="mt-2 text-xs text-amber-800">With protection off, these rules are kept but not in force.</p>
              )}
            </Section>

            <Section title="Malware scans">
              <ScanFields s={sec.data} draft={draft} onChange={(next) => setDraft({ ...draft, ...next })} />
            </Section>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-neutral-200 pt-6 first:border-t-0 first:pt-0">
      <h4 className="panel-card-title mb-3">{title}</h4>
      {children}
    </section>
  );
}

function ScanFields({
  s,
  draft,
  onChange,
}: {
  s: SiteSecurityDto;
  draft: Draft;
  onChange: (next: Pick<Draft, 'scanEnabled' | 'scanOnFinding'>) => void;
}) {
  const { defaults } = s.scan;
  const onFinding = draft.scanOnFinding ?? defaults.onFinding;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-sm font-medium text-neutral-700">Scan this site</div>
          <Segmented
            small
            label="Scan this site"
            options={[
              { id: 'follow', label: `Follow the default (${defaults.enabled ? 'on' : 'off'})` },
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
            ]}
            value={draft.scanEnabled === null ? 'follow' : draft.scanEnabled ? 'on' : 'off'}
            onChange={(v) => onChange({ scanEnabled: v === 'follow' ? null : v === 'on', scanOnFinding: draft.scanOnFinding })}
          />
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">On a finding</span>
          <select
            className={`${inputClass} max-w-sm`}
            value={draft.scanOnFinding ?? 'follow'}
            onChange={(e) => onChange({ scanEnabled: draft.scanEnabled, scanOnFinding: e.target.value === 'follow' ? null : (e.target.value as ScanOnFinding) })}
          >
            <option value="follow">Follow the default ({SCAN_ON_FINDING_INFO[defaults.onFinding].label.toLowerCase()})</option>
            {scanOnFindingModes.map((m) => (
              <option key={m} value={m}>
                {SCAN_ON_FINDING_INFO[m].label}
              </option>
            ))}
          </select>
          <span className="measure mt-1 block text-xs text-neutral-500">{SCAN_ON_FINDING_INFO[onFinding].description}</span>
        </label>
      </div>
      <p className="text-xs text-neutral-500">How often a site is scanned, and with how much memory and time, is set for every site on Settings → Malware scans.</p>
    </div>
  );
}
