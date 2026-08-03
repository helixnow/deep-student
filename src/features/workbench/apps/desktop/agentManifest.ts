/**
 * ACR 4.0（A2）— 学习 OS「desktop」虚拟目标 manifest
 *
 * 桌面本身的语义控制面：窗口聚焦/最小化/恢复/移动/缩放/贴靠/平铺 + 启动应用。
 * 无宿主窗口的单例（typeId 'desktop' 兼作稳定伪 windowId），经
 * core/agentRuntime.registerVirtualAgentTarget 注册，不进 appRegistry
 * （避免被 open_app / 启动器打开成假窗）。
 *
 * 纪律：
 * - 只读调用 windowStore / tiling / DockPinnedStore / presenceStore，不改写它们；
 * - 不提供 close（关窗必须走既有 workbench_close_window High 审批）；
 * - 布局类能力 reversible（记录原 bounds / displayMode 为 inverse）；
 * - launchApp medium 且不可撤，走 workbenchBus.launch 既有启动路径
 *   （新窗由 windowStore 自动打 'opening' 瞬态标记 → O9 入场动画）。
 */
import { appRegistry } from '../../core/appRegistry';
import { getSortedWindows } from '../../core/windowListCache';
import {
  clampTilingRatio,
  getActiveTilingPair,
  hasVisibleMaximizedWindow,
} from '../../core/tiling';
import { useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
// A45-4（docs/dev/acr/ACR-4.5.md）：Dock 固定区编排全部走 DockPinnedStore 真实函数
import {
  getDockPinned,
  reorderDockPinned,
  toggleDockPinned,
} from '../../components/DockPinnedStore';
import { getAgentControlMode } from '../../agent/gates';
import { usePresenceStore } from '../../agent/presenceStore';
import { captureWindowFlip } from '../../agent/visuals/agentWindowFlip';
import type {
  AgentActionCall,
  AgentActionResult,
  AgentAffordanceNode,
  AgentEntitySummary,
  AgentJsonValue,
  AgentObservationCondition,
  AppAgentManifest,
  DisplayMode,
  Frame,
  WorkbenchWindow,
} from '../../core/types';
import {
  actionArgs,
  objectSchema,
  rejectMismatchedTarget,
  shortLabel,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';
// ── A45-3（docs/dev/acr/ACR-4.5.md）：desktop 全局搜索能力的追加依赖 ──
import i18next from 'i18next';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import type { DependencyResolver } from '@/command-palette/registry/types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { DstuNode } from '@/dstu/types';
import { closeAppsPanel, openAppsPanel } from '../../components/appsPanelStore';
import {
  createAppsProvider,
  createChatProvider,
  createCommandsProvider,
  createDstuProviderWithNodeCapture,
  openChatInWorkbenchForAgent,
  openDstuInWorkbench,
  type GlobalSearchItem,
  type GlobalSearchKind,
  type GlobalSearchProvider,
  type WorkbenchSearchHost,
} from '../../search/globalSearchProviders';
import {
  isNotesWorkspaceResourceType,
  resourceTypeToAppTypeId,
} from '../content/typeMap';

export const DESKTOP_TYPE_ID = 'desktop';

/** 观察投影上限（对齐 files 的 80 窗/60 应用截断纪律） */
const MAX_OBSERVED_WINDOWS = 80;
const MAX_OBSERVED_APPS = 60;
/** moveWindow 钳制：窗口至少露出的边缘宽度 / 标题栏高度（对齐 windowStore） */
const MIN_VISIBLE_EDGE = 48;
const TITLEBAR_HEIGHT = 38;
const FALLBACK_MIN_SIZE = { w: 200, h: 150 } as const;
/** tileAll 语义上限：一次平铺最多 4 扇窗 */
const MAX_TILED_WINDOWS = 4;

/** launchApp：走 notes 工作区路由的资源 typeId（不在 appRegistry，需 resourceId） */
const WORKSPACE_RESOURCE_TYPE_IDS = new Set(['note', 'mindmap']);
/** launchApp：必须携带 resourceId 的内容型应用（对齐 stageManager open_app）。
 * file-preview 是 OS 模式的统一文件预览应用（instanceKey=resourceId，multi），
 * 无资源开窗只会得到空壳预览窗，同样要求 resourceId。 */
const RESOURCE_KEY_REQUIRED_TYPE_IDS = new Set([
  'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'file-preview',
]);

type DesktopSnapZone =
  | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br' | 'maximized' | 'floating';

const ZONE_TO_MODE: Record<DesktopSnapZone, DisplayMode> = {
  left: 'tiled-left',
  right: 'tiled-right',
  tl: 'tiled-tl',
  tr: 'tiled-tr',
  bl: 'tiled-bl',
  br: 'tiled-br',
  maximized: 'maximized',
  floating: 'floating',
};

const MODE_TO_ZONE: Record<DisplayMode, DesktopSnapZone> = {
  'tiled-left': 'left',
  'tiled-right': 'right',
  'tiled-tl': 'tl',
  'tiled-tr': 'tr',
  'tiled-bl': 'bl',
  'tiled-br': 'br',
  maximized: 'maximized',
  floating: 'floating',
};

const SNAP_ZONES: DesktopSnapZone[] = [
  'left', 'right', 'tl', 'tr', 'bl', 'br', 'maximized', 'floating',
];

export function desktopWindowRef(windowId: string): string {
  return stableAgentRef('desktop', 'window', windowId);
}

export function desktopAppRef(typeId: string): string {
  return stableAgentRef('desktop', 'app', typeId);
}

function focusedTopWindowId(): string | null {
  const state = useWindowStore.getState();
  return state.focusStack.at(-1) ?? null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function windowNotFound(windowId: string): AgentActionResult {
  return {
    handled: false,
    changed: false,
    code: 'WINDOW_NOT_FOUND',
    hint: `窗口不存在: ${windowId}；请重新 observe desktop 获取最新窗口清单`,
  };
}

function actionNoop(hint: string): AgentActionResult {
  return { handled: false, changed: false, code: 'ACTION_UNAVAILABLE', hint };
}

/** 每个窗口当前可用的桌面动作（观察投影与 execute 判定共用） */
function windowActions(win: WorkbenchWindow, focusedId: string | null): string[] {
  const actions: string[] = [];
  if (win.minimized || win.id !== focusedId) actions.push('focusWindow');
  if (win.minimized) actions.push('restoreWindow');
  else {
    actions.push('minimizeWindow', 'snapWindow');
    if (win.displayMode === 'floating') actions.push('moveWindow', 'resizeWindow');
  }
  return actions;
}

interface DesktopWindowStateEntry {
  typeId: string;
  instanceKey: string | null;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  displayMode: DisplayMode;
  zIndex: number;
  minimized: boolean;
  focused: boolean;
  agentReady: boolean;
  [key: string]: AgentJsonValue;
}

function windowStateEntry(
  win: WorkbenchWindow,
  focusedId: string | null,
): DesktopWindowStateEntry {
  return {
    typeId: win.typeId,
    instanceKey: win.instanceKey,
    title: shortLabel(win.title) ?? win.typeId,
    x: win.frame.x,
    y: win.frame.y,
    w: win.frame.w,
    h: win.frame.h,
    displayMode: win.displayMode,
    zIndex: win.zIndex,
    minimized: win.minimized,
    focused: !win.minimized && win.id === focusedId,
    agentReady: Boolean(appRegistry.getAgentManifest(win.typeId)),
  };
}

function displayModePostcondition(
  windowId: string,
  mode: DisplayMode,
): AgentObservationCondition {
  return {
    kind: 'state_equals',
    path: `windowStates.${windowId}.displayMode`,
    value: mode,
  };
}

/** tileAll 同款布局分配（≤4 窗） */
function tileModesFor(count: number): DisplayMode[] {
  if (count <= 1) return ['maximized'];
  if (count === 2) return ['tiled-left', 'tiled-right'];
  if (count === 3) return ['tiled-left', 'tiled-tr', 'tiled-br'];
  return ['tiled-tl', 'tiled-tr', 'tiled-bl', 'tiled-br'];
}

function launchableAppTypeIds(): string[] {
  return appRegistry
    .list()
    .filter((def) => def.showInLauncher !== false)
    .map((def) => def.typeId)
    .slice(0, MAX_OBSERVED_APPS);
}

// ---------------------------------------------------------------------------
// 能力执行
// ---------------------------------------------------------------------------

function executeFocusWindow(windowId: string): AgentActionResult {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return windowNotFound(windowId);
  const prevFocusedId = focusedTopWindowId();
  if (!win.minimized && prevFocusedId === windowId) {
    return actionNoop(`窗口 ${windowId} 已是焦点窗，focusWindow 为 no-op`);
  }
  const wasMinimized = win.minimized;
  store.focusWindow(windowId);
  const after = useWindowStore.getState();
  const acknowledged = after.focusStack.at(-1) === windowId
    && after.windows[windowId]?.minimized === false;
  if (!acknowledged) {
    return actionNoop(`focusWindow 未达到请求后的窗口状态: ${windowId}`);
  }
  const inverse: AgentActionCall[] = wasMinimized
    ? [{
        name: 'minimizeWindow',
        args: { windowId },
        targetRef: desktopWindowRef(windowId),
        expect: [{
          kind: 'state_equals',
          path: `windowStates.${windowId}.minimized`,
          value: true,
        }],
      }]
    : prevFocusedId && prevFocusedId !== windowId
      ? [{
          name: 'focusWindow',
          args: { windowId: prevFocusedId },
          targetRef: desktopWindowRef(prevFocusedId),
          expect: [{
            kind: 'state_equals',
            path: 'focusedWindowId',
            value: prevFocusedId,
          }],
        }]
      : [];
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    postconditions: [
      { kind: 'state_equals', path: 'focusedWindowId', value: windowId },
    ],
    ...(inverse.length ? { undo: { inverse, label: '恢复窗口焦点' } } : {}),
  };
}

function executeMinimizeWindow(windowId: string): AgentActionResult {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return windowNotFound(windowId);
  if (win.minimized) {
    return actionNoop(`窗口 ${windowId} 已最小化，minimizeWindow 为 no-op`);
  }
  store.minimizeWindow(windowId, true);
  const acknowledged = useWindowStore.getState().windows[windowId]?.minimized === true;
  if (!acknowledged) {
    return actionNoop(`minimizeWindow 未达到请求后的窗口状态: ${windowId}`);
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    postconditions: [{
      kind: 'state_equals',
      path: `windowStates.${windowId}.minimized`,
      value: true,
    }],
    undo: {
      inverse: {
        name: 'restoreWindow',
        args: { windowId },
        targetRef: desktopWindowRef(windowId),
        expect: [{
          kind: 'state_equals',
          path: `windowStates.${windowId}.minimized`,
          value: false,
        }],
      },
      label: '恢复被最小化的窗口',
    },
  };
}

function executeRestoreWindow(windowId: string): AgentActionResult {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return windowNotFound(windowId);
  if (!win.minimized) {
    return actionNoop(`窗口 ${windowId} 未最小化，restoreWindow 为 no-op`);
  }
  // 不抢焦点的反最小化（对齐 Dock 行为）；需要置顶请再 focusWindow
  store.minimizeWindow(windowId, false);
  const acknowledged = useWindowStore.getState().windows[windowId]?.minimized === false;
  if (!acknowledged) {
    return actionNoop(`restoreWindow 未达到请求后的窗口状态: ${windowId}`);
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    postconditions: [{
      kind: 'state_equals',
      path: `windowStates.${windowId}.minimized`,
      value: false,
    }],
    undo: {
      inverse: {
        name: 'minimizeWindow',
        args: { windowId },
        targetRef: desktopWindowRef(windowId),
        expect: [{
          kind: 'state_equals',
          path: `windowStates.${windowId}.minimized`,
          value: true,
        }],
      },
      label: '重新最小化窗口',
    },
  };
}

function requireFloatingVisible(
  win: WorkbenchWindow,
  action: string,
): AgentActionResult | null {
  if (win.minimized) {
    return actionNoop(`窗口 ${win.id} 已最小化，${action} 不可用；先 restoreWindow`);
  }
  if (win.displayMode !== 'floating') {
    return actionNoop(
      `窗口 ${win.id} 处于 ${win.displayMode} 布局，${action} 只作用于浮动窗；`
      + '先 snapWindow zone=floating 恢复浮动',
    );
  }
  return null;
}

function executeMoveWindow(
  windowId: string,
  x: number,
  y: number,
): AgentActionResult {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return windowNotFound(windowId);
  const blocked = requireFloatingVisible(win, 'moveWindow');
  if (blocked) return blocked;
  const { desktopSize } = store;
  const target: Frame = {
    ...win.frame,
    // 钳回可视区（对齐 windowStore 的边缘可见性保证）
    x: clampNumber(
      x,
      Math.min(0, MIN_VISIBLE_EDGE - win.frame.w),
      Math.max(0, desktopSize.w - MIN_VISIBLE_EDGE),
    ),
    y: clampNumber(y, 0, Math.max(0, desktopSize.h - TITLEBAR_HEIGHT)),
  };
  if (target.x === win.frame.x && target.y === win.frame.y) {
    return actionNoop(`窗口 ${windowId} 已在目标位置（含钳制），moveWindow 为 no-op`);
  }
  const before = { x: win.frame.x, y: win.frame.y };
  // ACR 4.1：FLIP 演出——布局直写不变，落位后播 transform 补间（装饰层，失败 no-op）
  const playFlip = captureWindowFlip([windowId]);
  store.moveWindow(windowId, target);
  const after = useWindowStore.getState().windows[windowId];
  const acknowledged = after?.frame.x === target.x && after?.frame.y === target.y;
  if (!acknowledged) {
    return actionNoop(`moveWindow 未达到请求后的窗口位置: ${windowId}`);
  }
  playFlip();
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    details: { windowId, x: target.x, y: target.y },
    postconditions: [
      { kind: 'state_equals', path: `windowStates.${windowId}.x`, value: target.x },
      { kind: 'state_equals', path: `windowStates.${windowId}.y`, value: target.y },
    ],
    undo: {
      inverse: {
        name: 'moveWindow',
        args: { windowId, x: before.x, y: before.y },
        targetRef: desktopWindowRef(windowId),
        expect: [
          { kind: 'state_equals', path: `windowStates.${windowId}.x`, value: before.x },
          { kind: 'state_equals', path: `windowStates.${windowId}.y`, value: before.y },
        ],
      },
      label: '恢复窗口位置',
    },
  };
}

function executeResizeWindow(
  windowId: string,
  width: number,
  height: number,
): AgentActionResult {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return windowNotFound(windowId);
  const blocked = requireFloatingVisible(win, 'resizeWindow');
  if (blocked) return blocked;
  const minSize = appRegistry.get(win.typeId)?.minSize ?? FALLBACK_MIN_SIZE;
  const { desktopSize } = store;
  const target: Frame = {
    ...win.frame,
    w: clampNumber(width, minSize.w, Math.max(minSize.w, desktopSize.w)),
    h: clampNumber(height, minSize.h, Math.max(minSize.h, desktopSize.h)),
  };
  if (target.w === win.frame.w && target.h === win.frame.h) {
    return actionNoop(`窗口 ${windowId} 已是目标尺寸（含钳制），resizeWindow 为 no-op`);
  }
  const before = { w: win.frame.w, h: win.frame.h };
  const playFlip = captureWindowFlip([windowId]);
  store.moveWindow(windowId, target);
  const after = useWindowStore.getState().windows[windowId];
  const acknowledged = after?.frame.w === target.w && after?.frame.h === target.h;
  if (!acknowledged) {
    return actionNoop(`resizeWindow 未达到请求后的窗口尺寸: ${windowId}`);
  }
  playFlip();
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    details: { windowId, width: target.w, height: target.h },
    postconditions: [
      { kind: 'state_equals', path: `windowStates.${windowId}.w`, value: target.w },
      { kind: 'state_equals', path: `windowStates.${windowId}.h`, value: target.h },
    ],
    undo: {
      inverse: {
        name: 'resizeWindow',
        args: { windowId, width: before.w, height: before.h },
        targetRef: desktopWindowRef(windowId),
        expect: [
          { kind: 'state_equals', path: `windowStates.${windowId}.w`, value: before.w },
          { kind: 'state_equals', path: `windowStates.${windowId}.h`, value: before.h },
        ],
      },
      label: '恢复窗口尺寸',
    },
  };
}

