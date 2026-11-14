/**
 * `pdfstream://` and `filestream://` protocol data sources.
 * Rust: dstu-vfs/src/pdf_protocol.rs + file_stream_protocol.rs.
 *
 * Both protocols serve local files with the same security model: canonicalize, a
 * directory allowlist, TOCTOU re-check on the opened handle, Range/HEAD/CORS and a
 * bounded response budget. filestream additionally rejects hidden path segments,
 * enforces a media-extension allowlist (relaxed inside VFS blob directories), and
 * supports `?mime=` overrides.
 */
import * as path from '../../../platform/util/path.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { Context, ProtocolReply, ProtocolRequestInfo } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import { fs, type LocalStats } from './local-runtime.ts';

export const DEFAULT_CORS_ORIGIN = 'tauri://localhost';
export const PDF_PROTOCOL_MAX_RESPONSE_BYTES = 200 * 1024 * 1024;
export const PDF_PROTOCOL_MAX_IN_FLIGHT_BYTES = 400 * 1024 * 1024;
export const FILE_STREAM_MAX_RESPONSE_BYTES = 200 * 1024 * 1024;
export const FILE_STREAM_MAX_IN_FLIGHT_BYTES = 400 * 1024 * 1024;
export const FILE_STREAM_MEDIA_CHUNK_BYTES = 16 * 1024 * 1024;

const ALLOWED_EXTENSIONS: readonly string[] = [
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba', 'aiff', 'aif', 'caf',
  'mp4', 'webm', 'mov', 'm4v', 'ogv', 'mpg', 'mpeg', '3gp', 'mkv', 'avi',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic',
  'pdf', 'bin',
];

export interface ProtocolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

class ResponseBudget {
  readonly registry: FinalizationRegistry<ResponseBudget>;
  private released = false;
  private readonly onRelease: () => void;
  constructor(registry: FinalizationRegistry<ResponseBudget>, onRelease: () => void) {
    this.registry = registry;
    this.onRelease = onRelease;
  }
  attach(body: Uint8Array): Uint8Array {
    this.registry.register(body, this, this);
    return body;
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.registry.unregister(this);
    this.onRelease();
  }
}

export function makeBudget(max: number) {
  let inFlight = 0;
  const registry = new FinalizationRegistry<ResponseBudget>(budget => budget.release());
  return {
    reserve(bytes: number): ResponseBudget | undefined {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
      if (inFlight + bytes > max) return undefined;
      inFlight += bytes;
      return new ResponseBudget(registry, () => { inFlight -= bytes; });
    },
  };
}

const pdfBudget = makeBudget(PDF_PROTOCOL_MAX_IN_FLIGHT_BYTES);
const fileBudget = makeBudget(FILE_STREAM_MAX_IN_FLIGHT_BYTES);

export function windowsComparablePathText(value: string): string {
  let unified = value.replaceAll('/', '\\');
  if (unified.startsWith('\\\\?\\UNC\\')) unified = `\\\\${unified.slice(8)}`;
  else if (unified.startsWith('\\\\?\\')) unified = unified.slice(4);
  return unified.replace(/\\+$/u, '').toLowerCase();
}

export function windowsPathStartsWith(value: string, dir: string): boolean {
  const normalizedPath = windowsComparablePathText(value);
  const normalizedDir = windowsComparablePathText(dir);
  if (normalizedDir === '') return false;
  if (normalizedPath === normalizedDir) return true;
  return normalizedPath.startsWith(normalizedDir)
    && normalizedPath.charAt(normalizedDir.length) === '\\';
}

/** Rust `path.starts_with` (component boundary) with Windows verbatim-form normalization. */
export function pathIsWithin(value: string, dir: string): boolean {
  const relative = path.relative(dir, value);
  const native = relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (native) return true;
  if (path.sep === '\\') return windowsPathStartsWith(value, dir);
  return false;
}

export function hasHiddenSegmentWithin(value: string, allowedDirs: readonly string[]): boolean {
  let base: string | undefined;
  for (const dir of allowedDirs) {
    if (!pathIsWithin(value, dir)) continue;
    if (base === undefined || dir.length > base.length) base = dir;
  }
  if (base === undefined) return true;
  const relative = path.relative(base, value);
  return relative.split(path.sep).some(segment => segment.startsWith('.'));
}

