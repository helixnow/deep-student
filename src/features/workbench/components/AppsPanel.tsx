/**
 * AppsPanel（L4）— 全部应用发现面板
 *
 * - 玻璃面板 + 顶部搜索；列表 / 网格展示 appRegistry.list()
 * - Enter / 点击 → workbenchBus.launch({ typeId, reason: 'api' }) 并关闭
 * - Esc / 点遮罩关闭；方向键选择；Tab 焦点陷阱；reduced-motion / minimal 友好（见 CSS）
 *
 * 开合状态见 appsPanelStore（openAppsPanel / closeAppsPanel）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GridFour, List, MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { workbenchBus } from '../core/workbenchBus';
import type { AppDefinition } from '../core/types';
import { closeAppsPanel, useAppsPanelOpen } from './appsPanelStore';
import './AppsPanel.css';

/** 退场动画保留挂载时长（与 CSS --wb-apps-duration 对齐） */
export const APPS_PANEL_EXIT_MS = 200;

type ViewMode = 'grid' | 'list';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

export interface AppsPanelProps {
  className?: string;
}

const AppsPanelComponent: React.FC<AppsPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const open = useAppsPanelOpen();
  const registryVersion = useRegistryVersion();

  const [rendered, setRendered] = useState(open);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [activeIndex, setActiveIndex] = useState(0);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const apps = useMemo(() => {
    void registryVersion;
    return filterApps(appRegistry.list(), query, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registryVersion 驱动 list 刷新
  }, [registryVersion, query, t]);

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

  // 焦点：打开时聚焦搜索框；关闭时还原
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

  // Tab / Shift+Tab 焦点陷阱：循环在 dialog 内。
  // 注意：可点关闭的 backdrop 不可设 inert（inert 退出命中测试，真机点空白关不掉）；
  // AT 隐藏用 backdrop 上的 aria-hidden，勿用 inert。
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

  // 过滤结果变化时钳制选中下标
  useEffect(() => {
    setActiveIndex((i) => {
      if (apps.length === 0) return 0;
      return Math.min(i, apps.length - 1);
    });
  }, [apps]);

  // 选中项滚入视野
  useEffect(() => {
    if (!open || !rendered) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-wb-apps-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, rendered, viewMode]);

  const launchApp = (typeId: string) => {
    workbenchBus.launch({ typeId, reason: 'api' });
    closeAppsPanel();
  };

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAppsPanel();
      return;
    }

    if (apps.length === 0) return;
    const targetIsSearch = e.target === searchRef.current;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (viewMode === 'grid') {
        const cols = getGridColumnCount(listRef.current?.querySelector('.wb-apps-grid') ?? null);
        setActiveIndex((i) => wrapIndex(i + cols, apps.length));
      } else {
        setActiveIndex((i) => wrapIndex(i + 1, apps.length));
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (viewMode === 'grid') {
        const cols = getGridColumnCount(listRef.current?.querySelector('.wb-apps-grid') ?? null);
        setActiveIndex((i) => wrapIndex(i - cols, apps.length));
      } else {
        setActiveIndex((i) => wrapIndex(i - 1, apps.length));
      }
      return;
    }
    if (e.key === 'ArrowRight') {
      if (targetIsSearch) return;
      if (viewMode !== 'grid') return;
      e.preventDefault();
      setActiveIndex((i) => wrapIndex(i + 1, apps.length));
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (targetIsSearch) return;
      if (viewMode !== 'grid') return;
      e.preventDefault();
      setActiveIndex((i) => wrapIndex(i - 1, apps.length));
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
      setActiveIndex(apps.length - 1);
      return;
    }
    if (e.key === 'Enter') {
      // 搜索框 / 列表项 Enter 均启动当前选中
      const target = e.target as HTMLElement | null;
      if (target?.closest('button.wb-apps-item')) return; // 交给按钮自身 click
      e.preventDefault();
      const app = apps[activeIndex];
      if (app) launchApp(app.typeId);
    }
  };

  if (!rendered) return null;

  const listClass = viewMode === 'grid' ? 'wb-apps-grid' : 'wb-apps-list';
  // 焦点常驻搜索框：用 aria-activedescendant 告知 AT 当前选中的应用项
  const activeOptionId =
    apps.length > 0 && apps[activeIndex] ? `wb-apps-option-${apps[activeIndex].typeId}` : undefined;

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

        <div className="wb-apps-body" ref={listRef}>
          {apps.length === 0 ? (
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
          ) : (
            <ul
              id="wb-apps-listbox"
              className={listClass}
              role="listbox"
              aria-label={t('workbench:appsPanel.title')}
            >
              {apps.map((app, index) => {
                const name = t(app.nameKey, app.typeId);
                const active = index === activeIndex;
                return (
                  <li key={app.typeId} role="presentation">
                    <button
                      type="button"
                      role="option"
                      id={`wb-apps-option-${app.typeId}`}
                      className="wb-apps-item"
                      data-testid={`wb-apps-item-${app.typeId}`}
                      data-wb-apps-index={index}
                      data-wb-apps-active={active || undefined}
                      aria-selected={active}
                      onClick={() => launchApp(app.typeId)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className="wb-apps-item-icon" aria-hidden>
                        {app.icon}
                      </span>
                      <span className="wb-apps-item-name">{name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

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
