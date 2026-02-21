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

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Edit2, Check, X, RefreshCw, ExternalLink, Settings, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  NoteIcon,
  TextbookIcon,
  ExamIcon,
  EssayIcon,
  TranslationIcon,
  MindmapIcon,
  FolderIcon,
  FavoriteIcon,
  RecentIcon,
  AllFilesIcon,
  ImageFileIcon,
  GenericFileIcon,
  TrashIcon as TrashIconSvg,
  type ResourceIconProps,
} from '../../icons';
import { useShallow } from 'zustand/react/shallow';
import {
  useDesktopStore,
  type DesktopShortcut,
  type AppType,
  type DesktopRootConfig,
  getPresetAppShortcuts,
} from '../../stores/desktopStore';
import type { QuickAccessType } from '../../stores/finderStore';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
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

/** 应用类型对应的图标 */
const APP_TYPE_ICONS: Record<AppType, React.FC<ResourceIconProps>> = {
  note: NoteIcon,
  exam: ExamIcon,
  essay: EssayIcon,
  translation: TranslationIcon,
  mindmap: MindmapIcon,
  textbook: TextbookIcon,
};

/** 快捷入口类型对应的图标 */
const QUICK_ACCESS_ICONS: Partial<Record<QuickAccessType, React.FC<ResourceIconProps>>> = {
  notes: NoteIcon,
  exams: ExamIcon,
  essays: EssayIcon,
  translations: TranslationIcon,
  mindmaps: MindmapIcon,
  textbooks: TextbookIcon,
  favorites: FavoriteIcon,
  recent: RecentIcon,
  allFiles: AllFilesIcon,
  images: ImageFileIcon,
  files: GenericFileIcon,
  trash: TrashIconSvg,
};

