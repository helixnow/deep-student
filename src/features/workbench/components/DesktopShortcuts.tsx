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
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, PencilSimple, Trash } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useLongPress, type LongPressPoint } from '@/hooks/mobile/useLongPress';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { DstuNodeType } from '@/dstu/types';
import {
  useDesktopStore,
  type AppType,
  type DesktopShortcut,
} from '@/features/learning-hub/stores/desktopStore';
import type { QuickAccessType } from '@/features/learning-hub/stores/finderStore';
import { getShortcutIcon } from '@/features/learning-hub/components/finder/shortcutIcons';
import { workbenchBus } from '../core/workbenchBus';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import {
  launchResourceFromDragData,
  registerDesktopResourceDropHandler,
} from '../apps/files/desktopDragBridge';
import { ActionItem } from './DesktopContextMenu';
import './DesktopShortcuts.css';

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
        title: shortcut.name,
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
// 图标
// ---------------------------------------------------------------------------

interface ShortcutIconProps {
  shortcut: DesktopShortcut;
  menuOpen: boolean;
  editing: boolean;
  onOpen: (shortcut: DesktopShortcut) => void;
  onContextMenu: (e: React.MouseEvent, shortcut: DesktopShortcut) => void;
  /** 触屏长按呼出菜单（右键的触屏替代） */
  onLongPressMenu: (point: LongPressPoint, shortcut: DesktopShortcut) => void;
  onRenameCommit: (id: string, name: string) => void;
  onRenameCancel: () => void;
}

const ShortcutIcon: React.FC<ShortcutIconProps> = ({
  shortcut,
  menuOpen,
  editing,
  onOpen,
  onContextMenu,
  onLongPressMenu,
  onRenameCommit,
  onRenameCancel,
}) => {
  const Icon = getShortcutIcon(shortcut);
  const [editName, setEditName] = useState(shortcut.name);
  // 触屏无双击语义：单击直接打开
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  // 触屏长按 = 右键菜单（长按触发后抑制本次 click，避免同时打开快捷方式）
  const longPress = useLongPress({
    onLongPress: (point) => onLongPressMenu(point, shortcut),
    disabled: !isTouchPrimary || editing,
    preventContextMenu: false,
  });

  useEffect(() => {
    if (editing) setEditName(shortcut.name);
  }, [editing, shortcut.name]);

  const commitOrCancel = useCallback(() => {
    const next = editName.trim();
    if (next && next !== shortcut.name) onRenameCommit(shortcut.id, next);
    else onRenameCancel();
  }, [editName, shortcut.id, shortcut.name, onRenameCommit, onRenameCancel]);

  return (
    // div[role=button]（非 <button>）：重命名态内嵌 <input>，button 不允许
    // 交互式子元素，嵌套会破坏输入框的光标定位/文本选择
    <div
      role="button"
      tabIndex={editing ? -1 : 0}
      className="wb-desk-icon"
      data-menu-open={menuOpen ? 'true' : undefined}
      data-wb-desk-shortcut={shortcut.id}
      aria-label={shortcut.name}
      {...longPress.bind}
      onClick={isTouchPrimary && !editing ? () => onOpen(shortcut) : undefined}
      onDoubleClick={editing ? undefined : () => onOpen(shortcut)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter' || e.key === ' ') {
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
            if (e.key === 'Enter') commitOrCancel();
            else if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={commitOrCancel}
        />
      ) : (
        <span className="wb-desk-icon__label">{shortcut.name}</span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 图标右键菜单（学习桌面玻璃菜单同款外壳）
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
  const { t } = useTranslation('learningHub');
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  useLiquidGlassLens(menuRef, true);

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

  useEffect(() => {
    if (closing) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handlePointerDown);
      document.addEventListener('keydown', handleEscape);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closing, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="wb-desk-menu wb-glass-lens"
      data-phase={closing ? 'closing' : 'open'}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 'var(--wb-z-desktop-menu, 9650)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ActionItem
        icon={<ArrowSquareOut size={15} weight="duotone" />}
        label={t('desktop.open')}
        onClick={() => {
          onClose();
          onOpen(state.shortcut);
        }}
      />
      <div className="wb-desk-menu-sep" role="separator" />
      <ActionItem
        icon={<PencilSimple size={15} weight="duotone" />}
        label={t('desktop.rename')}
        onClick={() => {
          onClose();
          onRename(state.shortcut.id);
        }}
      />
      <ActionItem
        icon={<Trash size={15} weight="duotone" />}
        label={t('desktop.remove')}
        danger
        onClick={() => {
          onClose();
          onRemove(state.shortcut.id);
        }}
      />
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// 图标层
// ---------------------------------------------------------------------------

export const DesktopShortcutsLayer: React.FC = () => {
  const { t } = useTranslation('learningHub');
  const { removeShortcut, renameShortcut, initDefaultShortcuts } = useDesktopStore(
    useShallow((state) => ({
      removeShortcut: state.removeShortcut,
      renameShortcut: state.renameShortcut,
      initDefaultShortcuts: state.initDefaultShortcuts,
    })),
  );
  const rawShortcuts = useDesktopStore((state) => state.shortcuts);
  const shortcuts = [...rawShortcuts].sort((a, b) => a.position - b.position);

  const [menu, setMenu] = useState<IconMenuState | null>(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const menuExitTimerRef = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
    openMenuAt(e.clientX, e.clientY, shortcut);
  }, [openMenuAt]);

  // 触屏长按 = 右键（按下坐标呼出同一菜单）
  const handleLongPressMenu = useCallback((point: LongPressPoint, shortcut: DesktopShortcut) => {
    openMenuAt(point.x, point.y, shortcut);
  }, [openMenuAt]);

  const closeMenu = useCallback(() => {
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
      <div className="wb-desk-icons" data-wb-desk-icons role="group" aria-label={t('desktop.title')}>
        {shortcuts.map((shortcut) => (
          <ShortcutIcon
            key={shortcut.id}
            shortcut={shortcut}
            menuOpen={menu?.shortcut.id === shortcut.id && !menuClosing}
            editing={editingId === shortcut.id}
            onOpen={handleOpen}
            onContextMenu={handleContextMenu}
            onLongPressMenu={handleLongPressMenu}
            onRenameCommit={handleRenameCommit}
            onRenameCancel={() => setEditingId(null)}
          />
        ))}
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
