// @docs sites/import
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportSummaryDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { useImports } from '../../api/hooks';
import { formatDate } from '../../lib/format';
import { IMPORT_STATUS_LABEL, importPath } from '../../lib/imports';
import { Button, Card, ConfirmDialog, ErrorNote } from '../ui';

/** Imports a job is working on: they can be neither deleted nor disconnected. */
const BUSY = new Set(['queued', 'pulling', 'pulled', 'finishing']);

/** Every import, newest first, under the Connect step. Hidden while there are none. */
export function ImportsList() {
  const imports = useImports();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<ImportSummaryDto | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/imports/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });
  const items = imports.data ?? [];
  if (items.length === 0) return null;

  return (
    <Card title="Imports">
      <ErrorNote error={remove.error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-2 pr-4 font-medium">Source</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Site</th>
              <th className="py-2 pr-4 font-medium">Started</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-t border-neutral-100 align-top">
                <td className="py-2 pr-4 break-all">{i.source ?? '–'}</td>
                <td className="py-2 pr-4">
                  {IMPORT_STATUS_LABEL[i.status]}
                  {i.status === 'failed' && i.lastError && <span className="block text-xs text-red-700">{i.lastError}</span>}
                </td>
                <td className="py-2 pr-4">{i.siteSlug ?? '–'}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{formatDate(i.startedAt ?? i.createdAt)}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <span className="inline-flex gap-2">
                    {i.status !== 'expired' && (
                      <Link to={importPath(i.id)}>
                        <Button small variant="secondary">
                          Continue
                        </Button>
                      </Link>
                    )}
                    <span title={BUSY.has(i.status) ? 'Stop its job first.' : undefined}>
                      <Button small variant="secondary" disabled={BUSY.has(i.status)} onClick={() => setDeleting(i)}>
                        Delete
                      </Button>
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete import"
          message={
            deleting.status === 'done'
              ? 'Removes the record of this import. The site it made stays.'
              : "Removes this import. The old site's plugin stops answering it."
          }
          confirmLabel="Delete import"
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </Card>
  );
}
