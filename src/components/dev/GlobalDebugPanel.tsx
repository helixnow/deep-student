import { createPortal } from 'react-dom';
import { NotionButton } from '@/components/ui/NotionButton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug } from 'lucide-react';
import clsx from 'clsx';
import { getDebugEnabled } from '../../utils/emitDebug';
import type { DebugEvent } from '../../utils/emitDebug';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/shad/Tooltip';
import './GlobalDebugPanel.css';

import DebugPanelHost from '../../debug-panel/DebugPanelHost';

type StreamEventDetail = DebugEvent & {
  ts?: number;
  phase?: string | null;
  streamId?: string;
  targetMessageId?: string;
};

const GlobalDebugPanel = () => {
  const debugEnabled = useMemo(() => getDebugEnabled(), []);
  const { t } = useTranslation('common');
  // visible 控制面板是否展开（true）或最小化为悬浮球（false）
  const [visible, setVisible] = useState(false);
  // panelMounted 一旦为 true 就永远不会变回 false，确保面板保活
  const [panelMounted, setPanelMounted] = useState(false);
  const [hasUnseenEvent, setHasUnseenEvent] = useState(false);
  const [togglePortalEl, setTogglePortalEl] = useState<HTMLElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const [currentStreamId, setCurrentStreamId] = useState<string | undefined>();
  const visibleRef = useRef(false);

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

  const minimizePanel = useCallback(() => {
    // 只是最小化，不卸载面板
    setVisible(false);
    visibleRef.current = false;
  }, []);

  const togglePanel = useCallback(() => {
    if (visibleRef.current) {
      minimizePanel();
    } else {
      openPanel();
    }
  }, [minimizePanel, openPanel]);

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
          minimizePanel();
        }
      } else {
        togglePanel();
      }
    };
    const handleOpen = () => openPanel();
    const handleMinimize = () => minimizePanel();

    const win = window as any;

    win.DSTU_OPEN_DEBUGGER = handleOpen;
    win.DSTU_CLOSE_DEBUGGER = handleMinimize;
    win.DSTU_TOGGLE_DEBUGGER = togglePanel;
    win.__DSTU_OPEN_DEBUGGER__ = handleOpen;
    win.__DSTU_CLOSE_DEBUGGER__ = handleMinimize;
    win.__DSTU_TOGGLE_DEBUGGER__ = togglePanel;

    win.addEventListener(
      'DSTU_TOGGLE_DEBUGGER',
      handleToggleEvent as EventListener,
    );
    win.addEventListener('DSTU_OPEN_DEBUGGER', handleOpen as EventListener);
    win.addEventListener('DSTU_CLOSE_DEBUGGER', handleMinimize as EventListener);

    return () => {
      if (win.DSTU_OPEN_DEBUGGER === handleOpen) delete win.DSTU_OPEN_DEBUGGER;
      if (win.DSTU_CLOSE_DEBUGGER === handleMinimize)
        delete win.DSTU_CLOSE_DEBUGGER;
      if (win.DSTU_TOGGLE_DEBUGGER === togglePanel)
        delete win.DSTU_TOGGLE_DEBUGGER;
      if (win.__DSTU_OPEN_DEBUGGER__ === handleOpen)
        delete win.__DSTU_OPEN_DEBUGGER__;
      if (win.__DSTU_CLOSE_DEBUGGER__ === handleMinimize)
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
        handleMinimize as EventListener,
      );
    };
  }, [debugEnabled, minimizePanel, openPanel, togglePanel]);

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
    el.style.right = '16px';
    el.style.bottom = '16px';
    el.style.zIndex = '2147483600';
    el.style.pointerEvents = 'auto';
    document.body.appendChild(el);
    setTogglePortalEl(el);
    return () => {
      try {
        document.body.removeChild(el);
      } catch {}
      setTogglePortalEl(null);
    };
  }, []);

  // 强制确保悬浮球样式不会被任何全局规则隐藏
  useEffect(() => {
    const applyStrongStyle = () => {
      const el = toggleBtnRef.current;
      if (!el) return;
      try {
        el.removeAttribute('hidden');
        el.style.setProperty('display', 'inline-flex', 'important');
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('pointer-events', 'auto', 'important');
        el.style.setProperty('position', 'fixed', 'important');
        el.style.setProperty('right', '16px', 'important');
        el.style.setProperty('bottom', '16px', 'important');
        el.style.setProperty('z-index', '2147483600', 'important');
      } catch {}
    };
    applyStrongStyle();
    const id = window.setInterval(applyStrongStyle, 500);
    return () => window.clearInterval(id);
  }, [togglePortalEl, visible]);

  if (!debugEnabled) return null;

  const toggleButton = (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <NotionButton
            ref={toggleBtnRef}
            variant="ghost" size="icon" iconOnly
            className={clsx(
              'dstu-debug-toggle',
              visible && 'dstu-debug-toggle--open',
              hasUnseenEvent && !visible && 'dstu-debug-toggle--pulse',
            )}
            aria-label={visible ? t('debug_panel.close') : t('debug_panel.open')}
            aria-pressed={visible}
            onClick={togglePanel}
            style={{ pointerEvents: 'auto' }}
          >
            <Bug className="dstu-debug-toggle__icon" aria-hidden="true" />
            <span
              className={clsx(
                'dstu-debug-toggle__status',
                hasUnseenEvent &&
                  !visible &&
                  'dstu-debug-toggle__status--active',
              )}
            />
          </NotionButton>
        </TooltipTrigger>
        <TooltipContent className="dstu-debug-toggle__tooltip">
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
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <>
      {togglePortalEl && createPortal(toggleButton, togglePortalEl)}

      {panelMounted && (
        <DebugPanelHost
          visible={visible}
          onClose={minimizePanel}
          currentStreamId={currentStreamId}
        />
      )}
    </>
  );
};

export default GlobalDebugPanel;
