/**
 * 确定性 GenerativeUIIntent fingerprint。
 * 稳定 JSON（key 排序、去掉 undefined）+ 同步简易 hash（djb2 双种子，16 hex）。
 * 不依赖 Web Crypto（subtle.digest 为异步）。
 */

import type { GenerativeBlockIntent, GenerativeUIIntent } from '../types';

export const FINGERPRINT_HEX_LENGTH = 16;

export interface FingerprintGenerativeUIIntentOptions {
  /** 为 true 时按块内容稳定排序，忽略 blocks 数组顺序 */
  ignoreBlockOrder?: boolean;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;

  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = canonicalize(item);
      return next === undefined ? null : next;
    });
  }

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const next = canonicalize(obj[key]);
    if (next !== undefined) sorted[key] = next;
  }
  return sorted;
}

/** 稳定 JSON：对象 key 排序，省略 undefined；数组中的 undefined 记为 null。 */
export function stableStringify(value: unknown): string {
  const canonical = canonicalize(value);
  return canonical === undefined ? 'null' : JSON.stringify(canonical);
}

function djb2(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** 双种子 djb2 → 16 位小写 hex（同步，无新依赖）。 */
export function hashToShortHex(input: string): string {
  const a = djb2(input, 5381).toString(16).padStart(8, '0');
  const b = djb2(input, 52711).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

function listBlocks(intent: GenerativeUIIntent | null | undefined): GenerativeBlockIntent[] {
  return Array.isArray(intent?.blocks) ? intent.blocks : [];
}

function prepareIntent(
  intent: GenerativeUIIntent | null | undefined,
  ignoreBlockOrder: boolean,
): unknown {
  if (intent == null || typeof intent !== 'object') return intent ?? null;
  if (!ignoreBlockOrder) return intent;

  const sortedBlocks = [...listBlocks(intent)].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right)),
  );
  return { ...intent, blocks: sortedBlocks };
}

/**
 * 相同 intent 得到相同短 hex。
 * 默认保留块顺序；`ignoreBlockOrder` 为 true 时重排 blocks 再哈希。
 */
export function fingerprintGenerativeUIIntent(
  intent: GenerativeUIIntent | null | undefined,
  options: FingerprintGenerativeUIIntentOptions = {},
): string {
  const prepared = prepareIntent(intent, options.ignoreBlockOrder === true);
  return hashToShortHex(stableStringify(prepared));
}
