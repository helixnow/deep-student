/**
 * Minimal in-memory WebDAV server on 127.0.0.1 for the sync smoke (no npm dependency).
 *
 * Implements what `host/plugins/sync-providers/src/webdav.ts` uses: Basic auth, MKCOL (201/405/409),
 * PUT (201/204/409), GET/HEAD with a single `bytes=` range (200/206/416), DELETE (204/404, recursive),
 * PROPFIND Depth 0/1 (207; `infinity` -> 403). Anything else is answered 405 and recorded, so a client
 * relying on an unimplemented method shows up in `requests` instead of silently passing.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const IMPLEMENTED_METHODS: readonly string[] = ['MKCOL', 'PUT', 'GET', 'HEAD', 'DELETE', 'PROPFIND'];

export interface DavRequest { method: string; path: string; depth: string | null; range: string | null; status: number; bytes: number }
export interface DavObject { path: string; size: number; sha256: string }

export interface FakeWebDav {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly requests: DavRequest[];
  /** Stored files (path without leading slash), sorted. */
  objects(): DavObject[];
  read(path: string): Buffer | undefined;
  close(): Promise<void>;
}

interface Entry { data: Buffer; modified: Date; etag: string }

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodeHref = (path: string) => path.split('/').map(encodeURIComponent).join('/');

function normalize(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath.split('?')[0] ?? '/');
  const trimmed = decoded.replace(/\/+/g, '/').replace(/\/$/, '');
  return trimmed === '' ? '/' : trimmed;
}

const parentOf = (path: string) => (path.lastIndexOf('/') <= 0 ? '/' : path.slice(0, path.lastIndexOf('/')));

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeWebDav(options: { username?: string; password?: string } = {}): Promise<FakeWebDav> {
  const username = options.username ?? 'smoke-dav';
  const password = options.password ?? 'smoke-dav-pass';
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const dirs = new Set<string>(['/', '/dav']);
  const files = new Map<string, Entry>();
  const requests: DavRequest[] = [];

  const propEntry = (path: string, entry: Entry | null): string => {
    const href = encodeHref(path === '/' ? '/' : entry === null ? `${path}/` : path);
    const props = entry === null
      ? '<d:resourcetype><d:collection/></d:resourcetype>'
      : `<d:resourcetype/><d:getcontentlength>${entry.data.length}</d:getcontentlength>`
        + `<d:getlastmodified>${entry.modified.toUTCString()}</d:getlastmodified><d:getetag>"${entry.etag}"</d:getetag>`;
    return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop>`
      + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  };

  const children = (dir: string): string[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const direct = (p: string) => p.startsWith(prefix) && p !== dir && !p.slice(prefix.length).includes('/');
    return [...[...dirs].filter(direct), ...[...files.keys()].filter(direct)].sort();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const method = req.method ?? 'GET';
    const path = normalize(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    const body = await readBody(req);
    const send = (status: number, payload?: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, headers);
      res.end(method === 'HEAD' ? undefined : payload);
      return status;
    };

    if (req.headers.authorization !== expectedAuth) return send(401, '', { 'www-authenticate': 'Basic realm="smoke"' });

    switch (method) {
      case 'MKCOL':
        if (dirs.has(path) || files.has(path)) return send(405);
        if (!dirs.has(parentOf(path))) return send(409);
        dirs.add(path);
        return send(201);
      case 'PUT': {
        if (dirs.has(path)) return send(405);
        if (!dirs.has(parentOf(path))) return send(409);
        const existed = files.has(path);
        files.set(path, { data: body, modified: new Date(), etag: createHash('sha256').update(body).digest('hex').slice(0, 32) });
        return send(existed ? 204 : 201);
      }
      case 'GET':
      case 'HEAD': {
        if (dirs.has(path)) return send(200, '', { 'content-type': 'text/html' });
        const entry = files.get(path);
        if (!entry) return send(404);
        const size = entry.data.length;
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (!range) return send(200, entry.data, { 'content-length': String(size), etag: `"${entry.etag}"` });
        const start = Number(range[1]);
        if (start >= size) return send(416, '', { 'content-range': `bytes */${size}` });
        const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
        return send(206, entry.data.subarray(start, end + 1), {
          'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), etag: `"${entry.etag}"`,
        });
      }
      case 'DELETE': {
        if (files.delete(path)) return send(204);
        if (!dirs.has(path) || path === '/') return send(404);
        for (const p of [...files.keys()]) if (p.startsWith(`${path}/`)) files.delete(p);
        for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
        return send(204);
      }
      case 'PROPFIND': {
        const depth = String(req.headers.depth ?? 'infinity');
        if (depth !== '0' && depth !== '1') return send(403);
        const isDir = dirs.has(path);
        const entry = files.get(path) ?? null;
        if (!isDir && entry === null) return send(404);
        const parts = [propEntry(path, entry)];
        if (isDir && depth === '1') for (const child of children(path)) parts.push(propEntry(child, files.get(child) ?? null));
        return send(207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`,
          { 'content-type': 'application/xml; charset=utf-8' });
      }
      default:
        return send(405);
    }
  };

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = normalize(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    const record: DavRequest = {
      method, path, depth: (req.headers.depth as string | undefined) ?? null, range: req.headers.range ?? null, status: 0, bytes: 0,
    };
    requests.push(record);
    handle(req, res).then(
      (status) => { record.status = status; record.bytes = Number(res.getHeader('content-length') ?? 0); },
      (error: unknown) => { record.status = 500; if (!res.headersSent) res.writeHead(500); res.end(String(error)); },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/dav/`,
    username,
    password,
    requests,
    objects: () => [...files.entries()]
      .map(([path, e]) => ({ path: path.slice(1), size: e.data.length, sha256: createHash('sha256').update(e.data).digest('hex') }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    read: (path) => files.get(normalize(`/${path}`))?.data,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
