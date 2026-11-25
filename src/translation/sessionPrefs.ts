/**
 * 会话语向/正式度的统一解析链：会话持久化值 → 用户偏好 → 内建默认。
 *
 * 适配器对缺失字段不再注入幽灵 'auto'/'zh-CN'（见 dstuNodeToTranslationSession），
 * 因此新建空翻译（有 id、无内容、无语向）能落到用户偏好；
 * 工作台的状态初始化、会话恢复 effect、翻译签名三处都必须用同一条链，
 * 避免签名失配导致误报 dirty 或自动翻译误触发。
 */

import {
  computeTranslationSourceHash,
  normalizeFormalityValue,
  sanitizeTranslationSyncedMeta,
  type TranslationFormality,
  type TranslationSyncedMeta,
} from '@/shared/translationSyncedMeta';

export {
  computeTranslationSourceHash,
  normalizeFormalityValue,
  sanitizeTranslationSyncedMeta,
  type TranslationFormality,
  type TranslationSyncedMeta,
};

/** 统一翻译参数签名：用于自动翻译去重与过期检测 */
export function buildTranslationStateSignature(params: {
  sourceHash: string;
  srcLang: string;
  tgtLang: string;
  formality: TranslationFormality;
  domain?: string;
  glossary?: Array<[string, string]>;
  customPrompt?: string;
}): string {
  return JSON.stringify([
    params.sourceHash,
    params.srcLang || 'auto',
    params.tgtLang || 'zh-CN',
    params.customPrompt ? params.customPrompt.trim() : '',
    params.formality || 'auto',
    params.domain || 'general',
    params.glossary ?? [],
  ]);
}

/** 语向/正式度的持久化偏好片段（工作台 WorkbenchPrefs 的子集） */
export interface TranslationLangPrefs {
  srcLang?: string;
  tgtLang?: string;
  formality?: TranslationFormality;
}

export interface ResolvedSessionPrefs {
  srcLang: string;
  tgtLang: string;
  formality: TranslationFormality;
}

export function resolveSessionPrefs(
  session: TranslationLangPrefs | null | undefined,
  prefs: TranslationLangPrefs,
): ResolvedSessionPrefs {
  return {
    srcLang: session?.srcLang || prefs.srcLang || 'auto',
    tgtLang: session?.tgtLang || prefs.tgtLang || 'zh-CN',
    formality: session?.formality || prefs.formality || 'auto',
  };
}

export interface TranslationDraftSnapshot {
  id: string;
  srcLang: string;
  tgtLang: string;
  formality?: TranslationFormality;
  domain?: string;
  sourceText: string;
  translatedText: string;
  lastTranslatedMeta?: TranslationSyncedMeta;
  updatedAt: number;
}

const DRAFT_STORAGE_PREFIX = 'ds.translation.draft.';

export function saveTranslationDraftSnapshot(snapshot: TranslationDraftSnapshot): void {
  if (!snapshot.id || typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      `${DRAFT_STORAGE_PREFIX}${snapshot.id}`,
      JSON.stringify(snapshot),
    );
  } catch {
    // Ignore storage errors
  }
}

