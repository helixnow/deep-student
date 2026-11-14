/**
 * Chunked staged uploads, ported from dstu-storage/src/staged_upload.rs.
 *
 * `staged_upload_append` in Rust injects `tauri::ipc::Request` and therefore
 * reads the raw invoke body plus the `x-upload-id` / `x-upload-offset` headers.
 * The Host CallContext exposes the raw body as `payload`; headers are an
 * additive F1 field (electron/api.ts declares it) that this module reads when
 * present and reports as missing otherwise, exactly like the Rust parser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorText } from './data-space-files.ts';
import { storageLog } from './logging.ts';
import { decodeBase64Standard, rustTrim, utf8ByteLength } from '../util/portable.ts';

const LOG_TARGET = 'dstu_storage::staged_upload';

export const STAGED_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const STAGED_UPLOAD_MEDIA_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const STAGED_UPLOAD_MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const STAGED_UPLOAD_IDLE_TTL_MS = 30 * 60 * 1000;
const STAGING_DIR_NAME = 'staged_uploads';
const PART_SUFFIX = '.part';

export const HEADER_UPLOAD_ID = 'x-upload-id';
export const HEADER_UPLOAD_OFFSET = 'x-upload-offset';

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'm4b', 'flac', 'aac', 'opus', 'wma', 'aiff', 'aif', 'caf', 'weba',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts',
]);

function extensionOf(name: string): string | null {
  const ext = path.extname(name);
  return ext ? ext.slice(1).toLowerCase() : null;
}

/** dstu-core/src/media_types.rs:40 `media_kind("", name).is_some()`. */
export function isMediaName(name: string): boolean {
  const ext = extensionOf(name);
  if (!ext) return false;
  return ext === 'bilibili' || AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

/** staged_upload.rs:37. */
export function maxBytesForName(name: string): number {
  return isMediaName(name) ? STAGED_UPLOAD_MEDIA_MAX_BYTES : STAGED_UPLOAD_MAX_BYTES;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function tooLargeError(actual: number, max: number): Error {
  return new Error(`File too large: max ${formatMb(max)}, got ${formatMb(actual)}`);
}

function partPath(dir: string, id: string): string {
  return path.join(dir, `${id}${PART_SUFFIX}`);
}

interface Entry {
  path: string;
  name: string;
  total: number;
  received: number;
  lastTouch: number;
}

const registry = new Map<string, Entry>();
let startupSwept = false;

/** A complete staged file; `dispose()` mirrors Rust `StagedFile::drop`. */
export class StagedFile {
  private readonly filePath: string;
  private readonly fileName: string;
  private readonly byteSize: number;
  private disposed = false;

  constructor(filePath: string, name: string, size: number) {
    this.filePath = filePath;
    this.fileName = name;
    this.byteSize = size;
  }

  path(): string { return this.filePath; }
  name(): string { return this.fileName; }
  size(): number { return this.byteSize; }

  /** staged_upload.rs:117. */
  readBounded(maxBytes: number): Uint8Array {
    if (this.byteSize > maxBytes) throw tooLargeError(this.byteSize, maxBytes);
    let fd: number;
    try { fd = fs.openSync(this.filePath, 'r'); }
    catch (error) { throw new Error(`Failed to open staged upload: ${errorText(error)}`); }
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    const chunks: Buffer[] = [];
    let read = 0;
    try {
      while (read <= maxBytes) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes + 1 - read), null);
        if (count === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, count)));
        read += count;
      }
    } catch (error) {
      throw new Error(`Failed to read staged upload: ${errorText(error)}`);
    } finally {
      fs.closeSync(fd);
    }
    if (read > maxBytes) throw tooLargeError(read, maxBytes);
    if (read !== this.byteSize) {
      throw new Error(`Staged upload changed on disk: expected ${this.byteSize} bytes, read ${read}`);
    }
    return new Uint8Array(Buffer.concat(chunks, read));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { fs.unlinkSync(this.filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        storageLog(LOG_TARGET, 'warn', `Failed to remove staged file ${this.filePath}: ${errorText(error)}`);
      }
    }
  }
}

