/**
 * Workbench 快捷键注册表（主责 P6 → O12 深化）
 *
 * - 静态定义设计文档 §6.4 全部快捷键 + O12 补齐的 WM 级快捷键
 *   （四分屏平铺、贴边移动、同应用循环、最小化、显示桌面、关闭全部、速查表）；
 * - `listWorkbenchShortcuts()` 供设置页（P10）展示快捷键清单；
 *   `listWorkbenchShortcutGroups()` 供速查表（ShortcutCheatsheet）分组展示；
 * - `matchWorkbenchShortcut()` / `isEditableTarget()` / `isShortcutGuardedEvent()`
 *   供 useWorkbenchShortcuts 消费（后者覆盖 IME 组合中与 shadow DOM 焦点）；
 * - `useWorkbenchOverlay` 保存键盘会话状态（俯瞰开关、Ctrl+Tab 切换器会话、
 *   速查表开关），由 ExposeOverlay / WindowSwitcher / ShortcutCheatsheet /
 *   useWorkbenchShortcuts 共同消费。O8（WindowSwitcher）依赖的既有字段与
 *   方法签名全部保持不变，O12 仅做【追加】。
 *
 * 快捷键仅在 workbench 激活且焦点不在文本输入（input/textarea/contenteditable/
 * role=textbox，含 shadow DOM 内）且不处于 IME 组合会话时生效。
 */
import { create } from 'zustand';
import type { Frame, Size } from './types';

// ============================================================================
// 定义
// ============================================================================

export type WorkbenchShortcutId =
  | 'tile-left'
  | 'tile-right'
  | 'maximize'
  | 'restore-or-minimize'
  | 'center'
  | 'cycle-next'
  | 'cycle-prev'
  | 'expose'
  | 'close-window'
  // ---- O12 追加 ----
  | 'tile-tl'
  | 'tile-tr'
  | 'tile-bl'
  | 'tile-br'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'cycle-app-next'
  | 'cycle-app-prev'
  | 'minimize'
  | 'show-desktop'
  | 'close-all'
  | 'cheatsheet';

/** 速查表分组（展示顺序即数组顺序） */
export type WorkbenchShortcutGroupId =
  | 'layout'
  | 'movement'
  | 'navigation'
  | 'management'
  | 'help';

export interface WorkbenchShortcutBinding {
  /**
   * 布局无关键（方向键 / Tab / "?"）用 KeyboardEvent.key 匹配；
   * 字母键用 KeyboardEvent.code（KeyC 等）匹配，避免 Alt 组合在部分键盘布局下
   * 产生替代字符导致 e.key 不可靠。
   */
  key?: string;
  code?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * 匹配时忽略 shift 状态（用于 "?" 这类本身可能由 Shift 产生的字符键，
   * 不同键盘布局下 "?" 未必需要 Shift）。
   */
  shiftAgnostic?: boolean;
}

export interface WorkbenchShortcutDefinition {
  id: WorkbenchShortcutId;
  binding: WorkbenchShortcutBinding;
  /** i18n key（namespace: workbench），文案兜底见 defaultDescription */
  descriptionKey: string;
  /** 中文兜底描述（t(key, default) 形式） */
  defaultDescription: string;
  /** 速查表分组 */
  group: WorkbenchShortcutGroupId;
  /** 可在设置中关闭（当前仅 Ctrl+W） */
  configurable?: boolean;
}

/** 设置页 / 速查表展示用的只读条目 */
export interface WorkbenchShortcutInfo {
  id: WorkbenchShortcutId;
  /** 人类可读键位，如 "Ctrl+Alt+←" */
  keys: string;
  /** 键帽可视化用的分段键位，如 ['Ctrl','Alt','←'] */
  keyParts: string[];
  descriptionKey: string;
  defaultDescription: string;
  group: WorkbenchShortcutGroupId;
  configurable: boolean;
}

export interface WorkbenchShortcutGroupInfo {
  id: WorkbenchShortcutGroupId;
  labelKey: string;
  defaultLabel: string;
  shortcuts: WorkbenchShortcutInfo[];
}

