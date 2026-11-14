/**
 * WAVE0 deterministic local cloud boundary (WebDAV + S3) for A/B equivalence runs.
 *
 * Both backends are pointed at their own fresh instance started with the same seed.
 * The service only stores bytes and answers protocol requests; it never computes a
 * sync/business result. All state lives in memory, every timestamp comes from a
 * logical clock (start + 1s per write), ETags are content hashes and upload/request
 * ids are counters, so the same request sequence always yields the same responses.
 *
 * Status codes follow the semantics the Rust clients rely on
 * (dstu-sync cloud_storage/webdav.rs, s3.rs): MKCOL 201/405/409, PUT 201/204/409,
 * GET 200/206/416/404, DELETE 204/404, PROPFIND 207 (Depth 0/1, infinity -> 403),
 * S3 NoSuchKey/NoSuchBucket/NoSuchUpload, ListObjectsV2 continuation tokens, multipart.
 * Faults (status or connection reset) are injected per request match for retry paths.
 *
 * Binds 127.0.0.1 only; HTTP reuses the in-process servers from tests/fake_dav.ts and
 * tests/fake_s3.ts. Usage and config injection: ../README.md.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo, Socket } from 'node:net';
import { spawnFakeDav, type FakeDav, type FakeResponse, type RequestHeaders } from '../../tests/fake_dav.ts';
import { spawnFakeS3, type FakeS3, type FakeS3Request, type FakeS3Response } from '../../tests/fake_s3.ts';

export const WEBDAV_USERNAME = 'wave0-user';
export const WEBDAV_PASSWORD = 'wave0-pass';
export const S3_BUCKET = 'wave0-bucket';
export const S3_ACCESS_KEY_ID = 'WAVE0ACCESSKEYID';
export const S3_SECRET_ACCESS_KEY = 'wave0-secret-access-key';
export const S3_REGION = 'us-east-1';
export const DEFAULT_ROOT = 'wave0';
export const DEFAULT_CLOCK_START_MS = Date.UTC(2021, 0, 1, 0, 0, 0);
/** S3 multipart minimum size for every part except the last. */
const MIN_PART_SIZE = 5 * 1024 * 1024;

export type SeedBytes = string | { base64: string };

export interface CloudSeed {
  clockStartMs?: number;
  webdav?: { dirs?: string[]; objects?: Record<string, SeedBytes> };
  s3?: { objects?: Record<string, SeedBytes>; /** Server-side page cap for ListObjectsV2. */ maxKeys?: number };
}

export const SEEDS: Readonly<Record<string, CloudSeed>> = {
  empty: {},
  basic: {
    webdav: {
      dirs: ['wave0', 'wave0/docs'],
      objects: { 'wave0/docs/a.txt': 'alpha', 'wave0/docs/b.txt': 'bravo' },
    },
    s3: { objects: { 'wave0/docs/a.txt': 'alpha', 'wave0/docs/b.txt': 'bravo' } },
  },
  's3-paged': {
    s3: {
      maxKeys: 2,
      objects: Object.fromEntries(['p0', 'p1', 'p2', 'p3', 'p4'].map(name => [`wave0/paged/${name}.txt`, name])),
    },
  },
};

export type CloudServiceName = 'webdav' | 's3';

export interface CloudFault {
  service: CloudServiceName;
  /** Exact HTTP method; omitted matches every method. */
  method?: string;
  /** Substring of the decoded request path; omitted matches every path. */
  pathIncludes?: string;
  /** How many matching requests consume this fault (default 1). */
  times?: number;
  respond: { status: number; headers?: Record<string, string>; body?: string } | 'reset';
}

export interface CloudRequestRecord {
  seq: number;
  service: CloudServiceName;
  method: string;
  /** Decoded path. */
  path: string;
  query: string;
  range: string | null;
  depth: string | null;
  bodyBytes: number;
  bodySha256: string;
  status: number | 'reset';
  responseSha256: string | null;
  fault: boolean;
}

export interface CloudObjectSnapshot { key: string; size: number; sha256: string; modified: string; etag: string }

