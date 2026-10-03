import type { ServerDto } from '../../../shared/types';

/**
 * Which server a bare `/terminal` should open, or null while that is not knowable yet.
 *
 * The "not yet" is the whole point. The fleet list and the fleet metadata are two requests,
 * and the configured default lives in the second one — so picking the first server the
 * moment the list lands opens a root shell on whichever machine happens to sort first. The
 * redirect then records that choice as the remembered one, which means the configured
 * default would never be chosen again on this browser.
 */
export function pickTerminalServer(
  servers: ServerDto[],
  opts: {
    /** Last server used on this browser; ignored when it is no longer registered. */
    remembered: number | null;
    defaultServerId: number | undefined;
    /** False while /api/meta is still in flight. A failed request counts as settled. */
    metaSettled: boolean;
  },
): number | null {
  if (servers.length === 0) return null;
  const remembered = servers.find((s) => s.id === opts.remembered);
  if (remembered) return remembered.id;
  // Nothing remembered: the fleet default is worth waiting for, but only until the request
  // is done one way or the other — an unreachable /api/meta must not strand the page.
  if (!opts.metaSettled) return null;
  return (servers.find((s) => s.id === opts.defaultServerId) ?? servers[0]!).id;
}