export function readTranslationDraftSnapshot(id: string | undefined): TranslationDraftSnapshot | null {
  if (!id || typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TranslationDraftSnapshot> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.srcLang !== 'string' || typeof parsed.tgtLang !== 'string') return null;
    const formality = normalizeFormalityValue(parsed.formality);
    const domain = typeof parsed.domain === 'string' && parsed.domain ? parsed.domain : undefined;
    const lastTranslatedMeta = sanitizeTranslationSyncedMeta(parsed.lastTranslatedMeta);
    return {
      id,
      srcLang: parsed.srcLang,
      tgtLang: parsed.tgtLang,
      ...(formality ? { formality } : {}),
      ...(domain ? { domain } : {}),
      sourceText: typeof parsed.sourceText === 'string' ? parsed.sourceText : '',
      translatedText: typeof parsed.translatedText === 'string' ? parsed.translatedText : '',
      ...(lastTranslatedMeta ? { lastTranslatedMeta } : {}),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearTranslationDraftSnapshot(id: string | undefined): void {
  if (!id || typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${id}`);
  } catch {
    // Ignore storage errors
  }
}

const LATIN_LANGS = new Set(['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'pl', 'sv', 'da', 'no', 'fi', 'tr', 'vi', 'id', 'ms']);

export function detectClearSourceLanguageMismatch(
  text: string,
  srcLang: string,
): { mismatch: boolean; detectedLang: string | null } {
  const sample = text.trim().slice(0, 500);
  if (!sample || !srcLang || srcLang === 'auto') {
    return { mismatch: false, detectedLang: null };
  }

  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let arabic = 0;
  let latin = 0;

  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) han += 1;
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1;
    else if (code >= 0xac00 && code <= 0xd7af) hangul += 1;
    else if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1;
    else if (code >= 0x0600 && code <= 0x06ff) arabic += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) latin += 1;
  }

  const total = han + kana + hangul + cyrillic + arabic + latin;
  if (total < 2) return { mismatch: false, detectedLang: null };

  const detectedNonLatin =
    kana >= 2 ? 'ja' :
    hangul >= 2 ? 'ko' :
    han >= Math.max(2, total * 0.35) ? 'zh-CN' :
    cyrillic > total * 0.5 ? 'ru' :
    arabic > total * 0.5 ? 'ar' :
    null;

  if (LATIN_LANGS.has(srcLang)) {
    if (detectedNonLatin && latin < total * 0.4) {
      return { mismatch: true, detectedLang: detectedNonLatin };
    }
    return { mismatch: false, detectedLang: null };
  }

  if (srcLang === 'zh-CN' || srcLang === 'zh-TW' || srcLang === 'zh') {
    if (kana >= 2 && han < kana * 2) {
      return { mismatch: true, detectedLang: 'ja' };
    }
    if (hangul >= 2 && han === 0) {
      return { mismatch: true, detectedLang: 'ko' };
    }
    if (han === 0 && latin >= Math.max(6, total * 0.7)) {
      return { mismatch: true, detectedLang: 'en' };
    }
    return { mismatch: false, detectedLang: null };
  }

  if (srcLang === 'ja') {
    if (kana === 0 && han === 0 && latin >= Math.max(6, total * 0.7)) {
      return { mismatch: true, detectedLang: 'en' };
    }
    if (hangul >= 2 && kana === 0) {
      return { mismatch: true, detectedLang: 'ko' };
    }
    return { mismatch: false, detectedLang: null };
  }

  if (srcLang === 'ko') {
    if (hangul === 0 && (latin >= Math.max(6, total * 0.7) || han >= 2)) {
      return { mismatch: true, detectedLang: detectedNonLatin ?? 'en' };
    }
    return { mismatch: false, detectedLang: null };
  }

  if (srcLang === 'ru') {
    if (cyrillic === 0 && (latin >= Math.max(6, total * 0.7) || han >= 2)) {
      return { mismatch: true, detectedLang: detectedNonLatin ?? 'en' };
    }
    return { mismatch: false, detectedLang: null };
  }

  return { mismatch: false, detectedLang: null };
}

export function isVerbatimUntranslatedOutput(
  sourceText: string,
  translatedText: string,
  srcLang: string,
  tgtLang: string,
): boolean {
  const normSrc = sourceText.trim().replace(/\s+/g, ' ');
  const normTgt = translatedText.trim().replace(/\s+/g, ' ');
  if (normSrc.length < 2 || normTgt.length < 2) return false;
  if (normSrc !== normTgt) return false;
  if (srcLang === tgtLang && srcLang !== 'auto') return false;
  // Require at least some alphabetic/CJK/kana/hangul/cyrillic characters (avoid numbers/punctuation-only false positives)
  return /[a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(normSrc);
}
