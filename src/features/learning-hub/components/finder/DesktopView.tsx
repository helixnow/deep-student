/**
 * 桌面视图组件
 *
 * 显示用户添加的桌面快捷方式，支持：
 * - 网格布局显示快捷方式
 * - 点击打开对应应用/资源
 * - 右键菜单管理快捷方式
 * - 拖拽排序（待实现）
 *
 * @since 2026-01-31
 */

import React, { useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useTranslation } from 'react-i18next';
import { Plus, Trash, PencilSimple, Check, X, ArrowSquareOut, Gear, FolderOpen, DotsThree } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useLiquidGlassLens } from '@/features/workbench/core/liquidGlassLens';
import '@/features/workbench/styles/workbench.tokens.css';
import '@/features/workbench/components/DesktopContextMenu.css';
import { IllustratedGenericFileIcon } from '../../icons';
import { APP_TYPE_ICONS, QUICK_ACCESS_ICONS, getShortcutIcon } from './shortcutIcons';
import { useShallow } from 'zustand/react/shallow';
import {
  useDesktopStore,
  type DesktopShortcut,
  type AppType,
  type DesktopRootConfig,
  getPresetAppShortcuts,
} from '../../stores/desktopStore';
import type { QuickAccessType } from '../../stores/finderStore';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { FolderPickerDialog } from './FolderPickerDialog';
import { folderApi } from '@/dstu';

/** 创建资源类型 */
export type CreateResourceType = 'note' | 'exam' | 'essay' | 'translation' | 'mindmap';

interface DesktopViewProps {
  /** 导航到快捷入口 */
  onNavigateQuickAccess: (type: QuickAccessType) => void;
  /** 打开资源 */
  onOpenResource?: (resourceId: string, resourceType: string) => void;
  /** 打开文件夹 */
  onOpenFolder?: (folderId: string) => void;
  /**
   * 在桌面根目录创建资源
   * @param type 资源类型
   * @param desktopRoot 桌面根目录配置
   */
  onCreateInDesktopRoot?: (type: CreateResourceType, desktopRoot: DesktopRootConfig) => void;
}

// ============================================================================
// 右键菜单组件
// ============================================================================

interface ContextMenuState {
  open: boolean;
  position: { x: number; y: number };
  target: DesktopShortcut | null; // null 表示空白区域
}

interface DesktopContextMenuProps {
  state: ContextMenuState;
  desktopRoot: DesktopRootConfig;
  onClose: () => void;
  onAddShortcut: () => void;
  onOpenShortcut?: (shortcut: DesktopShortcut) => void;
  onRenameShortcut?: (shortcut: DesktopShortcut) => void;
  onRemoveShortcut?: (shortcut: DesktopShortcut) => void;
  onSetDesktopRoot?: () => void;
}