export interface CloudSnapshot {
  webdav: { dirs: string[]; objects: CloudObjectSnapshot[] };
  s3: { objects: CloudObjectSnapshot[]; uploads: Array<{ key: string; uploadId: string; parts: number[] }> };
}

/**
 * `publish` is the exact `cloud_config_publish` (F4) argument object, shaped like the
 * frontend `publishCloudConfig` (toSafeCloudStorageConfig; Rust Safe* configs deny
 * unknown fields, so no secret appears in `config`). `runtime` is the `config` argument
 * of cloud_storage_* (L23), shaped like toRuntimeCloudStorageConfig; both backends
 * replace it with the published SSOT plus secure-store credentials before use.
 */
export interface CloudConfigInjection {
  publish: {
    config: Record<string, unknown>;
    credentials: Record<string, string>;
    encryptionPasswordIsPreexisting: boolean;
  };
  runtime: Record<string, unknown>;
}

export interface CloudServiceOptions {
  seed?: string | CloudSeed;
  webdavPort?: number;
  s3Port?: number;
  controlPort?: number;
  /** Isolated directory for the request transcript; defaults to a fresh mkdtemp. */
  dataDir?: string;
  /** Keep the data directory after stop / process exit. */
  keepDataDir?: boolean;
}

export interface CloudService {
  readonly webdavEndpoint: string;
  readonly s3Endpoint: string;
  readonly controlUrl: string;
  readonly dataDir: string;
  readonly seedName: string;
  config(provider: CloudServiceName, root?: string): CloudConfigInjection;
  /** Replaces `${cloud.webdav.endpoint}` / `${cloud.s3.endpoint}` in any JSON value. */
  resolve<T>(value: T): T;
  reset(seed?: string | CloudSeed): void;
  setFaults(faults: CloudFault[]): void;
  requests(): CloudRequestRecord[];
  snapshot(): CloudSnapshot;
  stop(): Promise<void>;
}

interface StoredObject { data: Buffer; modified: Date; etag: string }
interface Upload { key: string; initiated: Date; parts: Map<number, { data: Buffer; etag: string }> }

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const md5 = (data: Uint8Array): Buffer => createHash('md5').update(data).digest();
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const seedBytes = (value: SeedBytes): Buffer =>
  typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.base64, 'base64');
const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parentOf(key: string): string {
  const index = key.lastIndexOf('/');
  return index < 0 ? '' : key.slice(0, index);
}

/** Decodes a raw request path into a slash-trimmed key; null when percent-encoding is malformed. */
function decodeKey(rawPath: string): string | null {
  try {
    return rawPath.split('/').filter(segment => segment !== '').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

function hrefFor(key: string, collection: boolean): string {
  if (key === '') return '/';
  const href = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  return collection ? `${href}/` : href;
}

type RangeResult = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

function parseRange(header: string | undefined, size: number): RangeResult {
  const match = header === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  // Unparseable or multi-range headers are ignored, as RFC 9110 permits.
  if (match === null) return { kind: 'full' };
  const start = Number(match[1]);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (end < start) return { kind: 'full' };
  return { kind: 'partial', start, end };
}

const liveDataDirs = new Set<string>();
let exitHookInstalled = false;
function installExitCleanup(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of liveDataDirs) rmSync(dir, { recursive: true, force: true });
  });
}

function resolveSeed(seed: string | CloudSeed | undefined): { name: string; seed: CloudSeed } {
  if (seed === undefined) return { name: 'empty', seed: SEEDS.empty! };
  if (typeof seed !== 'string') return { name: 'custom', seed };
  const known = SEEDS[seed];
  if (known === undefined) throw new Error(`unknown cloud seed '${seed}' (known: ${Object.keys(SEEDS).join(', ')})`);
  return { name: seed, seed: known };
}

