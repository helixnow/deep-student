/**
 * 大纲 ↔ 画布切换时的焦点/caret 连续性。
 *
 * 这里的 requestOutlineCaret 不带 scope（写入默认 scope）：调用方
 * （MindMapContentView）无法稳定拿到大纲实例的 caret scope；
 * 大纲行以 store 为 scope 消费时，takeOutlineCaret 未命中会回落
 * 默认 scope，恰好接住这类跨边界写入（nodeId 全局唯一，无误配风险）。
 */
import { requestOutlineCaret } from './outlineCaret';

export interface OutlineResumePoint {
  nodeId: string;
  caret: number;
}

export function captureOutlineResumePoint(active: Element | null): OutlineResumePoint | null {
  if (!(active instanceof HTMLTextAreaElement) || active.dataset.mmOutlineInput !== 'true') {
    return null;
  }
  const nodeId = active.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
  if (!nodeId) return null;
  return {
    nodeId,
    caret: active.selectionStart ?? active.value.length,
  };
}

export function prepareOutlineResume(
  focusedNodeId: string | null,
  resume: OutlineResumePoint | null,
): string | null {
  const targetId = focusedNodeId ?? resume?.nodeId ?? null;
  if (targetId && resume?.nodeId === targetId) {
    requestOutlineCaret(targetId, resume.caret);
  }
  return targetId;
}
