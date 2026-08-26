/**
 * 缝一停用事务「取消矩阵」测试（0824 Wave2-B 第 7 轮 测试员-1）
 *
 * 第 7 轮只写不跑（本轮禁止执行 vitest），预期第 8 轮统一跑绿。
 *
 * 对齐已落地的公开 API（core/deactivationTransaction.ts）：
 * - `runWorkbenchDeactivationTransaction(reason)`：
 *   reason ∈ 'mode-off' | 'breakpoint' | 'app-exit'，
 *   返回 `Promise<{ ok: boolean }>`；
 * - phase 1 语义：逐窗顺序 confirmWindowClose，任一窗拒绝 → { ok: false }
 *   且**零副作用**（不关任何窗，含已确认过的窗）；全部通过 → { ok: true }，
 *   真正关窗 / 卸壳是调用方的 phase 2 职责，本事务不动 windowStore。
 *
 * 覆盖矩阵（与 deactivationTransaction.test.ts 互补，不重复 single-flight 用例）：
 * 1. dirty essay 窗（contentDirtyRegistry checker 恒 true）× 三种 reason
 *    → 全部 ok:false，且所有窗口原样保留；
 * 2. canClose=false 守卫窗 × 三种 reason → 全部 ok:false，被拒窗与
 *    同桌面的干净窗都不被拆；
 * 3. 全干净桌面（无 canClose 应用 + essay 未注册 checker）→ ok:true，
 *    phase 1 成功也不关窗（关窗属 phase 2）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { appRegistry } from '../appRegistry';
import {
  runWorkbenchDeactivationTransaction,
  type WorkbenchDeactivationReason,
} from '../deactivationTransaction';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { workbenchBus } from '../workbenchBus';
import { __resetWindowDirtyForTests } from '../windowCloseGuard';
import {
  __resetContentDirtyRegistry,
  isContentDirty,
  registerContentDirtyChecker,
} from '../../apps/content/contentDirtyRegistry';
import type { AppDefinition } from '../types';

// 三种停用路径共用同一事务实现——取消语义必须对每个 reason 都成立。
const ALL_REASONS: WorkbenchDeactivationReason[] = ['mode-off', 'breakpoint', 'app-exit'];

// ---------------------------------------------------------------------------
// 测试应用注册（模块级一次性；typeId 加 matrix 前缀，避免与同目录
// deactivationTransaction.test.ts 的注册冲突）
// ---------------------------------------------------------------------------

const GUARDED_TYPE = 'deact-matrix-guarded-test';
const ESSAY_TYPE = 'deact-matrix-essay-test';
const PLAIN_TYPE = 'deact-matrix-plain-test';

let guardedCanClose: (instanceKey: string | null) => boolean | Promise<boolean> = () => true;

appRegistry.register({
  typeId: GUARDED_TYPE,
  nameKey: 'workbench:test.deactMatrixGuarded',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  canClose: (instanceKey) => guardedCanClose(instanceKey),
});

// 模拟 createContentApp 的 essay 形态：canClose 消费 contentDirtyRegistry，
// 「dirty essay」= 注册了恒 true checker 的实例。
appRegistry.register({
  typeId: ESSAY_TYPE,
  nameKey: 'workbench:test.deactMatrixEssay',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  canClose: (instanceKey) => !isContentDirty(ESSAY_TYPE, instanceKey),
});

appRegistry.register({
  typeId: PLAIN_TYPE,
  nameKey: 'workbench:test.deactMatrixPlain',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
});

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  workbenchBus.setEnabled(true);
  guardedCanClose = () => true;
  __resetWindowDirtyForTests();
  __resetContentDirtyRegistry();
});

function store() {
  return useWindowStore.getState();
}

function windowCount(): number {
  return Object.keys(store().windows).length;
}

describe('runWorkbenchDeactivationTransaction — 取消矩阵', () => {
  describe.each(ALL_REASONS)('reason=%s', (reason) => {
    it('dirty essay 窗取消整个事务（ok:false），所有窗口原样保留', async () => {
      const plainId = store().openWindow({ typeId: PLAIN_TYPE, instanceKey: 'plain-1' });
      const essayId = store().openWindow({ typeId: ESSAY_TYPE, instanceKey: 'essay-1' });
      registerContentDirtyChecker(ESSAY_TYPE, 'essay-1', () => true); // 恒 dirty

      const result = await runWorkbenchDeactivationTransaction(reason);

      expect(result.ok).toBe(false);
      // 零副作用：dirty 窗和已放行的干净窗都不许被关（phase 1 不关窗）
      expect(store().windows[essayId]).toBeDefined();
      expect(store().windows[plainId]).toBeDefined();
      expect(windowCount()).toBe(2);
    });

    it('canClose=false 守卫窗取消整个事务（ok:false），被拒窗不被拆', async () => {
      const plainId = store().openWindow({ typeId: PLAIN_TYPE, instanceKey: 'plain-1' });
      const guardedId = store().openWindow({ typeId: GUARDED_TYPE, instanceKey: 'one' });
      guardedCanClose = () => false;

      const result = await runWorkbenchDeactivationTransaction(reason);

      expect(result.ok).toBe(false);
      expect(store().windows[guardedId]).toBeDefined();
      expect(store().windows[plainId]).toBeDefined();
      expect(windowCount()).toBe(2);
    });
  });

  it('全部窗口干净时放行（ok:true），phase 1 成功同样不关窗（关窗属 phase 2）', async () => {
    store().openWindow({ typeId: PLAIN_TYPE, instanceKey: 'plain-1' });
    store().openWindow({ typeId: ESSAY_TYPE, instanceKey: 'essay-1' }); // 未注册 checker = 干净
    store().openWindow({ typeId: GUARDED_TYPE, instanceKey: 'one' }); // guardedCanClose 缺省放行

    const result = await runWorkbenchDeactivationTransaction('mode-off');

    expect(result.ok).toBe(true);
    // 事务只做预检：真正的关窗 / 卸壳由调用方在拿到 ok:true 后执行
    expect(windowCount()).toBe(3);
  });
});
