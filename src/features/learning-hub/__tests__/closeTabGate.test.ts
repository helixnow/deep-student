/**
 * P4-1「Learning Hub 标签关闭 gate」红灯测试(0824 Wave2-B 第 2 轮)
 *
 * 第 2 轮只写不跑;预期第 8 轮绿。若实现尚未落地,本文件应对齐
 * deactivation-1 / suspend 卡同族的 hub 关闭门公开 API,缺符号时用
 * skip+注释标明红灯原因。
 *
 * 对齐的公开 API(wave2-B-ledger 4 号卡 + anchor-hub §6 P4-1):
 * - 新建异步 close gate `requestCloseTabs(tabs): Promise`,内部按
 *   tab.type → registry typeId 查 `isContentDirty`(复用 workbench
 *   `contentDirtyRegistry.ts` 的 isContentDirty/saveContentNow);
 * - dirty 则确认 / saveContentNow,失败保标签(fail-closed:未经确认的
 *   dirty tab 绝不放行);
 * - `LearningHubPage.closeTab` 退化为 gate 的最终提交步;
 * - ExamContentView 的注册/判分/store 调用点归 E 禁改,gate 只消费
 *   `isContentDirty('exam', id)`。
 *
 * 红灯原因(写作本文件时):gate 模块尚未创建(LearningHubPage.tsx:279
 * closeTab 仍是同步 filter,14 个关闭入口无一查 dirty registry),动态
 * import 失败 → 整组 describe.skip;实现落地后 skip 自动解除。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTab, type OpenTab } from '../types/tabs';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '@/features/workbench/apps/content/contentDirtyRegistry';

// ---------------------------------------------------------------------------
// 目标模块动态加载:实现员可能落在 hub 根 / utils / tabs 下,依次探测;
// 全部缺失 → skip(红灯原因见文件头)
// ---------------------------------------------------------------------------

type RequestCloseTabs = (tabs: OpenTab[]) => Promise<unknown>;

const CANDIDATE_PATHS = [
  '../closeTabGate',
  '../utils/closeTabGate',
  '../tabs/closeTabGate',
  '../apps/closeTabGate',
];

let requestCloseTabs: RequestCloseTabs | null = null;
for (const path of CANDIDATE_PATHS) {
  try {
    // @vite-ignore:模块在实现员落地前不存在,留给运行时解析而非转换期报错
    const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
    if (typeof mod.requestCloseTabs === 'function') {
      requestCloseTabs = mod.requestCloseTabs as RequestCloseTabs;
      break;
    }
  } catch {
    // 该候选路径不存在,继续探测下一个
  }
}

/**
 * 结果归一:P4-1 卡只约定「requestCloseTabs(...): Promise,失败保标签」,
 * 返回形状未定型。红灯阶段按语义归一「获准关闭的 tabId 集合」断言,
 * 第 8 轮实现定型后应收紧为单一形状。
 * 兼容:string[](获准 id)、OpenTab[](获准 tab)、
 * { approved | closed | closedTabIds: string[] }、boolean(全放行/全拦下)。
 */
function approvedTabIds(result: unknown, allIds: string[]): string[] {
  if (result === true) return allIds;
  if (result === false || result == null) return [];
  if (Array.isArray(result)) {
    return result
      .map((item) =>
        typeof item === 'string'
          ? item
          : item != null && typeof item === 'object' && 'tabId' in item
            ? String((item as { tabId: unknown }).tabId)
            : null,
      )
      .filter((id): id is string => id != null);
  }
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['approved', 'closed', 'closedTabIds']) {
      if (Array.isArray(record[key])) return approvedTabIds(record[key], allIds);
    }
    if ('ok' in record) return record.ok ? allIds : [];
  }
  return [];
}

function makeTab(type: OpenTab['type'], resourceId: string): OpenTab {
  return createTab({
    type,
    resourceId,
    dstuPath: `/${resourceId}`,
    title: `tab:${resourceId}`,
  });
}

beforeEach(() => {
  __resetContentDirtyRegistry();
});

// 实现未落地 → skip,红灯原因:gate 模块缺失(见文件头)
const describeIfImplemented = requestCloseTabs ? describe : describe.skip;

describeIfImplemented('requestCloseTabs — hub 标签关闭 gate(P4-1)', () => {
  const gate = requestCloseTabs!;

  it('dirty note tab 关闭被拦下(fail-closed:未确认不放行、标签保留)', async () => {
    const dirtyNote = makeTab('note', 'note-dirty-1');
    registerContentDirtyChecker('note', 'note-dirty-1', () => true); // 恒 dirty

    const result = await gate([dirtyNote]);
    expect(approvedTabIds(result, [dirtyNote.tabId])).not.toContain(dirtyNote.tabId);
  });

  it('干净 tab 放行(对照,证明 gate 不是「全拦」)', async () => {
    const cleanNote = makeTab('note', 'note-clean-1'); // 未注册 checker = 干净

    const result = await gate([cleanNote]);
    expect(approvedTabIds(result, [cleanNote.tabId])).toContain(cleanNote.tabId);
  });

  it('批量关闭:同批中 dirty 拦下、干净放行,互不拖累', async () => {
    const dirty = makeTab('note', 'note-dirty-2');
    const clean = makeTab('textbook', 'textbook-clean-1');
    registerContentDirtyChecker('note', 'note-dirty-2', () => true);

    const result = await gate([dirty, clean]);
    const approved = approvedTabIds(result, [dirty.tabId, clean.tabId]);
    expect(approved).not.toContain(dirty.tabId);
    expect(approved).toContain(clean.tabId);
  });

  it('exam tab 只消费 isContentDirty("exam", id)(注册点归 E,gate 不自建真相源)', async () => {
    const exam = makeTab('exam', 'exam-1');
    // 模拟 ExamContentView 已注册的 checker;gate 侧只做只读消费
    registerContentDirtyChecker('exam', 'exam-1', () => true);

    const result = await gate([exam]);
    expect(approvedTabIds(result, [exam.tabId])).not.toContain(exam.tabId);
  });
});

// 缺符号时保留一条显式 skip 记录,让红灯在测试报告里可见、可检索。
if (!requestCloseTabs) {
  describe('requestCloseTabs — hub 标签关闭 gate(未落地)', () => {
    it.skip('红灯占位:closeTabGate 模块尚未创建(closeTab 仍为同步 filter),实现落地后上方用例自动激活', () => {
      // 见文件头「红灯原因」。此占位不做任何断言。
    });
  });
}
