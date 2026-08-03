/**
 * AppsPanel（L4）— Spotlight 式全局搜索（应用 / 命令 / 学习资源 / 聊天）
 *
 * - 玻璃面板 + 顶部搜索；无输入时网格 / 列表展示可独立启动的注册应用
 * - 有输入时分区展示：应用 / 命令 / 资源 / 聊天（内容检索需 ≥2 字符）
 * - 应用 / 命令为本地即时过滤；dstu / chat 走独立 250ms 防抖 providers
 * - Enter / 点击 → 对应 open()（launch / executeCommand / 资源窗 / chat 会话）并关闭
 * - OS 模式下它是唯一的搜索入口（CommandPaletteProvider 在 workbenchActive 时改道至此）
 *
 * 开合状态见 appsPanelStore（openAppsPanel / closeAppsPanel）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatCenteredText,
  File as FileIcon,
  GridFour,
  Lightning,
  List,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { workbenchBus } from '../core/workbenchBus';
import type { AppDefinition } from '../core/types';
import { useCommandPaletteSafe } from '@/command-palette/CommandPaletteProvider';
import { formatShortcut } from '@/command-palette/registry/shortcutUtils';
import type { Command } from '@/command-palette/registry/types';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  CONTENT_SEARCH_MIN_CHARS,
  GLOBAL_SEARCH_DEBOUNCE_MS,
  createChatProvider,
  createDstuProvider,
  openChatInWorkbench,
  openDstuInWorkbench,
  useAbortableDebouncedQuery,
  type GlobalSearchItem,
  type GlobalSearchKind,
  type WorkbenchSearchHost,
} from '../search/globalSearchProviders';
import { closeAppsPanel, useAppsPanelOpen } from './appsPanelStore';
import { hasWorkbenchAppIcon, WorkbenchAppIcon } from './WorkbenchAppIcon';
import './AppsPanel.css';

/** 退场动画保留挂载时长（与 CSS --wb-apps-duration 对齐） */
export const APPS_PANEL_EXIT_MS = 200;

type ViewMode = 'grid' | 'list';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.closest('[inert]')) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

/** 网格首行可见项数量 → 列数（auto-fill 布局下的可靠估算） */
export function getGridColumnCount(listEl: HTMLElement | null): number {
  if (!listEl) return 1;
  const items = listEl.querySelectorAll<HTMLElement>('[data-wb-apps-index]');
  if (items.length <= 1) return 1;
  const firstTop = items[0].getBoundingClientRect().top;
  let cols = 1;
  for (let i = 1; i < items.length; i++) {
    if (Math.abs(items[i].getBoundingClientRect().top - firstTop) > 1) break;
    cols += 1;
  }
  return Math.max(1, cols);
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function useRegistryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => appRegistry.subscribe(() => setVersion((v) => v + 1)), []);
  return version;
}

function filterApps(apps: AppDefinition[], query: string, t: (key: string, fallback: string) => string) {
  const q = query.trim().toLowerCase();
  const sorted = [...apps].sort((a, b) => {
    const na = t(a.nameKey, a.typeId);
    const nb = t(b.nameKey, b.typeId);
    return na.localeCompare(nb, undefined, { sensitivity: 'base' });
  });
  if (!q) return sorted;
  return sorted.filter((app) => {
    const name = t(app.nameKey, app.typeId).toLowerCase();
    return name.includes(q) || app.typeId.toLowerCase().includes(q);
  });
}

function itemTestId(item: GlobalSearchItem): string {
  switch (item.kind) {
    case 'app':
      return `wb-apps-item-${item.id.replace(/^app:/, '')}`;
    case 'command':
      return `wb-apps-command-${item.id.replace(/^command:/, '')}`;
    case 'dstu':
      return `wb-apps-dstu-${item.id.replace(/^dstu:/, '')}`;
    case 'chat':
      return `wb-apps-chat-${item.id.replace(/^chat:/, '')}`;
    default:
      return `wb-apps-result-${item.id}`;
  }
}