/** 获取快捷方式图标 */
function getShortcutIcon(shortcut: DesktopShortcut): React.FC<ResourceIconProps> {
  if (shortcut.type === 'app' && shortcut.target.appType) {
    return APP_TYPE_ICONS[shortcut.target.appType] || GenericFileIcon;
  }
  if (shortcut.type === 'quickAccess' && shortcut.target.quickAccessType) {
    return QUICK_ACCESS_ICONS[shortcut.target.quickAccessType] || GenericFileIcon;
  }
  if (shortcut.type === 'folder') {
    return FolderIcon;
  }
  if (shortcut.type === 'resource' && shortcut.target.resourceType) {
    const typeIconMap: Record<string, React.FC<ResourceIconProps>> = {
      note: NoteIcon,
      exam: ExamIcon,
      essay: EssayIcon,
      translation: TranslationIcon,
      mindmap: MindmapIcon,
      textbook: TextbookIcon,
      image: ImageFileIcon,
      folder: FolderIcon,
    };
    return typeIconMap[shortcut.target.resourceType] || GenericFileIcon;
  }
  return GenericFileIcon;
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

  // 边界检测
  useEffect(() => {
    if (!state.open || !menuRef.current) return;

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
  }, [state.open, state.position]);

  // 点击外部关闭
  useEffect(() => {
    if (!state.open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [state.open, onClose]);

  if (!state.open) return null;

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
    <NotionButton variant="ghost" size="sm" className={cn('w-full !justify-start !px-3 !py-2', danger && 'text-red-500 hover:text-red-500')} onClick={() => { onClick(); onClose(); }}>
      {icon}
      <span>{label}</span>
    </NotionButton>
  );

  const Separator = () => <div className="h-px bg-border my-1" />;

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        'fixed min-w-[160px] overflow-hidden rounded-lg',
        'bg-popover/95 backdrop-blur-md text-popover-foreground',
        'border border-transparent ring-1 ring-border/40 shadow-lg',
        'py-1 animate-in fade-in-0 zoom-in-95'
      )}
      style={{ left: menuPosition.x, top: menuPosition.y, zIndex: Z_INDEX.contextMenu }}
    >
      {state.target ? (
        // 快捷方式右键菜单
        <>
          <MenuItem
            icon={<ExternalLink className="w-4 h-4" />}
            label={t('desktop.open', '打开')}
            onClick={() => onOpenShortcut?.(state.target!)}
          />
          <Separator />
          <MenuItem
            icon={<Edit2 className="w-4 h-4" />}
            label={t('desktop.rename', '重命名')}
            onClick={() => onRenameShortcut?.(state.target!)}
          />
          <Separator />
          <MenuItem
            icon={<Trash2 className="w-4 h-4" />}
            label={t('desktop.remove', '从桌面移除')}
            onClick={() => onRemoveShortcut?.(state.target!)}
            danger
          />
        </>
      ) : (
        // 空白区域右键菜单
        <>
          <MenuItem
            icon={<Plus className="w-4 h-4" />}
            label={t('desktop.addShortcut', '添加快捷方式')}
            onClick={onAddShortcut}
          />
          <Separator />
          <MenuItem
            icon={<Settings className="w-4 h-4" />}
            label={t('desktop.setRootFolder', '设置桌面根目录')}
            onClick={() => onSetDesktopRoot?.()}
          />
          {/* 显示当前桌面根目录 */}
          <div className="px-3 py-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5" />
              <span className="truncate max-w-[140px]">
                {desktopRoot.folderName || t('desktop.rootPath', '根目录')}
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
  const [editName, setEditName] = useState(shortcut.name);
  const Icon = getShortcutIcon(shortcut);

  useEffect(() => {
    if (isEditing) {
      setEditName(shortcut.name);
    }
  }, [isEditing, shortcut.name]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (editName.trim() && editName !== shortcut.name) {
        onEditConfirm(editName.trim());
      } else {
        onEditCancel();
      }
    } else if (e.key === 'Escape') {
      onEditCancel();
    }
  }, [editName, shortcut.name, onEditConfirm, onEditCancel]);

  return (
    <div
      className={cn(
        'group relative flex flex-col items-center justify-center gap-2 p-4 rounded-xl cursor-pointer select-none',
        'w-[88px] shrink-0',
        'transition-all duration-200 ease-out',
        'hover:bg-accent/60 dark:hover:bg-accent/40',
        'active:scale-95'
      )}
      onClick={isEditing ? undefined : onClick}
      onContextMenu={onContextMenu}
    >
      {/* 图标 */}
      <div className="relative transition-transform duration-200 group-hover:scale-110">
        <Icon size={56} />
        {/* 应用类型标记（仅 app 类型显示） */}
        {shortcut.type === 'app' && shortcut.target.action === 'create' && (
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
            <Plus className="w-3 h-3 text-primary-foreground" />
          </div>
        )}
      </div>

      {/* 名称 */}
      {isEditing ? (
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <Input
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-6 w-24 text-xs text-center px-1"
            autoFocus
          />
          <NotionButton variant="ghost" size="icon" iconOnly className="!h-5 !w-5 !p-0.5" onClick={() => { if (editName.trim() && editName !== shortcut.name) { onEditConfirm(editName.trim()); } else { onEditCancel(); } }} aria-label="confirm">
            <Check className="w-3.5 h-3.5 text-success" />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly className="!h-5 !w-5 !p-0.5" onClick={onEditCancel} aria-label="cancel">
            <X className="w-3.5 h-3.5 text-red-500" />
          </NotionButton>
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
  }, [hasAppShortcut, hasQuickAccessShortcut]);

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-[500px]">
        <NotionDialogHeader>
          <NotionDialogTitle>{t('desktop.addShortcut', '添加快捷方式')}</NotionDialogTitle>
          <NotionDialogDescription>
            {t('desktop.addShortcutDesc', '选择要添加到桌面的快捷方式')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>

        <div className="grid grid-cols-3 gap-3 py-4">
          {getPresetAppShortcuts().map((preset, index) => {
            const Icon = preset.type === 'app' && preset.target.appType
              ? APP_TYPE_ICONS[preset.target.appType]
              : preset.type === 'quickAccess' && preset.target.quickAccessType
                ? QUICK_ACCESS_ICONS[preset.target.quickAccessType]
                : GenericFileIcon;
            const added = isPresetAdded(preset);

            return (
              <NotionButton
                key={index}
                variant="ghost" size="sm"
                className={cn(
                  '!h-auto flex-col items-center gap-2 !p-3 !rounded-lg border',
                  added
                    ? 'border-success/50 bg-success/10 cursor-not-allowed opacity-60'
                    : 'border-transparent bg-muted/30 hover:border-border/40 hover:bg-muted/50'
                )}
                onClick={() => !added && handleAddPreset(index)}
                disabled={added}
              >
                {Icon && <Icon size={32} />}
                <span className="text-xs text-center">{preset.name}</span>
                {added && (
                  <span className="text-[10px] text-success">{t('desktop.added', '已添加')}</span>
                )}
              </NotionButton>
            );
          })}
        </div>

        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="default" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close', '关闭')}
          </NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
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
  const {
    getSortedShortcuts,
    removeShortcut,
    renameShortcut,
    initDefaultShortcuts,
    getDesktopRoot,
    setDesktopRoot,
  } = useDesktopStore(
    useShallow((state) => ({
      getSortedShortcuts: state.getSortedShortcuts,
      removeShortcut: state.removeShortcut,
      renameShortcut: state.renameShortcut,
      initDefaultShortcuts: state.initDefaultShortcuts,
      getDesktopRoot: state.getDesktopRoot,
      setDesktopRoot: state.setDesktopRoot,
    }))
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

  const shortcuts = getSortedShortcuts();
  const desktopRoot = getDesktopRoot();

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
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* 快捷方式网格 */}
      <CustomScrollArea className="flex-1">
        <div
          className="p-4 min-h-full"
          onContextMenu={handleContainerContextMenu}
        >
          {shortcuts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="w-24 h-24 rounded-full bg-accent/50 flex items-center justify-center mb-4">
                <Plus className="w-10 h-10" />
              </div>
              <p className="text-sm mb-4">{t('desktop.empty', '桌面为空')}</p>
              <p className="text-xs text-muted-foreground/60 mb-4">
                {t('desktop.rightClickHint', '右键点击添加快捷方式')}
              </p>
              <NotionButton
                variant="default"
                size="sm"
                onClick={() => setShowAddDialog(true)}
              >
                {t('desktop.addFirst', '添加第一个快捷方式')}
              </NotionButton>
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
        title={t('desktop.setRootFolder', '设置桌面根目录')}
      />
    </div>
  );
}