export function isAllowedMediaExtension(ext: string): boolean {
  return ALLOWED_EXTENSIONS.includes(ext.toLowerCase());
}

export function extensionPermitted(value: string, blobDirs: readonly string[]): boolean {
  if (blobDirs.some(dir => pathIsWithin(value, dir))) return true;
  const ext = path.extname(value);
  return ext !== '' && isAllowedMediaExtension(ext.slice(1));
}

export function fileStreamMimeType(value: string): string {
  const ext = path.extname(value).toLowerCase();
  switch (ext) {
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg':
    case '.oga':
    case '.opus': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.flac': return 'audio/flac';
    case '.aac': return 'audio/aac';
    case '.weba': return 'audio/webm';
    case '.aiff':
    case '.aif': return 'audio/aiff';
    case '.caf': return 'audio/x-caf';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.m4v': return 'video/x-m4v';
    case '.ogv': return 'video/ogg';
    case '.mpg':
    case '.mpeg': return 'video/mpeg';
    case '.3gp': return 'video/3gpp';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.avif': return 'image/avif';
    case '.heic': return 'image/heic';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export function pdfMimeType(value: string): string {
  const ext = path.extname(value);
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.txt': return 'text/plain';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

/**
 * Non-media overrides the file previewer needs for VFS blobs stored without a
 * usable extension (`<hash>.bin`). HTML/script types stay blocked so the
 * protocol can never be turned into a same-origin document/XSS vector.
 */
const ALLOWED_APPLICATION_MIME_OVERRIDES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/epub+zip',
]);
const ALLOWED_TEXT_MIME_OVERRIDES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
]);
const OPENXML_MIME_PREFIX = 'application/vnd.openxmlformats-officedocument.';

export function sanitizeMimeOverride(raw: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); }
  catch { return undefined; }
  const mime = rustTrim(decoded).toLowerCase();
  const slash = mime.indexOf('/');
  if (slash < 0) return undefined;
  const family = mime.slice(0, slash);
  const subtype = mime.slice(slash + 1);
  if (subtype === '' || subtype.length > 128) return undefined;
  if (!/^[a-z0-9.+-]+$/u.test(subtype)) return undefined;
  if (family === 'audio' || family === 'video' || family === 'image') return mime;
  if (ALLOWED_APPLICATION_MIME_OVERRIDES.has(mime) || ALLOWED_TEXT_MIME_OVERRIDES.has(mime)) return mime;
  if (mime.startsWith(OPENXML_MIME_PREFIX)) return mime;
  return undefined;
}

export function mimeOverrideFromQuery(query: string | null): string | undefined {
  if (query === null) return undefined;
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (key !== 'mime') continue;
    return sanitizeMimeOverride(separator < 0 ? '' : pair.slice(separator + 1));
  }
  return undefined;
}

export function parseRangeHeader(range: string, fileSize: number): readonly [number, number] | undefined {
  const prefix = 'bytes=';
  if (!range.startsWith(prefix)) return undefined;
  const parts = range.slice(prefix.length).split('-');
  if (parts.length !== 2) return undefined;
  const startText = rustTrim(parts[0]!);
  const endText = rustTrim(parts[1]!);
  if (startText !== '' && endText !== '') {
    const start = parseUnsigned(startText);
    const end = parseUnsigned(endText);
    if (start === undefined || end === undefined) return undefined;
    if (start > end || start >= fileSize) return undefined;
    return [start, Math.min(end, fileSize - 1)];
  }
  if (startText !== '') {
    const start = parseUnsigned(startText);
    if (start === undefined || start >= fileSize) return undefined;
    return [start, fileSize - 1];
  }
  if (endText !== '') {
    if (fileSize === 0) return undefined;
    const suffix = parseUnsigned(endText);
    if (suffix === undefined || suffix === 0) return undefined;
    return [Math.max(0, fileSize - suffix), fileSize - 1];
  }
  return undefined;
}