function executeSnapWindow(windowId: string, zone: DesktopSnapZone): AgentActionResult {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return windowNotFound(windowId);
  if (win.minimized) {
    return actionNoop(`窗口 ${windowId} 已最小化，snapWindow 不可用；先 restoreWindow`);
  }
  const mode = ZONE_TO_MODE[zone];
  if (win.displayMode === mode) {
    return actionNoop(`窗口 ${windowId} 已处于 ${zone} 布局，snapWindow 为 no-op`);
  }
  const beforeMode = win.displayMode;
  const playFlip = captureWindowFlip([windowId]);
  store.setDisplayMode(windowId, mode);
  const acknowledged = useWindowStore.getState().windows[windowId]?.displayMode === mode;
  if (!acknowledged) {
    return actionNoop(`snapWindow 未达到请求后的窗口布局: ${windowId}`);
  }
  playFlip();
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    details: { windowId, zone, displayMode: mode },
    postconditions: [displayModePostcondition(windowId, mode)],
    undo: {
      inverse: {
        name: 'snapWindow',
        args: { windowId, zone: MODE_TO_ZONE[beforeMode] },
        targetRef: desktopWindowRef(windowId),
        expect: [displayModePostcondition(windowId, beforeMode)],
      },
      label: '恢复窗口贴靠布局',
    },
  };
}

