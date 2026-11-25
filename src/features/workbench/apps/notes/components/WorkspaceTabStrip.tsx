import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  LinkSimple,
  List,
  PushPin,
  PushPinSlash,
  SidebarSimple,
  TreeStructure,
  X,
} from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { NoteGlyph } from '@/features/notes/components/NoteGlyph';
import { disambiguateTabTitles } from '@/features/notes/tabTitleDisambiguation';
import type {
  ResourceType,
  SaveState,
  TabContextMenu,
  TabDropPosition,
  WorkspaceTab,
} from '../workspaceTreeModel';

export const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }> = ({
  label,
  children,
  className,
  ...props
}) => (
  <button {...props} type="button" className={cn('notes-icon-button', className)} aria-label={label} title={label}>
    {children}
  </button>
);

export const ResourceGlyph: React.FC<{ type: ResourceType; size?: number; id?: string }> = ({ type, size = 15, id }) =>
  type === 'note'
    ? <NoteGlyph noteId={id} size={size} fallback={<FileText size={size} aria-hidden />} />
    : <TreeStructure size={size} aria-hidden />;

export interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeKey: string | null;
  /** 分屏时左侧主窗格当前打开的标签 key（与 rightTabKey 共同标识双窗格打开态） */
  mainActiveKey?: string | null;
  rightTabKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void | Promise<boolean>;
  onReorder: (draggedKey: string, targetKey: string, position: TabDropPosition) => void;
  onOpenContextMenu: (key: string, x: number, y: number, trigger: HTMLElement) => void;
  /** Double-clicking the empty strip area (browser-style) creates a new note. */
  onNewTab?: () => void;
  contextMenuKey: string | null;
  sidebarWidth: string;
  saveStates: Map<string, SaveState>;
  /** 标题栏右端的笔记页面级操作位（见 NotesChromeSlotContext） */
  actionsSlotRef?: React.Ref<HTMLDivElement>;
  /** 反向链接 / 局部图谱面板开关 */
  backlinksOpen?: boolean;
  onToggleBacklinks?: () => void;
}

