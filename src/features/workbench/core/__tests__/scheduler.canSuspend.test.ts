/**
 * 缝二「canSuspend / dirty 窗不冻结」红灯测试(0824 Wave2-B 第 2 轮)
 *
 * 第 2 轮只写不跑;预期第 8 轮绿。若实现尚未落地,本文件应对齐
 * deactivation-1 / suspend 卡的公开 API,缺符号时用 skip+注释标明红灯原因。
 *
 * 对齐的公开 API(wave2-B-ledger 缝二任务卡 + anchor-workbench §3.2 S1–S4):
 * - S1:`AppDefinition` 新增可选 `canSuspend?: (instanceKey: string | null) => boolean`
 *   (同步;false = 保持 background 不得 frozen);
 * - S2:scheduler 冻结选择循环在预取豁免 skip 旁加同型 skip:dirty 窗
 *   `continue`,且**不得执行 `used -= memoryWeightOf(win)`**(未回收不得记账)、
 *   不得进 selected / freezeCandidateSince;
 * - S3:内容应用 `canSuspend = !isContentDirty(typeId, resolvedKey)`;
 * - S4:skip 谓词并上 `isWindowDirty(win.id)` 兜底。
 *
 * 红灯原因(写作本文件时):`scheduler.ts:542-571` 冻结候选筛选只看
 * lifecycle / 预取豁免 / keepAliveWhenOccluded,无任何 dirty / canSuspend
 * 检查,dirty 用例预期跑红;`types.ts` 亦无 canSuspend 字段,本文件经
 * unknown 断言注入(编译可过),第 8 轮 S1 落地后可去掉断言。
 * 调度器既有导出(setFreezeGraceOverride / resetSchedulerTransientsForTests /
 * recomputeLifecycles)均已存在,无需 skip。
 *
 * 不变量(ledger 缝二原文):**dirty 窗永不 frozen;超限时多冻干净窗,
 * 绝不反向牺牲脏窗**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recomputeLifecycles,
  resetSchedulerTransientsForTests,
  setFreezeGraceOverride,
  setMemoryBudgetOverride,
  setSchedulerNowForTests,
} from '../scheduler';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { __resetWindowDirtyForTests, setWindowDirty } from '../windowCloseGuard';
import {
  __resetContentDirtyRegistry,
  isContentDirty,
  registerContentDirtyChecker,
} from '../../apps/content/contentDirtyRegistry';
import {
  clearResourceWorkspaceActive,
  getResourceWorkspaceActive,
  setResourceWorkspaceActive,
} from '../../apps/content/resourceWorkspaceRegistry';
import { registerTestApp } from './testUtils';
import type { AppDefinition } from '../types';

registerTestApp('susp-heavy', { memoryWeight: 3 });
// S1/S3 形态:内容应用把 canSuspend 桥到 contentDirtyRegistry。
// AppDefinition 尚无 canSuspend 字段(S1 卡新增)→ 经 unknown 断言注入,
// 使本文件在实现落地前即可通过类型检查;落地后应去掉断言直接书写。
registerTestApp('susp-content', {
  memoryWeight: 3,
  ...({
    canSuspend: (instanceKey: string | null) => !isContentDirty('susp-content', instanceKey),
  } as unknown as Partial<Omit<AppDefinition, 'typeId'>>),
});

function store() {
  return useWindowStore.getState();
}

/** 开 count 个 weight=3 完全重叠的窗口(LRU 顺序 = 打开顺序,同 scheduler.test.ts) */
function openHeavyStack(count: number, typeId = 'susp-heavy'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      store().openWindow({
        typeId,
        initialFrame: { x: 100, y: 100, w: 400, h: 300 },
      }),
    );
  }
  return ids;
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1600, h: 900 });
  // 5 窗 × 3 = 15 点 > 12 预算 → 恰好需要冻 1 个;grace 0 = 立即冻结语义
  setMemoryBudgetOverride(12);
  setFreezeGraceOverride(0);
  setSchedulerNowForTests(null);
  resetSchedulerTransientsForTests();
  __resetWindowDirtyForTests();
  __resetContentDirtyRegistry();
});

afterEach(() => {
  setMemoryBudgetOverride(null);
  setFreezeGraceOverride(null);
  setSchedulerNowForTests(null);
});

