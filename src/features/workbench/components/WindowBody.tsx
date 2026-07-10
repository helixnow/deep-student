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
      {t('workbench:window.loading', '加载中…')}
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
      aria-label={t('workbench:window.frozenWakeAria', '点击唤醒休眠窗口')}
    >
      <span className="wb-body-frozen-card wb-glass wb-glass-highlight">
        <span className="wb-body-frozen-icon" aria-hidden>
          {icon ?? <MoonStars size={36} weight="duotone" />}
        </span>
        <span className="wb-body-frozen-title">
          {title || t('workbench:window.frozenTitle', '窗口已休眠')}
        </span>
        <span className="wb-body-frozen-hint">
          {t('workbench:window.frozenHint', '为节省内存已暂停此窗口，点击唤醒')}
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
  // 仅可见窗需要节流提示；hidden/frozen 已由壳层停绘
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
        {t('workbench:window.unknownApp', '未知应用类型：{{typeId}}', { typeId: win.typeId })}
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
      <WindowErrorBoundary windowId={windowId}>
        <Suspense fallback={<SuspenseFallback />}>
          <App
            windowId={windowId}
            instanceKey={win.instanceKey}
            launchPayload={launchPayload}
            isActive={isActive}
            isVisible={isVisible}
            renderThrottleMs={renderThrottleMs}
            onTitleChange={handleTitleChange}
            requestClose={handleRequestClose}
          />
        </Suspense>
      </WindowErrorBoundary>
    </div>
  );
};

export default WindowBody;
