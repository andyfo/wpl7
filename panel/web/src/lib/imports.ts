import type { ImportStatus } from '../../../shared/schemas';

/** An import's status, as the list and the page say it. */
export const IMPORT_STATUS_LABEL: Record<ImportStatus, string> = {
  pending: 'Waiting for the old site',
  connected: 'Connected',
  queued: 'Queued',
  pulling: 'Pulling',
  pulled: 'Pulled',
  finishing: 'Setting up',
  done: 'Done',
  failed: 'Stopped',
  expired: 'Expired',
};

export const IMPORT_STEPS = ['Connect', 'Confirm', 'Import', 'Done'] as const;

/** The step of the Import site page an import is at (an index into IMPORT_STEPS). */
export function importStep(status: ImportStatus): number {
  switch (status) {
    case 'pending':
    case 'expired':
      return 0;
    case 'connected':
      return 1;
    case 'done':
      return 3;
    default:
      return 2;
  }
}

/** The page's own address for an import. */
export const importPath = (id: number) => `/sites/import?id=${id}`;
