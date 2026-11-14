/**
 * Stateful in-process WebDAV store used by command-level tests.
 *
 * Unlike `spawnFakeDav` (single responder), this keeps PUT objects so the real
 * `WebDavStorage` stack can run MKCOL / PUT / PROPFIND / GET / DELETE end to end
 * without Docker or an external account.
 */

import type { FakeResponse } from './fake_dav.ts';
import { spawnFakeDav } from './fake_dav.ts';

export interface StoredObject {
  data: Buffer;
  modified: Date;
}

export interface FakeDavState {
  objects: Map<string, StoredObject>;
  dirs: Set<string>;
}

export interface FakeDavStore {
  endpoint: string;
  state: FakeDavState;
  close(): Promise<void>;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hrefFor(key: string): string {
  return `/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function fileResponse(key: string, object: StoredObject): string {
  const href = hrefFor(key);
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop>`
    + '<D:resourcetype/>'
    + `<D:getcontentlength>${object.data.byteLength}</D:getcontentlength>`
    + `<D:getlastmodified>${object.modified.toUTCString()}</D:getlastmodified>`
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
}

function collectionResponse(key: string): string {
  const href = hrefFor(key.endsWith('/') ? key : `${key}/`);
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop>`
    + '<D:resourcetype><D:collection/></D:resourcetype>'
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
}

function multistatus(entries: string[]): FakeResponse {
  return {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`,
  };
}

function parsePropfindPath(path: string): string {
  return decodeURIComponent(path).replace(/^\/+|\/+$/g, '');
}

function parentOf(key: string): string {
  const index = key.lastIndexOf('/');
  return index < 0 ? '' : key.slice(0, index);
}

function ensureDir(state: FakeDavState, key: string): void {
  if (key === '') return;
  const parts = key.split('/');
  for (let index = 1; index <= parts.length; index++) {
    state.dirs.add(parts.slice(0, index).join('/'));
  }
}

export interface SpawnStatefulDavOptions {
  root?: string;
  /** Pre-seeded objects (`key` without leading slash). */
  objects?: Record<string, Uint8Array | string>;
}

export async function spawnStatefulDav(options: SpawnStatefulDavOptions = {}): Promise<FakeDavStore> {
  const state: FakeDavState = { objects: new Map(), dirs: new Set() };
  ensureDir(state, options.root ?? '');
  for (const [key, data] of Object.entries(options.objects ?? {})) {
    ensureDir(state, parentOf(key));
    state.objects.set(key, {
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data),
      modified: new Date(),
    });
  }
  const server = await spawnFakeDav((method, requestPath, _index, headers, body): FakeResponse => {
    const key = parsePropfindPath(requestPath);
    if (method === 'MKCOL') {
      ensureDir(state, key);
      return { status: 201 };
    }
    if (method === 'PUT') {
      ensureDir(state, parentOf(key));
      state.objects.set(key, { data: Buffer.from(body), modified: new Date() });
      return { status: 201 };
    }
    if (method === 'DELETE') {
      state.objects.delete(key);
      return { status: 204 };
    }
    if (method === 'GET') {
      const object = state.objects.get(key);
      if (object === undefined) return { status: 404 };
      const range = headers.range;
      if (range !== undefined && range.startsWith('bytes=')) {
        const start = Number(range.slice('bytes='.length).split('-')[0]);
        if (Number.isFinite(start) && start > 0) {
          if (start >= object.data.byteLength) return { status: 416 };
          return {
            status: 206,
            headers: { 'Content-Range': `bytes ${start}-${object.data.byteLength - 1}/${object.data.byteLength}` },
            body: object.data.subarray(start),
          };
        }
      }
      return { status: 200, body: object.data };
    }
    if (method === 'PROPFIND') {
      const depth = headers.depth ?? '1';
      const isObject = state.objects.has(key);
      const isDir = key === '' || state.dirs.has(key);
      if (!isObject && !isDir) return { status: 404 };
      const entries: string[] = [];
      if (isObject) {
        entries.push(fileResponse(key, state.objects.get(key)!));
      } else {
        entries.push(collectionResponse(key));
        if (depth !== '0') {
          const prefix = key === '' ? '' : `${key}/`;
          for (const dir of state.dirs) {
            if (!dir.startsWith(prefix) || dir === key || dir === '') continue;
            if (dir.slice(prefix.length).includes('/')) continue;
            entries.push(collectionResponse(dir));
          }
          for (const [objectKey, object] of state.objects) {
            if (!objectKey.startsWith(prefix)) continue;
            if (objectKey.slice(prefix.length).includes('/')) continue;
            entries.push(fileResponse(objectKey, object));
          }
        }
      }
      return multistatus(entries);
    }
    return { status: 405 };
  });
  return { endpoint: server.endpoint, state, close: () => server.close() };
}
