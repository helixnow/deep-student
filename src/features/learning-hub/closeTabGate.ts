/**
 * ★ 0824 Wave2-B r2（P4-1）：Learning Hub 标签关闭 gate（纯逻辑，无 React）。
 *
 * 所有用户可达的关闭入口（TabBar 关钮/中键/键盘/右键、Cmd+W、Finder 关钮、
 * 关闭其他/关闭右侧）在删除标签前都必须经过本模块；LearningHubPage.closeTab
 * 退化为 gate 通过后的最终提交步。
 *
 * dirty 真相源只读消费 workbench contentDirtyRegistry：各视图注册 checker 时
 * typeId 即 tab.type、instanceKey 即资源叶 ID（note=NoteContentView、
 * exam=ExamContentView、essay/translation=内嵌的两个 Workbench 组件，均已核实），
 * 故直接以 tab 字段查询，无需映射表。gate 不自建任何 dirty/保存状态。
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

/** 该标签对应的资源实例当前是否有未保存修改（未注册 checker = 干净） */
export const isTabDirty = (tab: OpenTab): boolean => isContentDirty(tab.type, tab.resourceId);

/**
 * 单标签 close gate：干净直接放行；dirty 弹三态确认（保存并关闭 / 丢弃 / 取消）。
 * 返回 true = 允许关闭。保存失败或用户取消返回 false —— 调用方必须保留标签
 * 与草稿（fail-closed）。无确认宿主时 requestContentCloseDecision 返回
 * 'cancel'，同样 fail-closed。
 */
export const confirmTabClose = async (tab: OpenTab): Promise<boolean> => {
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
