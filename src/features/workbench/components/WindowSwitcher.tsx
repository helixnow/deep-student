/**
 * WindowSwitcher — Ctrl+Tab 窗口循环切换器（P6 交付，O8 打磨）
 *
 * 行为（设计文档 §6.3/§6.4）：
 * - Ctrl+Tab 按住进入会话并循环（Shift 反向），松开 Ctrl 聚焦选中窗口；
 * - 顺序 = lastFocusedAt 最近使用优先（会话开启时冻结快照，避免循环中重排）；
 * - 键盘循环逻辑在 useWorkbenchShortcuts 内（O12 名下），本组件为展示层 + 鼠标支持。
 *
 * O8 打磨点（样式见 WindowSwitcher.css，类名 wb-switcher- 前缀）：
 * - 玻璃焦点框为单一元素，在图标间以 transform 平滑滑动（直写 DOM，
 *   不进 React state；CSS transition 中途重定向天然支持快速连按）；
 * - 选中项放大高亮（tile scale）+ 标题淡入切换；
 * - 进出动画：进入 scale+fade；退出区分 commit（松开聚焦，选中 tile
 *   外扩脉冲 + 玻璃条微放淡出）与 cancel（Esc/失焦，微缩淡出）。
 *   会话关闭后保留一帧冻结快照播放退出动画，animationend / 超时兜底卸载；
 *   退出中再次开启会话立即恢复 live 渲染（快速连按不中断）；
 * - 大量窗口：图标条换行、三行封顶纵向滚动、选中项自动 scrollIntoView；
 * - 可选窗口内容缩略（`thumbnails` prop，占位式迷你窗口卡，默认关闭）；
 * - 动效仅 transform/opacity，时长在 minimal 材质档 / reduced-motion 下归零。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowStore } from '../core/windowStore';
import { useWorkbenchOverlay } from '../core/shortcuts';
import { appRegistry } from '../core/appRegistry';
import type { WorkbenchWindow } from '../core/types';
import { announceWorkbench } from '../hooks/useWorkbenchA11y';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import './WindowSwitcher.css';

export interface WindowSwitcherProps {
  /**
   * 候选项渲染窗口内容缩略卡（按窗口宽高比的占位式迷你窗口 + 应用图标）
   * 而非纯图标。默认关闭（macOS Cmd+Tab 心智）；由 O20 决定是否接线。
   */
  thumbnails?: boolean;
}

interface SwitcherSession {
  ids: string[];
  index: number;
}

interface ExitSession extends SwitcherSession {
  /** true = 松开 Ctrl / 点击聚焦了选中窗口；false = Esc / 失焦取消 */
  commit: boolean;
}

/** 退出动画兜底卸载时长（> --wb-switcher-out-duration，animationend 为快路径） */
const EXIT_FALLBACK_MS = 260;

/** 缩略卡宽高比夹取范围，避免极端窗口比例撑破候选格 */
const THUMB_RATIO_MIN = 0.6;
const THUMB_RATIO_MAX = 2.2;

/** 关闭态 selector 的稳定空引用：窗口变更不再触发重渲染 */
const EMPTY_WINDOWS: Record<string, WorkbenchWindow> = {};

