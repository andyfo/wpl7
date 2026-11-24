// @docs sites/import
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportDto, JobDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { useMeta } from '../../api/hooks';
import { useFollowJob } from '../jobConsole/context';
import { localeName } from '../../lib/format';
import { Button, Card, ConfirmDialog, ErrorNote, Field, inputClass } from '../ui';
import { LeaveBehind, OldSiteFacts, WarningList, choicesBody, suggestedChoices } from './OldSite';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Step 2: what the old site reported, what stands in the way, and the choices - the new site's
 * name and PHP, and what of the old host to leave behind.
 */
export function ImportConfirm({ imp }: { imp: ImportDto }) {
  const meta = useMeta();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const report = imp.report!;
  const s = imp.suggestions!;
  const [title, setTitle] = useState(s.title);
  const [slug, setSlug] = useState(s.slug);
  const [serverId, setServerId] = useState<number | null>(null);
  const [phpVersion, setPhpVersion] = useState<string | null>(s.phpVersion);
  const [choices, setChoices] = useState(() => suggestedChoices(s, imp.constants));
  const [deleting, setDeleting] = useState(false);
  const follow = useFollowJob();

  const remove = useMutation({
    mutationFn: () => api(`/api/imports/${imp.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void navigate('/sites/import');
    },
  });

  const servers = meta.data?.servers ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const effServerId = serverId ?? meta.data?.defaultServerId ?? 1;
  const start = useMutation({
    mutationFn: async () => {
      const res = await api<{ job: JobDto }>(`/api/imports/${imp.id}/run`, {
        method: 'POST',
        body: {
          title: title.trim(),
          slug,
          ...(multiServer ? { serverId: effServerId } : {}),
          ...(phpVersion ? { phpVersion } : {}),
          ...choicesBody(choices),
        },
      });
      follow(res.job, { refresh: [['import', imp.id], ['imports']] });
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['import', imp.id] });
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });
  const blocking = imp.warnings.filter((w) => w.blocking);
  const reason = imp.blockedReason ?? (!SLUG_RE.test(slug) ? 'The site name is not valid.' : !title.trim() ? 'The site needs a title.' : null);
  const oldPhp = /^(\d+\.\d+)/.exec(report.phpVersion)?.[1] ?? report.phpVersion;

  return (
    <div className="space-y-6">
      <Card title="The old site">
        <OldSiteFacts report={report} language={localeName(meta.data?.locales, report.locale)} searchEnginesAllowed={report.searchEnginesAllowed} />
      </Card>

      {imp.warnings.length > 0 && (
        <Card title="Before you import">
          <WarningList warnings={imp.warnings} />
        </Card>
      )}

      <Card title="The new site">
        <div className="space-y-4">
          <Field label="Site title">
            <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label="Site name (slug)"
            hint={SLUG_RE.test(slug) ? 'Used for the container, database and dev address.' : '3-32 characters: a-z, 0-9 and dashes, not at either end.'}
          >
            <input className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          {multiServer && (
            <Field label="Server">
              <select className={inputClass} value={effServerId} onChange={(e) => setServerId(Number(e.target.value))}>
                {servers.map((srv) => (
                  <option key={srv.id} value={srv.id} disabled={srv.status !== 'ok'}>
                    {srv.name}
                    {srv.status !== 'ok' ? ` (${srv.status})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="grid max-w-2xl grid-cols-2 gap-4">
            <Field label="PHP version" hint={`The old site runs PHP ${oldPhp}.`}>
              <select className={inputClass} value={phpVersion ?? ''} onChange={(e) => setPhpVersion(e.target.value)}>
                {(meta.data?.phpVersions ?? []).map((v) => (
                  <option key={v} value={v}>
                    PHP {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      </Card>

      <Card title="From the old host">
        <LeaveBehind report={report} constants={imp.constants} value={choices} onChange={setChoices} />
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <span title={reason ?? undefined} className="inline-block">
          <Button disabled={reason !== null || start.isPending} onClick={() => start.mutate()}>
            Start import
          </Button>
        </span>
        <Button variant="secondary" onClick={() => setDeleting(true)}>
          Delete import
        </Button>
      </div>
      {reason && <p className={`text-sm ${blocking.length > 0 ? 'text-red-700' : 'text-neutral-500'}`}>{reason}</p>}
      <ErrorNote error={start.error ?? remove.error} />
      {deleting && (
        <ConfirmDialog
          title="Delete import"
          message="The old site's plugin stops answering this import. Nothing was copied yet."
          confirmLabel="Delete import"
          onConfirm={() => remove.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