export const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  tabs,
  activeKey,
  mainActiveKey = null,
  rightTabKey,
  onActivate,
  onClose,
  onReorder,
  onOpenContextMenu,
  onNewTab,
  contextMenuKey,
  sidebarWidth,
  saveStates,
  actionsSlotRef,
  backlinksOpen = false,
  onToggleBacklinks,
}) => {
  const { t } = useTranslation('workbench');
  const stripRef = useRef<HTMLDivElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; position: TabDropPosition } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowMenuPosition, setOverflowMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  const dismissOverflow = useCallback((event: Event) => {
    if (event.target instanceof Node && overflowRef.current?.contains(event.target)) return;
    if (event.target instanceof Node && overflowMenuRef.current?.contains(event.target)) return;
    setOverflowOpen(false);
  }, []);
  useEventRegistry(overflowOpen ? [
    { target: 'document', type: 'pointerdown', listener: dismissOverflow },
  ] : [], [overflowOpen, dismissOverflow]);

  useEffect(() => {
    if (!overflowOpen) return;
    const menu = overflowMenuRef.current;
    const selected = menu?.querySelector<HTMLButtonElement>('[role="menuitem"][data-active="true"]')
      ?? menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    selected?.focus();
  }, [overflowOpen]);

  const handleOverflowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isComposingKeyEvent(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOverflowOpen(false);
      overflowRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(overflowMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabs.length]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      strip.scrollLeft += delta;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  const focusTab = (event: React.KeyboardEvent, index: number) => {
    const buttons = event.currentTarget
      .closest('[data-notes-tabstrip]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!buttons?.length) return;
    const button = buttons.item((index + buttons.length) % buttons.length);
    button?.focus();
    button?.click();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number, key: string) => {
    if (event.defaultPrevented || isComposingKeyEvent(event)) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(event, index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(event, index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTab(event, 0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTab(event, tabs.length - 1);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void onClose(key);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onOpenContextMenu(key, bounds.left, bounds.bottom, event.currentTarget);
    }
  };

  const clearTabDrag = () => {
    setDraggedKey(null);
    setDropTarget(null);
  };

  const hasActiveTab = tabs.some((tab) => tab.key === activeKey);
  const isSplitMode = Boolean(rightTabKey);
  const disambiguatedLabels = useMemo(() => disambiguateTabTitles(tabs), [tabs]);

  return (
    <div className="notes-titlebar-tabs" style={{ '--notes-titlebar-sidebar-width': sidebarWidth } as React.CSSProperties}>
      <div
        ref={stripRef}
        className="notes-tabstrip scrollbar-none"
        data-notes-tabstrip
        role="tablist"
        aria-label={t('notesWorkspace.tabs.aria', 'Open files')}
        onDoubleClick={(event) => {
          // 仅拦截真正的空白条区域：已有 tab 时双击空白＝浏览器式新建；
          // 各 tab 自己 stopPropagation，不会走到这里。没有 tab 时保留
          // 标题栏双击缩放的窗壳语义。
          if (!onNewTab || tabs.length === 0 || event.target !== event.currentTarget) return;
          event.preventDefault();
          event.stopPropagation();
          onNewTab();
        }}
      >
        {tabs.map((tab, index) => {
          const saveState = saveStates.get(tab.key) ?? 'saved';
          const isMainSplitTab = isSplitMode && tab.key === mainActiveKey;
          const isRightSplitTab = tab.key === rightTabKey;
          const isTabbable = hasActiveTab ? tab.key === activeKey : index === 0;
          return (
            <div
              className="notes-tab"
              data-active={tab.key === activeKey ? 'true' : 'false'}
              data-main-split={isMainSplitTab ? 'true' : 'false'}
              data-right-split={isRightSplitTab ? 'true' : 'false'}
              data-pinned={tab.pinned ? 'true' : 'false'}
              data-save-state={saveState}
              data-drop-position={dropTarget?.key === tab.key ? dropTarget.position : undefined}
              key={tab.key}
              draggable
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => {
                event.preventDefault();
                const trigger = event.currentTarget.querySelector<HTMLElement>('[role="tab"]') ?? event.currentTarget;
                onOpenContextMenu(tab.key, event.clientX, event.clientY, trigger);
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.key);
                setDraggedKey(tab.key);
              }}
              onDragOver={(event) => {
                if (!draggedKey || draggedKey === tab.key) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const bounds = event.currentTarget.getBoundingClientRect();
                setDropTarget({
                  key: tab.key,
                  position: event.clientX >= bounds.left + bounds.width / 2 ? 'after' : 'before',
                });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropTarget((current) => current?.key === tab.key ? null : current);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const target = dropTarget?.key === tab.key
                  ? dropTarget
                  : { key: tab.key, position: 'before' as const };
                if (draggedKey && draggedKey !== target.key) onReorder(draggedKey, target.key, target.position);
                clearTabDrag();
              }}
              onDragEnd={clearTabDrag}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                void onClose(tab.key);
              }}
            >
              <button
                type="button"
                role="tab"
                title={tab.title}
                aria-label={tab.title || undefined}
                aria-selected={tab.key === activeKey}
                aria-haspopup="menu"
                aria-expanded={contextMenuKey === tab.key}
                aria-controls={contextMenuKey === tab.key ? 'notes-tab-context-menu' : undefined}
                aria-description={tab.pinned
                  ? t('notesWorkspace.tabs.pinned', 'Pinned')
                  : undefined}
                tabIndex={isTabbable ? 0 : -1}
                onClick={() => onActivate(tab.key)}
                onKeyDown={(event) => handleKeyDown(event, index, tab.key)}
              >
                <ResourceGlyph type={tab.type} id={tab.id} size={14} />
                {(() => {
                  const label = disambiguatedLabels.get(tab.key);
                  if (label?.disambiguated) {
                    return (
                      <span className="notes-tab-label" data-notes-tab-label data-disambiguated="true">
                        {label.prefixHint ? <span className="notes-tab-label-prefix">{label.prefixHint}</span> : null}
                        <span className="notes-tab-label-suffix">{label.distinguishing}</span>
                      </span>
                    );
                  }
                  return (
                    <span className="notes-tab-label" data-notes-tab-label data-disambiguated="false">
                      {tab.title}
                    </span>
                  );
                })()}
                {tab.pinned && (
                  <PushPin
                    className="notes-tab-pin"
                    size={11}
                    weight="fill"
                    aria-hidden
                  />
                )}
                {saveState !== 'saved' && (
                  <i
                    className="notes-tab-state"
                    aria-label={t(`notesWorkspace.saveState.${saveState}`)}
                    title={t(`notesWorkspace.saveState.${saveState}`)}
                  />
                )}
              </button>
              <IconButton label={t('notesWorkspace.tabs.close', { defaultValue: 'Close {{title}}', title: tab.title })} onClick={() => void onClose(tab.key)}>
                <X size={12} />
              </IconButton>
            </div>
          );
        })}
      </div>
      {tabs.length > 0 && (
        <div className="notes-tabs-overflow" ref={overflowRef}>
          <IconButton
            label={t('notesWorkspace.tabs.showAll', 'Show all open files')}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={(event) => {
              if (overflowOpen) {
                setOverflowOpen(false);
                return;
              }
              const bounds = event.currentTarget.getBoundingClientRect();
              setOverflowMenuPosition({
                top: bounds.bottom - 2,
                right: Math.max(8, window.innerWidth - bounds.right),
              });
              setOverflowOpen(true);
            }}
          >
            <List size={15} />
          </IconButton>
          {overflowOpen && overflowMenuPosition && createPortal(
            <CustomScrollArea
              ref={overflowMenuRef}
              className="notes-tabs-overflow-menu"
              viewportClassName="notes-tabs-overflow-menu-viewport"
              viewportProps={{ role: 'menu', 'aria-label': t('notesWorkspace.tabs.showAll', 'Show all open files'), onKeyDown: handleOverflowKeyDown }}
              style={overflowMenuPosition}
              fullHeight={false}
              trackOffsetTop={4}
              trackOffsetBottom={4}
              trackOffsetRight={2}
            >
              {tabs.map((tab) => {
                const overflowSaveState = saveStates.get(tab.key) ?? 'saved';
                const isMainSplitTab = isSplitMode && tab.key === mainActiveKey;
                const isRightSplitTab = tab.key === rightTabKey;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    key={tab.key}
                    title={tab.title}
                    data-active={tab.key === activeKey ? 'true' : 'false'}
                    data-main-split={isMainSplitTab ? 'true' : 'false'}
                    data-right-split={isRightSplitTab ? 'true' : 'false'}
                    data-save-state={overflowSaveState}
                    onClick={() => {
                      setOverflowOpen(false);
                      overflowRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                      onActivate(tab.key);
                    }}
                  >
                    <ResourceGlyph type={tab.type} id={tab.id} size={14} />
                    <span>{tab.title}</span>
                    {isMainSplitTab && (
                      <span className="notes-tab-split-badge" data-pane="main">
                        {t('notesWorkspace.tabs.splitLeftBadge', { defaultValue: '左' })}
                      </span>
                    )}
                    {isRightSplitTab && (
                      <span className="notes-tab-split-badge" data-pane="right">
                        {t('notesWorkspace.tabs.splitRightBadge', { defaultValue: '右' })}
                      </span>
                    )}
                    {tab.pinned && <PushPin className="notes-tab-pin" size={11} weight="fill" aria-hidden />}
                    {overflowSaveState !== 'saved' && (
                      <i
                        className="notes-tab-state"
                        aria-label={t(`notesWorkspace.saveState.${overflowSaveState}`)}
                        title={t(`notesWorkspace.saveState.${overflowSaveState}`)}
                      />
                    )}
                  </button>
                );
              })}
            </CustomScrollArea>,
            document.body,
          )}
        </div>
      )}
      {onToggleBacklinks && (
        <button
          type="button"
          className="notes-chrome-backlinks-btn"
          data-active={backlinksOpen ? 'true' : undefined}
          aria-pressed={Boolean(backlinksOpen)}
          aria-label={t('notes:workspace.linksAndGraph', { defaultValue: '反向链接 / 图谱' })}
          title={t('notes:workspace.linksAndGraph', { defaultValue: '反向链接 / 图谱' })}
          onClick={onToggleBacklinks}
        >
          <LinkSimple size={14} aria-hidden />
          <span>{t('notes:workspace.linksAndGraph', { defaultValue: '反向链接 / 图谱' })}</span>
        </button>
      )}
      {actionsSlotRef && <div ref={actionsSlotRef} className="notes-tab-actions-slot notes-titlebar-actions" data-tab-actions-slot />}
    </div>
  );
};

