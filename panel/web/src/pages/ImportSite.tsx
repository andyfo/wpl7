import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportConnectionCodeDto, ImportDto } from '../../../shared/types';
import { api } from '../api/client';
import { useImport } from '../api/hooks';
import { Button, Card, CopyField, ErrorNote, Spinner, Toggle } from '../components/ui';
import { ImportConfirm } from '../components/imports/ImportConfirm';
import { ImportsList } from '../components/imports/ImportsList';
import { IMPORT_STATUS_LABEL, IMPORT_STEPS, importStep } from '../lib/imports';

/** Start the zip's download in the background: the page stays where it is. */
function downloadPlugin(id: number): void {
  const a = document.createElement('a');
  a.href = `/api/imports/${id}/plugin`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Sites → Import site: bring an existing WordPress site in through the migration plugin. Connect
 * (download the plugin, install it on the old site), Confirm (what the old site reported, and the
 * choices), Import (the pull and the set-up), Done. `?id=` is the import the page is about.
 */
export function ImportSite() {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('id'));
  const id = Number.isInteger(raw) && raw > 0 ? raw : null;
  const imp = useImport(id);
  const step = id === null ? 0 : imp.data ? importStep(imp.data.status) : 0;

  return (
    <div className="space-y-6">
      <h1 className="page-title">Import a site</h1>
      <div className="flex flex-wrap gap-2 text-xs">
        {IMPORT_STEPS.map((label, i) => (
          <span
            key={label}
            className={`rounded-full px-3 py-1 font-medium ${i === step ? 'bg-[#18191c] text-white' : i < step ? 'bg-neutral-300 text-neutral-700' : 'bg-neutral-200 text-neutral-500'}`}
          >
            {i + 1}. {label}
          </span>
        ))}
      </div>

      {id !== null && imp.isPending && <Spinner />}
      <ErrorNote error={imp.error} />
      {id === null && <ConnectStep imp={null} onCreated={(created) => setParams({ id: String(created.id) })} />}
      {imp.data && step === 0 && <ConnectStep imp={imp.data} onCreated={() => undefined} />}
      {imp.data && step === 1 && <ImportConfirm imp={imp.data} />}
      {imp.data && step >= 2 && <ImportStatusCard imp={imp.data} />}
      {id === null && <ImportsList />}
    </div>
  );
}

/** Step 1: the plugin, and the wait for the old site to connect with it. */
function ConnectStep({ imp, onCreated }: { imp: ImportDto | null; onCreated: (created: ImportDto) => void }) {
  const qc = useQueryClient();
  const [allowHttp, setAllowHttp] = useState(false);
  const create = useMutation({
    mutationFn: () => api<ImportDto>('/api/imports', { method: 'POST', body: { allowHttp } }),
    onSuccess: (created) => {
      qc.setQueryData(['import', created.id], created);
      void qc.invalidateQueries({ queryKey: ['imports'] });
      onCreated(created);
      downloadPlugin(created.id);
    },
  });

  if (imp?.status === 'expired') {
    return (
      <Card title="Connect the old site">
        <div className="space-y-3">
          <ErrorNote
            error={imp.connectedAt ? 'This import has ended.' : 'This import has ended: the old site did not connect in time.'}
          />
          <Link to="/sites/import">
            <Button>Start over</Button>
          </Link>
        </div>
      </Card>
    );
  }

  const locked = imp !== null;
  return (
    <Card title="Connect the old site">
      <div className="space-y-4 text-sm">
        <div>
          <span title={locked ? 'Set before the plugin is downloaded.' : undefined} className="inline-block">
            <Toggle
              checked={imp ? imp.allowHttp : allowHttp}
              onChange={setAllowHttp}
              disabled={locked}
              label={
                <span>
                  The old site has no HTTPS
                  <span className="block text-xs text-neutral-500">
                    {locked ? 'Set before the plugin is downloaded.' : 'Allows plain HTTP. What the panel pulls can then be read on the way.'}
                  </span>
                </span>
              }
            />
          </span>
        </div>
        {imp ? (
          <a
            className="button-primary inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
            href={`/api/imports/${imp.id}/plugin`}
            download
          >
            Download plugin
          </a>
        ) : (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            Download plugin
          </Button>
        )}
        <ErrorNote error={create.error} />
        <ol className="list-decimal space-y-1 pl-5 text-neutral-700">
          <li>
            Install the zip on the old site: <b>Plugins → Add New → Upload Plugin</b>.
          </li>
          <li>Activate it.</li>
          <li>Come back here. The old site connects on its own.</li>
        </ol>
        {imp && (
          <div className="flex items-center gap-2 text-neutral-600">
            <Spinner /> Waiting for the old site…
          </div>
        )}
        {imp?.canDownload && <ConnectionCode id={imp.id} />}
      </div>
    </Card>
  );
}

/** For the plugin's own form, when it came without its connection file. Fetched only when opened. */
function ConnectionCode({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const code = useQuery({
    queryKey: ['import', id, 'code'],
    queryFn: () => api<ImportConnectionCodeDto>(`/api/imports/${id}/code`),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <details className="text-neutral-600" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer">The plugin asks for a connection code</summary>
      <div className="mt-2 space-y-2">
        {code.isPending && open && <Spinner />}
        <ErrorNote error={code.error} />
        {code.data && (
          <>
            <div className="text-xs font-medium text-neutral-500">Panel address</div>
            <CopyField value={code.data.panel} tone="plain" />
            <div className="text-xs font-medium text-neutral-500">Connection code</div>
            <CopyField value={code.data.code} />
          </>
        )}
      </div>
    </details>
  );
}

/** Steps 3 and 4 for now: where the import stands. */
function ImportStatusCard({ imp }: { imp: ImportDto }) {
  return (
    <Card title={IMPORT_STATUS_LABEL[imp.status]}>
      <div className="space-y-2 text-sm">
        <p>{imp.source}</p>
        {imp.lastError && <ErrorNote error={imp.lastError} />}
      </div>
    </Card>
  );
}
