/**
 * Pure translation provenance & formality helpers shared across layers
 * (`dstu` platform adapters and `translation` feature modules).
 */

export type TranslationFormality = 'formal' | 'casual' | 'auto';

/**
 * 确定性原文指纹：用于判定译文版本与当前原文是否同步（跨刷新持久化）。
 * 覆盖完整原文（不截断），以双 32 位哈希 + 长度拼接。
 */
export function computeTranslationSourceHash(sourceText: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < sourceText.length; i += 1) {
    const code = sourceText.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b);
  }
  return `v1:${sourceText.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/** 规范化正式度取值（兼容历史 'informal'） */
export function normalizeFormalityValue(value: unknown): TranslationFormality | undefined {
  if (value === 'formal') return 'formal';
  if (value === 'casual' || value === 'informal') return 'casual';
  if (value === 'auto') return 'auto';
  return undefined;
}

/**
 * 已完成译文的精确生成上下文（provenance）。
 * 与当前控件状态分离：控件改语言/改正式度/改原文不会改写它，
 * 只有新翻译完成、手工编辑保存或版本回滚时才原子更新。
 */
export interface TranslationSyncedMeta {
  sourceText: string;
  sourceHash: string;
  srcLang: string;
  tgtLang: string;
  formality: TranslationFormality;
  domain: string;
  glossary?: Array<[string, string]>;
  customPrompt?: string;
  translatedAt: number;
}

function sanitizeSyncedGlossary(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
      pairs.push([item[0], item[1]]);
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

export function sanitizeTranslationSyncedMeta(value: unknown): TranslationSyncedMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const tgtLang = typeof rec.tgtLang === 'string' && rec.tgtLang ? rec.tgtLang : undefined;
  const srcLang = typeof rec.srcLang === 'string' && rec.srcLang ? rec.srcLang : 'auto';
  if (!tgtLang) return undefined;
  const sourceText = typeof rec.sourceText === 'string' ? rec.sourceText : '';
  const sourceHash =
    typeof rec.sourceHash === 'string' && rec.sourceHash
      ? rec.sourceHash
      : computeTranslationSourceHash(sourceText);
  const formality = normalizeFormalityValue(rec.formality) ?? 'auto';
  const domain = typeof rec.domain === 'string' && rec.domain ? rec.domain : 'general';
  const glossary = sanitizeSyncedGlossary(rec.glossary);
  const customPrompt =
    typeof rec.customPrompt === 'string' && rec.customPrompt.trim() ? rec.customPrompt : undefined;
  const translatedAt =
    typeof rec.translatedAt === 'number' && Number.isFinite(rec.translatedAt) ? rec.translatedAt : 0;
  return {
    sourceText,
    sourceHash,
    srcLang,
    tgtLang,
    formality,
    domain,
    ...(glossary ? { glossary } : {}),
    ...(customPrompt ? { customPrompt } : {}),
    translatedAt,
  };
}