describe('缝二 — dirty background 窗超预算不冻结', () => {
  it('setWindowDirty 兜底(S4):dirty 的 LRU 最旧窗保持 background,压力转移给下一个干净窗', () => {
    const ids = openHeavyStack(5);
    setWindowDirty(ids[0], true); // 最旧 background 窗标脏

    recomputeLifecycles();
    const lc = store().lifecycles;
    // 不变量:dirty 窗永不 frozen
    expect(lc[ids[0]]).toBe('background');
    // 超限时多冻干净窗:压力落到下一个 LRU 干净窗,而非放弃冻结
    expect(lc[ids[1]]).toBe('frozen');
    expect(lc[ids[4]]).toBe('focused');
    // 预算记账(S2 约束):skip dirty 窗时不得把它按「已回收」扣减,
    // 否则会少冻——此处 15-3=12≤12,冻 ids[1] 一个即收敛。
    expect(Object.values(lc).filter((v) => v === 'frozen')).toHaveLength(1);
  });

  it('恒 dirty 的 contentDirtyRegistry checker 经 canSuspend(S1/S3)阻止冻结', () => {
    const contentId = store().openWindow({
      typeId: 'susp-content',
      instanceKey: 'res-1',
      initialFrame: { x: 100, y: 100, w: 400, h: 300 },
    });
    const rest = openHeavyStack(4); // contentId 为 LRU 最旧
    registerContentDirtyChecker('susp-content', 'res-1', () => true); // 恒 dirty

    recomputeLifecycles();
    const lc = store().lifecycles;
    expect(lc[contentId]).toBe('background'); // canSuspend=false → 不得 frozen
    expect(lc[rest[0]]).toBe('frozen'); // 干净窗替位被冻
  });

  it('dirty 标记清除后同一窗恢复可冻结(谓词是活的,不是一次性豁免)', () => {
    const ids = openHeavyStack(5);
    setWindowDirty(ids[0], true);
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('background');

    setWindowDirty(ids[0], false); // 保存完成,红点熄灭
    recomputeLifecycles();
    expect(store().lifecycles[ids[0]]).toBe('frozen');
  });
});

describe('缝二 — 对照:干净窗照常冻结(证明不是「全不冻」)', () => {
  it('同等预算下无 dirty 标记时,LRU 最旧 background 窗仍被冻结', () => {
    const ids = openHeavyStack(5); // 与 dirty 用例完全同构,仅缺 setWindowDirty
    recomputeLifecycles();
    const lc = store().lifecycles;
    expect(lc[ids[0]]).toBe('frozen');
    expect(lc[ids[1]]).toBe('background');
    expect(lc[ids[4]]).toBe('focused');
    expect(Object.values(lc).filter((v) => v === 'frozen')).toHaveLength(1);
  });

  it('未注册 checker 的 susp-content 窗视为干净,canSuspend 返回 true 时照常冻结', () => {
    const contentId = store().openWindow({
      typeId: 'susp-content',
      instanceKey: 'res-1',
      initialFrame: { x: 100, y: 100, w: 400, h: 300 },
    });
    openHeavyStack(4);
    // 不注册任何 checker:isContentDirty=false → canSuspend=true

    recomputeLifecycles();
    expect(store().lifecycles[contentId]).toBe('frozen');
  });
});

// ============================================================================
// 0824 Wave2-B 第 7 轮追加(测试员-2)。只写不跑,预期第 8 轮统一执行。
//
// 追加时点的实现状态(仅静态阅读,未运行):S1 已落地——types.ts:476 有
// `canSuspend?: (instanceKey) => boolean | Promise<boolean>`;S2 已落地——
// scheduler.ts:585 在预取豁免 skip 旁有
// `if (isWindowDirty(win.id) || !canSuspendNow(win)) continue;`(不扣 used);
// S3 已落地——createContentApp.tsx:92 把 canSuspend 桥到 isContentDirty,
// 其 resolveDirtyResourceId 对 exam/essay/translation 单窗工作区在
// instanceKey 为 null 时回落 getResourceWorkspaceActive(typeId)。
// 因此本段用例书写为预期绿,但**未执行验证**。
//
// 追加覆盖(第 2 轮既有用例之外):
// 1. 多 dirty 窗密集场景:候选序列里穿插多个 dirty 窗时逐个越过,
//    压力顺延多冻干净窗(ledger 缝二不变量的多窗强化);
// 2. exam(单资源工作区,instanceKey=null)dirty 亦不冻:canSuspend 经
//    getResourceWorkspaceActive('exam') 解析当前资源再查 isContentDirty;
// 3. exam 干净对照(未注册 checker → 照常冻结)与「活跃资源切换后
//    checker 不再命中 → 恢复可冻」(证明解析是活的,不是注册时快照)。
//
// 'exam' 应用定义在本测试模块图中未注册(不 import apps/content/register,
// 避免拉入 React lazy / i18next 装配链),故用 registerTestApp 以生产同形
// 参数注册:memoryWeight=2、instanceMode='single'、canSuspend 与
// createContentApp 的 resolveDirtyResourceId 逐字同构。
// ============================================================================

registerTestApp('exam', {
  memoryWeight: 2,
  instanceMode: 'single',
  canSuspend: (instanceKey: string | null) =>
    !isContentDirty('exam', instanceKey ?? getResourceWorkspaceActive('exam')),
});

