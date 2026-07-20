/**
 * 待办应用窗口（P9 薄包装 → O18 窗口化打磨 → 外壳 SOTA 轮次）
 *
 * 复用 `TodoContentView`（桌面端只渲染主面板）+ `TodoShellSidebar`
 * （legacy 模式下该侧栏由 App 壳渲染在导航槽位；窗口内自带一份，
 * 通过局部清零 --shell-titlebar-height/--shell-layout-gap 去掉壳位顶部留白）。
 *
 * 本轮打磨：
 * - 侧栏分隔线可拖拽调宽（200–400px，双击复位，宽度持久化到 localStorage）；
 * - 窄窗（<640px）不再收纳为玻璃抽屉，降级为 48px 常驻图标栏
 *   （TodoIconRail：智能视图 / 定时任务 / 清单 popover / 回收站）；
 * - 为避免 compact ↔ medium 切换时 TodoContentView 重挂载（会重置
 *   activeList），WorkbenchSidebarLayout 恒以非 compact 档渲染，侧栏槽位内
 *   自行在「完整侧栏 / 图标栏」间切换；useWbSysSize 的测量元素改为
 *   兄弟节点，绕开 `[data-wb-sys-size='compact'] .wb-sys-aside` 的 CSS 隐藏。
 */
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TodoContentView, TodoShellSidebar } from '@/features/todo';
import { TodoIconRail } from '@/features/todo/components/TodoIconRail';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WorkbenchSidebarLayout, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';

const SHELL_VAR_RESET = {
  '--shell-titlebar-height': '0px',
  '--shell-layout-gap': '0px',
} as React.CSSProperties;

// ============================================================================
// 侧栏宽度（拖拽 + 持久化）
// ============================================================================

const SIDEBAR_WIDTH_KEY = 'todo-window-sidebar-width';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 272;
/** 中窗（640–880px）下侧栏上限，给内容区留出呼吸空间 */
const SIDEBAR_MEDIUM_CAP = 300;
const RAIL_WIDTH = 48;

function clampSidebarWidth(width: number, max: number = SIDEBAR_MAX): number {
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
}

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // 持久化属增强能力，失败仅保留会话内宽度
  }
}

/**
 * 侧栏右缘拖拽把手（键盘可 ←/→ 步进，双击复位默认宽度）。
 * 拖拽过程走 onLiveResize（宿主直写 CSS 变量，零 React 重渲染），
 * 松手 / 键盘步进 / 双击走 onCommit（进 state + 持久化）。
 */
const SidebarResizeHandle: React.FC<{
  width: number;
  maxWidth: number;
  onLiveResize: (width: number) => void;
  onCommit: (width: number) => void;
}> = ({ width, maxWidth, onLiveResize, onCommit }) => {
  const { t } = useTranslation('todo');
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const label = t('sidebar.resizeHandle', '拖拽调整侧栏宽度');

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      className={[
        'absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none select-none',
        // 6px 视觉不变，透明伪元素横向外扩 12px 命中区（触屏可拖；宿主本身 absolute 已是定位上下文）
        "before:absolute before:inset-y-0 before:-inset-x-3 before:content-['']",
        'transition-colors duration-150',
        'hover:bg-[color:var(--interactive-hover)] active:bg-[color:var(--interactive-selected)]',
        'outline-none focus-visible:bg-[color:var(--interactive-hover)] focus-visible:ring-1 focus-visible:ring-ring',
      ].join(' ')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        onLiveResize(clampSidebarWidth(drag.startWidth + (e.clientX - drag.startX), maxWidth));
      }}
      onPointerUp={(e) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        dragRef.current = null;
        onCommit(clampSidebarWidth(drag.startWidth + (e.clientX - drag.startX), maxWidth));
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        onCommit(width);
      }}
      onLostPointerCapture={() => {
        // 正常 pointerup 已把 dragRef 清空；此处兜底系统级夺走捕获
        // （窗口拖拽/系统手势等）时的会话中断——回退到拖拽前宽度
        if (!dragRef.current) return;
        dragRef.current = null;
        onCommit(width);
      }}
      onDoubleClick={() => onCommit(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const delta = e.key === 'ArrowLeft' ? -16 : 16;
          onCommit(clampSidebarWidth(width + delta, maxWidth));
        }
        if (e.key === 'Home') {
          e.preventDefault();
          onCommit(SIDEBAR_DEFAULT);
        }
      }}
    />
  );
};

// ============================================================================
// TodoAppWindow
// ============================================================================

const TodoAppWindow: React.FC<AppWindowProps> = ({ launchPayload, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const { ref: sizeRef, sizeClass } = useWbSysSize();
  const compact = sizeClass === 'compact';

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);

  // 拖拽中直写 CSS 变量（不进 React state，缩放过程零重渲染）
  const applyLiveSidebarWidth = useCallback((width: number) => {
    const el = rootRef.current;
    if (!el) return;
    el.style.setProperty('--wb-sidebar-width', `${width}px`);
    el.style.setProperty('--wb-sidebar-width-medium', `${width}px`);
  }, []);
  const commitSidebarWidth = useCallback((width: number) => {
    applyLiveSidebarWidth(width);
    setSidebarWidth(width);
    persistSidebarWidth(width);
  }, [applyLiveSidebarWidth]);

  useEffect(() => {
    onTitleChange(t('workbench:apps.todo'));
  }, [onTitleChange, t]);

  const todoListId =
    launchPayload && typeof launchPayload === 'object' &&
    typeof (launchPayload as { todoListId?: unknown }).todoListId === 'string'
      ? (launchPayload as { todoListId: string }).todoListId
      : undefined;
  const initialView =
    launchPayload && typeof launchPayload === 'object' &&
    (launchPayload as { todoView?: unknown }).todoView === 'automations'
      ? 'automations' as const
      : undefined;

  const sidebarMax = sizeClass === 'medium' ? SIDEBAR_MEDIUM_CAP : SIDEBAR_MAX;
  const effectiveSidebarWidth = compact
    ? RAIL_WIDTH
    : Math.min(sidebarWidth, sidebarMax);

  const sidebarSlot = compact ? (
    <TodoIconRail className="h-full" />
  ) : (
    <div className="relative h-full w-full min-w-0">
      <TodoShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
      <SidebarResizeHandle
        width={effectiveSidebarWidth}
        maxWidth={sidebarMax}
        onLiveResize={applyLiveSidebarWidth}
        onCommit={commitSidebarWidth}
      />
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      style={{
        ...SHELL_VAR_RESET,
        '--wb-sidebar-width': `${effectiveSidebarWidth}px`,
        '--wb-sidebar-width-medium': `${effectiveSidebarWidth}px`,
      } as React.CSSProperties}
      data-wb-sys-app="todo"
    >
      {/* 尺寸测量用兄弟节点：data-wb-sys-size 落在这里而非布局祖先上，
          避免 compact 档的 CSS 把侧栏槽位整体 display:none（图标栏也要占位） */}
      <div ref={sizeRef} aria-hidden className="pointer-events-none absolute inset-0 -z-10" />
      <Suspense fallback={<WbSysSkeleton variant="sidebar" />}>
        <WbSysFade>
          <WorkbenchSidebarLayout
            sizeClass={compact ? 'medium' : sizeClass}
            navLabel={t('workbench:apps.system.todoNav')}
            sidebar={sidebarSlot}
          >
            <TodoContentView todoListId={todoListId} initialView={initialView} className="h-full" />
          </WorkbenchSidebarLayout>
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default TodoAppWindow;