function executeTileWindows(requestedIds: string[] | undefined): AgentActionResult {
  const store = useWindowStore.getState();
  let targets: WorkbenchWindow[];
  let overflow = 0;
  if (requestedIds?.length) {
    const unique = [...new Set(requestedIds)];
    const resolvedTargets: WorkbenchWindow[] = [];
    for (const id of unique) {
      const win = store.windows[id];
      if (!win) return windowNotFound(id);
      if (win.minimized) {
        return actionNoop(`窗口 ${id} 已最小化，无法参与平铺；先 restoreWindow`);
      }
      resolvedTargets.push(win);
    }
    targets = resolvedTargets.slice(0, MAX_TILED_WINDOWS);
    overflow = resolvedTargets.length - targets.length;
  } else {
    const visible = getSortedWindows(store.windows).filter((win) => !win.minimized);
    if (visible.length === 0) {
      return actionNoop('当前没有可平铺的窗口（全部已最小化或桌面为空）');
    }
    targets = visible.slice(0, MAX_TILED_WINDOWS);
    overflow = visible.length - targets.length;
  }
  const modes = tileModesFor(targets.length);
  const entries = targets.map((win, index) => ({ id: win.id, mode: modes[index]! }));
  if (entries.every((entry) => store.windows[entry.id]?.displayMode === entry.mode)) {
    return actionNoop('目标窗口已处于请求的平铺布局，tileWindows 为 no-op');
  }
  // 整体布局快照：所有受影响窗口的原 displayMode（floating 原 bounds 由
  // windowStore restoreFrame 语义在 snapWindow zone=floating 时精确还原）
  const snapshot = targets.map((win) => ({
    id: win.id,
    mode: win.displayMode,
  }));
  const playFlip = captureWindowFlip(entries.map((entry) => entry.id));
  if (store.batchSetDisplayModes) {
    store.batchSetDisplayModes(entries);
  } else {
    for (const entry of entries) store.setDisplayMode(entry.id, entry.mode);
  }
  const after = useWindowStore.getState();
  const acknowledged = entries.every(
    (entry) => after.windows[entry.id]?.displayMode === entry.mode,
  );
  if (!acknowledged) {
    return actionNoop('tileWindows 未达到请求后的整体布局，部分窗口未落位');
  }
  playFlip();
  const inverse: AgentActionCall[] = snapshot
    .filter((item, index) => item.mode !== entries[index]!.mode)
    .map((item) => ({
      name: 'snapWindow',
      args: { windowId: item.id, zone: MODE_TO_ZONE[item.mode] },
      targetRef: desktopWindowRef(item.id),
      expect: [displayModePostcondition(item.id, item.mode)],
    }));
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: entries.map((entry) => desktopWindowRef(entry.id)),
    details: {
      layout: entries.map((entry) => ({ windowId: entry.id, displayMode: entry.mode })),
      overflow,
    },
    postconditions: entries.map((entry) => displayModePostcondition(entry.id, entry.mode)),
    ...(inverse.length
      ? { undo: { inverse, label: '恢复平铺前的窗口布局' } }
      : {}),
  };
}

function executeLaunchApp(typeId: string, resourceId?: string): AgentActionResult {
  if (typeId === DESKTOP_TYPE_ID) {
    return actionNoop('desktop 是虚拟目标，无需（也不能）launchApp 打开');
  }
  const needsResource = WORKSPACE_RESOURCE_TYPE_IDS.has(typeId)
    || RESOURCE_KEY_REQUIRED_TYPE_IDS.has(typeId);
  if (needsResource && !resourceId?.trim()) {
    return {
      handled: false,
      changed: false,
      code: 'INVALID_ARGS',
      hint: `${typeId} 是资源型应用，launchApp 必须携带 resourceId`,
    };
  }
  if (!WORKSPACE_RESOURCE_TYPE_IDS.has(typeId) && !appRegistry.get(typeId)) {
    return {
      handled: false,
      changed: false,
      code: 'APP_NOT_REGISTERED',
      hint: `应用未注册: ${typeId}；从 observe desktop 的 launchableTypeIds 中选择`,
    };
  }
  const before = useWindowStore.getState();
  const beforeIds = new Set(Object.keys(before.windows));
  const prevFocusedId = focusedTopWindowId();
  const windowId = workbenchBus.launch({
    typeId,
    instanceKey: resourceId?.trim() || undefined,
    reason: 'api',
  });
  if (!windowId) {
    return {
      handled: false,
      changed: false,
      code: 'DISABLED',
      hint: '学习桌面未启用，launchApp 无法开窗',
    };
  }
  const after = useWindowStore.getState();
  if (!after.windows[windowId]) {
    return actionNoop(`launchApp 已派发但窗口 ${windowId} 未出现在桌面上`);
  }
  // ACR 4.0（A8 集成核对，对齐 stageManager handleOpenApp 的 background 焦点策略）：
  // workbenchBus.launch 会 focus 新窗；background 档下把焦点还给原窗
  // （新窗保留在桌面，不 minimize），避免 agent 后台开窗抢用户焦点。
  if (
    getAgentControlMode() === 'background'
    && prevFocusedId
    && prevFocusedId !== windowId
    && after.windows[prevFocusedId]
  ) {
    useWindowStore.getState().focusWindow(prevFocusedId);
  }
  const created = !beforeIds.has(windowId);
  if (!created && prevFocusedId === windowId) {
    return {
      handled: false,
      changed: false,
      code: 'ACTION_UNAVAILABLE',
      hint: `${typeId} 已打开且处于焦点（windowId=${windowId}），launchApp 为 no-op`,
      details: { windowId, created: false },
    };
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopWindowRef(windowId)],
    details: { windowId, created },
    postconditions: [{ kind: 'ref_exists', ref: desktopWindowRef(windowId) }],
    // 不可撤：关窗必须走既有 workbench_close_window（High 审批），不注册 inverse
  };
}

