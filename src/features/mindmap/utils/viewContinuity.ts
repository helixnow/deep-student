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
