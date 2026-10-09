// @docs sites/external
import type { ConnectionStatus } from '../../../shared/schemas';

/** A connection's status, as the list and the page say it. */
export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  pending: 'Waiting for the site',
  enrolled: 'Connected',
  active: 'Added',
  disconnected: 'Disconnected',
  expired: 'Expired',
};

export const CONNECT_STEPS = ['Connect', 'Confirm', 'Done'] as const;

/** The step of the Connect site page a connection is at (an index into CONNECT_STEPS). */
export function connectStep(status: ConnectionStatus): number {
  switch (status) {
    case 'enrolled':
      return 1;
    case 'active':
      return 2;
    default:
      return 0;
  }
}

/** The page's own address for a connection. */
export const connectionPath = (id: number) => `/sites/connect?id=${id}`;
