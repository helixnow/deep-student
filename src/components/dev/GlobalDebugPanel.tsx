import { createPortal } from 'react-dom';
import { NotionButton } from '@/components/ui/NotionButton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug } from '@phosphor-icons/react';
import clsx from 'clsx';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { getDebugEnabled } from '../../utils/emitDebug';
import type { DebugEvent } from '../../utils/emitDebug';
import './GlobalDebugPanel.css';

import DebugPanelHost from '../../debug-panel/DebugPanelHost';

type StreamEventDetail = DebugEvent & {
  ts?: number;
  phase?: string | null;
  streamId?: string;
  targetMessageId?: string;
};

const TOGGLE_POS_STORAGE_KEY = 'dstu-debug-toggle-pos';

const GlobalDebugPanel = () => {
  const debugEnabled = useMemo(() => getDebugEnabled(), []);
  const { t } = useTranslation('common');
  // visible 控制面板是否展开（true）或隐藏（false）
  const [visible, setVisible] = useState(false);
  // panelMounted 一旦为 true 就永远不会变回 false，确保面板保活
  const [panelMounted, setPanelMounted] = useState(false);
  const [hasUnseenEvent, setHasUnseenEvent] = useState(false);
  const [togglePortalEl, setTogglePortalEl] = useState<HTMLElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const [currentStreamId, setCurrentStreamId] = useState<string | undefined>();
  const visibleRef = useRef(false);

  // 悬浮球拖拽状态
  const [togglePos, setTogglePos] = useState<{ x: number; y: number }>(() => {
    try {
      const stored = localStorage.getItem(TOGGLE_POS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return parsed;
        }
      }
    } catch {}
    return { x: window.innerWidth - 60, y: window.innerHeight - 60 };
  });
  const [isDraggingToggle, setIsDraggingToggle] = useState(false);
  const toggleDragStart = useRef({ dx: 0, dy: 0, moved: false });

  // 在测试/autorun参数存在时自动挂载面板宿主（即使不可见也会创建插件，便于autorun）
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const params = url.searchParams;
      const testMode = params.get('test') === 'true' || params.get('test-mode') === 'true';
      const debugPlugin = params.get('debug-plugin');
      const autorun = params.get('autorun') === 'true';
      if ((testMode || autorun || debugPlugin === 'chat-test-runner') && !panelMounted) {
        setPanelMounted(true);
      }
    } catch {}
  }, [panelMounted]);

  const openPanel = useCallback(() => {
    setPanelMounted(true);
    setVisible(true);
    visibleRef.current = true;
    setHasUnseenEvent(false);
  }, []);

  const hidePanel = useCallback(() => {
    setVisible(false);
    visibleRef.current = false;
  }, []);

  const togglePanel = useCallback(() => {
    if (visibleRef.current) {
      hidePanel();
    } else {
      openPanel();
    }
  }, [hidePanel, openPanel]);

  useEffect(() => {
    if (!debugEnabled) return;

    const handleStreamEvent = (event: Event) => {
      const detail = (event as CustomEvent<StreamEventDetail>).detail;
      if (!detail) return;
      const metaStreamId =
        detail.streamId ||
        (detail.meta && (detail.meta.streamId || detail.meta.businessId));
      if (metaStreamId) {
        setCurrentStreamId(String(metaStreamId));
      }
      if (!visibleRef.current) {
        setHasUnseenEvent(true);
      }
    };

    const win = window as any;
    win.addEventListener('DSTU_STREAM_EVENT', handleStreamEvent, false);

    return () => {
      win.removeEventListener('DSTU_STREAM_EVENT', handleStreamEvent, false);
    };
  }, [debugEnabled]);

  useEffect(() => {
    if (!debugEnabled) return;

    const handleToggleEvent = (event?: CustomEvent<{ visible?: boolean }>) => {
      const explicit = event?.detail?.visible;
      if (typeof explicit === 'boolean') {
        if (explicit) {
          openPanel();
        } else {
          hidePanel();
        }
      } else {
        togglePanel();
      }
    };
    const handleOpen = () => openPanel();
    const handleHide = () => hidePanel();

    const win = window as any;

    win.DSTU_OPEN_DEBUGGER = handleOpen;
    win.DSTU_CLOSE_DEBUGGER = handleHide;
    win.DSTU_TOGGLE_DEBUGGER = togglePanel;
    win.__DSTU_OPEN_DEBUGGER__ = handleOpen;
    win.__DSTU_CLOSE_DEBUGGER__ = handleHide;
    win.__DSTU_TOGGLE_DEBUGGER__ = togglePanel;

    win.addEventListener(
      'DSTU_TOGGLE_DEBUGGER',
      handleToggleEvent as EventListener,
    );
    win.addEventListener('DSTU_OPEN_DEBUGGER', handleOpen as EventListener);
    win.addEventListener('DSTU_CLOSE_DEBUGGER', handleHide as EventListener);

    return () => {
      if (win.DSTU_OPEN_DEBUGGER === handleOpen) delete win.DSTU_OPEN_DEBUGGER;
      if (win.DSTU_CLOSE_DEBUGGER === handleHide)
        delete win.DSTU_CLOSE_DEBUGGER;
      if (win.DSTU_TOGGLE_DEBUGGER === togglePanel)
        delete win.DSTU_TOGGLE_DEBUGGER;
      if (win.__DSTU_OPEN_DEBUGGER__ === handleOpen)
        delete win.__DSTU_OPEN_DEBUGGER__;
      if (win.__DSTU_CLOSE_DEBUGGER__ === handleHide)
        delete win.__DSTU_CLOSE_DEBUGGER__;
      if (win.__DSTU_TOGGLE_DEBUGGER__ === togglePanel)
        delete win.__DSTU_TOGGLE_DEBUGGER__;

      win.removeEventListener(
        'DSTU_TOGGLE_DEBUGGER',
        handleToggleEvent as EventListener,
      );
      win.removeEventListener('DSTU_OPEN_DEBUGGER', handleOpen as EventListener);
      win.removeEventListener(
        'DSTU_CLOSE_DEBUGGER',
        handleHide as EventListener,
      );
    };
  }, [debugEnabled, hidePanel, openPanel, togglePanel]);

  useEffect(() => {
    if (!debugEnabled) return;

    const shortcut = (event: KeyboardEvent) => {
      const key = String(event.key || '').toLowerCase();
      if ((event.altKey || event.ctrlKey) && event.shiftKey && key === 'd') {
        event.preventDefault();
        togglePanel();
      }
    };

    window.addEventListener('keydown', shortcut);
    return () => {
      window.removeEventListener('keydown', shortcut);
    };
  }, [debugEnabled, togglePanel]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'dstu-debug-toggle-portal';
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '0';
    el.style.height = '0';
    el.style.zIndex = '2147483600';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    setTogglePortalEl(el);
    return () => {
      try {
        document.body.removeChild(el);
      } catch {}
      setTogglePortalEl(null);
    };
  }, []);

  // 悬浮球拖拽逻辑
  useEffect(() => {
    if (!isDraggingToggle) return;

    const handleMove = (ev: MouseEvent) => {
      const dx = Math.abs(ev.clientX - (togglePos.x + toggleDragStart.current.dx));
      const dy = Math.abs(ev.clientY - (togglePos.y + toggleDragStart.current.dy));
      if (dx > 3 || dy > 3) {
        toggleDragStart.current.moved = true;
      }
      setTogglePos({
        x: Math.max(0, Math.min(window.innerWidth - 44, ev.clientX - toggleDragStart.current.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 44, ev.clientY - toggleDragStart.current.dy)),
      });
    };

    const handleUp = () => {
      setIsDraggingToggle(false);
      try {
        localStorage.setItem(TOGGLE_POS_STORAGE_KEY, JSON.stringify(togglePos));
      } catch {}
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isDraggingToggle, togglePos]);

  // 窗口 resize 时 clamp 位置
  useEffect(() => {
    const clamp = () => {
      setTogglePos(prev => ({
        x: Math.min(prev.x, Math.max(0, window.innerWidth - 44)),
        y: Math.min(prev.y, Math.max(0, window.innerHeight - 44)),
      }));
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  if (!debugEnabled) return null;

  const tooltipContent = (
    <>
      <div className="dstu-debug-toggle__tooltip-label">
        {visible ? t('debug_panel.close_hint') : t('debug_panel.open_hint')}
      </div>
      {hasUnseenEvent && !visible && (
        <div className="dstu-debug-toggle__tooltip-sub">
          {t('debug_panel.new_events')}
        </div>
      )}
      {currentStreamId && (
        <div className="dstu-debug-toggle__tooltip-sub">
          {t('debug_panel.current_stream', { id: currentStreamId })}
        </div>
      )}
    </>
  );

  const handleToggleMouseDown = (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    toggleDragStart.current = {
      dx: ev.clientX - togglePos.x,
      dy: ev.clientY - togglePos.y,
      moved: false,
    };
    setIsDraggingToggle(true);
  };

  const handleToggleClick = () => {
    if (toggleDragStart.current.moved) {
      toggleDragStart.current.moved = false;
      return;
    }
    togglePanel();
  };

  // 面板未显示时显示悬浮球
  const toggleButton = !visible ? (
    <CommonTooltip content={tooltipContent} className="dstu-debug-toggle__tooltip">
      <NotionButton
        ref={toggleBtnRef}
        variant="ghost" size="icon" iconOnly
        className={clsx(
          'dstu-debug-toggle',
          hasUnseenEvent && 'dstu-debug-toggle--pulse',
          isDraggingToggle && 'dstu-debug-toggle--dragging',
        )}
        aria-label={t('debug_panel.open')}
        aria-pressed={visible}
        onMouseDown={handleToggleMouseDown}
        onClick={handleToggleClick}
        style={{
          pointerEvents: 'auto',
          position: 'fixed',
          left: togglePos.x,
          top: togglePos.y,
          right: 'auto',
          bottom: 'auto',
          cursor: isDraggingToggle ? 'grabbing' : 'grab',
          userSelect: 'none',
          transition: isDraggingToggle ? 'none' : 'transform 0.2s, box-shadow 0.2s, border-color 0.2s',
        }}
      >
        <Bug className="dstu-debug-toggle__icon" aria-hidden="true" />
        <span
          className={clsx(
            'dstu-debug-toggle__status',
            hasUnseenEvent && 'dstu-debug-toggle__status--active',
          )}
/>
      </NotionButton>
    </CommonTooltip>
  ) : null;

  return (
    <>
      {togglePortalEl && toggleButton && createPortal(toggleButton, togglePortalEl)}

      {panelMounted && (
        <DebugPanelHost
          visible={visible}
          onClose={hidePanel}
          currentStreamId={currentStreamId}
/>
      )}
    </>
  );
};

export default GlobalDebugPanel;
