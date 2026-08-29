/**
 * 会话语向/正式度的统一解析链：会话持久化值 → 用户偏好 → 内建默认。
 *
 * 适配器对缺失字段不再注入幽灵 'auto'/'zh-CN'（见 dstuNodeToTranslationSession），
 * 因此新建空翻译（有 id、无内容、无语向）能落到用户偏好；
 * 工作台的状态初始化、会话恢复 effect、翻译签名三处都必须用同一条链，
 * 避免签名失配导致误报 dirty 或自动翻译误触发。
 */

export type TranslationFormality = 'formal' | 'casual' | 'auto';

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
