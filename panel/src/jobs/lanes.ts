// @docs automations/jobs, reference/architecture
/**
 * The named lane a site's commands (wp.cli, site.shell, wp.rest) run in: one at a time per server,
 * beside that server's Docker and MariaDB work rather than in front of it - a ten-minute
 * command must not keep every other site on the machine from being restarted.
 */
export const execLane = (serverId: number) => `exec:${serverId}`;

/**
 * The server a named lane belongs to. Lanes that are per server are always `<name>:<id>`
 * (offsite:3, exec:3); a laned job carries no server_id - the claim query would read one as
 * holding the server lane - so this is how the Jobs list still knows where it runs.
 */
export function laneServerId(lane: string | null): number | null {
  const match = lane ? /:(\d+)$/.exec(lane) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The named lane an import's pull runs in: one import per server at a time, beside that server's
 * own work - a pull can take hours, and every other site on the machine must not wait for it.
 */
export const importLane = (serverId: number) => `import:${serverId}`;

/** The lanes jobs of sites hosted elsewhere share: two at a time, whatever servers they keep backups on. */
export const EXTERNAL_LANES = 2;

/**
 * The named lane a job of a site hosted elsewhere runs in. A backup pull can take hours, and it
 * holds no server's Docker or MariaDB: in a lane of their own, two such jobs at most run at
 * once, and the worker's other slots stay free for everything else. No colon: it belongs to no
 * server (laneServerId).
 */
export const externalLane = (siteId: number) => `external-${siteId % EXTERNAL_LANES}`;
