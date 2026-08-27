import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import i18next from 'i18next';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition } from '../../core/types';
import { handleNotesActivation } from './notesActivation';
import { createNotesAgentManifest } from './agentManifest';
import { requestContentCloseConfirmation } from '../content/ContentCloseConfirmation';
import { hasUnsavedNotesWorkspaceChanges } from './workspaceRegistry';

export const NOTES_APP_TYPE_ID = 'notes';

async function canCloseNotesWorkspace(_instanceKey: string | null): Promise<boolean> {
  if (!hasUnsavedNotesWorkspaceChanges()) return true;
  try {
    return await requestContentCloseConfirmation({
      description: i18next.t('workbench:content.confirmCloseUnsaved'),
    });
  } catch {
    // If the confirmation host cannot respond, retain the window and edits.
    return false;
  }
}

export const notesAppDefinition: AppDefinition = {
  typeId: NOTES_APP_TYPE_ID,
  nameKey: 'workbench:apps.note',
  icon: React.createElement(AppIconImage, { typeId: 'notes', className: 'h-8 w-8' }),
  instanceMode: 'single',
  memoryWeight: 3,
  // 默认宽度须明显大于 BACKLINKS_SIDE_BY_SIDE_MIN_WIDTH（1120，见
  // NotesWorkspaceApp）：旧值 1180 与 overlay 阈值 1180 重合，扣掉窗框后
  // 背链面板在默认尺寸下永远以覆盖层出现，无法并排
  defaultFrame: { w: 1240, h: 760 },
  minSize: { w: 480, h: 420 },
  render: React.lazy(() => import('./NotesWorkspaceApp')),
  onActivation: handleNotesActivation,
  agentManifest: createNotesAgentManifest(handleNotesActivation),
  canClose: canCloseNotesWorkspace,
  // suspend 契约：dirty 窗永不 frozen。同步查询各 Notes host 的未保存
  // 状态（checker 异常按 dirty 处理），有未保存编辑时调度器跳过冻结，
  // 窗口保持 background，不丢内存中的编辑内容。
  canSuspend: () => !hasUnsavedNotesWorkspaceChanges(),
  handlesCloseShortcut: true,
  // Ctrl+Tab / Ctrl+Shift+Tab 循环内部标签（NotesWorkspaceApp onWindowKeyDown
  // 消费；壳层让位协议见 AppDefinition.handlesTabCycleShortcut）
  handlesTabCycleShortcut: true,
};

let registered = false;

export function registerNotesApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(notesAppDefinition);
}

registerNotesApp();
