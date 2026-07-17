/**
 * @ 提及触发条件判定（纯函数，可单测）
 */

import type { EditorState } from '@milkdown/prose/state';

/**
 * 从光标前回溯，检测未完成的 `@query`。
 *
 * 规则：
 * - `@` 须在行首，或前一字符非「词字符」（字母/数字/下划线/CJK）
 * - `@` 后跟空格 → 不触发
 * - query 内出现空白 → 取消（视为已结束）
 * - 空 query（仅 `@`）→ 仍触发
 */
export function detectMentionTrigger(
  textBefore: string,
): { triggerStartInText: number; query: string } | null {
  for (let i = textBefore.length - 1; i >= 0; i -= 1) {
    if (textBefore[i] !== '@') continue;

    if (i > 0 && isWordChar(textBefore[i - 1]!)) {
      continue;
    }

    const query = textBefore.slice(i + 1);
    if (query.length > 0 && /^\s/.test(query)) {
      return null;
    }
    if (/\s/.test(query)) {
      return null;
    }

    return { triggerStartInText: i, query };
  }
  return null;
}

function isWordChar(ch: string): boolean {
  return /[\w\u3400-\u9fff\uf900-\ufaff]/.test(ch);
}

/** 代码块内不触发（含嵌套 code） */
export function shouldSkipMentionContext(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.spec.code) return true;
  }
  return false;
}