const WindowSwitcherComponent: React.FC<WindowSwitcherProps> = ({ thumbnails = false }) => {
  const { t } = useTranslation();
  const switcherOpen = useWorkbenchOverlay((s) => s.switcherOpen);
  const switcherIds = useWorkbenchOverlay((s) => s.switcherIds);
  const switcherIndex = useWorkbenchOverlay((s) => s.switcherIndex);
  const setSwitcherIndex = useWorkbenchOverlay((s) => s.setSwitcherIndex);
  const closeSwitcher = useWorkbenchOverlay((s) => s.closeSwitcher);

  /** 会话关闭后用于播放退出动画的冻结快照 */
  const [exitSession, setExitSession] = useState<ExitSession | null>(null);

  // 关闭且无退出会话时不消费 windows（恒返回同一空引用，窗口变更不重渲染）
  const active = switcherOpen || exitSession !== null;
  const windows = useWindowStore((s) => (active ? s.windows : EMPTY_WINDOWS));
  const focusWindow = useWindowStore((s) => s.focusWindow);

  /** live 会话的最新快照（退出效果读取；渲染期不写 ref，只在 effect 中同步） */
  const lastSessionRef = useRef<SwitcherSession | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  /** 焦点框是否已定位过：首次直接落位（不从 0,0 滑入），之后才平滑滑动 */
  const framePlacedRef = useRef(false);
  useLiquidGlassLens(barRef, switcherOpen || Boolean(exitSession));

  // 声明顺序即执行顺序：先记录 live 会话，再处理关闭 → 退出快照
  useEffect(() => {
    if (switcherOpen) {
      lastSessionRef.current = { ids: switcherIds, index: switcherIndex };
    }
  }, [switcherOpen, switcherIds, switcherIndex]);

  // 步进时 polite 播报当前窗口标题（便于 AT 跟随循环；仅随 index/ids 变化）
  useEffect(() => {
    if (!switcherOpen) return;
    const id = switcherIds[switcherIndex];
    if (!id) return;
    const win = useWindowStore.getState().windows[id];
    if (!win) return;
    const def = appRegistry.get(win.typeId);
    const title =
      win.title || (def ? t(def.nameKey, win.typeId) : win.typeId);
    if (title) announceWorkbench(title, 'polite');
  }, [switcherOpen, switcherIds, switcherIndex, t]);

  useEffect(() => {
    if (switcherOpen) {
      setExitSession(null);
      return undefined;
    }
    const last = lastSessionRef.current;
    lastSessionRef.current = null;
    if (!last) return undefined;
    // commit 判定：关闭与 focusWindow 同批提交（commitSwitcher / handlePick），
    // effect 执行时焦点栈已更新 → 栈顶 === 选中 id 即为「松开聚焦」
    const selectedId = last.ids[last.index];
    const stack = useWindowStore.getState().focusStack;
    const commit = Boolean(selectedId) && stack[stack.length - 1] === selectedId;
    setExitSession({ ...last, commit });
    const timer = window.setTimeout(() => setExitSession(null), EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [switcherOpen]);

  const live = switcherOpen;
  const session: SwitcherSession | null = live
    ? { ids: switcherIds, index: switcherIndex }
    : exitSession;

  // 玻璃焦点框滑动：直写 DOM（transform + transition），不进 React state。
  // 每次渲染后重测（条目少、offsetLeft/offsetTop 读取廉价）；重复设置相同
  // transform 不会打断进行中的过渡，快速连按时过渡中途重定向保持流畅。
  useLayoutEffect(() => {
    if (!session) {
      framePlacedRef.current = false;
      return;
    }
    const strip = stripRef.current;
    const frame = frameRef.current;
    if (!strip || !frame) return;
    const el = strip.querySelector<HTMLElement>('.wb-switcher-item[aria-selected="true"]');
    if (!el) {
      // 选中窗口已被关闭：隐藏焦点框（会话索引仍以冻结快照为准）
      frame.style.opacity = '0';
      return;
    }
    frame.style.opacity = '';
    frame.style.width = `${el.offsetWidth}px`;
    frame.style.height = `${el.offsetHeight}px`;
    const transform = `translate3d(${el.offsetLeft}px, ${el.offsetTop}px, 0)`;
    if (framePlacedRef.current) {
      frame.style.transform = transform;
    } else {
      framePlacedRef.current = true;
      frame.style.transition = 'none';
      frame.style.transform = transform;
      // 强制 reflow 使首次落位立即生效，随后恢复 transition 供后续滑动
      void frame.offsetWidth;
      frame.style.transition = '';
    }
    // 大量窗口滚动时保证选中项可见（jsdom 无 scrollIntoView，运行时才有）
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });

  const handlePick = useCallback(
    (id: string, index: number) => {
      if (!useWorkbenchOverlay.getState().switcherOpen) return;
      // 点选项即为提交项：同步冻结快照，保证退出动画的 commit 脉冲落在被点项上
      lastSessionRef.current = { ids: useWorkbenchOverlay.getState().switcherIds, index };
      closeSwitcher();
      focusWindow(id);
    },
    [closeSwitcher, focusWindow],
  );

  const handleHover = useCallback(
    (index: number) => {
      setSwitcherIndex(index);
    },
    [setSwitcherIndex],
  );

  const handleBarAnimationEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.animationName === 'wb-switcher-out' || e.animationName === 'wb-switcher-out-commit') {
      setExitSession(null);
    }
  }, []);

  if (!session) return null;

  // 会话快照中的窗口可能已被关闭，过滤失效 id（选中索引仍以快照为准）
  const entries = session.ids
    .map((id, index) => ({ id, index, win: windows[id] as WorkbenchWindow | undefined }))
    .filter((e): e is { id: string; index: number; win: WorkbenchWindow } => Boolean(e.win));

  if (entries.length === 0) return null;

  const selectedId = session.ids[session.index];
  const selectedWin = selectedId ? windows[selectedId] : undefined;
  const selectedTitle = selectedWin
    ? (selectedWin.title
      || t(appRegistry.get(selectedWin.typeId)?.nameKey ?? '', selectedWin.typeId))
    : '';

  return (
    <div
      className="wb-switcher-root pointer-events-none absolute inset-0 flex items-center justify-center"
      data-wb-switcher-root
      data-phase={live ? 'open' : 'closing'}
      data-commit={!live && exitSession?.commit ? 'true' : undefined}
      data-thumbs={thumbnails ? 'true' : undefined}
      aria-hidden={live ? undefined : true}
    >
      <div
        ref={barRef}
        className="wb-switcher-bar wb-glass wb-glass-highlight wb-glass-lens pointer-events-auto"
        role="listbox"
        aria-label={t('workbench:switcher.title')}
        aria-activedescendant={selectedId ? `wb-switcher-item-${selectedId}` : undefined}
        onAnimationEnd={handleBarAnimationEnd}
      >
        <div ref={stripRef} className="wb-switcher-strip" data-testid="wb-switcher-strip">
          <div
            ref={frameRef}
            className="wb-switcher-frame"
            data-testid="wb-switcher-frame"
            aria-hidden="true"
          />
          {entries.map(({ id, index, win }) => {
            const def = appRegistry.get(win.typeId);
            const isSelected = index === session.index;
            const label = win.title || (def ? t(def.nameKey, win.typeId) : win.typeId);
            const icon = def?.icon ?? (
              <span className="wb-switcher-icon-fallback">
                {(label || win.typeId).slice(0, 1)}
              </span>
            );
            const thumbRatio = win.frame.h > 0
              ? Math.min(THUMB_RATIO_MAX, Math.max(THUMB_RATIO_MIN, win.frame.w / win.frame.h))
              : 4 / 3;
            return (
              <button
                key={id}
                id={`wb-switcher-item-${id}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-minimized={win.minimized ? 'true' : undefined}
                title={label}
                className="wb-switcher-item"
                tabIndex={-1}
                onMouseEnter={() => handleHover(index)}
                onClick={() => handlePick(id, index)}
              >
                <span className="wb-switcher-tile">
                  {thumbnails ? (
                    <span
                      className="wb-switcher-thumb"
                      data-testid={`wb-switcher-thumb-${id}`}
                      style={{ aspectRatio: `${thumbRatio}` }}
                    >
                      <span className="wb-switcher-thumb-bar" />
                      <span className="wb-switcher-thumb-body" />
                      <span className="wb-switcher-thumb-icon">{icon}</span>
                    </span>
                  ) : (
                    <span className="wb-switcher-icon">{icon}</span>
                  )}
                </span>
                {win.minimized && (
                  <span
                    className="wb-switcher-min-dot"
                    aria-label={t('workbench:switcher.minimized')}
                  />
                )}
              </button>
            );
          })}
        </div>
        <div className="wb-switcher-caption">
          <div key={selectedId ?? 'none'} className="wb-switcher-title">
            {selectedTitle || '\u00A0'}
          </div>
          <div className="wb-switcher-hint">
            {t('workbench:switcher.hint')}
          </div>
        </div>
      </div>
    </div>
  );
};

export const WindowSwitcher = React.memo(WindowSwitcherComponent);
WindowSwitcher.displayName = 'WindowSwitcher';

export default WindowSwitcher;