function parseUnsigned(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function isAllowedOrigin(origin: string): boolean {
  return origin === DEFAULT_CORS_ORIGIN
    || origin === 'http://tauri.localhost'
    || origin === 'https://tauri.localhost'
    || origin === 'http://localhost'
    || origin === 'https://localhost'
    || origin.startsWith('http://localhost:')
    || origin.startsWith('https://localhost:')
    || origin === 'http://127.0.0.1'
    || origin === 'https://127.0.0.1'
    || origin.startsWith('http://127.0.0.1:')
    || origin.startsWith('https://127.0.0.1:');
}

export function corsOriginForRequest(origin: string | undefined): string {
  return origin !== undefined && isAllowedOrigin(origin) ? origin : DEFAULT_CORS_ORIGIN;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    Vary: 'Origin',
  };
}

function deniedHeaders(origin: string): Record<string, string> {
  return { Vary: 'Origin', 'Access-Control-Allow-Origin': origin };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function empty(status: number, headers: Record<string, string> = {}): ProtocolReply {
  return { status, headers, body: new Uint8Array(0) };
}

function decodeRequestPath(url: string): string {
  const parsed = new URL(url);
  const raw = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  return decodeURIComponent(raw);
}

export function checkedResponseLen(length: number, max: number): number | undefined {
  return Number.isSafeInteger(length) && length <= max ? length : undefined;
}

interface OpenedFile {
  fd: number;
  size: number;
  close(): void;
}

export function openedFileMatchesAuthorizedPath(
  fd: number,
  expectedPath: string,
  allowedDirs: readonly string[],
): boolean {
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.statSync(expectedPath);
    if (opened.dev !== current.dev || opened.ino !== current.ino) return false;
    const canonicalCurrent = fs.realpathSync(expectedPath);
    return allowedDirs.some(dir => pathIsWithin(canonicalCurrent, dir));
  } catch {
    return false;
  }
}

