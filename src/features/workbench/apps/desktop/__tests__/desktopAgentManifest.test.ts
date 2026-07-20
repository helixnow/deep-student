/**
 * ACR 4.0（A2）— desktop 虚拟目标测试
 *
 * 覆盖：observe 投影形状 / 各能力 execute 的 changed·undo·postcondition /
 * no-op 与错误路径 / agentRuntime 虚拟解析（get_capabilities·observe·act·undo）/
 * probe 恒 clean / queryProviders 发现路径。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  actOnAgentWindow,
  getAgentCapabilities,
  observeAgentWindow,
  revertAgentUndo,
} from '../../../core/agentRuntime';
import { resetAgentUndoJournalForTests } from '../../../core/agentUndoJournal';
import { resetWindowListCacheForTests } from '../../../core/windowListCache';
import { resetActiveTilingPairCacheForTests } from '../../../core/tiling';
import { resetWindowStoreForTests, useWindowStore } from '../../../core/windowStore';
import { workbenchBus } from '../../../core/workbenchBus';
import { registerTestApp } from '../../../core/__tests__/testUtils';
import { setAgentControlMode } from '../../../agent/gates';
import { probeTarget } from '../../../agent/probe';
import { buildWindowSummaries } from '../../../agent/queryProviders';
import type {
  AgentAffordanceNode,
  AgentObservationPatch,
} from '../../../core/types';
import {
  desktopAgentManifest,
  desktopAppRef,
  desktopWindowRef,
} from '../agentManifest';
import { registerDesktopAgentTarget } from '../register';

registerTestApp('desk-note', { instanceMode: 'multi' });
registerTestApp('desk-chat', { instanceMode: 'single' });
registerDesktopAgentTarget();

const CTX = { windowId: 'desktop', typeId: 'desktop', instanceKey: null };

function openTestWindow(typeId: string, title: string, instanceKey?: string): string {
  return useWindowStore.getState().openWindow({ typeId, instanceKey, title });
}

async function observe(): Promise<AgentObservationPatch> {
  return desktopAgentManifest.observe!(CTX);
}

function flatten(nodes: AgentAffordanceNode[] | undefined): AgentAffordanceNode[] {
  const result: AgentAffordanceNode[] = [];
  const stack = [...(nodes ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    stack.push(...(node.children ?? []));
  }
  return result;
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  resetWindowListCacheForTests();
  resetActiveTilingPairCacheForTests();
  resetAgentUndoJournalForTests({ clearStorage: true });
  workbenchBus.setEnabled(true);
  setAgentControlMode('follow');
});

describe('desktop manifest — 契约形状', () => {
  // A45-4 跨界收尾（协调者已授权）：能力全集 = 8 窗口管理 + A45-3 搜索 2 + A45-4 Dock 3
  it('能力全集、不提供 close、风险/可撤销矩阵符合章程', () => {
    const byName = Object.fromEntries(
      desktopAgentManifest.capabilities.map((capability) => [capability.name, capability]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      'focusWindow', 'globalSearch', 'launchApp', 'minimizeWindow', 'moveWindow',
      'openSearchResult', 'pinApp', 'reorderDock', 'resizeWindow', 'restoreWindow',
      'snapWindow', 'tileWindows', 'unpinApp',
    ]);
    // globalSearch 是唯一纯读能力（mutates=false），其余全部 mutates=true
    for (const capability of desktopAgentManifest.capabilities) {
      expect(capability.mutates, `${capability.name}.mutates`)
        .toBe(capability.name !== 'globalSearch');
    }
    expect(Object.keys(byName).some((name) => /close/i.test(name))).toBe(false);
    for (const low of [
      'focusWindow', 'minimizeWindow', 'restoreWindow',
      'moveWindow', 'resizeWindow', 'snapWindow',
    ]) {
      expect(byName[low]).toMatchObject({ risk: 'low', reversible: true });
    }
    expect(byName.tileWindows).toMatchObject({ risk: 'medium', reversible: true });
    expect(byName.launchApp).toMatchObject({ risk: 'medium', reversible: false });
    // A45-4：Dock 编排风险矩阵（pin/reorder 改视图态 low；unpin 移除用户配置 medium）
    expect(byName.pinApp).toMatchObject({ risk: 'low', reversible: true, idempotent: true });
    expect(byName.unpinApp).toMatchObject({ risk: 'medium', reversible: true, idempotent: true });
    expect(byName.reorderDock).toMatchObject({ risk: 'low', reversible: true, idempotent: true });
  });

  it('observe 投影：窗口清单、布局、dock、演出槽与 revision', async () => {
    const a = openTestWindow('desk-note', '笔记 A', 'na');
    const b = openTestWindow('desk-chat', '会话 B');
    useWindowStore.getState().minimizeWindow(a, true);
    useWindowStore.getState().setDisplayMode(b, 'maximized');

    const observation = await observe();
    expect(typeof observation.revision).toBe('string');
    expect(observation.state).toMatchObject({
      windowCount: 2,
      minimizedCount: 1,
      focusedWindowId: b,
      layout: { hasMaximized: true, activeTilingPair: null },
    });
    const windowStates = observation.state!.windowStates as Record<string, {
      minimized: boolean; displayMode: string; focused: boolean;
    }>;
    expect(windowStates[a]).toMatchObject({ minimized: true, focused: false });
    expect(windowStates[b]).toMatchObject({
      minimized: false, focused: true, displayMode: 'maximized',
    });
    expect(observation.state!.launchableTypeIds).toEqual(
      expect.arrayContaining(['desk-note', 'desk-chat']),
    );
    expect(observation.state!.stage).toEqual({ presence: [], slotsInUse: 0 });

    // 可用动作按桌面状态收敛：有最小化窗 → restoreWindow；最大化窗不可 move/resize
    expect(observation.availableActions).toEqual(expect.arrayContaining([
      'focusWindow', 'restoreWindow', 'minimizeWindow', 'snapWindow',
      'tileWindows', 'launchApp',
    ]));
    expect(observation.availableActions).not.toContain('moveWindow');

    // 实体/affordance：每个「当前可用」的 targetKinds 能力都能落到对应 kind 的
    // descriptor（moveWindow/resizeWindow 在无浮动窗时诚实地不可用）
    const descriptors = [...(observation.entities ?? []), ...flatten(observation.affordances)];
    for (const capability of desktopAgentManifest.capabilities) {
      if (!capability.targetKinds?.length || capability.targetOptional) continue;
      if (!observation.availableActions!.includes(capability.name)) continue;
      expect(
        descriptors.some((descriptor) =>
          capability.targetKinds!.includes(descriptor.kind)
          && descriptor.actions.includes(capability.name)),
        `${capability.name} 应可通过 ${capability.targetKinds.join('|')} 实体触达`,
      ).toBe(true);
    }
    const minimizedEntity = observation.entities!.find(
      (entity) => entity.ref === desktopWindowRef(a),
    );
    expect(minimizedEntity!.actions).toEqual(
      expect.arrayContaining(['focusWindow', 'restoreWindow']),
    );
    expect(minimizedEntity!.actions).not.toContain('minimizeWindow');
    expect(observation.entities!.some(
      (entity) => entity.ref === desktopAppRef('desk-chat') && entity.actions.includes('launchApp'),
    )).toBe(true);
  });
});

describe('desktop manifest — execute 能力矩阵', () => {
  it('focusWindow：changed/undo/postcondition + no-op + WINDOW_NOT_FOUND', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');
    const b = openTestWindow('desk-note', 'B', 'nb');
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(b);

    const focused = await desktopAgentManifest.execute!(CTX, {
      name: 'focusWindow', args: { windowId: a }, targetRef: desktopWindowRef(a),
    });
    expect(focused).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      postconditions: [{ kind: 'state_equals', path: 'focusedWindowId', value: a }],
      undo: { inverse: [expect.objectContaining({ name: 'focusWindow', args: { windowId: b } })] },
    });
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(a);

    const noop = await desktopAgentManifest.execute!(CTX, {
      name: 'focusWindow', args: { windowId: a },
    });
    expect(noop).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });

    const missing = await desktopAgentManifest.execute!(CTX, {
      name: 'focusWindow', args: { windowId: 'nope' },
    });
    expect(missing).toMatchObject({ handled: false, code: 'WINDOW_NOT_FOUND' });
  });

  it('minimizeWindow/restoreWindow 互为逆，且各自 no-op 收口', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');

    const minimized = await desktopAgentManifest.execute!(CTX, {
      name: 'minimizeWindow', args: { windowId: a },
    });
    expect(minimized).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      postconditions: [{
        kind: 'state_equals', path: `windowStates.${a}.minimized`, value: true,
      }],
      undo: { inverse: expect.objectContaining({ name: 'restoreWindow', args: { windowId: a } }) },
    });
    expect(useWindowStore.getState().windows[a].minimized).toBe(true);

    const minimizeAgain = await desktopAgentManifest.execute!(CTX, {
      name: 'minimizeWindow', args: { windowId: a },
    });
    expect(minimizeAgain).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });

    const restored = await desktopAgentManifest.execute!(CTX, {
      name: 'restoreWindow', args: { windowId: a },
    });
    expect(restored).toMatchObject({
      handled: true,
      changed: true,
      undo: { inverse: expect.objectContaining({ name: 'minimizeWindow' }) },
    });
    expect(useWindowStore.getState().windows[a].minimized).toBe(false);

    const restoreAgain = await desktopAgentManifest.execute!(CTX, {
      name: 'restoreWindow', args: { windowId: a },
    });
    expect(restoreAgain).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
  });

  it('moveWindow：记录原 bounds 为 undo、钳回可视区、非浮动/最小化拒绝', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');
    const before = useWindowStore.getState().windows[a].frame;

    const moved = await desktopAgentManifest.execute!(CTX, {
      name: 'moveWindow', args: { windowId: a, x: 200, y: 120 },
    });
    expect(moved).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      details: { windowId: a, x: 200, y: 120 },
      undo: {
        inverse: expect.objectContaining({
          name: 'moveWindow',
          args: { windowId: a, x: before.x, y: before.y },
        }),
      },
    });
    expect(useWindowStore.getState().windows[a].frame).toMatchObject({ x: 200, y: 120 });

    // 越界坐标钳回可视区（y ≥ 0，x ≤ 桌面宽 - 48）
    const clamped = await desktopAgentManifest.execute!(CTX, {
      name: 'moveWindow', args: { windowId: a, x: 99999, y: -50 },
    });
    expect(clamped).toMatchObject({ handled: true, details: { x: 1400 - 48, y: 0 } });

    const noop = await desktopAgentManifest.execute!(CTX, {
      name: 'moveWindow', args: { windowId: a, x: 1400 - 48, y: 0 },
    });
    expect(noop).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });

    useWindowStore.getState().setDisplayMode(a, 'tiled-left');
    const tiledReject = await desktopAgentManifest.execute!(CTX, {
      name: 'moveWindow', args: { windowId: a, x: 10, y: 10 },
    });
    expect(tiledReject).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });

    useWindowStore.getState().setDisplayMode(a, 'floating');
    useWindowStore.getState().minimizeWindow(a, true);
    const minimizedReject = await desktopAgentManifest.execute!(CTX, {
      name: 'moveWindow', args: { windowId: a, x: 10, y: 10 },
    });
    expect(minimizedReject).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });
  });

  it('resizeWindow：尺寸钳制到 minSize，undo 恢复原尺寸', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');
    const before = useWindowStore.getState().windows[a].frame;

    const resized = await desktopAgentManifest.execute!(CTX, {
      name: 'resizeWindow', args: { windowId: a, width: 640, height: 480 },
    });
    expect(resized).toMatchObject({
      handled: true,
      changed: true,
      details: { width: 640, height: 480 },
      undo: {
        inverse: expect.objectContaining({
          args: { windowId: a, width: before.w, height: before.h },
        }),
      },
    });

    // registerTestApp minSize 200x150：低于下限被钳制
    const clamped = await desktopAgentManifest.execute!(CTX, {
      name: 'resizeWindow', args: { windowId: a, width: 10, height: 10 },
    });
    expect(clamped).toMatchObject({ handled: true, details: { width: 200, height: 150 } });

    const noop = await desktopAgentManifest.execute!(CTX, {
      name: 'resizeWindow', args: { windowId: a, width: 200, height: 150 },
    });
    expect(noop).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
  });

  it('snapWindow：贴靠/最大化/恢复浮动，undo 回到原布局', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');

    const snapped = await desktopAgentManifest.execute!(CTX, {
      name: 'snapWindow', args: { windowId: a, zone: 'left' },
    });
    expect(snapped).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      postconditions: [{
        kind: 'state_equals', path: `windowStates.${a}.displayMode`, value: 'tiled-left',
      }],
      undo: {
        inverse: expect.objectContaining({
          name: 'snapWindow', args: { windowId: a, zone: 'floating' },
        }),
      },
    });
    expect(useWindowStore.getState().windows[a].displayMode).toBe('tiled-left');

    const noop = await desktopAgentManifest.execute!(CTX, {
      name: 'snapWindow', args: { windowId: a, zone: 'left' },
    });
    expect(noop).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });

    const invalid = await desktopAgentManifest.execute!(CTX, {
      name: 'snapWindow', args: { windowId: a, zone: 'diagonal' },
    });
    expect(invalid).toMatchObject({ handled: false, code: 'INVALID_ARGS' });

    const floating = await desktopAgentManifest.execute!(CTX, {
      name: 'snapWindow', args: { windowId: a, zone: 'floating' },
    });
    expect(floating).toMatchObject({ handled: true, changed: true });
    expect(useWindowStore.getState().windows[a].displayMode).toBe('floating');
  });

  it('tileWindows：整体布局 + 布局快照 undo + no-op 与最小化拒绝', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');
    const b = openTestWindow('desk-note', 'B', 'nb');
    const c = openTestWindow('desk-note', 'C', 'nc');
    useWindowStore.getState().minimizeWindow(c, true);

    const tiled = await desktopAgentManifest.execute!(CTX, { name: 'tileWindows' });
    expect(tiled).toMatchObject({ handled: true, changed: true, acknowledged: true });
    const state = useWindowStore.getState();
    expect(state.windows[a].displayMode).toBe('tiled-left');
    expect(state.windows[b].displayMode).toBe('tiled-right');
    expect(state.windows[c].displayMode).toBe('floating'); // 最小化窗不参与
    const undoActions = tiled.undo!.inverse as Array<{ name: string; args: unknown }>;
    expect(undoActions).toEqual([
      expect.objectContaining({
        name: 'snapWindow', args: { windowId: a, zone: 'floating' },
      }),
      expect.objectContaining({
        name: 'snapWindow', args: { windowId: b, zone: 'floating' },
      }),
    ]);

    const noop = await desktopAgentManifest.execute!(CTX, { name: 'tileWindows' });
    expect(noop).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });

    const withMinimized = await desktopAgentManifest.execute!(CTX, {
      name: 'tileWindows', args: { windowIds: [a, c] },
    });
    expect(withMinimized).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });

    const missing = await desktopAgentManifest.execute!(CTX, {
      name: 'tileWindows', args: { windowIds: ['nope'] },
    });
    expect(missing).toMatchObject({ handled: false, code: 'WINDOW_NOT_FOUND' });

    // 单窗指定 → maximized
    const single = await desktopAgentManifest.execute!(CTX, {
      name: 'tileWindows', args: { windowIds: [a] },
    });
    expect(single).toMatchObject({ handled: true, changed: true });
    expect(useWindowStore.getState().windows[a].displayMode).toBe('maximized');
  });

  it('launchApp：走 workbenchBus 启动、不可撤、错误路径结构化', async () => {
    const launched = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'desk-chat' }, targetRef: desktopAppRef('desk-chat'),
    });
    const windowId = (launched.details as { windowId: string }).windowId;
    expect(launched).toMatchObject({
      handled: true,
      changed: true,
      acknowledged: true,
      details: { created: true },
      postconditions: [{ kind: 'ref_exists', ref: desktopWindowRef(windowId) }],
    });
    expect(launched.undo).toBeUndefined();
    // 新窗获得 windowStore 'opening' 瞬态标记 → O9 正常入场动画
    expect(useWindowStore.getState().transientPhases?.[windowId]).toBe('opening');

    // single 应用已打开且已聚焦 → no-op
    const again = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'desk-chat' },
    });
    expect(again).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });

    const unregistered = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'no-such-app' },
    });
    expect(unregistered).toMatchObject({ handled: false, code: 'APP_NOT_REGISTERED' });

    const missingResource = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'exam' },
    });
    expect(missingResource).toMatchObject({ handled: false, code: 'INVALID_ARGS' });

    const desktopSelf = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'desktop' },
    });
    expect(desktopSelf).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });

    const mismatch = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp',
      args: { typeId: 'desk-note' },
      targetRef: desktopAppRef('desk-chat'),
    });
    expect(mismatch).toMatchObject({ handled: false, code: 'TARGET_REF_MISMATCH' });

    workbenchBus.setEnabled(false);
    const disabled = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'desk-note' },
    });
    expect(disabled).toMatchObject({ handled: false, code: 'DISABLED' });
  });

  // ACR 4.0（A8）：对齐 stageManager handleOpenApp 的 background 焦点策略
  it('launchApp：background 档开窗不抢焦点，follow 档保持聚焦新窗', async () => {
    const original = openTestWindow('desk-note', '原焦点窗', 'keep-focus');
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(original);

    setAgentControlMode('background');
    const background = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'desk-chat' },
    });
    expect(background).toMatchObject({ handled: true, changed: true });
    const launchedId = (background.details as { windowId: string }).windowId;
    expect(useWindowStore.getState().windows[launchedId]).toBeTruthy();
    // 新窗保留在桌面，但焦点还给原窗
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(original);

    setAgentControlMode('follow');
    const follow = await desktopAgentManifest.execute!(CTX, {
      name: 'launchApp', args: { typeId: 'desk-chat' },
    });
    // desk-chat 为 single：launch 聚焦既有窗
    expect(follow.details).toMatchObject({ windowId: launchedId, created: false });
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(launchedId);
  });
});

describe('desktop 虚拟目标 — agentRuntime 解析与发现', () => {
  it('get_capabilities：无 target 列表包含 desktop；typeId/windowId 均可定位', () => {
    const all = getAgentCapabilities();
    const desktop = all.apps.find((app) => app.typeId === 'desktop');
    expect(desktop).toBeDefined();
    expect(desktop!.capabilities.map((capability) => capability.name)).toContain('tileWindows');

    const byType = getAgentCapabilities({ typeId: 'desktop' });
    expect(byType.apps[0]).toMatchObject({ typeId: 'desktop', windowId: 'desktop' });

    const byWindow = getAgentCapabilities({ windowId: 'desktop' });
    expect(byWindow.apps[0]).toMatchObject({ typeId: 'desktop' });
  });

  it('observe：无窗恒可观察，focused=true，windowId=desktop', async () => {
    const observation = await observeAgentWindow({ typeId: 'desktop' });
    expect(observation).toMatchObject({
      windowId: 'desktop',
      typeId: 'desktop',
      instanceKey: null,
      focused: true,
      dirty: false,
      busy: false,
    });
    expect(observation.revision).toMatch(/^acr:/);
  });

  it('act 全链路：OCC revision + 校验 + postcondition 验证 + 持久 undo 回放', async () => {
    const a = openTestWindow('desk-note', 'A', 'na');
    const before = await observeAgentWindow({ typeId: 'desktop' });
    const receipt = await actOnAgentWindow({
      typeId: 'desktop',
      observationRevision: before.revision,
      actions: [{
        name: 'minimizeWindow',
        args: { windowId: a },
        targetRef: desktopWindowRef(a),
      }],
    }, { sessionId: 'sess-desk' });
    expect(receipt.status).toBe('completed');
    expect(receipt.results[0]).toMatchObject({
      handled: true,
      changed: true,
      verified: true,
      verificationSource: 'result-postcondition',
    });
    expect(useWindowStore.getState().windows[a].minimized).toBe(true);
    expect(receipt.undoToken).toBeDefined();

    const undone = await revertAgentUndo(receipt.undoToken!, { sessionId: 'sess-desk' });
    expect(undone.reverted).toBe(true);
    expect(useWindowStore.getState().windows[a].minimized).toBe(false);
  });

  it('act：过期 revision 与未知能力被拒绝', async () => {
    openTestWindow('desk-note', 'A', 'na');
    const before = await observeAgentWindow({ typeId: 'desktop' });
    openTestWindow('desk-note', 'B', 'nb'); // 使 revision 过期
    await expect(actOnAgentWindow({
      typeId: 'desktop',
      observationRevision: before.revision,
      actions: [{ name: 'tileWindows' }],
    })).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });

    const fresh = await observeAgentWindow({ typeId: 'desktop' });
    await expect(actOnAgentWindow({
      typeId: 'desktop',
      observationRevision: fresh.revision,
      actions: [{ name: 'closeWindow', args: {} }],
    })).rejects.toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
  });

  it('probe：desktop 恒 clean（无窗），OS 关闭时 disabled', () => {
    expect(probeTarget({ typeId: 'desktop' })).toEqual({ state: 'clean', windowId: null });
    workbenchBus.setEnabled(false);
    expect(probeTarget({ typeId: 'desktop' })).toEqual({ state: 'disabled', windowId: null });
  });

  it('list_windows：desktop 以独立虚拟描述暴露，不混入 windows[]', () => {
    openTestWindow('desk-note', 'A', 'na');
    const listed = buildWindowSummaries();
    expect(listed.windows.some((win) => win.typeId === 'desktop')).toBe(false);
    expect(listed.desktop).toMatchObject({
      typeId: 'desktop',
      agentReady: true,
      virtual: true,
    });
    expect(listed.desktop!.availableActions).toContain('launchApp');
  });
});
