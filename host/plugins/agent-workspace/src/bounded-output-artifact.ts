import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const OUTPUT_PREVIEW_BYTES = 8 * 1024;
export const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
export const OWNER_QUOTA_BYTES = 50 * 1024 * 1024;
export const OWNER_ARTIFACT_LIMIT = 1000;
export const ARTIFACT_TTL_MS = 7 * 86400000;
type Stream = 'stdout' | 'stderr';
export interface ArtifactSlice { slice: string; totalChars: number; nextOffset: number | null; truncated: boolean }
export interface ArtifactDescriptor { artifactId: string; sizeBytes: number; totalChars: number }
interface ArtifactRecord extends ArtifactDescriptor {
  ownerId: string; expiresAt: number; filename?: string; inline?: string;
}
interface ArtifactWriter {
  append(chunk: Uint8Array): void;
  finish(): ArtifactDescriptor;
  discard(): void;
}

/** Metadata is scoped to this store's lifetime. Files belong to the host, not the sandbox.
 * Quota includes active writers, so concurrent captures cannot overbook the owner.
 */
export class Utf16LeArtifactStore {
  readonly directory: string;
  private records = new Map<string, ArtifactRecord>();
  private usage = new Map<string, { bytes: number; count: number }>();
  private ownerQuotaBytes: number;
  private ownerArtifactLimit: number;
  private ttlMs: number;
  private now: () => number;

  constructor(directory: string, options: { ownerQuotaBytes?: number; ownerArtifactLimit?: number; ttlMs?: number; now?: () => number } = {}) {
    this.directory = directory;
    this.ownerQuotaBytes = options.ownerQuotaBytes ?? OWNER_QUOTA_BYTES;
    this.ownerArtifactLimit = options.ownerArtifactLimit ?? OWNER_ARTIFACT_LIMIT;
    this.ttlMs = options.ttlMs ?? ARTIFACT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  createWriter(ownerId: string): ArtifactWriter {
    const quota = this.usage.get(ownerId) ?? { bytes: 0, count: 0 };
    if (quota.count >= this.ownerArtifactLimit) throw new Error('artifact_quota_exceeded');
    quota.count++;
    this.usage.set(ownerId, quota);
    const artifactId = randomUUID(), filename = path.join(this.directory, `${artifactId}.utf16`);
    const decoder = new StringDecoder('utf8');
    let fd: number | undefined, sizeBytes = 0, totalChars = 0, buffer = '', closed = false;
    const writeText = (text: string) => {
      if (!text) return;
      totalChars += text.length;
      if (fd === undefined) { buffer += text; return; }
      const bytes = Buffer.from(text, 'utf16le');
      let written = 0;
      while (written < bytes.length) {
        const n = fs.writeSync(fd, bytes, written, bytes.length - written);
        if (!n) throw new Error('artifact_write_failed');
        written += n;
      }
    };
    const discard = () => {
      if (closed) return;
      closed = true;
      try {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; fs.unlinkSync(filename); }
      } finally { quota.bytes -= sizeBytes; quota.count--; buffer = ''; }
    };
    return {
      append: chunk => {
        if (closed) throw new Error('artifact_writer_closed');
        if (quota.bytes + chunk.byteLength > this.ownerQuotaBytes) throw new Error('artifact_quota_exceeded');
        quota.bytes += chunk.byteLength; sizeBytes += chunk.byteLength;
        if (fd === undefined && sizeBytes > OUTPUT_PREVIEW_BYTES) {
          fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
          fd = fs.openSync(filename, 'wx', 0o600);
          const initial = buffer; buffer = '';
          // Buffered characters were already counted.
          totalChars -= initial.length;
          writeText(initial);
        }
        writeText(decoder.write(Buffer.from(chunk)));
      },
      finish: () => {
        if (closed) throw new Error('artifact_writer_closed');
        writeText(decoder.end());
        const onDisk = fd !== undefined;
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        closed = true;
        const descriptor = { artifactId, sizeBytes, totalChars };
        this.records.set(artifactId, { ...descriptor, ownerId, expiresAt: this.now() + this.ttlMs, ...(onDisk ? { filename } : { inline: buffer }) });
        buffer = '';
        return descriptor;
      },
      discard,
    };
  }