function DesktopContextMenu({
  state,
  desktopRoot,
  onClose,
  onAddShortcut,
  onOpenShortcut,
  onRenameShortcut,
  onRemoveShortcut,
  onSetDesktopRoot,
}: DesktopContextMenuProps) {
  const { t } = useTranslation('learningHub');
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState(state.position);
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  // 液态玻璃透镜（学习桌面菜单同款材质）
  useLiquidGlassLens(menuRef, state.open);

  // 边界检测（useLayoutEffect：在绘制前完成定位，避免菜单先出现在旧位置再跳动）
  useLayoutEffect(() => {
    if (!state.open || !menuRef.current || isTouchPrimary) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = state.position.x;
    let y = state.position.y;

    if (x + rect.width > viewportWidth - 8) {
      x = viewportWidth - rect.width - 8;
    }
    if (y + rect.height > viewportHeight - 8) {
      y = state.position.y - rect.height;
    }
    x = Math.max(8, x);
    y = Math.max(8, y);

    setMenuPosition({ x, y });
  }, [isTouchPrimary, state.open, state.position]);

  // 点击外部关闭；触屏补充：菜单外 touchstart（capture）或背景滚动时关闭，避免滚动穿透时菜单悬空
  useEffect(() => {
    if (!state.open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleTouchOutside = (e: TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleTouchOutside, { capture: true, passive: true });
      window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleTouchOutside, { capture: true });
      window.removeEventListener('scroll', handleScroll, { capture: true });
      document.removeEventListener('keydown', handleEscape);
    };
  }, [state.open, onClose]);

  // 📱 Android 返回键：自绘浮层菜单打开时先关闭菜单（契约第 4 条）
  useEffect(() => {
    if (!state.open) return;
    return registerBackHandler(() => {
      onClose();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [state.open, onClose]);

  if (!state.open) return null;

  // 学习桌面 wb-desk-menu 同款菜单行（样式见 workbench DesktopContextMenu.css）
  const MenuItem = ({
    icon,
    label,
    onClick,
    danger = false,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'wb-desk-menu-item [@media(pointer:coarse)]:min-h-11',
        danger && 'wb-desk-menu-item--danger'
      )}
      onClick={() => { onClick(); onClose(); }}
    >
      <span className="wb-desk-menu-item-icon" aria-hidden="true">{icon}</span>
      <span className="wb-desk-menu-item-label">{label}</span>
    </button>
  );

  const Separator = () => <div className="wb-desk-menu-sep" role="separator" />;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-wb-blur-surface
      className={cn(
        'scroll-area--native wb-desk-menu wb-glass-lens max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden',
        isTouchPrimary && 'max-w-none rounded-t-2xl',
      )}
      style={isTouchPrimary
        ? {
            position: 'fixed',
            left: 8,
            right: 8,
            bottom: 0,
            top: 'auto',
            width: 'auto',
            maxHeight: 'calc(100dvh - var(--mobile-header-total-height, 56px) - 8px)',
            paddingBottom: 'var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
            zIndex: Z_INDEX.contextMenu,
          }
        : {
            // .wb-desk-menu 默认 absolute；此处 Portal 到 body，用 fixed
            position: 'fixed',
            left: menuPosition.x,
            top: menuPosition.y,
            zIndex: Z_INDEX.contextMenu,
          }}
    >
      {isTouchPrimary && (
        <div aria-hidden className="mx-auto my-2 h-1 w-10 rounded-full bg-muted-foreground/25" />
      )}
      {state.target ? (
        // 快捷方式右键菜单
        <>
          <MenuItem
            icon={<ArrowSquareOut size={15} weight="duotone" />}
            label={t('desktop.open')}
            onClick={() => onOpenShortcut?.(state.target!)}
          />
          <Separator />
          <MenuItem
            icon={<PencilSimple size={15} weight="duotone" />}
            label={t('desktop.rename')}
            onClick={() => onRenameShortcut?.(state.target!)}
          />
          <Separator />
          <MenuItem
            icon={<Trash size={15} weight="duotone" />}
            label={t('desktop.remove')}
            onClick={() => onRemoveShortcut?.(state.target!)}
            danger
          />
        </>
      ) : (
        // 空白区域右键菜单
        <>
          <MenuItem
            icon={<Plus size={15} weight="duotone" />}
            label={t('desktop.addShortcut')}
            onClick={onAddShortcut}
          />
          <Separator />
          <MenuItem
            icon={<Gear size={15} weight="duotone" />}
            label={t('desktop.setRootFolder')}
            onClick={() => onSetDesktopRoot?.()}
          />
          {/* 显示当前桌面根目录 */}
          <div className="px-3 py-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <FolderOpen size={14} />
              <span className="truncate max-w-[140px]">
                {desktopRoot.folderName || t('desktop.rootPath')}
              </span>
            </div>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}

// ============================================================================
// 快捷方式卡片组件
// ============================================================================

function ShortcutCard({
  shortcut,
  onClick,
  onContextMenu,
  isEditing,
  onEditConfirm,
  onEditCancel,
}: {
  shortcut: DesktopShortcut;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isEditing: boolean;
  onEditConfirm: (newName: string) => void;
  onEditCancel: () => void;
}) {
  const { t } = useTranslation('common');
  const [editName, setEditName] = useState(shortcut.name);
  const Icon = getShortcutIcon(shortcut);
  // 触屏无右键：管理入口（打开/重命名/移除）需要常显「更多」按钮
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  useEffect(() => {
    if (isEditing) {
      setEditName(shortcut.name);
    }
  }, [isEditing, shortcut.name]);

  // 提交或取消：有有效修改则提交，否则取消（Enter/确认按钮/点击空白共用）
  const commitOrCancel = useCallback(() => {
    if (editName.trim() && editName.trim() !== shortcut.name) {
      onEditConfirm(editName.trim());
    } else {
      onEditCancel();
    }
  }, [editName, shortcut.name, onEditConfirm, onEditCancel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitOrCancel();
    } else if (e.key === 'Escape') {
      onEditCancel();
    }
  }, [commitOrCancel, onEditCancel]);

  return (
    <div
      role="button"
      tabIndex={isEditing ? -1 : 0}
      aria-label={shortcut.name}
      className={cn(
        'group relative flex flex-col items-center justify-center gap-2 p-4 rounded-xl cursor-pointer select-none',
        'w-[88px] shrink-0',
        'transition-all duration-200 ease-out',
        'hover:bg-[var(--interactive-hover)] dark:hover:bg-[var(--interactive-hover)]',
        'active:scale-95',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40'
      )}
      onClick={isEditing ? undefined : onClick}
      onKeyDown={(e) => {
        if (isEditing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={onContextMenu}
    >
      {/* 触屏常显「更多」入口：快捷方式的重命名/移除原本只有右键菜单可达 */}
      {isTouchPrimary && !isEditing && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="absolute right-0 top-0 z-10 !h-11 !w-11 !p-2.5 hover:bg-[var(--interactive-hover)]"
          onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}
          aria-label={t('more')}
        >
          <DotsThree size={18} className="text-muted-foreground/70" />
        </DsButton>
      )}

      {/* 图标 */}
      <div className="relative transition-transform duration-200 group-hover:scale-110">
        <Icon size={56} />
        {/* 应用类型标记（仅 app 类型显示） */}
        {shortcut.type === 'app' && shortcut.target.action === 'create' && (
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
            <Plus size={12} className="text-primary-foreground" />
          </div>
        )}
      </div>

      {/* 名称 */}
      {isEditing ? (
        <div
          className="flex items-center gap-1"
          onClick={e => e.stopPropagation()}
          onBlur={(e) => {
            // 焦点完全离开编辑区（点击桌面空白等）时提交或取消，避免编辑态悬挂
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              commitOrCancel();
            }
          }}
        >
          {/* 触屏：重命名控件使用标准 44px 触控目标。 */}
          <Input
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={e => e.target.select()}
            className="h-6 w-24 text-xs text-center px-1 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!text-[16px]"
            autoFocus
          />
          <DsButton variant="ghost" size="icon" iconOnly className="!h-5 !w-5 !p-0.5 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" onClick={commitOrCancel} aria-label={t('confirm')}>
            <Check size={14} className="text-success" />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly className="!h-5 !w-5 !p-0.5 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" onClick={onEditCancel} aria-label={t('cancel')}>
            <X size={14} className="text-danger" />
          </DsButton>
        </div>
      ) : (
        <span className="text-xs text-center font-medium text-foreground/80 group-hover:text-foreground line-clamp-2 max-w-[80px]">
          {shortcut.name}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// 添加快捷方式对话框
// ============================================================================

function AddShortcutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('learningHub');
  const { addFromPreset, hasAppShortcut, hasQuickAccessShortcut } = useDesktopStore(
    useShallow((state) => ({
      addFromPreset: state.addFromPreset,
      hasAppShortcut: state.hasAppShortcut,
      hasQuickAccessShortcut: state.hasQuickAccessShortcut,
    }))
  );
  // ★ 订阅 shortcuts 状态本身：添加快捷方式后"已添加"标记才能实时更新
  // （仅订阅 store 的函数引用不会在状态变化时触发重渲染）
  const shortcuts = useDesktopStore((state) => state.shortcuts);

  const handleAddPreset = useCallback((index: number) => {
    addFromPreset(index);
  }, [addFromPreset]);

  const isPresetAdded = useCallback((preset: ReturnType<typeof getPresetAppShortcuts>[0]) => {
    if (preset.type === 'app' && preset.target.appType && preset.target.action) {
      return hasAppShortcut(preset.target.appType, preset.target.action);
    }
    if (preset.type === 'quickAccess' && preset.target.quickAccessType) {
      return hasQuickAccessShortcut(preset.target.quickAccessType);
    }
    return false;
    // shortcuts 变化时重新判断"已添加"状态
  }, [hasAppShortcut, hasQuickAccessShortcut, shortcuts]);

  return (
    <DsDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-[500px]">
        <DsDialogHeader>
          <DsDialogTitle>{t('desktop.addShortcut')}</DsDialogTitle>
          <DsDialogDescription>
            {t('desktop.addShortcutDesc')}
          </DsDialogDescription>
        </DsDialogHeader>
        <DsDialogBody>

        <div className="grid grid-cols-3 gap-3 py-4">
          {getPresetAppShortcuts().map((preset, index) => {
            const Icon = preset.type === 'app' && preset.target.appType
              ? APP_TYPE_ICONS[preset.target.appType]
              : preset.type === 'quickAccess' && preset.target.quickAccessType
                ? QUICK_ACCESS_ICONS[preset.target.quickAccessType]
                : IllustratedGenericFileIcon;
            const added = isPresetAdded(preset);

            return (
              <DsButton
                key={index}
                variant="ghost" size="sm"
                className={cn(
                  '!h-auto flex-col items-center gap-2 !p-3 !rounded-lg border',
                  added
                    ? 'border-success/50 bg-success/10 cursor-not-allowed opacity-60'
                    : 'border-transparent bg-muted/30 hover:border-border/40 hover:bg-[var(--interactive-hover)]'
                )}
                onClick={() => !added && handleAddPreset(index)}
                disabled={added}
              >
                {Icon && <Icon size={32} />}
                <span className="text-xs text-center">{preset.name}</span>
                {added && (
                  <span className="text-2xs text-success">{t('desktop.added')}</span>
                )}
              </DsButton>
            );
          })}
        </div>

        </DsDialogBody>
        <DsDialogFooter>
          <DsButton variant="default" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={() => onOpenChange(false)}>
            {t('common:close')}
          </DsButton>
        </DsDialogFooter>
    </DsDialog>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function DesktopView({
  onNavigateQuickAccess,
  onOpenResource,
  onOpenFolder,
  onCreateInDesktopRoot,
}: DesktopViewProps) {
  const { t } = useTranslation('learningHub');
  const { isSmallScreen } = useBreakpoint();
  // 触屏无右键：非空态也需要常显的「添加快捷方式/设置根目录」入口（F7）
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const {
    removeShortcut,
    renameShortcut,
    initDefaultShortcuts,
    setDesktopRoot,
  } = useDesktopStore(
    useShallow((state) => ({
      removeShortcut: state.removeShortcut,
      renameShortcut: state.renameShortcut,
      initDefaultShortcuts: state.initDefaultShortcuts,
      setDesktopRoot: state.setDesktopRoot,
    }))
  );
  // ★ 直接订阅状态（而非只订阅 getter 函数引用），
  // 确保添加/重命名/移除快捷方式后视图立即更新
  const rawShortcuts = useDesktopStore((state) => state.shortcuts);
  const desktopRoot = useDesktopStore((state) => state.desktopRoot);
  const shortcuts = useMemo(
    () => [...rawShortcuts].sort((a, b) => a.position - b.position),
    [rawShortcuts]
  );
  
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showRootFolderPicker, setShowRootFolderPicker] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    open: false,
    position: { x: 0, y: 0 },
    target: null,
  });

  // 首次加载时初始化默认快捷方式
  useEffect(() => {
    initDefaultShortcuts();
  }, [initDefaultShortcuts]);

  /** 处理设置桌面根目录 */
  const handleSetDesktopRoot = useCallback(async (folderId: string | null) => {
    if (folderId === null) {
      // 设置为根目录
      setDesktopRoot(null, null, null);
    } else {
      // 获取文件夹信息
      const result = await folderApi.getFolder(folderId);
      if (result.ok && result.value) {
        // 获取面包屑路径
        const breadcrumbsResult = await folderApi.getBreadcrumbs(folderId);
        let path = '/';
        if (breadcrumbsResult.ok && breadcrumbsResult.value.length > 0) {
          path = '/' + breadcrumbsResult.value.map(b => b.name).join('/');
        }
        setDesktopRoot(folderId, result.value.title, path);
      } else {
        // 如果获取失败，仍然设置但只有 ID
        setDesktopRoot(folderId, null, null);
      }
    }
    setShowRootFolderPicker(false);
  }, [setDesktopRoot]);

  /** 处理快捷方式点击 */
  const handleShortcutClick = useCallback((shortcut: DesktopShortcut) => {
    switch (shortcut.type) {
      case 'app':
        if (shortcut.target.action === 'create') {
          // ★ 2026-01-31: 在桌面根目录创建资源，然后跳转到该位置
          const appType = shortcut.target.appType;
          if (appType && appType !== 'textbook') {
            onCreateInDesktopRoot?.(appType as CreateResourceType, desktopRoot);
          }
        } else if (shortcut.target.action === 'list' && shortcut.target.appType) {
          const typeToQuickAccess: Record<AppType, QuickAccessType> = {
            note: 'notes',
            exam: 'exams',
            essay: 'essays',
            translation: 'translations',
            mindmap: 'mindmaps',
            textbook: 'textbooks',
          };
          onNavigateQuickAccess(typeToQuickAccess[shortcut.target.appType]);
        }
        break;

      case 'quickAccess':
        if (shortcut.target.quickAccessType) {
          onNavigateQuickAccess(shortcut.target.quickAccessType);
        }
        break;

      case 'resource':
        if (shortcut.target.resourceId && shortcut.target.resourceType) {
          onOpenResource?.(shortcut.target.resourceId, shortcut.target.resourceType);
        }
        break;

      case 'folder':
        if (shortcut.target.folderId) {
          onOpenFolder?.(shortcut.target.folderId);
        }
        break;
    }
  }, [onNavigateQuickAccess, onOpenResource, onOpenFolder, onCreateInDesktopRoot, desktopRoot]);

  /** 处理空白区域右键菜单 */
  const handleContainerContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      open: true,
      position: { x: e.clientX, y: e.clientY },
      target: null,
    });
  }, []);

  /** 处理快捷方式右键菜单 */
  const handleShortcutContextMenu = useCallback((e: React.MouseEvent, shortcut: DesktopShortcut) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      open: true,
      position: { x: e.clientX, y: e.clientY },
      target: shortcut,
    });
  }, []);

  /** 关闭右键菜单 */
  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, open: false }));
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* 快捷方式网格 */}
      <CustomScrollArea className="min-h-0 flex-1">
        <div
          className="min-h-full p-4"
          style={{
            paddingBottom: 'calc(1rem + var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)))',
          }}
          onContextMenu={handleContainerContextMenu}
        >
          {shortcuts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="w-24 h-24 rounded-full bg-accent/50 flex items-center justify-center mb-4">
                <Plus size={40} />
              </div>
              <p className="text-sm mb-4">{t('desktop.empty')}</p>
              <p className="text-xs text-muted-foreground/60 mb-4">
                {t(isSmallScreen ? 'desktop.touchHint' : 'desktop.rightClickHint', isSmallScreen ? '点击下方按钮添加快捷方式' : '右键点击添加快捷方式')}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <DsButton
                  variant="default"
                  size="sm"
                  className="[@media(pointer:coarse)]:!min-h-11"
                  onClick={() => setShowAddDialog(true)}
                >
                  {t('desktop.addFirst')}
                </DsButton>
                {/* r3 建议后续#3：空态并列次级入口——此前触屏空态下「设置桌面根目录」
                    必须先添加一个快捷方式后经「添加」卡菜单才可达 */}
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
                  onClick={() => setShowRootFolderPicker(true)}
                >
                  {t('desktop.setRootFolder')}
                </DsButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {shortcuts.map(shortcut => (
                <ShortcutCard
                  key={shortcut.id}
                  shortcut={shortcut}
                  onClick={() => handleShortcutClick(shortcut)}
                  onContextMenu={(e) => handleShortcutContextMenu(e, shortcut)}
                  isEditing={editingId === shortcut.id}
                  onEditConfirm={(newName) => {
                    renameShortcut(shortcut.id, newName);
                    setEditingId(null);
                  }}
                  onEditCancel={() => setEditingId(null)}
                />
              ))}
              {/* 触屏常显「添加」入口：空白区菜单（添加快捷方式/设置根目录）原本仅右键可达 */}
              {isTouchPrimary && (
                <button
                  type="button"
                  aria-label={t('desktop.addShortcut')}
                  aria-haspopup="menu"
                  className={cn(
                    'flex w-[88px] shrink-0 select-none flex-col items-center justify-center gap-2 rounded-xl p-4',
                    'border border-dashed border-border/60 text-muted-foreground',
                    'transition-colors duration-200 hover:bg-[var(--interactive-hover)] active:scale-95',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40'
                  )}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setContextMenu({
                      open: true,
                      position: { x: rect.left, y: rect.bottom + 4 },
                      target: null,
                    });
                  }}
                >
                  <Plus size={32} />
                  <span className="text-xs text-center">{t('desktop.add')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </CustomScrollArea>

      {/* 右键菜单 */}
      <DesktopContextMenu
        state={contextMenu}
        desktopRoot={desktopRoot}
        onClose={closeContextMenu}
        onAddShortcut={() => setShowAddDialog(true)}
        onOpenShortcut={(shortcut) => handleShortcutClick(shortcut)}
        onRenameShortcut={(shortcut) => setEditingId(shortcut.id)}
        onRemoveShortcut={(shortcut) => removeShortcut(shortcut.id)}
        onSetDesktopRoot={() => setShowRootFolderPicker(true)}
      />

      {/* 添加快捷方式对话框 */}
      <AddShortcutDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
      />

      {/* 设置桌面根目录对话框 */}
      <FolderPickerDialog
        open={showRootFolderPicker}
        onOpenChange={setShowRootFolderPicker}
        onConfirm={handleSetDesktopRoot}
        title={t('desktop.setRootFolder')}
        inline={isTouchPrimary}
      />
    </div>
  );
}