describe('缝二(第 7 轮追加)— 多 dirty 窗:逐个越过,压力顺延多冻干净窗', () => {
  it('候选序列穿插两个 dirty 窗时,冻结恰好落在其后的两个干净窗上', () => {
    // 6 窗 × 3 = 18 点 > 12 预算 → 需回收 6 点 = 冻 2 个干净窗
    const ids = openHeavyStack(6);
    setWindowDirty(ids[0], true);
    setWindowDirty(ids[2], true);

    recomputeLifecycles();
    const lc = store().lifecycles;
    // dirty 窗永不 frozen(两个都保持 background)
    expect(lc[ids[0]]).toBe('background');
    expect(lc[ids[2]]).toBe('background');
    // 压力顺延:LRU 序上紧随各 dirty 窗之后的干净窗被冻
    expect(lc[ids[1]]).toBe('frozen');
    expect(lc[ids[3]]).toBe('frozen');
    // S2 记账:skip dirty 不扣 used → 18-3-3=12≤12,恰好冻 2 个收敛,
    // 不多冻(ids[4] 仍 background)也不少冻
    expect(lc[ids[4]]).toBe('background');
    expect(lc[ids[5]]).toBe('focused');
    expect(Object.values(lc).filter((v) => v === 'frozen')).toHaveLength(2);
  });
});

describe('缝二(第 7 轮追加)— exam 单资源工作区 dirty 亦不冻', () => {
  beforeEach(() => {
    clearResourceWorkspaceActive('exam');
  });

  afterEach(() => {
    clearResourceWorkspaceActive('exam');
  });

  it('instanceKey=null 的 exam 窗经活跃资源解析出 dirty → 保持 background,干净窗替位被冻', () => {
    // exam(2) + 4 × heavy(3) = 14 点 > 12 预算;exam 为 LRU 最旧候选
    const examId = store().openWindow({
      typeId: 'exam',
      initialFrame: { x: 100, y: 100, w: 400, h: 300 },
    });
    const rest = openHeavyStack(4);
    setResourceWorkspaceActive('exam', 'paper-1');
    registerContentDirtyChecker('exam', 'paper-1', () => true); // 答题草稿未保存

    recomputeLifecycles();
    const lc = store().lifecycles;
    // canSuspend(null) → isContentDirty('exam', 活跃资源 paper-1)=true → 不冻
    expect(lc[examId]).toBe('background');
    // 压力顺延到下一个 LRU 干净窗;skip exam 不扣 used(14-3=11≤12,冻 1 个)
    expect(lc[rest[0]]).toBe('frozen');
    expect(Object.values(lc).filter((v) => v === 'frozen')).toHaveLength(1);
  });

  it('对照:同构布局下 exam 无 dirty checker 时,exam 自身作为 LRU 最旧窗被冻结', () => {
    const examId = store().openWindow({
      typeId: 'exam',
      initialFrame: { x: 100, y: 100, w: 400, h: 300 },
    });
    const rest = openHeavyStack(4);
    setResourceWorkspaceActive('exam', 'paper-1');
    // 不注册 checker:isContentDirty=false → canSuspend=true

    recomputeLifecycles();
    const lc = store().lifecycles;
    // exam(2) 被冻后 14-2=12≤12 收敛,干净 heavy 窗不受波及
    expect(lc[examId]).toBe('frozen');
    expect(lc[rest[0]]).toBe('background');
    expect(Object.values(lc).filter((v) => v === 'frozen')).toHaveLength(1);
  });

  it('活跃资源切走后旧资源的 dirty checker 不再命中,exam 恢复可冻(解析是活的)', () => {
    const examId = store().openWindow({
      typeId: 'exam',
      initialFrame: { x: 100, y: 100, w: 400, h: 300 },
    });
    openHeavyStack(4);
    registerContentDirtyChecker('exam', 'paper-1', () => true); // 只有 paper-1 脏
    setResourceWorkspaceActive('exam', 'paper-2'); // 工作区已切到干净的 paper-2

    recomputeLifecycles();
    // canSuspend(null) → isContentDirty('exam', paper-2)=false → 照常冻结
    expect(store().lifecycles[examId]).toBe('frozen');
  });

  it('S4 兜底对 exam 同样生效:setWindowDirty 标脏的 exam 窗不冻,与 canSuspend 判定相互独立', () => {
    const examId = store().openWindow({
      typeId: 'exam',
      initialFrame: { x: 100, y: 100, w: 400, h: 300 },
    });
    const rest = openHeavyStack(4);
    // 不注册 checker、不设活跃资源:canSuspend=true,仅 windowDirty 一路标脏
    setWindowDirty(examId, true);

    recomputeLifecycles();
    const lc = store().lifecycles;
    expect(lc[examId]).toBe('background');
    expect(lc[rest[0]]).toBe('frozen');
    expect(Object.values(lc).filter((v) => v === 'frozen')).toHaveLength(1);
  });
});