function openAuthorizedFile(
  canonicalPath: string,
  allowedDirs: readonly string[],
): OpenedFile | undefined {
  const fd = fs.openSync(canonicalPath, 'r');
  try {
    if (!openedFileMatchesAuthorizedPath(fd, canonicalPath, allowedDirs)) {
      fs.closeSync(fd);
      return undefined;
    }
    return { fd, size: fs.fstatSync(fd).size, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readExact(file: OpenedFile, length: number, position: number): Uint8Array | undefined {
  const buffer = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const chunk = fs.readSync(file.fd, buffer, read, length - read, position + read);
    if (chunk <= 0) return undefined;
    read += chunk;
  }
  return buffer;
}

interface StreamOptions {
  readonly pdfOnly: boolean;
  readonly allowedDirs: readonly string[];
  readonly blobDirs: readonly string[];
  readonly maxResponseBytes: number;
  readonly budget: ReturnType<typeof makeBudget>;
  readonly mime: (path: string) => string;
  readonly chunkMedia: boolean;
  /** Validated `?mime=` override (see sanitizeMimeOverride). */
  readonly mimeOverride?: string;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/** VFS blobs are content-addressed (`<hash>.bin`), so the extension alone cannot prove PDF-ness. */
function hasPdfMagic(file: OpenedFile): boolean {
  const head = readExact(file, PDF_MAGIC.length, 0);
  return head !== undefined && PDF_MAGIC.every((byte, index) => head[index] === byte);
}

function isBlobLikePath(value: string, blobDirs: readonly string[]): boolean {
  const ext = path.extname(value).toLowerCase();
  return ext === '.bin' || ext === '.octet-stream' || blobDirs.some(dir => pathIsWithin(value, dir));
}

export function handleAssetProtocol(
  request: ProtocolRequest,
  options: StreamOptions,
): ProtocolReply {
  const origin = corsOriginForRequest(headerValue(request.headers, 'origin'));
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return empty(204, corsHeaders(origin));
  if (method !== 'GET' && method !== 'HEAD') {
    return empty(405, { ...corsHeaders(origin), Allow: 'GET, HEAD, OPTIONS' });
  }

  const decoded = decodeRequestPath(request.url);
  let canonical: string;
  try { canonical = fs.realpathSync(decoded); }
  catch { return empty(404, deniedHeaders(origin)); }

  if (!options.allowedDirs.some(dir => pathIsWithin(canonical, dir))) {
    return empty(403, deniedHeaders(origin));
  }

  if (!options.pdfOnly) {
    if (hasHiddenSegmentWithin(canonical, options.allowedDirs)) {
      return empty(403, deniedHeaders(origin));
    }
    if (!extensionPermitted(canonical, options.blobDirs)) {
      return empty(403, deniedHeaders(origin));
    }
  }

  let stat: LocalStats;
  try { stat = fs.statSync(canonical); }
  catch { return empty(404, deniedHeaders(origin)); }
  if (!stat.isFile()) return empty(404, deniedHeaders(origin));

  let file: OpenedFile;
  try {
    const opened = openAuthorizedFile(canonical, options.allowedDirs);
    if (opened === undefined) return empty(403, corsHeaders(origin));
    file = opened;
  } catch { return empty(404, deniedHeaders(origin)); }

  try {
    // Only sniff while holding the authorized handle: the bytes checked are the
    // bytes served (the pre-open extension check cannot read content anyway).
    const pdfMagic = options.pdfOnly ? hasPdfMagic(file) : false;
    if (options.pdfOnly) {
      const isPdfExtension = path.extname(canonical).toLowerCase() === '.pdf';
      const overridePdf = options.mimeOverride === 'application/pdf';
      const sniffable = isBlobLikePath(canonical, options.blobDirs) && pdfMagic;
      if (!isPdfExtension && !overridePdf && !sniffable) {
        return empty(403, deniedHeaders(origin));
      }
    }

    const fileSize = file.size;
    const contentType = options.pdfOnly && (pdfMagic || options.mimeOverride === 'application/pdf')
      ? 'application/pdf'
      : options.mime(canonical);

    if (method === 'HEAD') {
      return empty(200, {
        ...corsHeaders(origin),
        'Content-Type': contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      });
    }

    const rangeHeader = headerValue(request.headers, 'range');
    if (rangeHeader !== undefined) {
      const range = parseRangeHeader(rangeHeader, fileSize);
      if (range === undefined) {
        return empty(416, {
          ...corsHeaders(origin),
          'Content-Range': `bytes */${fileSize}`,
        });
      }
      const [start, initialEnd] = range;
      let end = initialEnd;
      if (!options.pdfOnly && isStreamedMedia(contentType)
        && end - start + 1 > FILE_STREAM_MEDIA_CHUNK_BYTES) {
        end = start + FILE_STREAM_MEDIA_CHUNK_BYTES - 1;
      }
      const length = end - start + 1;
      const bufferLen = checkedResponseLen(length, options.maxResponseBytes);
      if (bufferLen === undefined) {
        return empty(416, {
          ...corsHeaders(origin),
          'Content-Range': `bytes */${fileSize}`,
        });
      }
      const budget = options.budget.reserve(length);
      if (budget === undefined) {
        return empty(503, { ...corsHeaders(origin), 'Retry-After': '1' });
      }
      let body;
      try { body = readExact(file, bufferLen, start); }
      catch (error) { budget.release(); throw error; }
      if (body === undefined) {
        budget.release();
        return empty(416, {
          ...corsHeaders(origin),
          'Content-Range': `bytes */${fileSize}`,
        });
      }
      return {
        status: 206,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': contentType,
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
        },
        body: budget.attach(body),
      };
    }

    const bufferLen = checkedResponseLen(fileSize, options.maxResponseBytes);
    if (bufferLen === undefined) {
      return empty(413, { ...corsHeaders(origin), 'Accept-Ranges': 'bytes' });
    }
    const budget = options.budget.reserve(fileSize);
    if (budget === undefined) {
      return empty(503, { ...corsHeaders(origin), 'Retry-After': '1' });
    }
    let body;
    try { body = readExact(file, bufferLen, 0); }
    catch (error) { budget.release(); throw error; }
    if (body === undefined) {
      budget.release();
      return empty(416, { ...corsHeaders(origin), 'Content-Range': `bytes */${fileSize}` });
    }
    return {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': contentType,
        'Content-Length': String(bufferLen),
        'Accept-Ranges': 'bytes',
      },
      body: budget.attach(body),
    };
  } finally {
    file.close();
  }
}

function isStreamedMedia(contentType: string): boolean {
  const normalized = rustTrim(contentType).toLowerCase();
  return normalized.startsWith('video/') || normalized.startsWith('audio/');
}

export function handlePdfStream(
  request: ProtocolRequest,
  allowedDirs: readonly string[],
  blobDirs: readonly string[] = [],
): ProtocolReply {
  const url = new URL(request.url);
  const override = mimeOverrideFromQuery(url.search.startsWith('?') ? url.search.slice(1) : null);
  return handleAssetProtocol(request, {
    pdfOnly: true,
    allowedDirs,
    blobDirs,
    maxResponseBytes: PDF_PROTOCOL_MAX_RESPONSE_BYTES,
    budget: pdfBudget,
    mime: pdfMimeType,
    chunkMedia: false,
    ...(override === undefined ? {} : { mimeOverride: override }),
  });
}

export function handleFileStream(
  request: ProtocolRequest,
  allowedDirs: readonly string[],
  blobDirs: readonly string[],
): ProtocolReply {
  const url = new URL(request.url);
  const override = mimeOverrideFromQuery(url.search.startsWith('?') ? url.search.slice(1) : null);
  return handleAssetProtocol(request, {
    pdfOnly: false,
    allowedDirs,
    blobDirs,
    maxResponseBytes: FILE_STREAM_MAX_RESPONSE_BYTES,
    budget: fileBudget,
    mime: value => override ?? fileStreamMimeType(value),
    chunkMedia: true,
    ...(override === undefined ? {} : { mimeOverride: override }),
  });
}

export function filestreamCheckAccess(
  requestedPath: string,
  allowedDirs: readonly string[],
  blobDirs: readonly string[],
): boolean {
  let canonical: string;
  try { canonical = fs.realpathSync(requestedPath); }
  catch { return false; }
  if (!allowedDirs.some(dir => pathIsWithin(canonical, dir))) return false;
  if (hasHiddenSegmentWithin(canonical, allowedDirs)) return false;
  if (!extensionPermitted(canonical, blobDirs)) return false;
  try { return fs.statSync(canonical).isFile(); }
  catch { return false; }
}

/** Rust `resolve_allowed_dirs` (pdf_protocol.rs:259-311). */
export function resolveAllowedDirs(database: VfsDatabase, appDataDir: string, home = fs.homeDir()): string[] {
  const candidates = [
    appDataDir,
    database.appDataDir(),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures'),
    fs.tmpDir(),
    database.blobsDir(),
  ];
  const dirs: string[] = [];
  for (const candidate of candidates) {
    let resolved: string;
    try { resolved = fs.realpathSync(candidate); }
    catch { resolved = candidate; }
    if (!dirs.includes(resolved)) dirs.push(resolved);
  }
  return dirs;
}

/** Rust `resolve_blob_dirs` (file_stream_protocol.rs:215-225). */
export function resolveBlobDirs(database: VfsDatabase): string[] {
  try { return [fs.realpathSync(database.blobsDir())]; }
  catch { return [database.blobsDir()]; }
}

export function registerProtocols(ctx: Context, database: VfsDatabase): void {
  const allowedDirs = (): string[] => resolveAllowedDirs(database, ctx.app.dataDir);
  const blobDirs = (): string[] => resolveBlobDirs(database);
  ctx.protocols.register('pdfstream', (request: ProtocolRequestInfo) => handlePdfStream(
    { url: request.url, method: request.method, headers: request.headers },
    allowedDirs(),
    blobDirs(),
  ));
  ctx.protocols.register('filestream', (request: ProtocolRequestInfo) => handleFileStream(
    { url: request.url, method: request.method, headers: request.headers },
    allowedDirs(),
    blobDirs(),
  ));
}