// ---------------------------------------------------------------------------
// A45-3（docs/dev/acr/ACR-4.5.md）：全局搜索——⌘K 四 provider 的 agent 数据面
//
// globalSearch：复用 search/globalSearchProviders 的 apps/commands/dstu/chat
// 四个 provider，结构化返回结果（read 级，纯数据，不弹 UI）；
// openSearchResult：按 kind+id 打开 globalSearch 命中的目标（medium）。
// provider 是异步可 abort 的：统一 3s 超时，超时/异常结构化失败，不悬挂。
// ---------------------------------------------------------------------------

const SEARCH_KINDS = ['app', 'command', 'dstu', 'chat'] as const;
const GLOBAL_SEARCH_TIMEOUT_MS = 3000;
const GLOBAL_SEARCH_DEFAULT_LIMIT = 8;
const GLOBAL_SEARCH_MAX_LIMIT = 20;
/** dstu 命中节点缓存上限（openSearchResult 需要 node.type 决定开窗应用） */
const AGENT_DSTU_HIT_CACHE_MAX = 200;

function isSearchKind(value: unknown): value is GlobalSearchKind {
  return typeof value === 'string'
    && (SEARCH_KINDS as readonly string[]).includes(value);
}

function desktopSearchResultRef(kind: GlobalSearchKind, id: string): string {
  return stableAgentRef('desktop', 'search', kind, id);
}

/**
 * 命令依赖在 agent 上下文的诚实降级：navigate/toggleTheme/switchLanguage 只
 * 存在于应用壳（React 层），这里显式抛错而不是静默 no-op，让依赖它们的命令
 * **结构化失败**（openSearchResult 转成 COMMAND_NEEDS_SHELL），绝不假装成功。
 */
function agentDepUnavailable(name: string): never {
  throw new Error(
    `AGENT_DEPS_UNAVAILABLE: 命令依赖 ${name} 只存在于应用壳，agent 上下文不可用`,
  );
}

/** 模块级可构造的最小 DependencyResolver（读 getter 全部接真实来源） */
function buildAgentCommandDeps(): DependencyResolver {
  return {
    navigate: () => agentDepUnavailable('navigate'),
    getCurrentView: () => 'workbench',
    getFocusedWorkbenchAppTypeId: () => {
      const state = useWindowStore.getState();
      const focusedId = state.focusStack.at(-1);
      return focusedId ? state.windows[focusedId]?.typeId ?? null : null;
    },
    t: i18next.t.bind(i18next) as DependencyResolver['t'],
    showNotification: showGlobalNotification,
    toggleTheme: () => agentDepUnavailable('toggleTheme'),
    // 与 SkillsManagementPage 相同的模块级暗色态读取方式
    isDarkMode: () =>
      typeof document !== 'undefined'
      && document.documentElement.classList.contains('dark'),
    switchLanguage: () => agentDepUnavailable('switchLanguage'),
    getCurrentLanguage: () => i18next.language,
    // workbench 模式下 ⌘K 面板即 AppsPanel（CommandPaletteProvider 同款改道）
    openCommandPalette: openAppsPanel,
    closeCommandPalette: closeAppsPanel,
  };
}

/** globalSearch 宿主依赖是否满足（不满足时 observe 诚实报 searchAvailable=false） */
function agentSearchHostReady(): boolean {
  try {
    return typeof appRegistry.list === 'function'
      && typeof commandRegistry.search === 'function';
  } catch {
    return false;
  }
}

/** dstu 命中节点缓存：Map 插入序即 LRU 近似，超限剔除最旧条目 */
const agentDstuHitCache = new Map<string, DstuNode>();

function rememberAgentDstuNodes(nodes: DstuNode[]): void {
  for (const node of nodes) {
    agentDstuHitCache.delete(node.id);
    agentDstuHitCache.set(node.id, node);
  }
  while (agentDstuHitCache.size > AGENT_DSTU_HIT_CACHE_MAX) {
    const oldest = agentDstuHitCache.keys().next().value;
    if (oldest === undefined) break;
    agentDstuHitCache.delete(oldest);
  }
}

/**
 * 运行时构造 WorkbenchSearchHost（AppsPanel 用 React hooks 构造同形宿主；
 * agent 侧全部依赖模块级单例：appRegistry / commandRegistry / i18next /
 * windowStore / workbenchBus，因此可在 manifest 内直接构造）。
 * open 回调仅被条目的 open 闭包间接持有（globalSearch 纯数据、不代 open），
 * 但仍全部接到真实打开路径，杜绝任何静默 no-op。
 */
function buildAgentSearchHost(): WorkbenchSearchHost {
  const deps = buildAgentCommandDeps();
  return {
    listLaunchableApps: () =>
      appRegistry.list().filter((def) => def.showInLauncher !== false),
    appName: (app) => i18next.t(app.nameKey, { defaultValue: app.typeId }),
    searchCommands: (query) => {
      try {
        return commandRegistry.search(query, 'workbench', deps);
      } catch {
        return [];
      }
    },
    openApp: (typeId) => {
      workbenchBus.launch({ typeId, reason: 'api' });
    },
    openCommand: (id) => commandRegistry.execute(id, deps),
    openDstu: (node) => {
      openDstuInWorkbench(node);
    },
    openChat: (sessionId) => {
      openChatInWorkbenchForAgent(sessionId);
    },
    untitledSessionTitle: i18next.t('command_palette:untitled', {
      defaultValue: 'Untitled',
    }),
  };
}

function buildAgentSearchProviders(host: WorkbenchSearchHost): GlobalSearchProvider[] {
  return [
    createAppsProvider(host),
    createCommandsProvider(host),
    createDstuProviderWithNodeCapture(host, rememberAgentDstuNodes),
    createChatProvider(host),
  ];
}

