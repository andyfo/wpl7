// @docs databases/adminer
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import type { DockerPort } from '../services/docker.js';

export const ADMINER_CONTAINER = 'wpl7-adminer';

/** Joins the exec's stdin and stdout to the PHP server on the Adminer container's own loopback. */
export const ADMINER_RELAY = ['php', '/srv/adminer/relay.php'];

/** The longest one request may take: an export of a big table is one request. */
export const ADMINER_REQUEST_MS = 30 * 60_000;

/** A request body past its limit: the front door answers 413. */
export class BodyTooLargeError extends Error {
  constructor(readonly max: number) {
    super('The request is too large');
  }
}

/**
 * One HTTP request to a server's Adminer, carried by `docker exec … php relay.php` over the Docker
 * connection the panel has to every server (the socket here, SSH elsewhere). No port is opened
 * anywhere. Each request is a relay of its own, and ends with the response (`Connection: close`).
 * `signal` abandons it, the relay with it: the browser went away. A body past `maxBody` bytes
 * fails it with BodyTooLargeError.
 */
export async function adminerRequest(
  docker: DockerPort,
  req: {
    method: string;
    path: string;
    headers: OutgoingHttpHeaders;
    body?: Readable | Buffer | string;
    maxBody?: number;
    signal?: AbortSignal;
  },
): Promise<IncomingMessage> {
  const relay = await docker.execDuplex(ADMINER_CONTAINER, ADMINER_RELAY, { timeoutMs: ADMINER_REQUEST_MS });
  if (req.signal?.aborted) {
    relay.stream.destroy();
    throw new Error('The request was abandoned');
  }
  /** Set the moment the body passes `maxBody`: whatever error the request then fails with, it is this. */
  let tooLarge: BodyTooLargeError | null = null;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = http.request(
      {
        method: req.method,
        path: req.path,
        headers: { ...req.headers, host: 'adminer', connection: 'close' },
        createConnection: () => relay.stream as unknown as Socket,
        signal: req.signal,
      },
      resolve,
    );
    outgoing.on('error', (err) => {
      relay.stream.destroy();
      if (tooLarge) return reject(tooLarge);
      const stderr = relay.stderr().trim();
      reject(stderr ? new Error(`${err.message}: ${stderr.slice(0, 300)}`) : err);
    });
    if (req.body instanceof Readable) {
      // An error on either side - the browser gone, the body too large - ends both, and comes out
      // of `outgoing` as its error.
      const done = (err: NodeJS.ErrnoException | null) => {
        if (err) outgoing.destroy(err);
      };
      if (req.maxBody !== undefined) {
        const max = req.maxBody;
        let seen = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _enc, cb: TransformCallback) {
            seen += chunk.length;
            if (seen <= max) return cb(null, chunk);
            tooLarge = new BodyTooLargeError(max);
            cb(tooLarge);
          },
        });
        pipeline(req.body, limit, outgoing, done);
      } else {
        pipeline(req.body, outgoing, done);
      }
    } else {
      outgoing.end(req.body);
    }
  });
}

/** A response read whole: for the panel's own requests (the sign-in, the readiness check). */
export async function readAll(res: IncomingMessage, max = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
