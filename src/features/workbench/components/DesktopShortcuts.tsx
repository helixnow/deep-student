/**
 * DesktopShortcuts — 学习桌面快捷方式图标层
 * ---------------------------------------------------------------------------
 * 与资源库「桌面」视图共用 learning-hub 的 desktopStore（zustand persist），
 * 两端的快捷方式数据实时同步：
 * - 资源库右键「添加到桌面」→ 图标同时出现在学习桌面与资源库桌面视图；
 * - 从 files 窗口把资源/文件夹拖到桌面空白处 → 创建桌面快捷方式
 *   （通过 desktopDragBridge 的 drop handler 认领，替代原「落点开窗」兜底）；
 * - 双击图标打开：资源 → 内容窗口；文件夹/快捷入口 → 资源库窗口定位；
 *   app 快捷方式 → 直接打开对应学习应用。
 *
 * 图标层指针穿透（CSS pointer-events: none，图标恢复 auto），不破坏桌面
 * 空白区手势的 e.target === e.currentTarget 判定。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useLongPress, type LongPressPoint } from '@/hooks/mobile/useLongPress';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { DstuNodeType } from '@/dstu/types';
import {
  resolveShortcutName,
  useDesktopShortcutName,
  useDesktopStore,
  type AppType,
  type DesktopShortcut,
} from '@/features/learning-hub/stores/desktopStore';
import type { QuickAccessType } from '@/features/learning-hub/stores/finderStore';
import { getShortcutIcon } from '@/features/learning-hub/components/finder/shortcutIcons';
import { workbenchBus } from '../core/workbenchBus';
import {
  isEditableTarget,
  resolveShortcutEventTarget,
  useWorkbenchOverlay,
} from '../core/shortcuts';
import { useLiquidGlassLens, WallpaperReplica } from '../core/liquidGlassLens';
import {
  launchResourceFromDragData,
  registerDesktopResourceDropHandler,
} from '../apps/files/desktopDragBridge';
import { requestQuickLook } from '../apps/preview/quickLook';
import { inlineAppMenuSubmenus } from '@/ui-plugins/official/menu/appMenu';
import { officialDesktopShortcutMenuEntries } from '@/ui-plugins/official/menu/desktopShortcutMenu';
import { useAppMenuRows } from './appMenuHost';
import { DeskMenuRow } from './DeskMenuItems';
import './DesktopShortcuts.css';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';

// ---------------------------------------------------------------------------
// 打开快捷方式（与资源库桌面 handleShortcutClick 同语义，落点换成 workbench 窗口）
// ---------------------------------------------------------------------------

const APP_TYPE_TO_QUICK_ACCESS: Record<AppType, QuickAccessType> = {
  note: 'notes',
  exam: 'exams',
  essay: 'essays',
  translation: 'translations',
  mindmap: 'mindmaps',
  textbook: 'textbooks',
};

const APP_TYPE_TO_WORKBENCH_TYPE_ID: Record<Exclude<AppType, 'textbook'>, string> = {
  note: 'notes',
  exam: 'exam',
  essay: 'essay',
  translation: 'translation',
  // 思维导图与笔记共用统一知识工作区应用。
  mindmap: 'notes',
};

/** 可作为桌面快捷方式的资源类型（拖放认领时校验） */
const SHORTCUTABLE_RESOURCE_TYPES = new Set([
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
]);

function openFilesWithActivation(action: string, payload: unknown): void {
  void workbenchBus.activate({
    typeId: 'files',
    instanceKey: '',
    action,
    payload,
    fallbackLaunch: { typeId: 'files', reason: 'shortcut' },
  });
}

