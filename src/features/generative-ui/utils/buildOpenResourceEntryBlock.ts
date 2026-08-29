/**
 * 确定性构建「打开已有资源」action-bar 入口块（只读导航，无 LLM、无写副作用）。
 *
 * 宿主（如 NotesContextPanel 只读摘要、PDF 摘要卡）把已知的笔记 / PDF 页目标
 * 传进来，得到一个可直接 append 到既有 intent.blocks 的 action-bar 块；
 * 同一份目标再喂给 createOpenResourceActionHandlers 即得配套 handler 表，
 * 两侧 id 由同一组组合函数派生，天然对齐（actionHandlerSync 契约口径）。
 *
 * 非法目标（id 形状不符 / 页码越界 / label 为空）在这里与 handler 工厂
 * 同口径跳过；全部无效时返回 null，宿主据此不渲染入口行。
 */

import type { GenerativeBlockIntent } from '../types';
import {
  openNoteActionId,
  openPdfPageActionId,
  type OpenNoteActionInput,
  type OpenPdfPageActionInput,
} from '../handlers/openResourceActionHandlers';

/** 对齐 actionBarPropsSchema：actions max(6) / label max(60) */
const MAX_ACTIONS_PER_BAR = 6;
const MAX_ACTION_LABEL_LENGTH = 60;

export interface BuildOpenResourceEntryBlockInput {
  /** 块 id（可选，稳定 diff 用） */
  id?: string;
  notes?: readonly OpenNoteActionInput[];
  pdfPages?: readonly OpenPdfPageActionInput[];
}

interface OpenResourceEntryAction {
  id: string;
  label: string;
  variant: 'default';
  riskLevel: 'low';
}

function clampLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > MAX_ACTION_LABEL_LENGTH
    ? trimmed.slice(0, MAX_ACTION_LABEL_LENGTH)
    : trimmed;
}

export function buildOpenResourceEntryBlock(
  input: BuildOpenResourceEntryBlockInput,
): GenerativeBlockIntent | null {
  const actions: OpenResourceEntryAction[] = [];

  for (const note of input.notes ?? []) {
    if (actions.length >= MAX_ACTIONS_PER_BAR) break;
    const actionId = openNoteActionId(note.noteId);
    const label = clampLabel(note.label ?? '');
    if (!actionId || !label) continue;
    actions.push({ id: actionId, label, variant: 'default', riskLevel: 'low' });
  }

  for (const pdfPage of input.pdfPages ?? []) {
    if (actions.length >= MAX_ACTIONS_PER_BAR) break;
    const actionId = openPdfPageActionId(pdfPage.sourceId, pdfPage.pageNumber);
    const label = clampLabel(pdfPage.label ?? '');
    if (!actionId || !label) continue;
    actions.push({ id: actionId, label, variant: 'default', riskLevel: 'low' });
  }

  if (actions.length === 0) return null;

  return {
    type: 'action-bar',
    ...(input.id ? { id: input.id } : {}),
    props: { actions },
  };
}
