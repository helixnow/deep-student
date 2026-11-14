// browser/service.rs:1945-1964 hash_download_file_bounded. Normally called in the
// dedicated worker; also used by the explicit worker-unavailable fallback (:1508).
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';

export type DownloadHashResult =
  | { ok: true; sha256: string; size: number }
  | { ok: false; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashDownloadFileBoundedCore(path: string, maxBytes: number): DownloadHashResult {
  let file: number;
  try { file = openSync(path, 'r'); }
  catch (error) { return { ok: false, error: `open downloaded file: ${errorText(error)}` }; }
  const hasher = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    for (;;) {
      let read: number;
      try { read = readSync(file, buffer, 0, buffer.length, null); }
      catch (error) { return { ok: false, error: `read downloaded file: ${errorText(error)}` }; }
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return { ok: false, error: 'download exceeds per-file byte limit' };
      hasher.update(buffer.subarray(0, read));
    }
    return { ok: true, sha256: hasher.digest('hex'), size: total };
  } finally {
    // boundary-allow empty-catch: Rust File::drop does not surface close errors
    try { closeSync(file); } catch { /* dropped like Rust File */ }
  }
}

/** Decode the worker message; no database handles or file contents cross threads. */
export function decodeDownloadHashResult(value: unknown): DownloadHashResult | null {
  if (value === null || typeof value !== 'object') return null;
  if ('ok' in value && value.ok === false && 'error' in value && typeof value.error === 'string') {
    return { ok: false, error: value.error };
  }
  if ('ok' in value && value.ok === true && 'sha256' in value && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(value.sha256) && 'size' in value && typeof value.size === 'number'
    && Number.isSafeInteger(value.size) && value.size >= 0) {
    return { ok: true, sha256: value.sha256, size: value.size };
  }
  return null;
}
