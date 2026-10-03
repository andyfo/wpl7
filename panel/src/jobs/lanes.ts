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