  writeArtifact(ownerId: string, text: string): ArtifactDescriptor {
    const writer = this.createWriter(ownerId);
    try {
      // Do not allocate a second full-output UTF-8 buffer.
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + 4096);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
        writer.append(Buffer.from(text.slice(offset, end)));
        offset = end;
      }
      return writer.finish();
    } catch (error) { writer.discard(); throw error; }
  }

  readArtifactSlice(artifactId: string, ownerId: string, offsetChars = 0, maxChars = 8000): ArtifactSlice {
    if (!Number.isSafeInteger(offsetChars) || offsetChars < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 12000) throw new Error('invalid_artifact_range');
    const record = this.records.get(artifactId);
    if (!record || record.ownerId !== ownerId) throw new Error('artifact_not_found');
    if (record.expiresAt <= this.now()) throw new Error('artifact_expired');
    if (offsetChars > record.totalChars) throw new Error('invalid_artifact_range');
    const length = Math.min(maxChars, record.totalChars - offsetChars);
    let slice: string;
    if (record.filename) {
      const fd = fs.openSync(record.filename, 'r');
      try {
        const bytes = Buffer.alloc(length * 2);
        let read = 0;
        while (read < bytes.length) {
          const n = fs.readSync(fd, bytes, read, bytes.length - read, offsetChars * 2 + read);
          if (!n) throw new Error('artifact_storage_unavailable');
          read += n;
        }
        // Deliberately preserve UTF-16 code units, including half a surrogate pair,
        // exactly like String.slice(offsetChars, offsetChars + maxChars).
        slice = bytes.toString('utf16le');
      } finally { fs.closeSync(fd); }
    } else slice = record.inline!.slice(offsetChars, offsetChars + length);
    const end = offsetChars + slice.length;
    return { slice, totalChars: record.totalChars, nextOffset: end < record.totalChars ? end : null, truncated: end < record.totalChars };
  }

  cleanup(time = this.now()): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt > time) continue;
      if (record.filename) {
        try { fs.unlinkSync(record.filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      this.records.delete(id);
      const quota = this.usage.get(record.ownerId)!;
      quota.bytes -= record.sizeBytes; quota.count--; removed++;
    }
    return removed;
  }
}

interface StreamState {
  decoder: StringDecoder; head: string; tail: string; full: string; bytes: number;
  writer?: ArtifactWriter; artifact?: ArtifactDescriptor;
}
export interface BoundedOutputResult {
  stdout: string; stderr: string;
  stdoutTruncated: boolean; stderrTruncated: boolean;
  complete: boolean; terminationReason?: 'output_limit_exceeded';
  output: { stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; complete: boolean; limitBytes: number };
  artifacts?: Partial<Record<Stream, ArtifactDescriptor>>;
  outputStorageError?: string;
}
const HALF_PREVIEW = OUTPUT_PREVIEW_BYTES / 2;
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/** Feed both pipes incrementally. A false complete result asks the caller to stop
 * the process; preview truncation alone never requests termination. Sync bounded
 * disk writes provide backpressure without an unbounded promise/chunk queue.
 */
