/**
 * Crepe 编辑器共享工具。
 *
 * ⚠️ 本文件曾是 `CrepeEditor.tsx` 的完整平行实现（~880 行，自带 init /
 * buildApi / markdownUpdated 监听），但全仓无人调用，且缺少组件路径上的
 * IME 防护、Tauri 图片链路等修复，属于容易被误用的落后副本（审计 E1-2）。
 * 废弃的 `useCrepeEditor` Hook 桩及其 Options/Return 类型已随 index.ts
 * 对外导出一并移除。现仅保留：
 *
 * - `createAgentInsertTransaction`：ACR agent 插入事务工具
 *   （`CrepeEditor.tsx` 与 `__tests__/agentInsertMapping.test.ts` 依赖，
 *   行为契约由测试锁定，请勿改动语义）。
 *
 * 需要挂载编辑器时，请使用 React 组件 `<CrepeEditor>`（`./CrepeEditor`）。
 */

import type { EditorState, Transaction } from '@milkdown/prose/state';

export interface AgentInsertTransaction {
  transaction: Transaction;
  /** Full structural range inserted by ProseMirror (used for undo/ledger). */
  from: number;
  to: number;
  /** Textblock position where the next batch should continue. */
  cursor: number;
}

/**
 * Insert agent text and derive its final range from the transaction mapping.
 * At a block document boundary, ProseMirror may wrap inserted text in a new
 * paragraph, so the resulting position can advance by more than text.length.
 */
export function createAgentInsertTransaction(
  state: EditorState,
  text: string,
  pos: number,
): AgentInsertTransaction {
  const max = state.doc.content.size;
  const insertPos = Math.max(0, Math.min(pos, max));
  const transaction = state.tr.insertText(text, insertPos);
  const from = transaction.mapping.map(insertPos, -1);
  const to = transaction.mapping.map(insertPos, 1);
  let cursor = to;

  // Inserting inline text at a block boundary wraps it in a textblock. The
  // mapped right edge is then after that block; continue one position earlier,
  // inside the textblock, so the next batch does not create another paragraph.
  if (transaction.docChanged && cursor > 0) {
    const $to = transaction.doc.resolve(cursor);
    if (!$to.parent.inlineContent && $to.nodeBefore?.isTextblock) {
      cursor -= 1;
    }
  }

  return {
    transaction,
    from,
    to,
    cursor,
  };
}
