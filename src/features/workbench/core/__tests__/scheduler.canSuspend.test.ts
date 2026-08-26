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