const GROUP_META: Record<WorkbenchShortcutGroupId, { labelKey: string; defaultLabel: string }> = {
  layout: { labelKey: 'workbench:cheatsheet.groups.layout', defaultLabel: '平铺与布局' },
  movement: { labelKey: 'workbench:cheatsheet.groups.movement', defaultLabel: '移动与贴边' },
  navigation: { labelKey: 'workbench:cheatsheet.groups.navigation', defaultLabel: '切换与导航' },
  management: { labelKey: 'workbench:cheatsheet.groups.management', defaultLabel: '窗口管理' },
  help: { labelKey: 'workbench:cheatsheet.groups.help', defaultLabel: '帮助' },
};

/** 分组展示顺序 */
export const WORKBENCH_SHORTCUT_GROUP_ORDER: readonly WorkbenchShortcutGroupId[] = [
  'layout',
  'movement',
  'navigation',
  'management',
  'help',
];

export const WORKBENCH_SHORTCUT_DEFINITIONS: readonly WorkbenchShortcutDefinition[] = [
  // ---- §6.4 原始快捷键（顺序与 id 保持稳定，P10 设置页消费） ----
  {
    id: 'tile-left',
    binding: { key: 'ArrowLeft', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.tileLeft',
    defaultDescription: '平铺到左半屏',
    group: 'layout',
  },
  {
    id: 'tile-right',
    binding: { key: 'ArrowRight', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.tileRight',
    defaultDescription: '平铺到右半屏',
    group: 'layout',
  },
  {
    id: 'maximize',
    binding: { key: 'ArrowUp', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.maximize',
    defaultDescription: '最大化（填满桌面）',
    group: 'layout',
  },
  {
    id: 'restore-or-minimize',
    binding: { key: 'ArrowDown', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.restoreOrMinimize',
    defaultDescription: '恢复原尺寸 / 最小化',
    group: 'layout',
  },
  {
    id: 'center',
    binding: { code: 'KeyC', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.center',
    defaultDescription: '居中窗口',
    group: 'layout',
  },
  {
    id: 'cycle-next',
    binding: { key: 'Tab', ctrl: true, alt: false, shift: false },
    descriptionKey: 'workbench:shortcuts.cycleNext',
    defaultDescription: '循环切换到下一个窗口',
    group: 'navigation',
  },
  {
    id: 'cycle-prev',
    binding: { key: 'Tab', ctrl: true, alt: false, shift: true },
    descriptionKey: 'workbench:shortcuts.cyclePrev',
    defaultDescription: '循环切换到上一个窗口',
    group: 'navigation',
  },
  {
    id: 'expose',
    binding: { code: 'KeyE', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.expose',
    defaultDescription: '窗口俯瞰',
    group: 'navigation',
  },
  {
    id: 'close-window',
    binding: { code: 'KeyW', ctrl: true, alt: false, shift: false },
    descriptionKey: 'workbench:shortcuts.closeWindow',
    defaultDescription: '关闭焦点窗口',
    group: 'management',
    configurable: true,
  },
  // ---- O12 补齐：四分屏平铺（对标 Rectangle 的 Ctrl+Opt+U/I/J/K） ----
  {
    id: 'tile-tl',
    binding: { code: 'KeyU', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.tileTopLeft',
    defaultDescription: '平铺到左上角',
    group: 'layout',
  },
  {
    id: 'tile-tr',
    binding: { code: 'KeyI', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.tileTopRight',
    defaultDescription: '平铺到右上角',
    group: 'layout',
  },
  {
    id: 'tile-bl',
    binding: { code: 'KeyJ', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.tileBottomLeft',
    defaultDescription: '平铺到左下角',
    group: 'layout',
  },
  {
    id: 'tile-br',
    binding: { code: 'KeyK', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.tileBottomRight',
    defaultDescription: '平铺到右下角',
    group: 'layout',
  },
  // ---- O12 补齐：贴边移动（保持尺寸，发送到桌面边缘） ----
  {
    id: 'move-left',
    binding: { key: 'ArrowLeft', ctrl: true, alt: true, shift: true },
    descriptionKey: 'workbench:shortcuts.moveLeft',
    defaultDescription: '贴靠到左边缘（保持尺寸）',
    group: 'movement',
  },
  {
    id: 'move-right',
    binding: { key: 'ArrowRight', ctrl: true, alt: true, shift: true },
    descriptionKey: 'workbench:shortcuts.moveRight',
    defaultDescription: '贴靠到右边缘（保持尺寸）',
    group: 'movement',
  },
  {
    id: 'move-up',
    binding: { key: 'ArrowUp', ctrl: true, alt: true, shift: true },
    descriptionKey: 'workbench:shortcuts.moveUp',
    defaultDescription: '贴靠到上边缘（保持尺寸）',
    group: 'movement',
  },
  {
    id: 'move-down',
    binding: { key: 'ArrowDown', ctrl: true, alt: true, shift: true },
    descriptionKey: 'workbench:shortcuts.moveDown',
    defaultDescription: '贴靠到下边缘（保持尺寸）',
    group: 'movement',
  },
  // ---- O12 补齐：同应用窗口循环（对标 macOS Cmd+`） ----
  {
    id: 'cycle-app-next',
    binding: { code: 'Backquote', ctrl: true, alt: false, shift: false },
    descriptionKey: 'workbench:shortcuts.cycleAppNext',
    defaultDescription: '切换到同应用下一个窗口',
    group: 'navigation',
  },
  {
    id: 'cycle-app-prev',
    binding: { code: 'Backquote', ctrl: true, alt: false, shift: true },
    descriptionKey: 'workbench:shortcuts.cycleAppPrev',
    defaultDescription: '切换到同应用上一个窗口',
    group: 'navigation',
  },
  // ---- O12 补齐：最小化 / 显示桌面 / 关闭全部 ----
  {
    id: 'minimize',
    binding: { code: 'KeyM', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.minimize',
    defaultDescription: '最小化焦点窗口',
    group: 'management',
  },
  {
    id: 'show-desktop',
    binding: { code: 'KeyD', ctrl: true, alt: true, shift: false },
    descriptionKey: 'workbench:shortcuts.showDesktop',
    defaultDescription: '显示桌面（最小化全部 / 再按恢复）',
    group: 'navigation',
  },
  {
    id: 'close-all',
    binding: { code: 'KeyW', ctrl: true, alt: true, shift: true },
    descriptionKey: 'workbench:shortcuts.closeAll',
    defaultDescription: '关闭所有窗口',
    group: 'management',
  },
  // ---- O12 补齐：速查表 ----
  {
    id: 'cheatsheet',
    binding: { key: '?', ctrl: false, alt: false, shift: false, shiftAgnostic: true },
    descriptionKey: 'workbench:shortcuts.cheatsheet',
    defaultDescription: '快捷键速查表',
    group: 'help',
  },
];

const KEY_DISPLAY: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

const CODE_DISPLAY: Record<string, string> = {
  Backquote: '`',
  Slash: '/',
};

/** 键帽可视化用：把 binding 拆成分段键位（['Ctrl','Alt','←']） */
export function splitShortcutBinding(binding: WorkbenchShortcutBinding): string[] {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift && !binding.shiftAgnostic) parts.push('Shift');
  if (binding.code) {
    parts.push(CODE_DISPLAY[binding.code] ?? binding.code.replace(/^Key/, '').replace(/^Digit/, ''));
  } else if (binding.key) {
    parts.push(KEY_DISPLAY[binding.key] ?? binding.key);
  }
  return parts;
}

export function formatShortcutBinding(binding: WorkbenchShortcutBinding): string {
  return splitShortcutBinding(binding).join('+');
}

function toInfo(def: WorkbenchShortcutDefinition): WorkbenchShortcutInfo {
  return {
    id: def.id,
    keys: formatShortcutBinding(def.binding),
    keyParts: splitShortcutBinding(def.binding),
    descriptionKey: def.descriptionKey,
    defaultDescription: def.defaultDescription,
    group: def.group,
    configurable: def.configurable ?? false,
  };
}

/** 快捷键清单 API（P10 设置页消费） */
export function listWorkbenchShortcuts(): WorkbenchShortcutInfo[] {
  return WORKBENCH_SHORTCUT_DEFINITIONS.map(toInfo);
}

/** 分组清单 API（ShortcutCheatsheet 消费；空组自动剔除） */
export function listWorkbenchShortcutGroups(): WorkbenchShortcutGroupInfo[] {
  const infos = listWorkbenchShortcuts();
  return WORKBENCH_SHORTCUT_GROUP_ORDER.map((groupId) => ({
    id: groupId,
    labelKey: GROUP_META[groupId].labelKey,
    defaultLabel: GROUP_META[groupId].defaultLabel,
    shortcuts: infos.filter((s) => s.group === groupId),
  })).filter((g) => g.shortcuts.length > 0);
}

// ============================================================================
// 匹配与输入框 guard
// ============================================================================

/** 精确修饰键匹配（metaKey 参与的组合一律不视为 workbench 快捷键） */
export function matchWorkbenchShortcut(e: KeyboardEvent): WorkbenchShortcutDefinition | null {
  if (e.metaKey) return null;
  for (const def of WORKBENCH_SHORTCUT_DEFINITIONS) {
    const b = def.binding;
    if (b.ctrl !== e.ctrlKey || b.alt !== e.altKey) continue;
    if (!b.shiftAgnostic && b.shift !== e.shiftKey) continue;
    if (b.code) {
      if (e.code === b.code) return def;
    } else if (b.key) {
      if (e.key === b.key) return def;
      // `?` 类 shiftAgnostic 绑定的布局兜底：部分键盘布局未按 Shift 时
      // e.key 为 '/'（物理 Slash 键），按 code 也算命中，速查表不失联
      if (b.shiftAgnostic && b.key === '?' && e.code === 'Slash') return def;
    }
  }
  return null;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const EDITABLE_CLOSEST_SELECTOR = [
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(', ');

/**
 * 焦点在 input / textarea / select / contenteditable / role="textbox" 时
 * 所有快捷键不触发。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (EDITABLE_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  if (el.getAttribute?.('role') === 'textbox') return true;
  // jsdom 未实现 isContentEditable，closest 兜底（同时覆盖继承场景）
  if (typeof el.closest === 'function' && el.closest(EDITABLE_CLOSEST_SELECTOR)) {
    return true;
  }
  return false;
}

/**
 * shadow DOM 感知的事件真实目标：open shadow root 内的可编辑元素会被
 * 事件重定向（retarget）成宿主元素，composedPath()[0] 才是真实焦点。
 */
export function resolveShortcutEventTarget(e: Event): EventTarget | null {
  if (typeof e.composedPath === 'function') {
    try {
      const path = e.composedPath();
      if (path.length > 0) return path[0];
    } catch {
      /* 某些合成事件不支持 composedPath，回退 e.target */
    }
  }
  return e.target;
}

/**
 * 键盘事件级 guard（useWorkbenchShortcuts 消费）：
 * - IME 组合会话中（isComposing / keyCode 229）一律不触发快捷键；
 * - 真实焦点（含 shadow DOM 内）在可编辑区时不触发。
 */
export function isShortcutGuardedEvent(e: KeyboardEvent): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  return isEditableTarget(resolveShortcutEventTarget(e));
}

// ============================================================================
// 几何辅助
// ============================================================================

/** Ctrl+Alt+C 居中：保持尺寸（超出桌面时收缩），居中摆放 */
export function computeCenteredFrame(frame: Frame, desktop: Size): Frame {
  const w = Math.min(frame.w, desktop.w);
  const h = Math.min(frame.h, desktop.h);
  return {
    x: Math.round((desktop.w - w) / 2),
    y: Math.round((desktop.h - h) / 2),
    w,
    h,
  };
}

export type EdgeDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Ctrl+Alt+Shift+方向：保持尺寸（超出桌面时收缩），贴靠到对应桌面边缘；
 * 非移动轴钳回可视区，保证整窗可见。
 */
export function computeEdgeMovedFrame(frame: Frame, desktop: Size, edge: EdgeDirection): Frame {
  const w = Math.min(frame.w, desktop.w);
  const h = Math.min(frame.h, desktop.h);
  const clampX = (x: number) => Math.round(Math.min(Math.max(x, 0), desktop.w - w));
  const clampY = (y: number) => Math.round(Math.min(Math.max(y, 0), desktop.h - h));
  switch (edge) {
    case 'left':
      return { x: 0, y: clampY(frame.y), w, h };
    case 'right':
      return { x: Math.round(desktop.w - w), y: clampY(frame.y), w, h };
    case 'up':
      return { x: clampX(frame.x), y: 0, w, h };
    case 'down':
      return { x: clampX(frame.x), y: Math.round(desktop.h - h), w, h };
  }
}

// ============================================================================
// 快捷键触发的视觉反馈事件（O12）
// ============================================================================

/**
 * 快捷键动作反馈事件（window 上派发）。
 * ShortcutCheatsheet 用它做行高亮；其他代理（如 O15 HUD）可自愿订阅，
 * 不订阅无任何影响 —— 非侵入式协作接口。
 */
export const WORKBENCH_SHORTCUT_FEEDBACK_EVENT = 'workbench:shortcut-feedback';

export interface WorkbenchShortcutFeedbackDetail {
  shortcutId: WorkbenchShortcutId;
  windowId?: string;
  /** 动作目标区域（桌面坐标系），平铺/贴边/居中类动作携带 */
  frame?: Frame;
}

// ============================================================================
// 键盘会话状态（俯瞰 / 切换器 / 速查表）
// ============================================================================

export interface WorkbenchOverlayState {
  /** 俯瞰（Exposé）是否激活 */
  exposeOpen: boolean;
  /** Ctrl+Tab 切换器会话是否激活（按住 Ctrl 期间） */
  switcherOpen: boolean;
  /** 会话内候选窗口 id（lastFocusedAt 降序，最近使用在前），会话期间冻结不重排 */
  switcherIds: string[];
  switcherIndex: number;
  /** 最近一次会话的退出方式（展示层播 commit/cancel 退出动画的显式依据） */
  switcherExitReason: 'commit' | 'cancel' | null;
  /** 快捷键速查表是否显示（O12） */
  cheatsheetOpen: boolean;
  /** true = ? 键切换的常驻显示；false = 长按 Ctrl+Alt 的临时显示（松开即收） */
  cheatsheetSticky: boolean;

  openExpose: () => void;
  closeExpose: () => void;
  toggleExpose: () => void;
  openSwitcher: (ids: string[], index: number) => void;
  /** 循环步进（正=下一个，负=上一个），自动回绕 */
  stepSwitcher: (delta: number) => void;
  setSwitcherIndex: (index: number) => void;
  /** reason 缺省为 cancel；commit = 松开修饰键/点选确认（展示层据此播提交脉冲） */
  closeSwitcher: (reason?: 'commit' | 'cancel') => void;
  openCheatsheet: (options?: { sticky?: boolean }) => void;
  closeCheatsheet: () => void;
  toggleCheatsheet: () => void;
}

export const useWorkbenchOverlay = create<WorkbenchOverlayState>((set, get) => ({
  exposeOpen: false,
  switcherOpen: false,
  switcherIds: [],
  switcherIndex: 0,
  switcherExitReason: null,
  cheatsheetOpen: false,
  cheatsheetSticky: false,

  openExpose: () => set({ exposeOpen: true, switcherOpen: false, cheatsheetOpen: false }),
  closeExpose: () => set({ exposeOpen: false }),
  toggleExpose: () =>
    set((s) => ({
      exposeOpen: !s.exposeOpen,
      switcherOpen: false,
      cheatsheetOpen: s.exposeOpen ? s.cheatsheetOpen : false,
    })),

  openSwitcher: (ids, index) => {
    if (ids.length === 0) return;
    const clamped = ((index % ids.length) + ids.length) % ids.length;
    set({
      switcherOpen: true,
      switcherIds: ids,
      switcherIndex: clamped,
      switcherExitReason: null,
      exposeOpen: false,
      cheatsheetOpen: false,
    });
  },

  stepSwitcher: (delta) => {
    const { switcherOpen, switcherIds, switcherIndex } = get();
    if (!switcherOpen || switcherIds.length === 0) return;
    const n = switcherIds.length;
    set({ switcherIndex: (((switcherIndex + delta) % n) + n) % n });
  },

  setSwitcherIndex: (index) => {
    const { switcherOpen, switcherIds } = get();
    if (!switcherOpen || index < 0 || index >= switcherIds.length) return;
    set({ switcherIndex: index });
  },

  closeSwitcher: (reason = 'cancel') =>
    set((s) => ({
      switcherOpen: false,
      switcherIds: [],
      switcherIndex: 0,
      switcherExitReason: s.switcherOpen ? reason : s.switcherExitReason,
    })),

  openCheatsheet: (options) =>
    set({
      cheatsheetOpen: true,
      cheatsheetSticky: options?.sticky ?? true,
      exposeOpen: false,
      switcherOpen: false,
      switcherIds: [],
      switcherIndex: 0,
    }),

  closeCheatsheet: () => set({ cheatsheetOpen: false, cheatsheetSticky: false }),

  toggleCheatsheet: () => {
    const { cheatsheetOpen } = get();
    if (cheatsheetOpen) {
      get().closeCheatsheet();
    } else {
      get().openCheatsheet({ sticky: true });
    }
  },
}));
