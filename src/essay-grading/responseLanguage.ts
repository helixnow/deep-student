/**
 * 作文批改反馈语言
 *
 * 批改评语跟随界面语言：中文界面（含英文作文，如雅思）用中文讲解，英文界面用英文。
 * 后端 `GradingRequest.response_language` 只识别 'zh-CN' / 'en-US'，这里把 i18n
 * 语言码归一化到这两个值；无法识别时回落中文（与后端缺省行为一致）。
 */
export type GradingResponseLanguage = 'zh-CN' | 'en-US';

export function toGradingResponseLanguage(language: string | null | undefined): GradingResponseLanguage {
  const normalized = (language ?? '').trim().toLowerCase();
  return normalized.startsWith('en') ? 'en-US' : 'zh-CN';
}
