/** 学习资源管理器 - 统一右键菜单组件。外壳保持原样，条目由 resource.contextMenu 提供。 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  FolderPlus, FileText, ArrowClockwise, Pencil, Trash, ArrowSquareOut, Chat, FolderOpen,
  Copy, Clipboard, ArrowCounterClockwise, Warning, Star, StarHalf, CheckCircle, Cards,
} from '@phosphor-icons/react';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '@/utils/cn';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useLiquidGlassLens, WallpaperReplica } from '@/features/workbench/core/liquidGlassLens';
import '@/features/workbench/styles/workbench.tokens.css';
import '@/features/workbench/components/DesktopContextMenu.css';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../stores/desktopStore';
import { useOptionalSlot } from '@/ui-kernel/react';
import type { ContentMenuContext, ContentMenuContribution } from '@/ui-kernel/contracts/content';
import { menuTargetContext } from '@/ui-plugins/official/content/menu';
import { CommunityContentBoundary } from '@/ui-plugins/official/content/CommunityContentBoundary';
import { officialMenuEntries } from '@/ui-plugins/official/content/entries';
import type { LearningHubContextMenuProps } from './LearningHubContextMenu.types';

export type { ContextMenuTarget, LearningHubContextMenuProps } from './LearningHubContextMenu.types';

interface MenuItemProps {
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, disabled, danger, onClick, children }) => (
  <button
    type="button"
    role="menuitem"
    className={cn('wb-desk-menu-item [@media(pointer:coarse)]:min-h-11', danger && 'wb-desk-menu-item--danger')}
    disabled={disabled}
    onClick={onClick}
  >
    <span className="wb-desk-menu-item-icon" aria-hidden="true" data-empty={icon ? undefined : 'true'}>{icon}</span>
    <span className="wb-desk-menu-item-label">{children}</span>
  </button>
);
const MenuSeparator: React.FC = () => <div className="wb-desk-menu-sep" role="separator" />;
const MENU_EXIT_MS = 180;
const menuIcons = { FolderPlus, FileText, ArrowClockwise, Pencil, Trash, ArrowSquareOut, Chat, FolderOpen,
  Copy, Clipboard, ArrowCounterClockwise, Warning, Star, StarHalf, CheckCircle, Cards };

function ContributedMenuRow({ item, context, t }: {
  item: ContentMenuContribution;
  context: ContentMenuContext;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (!item.visible(context)) return null;
  if (item.separator) return <MenuSeparator />;
  const iconName = typeof item.icon === 'function' ? item.icon(context) : item.icon;
  const Icon = iconName ? menuIcons[iconName] : undefined;
  const labelKey = typeof item.labelKey === 'function' ? item.labelKey(context) : item.labelKey!;
  const iconClassName = item.iconClassName?.(context);
  return (
    <MenuItem
      icon={Icon ? <Icon size={15} weight="duotone" className={iconClassName} /> : undefined}
      disabled={item.disabled?.(context)}
      danger={item.danger}
      onClick={() => item.run?.(context)}
    >
      {t(labelKey, item.labelParams?.(context) ?? {})}
    </MenuItem>
  );
}

export const LearningHubContextMenu: React.FC<LearningHubContextMenuProps> = (props) => {
  const { open, onOpenChange, position, target, isTrashView = false, canCreate = true,
    canDelete = true, canMove = true, canAddToChat = true, pasteCount = 0 } = props;
  const { t } = useTranslation('learningHub');
  const entries = useOptionalSlot<ContentMenuContribution>('resource.contextMenu') ?? officialMenuEntries;
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ x: position.x, y: position.y });
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const [renderedOpen, setRenderedOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  const renderedOpenRef = useRef(renderedOpen);
  const exitTimerRef = useRef<number | null>(null);
  useEffect(() => { renderedOpenRef.current = renderedOpen; }, [renderedOpen]);
  useEffect(() => {
    if (open) {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setRenderedOpen(true);
      setClosing(false);
      return;
    }
    if (!renderedOpenRef.current) return;
    setClosing(true);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setRenderedOpen(false);
      setClosing(false);
    }, MENU_EXIT_MS);
  }, [open]);
  useEffect(() => () => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);
  useLiquidGlassLens(menuRef, renderedOpen);

  useLayoutEffect(() => {
    if (!open || !renderedOpen || !menuRef.current || isTouchPrimary) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let x = position.x;
    let y = position.y;
    if (x + rect.width > viewportWidth - 8) x = viewportWidth - rect.width - 8;
    if (y + rect.height > viewportHeight - 8) y = position.y - rect.height;
    x = Math.max(8, x);
    y = Math.max(8, y);
    setMenuPosition({ x, y });
  }, [isTouchPrimary, open, position, renderedOpen, target]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    const handleTouchOutside = (e: TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    };
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
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
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => { onOpenChange(false); return true; }, BACK_PRIORITY.overlay);
  }, [open, onOpenChange]);
  const closeMenu = useCallback(() => { onOpenChange(false); }, [onOpenChange]);
  const { addResourceShortcut, addFolderShortcut, hasResourceShortcut, hasFolderShortcut } = useDesktopStore(
    useShallow((state) => ({
      addResourceShortcut: state.addResourceShortcut,
      addFolderShortcut: state.addFolderShortcut,
      hasResourceShortcut: state.hasResourceShortcut,
      hasFolderShortcut: state.hasFolderShortcut,
    }))
  );
  if (!renderedOpen) return null;

  const targetContext = menuTargetContext(target, isTrashView);
  const { resourceItem, isFolder } = targetContext;
  const context: ContentMenuContext = {
    ...props, isTrashView, canCreate, canDelete, canMove, canAddToChat, pasteCount,
    ...targetContext, closeMenu, addResourceShortcut, addFolderShortcut,
    isAddedToDesktop: targetContext.scope === 'resource'
      ? isFolder ? hasFolderShortcut(resourceItem?.id || '') : hasResourceShortcut(resourceItem?.id || '')
      : false,
  };
  const targetTitle = target.type === 'folder' ? target.folder.folder.title : target.type === 'resource' ? target.resource.title : null;
  const rawTargetMeta =
    target.type === 'resource'
      ? (target.resource as unknown as { metadata?: { isMounted?: boolean; mountId?: string } }).metadata
      : target.type === 'folder'
        ? ((target.folder as unknown as { metadata?: { isMounted?: boolean; mountId?: string } }).metadata ??
           (target.folder.folder as unknown as { metadata?: { isMounted?: boolean; mountId?: string } }).metadata)
        : undefined;
  const resolvedMountId =
    props.activeMountId ??
    (rawTargetMeta?.isMounted && typeof rawTargetMeta.mountId === 'string'
      ? rawTargetMeta.mountId
      : null);
  const canShowSpaceMountRow =
    !isTrashView &&
    (target.type === 'resource' || target.type === 'folder') &&
    typeof props.onMountToSpace === 'function';

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-wb-blur-surface
      data-phase={closing ? 'closing' : 'open'}
      className={cn(
        'wb-desk-menu wb-glass-lens wb-desk-menu-sparse-icons',
        'scroll-area--native max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden',
        isTouchPrimary && 'max-w-none rounded-t-2xl [&_[role=menuitem]]:min-h-11'
      )}
      style={isTouchPrimary ? {
        position: 'fixed', left: 8, right: 8, bottom: 0, top: 'auto', width: 'auto',
        maxHeight: 'calc(100dvh - var(--mobile-header-total-height, 56px) - 8px)',
        paddingBottom: 'var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
        zIndex: Z_INDEX.contextMenu,
      } : { position: 'fixed', left: menuPosition.x, top: menuPosition.y, zIndex: Z_INDEX.contextMenu }}
    >
      <WallpaperReplica hostRef={menuRef} enabled={renderedOpen} />
      {isTouchPrimary && <div aria-hidden className="mx-auto my-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25" />}
      {isTouchPrimary && targetTitle && (
        <div className="mb-1 border-b border-border/40 px-3 pb-2 text-xs font-medium text-muted-foreground break-all">{targetTitle}</div>
      )}
      {entries.map(entry => entry.origin === 'builtin' ? (
        <ContributedMenuRow key={`${entry.owner}:${entry.id}`} item={entry.value} context={context} t={t} />
      ) : (
        <CommunityContentBoundary key={`${entry.owner}:${entry.id}`}>
          <ContributedMenuRow item={entry.value} context={context} t={t} />
        </CommunityContentBoundary>
      ))}
      {canShowSpaceMountRow ? (
        <>
          <div className="my-1 border-t border-border/35" role="separator" />
          <MenuItem
            icon={<FolderPlus size={15} weight="duotone" />}
            onClick={() => {
              closeMenu();
              props.onMountToSpace?.(target);
            }}
          >
            {t('spaceMount.menuMountToSpace')}
          </MenuItem>
          {resolvedMountId && props.onUnmountFromCurrentFolder ? (
            <MenuItem
              icon={<ArrowCounterClockwise size={15} weight="duotone" />}
              onClick={() => {
                closeMenu();
                props.onUnmountFromCurrentFolder?.(resolvedMountId);
              }}
            >
              {t('spaceMount.menuUnmountFromSpace')}
            </MenuItem>
          ) : null}
        </>
      ) : null}
    </div>,
    document.body
  );
};

export default LearningHubContextMenu;