export class BoundedStreamAccumulator {
  private streams: Record<Stream, StreamState>;
  private store?: Utf16LeArtifactStore;
  private ownerId: string;
  private total = 0;
  private exceeded = false;
  private ended = false;
  private storageError?: string;
  constructor(options: { store?: Utf16LeArtifactStore; ownerId?: string } = {}) {
    const create = (): StreamState => ({ decoder: new StringDecoder('utf8'), head: '', tail: '', full: '', bytes: 0 });
    this.streams = { stdout: create(), stderr: create() };
    this.store = options.store; this.ownerId = options.ownerId ?? '';
  }
  private remember(state: StreamState, text: string): void {
    if (!text) return;
    if (state.bytes <= OUTPUT_PREVIEW_BYTES) { state.full += text; return; }
    if (state.full) {
      state.head = utf8Prefix(state.full, HALF_PREVIEW);
      state.tail = utf8Tail(state.full, HALF_PREVIEW);
      state.full = '';
    }
    state.head = utf8Prefix(state.head + utf8Prefix(text, HALF_PREVIEW), HALF_PREVIEW);
    // Only retain a bounded suffix even if a caller supplies a huge chunk.
    state.tail = utf8Tail(state.tail + utf8Tail(text, HALF_PREVIEW), HALF_PREVIEW);
  }
  private storageFailure(error: unknown): void {
    this.storageError = error instanceof Error && error.message === 'artifact_quota_exceeded' ? error.message : 'artifact_storage_unavailable';
    for (const state of Object.values(this.streams)) {
      try { state.writer?.discard(); }
      catch (cleanupError) { this.storageError = 'artifact_storage_unavailable'; }
      state.writer = undefined;
    }
  }
  append(stream: Stream, chunk: Uint8Array): BoundedOutputResult {
    if (this.ended) throw new Error('output_already_finished');
    if (this.exceeded) return this.result();
    const remaining = OUTPUT_LIMIT_BYTES - this.total;
    const accepted = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
    this.exceeded = chunk.byteLength > remaining;
    const state = this.streams[stream];
    state.bytes += accepted.byteLength; this.total += accepted.byteLength;
    if (accepted.byteLength) {
      // Decode in fixed-size pieces to bound temporary strings as well as retained memory.
      for (let offset = 0; offset < accepted.length; offset += 4096) {
        const piece = accepted.subarray(offset, offset + 4096);
        this.remember(state, state.decoder.write(Buffer.from(piece)));
        if (this.store && !this.storageError) {
          try {
            state.writer ??= this.store.createWriter(this.ownerId);
            state.writer.append(piece);
          } catch (error) { this.storageFailure(error); }
        }
      }
    }
    return this.result();
  }
  finish(): BoundedOutputResult {
    if (!this.ended) {
      this.ended = true;
      for (const state of Object.values(this.streams)) {
        this.remember(state, state.decoder.end());
        if (state.writer && !this.storageError) {
          try { state.artifact = state.writer.finish(); }
          catch (error) { this.storageFailure(error); }
        }
      }
    }
    return this.result();
  }
  private result(): BoundedOutputResult {
    const stdoutTruncated = this.streams.stdout.bytes > OUTPUT_PREVIEW_BYTES;
    const stderrTruncated = this.streams.stderr.bytes > OUTPUT_PREVIEW_BYTES;
    const preview = (s: StreamState): string => s.bytes > OUTPUT_PREVIEW_BYTES ? s.head + s.tail : s.full;
    const artifacts: Partial<Record<Stream, ArtifactDescriptor>> = {};
    for (const stream of ['stdout', 'stderr'] as const) if (this.streams[stream].artifact) artifacts[stream] = this.streams[stream].artifact;
    return {
      stdout: preview(this.streams.stdout), stderr: preview(this.streams.stderr), stdoutTruncated, stderrTruncated,
      complete: !this.exceeded, ...(this.exceeded ? { terminationReason: 'output_limit_exceeded' as const } : {}),
      output: { stdoutBytes: this.streams.stdout.bytes, stderrBytes: this.streams.stderr.bytes, stdoutTruncated, stderrTruncated, complete: !this.exceeded, limitBytes: OUTPUT_LIMIT_BYTES },
      ...(Object.keys(artifacts).length ? { artifacts } : {}),
      ...(this.storageError ? { outputStorageError: this.storageError } : {}),
    };
  }
}
