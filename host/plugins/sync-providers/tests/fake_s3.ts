/**
 * In-process fake S3-compatible endpoint for transport tests.
 *
 * The client signs every request, but the fake server does not validate SigV4:
 * these tests exercise retry/redirect/path/range semantics, not AWS auth (the
 * official known-answer vectors cover signing in s3.test.ts).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { applyByteRange } from './fake_dav.ts';

export interface FakeS3Request {
  method: string;
  /** Decoded pathname (percent escapes are resolved by `URL`). */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface FakeS3Response {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Declares a different length than the bytes actually sent. */
  declaredLength?: number;
  /** Writes headers plus this many bytes, then keeps the socket open (stall). */
  stallAfterBytes?: number;
  /** Destroys the socket before any response byte (connection reset). */
  destroySocket?: boolean;
}

export type FakeS3Handler = (request: FakeS3Request, index: number) => FakeS3Response;

export interface FakeS3 {
  endpoint: string;
  log: FakeS3Request[];
  close(): Promise<void>;
}

export async function spawnFakeS3(handler: FakeS3Handler, port = 0, options: { ranges?: boolean } = {}): Promise<FakeS3> {
  const log: FakeS3Request[] = [];
  const sockets = new Set<Socket>();
  let index = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const parsed = new URL(req.url ?? '/', 'http://fake.invalid');
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      const request: FakeS3Request = {
        method: req.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.searchParams,
        headers,
        body: Buffer.concat(chunks),
      };
      log.push(request);
      let response = handler(request, index++);
      if (options.ranges && request.method === 'GET' && headers.range) response = applyByteRange(response, headers.range);
      if (response.destroySocket === true) { req.socket.destroy(); return; }
      const payload = response.body === undefined
        ? Buffer.alloc(0)
        : typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : Buffer.from(response.body);
      const declared = response.declaredLength ?? payload.byteLength;
      const truncated = declared > payload.byteLength;
      res.writeHead(response.status, {
        ...response.headers,
        ...(truncated ? { Connection: 'close' } : {}),
        'Content-Length': String(declared),
      });
      if (request.method === 'HEAD') { res.end(); return; }
      if (response.stallAfterBytes !== undefined) {
        res.write(payload.subarray(0, response.stallAfterBytes));
        return; // Deliberately never end: the client's stall guard must fire.
      }
      res.end(payload, () => {
        if (truncated) res.destroy();
      });
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => { server.listen(port, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    log,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** Minimal S3 error document. */
export function s3ErrorXml(code: string, message = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>`
    + `<Message>${message}</Message></Error>`;
}
