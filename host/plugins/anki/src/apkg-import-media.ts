/**
 * APKG 媒体条目命名、清单提取与落盘路径收集。
 */
import type { ApkgMediaSkip } from './apkg-types.ts';
import {
  MAX_REPORTED_MEDIA_FILENAMES,
  byteLen,
  hasControlChar,
  rustFileName,
  trimWhitespace,
  type ImportLimits,
} from './apkg-import-types.ts';

/** 媒体跳过统计（`MediaSkipTracker`）。 */
export class MediaSkipTracker {
  private readonly order: string[] = [];
  private readonly counts = new Map<string, number>();
  private readonly filenames = new Map<string, string[]>();

  record(reason: string, filename: string): void {
    const current = this.counts.get(reason);
    if (current === undefined) {
      this.order.push(reason);
      this.counts.set(reason, 1);
    } else {
      this.counts.set(reason, current + 1);
    }
    const samples = this.filenames.get(reason);
    if (samples === undefined) {
      this.filenames.set(reason, [filename]);
    } else if (samples.length < MAX_REPORTED_MEDIA_FILENAMES) {
      samples.push(filename);
    }
  }

  intoSkips(): ApkgMediaSkip[] {
    return this.order.map((reason) => ({
      reason,
      count: this.counts.get(reason) ?? 0,
      filenames: this.filenames.get(reason) ?? [],
    }));
  }
}


// ============================================================================
// 媒体文件名 / 引用
// ============================================================================

/**
 * 媒体文件名安全化：仅保留最后一个 path segment，拒绝空名/点名/超长名/控制字符，
 * 以及残留的路径分隔符（`/`、`\`）与盘符冒号。
 */
export function sanitizeMediaFilename(raw: string): string | null {
  const name = rustFileName(trimWhitespace(raw));
  if (name === null) return null;
  if (name === '' || name === '.' || name === '..' || byteLen(name) > 255) return null;
  if (hasControlChar(name)) return null;
  // Unix 上 `Path::file_name` 不切分 `\`，"..\evil" 会整体留下来；显式拒绝。
  if (name.includes('/') || name.includes('\\') || name.includes(':')) return null;
  return name;
}

/** `src="..."` / `src='...'` / `src=...` / `[sound:...]` 引用的媒体文件名（保持出现顺序）。 */
export function extractMediaFilenames(text: string): string[] {
  const names: string[] = [];

  for (const match of text.matchAll(/\bsrc(?:\s*=\s*(?:"([^"]+)"|'([^']+)')|=([^\s"'=<>`]+\.[a-z0-9]{1,8}))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (value !== '') names.push(value);
  }

  for (const match of text.matchAll(/\[sound:([^\]]+)\]/gi)) {
    const value = (match[1] ?? '').trim();
    if (value !== '') names.push(value);
  }

  return names;
}

/** 收集卡片字段引用且已成功落盘的媒体绝对路径（去重、保持首次出现顺序）。 */
export function collectCardMediaPaths(
  fieldValues: readonly string[],
  mediaPaths: ReadonlyMap<string, string>,
): string[] {
  if (mediaPaths.size === 0) return [];
  const images: string[] = [];
  const seen = new Set<string>();
  let lowerIndex: Map<string, string> | null = null;
  const resolveTarget = (raw: string): string | undefined => {
    const stripped = raw.replace(/^anki-media:\/\/\/?/i, '');
    const candidates = [raw, stripped];
    try {
      const decoded = decodeURIComponent(stripped);
      if (decoded !== stripped) candidates.push(decoded);
    } catch { /* boundary-allow empty-catch: Malformed URI escapes remain literal filenames. */ }
    for (const candidate of candidates) {
      const direct = mediaPaths.get(candidate);
      if (direct !== undefined) return direct;
      const sanitized = sanitizeMediaFilename(candidate);
      if (sanitized !== null) {
        const byBase = mediaPaths.get(sanitized);
        if (byBase !== undefined) return byBase;
      }
    }
    if (lowerIndex === null) {
      lowerIndex = new Map<string, string>();
      for (const [key, value] of mediaPaths.entries()) {
        const lowerKey = key.toLowerCase();
        if (!lowerIndex.has(lowerKey)) lowerIndex.set(lowerKey, value);
        const sanitized = sanitizeMediaFilename(key);
        if (sanitized !== null && !lowerIndex.has(sanitized.toLowerCase())) {
          lowerIndex.set(sanitized.toLowerCase(), value);
        }
      }
    }
    for (const candidate of candidates) {
      const hit = lowerIndex.get(candidate.toLowerCase());
      if (hit !== undefined) return hit;
      const sanitized = sanitizeMediaFilename(candidate);
      if (sanitized !== null) {
        const baseHit = lowerIndex.get(sanitized.toLowerCase());
        if (baseHit !== undefined) return baseHit;
      }
    }
    return undefined;
  };
  for (const value of fieldValues) {
    for (const name of extractMediaFilenames(value)) {
      const target = resolveTarget(name);
      if (target !== undefined && !seen.has(target)) {
        seen.add(target);
        images.push(target);
      }
    }
  }
  return images;
}
