// @docs sites/external
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConnectionSummaryDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { useConnections } from '../../api/hooks';
import { formatDate } from '../../lib/format';
import { CONNECTION_STATUS_LABEL, connectionPath } from '../../lib/connections';
import { Button, Card, ConfirmDialog, ErrorNote } from '../ui';

/** Connections that are not a site yet, newest first, under the Connect step. Hidden while there are none. */
export function ConnectionsList() {
  const connections = useConnections();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<ConnectionSummaryDto | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connections'] }),
  });
  const items = connections.data ?? [];
  if (items.length === 0) return null;

  return (
    <Card title="Connections">
      <ErrorNote error={remove.error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-2 pr-4 font-medium">Site</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Started</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-t border-neutral-100 align-top">
                <td className="py-2 pr-4 break-all">
                  {c.source ?? '–'}
                  {c.forSite && <span className="block text-xs text-neutral-500">Reconnects {c.forSite.title}</span>}
                </td>
                <td className="py-2 pr-4">{CONNECTION_STATUS_LABEL[c.status]}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{formatDate(c.createdAt)}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <span className="inline-flex gap-2">
                    {c.status !== 'expired' && (
                      <Link to={connectionPath(c.id)}>
                        <Button small variant="secondary">
                          Continue
                        </Button>
                      </Link>
                    )}
                    <Button small variant="secondary" onClick={() => setDeleting(c)}>
                      Delete
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete connection"
          message={
            deleting.status === 'expired'
              ? 'Removes this connection.'
              : 'The panel forgets this connection. If the plugin is on the site already, delete it there too.'
          }
          confirmLabel="Delete connection"
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </Card>
  );
}
