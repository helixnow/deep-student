/**
 * ftp.rs 的纯辅助规则：远端路径拼接、`550` 等回复码的“不存在”判定、重试策略与传输超时。
 * 不碰套接字与文件，`ftp.ts` 的会话与存储实现共用。
 */

import { MEMORY_GET_BUDGET_EXCEEDED } from './traits.ts';

const RETRY_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

/** ftp.rs:224 `join_paths`. */
export function joinPaths(base: string, child: string): string {
  const baseTrimmed = base.replace(/^\/+|\/+$/g, '');
  const preserveTrailingSlash = child.endsWith('/') && child.replace(/^\/+|\/+$/g, '') !== '';
  const childTrimmed = child.replace(/^\/+|\/+$/g, '');
  if (!baseTrimmed && !childTrimmed) return '';
  if (!baseTrimmed) return preserveTrailingSlash ? `${childTrimmed}/` : childTrimmed;
  if (!childTrimmed) return baseTrimmed;
  return preserveTrailingSlash ? `${baseTrimmed}/${childTrimmed}/` : `${baseTrimmed}/${childTrimmed}`;
}

/** ftp.rs:253 `absolute_path`. */
export function absolutePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
}

/** ftp.rs:263 `split_parent_filename`. */
export function splitParentFilename(key: string): [string, string] {
  const index = key.lastIndexOf('/');
  return index >= 0 ? [key.slice(0, index), key.slice(index + 1)] : ['', key];
}

/**
 * ftp.rs:274: suppaftp reports `Invalid response: [550] 550 ...`; the bracketed code
 * wins, otherwise scan for a standalone 4xx/5xx token.
 */
export function extractStatusCode(message: string): number | null {
  const start = message.indexOf('[');
  if (start >= 0) {
    const end = message.indexOf(']', start + 1);
    if (end >= 0) {
      const candidate = message.slice(start + 1, end).trim();
      if (/^\d+$/.test(candidate)) {
        const code = Number(candidate);
        if (code >= 100 && code < 600) return code;
      }
    }
  }
  for (const raw of message.split(/\s+/)) {
    const token = raw.replace(/^[^0-9]+|[^0-9]+$/g, '');
    if (token.length !== 3 || !/^\d+$/.test(token)) continue;
    const code = Number(token);
    if (code >= 400 && code < 600) return code;
  }
  return null;
}

/** ftp.rs:306: only an explicit 550/501 "missing" reply is not-found. */
export function isNotFoundError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const code = extractStatusCode(message);
  if (code !== 550 && code !== 501) return false;
  return message.includes('no such file')
    || message.includes('no such directory')
    || message.includes('not retrievable')
    || message.includes('does not exist')
    || message.includes('file not found')
    || message.includes('directory not found');
}

/** ftp.rs:333: `delete` treats an explicitly missing parent directory as absent. */
export function isMissingDirectoryError(error: unknown): boolean {
  if (isNotFoundError(error)) return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (extractStatusCode(message) !== 550) return false;
  const explicitlyMissing = ['not found', 'no such file', 'no such directory', 'not retrievable', 'does not exist', '不存在']
    .some(marker => message.includes(marker));
  const explicitlyGone = message.includes('410') && message.includes('gone');
  return explicitlyMissing || explicitlyGone;
}

/** ftp.rs:432: deterministic budget rejections must not be retried. */
export function isBudgetExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(MEMORY_GET_BUDGET_EXCEEDED);
}

/** ftp.rs:444: three attempts with 1 s / 2 s backoff; budget rejections never retry. */
export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(500 * (1 << attempt));
    try {
      return await operation();
    } catch (error) {
      if (isBudgetExceededError(error)) throw error;
      lastError = error;
      if (attempt === RETRY_ATTEMPTS - 1) break;
    }
  }
  throw lastError;
}

/** ftp.rs:560: 120 s base plus the transfer time at a floor of 64 KiB/s. */
export function transferTimeoutMs(totalSize: number): number {
  return 120_000 + Math.floor(totalSize / (64 * 1024)) * 1000;
}