/** staged_upload.rs:159. */
export function sweep(dir: string, removeAllOrphans: boolean): void {
  const now = performance.now();
  const expired: Array<[string, string]> = [];
  for (const [id, entry] of registry) {
    if (now - entry.lastTouch > STAGED_UPLOAD_IDLE_TTL_MS) expired.push([id, entry.path]);
  }
  for (const [id, file] of expired) {
    storageLog(LOG_TARGET, 'info', `Dropping idle staged upload ${id}`);
    registry.delete(id);
    try { fs.unlinkSync(file); }
    catch (error) { storageLog(LOG_TARGET, 'debug', `Failed to remove idle staged file ${file}: ${errorText(error)}`); }
  }

  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const registered = new Set([...registry.values()].map((entry) => entry.path));
  for (const item of items) {
    const file = path.join(dir, item.name);
    if (registered.has(file)) continue;
    let stale = removeAllOrphans;
    if (!stale) {
      try { stale = Date.now() - fs.statSync(file).mtimeMs > STAGED_UPLOAD_IDLE_TTL_MS; }
      catch { stale = false; }
    }
    if (stale && item.isFile()) {
      try { fs.unlinkSync(file); }
      catch (error) { storageLog(LOG_TARGET, 'debug', `Failed to remove orphan staged file ${file}: ${errorText(error)}`); }
    }
  }
}

/** staged_upload.rs:213. */
function prepareDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (error) { throw new Error(`Failed to create staging directory: ${errorText(error)}`); }
  const first = !startupSwept;
  startupSwept = true;
  sweep(dir, first);
}

function createPart(dir: string, id: string): string {
  const file = partPath(dir, id);
  try { fs.closeSync(fs.openSync(file, 'wx')); }
  catch (error) { throw new Error(`Failed to create staged upload file: ${errorText(error)}`); }
  return file;
}

/** staged_upload.rs:223. */
export function beginIn(dir: string, name: string, totalSize: number, maxBytes: number): string {
  const limit = Math.min(maxBytes, STAGED_UPLOAD_MEDIA_MAX_BYTES);
  if (totalSize > limit) throw tooLargeError(totalSize, limit);
  prepareDir(dir);
  const id = randomUUID().replace(/-/g, '');
  const file = createPart(dir, id);
  registry.set(id, { path: file, name, total: totalSize, received: 0, lastTouch: performance.now() });
  return id;
}

/** staged_upload.rs:251. */
export function append(uploadId: string, offset: number | bigint, chunk: Uint8Array): number {
  if (chunk.length > STAGED_UPLOAD_MAX_CHUNK_BYTES) {
    throw new Error(`Chunk too large: ${chunk.length} bytes (max ${STAGED_UPLOAD_MAX_CHUNK_BYTES})`);
  }
  const entry = registry.get(uploadId);
  if (!entry) throw new Error(`Unknown or expired upload: ${uploadId}`);
  if (BigInt(offset) !== BigInt(entry.received)) {
    throw new Error(`Unexpected chunk offset ${offset} (expected ${entry.received})`);
  }
  const next = entry.received + chunk.length;
  if (next > entry.total) {
    abort(uploadId);
    throw new Error(`Chunk exceeds declared size: ${next} > ${entry.total}`);
  }
  try {
    const fd = fs.openSync(entry.path, 'a');
    try { writeAll(fd, chunk); } finally { fs.closeSync(fd); }
  } catch (error) {
    abort(uploadId);
    throw new Error(`Failed to write staged upload chunk: ${errorText(error)}`);
  }
  entry.received = next;
  entry.lastTouch = performance.now();
  return next;
}

/** staged_upload.rs:292. */
export function abort(uploadId: string): void {
  const entry = registry.get(uploadId);
  if (!entry) return;
  registry.delete(uploadId);
  try { fs.unlinkSync(entry.path); }
  catch (error) { storageLog(LOG_TARGET, 'debug', `Failed to remove aborted staged file ${entry.path}: ${errorText(error)}`); }
}

/** staged_upload.rs:301. */
export function takeStagedUpload(uploadId: string): StagedFile {
  const entry = registry.get(uploadId);
  if (!entry) throw new Error(`Unknown or expired upload: ${uploadId}`);
  registry.delete(uploadId);
  const staged = new StagedFile(entry.path, entry.name, entry.received);
  if (entry.received !== entry.total) {
    staged.dispose();
    throw new Error(`Upload incomplete: received ${entry.received} of ${entry.total} bytes`);
  }
  return staged;
}

/** staged_upload.rs:322. */
export async function stageFromReader(
  dir: string,
  name: string,
  reader: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ uploadId: string; size: number }> {
  const limit = Math.min(maxBytes, STAGED_UPLOAD_MEDIA_MAX_BYTES);
  prepareDir(dir);
  const id = randomUUID().replace(/-/g, '');
  const file = createPart(dir, id);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'a');
    let written = 0;
    try {
      for await (const chunk of reader) {
        const room = limit + 1 - written;
        if (room <= 0) break;
        const bytes = chunk.length > room ? chunk.subarray(0, room) : chunk;
        writeAll(fd, bytes);
        written += bytes.length;
        if (written > limit || bytes.length < chunk.length) break;
      }
    } catch (error) {
      throw new Error(`Failed to copy file into staging area: ${errorText(error)}`);
    }
    if (written > limit) throw tooLargeError(written, limit);
    try { fs.fsyncSync(fd); }
    catch (error) { throw new Error(`Failed to flush staged upload: ${errorText(error)}`); }
    fs.closeSync(fd);
    fd = null;
    registry.set(id, { path: file, name, total: written, received: written, lastTouch: performance.now() });
    return { uploadId: id, size: written };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); }
      catch (closeError) { storageLog(LOG_TARGET, 'debug', `Failed to close staged upload ${file}: ${errorText(closeError)}`); }
    }
    try { fs.unlinkSync(file); }
    catch (unlinkError) { storageLog(LOG_TARGET, 'debug', `Failed to remove incomplete staged upload ${file}: ${errorText(unlinkError)}`); }
    throw error;
  }
}

