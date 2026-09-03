/**
 * 缝一「deactivation transaction」红灯测试(0824 Wave2-B 第 2 轮)
 *
 * 第 2 轮只写不跑;预期第 8 轮绿。若实现尚未落地,本文件应对齐
 * deactivation-1 卡的公开 API,缺符号时用 skip+注释标明红灯原因。
 *
 * 对齐的公开 API(wave2-B-ledger 缝一任务卡 + anchor-workbench §3.1 T1–T3):
 * - 新建 `core/deactivationTransaction.ts`,导出
 *   `runWorkbenchDeactivationTransaction(reason: 'mode-off' | 'breakpoint' | 'app-quit')`;
 * - 内部枚举 `useWindowStore.getState().windows`,逐窗 `confirmWindowClose`
 *   (复用 windowCloseGuard 的 single-flight);
 * - 任一窗拒绝(canClose=false / isContentDirty=true)→ 整体取消,返回 ok:false。
 *
 * 红灯原因(写作本文件时):`core/deactivationTransaction.ts` 尚未创建,
 * 动态 import 失败 → 整组 describe.skip;实现落地后 skip 自动解除,
 * 断言即按本契约把行为钉死。
 *
 * 调用方契约(在此声明预期,设置页侧断言不进本文件,避免拉起整页渲染):
 * 事务返回 ok:false 时,WorkbenchSettingsSection.handleModeChange **不得
 * persist `desktop.workbenchMode=false`、不得 workbenchBus.setEnabled(false)、
 * 不得派发 WORKBENCH_MODE_CHANGED,开关 UI 必须回弹**;App.tsx 断点切壳
 * 同理不得提交 shellStableSmallScreen。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appRegistry } from '../appRegistry';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { workbenchBus } from '../workbenchBus';
import { __resetWindowDirtyForTests } from '../windowCloseGuard';
import {
  __resetContentDirtyRegistry,
  isContentDirty,
  registerContentDirtyChecker,
} from '../../apps/content/contentDirtyRegistry';
import type { AppDefinition } from '../types';

// ---------------------------------------------------------------------------
// 目标模块动态加载:缺符号 → skip(红灯原因见文件头)
// ---------------------------------------------------------------------------

type DeactivationReason = 'mode-off' | 'breakpoint' | 'app-quit';
type RunDeactivation = (reason: DeactivationReason) => Promise<unknown>;

const MODULE_PATH = '../deactivationTransaction';

let runWorkbenchDeactivationTransaction: RunDeactivation | null = null;
try {
  // @vite-ignore:模块在实现员落地前不存在,必须留给运行时解析而非转换期报错
  const mod = (await import(/* @vite-ignore */ MODULE_PATH)) as Record<string, unknown>;
  const candidate = mod.runWorkbenchDeactivationTransaction;
  runWorkbenchDeactivationTransaction =
    typeof candidate === 'function' ? (candidate as RunDeactivation) : null;
} catch {
  runWorkbenchDeactivationTransaction = null;
}

/**
 * 结果归一:任务卡两轮口径分别是 `Promise<boolean>`(ledger)与
 * `{ ok: boolean }`(第 2 轮细化)。红灯测试按语义闸门归一断言,
 * 第 8 轮实现定型后可收紧为单一形状。
 */
function okOf(result: unknown): boolean {
  if (typeof result === 'boolean') return result;
  if (result != null && typeof result === 'object' && 'ok' in result) {
    return Boolean((result as { ok: unknown }).ok);
  }
  return Boolean(result);
}

// ---------------------------------------------------------------------------
// 测试应用注册(模块级一次性,复用 windowCloseGuard.test.ts 范式)
// ---------------------------------------------------------------------------

const GUARDED_TYPE = 'deact-guarded-test';
const ESSAY_TYPE = 'deact-essay-test';
const PLAIN_TYPE = 'deact-plain-test';

let guardedCanClose: (instanceKey: string | null) => boolean | Promise<boolean> = () => true;

appRegistry.register({
  typeId: GUARDED_TYPE,
  nameKey: 'workbench:test.deactGuarded',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  canClose: (instanceKey) => guardedCanClose(instanceKey),
});

// 模拟 createContentApp 的 essay 形态:canClose 消费 contentDirtyRegistry。
// dirty essay 即「isContentDirty=true 窗」的代表场景。
appRegistry.register({
  typeId: ESSAY_TYPE,
  nameKey: 'workbench:test.deactEssay',
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
  nameKey: 'workbench:test.deactPlain',
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

// 实现未落地 → skip,红灯原因:core/deactivationTransaction.ts 缺失(见文件头)
const describeIfImplemented = runWorkbenchDeactivationTransaction ? describe : describe.skip;

describeIfImplemented('runWorkbenchDeactivationTransaction — 缝一整体事务', () => {
  const run = runWorkbenchDeactivationTransaction!;

  it('dirty essay 窗存在时,mode-off 事务返回 ok:false(设置页不得 persist mode=false)', async () => {
    // 预期:本用例通过后,WorkbenchSettingsSection.handleModeChange 以此返回值
    // 为闸——ok:false 时不得写 desktop.workbenchMode=false、不得派发
    // WORKBENCH_MODE_CHANGED、开关 UI 回弹(T2 卡)。
    store().openWindow({ typeId: PLAIN_TYPE, instanceKey: 'plain-1' });
    store().openWindow({ typeId: ESSAY_TYPE, instanceKey: 'essay-1' });
    registerContentDirtyChecker(ESSAY_TYPE, 'essay-1', () => true); // 恒 dirty

    const result = await run('mode-off');
    expect(okOf(result)).toBe(false);
  });

  it('canClose=false 窗同样整体取消,且被拒窗口保留在 store(不拆窗)', async () => {
    const guardedId = store().openWindow({ typeId: GUARDED_TYPE, instanceKey: 'one' });
    guardedCanClose = () => false;

    const result = await run('mode-off');
    expect(okOf(result)).toBe(false);
    // 整体取消:拒绝关闭的窗口必须原样留在桌面,桌面继续存活
    expect(store().windows[guardedId]).toBeDefined();
  });

  it('全部窗口干净时事务放行(ok:true)', async () => {
    store().openWindow({ typeId: PLAIN_TYPE, instanceKey: 'plain-1' });
    store().openWindow({ typeId: ESSAY_TYPE, instanceKey: 'essay-1' }); // 未注册 checker = 干净

    const result = await run('mode-off');
    expect(okOf(result)).toBe(true);
  });

  it('事务复用 confirmWindowClose single-flight:一次事务内每窗 canClose 只问一次', async () => {
    store().openWindow({ typeId: GUARDED_TYPE, instanceKey: 'one' });
    const canClose = vi.fn(() => true);
    guardedCanClose = canClose;

    await run('mode-off');
    expect(canClose).toHaveBeenCalledTimes(1);
  });
});

// 缺符号时保留一条显式 skip 记录,让红灯在测试报告里可见、可检索。
if (!runWorkbenchDeactivationTransaction) {
  describe('runWorkbenchDeactivationTransaction — 缝一整体事务(未落地)', () => {
    it.skip('红灯占位:core/deactivationTransaction.ts 尚未创建,实现落地后上方用例自动激活', () => {
      // 见文件头「红灯原因」。此占位不做任何断言。
    });
  });
}
