/**
 * ★ 0824 Wave2-B r2（P4-1）：Learning Hub 标签关闭 gate（纯逻辑，无 React）。
 *
 * 所有用户可达的关闭入口（TabBar 关钮/中键/键盘/右键、Cmd+W、Finder 关钮、
 * 关闭其他/关闭右侧）在删除标签前都必须经过本模块；LearningHubPage.closeTab
 * 退化为 gate 通过后的最终提交步。
 *
 * 墨迹工作区通过退出注册表先结束手势并保存；已打开的工作区同时豁免 LRU 淘汰。
 * 其他资源直接按 tab.type 与资源叶 ID 消费 contentDirtyRegistry，
 * gate 不自建 dirty/保存状态。
 */

import i18next from 'i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  hasContentSaveHandler,
  isContentDirty,
  saveContentNow,
} from '@/features/workbench/apps/content/contentDirtyRegistry';
import { requestContentCloseDecision } from '@/features/workbench/apps/content/ContentCloseConfirmation';
import type { OpenTab } from './types/tabs';
import { flushInkWorkspace, hasInkWorkspace } from '@/services/inkWorkspaceRegistry';

/** 打开的墨迹工作区需保活；其他资源以已注册 checker 为准。 */
export const isTabDirty = (tab: OpenTab): boolean => hasInkWorkspace(tab.resourceId) || isContentDirty(tab.type, tab.resourceId);

/**
 * 单标签 close gate：墨迹工作区先结束手势并保存；其他 dirty 资源弹三态确认。
 * 返回 true = 允许关闭。保存失败或用户取消返回 false —— 调用方必须保留标签
 * 与草稿（fail-closed）。无确认宿主时 requestContentCloseDecision 返回
 * 'cancel'，同样 fail-closed。
 */
export const confirmTabClose = async (tab: OpenTab): Promise<boolean> => {
  if (hasInkWorkspace(tab.resourceId)) return flushInkWorkspace(tab.resourceId);
  if (!isTabDirty(tab)) return true;
  const offerSave = hasContentSaveHandler(tab.type, tab.resourceId);
  // ★ r6-review（关标签）：原引用 workbench:notes.confirmCloseUnsaved 为不存在
  // 的键（workbench 命名空间无 notes 对象），对话框会露出裸 key。改用既有
  // 标签页措辞键（r2 i18n 文档声明的复用备选，zh/en 双语齐），不新造键。
  const decision = await requestContentCloseDecision({
    description: i18next.t('workbench:notesWorkspace.confirmCloseUnsaved'),
    offerSave,
  });
  if (decision === 'save') {
    const saved = await saveContentNow(tab.type, tab.resourceId);
    if (!saved) {
      showGlobalNotification('error', i18next.t('workbench:content.saveAndCloseFailed'));
    }
    return saved;
  }
  return decision === 'discard';
};

export interface CloseTabsGateResult {
  /** 获准关闭的 tabId（保持传入顺序） */
  approved: string[];
  /** 用户是否在本批中取消过（或保存失败）——调用方可据此提示/停止后续操作 */
  cancelled: boolean;
}

/**
 * 批量 close gate（P4-2）：逐个检查，干净标签直接放行；脏标签弹确认。
 * 用户一旦取消（或保存失败），后续脏标签不再弹框、一律保留（不对用户
 * 连环轰炸对话框），但同批的干净标签互不拖累、照常放行。
 * 未获准的标签必须原样保留（fail-closed）。
 */
export async function requestCloseTabs(tabs: OpenTab[]): Promise<CloseTabsGateResult> {
  const approved: string[] = [];
  let cancelled = false;
  for (const tab of tabs) {
    if (!isTabDirty(tab)) {
      approved.push(tab.tabId);
      continue;
    }
    if (cancelled) continue; // 已取消：不再弹后续确认，脏标签一律保留
    if (await confirmTabClose(tab)) {
      approved.push(tab.tabId);
    } else {
      cancelled = true;
    }
  }
  return { approved, cancelled };
}
