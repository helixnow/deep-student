/**
 * SystemWindowShared（O18）— 系统应用窗口共享呈现件
 *
 * - WbSysSkeleton：应用形态骨架屏（sidebar / list / dashboard / surface 四变体），
 *   替代 lazy 加载期的通用转圈——形态与目标页面布局一致，加载完成无跳变；
 * - WbSysFade：内容就绪淡入壳（transform + opacity，引用 O1 缓动 token）；
 * - WorkbenchSidebarLayout：所有 OS 子应用共用的「侧栏 + 内容」窗口布局。宽窗并排；
 *   窄窗（compact 档）侧栏收纳为左缘玻璃抽屉——这是 legacy 页面在
 *   窗口化后拿不到的紧凑布局（legacy 断点全看视口）；
 * - WbSysActivityStrip：「任务进行中」窗口顶部活动条（transform 跑马，
 *   reduced-motion / minimal 材质档降级为静态细条）。
 *
 * 全部新类以 wb-sys- 前缀隔离；不触碰 workbench.css 契约类。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SidebarSimple, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { WbSysSizeClass } from './useWbSysSize';
import './SystemWindowShared.css';

// ============================================================================
// 骨架屏
// ============================================================================

export type WbSysSkeletonVariant = 'sidebar' | 'list' | 'dashboard' | 'surface';

const SkeletonBones: React.FC<{ variant: WbSysSkeletonVariant }> = ({ variant }) => {
  switch (variant) {
    case 'sidebar':
      // 侧栏 + 内容两栏（待办 / 设置）
      return (
        <div className="wb-sys-skel-split">
          <div className="wb-sys-skel-aside">
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '72%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '58%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '66%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '48%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '62%' }} />
          </div>
          <div className="wb-sys-skel-main">
            <span className="wb-sys-bone wb-sys-bone-title" style={{ width: '38%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '86%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '74%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '80%' }} />
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '52%' }} />
          </div>
        </div>
      );
    case 'dashboard':
      // 标题 + 指标卡 + 列表行（制卡任务）
      return (
        <div className="wb-sys-skel-main wb-sys-skel-pad">
          <span className="wb-sys-bone wb-sys-bone-title" style={{ width: '32%' }} />
          <div className="wb-sys-skel-cards">
            <span className="wb-sys-bone wb-sys-bone-card" />
            <span className="wb-sys-bone wb-sys-bone-card" />
          </div>
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '92%' }} />
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '84%' }} />
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '88%' }} />
        </div>
      );
    case 'surface':
      // 工具栏 + 大画布（沙箱）
      return (
        <div className="wb-sys-skel-main wb-sys-skel-pad">
          <div className="wb-sys-skel-toolbar">
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: 160 }} />
            <span className="wb-sys-bone wb-sys-bone-chip" />
          </div>
          <span className="wb-sys-bone wb-sys-bone-canvas" />
        </div>
      );
    case 'list':
    default:
      // 工具栏 + 均匀列表行（技能 / 模板）
      return (
        <div className="wb-sys-skel-main wb-sys-skel-pad">
          <div className="wb-sys-skel-toolbar">
            <span className="wb-sys-bone wb-sys-bone-row" style={{ width: 140 }} />
            <span className="wb-sys-bone wb-sys-bone-chip" />
            <span className="wb-sys-bone wb-sys-bone-chip" />
          </div>
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '90%' }} />
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '82%' }} />
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '86%' }} />
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '68%' }} />
          <span className="wb-sys-bone wb-sys-bone-row" style={{ width: '76%' }} />
        </div>
      );
  }
};

/** 应用形态骨架屏（lazy 加载期占位） */
export const WbSysSkeleton: React.FC<{ variant: WbSysSkeletonVariant }> = ({ variant }) => {
  const { t } = useTranslation('workbench');
  return (
    <div
      className={`wb-sys-skeleton wb-sys-skeleton-${variant}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={t('workbench:window.loading')}
      data-wb-sys-skeleton={variant}
    >
      <SkeletonBones variant={variant} />
    </div>
  );
};

// ============================================================================
// 内容就绪淡入
// ============================================================================

/** lazy 内容挂载后的一次性淡入（替代骨架 → 内容的硬切） */
export const WbSysFade: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div className={`wb-sys-fade${className ? ` ${className}` : ''}`}>{children}</div>
);

// ============================================================================
// 侧栏 + 内容布局（窄窗抽屉化）
// ============================================================================

export interface WorkbenchSidebarLayoutProps {
  /** 侧栏内容（legacy Shell 侧栏组件） */
  sidebar: React.ReactNode;
  /** 主内容 */
  children: React.ReactNode;
  /** 来自 useWbSysSize 的宽度分级 */
  sizeClass: WbSysSizeClass;
  /** 抽屉/侧栏的无障碍名称（如「待办导航」） */
  navLabel: string;
  /** Compact drawer controlled state. Wide and medium sidebars remain visible. */
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
}

/**
 * 宽窗（wide）：侧栏 272px 并排（--wb-sidebar-width，对话标准）；
 * 中窗（medium）：侧栏收窄到 240px；
 * 窄窗（compact）：侧栏离场，改为左缘把手 + 玻璃抽屉。
 *
 * 抽屉面板**始终挂载**（visibility 隐藏）：lazy 侧栏随首屏一起加载，
 * 打开抽屉绝不触发 Suspense 回退。
 */
export const WorkbenchSidebarLayout: React.FC<WorkbenchSidebarLayoutProps> = ({
  sidebar,
  children,
  sizeClass,
  navLabel,
  drawerOpen: controlledDrawerOpen,
  onDrawerOpenChange,
}) => {
  const { t } = useTranslation('workbench');
  const [internalDrawerOpen, setInternalDrawerOpen] = useState(false);
  const drawerOpen = controlledDrawerOpen ?? internalDrawerOpen;
  const setDrawerOpen = useCallback((open: boolean) => {
    setInternalDrawerOpen(open);
    onDrawerOpenChange?.(open);
  }, [onDrawerOpenChange]);
  const drawerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const compact = sizeClass === 'compact';
  const wasCompactRef = useRef(compact);

  // 离开 compact 档时收起抽屉，避免回宽窗后残留状态
  useEffect(() => {
    if (wasCompactRef.current && !compact) setDrawerOpen(false);
    wasCompactRef.current = compact;
  }, [compact, setDrawerOpen]);

  // 焦点管理：开抽屉焦点入面板（aria-modal 对话框契约），关抽屉还给把手
  useEffect(() => {
    if (drawerOpen) {
      const drawer = drawerRef.current;
      const handle = handleRef.current;
      drawer?.focus();
      return () => {
        // 仅当焦点仍滞留在抽屉内时才归还，避免抢走用户点出去的焦点
        const active = document.activeElement;
        if (active && drawer?.contains(active)) {
          handle?.focus();
        }
      };
    }
    return undefined;
  }, [drawerOpen]);

  const handleEscape = useCallback((event: Event) => {
    const e = event as KeyboardEvent;
    if (drawerOpen && e.key === 'Escape') {
      e.stopPropagation();
      setDrawerOpen(false);
    }
  }, [drawerOpen, setDrawerOpen]);

  // capture：先于 workbench 全局快捷键（Esc 退出俯瞰等）消费掉
  useEventRegistry(drawerOpen ? [{
    target: 'document',
    type: 'keydown',
    listener: handleEscape,
    options: true,
  }] : [], [drawerOpen, handleEscape]);

  /*
   * 抽屉内点中导航项（button / a / [role=button]）后自动收起。
   * 让侧栏先处理选中，再在下一帧收抽屉，避免打断其事件流。
   * 📱 例外：祖先带 data-wb-drawer-stay 的操作（列表过滤/清空搜索/刷新等，
   * 其结果就显示在抽屉内）不自动收起，否则窄窗下这些功能等于不可用。
   */
  const handleDrawerClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const actionable = target?.closest('button, a, [role="button"]');
    if (actionable && !actionable.closest('[data-wb-drawer-stay]')) {
      window.setTimeout(() => setDrawerOpen(false), 0);
    }
  }, [setDrawerOpen]);

  const openLabel = t('workbench:apps.system.showNav');
  const closeLabel = t('workbench:apps.system.hideNav');

  return (
    <div className="wb-sys-split" data-wb-sys-drawer-mode={compact ? 'true' : 'false'}>
      {/* 并排侧栏（compact 档由 CSS 离场） */}
      <div className="wb-sys-aside" aria-hidden={compact}>
        {!compact && sidebar}
      </div>

      <div className="wb-sys-content">{children}</div>

      {compact && (
        <>
          {/* 左缘玻璃把手：窄窗唯一的导航入口 */}
          <DsButton
            ref={handleRef}
            variant="ghost"
            size="icon"
            iconOnly
            className="wb-sys-drawer-handle"
            onClick={() => setDrawerOpen(true)}
            aria-label={openLabel}
            aria-expanded={drawerOpen}
            title={openLabel}
            data-wb-sys-drawer-handle
          >
            <SidebarSimple size={14} weight="bold" aria-hidden />
          </DsButton>

          {/* 遮罩 */}
          <div
            className="wb-sys-scrim"
            data-open={drawerOpen ? 'true' : 'false'}
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />

          {/* 抽屉（常驻挂载，visibility 切换） */}
          <div
            ref={drawerRef}
            className="wb-sys-drawer"
            data-open={drawerOpen ? 'true' : 'false'}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={navLabel}
            aria-hidden={!drawerOpen}
            onClick={handleDrawerClick}
            data-wb-sys-drawer
          >
            <div className="wb-sys-drawer-head">
              <span className="wb-sys-drawer-title">{navLabel}</span>
              <DsButton
                type="button"
                variant="ghost"
                size="icon"
                iconOnly
                className="wb-sys-drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label={closeLabel}
                title={closeLabel}
              >
                <X size={13} weight="bold" aria-hidden />
              </DsButton>
            </div>
            <CustomScrollArea
              className="wb-sys-drawer-body"
              viewportClassName="wb-sys-drawer-body-viewport"
              trackOffsetTop={6}
              trackOffsetBottom={6}
              trackOffsetRight={3}
            >
              {sidebar}
            </CustomScrollArea>
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================================
// 任务进行中活动条
// ============================================================================

/**
 * 窗口顶缘 2px 活动条：active 时渐显 + 高光跑马（translate3d 循环）。
 * pointer-events:none，不遮挡内容交互；reduced-motion / minimal 档静态化。
 */
export const WbSysActivityStrip: React.FC<{ active: boolean; label?: string }> = ({
  active,
  label,
}) => (
  <div
    className="wb-sys-activity"
    data-active={active ? 'true' : 'false'}
    role={active ? 'status' : undefined}
    aria-label={active ? label : undefined}
    aria-hidden={!active}
    data-wb-sys-activity
  >
    <span className="wb-sys-activity-runner" aria-hidden />
  </div>
);
