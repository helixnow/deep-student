/**
 * 笔记标题 / 标签的前端前置校验，规则与 Rust 后端保持一致
 * （src-tauri/src/vfs/repos/note_repo.rs 的 validate_title / validate_tags）：
 * - 标题：≤ 500 字符；禁止换行与控制字符（Tab 豁免，H1 导入场景）
 * - 标签：≤ 100 个；单个 ≤ 100 字符；禁止控制字符
 *
 * 后端超限会以 InvalidArgument 拒绝写入；前端在输入侧提前拦截，
 * 给出友好提示而不是等保存失败。
 */

export const NOTE_TITLE_MAX_CHARS = 500;
export const NOTE_TAG_MAX_CHARS = 100;
export const NOTE_TAGS_MAX_COUNT = 100;

/** 标题/名称输入接近上限（> 该值）时 UI 开始显示字符计数 */
export const NOTE_TITLE_COUNT_WARN_THRESHOLD = 450;

/** 按 Unicode 码点计数（与后端 chars().count() 口径一致，区别于 UTF-16 length） */
export function countNoteInputChars(raw: string): number {
  return [...raw].length;
}

/** 控制字符（Tab \u0009 豁免；换行/回车视为控制字符一并拒绝）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_TAB = /[\u0000-\u0008\u000A-\u001F\u007F]/;

export type NoteInputViolation = 'empty' | 'too_long' | 'control_chars';

export function validateNoteTitle(raw: string): NoteInputViolation | null {
  if (!raw.trim()) return 'empty';
  // 与后端一致：长度/控制字符按原始串计（后端仅对空判定做 trim）
  if ([...raw].length > NOTE_TITLE_MAX_CHARS) return 'too_long';
  if (CONTROL_CHARS_EXCEPT_TAB.test(raw)) return 'control_chars';
  return null;
}

/**
 * 后端允许空白标签（历史行为，展示层过滤），但 UI 添加 chip 时
 * 仍将空串视为无效输入。后端对标签的控制字符检查不豁免 Tab。
 */
export function validateNoteTag(raw: string): NoteInputViolation | null {
  const tag = raw.trim();
  if (!tag) return 'empty';
  if ([...tag].length > NOTE_TAG_MAX_CHARS) return 'too_long';
  if (CONTROL_CHARS_EXCEPT_TAB.test(tag) || tag.includes('\t')) return 'control_chars';
  return null;
}

/**
 * 输入侧就地清洗：折叠换行为空格、去除其余控制字符并按字符数截断。
 * 适用于粘贴进标题输入框等场景（清洗后仍应再走 validate 提示）。
 */
export function sanitizeNoteTitleInput(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  const chars = [...cleaned];
  return chars.length > NOTE_TITLE_MAX_CHARS
    ? chars.slice(0, NOTE_TITLE_MAX_CHARS).join('')
    : cleaned;
}