/** Rust Write::write_all / io::copy: retry short writes and Interrupted. */
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    let written: number;
    try { written = fs.writeSync(fd, bytes, offset, bytes.length - offset); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      throw error;
    }
    if (written === 0) throw new Error('failed to write whole buffer');
    offset += written;
  }
}

function parseHeaderOffset(headerOffset: string | undefined): number | bigint | undefined {
  if (headerOffset === undefined) return undefined;
  const trimmed = rustTrim(headerOffset);
  if (!/^\+?[0-9]+$/.test(trimmed)) throw new Error(`Invalid ${HEADER_UPLOAD_OFFSET} header`);
  const value = BigInt(trimmed);
  if (value > 18446744073709551615n) throw new Error(`Invalid ${HEADER_UPLOAD_OFFSET} header`);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function decodeBase64(data: string): Uint8Array {
  const decoded = decodeBase64Standard(data);
  if (decoded.error !== undefined) throw new Error(`Invalid chunk base64: ${decoded.error}`);
  return new Uint8Array(decoded.bytes);
}

/**
 * staged_upload.rs:379. `body` is the Host raw invoke payload: `Uint8Array`
 * for `InvokeBody::Raw`, a plain object / array for `InvokeBody::Json`.
 */
export function parseAppendRequest(
  body: unknown,
  headerId?: string,
  headerOffset?: string,
): { uploadId: string; offset: number | bigint; bytes: Uint8Array } {
  const parsedHeaderOffset = parseHeaderOffset(headerOffset);

  if (body instanceof Uint8Array) {
    const uploadId = headerId;
    if (uploadId === undefined) throw new Error(`Missing ${HEADER_UPLOAD_ID} header`);
    if (parsedHeaderOffset === undefined) throw new Error(`Missing ${HEADER_UPLOAD_OFFSET} header`);
    if (body.length > STAGED_UPLOAD_MAX_CHUNK_BYTES) throw new Error(`Chunk too large: ${body.length} bytes`);
    return { uploadId, offset: parsedHeaderOffset, bytes: Uint8Array.from(body) };
  }

  if (Array.isArray(body)) {
    const uploadId = headerId;
    if (uploadId === undefined) throw new Error(`Missing ${HEADER_UPLOAD_ID} header`);
    if (parsedHeaderOffset === undefined) throw new Error(`Missing ${HEADER_UPLOAD_OFFSET} header`);
    if (body.length > STAGED_UPLOAD_MAX_CHUNK_BYTES) throw new Error(`Chunk too large: ${body.length} bytes`);
    const bytes = new Uint8Array(body.length);
    for (let index = 0; index < body.length; index++) {
      const value = body[index];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error('Invalid byte in chunk');
      }
      bytes[index] = value;
    }
    return { uploadId, offset: parsedHeaderOffset, bytes };
  }

  if (typeof body === 'object' && body !== null) {
    const map = body as Record<string, unknown>;
    const uploadId = typeof map.uploadId === 'string' ? map.uploadId : headerId;
    if (uploadId === undefined) throw new Error('Missing uploadId');
    const rawOffset = map.offset;
    const offset = typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset >= 0 && BigInt(rawOffset) <= 18446744073709551615n
      ? (Number.isSafeInteger(rawOffset) ? rawOffset : BigInt(rawOffset))
      : parsedHeaderOffset;
    if (offset === undefined) throw new Error('Missing offset');
    const data = map.data;
    if (typeof data !== 'string') throw new Error('Missing chunk data');
    const encodedBytes = utf8ByteLength(data);
    if (encodedBytes > Math.ceil(STAGED_UPLOAD_MAX_CHUNK_BYTES / 3) * 4 + 4) {
      throw new Error(`Chunk too large: ${encodedBytes} base64 chars`);
    }
    return { uploadId, offset, bytes: decodeBase64(data) };
  }

  throw new Error('Unsupported chunk payload');
}

export function stagingDir(appCacheDir: string): string {
  return path.join(appCacheDir, STAGING_DIR_NAME);
}
