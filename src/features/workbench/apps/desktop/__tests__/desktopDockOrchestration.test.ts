/**
 * A45-4（docs/dev/acr/ACR-4.5.md）— desktop Dock 固定区编排能力测试
 *
 * 覆盖：
 * - pinApp / unpinApp / reorderDock 的 changed 语义与固定区真实落地（DockPinnedStore）
 * - no-op 诚实（已固定 / 未固定 / 同位重排 → changed:false + ACTION_UNAVAILABLE）
 * - 「整个固定区快照」undo 结构（inverse 组合 + state_equals dockPinned 断言 + 中文 label）
 * - 无效 typeId 结构化失败（INVALID_ARGS / APP_NOT_REGISTERED / launcher 隐藏不代钉）
 * - reorderDock 越界 / 非整数 toIndex 拒绝
 * - observe 的 availableActions / 实体 Dock 动作增补
 * - agentRuntime act + undo 全链路回放（组合 inverse 精确恢复快照）
 *
 * 本轮纪律：测试只写不跑（协调者统一验收）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  actOnAgentWindow,
  observeAgentWindow,
  revertAgentUndo,
} from '../../../core/agentRuntime';
import { resetAgentUndoJournalForTests } from '../../../core/agentUndoJournal';
import { resetWindowListCacheForTests } from '../../../core/windowListCache';
import { resetActiveTilingPairCacheForTests } from '../../../core/tiling';
import { resetWindowStoreForTests } from '../../../core/windowStore';
import { workbenchBus } from '../../../core/workbenchBus';
import { registerTestApp } from '../../../core/__tests__/testUtils';
import { setAgentControlMode } from '../../../agent/gates';
import {
  getDockPinned,
  setDockPinned,
} from '../../../components/DockPinnedStore';
import type { AgentActionCall, AgentActionResult } from '../../../core/types';
import { desktopAgentManifest, desktopAppRef } from '../agentManifest';
import { registerDesktopAgentTarget } from '../register';

registerTestApp('dock-chat', { instanceMode: 'single' });
registerTestApp('dock-files', { instanceMode: 'single' });
registerTestApp('dock-todo', { instanceMode: 'single' });
registerTestApp('dock-notes', { instanceMode: 'multi' });
// launcher 隐藏应用：不可经 agent 钉入（对齐 AppsPanel 可发现集合）
registerTestApp('dock-hidden', { instanceMode: 'single', showInLauncher: false });
registerDesktopAgentTarget();

const CTX = { windowId: 'desktop', typeId: 'desktop', instanceKey: null };
const DOCK_UNDO_LABEL = '恢复 Dock 固定区';

async function execute(
  name: string,
  args: Record<string, unknown>,
  targetRef?: string,
): Promise<AgentActionResult> {
  return (await desktopAgentManifest.execute!(CTX, {
    name,
    args,
    ...(targetRef ? { targetRef } : {}),
  })) as AgentActionResult;
}

function dockCondition(expected: string[]) {
  return { kind: 'state_equals', path: 'dockPinned', value: expected };
}

function inverseCalls(result: AgentActionResult): AgentActionCall[] {
  const inverse = result.undo!.inverse;
  return Array.isArray(inverse) ? inverse : [inverse];
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  resetWindowListCacheForTests();
  resetActiveTilingPairCacheForTests();
  resetAgentUndoJournalForTests({ clearStorage: true });
  workbenchBus.setEnabled(true);
  setAgentControlMode('follow');
  // DockPinnedStore 是模块级状态：每例清空，避免跨用例串味
  setDockPinned([]);
});

describe('desktop Dock 编排 — pinApp', () => {
  it('钉入追加到末尾：changed/acknowledged/postcondition + 快照 undo 结构', async () => {
    setDockPinned(['dock-chat']);
    const result = await execute('pinApp', { typeId: 'dock-files' });
    expect(result).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      entityRefs: [desktopAppRef('dock-files')],
      details: { typeId: 'dock-files', index: 1, dockPinned: ['dock-chat', 'dock-files'] },
      postconditions: [dockCondition(['dock-chat', 'dock-files'])],
      undo: {
        label: DOCK_UNDO_LABEL,
        inverse: [{
          name: 'unpinApp',
          args: { typeId: 'dock-files' },
          expect: [dockCondition(['dock-chat'])],
        }],
      },
    });
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-files']);
  });

  it('已固定 → no-op（changed:false，固定区不变）', async () => {
    setDockPinned(['dock-chat', 'dock-files']);
    const result = await execute('pinApp', { typeId: 'dock-chat' });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-files']);
  });

  it('无效 typeId 结构化失败：缺参 / 未注册 / launcher 隐藏 / desktop 自身', async () => {
    expect(await execute('pinApp', { typeId: '   ' }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('pinApp', {}))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('pinApp', { typeId: 'no-such-app' }))
      .toMatchObject({ handled: false, changed: false, code: 'APP_NOT_REGISTERED' });
    expect(await execute('pinApp', { typeId: 'dock-hidden' }))
      .toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(await execute('pinApp', { typeId: 'desktop' }))
      .toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });
    expect(getDockPinned()).toEqual([]);
  });

  it('targetRef 与 typeId 不一致 → TARGET_REF_MISMATCH', async () => {
    const result = await execute(
      'pinApp',
      { typeId: 'dock-chat' },
      desktopAppRef('dock-files'),
    );
    expect(result).toMatchObject({ handled: false, code: 'TARGET_REF_MISMATCH' });
  });
});

describe('desktop Dock 编排 — unpinApp', () => {
  it('取消中位固定：undo 为 pinApp+reorderDock 两步组合，精确恢复快照', async () => {
    setDockPinned(['dock-chat', 'dock-files', 'dock-todo']);
    const result = await execute('unpinApp', { typeId: 'dock-files' });
    expect(result).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      details: { typeId: 'dock-files', removedIndex: 1, dockPinned: ['dock-chat', 'dock-todo'] },
      postconditions: [dockCondition(['dock-chat', 'dock-todo'])],
      undo: {
        label: DOCK_UNDO_LABEL,
        inverse: [
          {
            name: 'pinApp',
            args: { typeId: 'dock-files' },
            expect: [dockCondition(['dock-chat', 'dock-todo', 'dock-files'])],
          },
          {
            name: 'reorderDock',
            args: { typeId: 'dock-files', toIndex: 1 },
            expect: [dockCondition(['dock-chat', 'dock-files', 'dock-todo'])],
          },
        ],
      },
    });
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-todo']);
  });

  it('取消末位固定：undo 单步 pinApp 即恢复快照', async () => {
    setDockPinned(['dock-chat', 'dock-files']);
    const result = await execute('unpinApp', { typeId: 'dock-files' });
    expect(result.changed).toBe(true);
    expect(inverseCalls(result)).toEqual([
      expect.objectContaining({
        name: 'pinApp',
        args: { typeId: 'dock-files' },
        expect: [dockCondition(['dock-chat', 'dock-files'])],
      }),
    ]);
  });

  it('未固定 → no-op（changed:false）', async () => {
    setDockPinned(['dock-chat']);
    const result = await execute('unpinApp', { typeId: 'dock-files' });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(getDockPinned()).toEqual(['dock-chat']);
  });

  it('允许清空固定区（对齐 UI toggle 语义），message 如实提示默认回退', async () => {
    setDockPinned(['dock-chat']);
    const result = await execute('unpinApp', { typeId: 'dock-chat' });
    expect(result).toMatchObject({ handled: true, changed: true });
    expect(getDockPinned()).toEqual([]);
    expect(result.message).toContain('默认');
  });

  it('launcher 隐藏的固定项可取消，但诚实不注册 undo（pinApp 无法恢复）', async () => {
    // 用户经 UI 右键可钉入 launcher 隐藏应用；agent 取消它后无法经 pinApp 撤销
    setDockPinned(['dock-chat', 'dock-hidden']);
    const result = await execute('unpinApp', { typeId: 'dock-hidden' });
    expect(result).toMatchObject({ handled: true, changed: true });
    expect(getDockPinned()).toEqual(['dock-chat']);
    expect(result.undo).toBeUndefined();
    expect(result.message).toContain('dock-hidden');
  });
});

describe('desktop Dock 编排 — reorderDock', () => {
  it('移位：changed + 快照 undo（reorderDock 回原位）', async () => {
    setDockPinned(['dock-chat', 'dock-files', 'dock-todo']);
    const result = await execute('reorderDock', { typeId: 'dock-chat', toIndex: 2 });
    expect(result).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      details: {
        typeId: 'dock-chat',
        fromIndex: 0,
        toIndex: 2,
        dockPinned: ['dock-files', 'dock-todo', 'dock-chat'],
      },
      postconditions: [dockCondition(['dock-files', 'dock-todo', 'dock-chat'])],
      undo: {
        label: DOCK_UNDO_LABEL,
        inverse: [{
          name: 'reorderDock',
          args: { typeId: 'dock-chat', toIndex: 0 },
          expect: [dockCondition(['dock-chat', 'dock-files', 'dock-todo'])],
        }],
      },
    });
    expect(getDockPinned()).toEqual(['dock-files', 'dock-todo', 'dock-chat']);
  });

  it('同位重排 → no-op（changed:false，固定区不变）', async () => {
    setDockPinned(['dock-chat', 'dock-files']);
    const result = await execute('reorderDock', { typeId: 'dock-files', toIndex: 1 });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-files']);
  });

  it('toIndex 越界 / 非整数 / 缺失 → INVALID_ARGS，且 hint 报出合法范围', async () => {
    setDockPinned(['dock-chat', 'dock-files']);
    const overflow = await execute('reorderDock', { typeId: 'dock-chat', toIndex: 2 });
    expect(overflow).toMatchObject({ handled: false, changed: false, code: 'INVALID_ARGS' });
    expect(overflow.hint).toContain('0-1');
    expect(await execute('reorderDock', { typeId: 'dock-chat', toIndex: -1 }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('reorderDock', { typeId: 'dock-chat', toIndex: 0.5 }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('reorderDock', { typeId: 'dock-chat' }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-files']);
  });

  it('未固定的 typeId → 结构化拒绝并提示先 pinApp', async () => {
    setDockPinned(['dock-chat']);
    const result = await execute('reorderDock', { typeId: 'dock-files', toIndex: 0 });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(result.hint).toContain('pinApp');
  });
});

describe('desktop Dock 编排 — observe 投影', () => {
  it('availableActions 按固定区状态收敛；实体动作按 pinned 分派', async () => {
    // 空固定区：只有 pinApp（unpin/reorder 诚实不可用）
    let observation = await desktopAgentManifest.observe!(CTX);
    expect(observation.availableActions).toContain('pinApp');
    expect(observation.availableActions).not.toContain('unpinApp');
    expect(observation.availableActions).not.toContain('reorderDock');

    // 单钉：unpinApp 可用，reorderDock（需 ≥2 项）不可用
    setDockPinned(['dock-chat']);
    observation = await desktopAgentManifest.observe!(CTX);
    expect(observation.availableActions).toEqual(
      expect.arrayContaining(['pinApp', 'unpinApp']),
    );
    expect(observation.availableActions).not.toContain('reorderDock');

    // 双钉：三能力齐备；实体动作按 pinned 分派
    setDockPinned(['dock-chat', 'dock-files']);
    observation = await desktopAgentManifest.observe!(CTX);
    expect(observation.availableActions).toEqual(
      expect.arrayContaining(['pinApp', 'unpinApp', 'reorderDock']),
    );
    expect(observation.state!.dockPinned).toEqual(['dock-chat', 'dock-files']);
    const pinnedEntity = observation.entities!.find(
      (entity) => entity.ref === desktopAppRef('dock-chat'),
    );
    expect(pinnedEntity!.actions).toEqual(
      expect.arrayContaining(['launchApp', 'unpinApp', 'reorderDock']),
    );
    expect(pinnedEntity!.actions).not.toContain('pinApp');
    const unpinnedEntity = observation.entities!.find(
      (entity) => entity.ref === desktopAppRef('dock-todo'),
    );
    expect(unpinnedEntity!.actions).toEqual(expect.arrayContaining(['launchApp', 'pinApp']));
    expect(unpinnedEntity!.actions).not.toContain('unpinApp');
  });
});

describe('desktop Dock 编排 — agentRuntime act + undo 全链路', () => {
  it('unpinApp 中位项经组合 inverse 回放，精确恢复固定区快照', async () => {
    setDockPinned(['dock-chat', 'dock-files', 'dock-todo']);
    const before = await observeAgentWindow({ typeId: 'desktop' });
    const receipt = await actOnAgentWindow({
      typeId: 'desktop',
      observationRevision: before.revision,
      actions: [{ name: 'unpinApp', args: { typeId: 'dock-files' } }],
    }, { sessionId: 'sess-dock' });
    expect(receipt.status).toBe('completed');
    expect(receipt.results[0]).toMatchObject({
      handled: true,
      changed: true,
      verified: true,
      verificationSource: 'result-postcondition',
    });
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-todo']);
    expect(receipt.undoToken).toBeDefined();

    const undone = await revertAgentUndo(receipt.undoToken!, { sessionId: 'sess-dock' });
    expect(undone.reverted).toBe(true);
    // pinApp 追加 + reorderDock 归位：顺序也一并恢复
    expect(getDockPinned()).toEqual(['dock-chat', 'dock-files', 'dock-todo']);
  });
});