export async function startCloudService(options: CloudServiceOptions = {}): Promise<CloudService> {
  let { name: seedName, seed } = resolveSeed(options.seed);
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ds-wave0-cloud-'));
  mkdirSync(dataDir, { recursive: true });
  const transcript = join(dataDir, 'requests.jsonl');
  const removeDataDir = ownsDataDir && options.keepDataDir !== true;
  if (removeDataDir) {
    liveDataDirs.add(dataDir);
    installExitCleanup();
  }

  let clock = 0;
  let seq = 0;
  let uploadCounter = 0;
  let faults: Array<CloudFault & { remaining: number }> = [];
  let log: CloudRequestRecord[] = [];
  const davDirs = new Set<string>();
  const davObjects = new Map<string, StoredObject>();
  const s3Objects = new Map<string, StoredObject>();
  const uploads = new Map<string, Upload>();

  const tick = (): Date => {
    const date = new Date(clock);
    clock += 1000;
    return date;
  };
  const store = (data: Buffer, etag?: string): StoredObject =>
    ({ data, modified: tick(), etag: etag ?? `"${md5(data).toString('hex')}"` });
  const ensureDavDir = (key: string): void => {
    if (key === '') return;
    const parts = key.split('/');
    for (let index = 1; index <= parts.length; index++) davDirs.add(parts.slice(0, index).join('/'));
  };

  const applySeed = (): void => {
    clock = seed.clockStartMs ?? DEFAULT_CLOCK_START_MS;
    seq = 0;
    uploadCounter = 0;
    faults = [];
    log = [];
    davDirs.clear();
    davObjects.clear();
    s3Objects.clear();
    uploads.clear();
    for (const dir of [...(seed.webdav?.dirs ?? [])].sort(byteOrder)) ensureDavDir(dir);
    for (const [key, value] of Object.entries(seed.webdav?.objects ?? {}).sort(([a], [b]) => byteOrder(a, b))) {
      ensureDavDir(parentOf(key));
      davObjects.set(key, store(seedBytes(value)));
    }
    for (const [key, value] of Object.entries(seed.s3?.objects ?? {}).sort(([a], [b]) => byteOrder(a, b))) {
      s3Objects.set(key, store(seedBytes(value)));
    }
    appendFileSync(transcript, `${JSON.stringify({ reset: seedName })}\n`);
  };
  applySeed();

  const takeFault = (service: CloudServiceName, method: string, path: string): CloudFault['respond'] | null => {
    const fault = faults.find(candidate => candidate.service === service
      && (candidate.method === undefined || candidate.method === method)
      && (candidate.pathIncludes === undefined || path.includes(candidate.pathIncludes)));
    if (fault === undefined) return null;
    fault.remaining -= 1;
    if (fault.remaining <= 0) faults = faults.filter(candidate => candidate !== fault);
    return fault.respond;
  };

  const record = (entry: Omit<CloudRequestRecord, 'seq'>): void => {
    const full: CloudRequestRecord = { seq: seq++, ...entry };
    log.push(full);
    appendFileSync(transcript, `${JSON.stringify(full)}\n`);
  };
  const bodyHash = (body: string | Uint8Array | undefined): string | null =>
    body === undefined ? null : sha256(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);

  // ------------------------------------------------------------------ WebDAV

  const davAuth = `Basic ${Buffer.from(`${WEBDAV_USERNAME}:${WEBDAV_PASSWORD}`, 'utf8').toString('base64')}`;
  const davIsDir = (key: string): boolean => key === '' || davDirs.has(key);

  const davFileEntry = (key: string, object: StoredObject): string =>
    `<D:response><D:href>${escapeXml(hrefFor(key, false))}</D:href><D:propstat><D:prop>`
    + '<D:resourcetype/>'
    + `<D:getcontentlength>${object.data.byteLength}</D:getcontentlength>`
    + `<D:getlastmodified>${object.modified.toUTCString()}</D:getlastmodified>`
    + `<D:getetag>${escapeXml(object.etag)}</D:getetag>`
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  const davDirEntry = (key: string): string =>
    `<D:response><D:href>${escapeXml(hrefFor(key, true))}</D:href><D:propstat><D:prop>`
    + '<D:resourcetype><D:collection/></D:resourcetype>'
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';

  const davRespond = (method: string, key: string, headers: RequestHeaders, body: Buffer): FakeResponse => {
    if (headers.authorization !== davAuth) {
      return { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="wave0"' } };
    }
    switch (method) {
      case 'OPTIONS':
        return { status: 200, headers: { DAV: '1', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND' } };
      case 'MKCOL':
        if (body.byteLength > 0) return { status: 415 };
        if (davIsDir(key) || davObjects.has(key)) return { status: 405 };
        if (!davIsDir(parentOf(key))) return { status: 409 };
        davDirs.add(key);
        return { status: 201 };
      case 'PUT': {
        if (davIsDir(key)) return { status: 405 };
        if (!davIsDir(parentOf(key))) return { status: 409 };
        const existed = davObjects.has(key);
        const object = store(Buffer.from(body));
        davObjects.set(key, object);
        return { status: existed ? 204 : 201, headers: { ETag: object.etag } };
      }
      case 'GET':
      case 'HEAD': {
        const object = davObjects.get(key);
        if (object === undefined) {
          return davIsDir(key) ? { status: 200, headers: { 'Content-Type': 'text/html' }, body: '' } : { status: 404 };
        }
        const base = {
          'Content-Type': 'application/octet-stream',
          ETag: object.etag,
          'Last-Modified': object.modified.toUTCString(),
          'Accept-Ranges': 'bytes',
        };
        const size = object.data.byteLength;
        const range = parseRange(headers.range, size);
        if (range.kind === 'unsatisfiable') return { status: 416, headers: { 'Content-Range': `bytes */${size}` } };
        if (range.kind === 'partial') {
          return {
            status: 206,
            headers: { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
            body: object.data.subarray(range.start, range.end + 1),
          };
        }
        return { status: 200, headers: base, body: object.data };
      }
      case 'DELETE': {
        if (key === '') return { status: 403 };
        if (davObjects.delete(key)) return { status: 204 };
        if (!davDirs.has(key)) return { status: 404 };
        const prefix = `${key}/`;
        for (const dir of [...davDirs]) if (dir === key || dir.startsWith(prefix)) davDirs.delete(dir);
        for (const objectKey of [...davObjects.keys()]) if (objectKey.startsWith(prefix)) davObjects.delete(objectKey);
        return { status: 204 };
      }
      case 'PROPFIND': {
        const depth = (headers.depth ?? 'infinity').trim();
        if (depth !== '0' && depth !== '1') return { status: 403 };
        const object = davObjects.get(key);
        const entries: string[] = [];
        if (object !== undefined) {
          entries.push(davFileEntry(key, object));
        } else if (davIsDir(key)) {
          entries.push(davDirEntry(key));
          if (depth === '1') {
            const children: Array<[string, StoredObject | null]> = [];
            for (const dir of davDirs) if (dir !== key && dir !== '' && parentOf(dir) === key) children.push([dir, null]);
            for (const [objectKey, child] of davObjects) if (parentOf(objectKey) === key) children.push([objectKey, child]);
            children.sort(([a], [b]) => byteOrder(a, b));
            for (const [childKey, child] of children) entries.push(child === null ? davDirEntry(childKey) : davFileEntry(childKey, child));
          }
        } else {
          return { status: 404 };
        }
        return {
          status: 207,
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
          body: `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`,
        };
      }
      default:
        return { status: 501 };
    }
  };

  const webdav: FakeDav = await spawnFakeDav((method, rawPath, _index, headers, body) => {
    const key = decodeKey(rawPath);
    const path = key === null ? rawPath : `/${key}`;
    const fault = takeFault('webdav', method, path);
    const response: FakeResponse = fault === 'reset'
      ? { status: 0, destroySocket: true }
      : fault !== null
        ? { status: fault.status, headers: fault.headers, body: fault.body }
        : key === null ? { status: 400 } : davRespond(method, key, headers, body);
    record({
      service: 'webdav', method, path, query: '', range: headers.range ?? null, depth: headers.depth ?? null,
      bodyBytes: body.byteLength, bodySha256: sha256(body),
      status: response.destroySocket === true ? 'reset' : response.status,
      responseSha256: response.destroySocket === true ? null : bodyHash(response.body), fault: fault !== null,
    });
    return response;
  }, options.webdavPort ?? 0);

  // ------------------------------------------------------------------ S3

  const s3Error = (status: number, code: string, message: string, resource: string): FakeS3Response => ({
    status,
    headers: { 'Content-Type': 'application/xml', 'x-amz-request-id': `wave0-${seq}` },
    body: '<?xml version="1.0" encoding="UTF-8"?>'
      + `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message>`
      + `<Resource>${escapeXml(resource)}</Resource><RequestId>wave0-${seq}</RequestId></Error>`,
  });
  const xml = (body: string): FakeS3Response => ({
    status: 200,
    headers: { 'Content-Type': 'application/xml', 'x-amz-request-id': `wave0-${seq}` },
    body: `<?xml version="1.0" encoding="UTF-8"?>${body}`,
  });
  const objectHeaders = (object: StoredObject): Record<string, string> => ({
    'Content-Type': 'application/octet-stream',
    ETag: object.etag,
    'Last-Modified': object.modified.toUTCString(),
    'Accept-Ranges': 'bytes',
    'x-amz-request-id': `wave0-${seq}`,
  });

  const listObjectsV2 = (query: URLSearchParams, resource: string): FakeS3Response => {
    if (query.has('delimiter') || query.has('start-after')) {
      return s3Error(501, 'NotImplemented', 'delimiter/start-after are not used by dstu-sync', resource);
    }
    const prefix = query.get('prefix') ?? '';
    const token = query.get('continuation-token');
    let after: string | null = null;
    if (token !== null) {
      after = Buffer.from(token, 'base64url').toString('utf8');
      if (Buffer.from(after, 'utf8').toString('base64url') !== token) {
        return s3Error(400, 'InvalidArgument', 'The continuation token provided is incorrect', resource);
      }
    }
    const requested = query.has('max-keys') ? Number(query.get('max-keys')) : 1000;
    const pageSize = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 1000, seed.s3?.maxKeys ?? 1000));
    const keys = [...s3Objects.keys()]
      .filter(key => key.startsWith(prefix) && (after === null || byteOrder(key, after) > 0))
      .sort(byteOrder);
    const page = keys.slice(0, pageSize);
    const truncated = keys.length > page.length;
    const contents = page.map(key => {
      const object = s3Objects.get(key)!;
      return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${object.modified.toISOString()}</LastModified>`
        + `<ETag>${escapeXml(object.etag)}</ETag><Size>${object.data.byteLength}</Size>`
        + '<StorageClass>STANDARD</StorageClass></Contents>';
    }).join('');
    const next = truncated && page.length > 0
      ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]!, 'utf8').toString('base64url')}</NextContinuationToken>`
      : '';
    return xml('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + `<Name>${S3_BUCKET}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>`
      + `<MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>`
      + (token === null ? '' : `<ContinuationToken>${escapeXml(token)}</ContinuationToken>`)
      + `${next}${contents}</ListBucketResult>`);
  };

  const listUploads = (query: URLSearchParams): FakeS3Response => {
    const prefix = query.get('prefix') ?? '';
    const rows = [...uploads.entries()]
      .filter(([, upload]) => upload.key.startsWith(prefix))
      .sort(([idA, a], [idB, b]) => byteOrder(a.key, b.key) || byteOrder(idA, idB))
      .map(([uploadId, upload]) => `<Upload><Key>${escapeXml(upload.key)}</Key><UploadId>${uploadId}</UploadId>`
        + `<Initiated>${upload.initiated.toISOString()}</Initiated><StorageClass>STANDARD</StorageClass></Upload>`)
      .join('');
    return xml('<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + `<Bucket>${S3_BUCKET}</Bucket><Prefix>${escapeXml(prefix)}</Prefix><IsTruncated>false</IsTruncated>`
      + `${rows}</ListMultipartUploadsResult>`);
  };

  const completeUpload = (uploadId: string, key: string, body: Buffer, resource: string): FakeS3Response => {
    const upload = uploads.get(uploadId);
    if (upload === undefined || upload.key !== key) return s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.', resource);
    const requested = [...body.toString('utf8').matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map(match => ({
      number: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(match[1]!)?.[1]),
      etag: (/<ETag>([\s\S]*?)<\/ETag>/.exec(match[1]!)?.[1] ?? '').replace(/&quot;|"/g, ''),
    }));
    if (requested.length === 0) return s3Error(400, 'MalformedXML', 'The XML you provided was not well-formed.', resource);
    const chunks: Buffer[] = [];
    const digests: Buffer[] = [];
    for (let index = 0; index < requested.length; index++) {
      const { number, etag } = requested[index]!;
      if (index > 0 && number <= requested[index - 1]!.number) {
        return s3Error(400, 'InvalidPartOrder', 'The list of parts was not in ascending order.', resource);
      }
      const part = upload.parts.get(number);
      if (part === undefined || part.etag.replace(/"/g, '') !== etag) {
        return s3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found.', resource);
      }
      if (index < requested.length - 1 && part.data.byteLength < MIN_PART_SIZE) {
        return s3Error(400, 'EntityTooSmall', 'Your proposed upload is smaller than the minimum allowed object size.', resource);
      }
      chunks.push(part.data);
      digests.push(md5(part.data));
    }
    const etag = `"${md5(Buffer.concat(digests)).toString('hex')}-${requested.length}"`;
    const object = store(Buffer.concat(chunks), etag);
    s3Objects.set(key, object);
    uploads.delete(uploadId);
    return xml('<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + `<Bucket>${S3_BUCKET}</Bucket><Key>${escapeXml(key)}</Key><ETag>${escapeXml(etag)}</ETag>`
      + '</CompleteMultipartUploadResult>');
  };

  const s3Respond = (request: FakeS3Request, bucket: string, key: string): FakeS3Response => {
    const { method, query, headers, body } = request;
    const resource = key === '' ? `/${bucket}` : `/${bucket}/${key}`;
    const credential = /Credential=([^/,\s]+)\//.exec(headers.authorization ?? '')?.[1];
    if (credential === undefined) return s3Error(403, 'AccessDenied', 'Access Denied', resource);
    if (credential !== S3_ACCESS_KEY_ID) {
      return s3Error(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', resource);
    }
    if (bucket === '') return s3Error(501, 'NotImplemented', 'ListBuckets is not used by dstu-sync', resource);
    if (bucket !== S3_BUCKET) {
      return method === 'HEAD' ? { status: 404 } : s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', resource);
    }
    if ((headers['content-encoding'] ?? '').includes('aws-chunked') || (headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) {
      return s3Error(501, 'NotImplemented', 'aws-chunked uploads are not expected with WhenRequired checksums', resource);
    }
    if (key === '') {
      if (method === 'HEAD') return { status: 200, headers: { 'x-amz-request-id': `wave0-${seq}` } };
      if (method === 'GET' && query.has('uploads')) return listUploads(query);
      if (method === 'GET' && query.get('list-type') === '2') return listObjectsV2(query, resource);
      if (method === 'GET') return s3Error(501, 'NotImplemented', 'only ListObjectsV2 is served', resource);
      return s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', resource);
    }
    const uploadId = query.get('uploadId');
    switch (method) {
      case 'POST':
        if (query.has('uploads')) {
          const id = `wave0-upload-${++uploadCounter}`;
          uploads.set(id, { key, initiated: tick(), parts: new Map() });
          return xml('<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            + `<Bucket>${S3_BUCKET}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${id}</UploadId>`
            + '</InitiateMultipartUploadResult>');
        }
        if (uploadId !== null) return completeUpload(uploadId, key, body, resource);
        return s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', resource);
      case 'PUT': {
        if (headers['x-amz-copy-source'] !== undefined) return s3Error(501, 'NotImplemented', 'CopyObject is not used by dstu-sync', resource);
        if (uploadId !== null) {
          const upload = uploads.get(uploadId);
          const partNumber = Number(query.get('partNumber'));
          if (upload === undefined || upload.key !== key) return s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.', resource);
          if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
            return s3Error(400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000, inclusive', resource);
          }
          const etag = `"${md5(body).toString('hex')}"`;
          upload.parts.set(partNumber, { data: Buffer.from(body), etag });
          return { status: 200, headers: { ETag: etag, 'x-amz-request-id': `wave0-${seq}` } };
        }
        const object = store(Buffer.from(body));
        s3Objects.set(key, object);
        return { status: 200, headers: { ETag: object.etag, 'x-amz-request-id': `wave0-${seq}` } };
      }
      case 'GET':
      case 'HEAD': {
        const object = s3Objects.get(key);
        if (object === undefined) {
          return method === 'HEAD' ? { status: 404 } : s3Error(404, 'NoSuchKey', 'The specified key does not exist.', resource);
        }
        const size = object.data.byteLength;
        const range = parseRange(headers.range, size);
        if (range.kind === 'unsatisfiable') {
          return { ...s3Error(416, 'InvalidRange', 'The requested range is not satisfiable', resource),
            headers: { 'Content-Type': 'application/xml', 'Content-Range': `bytes */${size}` } };
        }
        if (range.kind === 'partial') {
          return {
            status: 206,
            headers: { ...objectHeaders(object), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
            body: object.data.subarray(range.start, range.end + 1),
          };
        }
        return { status: 200, headers: objectHeaders(object), body: object.data };
      }
      case 'DELETE':
        if (uploadId !== null) {
          if (!uploads.delete(uploadId)) return s3Error(404, 'NoSuchUpload', 'The specified upload does not exist.', resource);
          return { status: 204 };
        }
        s3Objects.delete(key);
        return { status: 204, headers: { 'x-amz-request-id': `wave0-${seq}` } };
      default:
        return s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', resource);
    }
  };

  const s3: FakeS3 = await spawnFakeS3(request => {
    const segments = request.path.split('/').slice(1);
    let bucket = '';
    let key: string | null = '';
    try {
      bucket = decodeURIComponent(segments[0] ?? '');
      key = segments.slice(1).map(decodeURIComponent).join('/');
    } catch {
      key = null;
    }
    const path = key === null ? request.path : key === '' ? `/${bucket}` : `/${bucket}/${key}`;
    const fault = takeFault('s3', request.method, path);
    const response: FakeS3Response = fault === 'reset'
      ? { status: 0, destroySocket: true }
      : fault !== null
        ? { status: fault.status, headers: fault.headers, body: fault.body }
        : key === null ? s3Error(400, 'InvalidURI', 'Couldn\'t parse the specified URI.', request.path) : s3Respond(request, bucket, key);
    const query = [...request.query.entries()].sort(([a], [b]) => byteOrder(a, b))
      .map(([name, value]) => `${name}=${value}`).join('&');
    record({
      service: 's3', method: request.method, path, query, range: request.headers.range ?? null, depth: null,
      bodyBytes: request.body.byteLength, bodySha256: sha256(request.body),
      status: response.destroySocket === true ? 'reset' : response.status,
      responseSha256: response.destroySocket === true ? null : bodyHash(response.body), fault: fault !== null,
    });
    return response;
  }, options.s3Port ?? 0);

  // ------------------------------------------------------------------ service API

  const webdavEndpoint = webdav.endpoint;
  const s3Endpoint = s3.endpoint;

  const snapshotObjects = (objects: Map<string, StoredObject>): CloudObjectSnapshot[] =>
    [...objects.entries()].sort(([a], [b]) => byteOrder(a, b)).map(([key, object]) => ({
      key, size: object.data.byteLength, sha256: sha256(object.data), modified: object.modified.toISOString(), etag: object.etag,
    }));

  const service: CloudService = {
    webdavEndpoint,
    s3Endpoint,
    controlUrl: '',
    dataDir,
    get seedName() { return seedName; },
    config(provider, root = DEFAULT_ROOT): CloudConfigInjection {
      if (provider === 'webdav') {
        const safe = { endpoint: webdavEndpoint, username: WEBDAV_USERNAME };
        return {
          publish: {
            config: { provider: 'webdav', webdav: safe, root },
            credentials: { webdavPassword: WEBDAV_PASSWORD },
            encryptionPasswordIsPreexisting: false,
          },
          runtime: { provider: 'webdav', webdav: { ...safe, password: '' }, root },
        };
      }
      const safe = { endpoint: s3Endpoint, bucket: S3_BUCKET, accessKeyId: S3_ACCESS_KEY_ID, region: S3_REGION, pathStyle: true };
      return {
        publish: {
          config: { provider: 's3', s3: safe, root },
          credentials: { s3SecretAccessKey: S3_SECRET_ACCESS_KEY },
          encryptionPasswordIsPreexisting: false,
        },
        runtime: { provider: 's3', s3: { ...safe, secretAccessKey: '' }, root },
      };
    },
    resolve<T>(value: T): T {
      const walk = (node: unknown): unknown => {
        if (typeof node === 'string') {
          return node.replaceAll('${cloud.webdav.endpoint}', webdavEndpoint).replaceAll('${cloud.s3.endpoint}', s3Endpoint);
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node !== null && typeof node === 'object') {
          return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, walk(child)]));
        }
        return node;
      };
      return walk(value) as T;
    },
    reset(next) {
      if (next !== undefined) ({ name: seedName, seed } = resolveSeed(next));
      applySeed();
    },
    setFaults(next) {
      faults = next.map(fault => ({ ...fault, remaining: fault.times ?? 1 }));
    },
    requests: () => log.map(entry => ({ ...entry })),
    snapshot: () => ({
      webdav: { dirs: [...davDirs].sort(byteOrder), objects: snapshotObjects(davObjects) },
      s3: {
        objects: snapshotObjects(s3Objects),
        uploads: [...uploads.entries()].sort(([a], [b]) => byteOrder(a, b))
          .map(([uploadId, upload]) => ({ key: upload.key, uploadId, parts: [...upload.parts.keys()].sort((a, b) => a - b) })),
      },
    }),
    stop: async () => {
      await Promise.all([webdav.close(), s3.close(), closeControl()]);
      if (removeDataDir) {
        rmSync(dataDir, { recursive: true, force: true });
        liveDataDirs.delete(dataDir);
      }
    },
  };

  // ------------------------------------------------------------------ control API

  const sockets = new Set<Socket>();
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };
  const control: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload: Record<string, unknown> = {};
      if (raw.trim() !== '') {
        try { payload = JSON.parse(raw) as Record<string, unknown>; }
        catch (error) { reply(res, 400, { error: `invalid JSON: ${(error as Error).message}` }); return; }
      }
      const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
      try {
        if (route === 'GET /__cloud/state') {
          reply(res, 200, { webdav: webdavEndpoint, s3: s3Endpoint, seed: seedName, dataDir, requests: log.length, snapshot: service.snapshot() });
        } else if (route === 'POST /__cloud/reset') {
          service.reset(payload.seed as string | CloudSeed | undefined);
          reply(res, 200, { seed: seedName });
        } else if (route === 'POST /__cloud/faults') {
          service.setFaults((payload.faults ?? []) as CloudFault[]);
          reply(res, 200, { faults: faults.length });
        } else if (route === 'GET /__cloud/requests') {
          reply(res, 200, service.requests());
        } else {
          reply(res, 404, { error: `unknown control route ${route}` });
        }
      } catch (error) {
        reply(res, 400, { error: (error as Error).message });
      }
    });
  });
  control.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => { control.listen(options.controlPort ?? 0, '127.0.0.1', resolve); });
  const closeControl = (): Promise<void> => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    control.close(() => resolve());
  });
  (service as { controlUrl: string }).controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  return service;
}

// ------------------------------------------------------------------ CLI

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const port = (name: string): number | undefined => {
    const value = argValue(args, name);
    return value === undefined ? undefined : Number(value);
  };
  const service = await startCloudService({
    seed: argValue(args, 'seed'),
    webdavPort: port('webdav-port'),
    s3Port: port('s3-port'),
    controlPort: port('control-port'),
    dataDir: argValue(args, 'data-dir'),
    keepDataDir: args.includes('--keep-data-dir'),
  });
  process.stdout.write(`${JSON.stringify({
    webdav: service.webdavEndpoint, s3: service.s3Endpoint, control: service.controlUrl,
    dataDir: service.dataDir, seed: service.seedName, seeds: Object.keys(SEEDS), pid: process.pid,
  })}\n`);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const requests = service.requests();
    await service.stop();
    process.stdout.write(`${JSON.stringify({ stopped: true, requests })}\n`);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  if (!args.includes('--no-stdin')) {
    process.stdin.on('end', () => { void shutdown(); });
    process.stdin.resume();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  void main(process.argv.slice(2));
}