/** 打开一个桌面快捷方式（供图标双击 / 菜单「打开」共用） */
export function openDesktopShortcut(
  shortcut: DesktopShortcut,
  t: (key: string) => string,
): void {
  switch (shortcut.type) {
    case 'resource': {
      const { resourceId, resourceType } = shortcut.target;
      if (!resourceId || !resourceType) return;
      const opened = launchResourceFromDragData({
        resourceId,
        resourceType,
        title: resolveShortcutName(shortcut),
      });
      if (opened === null) {
        showGlobalNotification('error', t('desktop.resourceNotFound'));
      }
      break;
    }
    case 'folder':
      if (shortcut.target.folderId) {
        openFilesWithActivation('openFolder', { folderId: shortcut.target.folderId });
      }
      break;
    case 'quickAccess':
      if (shortcut.target.quickAccessType) {
        openFilesWithActivation('openQuickAccess', { type: shortcut.target.quickAccessType });
      }
      break;
    case 'app': {
      const appType = shortcut.target.appType;
      if (!appType) return;
      if (appType === 'textbook') {
        openFilesWithActivation('openQuickAccess', { type: APP_TYPE_TO_QUICK_ACCESS[appType] });
      } else {
        workbenchBus.launch({
          typeId: APP_TYPE_TO_WORKBENCH_TYPE_ID[appType],
          reason: 'shortcut',
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// 框选 / 拖拽排序 / 空格 Quick Look 纯函数（导出供单测）
// ---------------------------------------------------------------------------

export interface DesktopRectBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ReorderSlot {
  id: string;
  index: number;
  rect: DesktopRectBox;
}

const MARQUEE_DRAG_THRESHOLD = 4;
const REORDER_DRAG_THRESHOLD = 6;
const REORDER_SNAP_MAX_DIST = 96;

export function rectsIntersect(a: DesktopRectBox, b: DesktopRectBox): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

export function resolveQuickLookResourceId(
  shortcuts: readonly DesktopShortcut[],
  selectedIds: ReadonlySet<string>,
  primaryId: string | null,
): string | null {
  if (selectedIds.size === 0) return null;
  if (primaryId && selectedIds.has(primaryId)) {
    const primary = shortcuts.find((s) => s.id === primaryId);
    if (primary?.type === 'resource' && primary.target.resourceId) {
      return primary.target.resourceId;
    }
  }
  for (const shortcut of shortcuts) {
    if (selectedIds.has(shortcut.id) && shortcut.type === 'resource' && shortcut.target.resourceId) {
      return shortcut.target.resourceId;
    }
  }
  return null;
}

export function findReorderTargetIndex(
  pointer: { x: number; y: number },
  slots: readonly ReorderSlot[],
): number | null {
  for (const slot of slots) {
    if (
      pointer.x >= slot.rect.left
      && pointer.x <= slot.rect.right
      && pointer.y >= slot.rect.top
      && pointer.y <= slot.rect.bottom
    ) {
      return slot.index;
    }
  }
  let bestIndex: number | null = null;
  let bestDist = REORDER_SNAP_MAX_DIST;
  for (const slot of slots) {
    const cx = (slot.rect.left + slot.rect.right) / 2;
    const cy = (slot.rect.top + slot.rect.bottom) / 2;
    const dist = Math.hypot(pointer.x - cx, pointer.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = slot.index;
    }
  }
  return bestIndex;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function isSpaceQuickLookBlockedTarget(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (
    el.closest(
      '[data-wb-window-id], [role="dialog"], [role="menu"], [data-wb-dock], .wb-agenda-widget, .wb-ai-briefing-widget',
    )
  ) {
    return true;
  }
  if (!el.closest('[data-wb-desk-shortcut]') && el.closest('button, a, [role="slider"]')) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

interface ShortcutIconProps {
  shortcut: DesktopShortcut;
  index: number;
  selected: boolean;
  dragging: boolean;
  dropTarget: boolean;
  dragOffset: { dx: number; dy: number } | null;
  menuOpen: boolean;
  editing: boolean;
  onSelect: (e: React.MouseEvent, shortcut: DesktopShortcut) => void;
  onKeyboardFocus: (shortcut: DesktopShortcut) => void;
  onPointerDragStart: (e: React.PointerEvent, shortcut: DesktopShortcut, index: number) => void;
  onOpen: (shortcut: DesktopShortcut) => void;
  onContextMenu: (e: React.MouseEvent, shortcut: DesktopShortcut) => void;
  /** 触屏长按呼出菜单（右键的触屏替代） */
  onLongPressMenu: (point: LongPressPoint, shortcut: DesktopShortcut) => void;
  onRenameCommit: (id: string, name: string) => void;
  onRenameCancel: () => void;
}

const ShortcutIcon: React.FC<ShortcutIconProps> = ({
  shortcut,
  index,
  selected,
  dragging,
  dropTarget,
  dragOffset,
  menuOpen,
  editing,
  onSelect,
  onKeyboardFocus,
  onPointerDragStart,
  onOpen,
  onContextMenu,
  onLongPressMenu,
  onRenameCommit,
  onRenameCancel,
}) => {
  const Icon = getShortcutIcon(shortcut);
  // 预设快捷方式（未改名）跟随当前界面语言，语言切换时实时更新
  const displayName = useDesktopShortcutName(shortcut);
  const [editName, setEditName] = useState(displayName);
  // 触屏无双击语义：单击直接打开
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  // 触屏长按 = 右键菜单（长按触发后抑制本次 click，避免同时打开快捷方式）
  const longPress = useLongPress({
    onLongPress: (point) => onLongPressMenu(point, shortcut),
    disabled: !isTouchPrimary || editing,
    preventContextMenu: false,
  });

  useEffect(() => {
    if (editing) setEditName(displayName);
  }, [editing, displayName]);

  const commitOrCancel = useCallback(() => {
    const next = editName.trim();
    if (next && next !== displayName) onRenameCommit(shortcut.id, next);
    else onRenameCancel();
  }, [editName, shortcut.id, displayName, onRenameCommit, onRenameCancel]);

  const dragStyle = dragging && dragOffset
    ? { transform: `translate3d(${dragOffset.dx}px, ${dragOffset.dy}px, 0) scale(1.04)` }
    : undefined;

  return (
    // div[role=button]（非 <button>）：重命名态内嵌 <input>，button 不允许
    // 交互式子元素，嵌套会破坏输入框的光标定位/文本选择
    <div
      role="button"
      tabIndex={editing ? -1 : 0}
      className="wb-desk-icon"
      style={dragStyle}
      data-selected={selected ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      data-drop-target={dropTarget ? 'true' : undefined}
      data-menu-open={menuOpen ? 'true' : undefined}
      data-wb-desk-shortcut={shortcut.id}
      aria-label={displayName}
      aria-pressed={selected}
      {...longPress.bind}
      onPointerDown={(e) => {
        longPress.bind.onPointerDown(e);
        if (!editing && !isTouchPrimary) {
          onPointerDragStart(e, shortcut, index);
        }
      }}
      onFocus={() => {
        if (!editing) onKeyboardFocus(shortcut);
      }}
      onClick={(e) => {
        if (editing || e.defaultPrevented) return;
        if (isTouchPrimary) {
          onOpen(shortcut);
          return;
        }
        onSelect(e, shortcut);
      }}
      onDoubleClick={editing ? undefined : () => onOpen(shortcut)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen(shortcut);
        }
      }}
      onContextMenu={(e) => onContextMenu(e, shortcut)}
    >
      <span className="wb-desk-icon__art" aria-hidden="true">
        <Icon size={52} />
      </span>
      {editing ? (
        <input
          className="wb-desk-icon__input"
          value={editName}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setEditName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (isComposingKeyEvent(e)) return;
            if (e.key === 'Enter') commitOrCancel();
            else if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={commitOrCancel}
        />
      ) : (
        <span className="wb-desk-icon__label">{displayName}</span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 图标右键菜单（学习桌面玻璃菜单同款外壳；行来自 `app.menu` 的 workbench.desktopShortcut，
// 官方行见 ui-plugins/official/menu/desktopShortcutMenu.tsx）
// ---------------------------------------------------------------------------

interface IconMenuState {
  shortcut: DesktopShortcut;
  x: number;
  y: number;
}

const ICON_MENU_EXIT_MS = 180;

interface IconMenuProps {
  state: IconMenuState;
  closing: boolean;
  onClose: () => void;
  onOpen: (shortcut: DesktopShortcut) => void;
  onRename: (id: string) => void;
  onRemove: (id: string) => void;
}

const IconMenu: React.FC<IconMenuProps> = ({
  state,
  closing,
  onClose,
  onOpen,
  onRename,
  onRemove,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  useLiquidGlassLens(menuRef, true);
  const { shortcut } = state;
  const { resourceId, resourceType, folderId, quickAccessType, appType } = shortcut.target;
  const rows = inlineAppMenuSubmenus(useAppMenuRows('workbench.desktopShortcut', {
    shortcutId: shortcut.id,
    shortcutType: shortcut.type,
    name: resolveShortcutName(shortcut),
    target: { resourceId, resourceType, folderId, quickAccessType, appType },
    closeMenu: onClose,
    open: () => onOpen(shortcut),
    beginRename: () => onRename(shortcut.id),
    remove: () => onRemove(shortcut.id),
  }, officialDesktopShortcutMenuEntries));

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = state.x;
    let y = state.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = state.y - rect.height;
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [state]);

  const [menuArmed, setMenuArmed] = useState(false);

  useEffect(() => {
    if (closing) {
      setMenuArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setMenuArmed(true), 0);
    return () => {
      window.clearTimeout(timer);
      setMenuArmed(false);
    };
  }, [closing]);

  useEventRegistry(
    menuArmed && !closing
      ? [
          {
            target: 'document',
            type: 'mousedown',
            listener: (e) => {
              if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
            },
          },
          {
            target: 'document',
            type: 'keydown',
            listener: (e) => {
              if ((e as KeyboardEvent).key === 'Escape') onClose();
            },
          },
        ]
      : [],
    [closing, menuArmed, onClose],
  );

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="wb-desk-menu wb-glass-lens"
      data-phase={closing ? 'closing' : 'open'}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 'var(--wb-z-desktop-menu, 9650)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <WallpaperReplica hostRef={menuRef} />
      {rows.map((row) => <DeskMenuRow key={row.key} row={row} onDone={onClose} />)}
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// 图标层
// ---------------------------------------------------------------------------

export interface DesktopShortcutsLayerProps {
  /** 桌面工作区根节点（空白区框选手势挂载目标；缺省自动向上找 [data-wb-desktop]） */
  desktopRef?: React.RefObject<HTMLElement | null>;
}

interface MarqueeSession {
  pointerId: number;
  startX: number;
  startY: number;
  hostRect: DOMRect;
  additive: boolean;
  initialSelection: Set<string>;
  active: boolean;
}

interface ReorderSession {
  id: string;
  originIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  slots: ReorderSlot[];
}

interface IconDragVisual {
  id: string;
  dx: number;
  dy: number;
  targetId: string | null;
}

export const DesktopShortcutsLayer: React.FC<DesktopShortcutsLayerProps> = ({ desktopRef }) => {
  const { t } = useTranslation('learningHub');
  const { removeShortcut, renameShortcut, moveShortcut, initDefaultShortcuts } = useDesktopStore(
    useShallow((state) => ({
      removeShortcut: state.removeShortcut,
      renameShortcut: state.renameShortcut,
      moveShortcut: state.moveShortcut,
      initDefaultShortcuts: state.initDefaultShortcuts,
    })),
  );
  const rawShortcuts = useDesktopStore((state) => state.shortcuts);
  const shortcuts = useMemo(
    () => [...rawShortcuts].sort((a, b) => a.position - b.position),
    [rawShortcuts],
  );
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<IconMenuState | null>(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const menuExitTimerRef = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // 多选态（框选 + Cmd/Ctrl 点击）与主选中项（空格 Quick Look 目标）
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<string | null>(null);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const primarySelectedIdRef = useRef(primarySelectedId);
  primarySelectedIdRef.current = primarySelectedId;

  // 框选与图标拖拽排序视觉状态
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [dragVisual, setDragVisual] = useState<IconDragVisual | null>(null);
  const marqueeSessionRef = useRef<MarqueeSession | null>(null);
  const reorderSessionRef = useRef<ReorderSession | null>(null);
  const pointerDownOnIconRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  // 快捷方式集合变化时剔除失效选中 id
  useEffect(() => {
    const validIds = new Set(shortcuts.map((s) => s.id));
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return setsEqual(prev, next) ? prev : next;
    });
    setPrimarySelectedId((prev) => (prev && validIds.has(prev) ? prev : null));
  }, [shortcuts]);

  // 与资源库桌面一致：首次使用初始化默认快捷方式
  useEffect(() => {
    initDefaultShortcuts();
  }, [initDefaultShortcuts]);

  // 拖资源/文件夹到桌面空白处 → 创建快捷方式（认领 drop，替代默认落点开窗）
  useEffect(() => {
    return registerDesktopResourceDropHandler(({ resource }) => {
      const { resourceId, resourceType, title } = resource;
      const store = useDesktopStore.getState();
      if (resourceType === 'folder') {
        const added = store.addFolderShortcut(resourceId, title);
        showGlobalNotification(
          added ? 'success' : 'info',
          t(added ? 'desktop.shortcutAdded' : 'desktop.shortcutExists'),
        );
        return true;
      }
      if (!SHORTCUTABLE_RESOURCE_TYPES.has(resourceType)) return false;
      const added = store.addResourceShortcut(resourceId, title, resourceType as DstuNodeType);
      showGlobalNotification(
        added ? 'success' : 'info',
        t(added ? 'desktop.shortcutAdded' : 'desktop.shortcutExists'),
      );
      return true;
    });
  }, [t]);

  // 卸载兜底：清掉菜单离场计时器
  useEffect(
    () => () => {
      if (menuExitTimerRef.current !== null) {
        window.clearTimeout(menuExitTimerRef.current);
        menuExitTimerRef.current = null;
      }
    },
    [],
  );

  const handleOpen = useCallback(
    (shortcut: DesktopShortcut) => {
      openDesktopShortcut(shortcut, t);
    },
    [t],
  );

  const handleSelectIcon = useCallback((e: React.MouseEvent, shortcut: DesktopShortcut) => {
    pointerDownOnIconRef.current = false;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(shortcut.id)) {
          next.delete(shortcut.id);
          setPrimarySelectedId((cur) => {
            if (cur !== shortcut.id) return cur;
            const remaining = shortcutsRef.current.find((item) => next.has(item.id));
            return remaining?.id ?? null;
          });
        } else {
          next.add(shortcut.id);
          setPrimarySelectedId(shortcut.id);
        }
        return next;
      });
      return;
    }
    setSelectedIds(new Set([shortcut.id]));
    setPrimarySelectedId(shortcut.id);
  }, []);

  const handleKeyboardFocus = useCallback((shortcut: DesktopShortcut) => {
    if (pointerDownOnIconRef.current) return;
    setSelectedIds((prev) => (prev.size === 1 && prev.has(shortcut.id) ? prev : new Set([shortcut.id])));
    setPrimarySelectedId(shortcut.id);
  }, []);

  const handlePointerDragStart = useCallback(
    (e: React.PointerEvent, shortcut: DesktopShortcut, index: number) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      pointerDownOnIconRef.current = true;
      window.setTimeout(() => {
        pointerDownOnIconRef.current = false;
      }, 0);
      if (e.metaKey || e.ctrlKey) return;
      const container = containerRef.current;
      if (!container) return;
      const slots: ReorderSlot[] = [];
      shortcutsRef.current.forEach((item, idx) => {
        const el = container.querySelector<HTMLElement>(`[data-wb-desk-shortcut="${item.id}"]`);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        slots.push({
          id: item.id,
          index: idx,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        });
      });
      reorderSessionRef.current = {
        id: shortcut.id,
        originIndex: index,
        pointerId: e.pointerId ?? 0,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        slots,
      };
    },
    [],
  );

  // 桌面空白区橡胶筋框选 + 图标拖拽重排 + 空格直呼 Quick Look（统一经 useEventRegistry 注册）
  const cancelPointerSessions = useCallback(() => {
    marqueeSessionRef.current = null;
    reorderSessionRef.current = null;
    setMarquee(null);
    setDragVisual(null);
  }, []);

  useEventRegistry(
    [
      {
        target: 'window',
        type: 'pointerdown',
        listener: (event) => {
          const e = event as PointerEvent;
          if (e.button !== 0 || e.pointerType === 'touch') return;
          if (editingId !== null || menu !== null) return;
          const container = containerRef.current;
          if (!container) return;
          const desktopEl =
            desktopRef?.current
            ?? container.closest<HTMLElement>('[data-wb-desktop]')
            ?? container.parentElement;
          const isBlankHit = e.target === desktopEl || e.target === container;
          if (!isBlankHit) return;

          const additive = e.metaKey || e.ctrlKey;
          if (!additive && selectedIdsRef.current.size > 0) {
            setSelectedIds(new Set());
            setPrimarySelectedId(null);
          }

          marqueeSessionRef.current = {
            pointerId: e.pointerId ?? 0,
            startX: e.clientX,
            startY: e.clientY,
            hostRect: container.getBoundingClientRect(),
            additive,
            initialSelection: additive ? new Set(selectedIdsRef.current) : new Set(),
            active: false,
          };
        },
      },
      {
        target: 'window',
        type: 'pointermove',
        listener: (event) => {
          const e = event as PointerEvent;
          const pointerId = e.pointerId ?? 0;

          // 1. 图标拖拽重排
          const reorder = reorderSessionRef.current;
          if (reorder && pointerId === reorder.pointerId) {
            const dx = e.clientX - reorder.startX;
            const dy = e.clientY - reorder.startY;
            if (!reorder.active) {
              if (Math.hypot(dx, dy) < REORDER_DRAG_THRESHOLD) return;
              reorder.active = true;
            }
            const targetIndex = findReorderTargetIndex({ x: e.clientX, y: e.clientY }, reorder.slots);
            const targetId =
              targetIndex !== null && targetIndex !== reorder.originIndex
                ? (reorder.slots[targetIndex]?.id ?? null)
                : null;
            setDragVisual({ id: reorder.id, dx, dy, targetId });
            return;
          }

          // 2. 桌面空白区橡胶筋框选
          const session = marqueeSessionRef.current;
          if (!session || pointerId !== session.pointerId) return;
          const dx = e.clientX - session.startX;
          const dy = e.clientY - session.startY;
          if (!session.active) {
            if (Math.hypot(dx, dy) < MARQUEE_DRAG_THRESHOLD) return;
            session.active = true;
          }

          const clientBox: DesktopRectBox = {
            left: Math.min(session.startX, e.clientX),
            top: Math.min(session.startY, e.clientY),
            right: Math.max(session.startX, e.clientX),
            bottom: Math.max(session.startY, e.clientY),
          };
          const { hostRect } = session;
          const localLeft = hostRect.width > 0
            ? Math.max(0, clientBox.left - hostRect.left)
            : clientBox.left - hostRect.left;
          const localTop = hostRect.height > 0
            ? Math.max(0, clientBox.top - hostRect.top)
            : clientBox.top - hostRect.top;
          const localRight = hostRect.width > 0
            ? Math.min(hostRect.width, clientBox.right - hostRect.left)
            : clientBox.right - hostRect.left;
          const localBottom = hostRect.height > 0
            ? Math.min(hostRect.height, clientBox.bottom - hostRect.top)
            : clientBox.bottom - hostRect.top;
          setMarquee({
            left: localLeft,
            top: localTop,
            width: Math.max(0, localRight - localLeft),
            height: Math.max(0, localBottom - localTop),
          });

          const container = containerRef.current;
          if (!container) return;
          const next = new Set(session.initialSelection);
          let firstHit: string | null = null;
          container.querySelectorAll<HTMLElement>('[data-wb-desk-shortcut]').forEach((el) => {
            const id = el.getAttribute('data-wb-desk-shortcut');
            if (!id) return;
            const rect = el.getBoundingClientRect();
            if (
              rectsIntersect(
                { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
                clientBox,
              )
            ) {
              next.add(id);
              if (firstHit === null) firstHit = id;
            }
          });
          if (!setsEqual(selectedIdsRef.current, next)) {
            setSelectedIds(next);
          }
          if (firstHit !== null) {
            setPrimarySelectedId((cur) => (cur && next.has(cur) ? cur : firstHit));
          } else if (next.size === 0) {
            setPrimarySelectedId(null);
          }
        },
      },
      {
        target: 'window',
        type: 'pointerup',
        listener: (event) => {
          const e = event as PointerEvent;
          const pointerId = e.pointerId ?? 0;
          const reorder = reorderSessionRef.current;
          if (reorder && pointerId === reorder.pointerId) {
            reorderSessionRef.current = null;
            setDragVisual(null);
            if (reorder.active) {
              suppressNextClickRef.current = true;
              window.setTimeout(() => {
                suppressNextClickRef.current = false;
              }, 0);
              const targetIndex = findReorderTargetIndex(
                { x: e.clientX, y: e.clientY },
                reorder.slots,
              );
              if (targetIndex !== null && targetIndex !== reorder.originIndex) {
                moveShortcut(reorder.id, targetIndex);
              }
            }
          }
          const session = marqueeSessionRef.current;
          if (session && pointerId === session.pointerId) {
            marqueeSessionRef.current = null;
            setMarquee(null);
          }
        },
      },
      {
        target: 'window',
        type: 'pointercancel',
        listener: cancelPointerSessions,
      },
      {
        target: 'window',
        type: 'blur',
        listener: cancelPointerSessions,
      },
      {
        target: 'window',
        type: 'keydown',
        listener: (event) => {
          const e = event as KeyboardEvent;
          if (e.key === 'Escape') {
            if (reorderSessionRef.current || marqueeSessionRef.current) {
              cancelPointerSessions();
              return;
            }
            if (selectedIdsRef.current.size > 0 && editingId === null && menu === null) {
              setSelectedIds(new Set());
              setPrimarySelectedId(null);
            }
            return;
          }
          if (e.defaultPrevented || e.repeat) return;
          if (e.key !== ' ' && e.code !== 'Space') return;
          if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
          if (isComposingKeyEvent(e)) return;
          if (editingId !== null || menu !== null) return;
          if (selectedIdsRef.current.size === 0) return;

          const overlay = useWorkbenchOverlay.getState();
          if (overlay.exposeOpen || overlay.switcherOpen || overlay.cheatsheetOpen) return;
          if (isSpaceQuickLookBlockedTarget(resolveShortcutEventTarget(e))) return;

          const resourceId = resolveQuickLookResourceId(
            shortcutsRef.current,
            selectedIdsRef.current,
            primarySelectedIdRef.current,
          );
          if (!resourceId) return;
          e.preventDefault();
          requestQuickLook(resourceId);
        },
      },
    ],
    [cancelPointerSessions, desktopRef, editingId, menu, moveShortcut],
  );

  const openMenuAt = useCallback((x: number, y: number, shortcut: DesktopShortcut) => {
    if (menuExitTimerRef.current !== null) {
      window.clearTimeout(menuExitTimerRef.current);
      menuExitTimerRef.current = null;
    }
    setMenuClosing(false);
    setMenu({ shortcut, x, y });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, shortcut: DesktopShortcut) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIdsRef.current.has(shortcut.id)) {
      setSelectedIds(new Set([shortcut.id]));
      setPrimarySelectedId(shortcut.id);
    }
    openMenuAt(e.clientX, e.clientY, shortcut);
  }, [openMenuAt]);

  // 触屏长按 = 右键（按下坐标呼出同一菜单）
  const handleLongPressMenu = useCallback((point: LongPressPoint, shortcut: DesktopShortcut) => {
    openMenuAt(point.x, point.y, shortcut);
  }, [openMenuAt]);

  const closeMenu = useCallback(() => {
    // 插件行可能先调 closeMenu 又按默认执行后关闭；第二次不能再起计时器，否则重新打开的菜单会被前一个计时器关掉
    if (menuExitTimerRef.current !== null) return;
    setMenuClosing(true);
    menuExitTimerRef.current = window.setTimeout(() => {
      menuExitTimerRef.current = null;
      setMenu(null);
      setMenuClosing(false);
    }, ICON_MENU_EXIT_MS);
  }, []);

  const handleRenameCommit = useCallback(
    (id: string, name: string) => {
      renameShortcut(id, name);
      setEditingId(null);
    },
    [renameShortcut],
  );

  if (shortcuts.length === 0) return null;

  return (
    <>
      <div
        ref={containerRef}
        className="wb-desk-icons"
        data-wb-desk-icons
        role="group"
        aria-label={t('desktop.title')}
      >
        {shortcuts.map((shortcut, index) => {
          const isDragging = dragVisual?.id === shortcut.id;
          return (
            <ShortcutIcon
              key={shortcut.id}
              shortcut={shortcut}
              index={index}
              selected={selectedIds.has(shortcut.id)}
              dragging={isDragging}
              dropTarget={dragVisual?.targetId === shortcut.id}
              dragOffset={isDragging ? { dx: dragVisual.dx, dy: dragVisual.dy } : null}
              menuOpen={menu?.shortcut.id === shortcut.id && !menuClosing}
              editing={editingId === shortcut.id}
              onSelect={handleSelectIcon}
              onKeyboardFocus={handleKeyboardFocus}
              onPointerDragStart={handlePointerDragStart}
              onOpen={handleOpen}
              onContextMenu={handleContextMenu}
              onLongPressMenu={handleLongPressMenu}
              onRenameCommit={handleRenameCommit}
              onRenameCancel={() => setEditingId(null)}
            />
          );
        })}
        {marquee && marquee.width > 0 && marquee.height > 0 && (
          <div
            className="wb-desk-marquee"
            data-wb-desk-marquee
            aria-hidden="true"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        )}
      </div>
      {menu && (
        <IconMenu
          state={menu}
          closing={menuClosing}
          onClose={closeMenu}
          onOpen={handleOpen}
          onRename={setEditingId}
          onRemove={removeShortcut}
        />
      )}
    </>
  );
};

export default DesktopShortcutsLayer;