/** provider promise 与 abort 信号赛跑：信号触发即拒绝，绝不悬挂 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new Error('GLOBAL_SEARCH_ABORTED'));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', fail);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', fail);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface AgentSearchKindOutcome {
  kind: GlobalSearchKind;
  status: 'ok' | 'skipped' | 'timeout' | 'error';
  items: GlobalSearchItem[];
  hint?: string;
}

async function runAgentSearchProvider(
  provider: GlobalSearchProvider,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<AgentSearchKindOutcome> {
  if (query.length < provider.minChars) {
    return {
      kind: provider.kind,
      status: 'skipped',
      items: [],
      hint: `${provider.kind} 检索需 query ≥ ${provider.minChars} 字符`,
    };
  }
  try {
    const items = await raceAbort(provider.search(query, signal), signal);
    return { kind: provider.kind, status: 'ok', items: items.slice(0, limit) };
  } catch (error) {
    if (signal.aborted) {
      return {
        kind: provider.kind,
        status: 'timeout',
        items: [],
        hint: `${provider.kind} provider 超过 ${GLOBAL_SEARCH_TIMEOUT_MS}ms 未返回，已中止`,
      };
    }
    return {
      kind: provider.kind,
      status: 'error',
      items: [],
      hint: `${provider.kind} provider 异常: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function invalidArgs(hint: string): AgentActionResult {
  return { handled: false, changed: false, code: 'INVALID_ARGS', hint };
}

async function executeGlobalSearch(
  queryArg: unknown,
  kindsArg: unknown,
  limitArg: unknown,
  outerSignal?: AbortSignal,
): Promise<AgentActionResult> {
  const query = typeof queryArg === 'string' ? queryArg.trim() : '';
  if (!query) return invalidArgs('globalSearch 需要非空 query');
  let kinds: GlobalSearchKind[];
  if (kindsArg === undefined) {
    kinds = [...SEARCH_KINDS];
  } else if (
    Array.isArray(kindsArg) && kindsArg.length > 0 && kindsArg.every(isSearchKind)
  ) {
    kinds = [...new Set(kindsArg)];
  } else {
    return invalidArgs(`kinds 必须是 ${SEARCH_KINDS.join('/')} 的非空子集`);
  }
  let limit = GLOBAL_SEARCH_DEFAULT_LIMIT;
  if (limitArg !== undefined) {
    if (typeof limitArg !== 'number' || !Number.isInteger(limitArg) || limitArg < 1) {
      return invalidArgs(`limit 必须是 1-${GLOBAL_SEARCH_MAX_LIMIT} 的整数`);
    }
    limit = Math.min(limitArg, GLOBAL_SEARCH_MAX_LIMIT);
  }
  if (!agentSearchHostReady()) {
    return {
      handled: false,
      changed: false,
      code: 'SEARCH_UNAVAILABLE',
      hint: '全局搜索宿主依赖不可用（appRegistry/commandRegistry 未就绪）',
    };
  }

  const host = buildAgentSearchHost();
  const providers = buildAgentSearchProviders(host)
    .filter((provider) => kinds.includes(provider.kind));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLOBAL_SEARCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  let outcomes: AgentSearchKindOutcome[];
  try {
    outcomes = await Promise.all(
      providers.map((provider) =>
        runAgentSearchProvider(provider, query, limit, controller.signal)),
    );
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }

  const failed = outcomes.filter(
    (outcome) => outcome.status === 'timeout' || outcome.status === 'error',
  );
  const usable = outcomes.filter((outcome) => outcome.status === 'ok');
  if (usable.length === 0 && failed.length > 0) {
    return {
      handled: false,
      changed: false,
      code: failed.every((outcome) => outcome.status === 'timeout')
        ? 'SEARCH_TIMEOUT'
        : 'SEARCH_FAILED',
      hint: failed.map((outcome) => outcome.hint ?? outcome.kind).join('；'),
    };
  }

  const items: AgentJsonValue[] = outcomes.flatMap((outcome) =>
    outcome.items.map((item) => {
      // provider 条目 id 形如 `${kind}:${真实 id}`；对 agent 暴露真实 id
      const prefix = `${outcome.kind}:`;
      const id = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
      return {
        kind: outcome.kind,
        id,
        label: shortLabel(item.title) ?? id,
        sublabel: shortLabel(item.subtitle) ?? null,
        ref: desktopSearchResultRef(outcome.kind, id),
        score: Math.round(item.score * 1000) / 1000,
        // 后续动作提示：条目可用 openSearchResult 打开
        openAction: { name: 'openSearchResult', args: { kind: outcome.kind, id } },
      };
    }));
  const degraded = outcomes
    .filter((outcome) => outcome.status !== 'ok')
    .map((outcome) => ({
      kind: outcome.kind,
      status: outcome.status,
      hint: outcome.hint ?? null,
    }));

  return {
    handled: true,
    // 纯数据面：不改任何 UI/域状态；结果本身即权威回执
    changed: false,
    acknowledged: true,
    details: {
      query,
      kinds: [...kinds],
      limitPerKind: limit,
      totalItems: items.length,
      items,
      degradedKinds: degraded,
    },
    ...(degraded.length
      ? {
          message: `部分 provider 未返回结果：${degraded
            .map((entry) => `${entry.kind}(${entry.status})`)
            .join('、')}；其余结果可用`,
        }
      : {}),
  };
}

async function executeOpenSearchResult(
  kind: GlobalSearchKind,
  id: string,
): Promise<AgentActionResult> {
  switch (kind) {
    // app：走 launchApp 同一条诚实路径（资源型应用缺 resourceId 会结构化失败）
    case 'app':
      return executeLaunchApp(id);
    case 'dstu': {
      const node = agentDstuHitCache.get(id);
      if (!node) {
        return {
          handled: false,
          changed: false,
          code: 'RESULT_EXPIRED',
          hint: `dstu 结果 ${id} 不在最近的 globalSearch 缓存中；`
            + '请先执行 globalSearch（kinds 含 dstu）再打开',
        };
      }
      // 与 openDstuInWorkbench 相同的 typeId 映射；开窗复用 launchApp 诚实回执
      const typeId = isNotesWorkspaceResourceType(node.type)
        ? node.type
        : resourceTypeToAppTypeId(node.type);
      if (!typeId) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `资源类型 ${node.type} 无法在学习桌面开窗`,
        };
      }
      const result = executeLaunchApp(typeId, node.id);
      if (!result.handled) return result;
      return {
        ...result,
        details: {
          ...(result.details ?? {}),
          searchResult: { kind, id, label: shortLabel(node.name) ?? id },
        },
      };
    }
    case 'chat': {
      const windowId = openChatInWorkbenchForAgent(id);
      if (!windowId) {
        return {
          handled: false,
          changed: false,
          code: 'DISABLED',
          hint: '学习桌面未启用，无法打开聊天会话窗',
        };
      }
      if (!useWindowStore.getState().windows[windowId]) {
        return actionNoop(
          `openSearchResult 已派发聊天开窗但窗口 ${windowId} 未出现在桌面上`,
        );
      }
      return {
        handled: true,
        changed: true,
        acknowledged: true,
        entityRefs: [desktopWindowRef(windowId)],
        details: { windowId, sessionId: id },
        postconditions: [{ kind: 'ref_exists', ref: desktopWindowRef(windowId) }],
        message: '聊天窗已确认存在；会话切换经 navigate-to-session 事件派发'
          + '（含冷启动重发），未逐条确认最终会话定位',
        // 开窗不可撤：关窗必须走 workbench_close_window High 审批，不注册 inverse
      };
    }
    case 'command': {
      const command = commandRegistry.getById(id);
      if (!command) {
        return {
          handled: false,
          changed: false,
          code: 'COMMAND_NOT_FOUND',
          hint: `命令不存在: ${id}；请用 globalSearch（kinds 含 command）获取有效命令 id`,
        };
      }
      if (command.visibleInViews?.length && !command.visibleInViews.includes('workbench')) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `命令 ${id} 不在学习桌面（workbench）视图可用`,
        };
      }
      // 危险/需确认命令不代执行（registry 的确认对话框尚未实现，代执行会绕过确认）
      if (command.dangerous || command.requireConfirm) {
        return {
          handled: false,
          changed: false,
          code: 'CONFIRM_REQUIRED',
          hint: `命令 ${id} 标记为危险/需确认，agent 不代执行；请用户在 ⌘K 面板自行执行`,
        };
      }
      const deps = buildAgentCommandDeps();
      let enabledNow = true;
      try {
        enabledNow = command.isEnabled ? command.isEnabled(deps) : true;
      } catch {
        enabledNow = false;
      }
      if (!enabledNow) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `命令 ${id} 当前不可用（isEnabled=false 或其判定依赖应用壳）`,
        };
      }
      try {
        await commandRegistry.execute(id, deps);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        if (messageText.includes('AGENT_DEPS_UNAVAILABLE')) {
          return {
            handled: false,
            changed: false,
            code: 'COMMAND_NEEDS_SHELL',
            hint: `命令 ${id} 依赖应用壳（导航/主题/语言切换），agent 上下文无法执行；`
              + '请用户在 ⌘K 面板执行',
          };
        }
        return {
          handled: false,
          changed: false,
          code: 'COMMAND_FAILED',
          hint: `命令执行失败: ${messageText}`,
        };
      }
      return {
        handled: true,
        changed: true,
        // 命令副作用没有权威回执，如实不标 acknowledged
        acknowledged: false,
        details: { commandId: id, label: shortLabel(command.name) ?? id },
        message: `命令「${command.name}」已执行；副作用无权威回执，如需确认请 observe 相关目标`,
        // 面板命令无统一逆操作，不注册 inverse
      };
    }
    default:
      return invalidArgs(`kind 必须是 ${SEARCH_KINDS.join('/')} 之一`);
  }
}

// ---------------------------------------------------------------------------
// A45-4（docs/dev/acr/ACR-4.5.md）：Dock 固定区编排 — pinApp / unpinApp / reorderDock
//
// 全部走 DockPinnedStore 真实函数（toggleDockPinned / reorderDockPinned），
// 持久化经既有 subscribeDockPinned → 桌面快照路径，不自建存储。
// undo 对齐 tileWindows 的「快照」手法：执行前取整个固定区数组快照，
// inverse 用本 manifest 已声明能力组合精确恢复快照（expect 校验 state.dockPinned）。
// ---------------------------------------------------------------------------

/** Dock 快照恢复 undo 的统一 label（跟随本文件 undo label 硬编码中文的既有惯例） */
const DOCK_UNDO_LABEL = '恢复 Dock 固定区';

function dockPinnedEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 固定区整体状态断言（postcondition / inverse expect 共用） */
function dockStateCondition(expected: readonly string[]): AgentObservationCondition {
  return { kind: 'state_equals', path: 'dockPinned', value: [...expected] };
}

/**
 * 可钉性判定：appRegistry 已注册且启动器可见（showInLauncher !== false），
 * 与 AppsPanel / launchableAppTypeIds 同一谓词。UI 的 Dock 右键菜单对「运行中」
 * 应用更宽松（可钉 launcher 隐藏的内容应用），agent 侧收敛到可发现集合，
 * 避免钉出无 resourceId 就无法启动的死图标。
 */
function dockPinBlocked(typeId: string): AgentActionResult | null {
  const def = appRegistry.get(typeId);
  if (!def) {
    return {
      handled: false,
      changed: false,
      code: 'APP_NOT_REGISTERED',
      hint: `应用未注册: ${typeId}；从 observe desktop 的 launchableTypeIds 中选择`,
    };
  }
  if (def.showInLauncher === false) {
    return actionNoop(
      `${typeId} 不在启动器可见集合（showInLauncher=false），agent 不代钉入 Dock`,
    );
  }
  return null;
}

function executePinApp(typeId: string): AgentActionResult {
  if (typeId === DESKTOP_TYPE_ID) {
    return actionNoop('desktop 是虚拟目标，不能钉入 Dock');
  }
  // 快照：getDockPinned 返回活引用，必须拷贝后再落 undo
  const snapshot = [...getDockPinned()];
  if (snapshot.includes(typeId)) {
    return actionNoop(`${typeId} 已在 Dock 固定区，pinApp 为 no-op`);
  }
  const blocked = dockPinBlocked(typeId);
  if (blocked) return blocked;
  // 未钉 → toggle 即钉入（追加到固定区末尾），与 DockContextMenu 同一真实路径
  toggleDockPinned(typeId);
  const expected = [...snapshot, typeId];
  if (!dockPinnedEquals(getDockPinned(), expected)) {
    return actionNoop(`pinApp 未达到请求后的固定区状态: ${typeId}`);
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopAppRef(typeId)],
    details: { typeId, index: expected.length - 1, dockPinned: [...expected] },
    postconditions: [dockStateCondition(expected)],
    undo: {
      // pinApp 恒追加末尾：unpinApp 一步即恢复整个快照
      inverse: [{
        name: 'unpinApp',
        args: { typeId },
        expect: [dockStateCondition(snapshot)],
      }],
      label: DOCK_UNDO_LABEL,
    },
  };
}

function executeUnpinApp(typeId: string): AgentActionResult {
  const snapshot = [...getDockPinned()];
  const index = snapshot.indexOf(typeId);
  if (index < 0) {
    return actionNoop(`${typeId} 不在 Dock 固定区，unpinApp 为 no-op`);
  }
  // 对齐 UI 语义：toggleDockPinned 无最小钉数限制，允许清空固定区
  toggleDockPinned(typeId);
  const expected = snapshot.filter((id) => id !== typeId);
  if (!dockPinnedEquals(getDockPinned(), expected)) {
    return actionNoop(`unpinApp 未达到请求后的固定区状态: ${typeId}`);
  }
  const notes: string[] = [];
  if (expected.length === 0) {
    // WorkbenchDesktop 快照恢复：dockPinned 为空时回退 DEFAULT_DOCK_PINNED
    notes.push('Dock 固定区已清空；下次桌面快照恢复会回退为默认固定集合');
  }
  // inverse：pinApp 重新追加到末尾；原位不是末尾时补一步 reorderDock 归位，
  // 两步后恰好恢复整个固定区快照
  const reAppended = [...expected, typeId];
  const inverse: AgentActionCall[] = [{
    name: 'pinApp',
    args: { typeId },
    expect: [dockStateCondition(reAppended)],
  }];
  if (index !== expected.length) {
    inverse.push({
      name: 'reorderDock',
      args: { typeId, toIndex: index },
      expect: [dockStateCondition(snapshot)],
    });
  }
  // launcher 隐藏的固定项（用户经 UI 右键钉入）无法经 pinApp 恢复：诚实不注册 undo
  const restorable = !dockPinBlocked(typeId);
  if (!restorable) {
    notes.push(`${typeId} 不在启动器可见集合，取消固定后无法经 pinApp 撤销恢复`);
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopAppRef(typeId)],
    details: { typeId, removedIndex: index, dockPinned: [...expected] },
    postconditions: [dockStateCondition(expected)],
    ...(notes.length ? { message: notes.join('；') } : {}),
    ...(restorable ? { undo: { inverse, label: DOCK_UNDO_LABEL } } : {}),
  };
}

