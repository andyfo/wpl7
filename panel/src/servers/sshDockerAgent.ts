import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { SshConnection } from './sshConnection.js';

/**
 * http.Agent that carries every Docker API request over a channel of the pooled
 * SSH connection, straight to the remote /var/run/docker.sock. dockerode's own
 * `protocol:'ssh'` support opens a brand-new SSH connection per API call
 * (docker-modem/lib/modem.js), which this avoids.
 */
export class SshDockerAgent extends http.Agent {
  constructor(private readonly conn: SshConnection) {
    // keepAlive off: every request gets a fresh channel; the SSH connection is what's pooled.
    super({ keepAlive: false });
  }

  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    this.conn.openDockerChannel().then(
      (channel) => callback?.(null, decorateChannel(channel)),
      (err) => callback?.(err instanceof Error ? err : new Error(String(err)), undefined as never),
    );
    return undefined;
  }
}

/** node:http expects net.Socket-isms the ssh2 channel lacks; stub them (ssh2's own http-agents.js recipe). */
function decorateChannel(channel: Duplex): Duplex {
  const c = channel as Duplex & Record<string, unknown>;
  c.setKeepAlive = () => undefined;
  c.setNoDelay = () => undefined;
  c.setTimeout = () => undefined;
  c.ref = () => undefined;
  c.unref = () => undefined;
  c.destroySoon = () => channel.destroy();
  return channel;
}
