import { z } from 'zod';
import type { CoreServices } from '../../services/index.js';
import { runHousekeeping } from '../../services/housekeeping.js';
import type { JobContext } from '../context.js';

export const housekeepingPayload = z.object({});

/**
 * The nightly pruning run (services/housekeeping.ts). Every line goes to the job log and to
 * the panel log both: the job is where an operator looks, the panel log is where the run has
 * always said what it removed.
 */
export async function systemHousekeeping(ctx: JobContext<z.infer<typeof housekeepingPayload>>, s: CoreServices): Promise<void> {
  const log = {
    info: (message: string) => {
      ctx.info(message);
      s.log.info(message);
    },
    warn: (message: string) => {
      ctx.warn(message);
      s.log.warn(message);
    },
  };
  ctx.setResult(await runHousekeeping(s, log, () => ctx.checkCanceled()));
}