function executeReorderDock(typeId: string, toIndexArg: unknown): AgentActionResult {
  const snapshot = [...getDockPinned()];
  const fromIndex = snapshot.indexOf(typeId);
  if (fromIndex < 0) {
    return actionNoop(`${typeId} 不在 Dock 固定区，无法 reorderDock；先 pinApp`);
  }
  if (
    typeof toIndexArg !== 'number'
    || !Number.isInteger(toIndexArg)
    || toIndexArg < 0
    || toIndexArg >= snapshot.length
  ) {
    return invalidArgs(
      `toIndex 必须是 0-${snapshot.length - 1} 的整数（当前固定区共 ${snapshot.length} 项）`,
    );
  }
  if (toIndexArg === fromIndex) {
    return actionNoop(`${typeId} 已在固定区第 ${fromIndex} 位，reorderDock 为 no-op`);
  }
  reorderDockPinned(fromIndex, toIndexArg);
  const expected = snapshot.slice();
  const moved = expected.splice(fromIndex, 1)[0]!;
  expected.splice(toIndexArg, 0, moved);
  if (!dockPinnedEquals(getDockPinned(), expected)) {
    return actionNoop(`reorderDock 未达到请求后的固定区顺序: ${typeId}`);
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [desktopAppRef(typeId)],
    details: { typeId, fromIndex, toIndex: toIndexArg, dockPinned: [...expected] },
    postconditions: [dockStateCondition(expected)],
    undo: {
      inverse: [{
        name: 'reorderDock',
        args: { typeId, toIndex: fromIndex },
        expect: [dockStateCondition(snapshot)],
      }],
      label: DOCK_UNDO_LABEL,
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const WINDOW_ID_SCHEMA = { type: 'string' as const, minLength: 1 };

export const desktopAgentManifest: AppAgentManifest = {
  version: 1,
  description:
    '学习 OS 桌面本身（无宿主窗口的虚拟单例目标）。观察窗口清单/布局/贴靠/Dock 与演出占用，'
    + '并进行窗口聚焦、最小化/恢复、移动、缩放、贴靠、平铺、应用启动与 Dock 固定区编排'
    + '（pinApp/unpinApp/reorderDock）。'
    + '不提供关窗能力：关闭窗口必须走 workbench_close_window（High 审批）。',
  capabilities: [
    {
      name: 'focusWindow',
      description: '聚焦（置顶）指定窗口；最小化窗口会同时恢复。',
      inputSchema: objectSchema({ windowId: WINDOW_ID_SCHEMA }, ['windowId']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-window'], targetIdPath: 'windowId',
    },
    {
      name: 'minimizeWindow',
      description: '最小化指定窗口到 Dock。',
      inputSchema: objectSchema({ windowId: WINDOW_ID_SCHEMA }, ['windowId']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-window'], targetIdPath: 'windowId',
    },
    {
      name: 'restoreWindow',
      description: '恢复被最小化的窗口（不抢焦点；需要置顶请再 focusWindow）。',
      inputSchema: objectSchema({ windowId: WINDOW_ID_SCHEMA }, ['windowId']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-window'], targetIdPath: 'windowId',
    },
    {
      name: 'moveWindow',
      description: '移动浮动窗口到桌面坐标 (x, y)；越界坐标会被钳回可视区。',
      inputSchema: objectSchema({
        windowId: WINDOW_ID_SCHEMA,
        x: { type: 'number' },
        y: { type: 'number' },
      }, ['windowId', 'x', 'y']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-window'], targetIdPath: 'windowId',
    },
    {
      name: 'resizeWindow',
      description: '调整浮动窗口尺寸；尺寸会被钳制到应用 minSize 与桌面大小之间。',
      inputSchema: objectSchema({
        windowId: WINDOW_ID_SCHEMA,
        width: { type: 'number', minimum: 1 },
        height: { type: 'number', minimum: 1 },
      }, ['windowId', 'width', 'height']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-window'], targetIdPath: 'windowId',
    },
    {
      name: 'snapWindow',
      description:
        '把窗口贴靠到半屏/四分屏/最大化，或 zone=floating 恢复浮动（按原始 bounds 还原）。',
      inputSchema: objectSchema({
        windowId: WINDOW_ID_SCHEMA,
        zone: { type: 'string', enum: [...SNAP_ZONES] },
      }, ['windowId', 'zone']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-window'], targetIdPath: 'windowId',
    },
    {
      name: 'tileWindows',
      description:
        '整体平铺桌面窗口（≤4 扇：1 窗最大化 / 2 窗左右分屏 / 3-4 窗四分屏）。'
        + '缺省作用于全部未最小化窗口；可用 windowIds 指定子集。撤销恢复整体布局快照。',
      inputSchema: objectSchema({
        windowIds: {
          type: 'array',
          items: WINDOW_ID_SCHEMA,
          minItems: 1,
          maxItems: MAX_TILED_WINDOWS,
        },
      }),
      risk: 'medium', mutates: true, reversible: true, idempotent: false,
    },
    {
      name: 'launchApp',
      description:
        '启动应用（走既有 workbenchBus.launch 路径，带正常入场动画）。'
        + '资源型应用（note/mindmap/textbook/exam/translation/essay/image/file）必须携带 resourceId。'
        + '不可撤销：关闭窗口需走 workbench_close_window High 审批。',
      inputSchema: objectSchema({
        typeId: { type: 'string', minLength: 1 },
        resourceId: { type: 'string', minLength: 1 },
      }, ['typeId']),
      risk: 'medium', mutates: true, reversible: false, idempotent: false,
      targetKinds: ['desktop-app'], targetOptional: true, targetIdPath: 'typeId',
    },
    // ── A45-3：全局搜索能力段（追加，勿动上方既有能力） ──
    {
      name: 'globalSearch',
      description:
        '用学习 OS 的 ⌘K 全局搜索（app/command/dstu/chat 四个 provider）查找应用、'
        + '命令、学习资源与聊天会话；纯数据返回、不弹 UI、不改任何状态。'
        + '结果条目含 kind+id，可交给 openSearchResult 打开；'
        + 'dstu/chat 内容检索需 query ≥ 2 字符，provider 超过 3s 未返回会结构化超时。',
      inputSchema: objectSchema({
        query: { type: 'string', minLength: 1, maxLength: 500 },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...SEARCH_KINDS] },
          minItems: 1,
          maxItems: SEARCH_KINDS.length,
        },
        limit: { type: 'integer', minimum: 1, maximum: GLOBAL_SEARCH_MAX_LIMIT },
      }, ['query']),
      risk: 'read', mutates: false, reversible: false, idempotent: true,
    },
    {
      name: 'openSearchResult',
      description:
        '打开 globalSearch 返回的条目：app→启动应用、dstu→打开学习资源窗、'
        + 'chat→聚焦会话窗、command→执行命令面板命令（有副作用；依赖应用壳的'
        + '导航/主题/语言类命令与危险/需确认命令会结构化失败，不代执行）。'
        + 'dstu 条目必须来自最近一次 globalSearch。开窗不可撤销：'
        + '关闭窗口需走 workbench_close_window High 审批。',
      inputSchema: objectSchema({
        kind: { type: 'string', enum: [...SEARCH_KINDS] },
        id: { type: 'string', minLength: 1 },
      }, ['kind', 'id']),
      risk: 'medium', mutates: true, reversible: false, idempotent: false,
    },
    // ── A45-4：Dock 固定区编排能力段（追加，勿动上方既有能力） ──
    {
      name: 'pinApp',
      description:
        '把应用钉入 Dock 固定区（追加到末尾）。typeId 必须是已注册且启动器可见的应用'
        + '（observe desktop 的 launchableTypeIds）；已固定则为 no-op。'
        + '撤销恢复整个固定区快照。',
      inputSchema: objectSchema({ typeId: { type: 'string', minLength: 1 } }, ['typeId']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-app'], targetOptional: true, targetIdPath: 'typeId',
    },
    {
      name: 'unpinApp',
      description:
        '把应用从 Dock 固定区移除（运行中的窗口不受影响）。未固定则为 no-op；'
        + '允许清空固定区（清空后下次桌面快照恢复会回退默认固定集合）。'
        + '撤销恢复整个固定区快照。',
      inputSchema: objectSchema({ typeId: { type: 'string', minLength: 1 } }, ['typeId']),
      risk: 'medium', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-app'], targetOptional: true, targetIdPath: 'typeId',
    },
    {
      name: 'reorderDock',
      description:
        '调整 Dock 固定区顺序：把已固定的应用移动到 toIndex（0 起，必须小于固定项数，'
        + '当前固定区见 observe desktop 的 state.dockPinned）。已在目标位则为 no-op。'
        + '撤销恢复整个固定区快照。',
      inputSchema: objectSchema({
        typeId: { type: 'string', minLength: 1 },
        toIndex: { type: 'integer', minimum: 0 },
      }, ['typeId', 'toIndex']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['desktop-app'], targetOptional: true, targetIdPath: 'typeId',
    },
  ],
  observe() {
    const state = useWindowStore.getState();
    const focusedId = focusedTopWindowId();
    const sorted = getSortedWindows(state.windows);
    const visibleWindows = sorted.slice(0, MAX_OBSERVED_WINDOWS);
    const pair = getActiveTilingPair(state.windows);
    const dockPinned = getDockPinned();
    const launchable = launchableAppTypeIds();
    const presenceEntries = Object.entries(usePresenceStore.getState().byWindow)
      .map(([windowId, presence]) => ({ windowId, status: presence.status }));

    // A45-4：每个应用当前可用的 Dock 编排动作（已固定 → unpin/reorder，未固定 → pin）
    const appDockActions = (typeId: string): string[] => (
      dockPinned.includes(typeId)
        ? ['unpinApp', ...(dockPinned.length > 1 ? ['reorderDock'] : [])]
        : ['pinApp']
    );

    const windowEntities: AgentEntitySummary[] = visibleWindows.map((win) => ({
      ref: desktopWindowRef(win.id),
      kind: 'desktop-window',
      label: shortLabel(win.title) ?? win.typeId,
      description: win.typeId,
      actions: windowActions(win, focusedId),
      state: windowStateEntry(win, focusedId),
    }));
    const appEntities: AgentEntitySummary[] = launchable.map((typeId) => ({
      ref: desktopAppRef(typeId),
      kind: 'desktop-app',
      label: typeId,
      actions: ['launchApp', ...appDockActions(typeId)],
      state: {
        typeId,
        pinned: dockPinned.includes(typeId),
        runningWindows: sorted.filter((win) => win.typeId === typeId).length,
      },
    }));

    const windowNodes: AgentAffordanceNode[] = visibleWindows.map((win) => ({
      ref: desktopWindowRef(win.id),
      kind: 'desktop-window',
      label: shortLabel(win.title) ?? win.typeId,
      actions: windowActions(win, focusedId),
      selected: !win.minimized && win.id === focusedId,
      value: { windowId: win.id, typeId: win.typeId },
    }));
    const appNodes: AgentAffordanceNode[] = launchable.map((typeId) => ({
      ref: desktopAppRef(typeId),
      kind: 'desktop-app',
      label: typeId,
      actions: ['launchApp', ...appDockActions(typeId)],
      value: { typeId },
    }));

    const anyVisible = sorted.some((win) => !win.minimized);
    const availableActions = [
      ...(sorted.some((win) => win.minimized || win.id !== focusedId)
        ? ['focusWindow']
        : []),
      ...(anyVisible ? ['minimizeWindow', 'snapWindow', 'tileWindows'] : []),
      ...(sorted.some((win) => win.minimized) ? ['restoreWindow'] : []),
      ...(sorted.some((win) => !win.minimized && win.displayMode === 'floating')
        ? ['moveWindow', 'resizeWindow']
        : []),
      'launchApp',
      // A45-3：搜索宿主依赖满足时才报可用（诚实能力面）
      ...(agentSearchHostReady() ? ['globalSearch', 'openSearchResult'] : []),
      // A45-4：Dock 编排按固定区状态收敛（全部已固定 → pinApp 诚实不可用）
      ...(launchable.some((typeId) => !dockPinned.includes(typeId)) ? ['pinApp'] : []),
      ...(dockPinned.length > 0 ? ['unpinApp'] : []),
      ...(dockPinned.length > 1 ? ['reorderDock'] : []),
    ];

    const windowStates: Record<string, AgentJsonValue> = {};
    for (const win of visibleWindows) {
      windowStates[win.id] = windowStateEntry(win, focusedId);
    }

    return {
      revision: stableRevision(
        sorted.map((win) => [
          win.id, win.typeId, win.instanceKey, win.title,
          win.frame.x, win.frame.y, win.frame.w, win.frame.h,
          win.displayMode, win.minimized, win.zIndex,
        ]),
        focusedId,
        state.desktopSize,
        state.tilingRatios,
        dockPinned,
        launchable,
      ),
      route: 'desktop',
      busy: false,
      selection: focusedId && state.windows[focusedId] && !state.windows[focusedId].minimized
        ? [desktopWindowRef(focusedId)]
        : [],
      availableActions,
      entities: [...windowEntities, ...appEntities],
      affordances: [
        {
          ref: stableAgentRef('desktop', 'windows'),
          kind: 'desktop-window-list',
          label: '桌面窗口',
          actions: ['tileWindows'],
          children: windowNodes,
        },
        {
          ref: stableAgentRef('desktop', 'dock'),
          kind: 'desktop-dock',
          label: '可启动应用',
          actions: ['launchApp'],
          children: appNodes,
        },
      ],
      state: {
        desktopSize: { w: state.desktopSize.w, h: state.desktopSize.h },
        windowCount: sorted.length,
        windowsTruncated: sorted.length > visibleWindows.length,
        minimizedCount: sorted.filter((win) => win.minimized).length,
        focusedWindowId: focusedId,
        zOrder: [...sorted]
          .sort((a, b) => a.zIndex - b.zIndex)
          .map((win) => win.id),
        windowStates,
        layout: {
          hasMaximized: hasVisibleMaximizedWindow(state.windows),
          activeTilingPair: pair
            ? {
                leftWindowId: pair.left.id,
                rightWindowId: pair.right.id,
                ratio: clampTilingRatio(state.tilingRatios[pair.key] ?? 0.5),
              }
            : null,
        },
        dockPinned: [...dockPinned],
        launchableTypeIds: launchable,
        // A45-3：⌘K 全局搜索数据面是否可用（host 依赖不满足时诚实 false）
        searchAvailable: agentSearchHostReady(),
        stage: {
          presence: presenceEntries,
          slotsInUse: presenceEntries
            .filter((entry) => entry.status === 'acting').length,
        },
      },
    };
  },
  // A45-3：形参由 _ctx 改名 ctx（globalSearch 需要 ctx.signal 级联取消），行为不变
  async execute(ctx, action) {
    const args = actionArgs(action);
    const windowId = typeof args.windowId === 'string' ? args.windowId : '';
    if (windowId) {
      const mismatch = rejectMismatchedTarget(action, desktopWindowRef(windowId));
      if (mismatch) return mismatch;
    }
    switch (action.name) {
      case 'focusWindow':
        return executeFocusWindow(windowId);
      case 'minimizeWindow':
        return executeMinimizeWindow(windowId);
      case 'restoreWindow':
        return executeRestoreWindow(windowId);
      case 'moveWindow':
        return executeMoveWindow(windowId, Number(args.x), Number(args.y));
      case 'resizeWindow':
        return executeResizeWindow(windowId, Number(args.width), Number(args.height));
      case 'snapWindow': {
        const zone = args.zone;
        if (typeof zone !== 'string' || !(zone in ZONE_TO_MODE)) {
          return {
            handled: false,
            changed: false,
            code: 'INVALID_ARGS',
            hint: `zone 必须是 ${SNAP_ZONES.join('/')} 之一`,
          };
        }
        return executeSnapWindow(windowId, zone as DesktopSnapZone);
      }
      case 'tileWindows': {
        const windowIds = Array.isArray(args.windowIds)
          ? args.windowIds.filter((id): id is string => typeof id === 'string')
          : undefined;
        return executeTileWindows(windowIds);
      }
      case 'launchApp': {
        const typeId = typeof args.typeId === 'string' ? args.typeId.trim() : '';
        if (!typeId) {
          return {
            handled: false,
            changed: false,
            code: 'INVALID_ARGS',
            hint: 'launchApp 缺少 typeId',
          };
        }
        const mismatch = rejectMismatchedTarget(action, desktopAppRef(typeId));
        if (mismatch) return mismatch;
        return executeLaunchApp(
          typeId,
          typeof args.resourceId === 'string' ? args.resourceId : undefined,
        );
      }
      // ── A45-3：全局搜索能力段 ──
      case 'globalSearch':
        return executeGlobalSearch(args.query, args.kinds, args.limit, ctx.signal);
      case 'openSearchResult': {
        if (!isSearchKind(args.kind)) {
          return invalidArgs(`kind 必须是 ${SEARCH_KINDS.join('/')} 之一`);
        }
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return invalidArgs('openSearchResult 缺少 id');
        const mismatch = rejectMismatchedTarget(
          action,
          desktopSearchResultRef(args.kind, id),
        );
        if (mismatch) return mismatch;
        return executeOpenSearchResult(args.kind, id);
      }
      // ── A45-4：Dock 固定区编排能力段 ──
      case 'pinApp':
      case 'unpinApp':
      case 'reorderDock': {
        const typeId = typeof args.typeId === 'string' ? args.typeId.trim() : '';
        if (!typeId) return invalidArgs(`${action.name} 缺少 typeId`);
        const mismatch = rejectMismatchedTarget(action, desktopAppRef(typeId));
        if (mismatch) return mismatch;
        if (action.name === 'pinApp') return executePinApp(typeId);
        if (action.name === 'unpinApp') return executeUnpinApp(typeId);
        return executeReorderDock(typeId, args.toIndex);
      }
      default:
        return {
          handled: false,
          code: 'CAPABILITY_NOT_FOUND',
          hint: `desktop 未声明动作 ${action.name}`,
        };
    }
  },
};
