/**
 * In-process fake WebDAV server for transport tests (mirrors the hyper-based
 * `spawn_fake_dav` used by webdav.rs tests). No Docker, no external account.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /**
   * Declares a longer `Content-Length` than the bytes actually sent, then
   * closes the socket: the "transfer interrupted mid-body" shape.
   */
  declaredLength?: number;
  /** Writes headers plus this many bytes, then keeps the socket open (stall). */
  stallAfterBytes?: number;
  /** Destroys the socket before any response byte (connection reset). */
  destroySocket?: boolean;
}

export type RequestHeaders = Record<string, string | undefined>;

export type Responder = (method: string, path: string, index: number, headers: RequestHeaders, body: Buffer) => FakeResponse;

export interface FakeDavRequest {
  method: string;
  path: string;
  headers: RequestHeaders;
  body: Buffer;
}

export interface FakeDav {
  endpoint: string;
  log: Array<[string, string]>;
  requests: FakeDavRequest[];
  rangeRequests: Array<{ path: string; range: string }>;
  injectTruncatedGet(path: string, bytesBeforeReset: number): void;
  close(): Promise<void>;
}

export async function spawnFakeDav(responder: Responder, port = 0, options: { ranges?: boolean } = {}): Promise<FakeDav> {
  const log: Array<[string, string]> = [];
  const requests: FakeDavRequest[] = [];
  const rangeRequests: Array<{ path: string; range: string }> = [];
  const truncatedGets = new Map<string, number>();
  let index = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const current = index++;
      log.push([method, path]);
      const headers: RequestHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      requests.push({ method, path, headers, body: Buffer.concat(chunks) });
      let response = responder(method, path, current, headers, Buffer.concat(chunks));
      if (method === 'GET' && headers.range) {
        rangeRequests.push({ path, range: headers.range });
        if (options.ranges) response = applyByteRange(response, headers.range);
      }
      if (response.destroySocket === true) { req.socket.destroy(); return; }
      const payload = response.body === undefined
        ? Buffer.alloc(0)
        : typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : Buffer.from(response.body);
      const declared = response.declaredLength ?? payload.byteLength;
      const truncated = declared > payload.byteLength;
      res.writeHead(response.status, {
        ...response.headers,
        // A short body must not keep the connection alive: close as soon as the
        // sent bytes are flushed so the client sees the premature EOF at once.
        ...(truncated && response.stallAfterBytes === undefined ? { Connection: 'close' } : {}),
        'Content-Length': String(declared),
      });
      const bytesBeforeReset = method === 'GET' ? truncatedGets.get(path) : undefined;
      if (bytesBeforeReset !== undefined && response.status >= 200 && response.status < 300) {
        truncatedGets.delete(path);
        res.flushHeaders();
        res.write(payload.subarray(0, bytesBeforeReset), () => {
          // Let the client consume the flushed prefix before resetting the socket.
          setTimeout(() => req.socket.destroy(), 20);
        });
        return;
      }
      if (response.stallAfterBytes !== undefined) {
        res.write(payload.subarray(0, response.stallAfterBytes));
        return; // Deliberately never end: the client's stall guard must fire.
      }
      res.end(payload, () => {
        if (truncated) res.destroy();
      });
    });
  });
  await new Promise<void>(resolve => { server.listen(port, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}/`,
    log,
    requests,
    rangeRequests,
    injectTruncatedGet: (path, bytesBeforeReset) => { truncatedGets.set(path, bytesBeforeReset); },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** Opt-in: existing fault tests intentionally return 200 or malformed 206 responses. */
export function applyByteRange(response: FakeResponse, range: string): FakeResponse {
  if (response.status !== 200 || response.body === undefined) return response;
  const payload = typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : Buffer.from(response.body);
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match ? Number(match[1]) : NaN;
  const end = match && match[2] ? Number(match[2]) : payload.byteLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= payload.byteLength || end >= payload.byteLength) {
    return { ...response, status: 416, headers: { 'Content-Range': `bytes */${payload.byteLength}` }, body: new Uint8Array(0), declaredLength: 0 };
  }
  return { ...response, status: 206, headers: { ...response.headers, 'Content-Range': `bytes ${start}-${end}/${payload.byteLength}` }, body: payload.subarray(start, end + 1), declaredLength: end - start + 1 };
}

export function countMethod(log: Array<[string, string]>, method: string): number {
  return log.filter(([candidate]) => candidate === method).length;
}

/** Depth:1 PROPFIND multistatus: the collection itself plus `entryCount` files. */
export function multistatusXml(collectionHref: string, entryCount: number): string {
  let xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">';
  xml += `<d:response><d:href>${collectionHref}</d:href><d:propstat><d:prop>`
    + '<d:resourcetype><d:collection/></d:resourcetype></d:prop>'
    + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  for (let i = 0; i < entryCount; i++) {
    xml += `<d:response><d:href>${collectionHref}file-${i}.txt</d:href>`
      + '<d:propstat><d:prop><d:resourcetype/>'
      + '<d:getcontentlength>10</d:getcontentlength>'
      + '<d:getlastmodified>Fri, 01 Jan 2021 00:00:00 GMT</d:getlastmodified>'
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  }
  return `${xml}</d:multistatus>`;
}

export function filePropfindXml(href: string, size: number): string {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
    + `<d:response><d:href>${href}</d:href><d:propstat><d:prop>`
    + `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength>`
    + '<d:getlastmodified>Fri, 01 Jan 2021 00:00:00 GMT</d:getlastmodified>'
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
    + '</d:multistatus>';
}
