/**
 * Generative UI 交互作答 — 限长常量（契约）
 *
 * 与 Rust `src-tauri/crates/dstu-agent/src/chat_v2/tools/genui_interaction.rs` 的
 * `GENUI_*` 常量一一同值，由 tests/vitest/generative-ui/genuiLimits.contract.test.ts 读源码锁住。
 * 本文件不得 import 任何模块（schema.ts 依赖它，避免环）。
 */

/** 本期新增的 3 种块（Rust GENUI_NEW_BLOCK_TYPES） */
export const GENUI_NEW_BLOCK_TYPES = ['choice', 'form', 'image'] as const;
/** 交互块（需要 awaitAnswer） */
export const GENUI_INTERACTIVE_BLOCK_TYPES = ['choice', 'form'] as const;

/** 交互块（choice + form）每份 intent 上限 */
export const GENUI_MAX_INTERACTIVE_BLOCKS = 4;
/** answer.summary 上限（字符，按 Unicode 码点计，同 Rust chars().count()） */
export const GENUI_ANSWER_SUMMARY_MAX_CHARS = 500;
/** answer.data 序列化后上限（字符） */
export const GENUI_ANSWER_DATA_MAX_CHARS = 16_000;
/** 图片引用（image 块 + choice 选项图片）每份 intent 上限 */
export const GENUI_MAX_IMAGE_REFS = 8;
/** followup:* action 每份 intent 上限 */
export const GENUI_MAX_FOLLOWUP_ACTIONS = 4;
/** followup prompt 上限 */
export const GENUI_FOLLOWUP_PROMPT_MAX_CHARS = 500;
/** form text 字段 maxLength 上限 */
export const GENUI_TEXT_FIELD_MAX_CHARS = 2000;
/** form text 字段 maxLength 缺省值 */
export const GENUI_TEXT_FIELD_DEFAULT_MAX_CHARS = 500;
/** choice「其他」文本上限 */
export const GENUI_CHOICE_OTHER_MAX_CHARS = 500;
/** slider (max-min)/step 档位上限 */
export const GENUI_SLIDER_MAX_STEPS = 1000;
/** image url 上限 */
export const GENUI_IMAGE_URL_MAX_CHARS = 2048;

/** 交互块 id、choice option id */
export const GENUI_INTERACTIVE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** form field name */
export const GENUI_FORM_FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** followup action id */
export const GENUI_FOLLOWUP_ACTION_ID_RE = /^followup:[a-z0-9-]{1,40}$/;
export const GENUI_FOLLOWUP_ACTION_PREFIX = 'followup:';
/** 图片 resource 来源 id */
export const GENUI_IMAGE_RESOURCE_ID_RE = /^(att|file|img|res)_[A-Za-z0-9_-]{1,120}$/;
/** 图片 pdf-page 来源 id */
export const GENUI_IMAGE_PDF_RESOURCE_ID_RE = /^res_[A-Za-z0-9_-]{1,120}$/;
export const GENUI_IMAGE_PDF_PAGE_MAX = 10000;

/** 按 Unicode 码点计数（与 Rust `str::chars().count()` 一致，避免 UTF-16 代理对差异） */
export function countGenuiChars(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

/** 按码点截断；超长时末尾放 `…` 且总长不超过 max */
export function truncateGenuiChars(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  if (max <= 1) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}