function itemOptionId(item: GlobalSearchItem): string {
  return `wb-apps-option-${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export interface AppsPanelProps {
  className?: string;
}

const SECTION_ORDER: GlobalSearchKind[] = ['app', 'command', 'dstu', 'chat'];

const AppsPanelComponent: React.FC<AppsPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const open = useAppsPanelOpen();
  const registryVersion = useRegistryVersion();
  const commandPalette = useCommandPaletteSafe();

  const [rendered, setRendered] = useState(open);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [activeIndex, setActiveIndex] = useState(0);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const searching = query.trim().length > 0;
  const contentSearchReady = query.trim().length >= CONTENT_SEARCH_MIN_CHARS;

  const launchableApps = useMemo(() => {
    void registryVersion;
    return appRegistry.list().filter((app) => app.showInLauncher !== false);
  }, [registryVersion]);

  const host = useMemo<WorkbenchSearchHost>(
    () => ({
      listLaunchableApps: () => launchableApps,
      appName: (app) => t(app.nameKey, app.typeId),
      searchCommands: (q) => {
        if (!commandPalette) return [];
        try {
          return commandPalette.searchCommands(q);
        } catch {
          return [];
        }
      },
      openApp: (typeId) => {
        workbenchBus.launch({ typeId, reason: 'api' });
        closeAppsPanel();
      },
      openCommand: (id) => {
        closeAppsPanel();
        void commandPalette?.executeCommand(id);
      },
      openDstu: (node) => {
        closeAppsPanel();
        openDstuInWorkbench(node);
      },
      openChat: (sessionId) => {
        closeAppsPanel();
        openChatInWorkbench(sessionId);
      },
      untitledSessionTitle: t('command_palette:untitled', 'Untitled'),
    }),
    [launchableApps, commandPalette, t],
  );

  const dstuProvider = useMemo(() => createDstuProvider(host), [host]);
  const chatProvider = useMemo(() => createChatProvider(host), [host]);

  const dstuState = useAbortableDebouncedQuery(
    query,
    open && searching,
    (q, signal) => dstuProvider.search(q, signal),
    {
      debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: CONTENT_SEARCH_MIN_CHARS,
      empty: [] as GlobalSearchItem[],
    },
  );

  const chatState = useAbortableDebouncedQuery(
    query,
    open && searching,
    (q, signal) => chatProvider.search(q, signal),
    {
      debounceMs: GLOBAL_SEARCH_DEBOUNCE_MS,
      minChars: CONTENT_SEARCH_MIN_CHARS,
      empty: [] as GlobalSearchItem[],
    },
  );

  const apps = useMemo(
    () => filterApps(launchableApps, query, t),
    [launchableApps, query, t],
  );

  const commands = useMemo<Command[]>(() => {
    if (!searching || !commandPalette) return [];
    try {
      return commandPalette
        .searchCommands(query)
        .filter((command) => command.id !== 'global.command-palette');
    } catch {
      return [];
    }
  }, [commandPalette, query, searching]);

  const appItems = useMemo<GlobalSearchItem[]>(
    () =>
      apps.map((app) => ({
        id: `app:${app.typeId}`,
        kind: 'app' as const,
        title: t(app.nameKey, app.typeId),
        subtitle: searching ? app.typeId : undefined,
        score: 1,
        open: () => host.openApp(app.typeId),
      })),
    [apps, host, searching, t],
  );

  const commandItems = useMemo<GlobalSearchItem[]>(
    () =>
      commands.map((command) => ({
        id: `command:${command.id}`,
        kind: 'command' as const,
        title: command.name,
        subtitle: command.description,
        score: 0.95,
        shortcut: command.shortcut,
        open: () => {
          void host.openCommand(command.id);
        },
      })),
    [commands, host],
  );

  const itemsByKind = useMemo(
    () => ({
      app: appItems,
      command: searching ? commandItems : [],
      dstu: searching ? dstuState.data : [],
      chat: searching ? chatState.data : [],
    }),
    [appItems, chatState.data, commandItems, dstuState.data, searching],
  );

  const items = useMemo<GlobalSearchItem[]>(() => {
    if (!searching) return appItems;
    return [
      ...itemsByKind.app,
      ...itemsByKind.command,
      ...itemsByKind.dstu,
      ...itemsByKind.chat,
    ];
  }, [appItems, itemsByKind, searching]);

  const loading = dstuState.loading || chatState.loading;
  const loadingByKind = {
    app: false,
    command: false,
    dstu: dstuState.loading,
    chat: chatState.loading,
  };

  // 开合：退场动画 + 重置搜索
  useEffect(() => {
    if (open) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setRendered(true);
      setQuery('');
      setActiveIndex(0);
      return undefined;
    }
    if (!rendered) return undefined;
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setRendered(false);
      setQuery('');
      setActiveIndex(0);
    }, APPS_PANEL_EXIT_MS);
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [open, rendered]);

  useEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.setTimeout(() => {
      searchRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => {
      window.clearTimeout(id);
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = getFocusable(dialog);
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? dialog.contains(active) : false;
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex((i) => {
      if (items.length === 0) return 0;
      return Math.min(i, items.length - 1);
    });
  }, [items]);

  useEffect(() => {
    if (!open || !rendered) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-wb-apps-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, rendered, viewMode, items]);

  const activateItem = (item: GlobalSearchItem | undefined) => {
    if (!item) return;
    void item.open();
  };

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAppsPanel();
      return;
    }

    if (items.length === 0) return;
    const targetIsSearch = e.target === searchRef.current;
    const gridNav = !searching && viewMode === 'grid';

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (gridNav) {
        const cols = getGridColumnCount(listRef.current?.querySelector('.wb-apps-grid') ?? null);
        setActiveIndex((i) => wrapIndex(i + cols, items.length));
      } else {
        setActiveIndex((i) => wrapIndex(i + 1, items.length));
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (gridNav) {
        const cols = getGridColumnCount(listRef.current?.querySelector('.wb-apps-grid') ?? null);
        setActiveIndex((i) => wrapIndex(i - cols, items.length));
      } else {
        setActiveIndex((i) => wrapIndex(i - 1, items.length));
      }
      return;
    }
    if (e.key === 'ArrowRight') {
      if (targetIsSearch) return;
      if (!gridNav) return;
      e.preventDefault();
      setActiveIndex((i) => wrapIndex(i + 1, items.length));
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (targetIsSearch) return;
      if (!gridNav) return;
      e.preventDefault();
      setActiveIndex((i) => wrapIndex(i - 1, items.length));
      return;
    }
    if (e.key === 'Home') {
      if (targetIsSearch) return;
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === 'End') {
      if (targetIsSearch) return;
      e.preventDefault();
      setActiveIndex(items.length - 1);
      return;
    }
    if (e.key === 'Enter') {
      const target = e.target as HTMLElement | null;
      if (target?.closest('button.wb-apps-item')) return;
      e.preventDefault();
      activateItem(items[activeIndex]);
    }
  };

  if (!rendered) return null;

  const listClass = viewMode === 'grid' ? 'wb-apps-grid' : 'wb-apps-list';
  const activeItem = items[activeIndex];
  const activeOptionId = activeItem ? itemOptionId(activeItem) : undefined;

  const sectionLabel = (kind: GlobalSearchKind): string => {
    switch (kind) {
      case 'app':
        return t('workbench:appsPanel.sectionApps');
      case 'command':
        return t('workbench:appsPanel.sectionCommands');
      case 'dstu':
        return t('workbench:appsPanel.sectionResources');
      case 'chat':
        return t('workbench:appsPanel.sectionChat');
      default:
        return kind;
    }
  };

  const kindIcon = (kind: GlobalSearchKind) => {
    switch (kind) {
      case 'command':
        return <Lightning size={22} weight="duotone" />;
      case 'dstu':
        return <FileIcon size={22} weight="duotone" />;
      case 'chat':
        return <ChatCenteredText size={22} weight="duotone" />;
      default:
        return null;
    }
  };

  const renderResultRow = (item: GlobalSearchItem, index: number) => {
    const active = index === activeIndex;
    const typeId = item.kind === 'app' ? item.id.replace(/^app:/, '') : null;
    return (
      <li key={item.id} role="presentation">
        <button
          type="button"
          role="option"
          id={itemOptionId(item)}
          className={cn('wb-apps-item', item.kind !== 'app' && 'wb-apps-command')}
          data-testid={itemTestId(item)}
          data-wb-apps-index={index}
          data-wb-apps-active={active || undefined}
          data-wb-apps-kind={item.kind}
          aria-selected={active}
          onClick={() => activateItem(item)}
          onMouseEnter={() => setActiveIndex(index)}
        >
          <span className="wb-apps-item-icon" aria-hidden>
            {item.kind === 'app' && typeId && hasWorkbenchAppIcon(typeId) ? (
              <WorkbenchAppIcon typeId={typeId} />
            ) : item.kind === 'app' && typeId ? (
              appRegistry.get(typeId)?.icon
            ) : (
              kindIcon(item.kind)
            )}
          </span>
          {item.kind === 'app' && !searching ? (
            <span className="wb-apps-item-name">{item.title}</span>
          ) : (
            <span className="wb-apps-command-text">
              <span className="wb-apps-item-name">{item.title}</span>
              {item.subtitle && (
                <span className="wb-apps-command-desc">{item.subtitle}</span>
              )}
            </span>
          )}
          {item.shortcut && (
            <kbd className="wb-apps-command-shortcut">{formatShortcut(item.shortcut)}</kbd>
          )}
        </button>
      </li>
    );
  };

  let flatOffset = 0;
  const sectionBlocks = SECTION_ORDER.map((kind) => {
    const sectionItems = itemsByKind[kind];
    const start = flatOffset;
    flatOffset += sectionItems.length;
    return { kind, sectionItems, start };
  });

  const showEmpty = searching && items.length === 0 && !loading;
  const showContentLoading = searching && contentSearchReady && loading && items.length === 0;

  return (
    <div
      className={cn('wb-apps-root', className)}
      data-wb-apps-open={open ? 'true' : 'false'}
      data-testid="wb-apps-panel"
      onKeyDown={onRootKeyDown}
    >
      <div
        className="wb-apps-backdrop"
        data-wb-apps-backdrop
        data-testid="wb-apps-backdrop"
        onClick={closeAppsPanel}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className="wb-glass wb-glass-highlight wb-apps-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench:appsPanel.title')}
        tabIndex={-1}
      >
        <div className="wb-apps-header">
          <h2 className="wb-apps-title">{t('workbench:appsPanel.title')}</h2>
          {/* 搜索态结果固定为分区列表，网格/列表切换不适用 → 隐藏死控件 */}
          {!searching && (
            <div className="wb-apps-view-toggle" role="group" aria-label={t('workbench:appsPanel.view')}>
              <button
                type="button"
                className="wb-apps-view-btn"
                aria-pressed={viewMode === 'grid'}
                aria-label={t('workbench:appsPanel.gridView')}
                data-testid="wb-apps-view-grid"
                onClick={() => setViewMode('grid')}
              >
                <GridFour size={16} weight="bold" />
              </button>
              <button
                type="button"
                className="wb-apps-view-btn"
                aria-pressed={viewMode === 'list'}
                aria-label={t('workbench:appsPanel.listView')}
                data-testid="wb-apps-view-list"
                onClick={() => setViewMode('list')}
              >
                <List size={16} weight="bold" />
              </button>
            </div>
          )}
          <button
            type="button"
            className="wb-apps-close"
            onClick={closeAppsPanel}
            aria-label={t('workbench:appsPanel.close')}
            data-testid="wb-apps-close"
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path
                d="M2 2 L10 10 M10 2 L2 10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="wb-apps-search-wrap">
          <MagnifyingGlass size={16} className="wb-apps-search-icon" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            className="wb-apps-search"
            data-testid="wb-apps-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder={t('workbench:appsPanel.searchPlaceholder')}
            aria-label={t('workbench:appsPanel.searchPlaceholder')}
            aria-controls="wb-apps-listbox"
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <CustomScrollArea
          className="wb-apps-body"
          viewportRef={listRef}
          viewportClassName="wb-apps-body-viewport"
          trackOffsetTop={4}
          trackOffsetBottom={12}
          trackOffsetRight={4}
        >
          {showContentLoading ? (
            <div className="wb-apps-loading" data-testid="wb-apps-loading" role="status">
              {t('workbench:appsPanel.searching')}
            </div>
          ) : showEmpty ? (
            <div className="wb-apps-empty" data-testid="wb-apps-empty" role="status">
              <span className="wb-apps-empty-icon" aria-hidden>
                <MagnifyingGlass size={20} />
              </span>
              <span className="wb-apps-empty-title">
                {t('workbench:appsPanel.empty')}
              </span>
              <span className="wb-apps-empty-hint">
                {t('workbench:appsPanel.emptyHint')}
              </span>
            </div>
          ) : !searching ? (
            <ul
              id="wb-apps-listbox"
              className={listClass}
              role="listbox"
              aria-label={t('workbench:appsPanel.title')}
            >
              {items.map((item, index) => renderResultRow(item, index))}
            </ul>
          ) : (
            <div
              id="wb-apps-listbox"
              className="wb-apps-results"
              role="listbox"
              aria-label={t('workbench:appsPanel.title')}
            >
              {sectionBlocks.map(({ kind, sectionItems, start }) => {
                if (sectionItems.length === 0) {
                  if (
                    (kind === 'dstu' || kind === 'chat') &&
                    contentSearchReady &&
                    loadingByKind[kind]
                  ) {
                    return (
                      <React.Fragment key={kind}>
                        <div className="wb-apps-section" role="presentation">
                          {sectionLabel(kind)}
                        </div>
                        <div
                          className="wb-apps-section-loading"
                          data-testid={`wb-apps-loading-${kind}`}
                          role="status"
                        >
                          {t('workbench:appsPanel.searching')}
                        </div>
                      </React.Fragment>
                    );
                  }
                  return null;
                }
                return (
                  <React.Fragment key={kind}>
                    <div className="wb-apps-section" role="presentation">
                      {sectionLabel(kind)}
                    </div>
                    <ul className="wb-apps-list" role="presentation">
                      {sectionItems.map((item, i) => renderResultRow(item, start + i))}
                    </ul>
                  </React.Fragment>
                );
              })}
              {loading && items.length > 0 && (
                <div
                  className="wb-apps-section-loading"
                  data-testid="wb-apps-loading-more"
                  role="status"
                >
                  {t('workbench:appsPanel.searching')}
                </div>
              )}
            </div>
          )}
        </CustomScrollArea>

        {searching ? (
          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="wb-apps-result-count"
          >
            {loading
              ? t('workbench:appsPanel.searching')
              : t('workbench:appsPanel.resultCount', '{{count}} results', {
                  count: items.length,
                })}
          </div>
        ) : null}

        <div className="wb-apps-footer">
          <span className="wb-apps-footer-hint">
            <kbd>↑↓←→</kbd>
            {t('workbench:appsPanel.hintSelect')}
          </span>
          <span className="wb-apps-footer-hint">
            <kbd>Enter</kbd>
            {t('workbench:appsPanel.hintOpen')}
          </span>
          <span className="wb-apps-footer-hint">
            <kbd>Esc</kbd>
            {t('workbench:appsPanel.hintClose')}
          </span>
        </div>
      </div>
    </div>
  );
};

export const AppsPanel = React.memo(AppsPanelComponent);
AppsPanel.displayName = 'AppsPanel';

export default AppsPanel;
