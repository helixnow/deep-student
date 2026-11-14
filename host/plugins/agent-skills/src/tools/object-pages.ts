/**
 * Managed-object page I/O for PTC `object_read` / `object_write`.
 *
 * Port of `dstu-core/src/task_objects.rs:783-1120` (`read_task_object_page` /
 * `write_task_object_page`): the same root whitelist, locator validation,
 * canonicalized prefix checks, UTF-8 page boundary handling, optimistic
 * `expected_sha256` lock and atomic tmp+rename write.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { managedLocator, type ManagedLocator } from './task-objects.ts';

export interface ObjectPageLogger {
  warn?(message: string): void;
}

export const OBJECT_READABLE_ROOT_IDS: readonly string[] = ['artifacts'];
export const OBJECT_WRITABLE_ROOT_IDS: readonly string[] = ['artifacts'];
export const OBJECT_READ_PAGE_MAX_BYTES = 32 * 1024;
export const OBJECT_WRITE_MAX_BYTES = 256 * 1024;

export interface TaskObjectPage {
  content: string;
  encoding: 'utf-8' | 'base64';
  offset: number;
  next_offset: number;
  total_size: number;
  eof: boolean;
  sha256: string;
}

export interface TaskObjectWriteOutcome {
  sha256: string;
  total_size: number;
  written_bytes: number;
  created: boolean;
}

function ioMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedRelative(locator: ManagedLocator): string {
  const parts = locator.relativePath.split('/').filter(part => part !== '.');
  if (parts.length === 0 || parts.some(part => part === '' || part === '..')) {
    throw new Error('relative_path does not identify a file');
  }
  return parts.join('/');
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `read_task_object_page`: one bounded page plus whole-file sha256. */
export function readTaskObjectPage(
  rootDir: string,
  locator: ManagedLocator,
  offset: number,
  limit: number,
): TaskObjectPage {
  if (!OBJECT_READABLE_ROOT_IDS.includes(locator.rootId)) {
    throw new Error(
      `root_id '${locator.rootId}' is not object-readable `
      + `(allowed: ${OBJECT_READABLE_ROOT_IDS.join(', ')})`,
    );
  }
  // Defensive: a deserialized/hand-built locator may not have gone through managedLocator().
  managedLocator(locator.rootId, locator.relativePath);
  if (limit <= 0) throw new Error('limit must be positive');
  const effectiveLimit = Math.min(limit, OBJECT_READ_PAGE_MAX_BYTES);
  const relative = normalizedRelative(locator);

  let rootCanon: string;
  try { rootCanon = realpathSync(rootDir); }
  catch (error) {
    throw new Error(`managed root '${locator.rootId}' is unavailable: ${ioMessage(error)}`);
  }
  let fileCanon: string;
  try { fileCanon = realpathSync(path.join(rootCanon, relative)); }
  catch (error) {
    throw new Error(`object '${locator.relativePath}' is not readable: ${ioMessage(error)}`);
  }
  if (!isInside(rootCanon, fileCanon)) throw new Error('object path escapes the managed root');
  let metadata;
  try { metadata = statSync(fileCanon); }
  catch (error) {
    throw new Error(`object '${locator.relativePath}' is not readable: ${ioMessage(error)}`);
  }
  if (!metadata.isFile()) throw new Error(`object '${locator.relativePath}' is not a file`);

  let bytes: Buffer;
  try { bytes = readFileSync(fileCanon); }
  catch (error) {
    throw new Error(`failed to read object '${locator.relativePath}': ${ioMessage(error)}`);
  }
  const totalSize = bytes.length;
  const sha256 = sha256Hex(bytes);
  const text = decodeUtf8(bytes);
  const encoding = text === null ? 'base64' : 'utf-8';
  if (offset >= totalSize) {
    return {
      content: '', encoding, offset: totalSize, next_offset: totalSize, total_size: totalSize,
      eof: true, sha256,
    };
  }
  if (offset < 0) throw new Error(`offset must be >= 0, got ${offset}`);

  if (text !== null) {
    if ((bytes[offset]! & 0b1100_0000) === 0b1000_0000) {
      throw new Error(
        'offset splits a UTF-8 character; use next_offset from the previous page',
      );
    }
    let end = Math.min(offset + effectiveLimit, totalSize);
    while (end > offset && end < totalSize && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
      end -= 1;
    }
    if (end === offset) {
      end = offset + 1;
      while (end < totalSize && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end += 1;
    }
    const content = decodeUtf8(bytes.subarray(offset, end));
    if (content === null) throw new Error('internal error: page slice is not valid UTF-8');
    return {
      content, encoding, offset, next_offset: end, total_size: totalSize, eof: end >= totalSize,
      sha256,
    };
  }
  const end = Math.min(offset + effectiveLimit, totalSize);
  return {
    content: bytes.subarray(offset, end).toString('base64'),
    encoding,
    offset,
    next_offset: end,
    total_size: totalSize,
    eof: end >= totalSize,
    sha256,
  };
}

/** Best-effort tmp cleanup; Rust discards the error, we keep a warning. */
function removeTmpQuietly(tmp: string, logger: ObjectPageLogger): void {
  try { rmSync(tmp, { force: true }); }
  catch (error) {
    logger.warn?.(`[agent-skills] failed to remove ptc write temp ${tmp}: ${ioMessage(error)}`);
  }
}

/**
 * `write_task_object_page`: pwrite semantics, `expected_sha256` optimistic lock
 * and atomic tmp+rename finalisation.
 */
export function writeTaskObjectPage(
  rootDir: string,
  locator: ManagedLocator,
  content: Uint8Array,
  offset: number | null | undefined,
  expectedSha256: string | null | undefined,
  logger: ObjectPageLogger = {},
): TaskObjectWriteOutcome {
  if (!OBJECT_WRITABLE_ROOT_IDS.includes(locator.rootId)) {
    throw new Error(
      `root_id '${locator.rootId}' is not object-writable `
      + `(allowed: ${OBJECT_WRITABLE_ROOT_IDS.join(', ')})`,
    );
  }
  managedLocator(locator.rootId, locator.relativePath);
  if (content.length > OBJECT_WRITE_MAX_BYTES) {
    throw new Error(
      `content is ${content.length} bytes, exceeding the ${OBJECT_WRITE_MAX_BYTES} byte write cap`,
    );
  }
  const relative = normalizedRelative(locator);

  try { mkdirSync(rootDir, { recursive: true }); }
  catch (error) {
    throw new Error(`managed root '${locator.rootId}' is unavailable: ${ioMessage(error)}`);
  }
  let rootCanon: string;
  try { rootCanon = realpathSync(rootDir); }
  catch (error) {
    throw new Error(`managed root '${locator.rootId}' is unavailable: ${ioMessage(error)}`);
  }

  const targetRel = path.join(rootCanon, relative);
  const parent = path.dirname(targetRel);
  try { mkdirSync(parent, { recursive: true }); }
  catch (error) { throw new Error(`failed to create parent directory: ${ioMessage(error)}`); }
  let parentCanon: string;
  try { parentCanon = realpathSync(parent); }
  catch (error) { throw new Error(`parent directory is unavailable: ${ioMessage(error)}`); }
  if (!isInside(rootCanon, parentCanon)) throw new Error('object path escapes the managed root');
  const fileName = path.basename(targetRel);
  const target = path.join(parentCanon, fileName);

  const existed = existsSync(target);
  let current = Buffer.alloc(0);
  if (existed) {
    let targetCanon: string;
    try { targetCanon = realpathSync(target); }
    catch (error) {
      throw new Error(`object '${locator.relativePath}' is unavailable: ${ioMessage(error)}`);
    }
    if (!isInside(rootCanon, targetCanon)) throw new Error('object path escapes the managed root');
    let metadata;
    try { metadata = statSync(targetCanon); }
    catch (error) {
      throw new Error(`object '${locator.relativePath}' is unavailable: ${ioMessage(error)}`);
    }
    if (!metadata.isFile()) throw new Error(`object '${locator.relativePath}' is not a file`);
    try { current = readFileSync(targetCanon); }
    catch (error) {
      throw new Error(`failed to read object '${locator.relativePath}': ${ioMessage(error)}`);
    }
    if (expectedSha256 !== null && expectedSha256 !== undefined) {
      const actual = sha256Hex(current);
      if (actual !== expectedSha256) {
        throw new Error(
          `expected_sha256 mismatch for '${locator.relativePath}': content changed since it was read `
          + `(expected ${expectedSha256}, actual ${actual}); re-read and retry`,
        );
      }
    }
  } else if (expectedSha256 !== null && expectedSha256 !== undefined) {
    throw new Error(
      `expected_sha256 given but object '${locator.relativePath}' does not exist`,
    );
  }

  let next: Buffer;
  if (offset === null || offset === undefined) {
    next = Buffer.from(content);
  } else {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`offset must be >= 0, got ${offset}`);
    }
    if (offset > current.length) {
      throw new Error(
        `offset ${offset} exceeds current size ${current.length}; append with offset=size `
        + 'or overwrite with offset=None',
      );
    }
    next = Buffer.concat([current.subarray(0, offset), content, current.subarray(offset + content.length)]);
  }

  const tmp = path.join(parentCanon, `.${fileName}.ptc-write-${randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    removeTmpQuietly(tmp, logger);
    throw new Error(`failed to write object: ${ioMessage(error)}`);
  }
  try { renameSync(tmp, target); }
  catch (error) {
    removeTmpQuietly(tmp, logger);
    throw new Error(`failed to finalize object write: ${ioMessage(error)}`);
  }

  return {
    sha256: sha256Hex(next),
    total_size: next.length,
    written_bytes: content.length,
    created: !existed,
  };
}