export const WorkspaceTabStrip = WorkspaceTabs;

export interface WorkspaceTabContextMenuProps {
  menuRef: React.RefObject<HTMLDivElement | null>;
  menu: TabContextMenu;
  target: WorkspaceTab;
  isRightSplit: boolean;
  canOpenRightSplit: boolean;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  onTogglePin: (key: string) => void;
  onToggleRightSplit: (key: string) => void;
  onCloseTab: (key: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseRight: (key: string) => void;
  onDismissAndRestoreFocus: () => void;
}

export const WorkspaceTabContextMenu: React.FC<WorkspaceTabContextMenuProps> = ({
  menuRef,
  menu,
  target,
  isRightSplit,
  canOpenRightSplit,
  canCloseOthers,
  canCloseRight,
  onTogglePin,
  onToggleRightSplit,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
  onDismissAndRestoreFocus,
}) => {
  const { t } = useTranslation('workbench');
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isComposingKeyEvent(event)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={menuRef}
      id="notes-tab-context-menu"
      className="notes-context-menu notes-tab-context-menu"
      role="menu"
      aria-label={target.title}
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={handleMenuKeyDown}
    >
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={Boolean(target.pinned)}
        onClick={() => {
          onTogglePin(target.key);
          onDismissAndRestoreFocus();
        }}
      >
        {target.pinned ? <PushPinSlash size={14} aria-hidden /> : <PushPin size={14} aria-hidden />}
        <span className="notes-context-menu-label">
          {target.pinned
            ? t('notesWorkspace.tabs.menu.unpin', 'Unpin')
            : t('notesWorkspace.tabs.menu.pin', 'Pin')}
        </span>
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={isRightSplit}
        disabled={!isRightSplit && !canOpenRightSplit}
        onClick={() => {
          onToggleRightSplit(target.key);
          onDismissAndRestoreFocus();
        }}
      >
        <SidebarSimple size={14} aria-hidden />
        <span className="notes-context-menu-label">
          {isRightSplit
            ? t('notesWorkspace.tabs.menu.closeRightSplit', 'Close right split')
            : t('notesWorkspace.tabs.menu.openInRightSplit', 'Open in right split')}
        </span>
      </button>
      <div role="separator" className="notes-context-menu-separator" />
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        onClick={() => {
          onCloseTab(target.key);
          onDismissAndRestoreFocus();
        }}
      >
        <span className="notes-context-menu-label">{t('notesWorkspace.tabs.menu.close', 'Close')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canCloseOthers}
        onClick={() => {
          onCloseOthers(target.key);
          onDismissAndRestoreFocus();
        }}
      >
        <span className="notes-context-menu-label">
          {t('notesWorkspace.tabs.closeOthers', 'Close other tabs')}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canCloseRight}
        onClick={() => {
          onCloseRight(target.key);
          onDismissAndRestoreFocus();
        }}
      >
        <span className="notes-context-menu-label">
          {t('notesWorkspace.tabs.closeTabsToRight', 'Close tabs to the right')}
        </span>
      </button>
    </div>
  );
};
