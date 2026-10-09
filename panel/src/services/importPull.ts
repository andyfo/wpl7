// @docs sites/import
import crypto from 'node:crypto';
import {
  PluginClient,
  PluginSourceError,
  sha256,
  type PluginClientOptions,
  type PluginProtocol,
} from './pluginClient.js';

/**
 * The panel's side of the import protocol (docs/internal/import-protocol.md): every request it
 * makes to the migration plugin on an old site, signed with the import's token. The transport,
 * the retries and the paging actions are PluginClient's (pluginClient.ts); this adds the HMAC
 * signature and the two actions only an import has, `maintenance` and `finish`.
 */

export {
  PullCanceledError,
  PullTransportError,
  actionUrl,
  createPinnedTransport,
  type BundleAnswer,
  type BundleFile,
  type FileEntry,
  type FilesAnswer,
  type PingAnswer,
  type PullRequest,
  type PullResponse,
  type PullState,
  type PullTransport,
  type RangeAnswer,
  type RangeEncoding,
  type SnapshotAnswer,
  type SqlAnswer,
  type TablesAnswer,
  type Transport,
} from './pluginClient.js';

/** Something about the old site the pull cannot get past. `fatal`: retrying will not help. */
export const ImportSourceError = PluginSourceError;
export type ImportSourceError = PluginSourceError;

/** The canonical string a request's signature covers (A.2). */
export function canonicalRequest(importId: number, action: string, timestamp: number, nonce: string, body: Buffer): string {
  return ['WPL7-MIGRATE-V1', String(importId), action, String(timestamp), nonce, sha256(body)].join('\n');
}

export function signRequest(token: string, canonical: string): string {
  return crypto.createHmac('sha256', Buffer.from(token, 'utf8')).update(canonical).digest('hex');
}

/** WPL7 Migrate's side of things: the HMAC of the import's token, and the old site's words. */
export function migrateProtocol(importId: number, token: string): PluginProtocol {
  return {
    marker: 'x-wpl7-protocol',
    queryVar: 'wpl7-migrate',
    version: 1,
    budgeted: [],
    sign(action, timestamp, nonce, body) {
      const signature = `v1=${signRequest(token, canonicalRequest(importId, action, timestamp, nonce, body))}`;
      return {
        headers: {
          'x-wpl7-import-id': String(importId),
          'x-wpl7-timestamp': String(timestamp),
          'x-wpl7-nonce': nonce,
          'x-wpl7-signature': signature,
        },
        query: { _id: String(importId), _ts: String(timestamp), _nonce: nonce, _sig: signature },
      };
    },
    words: {
      site: 'the old site',
      Site: 'The old site',
      host: 'the old host',
      Host: 'The old host',
      refused: 'The plugin on the old site refused the panel. It may have been disconnected or replaced: download it again and connect.',
      paths: '/wp-json/wpl7-migrate/ and ?wpl7-migrate=',
    },
  };
}

export interface PullClientOptions extends PluginClientOptions {
  importId: number;
  token: string;
}

export class ImportPullClient extends PluginClient {
  constructor(opts: PullClientOptions) {
    super(migrateProtocol(opts.importId, opts.token), opts);
  }

  maintenance(on: boolean, ttlS = 3600): Promise<{ on: boolean; until: number }> {
    return this.call('maintenance', { on, ttl_s: ttlS }).then((a) => a.json as unknown as { on: boolean; until: number });
  }

  async finish(): Promise<void> {
    await this.call('finish', {});
  }
}
