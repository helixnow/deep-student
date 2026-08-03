/**
 * WindowBody（P3 / O9）— 生命周期感知的应用内容挂载壳。
 *
 * 四档策略（设计文档 §5.1）：
 * - focused / visible：正常挂载，isActive / isVisible 通过 props 下传给应用；
 * - background：DOM 保留，visibility:hidden + content-visibility:hidden，渲染成本归零；
 * - frozen：卸载整棵应用子树，只渲染「已休眠」玻璃占位卡，点击唤醒（focusWindow + 解冻）。
 *
 * O9：挂载 useWindowLifecycleAnim；frozen 玻璃卡 + 唤醒淡入；关窗走动画编排。
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoonStars } from '@phosphor-icons/react';
import { useWindowStore } from '../core/windowStore';
import {
  recomputeLifecycles,
  useWindowLifecycle,
  useWindowRenderHint,
} from '../core/scheduler';
import { appRegistry } from '../core/appRegistry';
import { WindowErrorBoundary } from './WindowErrorBoundary';
import {
  requestCloseAnimated,
  useWindowLifecycleAnim,
} from '../hooks/useWindowLifecycleAnim';
import './WindowLifecycle.css';
import {
  clearWindowActivation,
  markWindowActivationPending,
  markWindowActivationReady,
} from '../core/workbenchBus';

const ActivationPendingMarker: React.FC<{ windowId: string }> = ({ windowId }) => {
  useEffect(() => {
    markWindowActivationPending(windowId);
    // 宿主卸载（关窗/冻结）时删除条目，而不是再次置 pending：
    // stale `false` 会让后续 activate 白等 10s 超时。
    return () => clearWindowActivation(windowId);
  }, [windowId]);
  return null;
};

const ActivationReadyMarker: React.FC<{ windowId: string }> = ({ windowId }) => {
  useEffect(() => {
    markWindowActivationReady(windowId);
    // App 子树卸载 = 不再可送达；回到 pending 会误导 waiter，这里直接收口。
    // 若只是重挂载（Suspense 重试），PendingMarker 会重新登记。
    return () => markWindowActivationPending(windowId);
  }, [windowId]);
  return null;
};

const SuspenseFallback: React.FC = () => {
  const { t } = useTranslation('workbench');
  return (
    <div
      className="flex h-full w-full items-center justify-center gap-2 text-xs opacity-60"
      data-wb-loading
    >
      <span
        aria-hidden
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
      {t('workbench:window.loading')}
    </div>
  );
};

const FrozenPlaceholder: React.FC<{
  title: string;
  icon: React.ReactNode;
  onWake: () => void;
}> = ({ title, icon, onWake }) => {
  const { t } = useTranslation('workbench');
  return (
    <button
      type="button"
      onClick={onWake}
      data-wb-frozen-placeholder
      className="wb-body-frozen"
      aria-label={t('workbench:window.frozenWakeAria')}
    >
      <span className="wb-body-frozen-card wb-glass wb-glass-highlight">
        <span className="wb-body-frozen-icon" aria-hidden>
          {icon ?? <MoonStars size={36} weight="duotone" />}
        </span>
        <span className="wb-body-frozen-title">
          {title || t('workbench:window.frozenTitle')}
        </span>
        <span className="wb-body-frozen-hint">
          {t('workbench:window.frozenHint')}
        </span>
      </span>
    </button>
  );
};

export interface WindowBodyProps {
  windowId: string;
}

export const WindowBody: React.FC<WindowBodyProps> = ({ windowId }) => {
  const { t } = useTranslation('workbench');
  const lifecycle = useWindowLifecycle(windowId);
  const win = useWindowStore((s) => s.windows[windowId]);
  const launchPayload = useWindowStore((s) => s.launchPayloads[windowId]);

  useWindowLifecycleAnim(windowId);

  const prevLifecycleRef = useRef(lifecycle);
  const [wakeIn, setWakeIn] = useState(false);

  useEffect(() => {
    const prev = prevLifecycleRef.current;
    prevLifecycleRef.current = lifecycle;
    if (prev === 'frozen' && lifecycle !== 'frozen') {
      setWakeIn(true);
    }
  }, [lifecycle]);

  const handleWakeAnimEnd = useCallback((event: React.AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setWakeIn(false);
  }, []);

  const handleTitleChange = useCallback(
    (title: string) => {
      useWindowStore.getState().setTitle(windowId, title);
    },
    [windowId],
  );

  const handleRequestClose = useCallback(() => {
    void requestCloseAnimated(windowId);
  }, [windowId]);

  const handleWake = useCallback(() => {
    const store = useWindowStore.getState();
    store.focusWindow(windowId);
    // 乐观解冻：scheduler（P1）随后会全量重算；此处保证点击即恢复
    if (store.lifecycles[windowId] === 'frozen') {
      store.setLifecycles({ ...store.lifecycles, [windowId]: 'focused' });
    }
    recomputeLifecycles();
  }, [windowId]);

  const def = useMemo(() => (win ? appRegistry.get(win.typeId) : undefined), [win?.typeId]);
  const { throttleMs } = useWindowRenderHint(windowId);
  const isActive = lifecycle === 'focused';
  const isVisible = lifecycle === 'focused' || lifecycle === 'visible';
  const hidden = lifecycle === 'background';
  // 仅可见窗需要节流提示；hidden/frozen 已由壳层停绘。
  // hidden 窗另以 isSuspended 显式下传「已停绘」语义：React 树仍全速跑，
  // 重应用（如 Chat 流式）可据此暂停纯视觉提交（缓冲不丢，回可见即补渲）。
  const renderThrottleMs = isVisible ? throttleMs : 0;

  if (!win) return null;

  if (lifecycle === 'frozen') {
    return (
      <FrozenPlaceholder
        title={win.title}
        icon={def?.icon ?? null}
        onWake={handleWake}
      />
    );
  }

  if (!def) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-xs opacity-60"
        data-wb-unknown-app
      >
        {t('workbench:window.unknownApp', { typeId: win.typeId })}
      </div>
    );
  }

  const App = def.render;

  return (
    <div
      className={['h-full w-full', wakeIn ? 'wb-body-wake-in' : ''].filter(Boolean).join(' ')}
      data-wb-window-body
      data-lifecycle={lifecycle}
      onAnimationEnd={wakeIn ? handleWakeAnimEnd : undefined}
      style={
        hidden
          ? { visibility: 'hidden', contentVisibility: 'hidden' }
          : undefined
      }
    >
      <ActivationPendingMarker windowId={windowId} />
      <WindowErrorBoundary windowId={windowId}>
        <Suspense fallback={<SuspenseFallback />}>
          <>
            <App
              windowId={windowId}
              instanceKey={win.instanceKey}
              launchPayload={launchPayload}
              isActive={isActive}
              isVisible={isVisible}
              renderThrottleMs={renderThrottleMs}
              isSuspended={hidden}
              onTitleChange={handleTitleChange}
              requestClose={handleRequestClose}
            />
            <ActivationReadyMarker windowId={windowId} />
          </>
        </Suspense>
      </WindowErrorBoundary>
    </div>
  );
};

export default WindowBody;
