/**
 * Browser session 生命周期 hook（B2a）
 *
 * chrome 挂载时 hydrate；卸载不自动关 session（由 canClose / 显式 close 负责）。
 * R2-10：订阅 browser:control-mode-changed，镜像与 Rust 权威一致。
 */
import { useEffect } from 'react';

import { ensureBrowserControlModeSync } from '../controlModeSync';
import { useBrowserSessionStore } from '../sessionStore';
import type { BrowserLaunchPayload } from '../types';

export function useBrowserSession(options?: {
  /** 挂载时从 Rust 拉状态 */
  hydrateOnMount?: boolean;
  launchPayload?: unknown;
}) {
  const hydrateOnMount = options?.hydrateOnMount ?? true;
  const hydrateFromRust = useBrowserSessionStore((s) => s.hydrateFromRust);
  const applyLaunchPayload = useBrowserSessionStore((s) => s.applyLaunchPayload);
  const sessionId = useBrowserSessionStore((s) => s.sessionId);
  const currentUrl = useBrowserSessionStore((s) => s.currentUrl);
  const title = useBrowserSessionStore((s) => s.title);
  const canGoBack = useBrowserSessionStore((s) => s.canGoBack);
  const canGoForward = useBrowserSessionStore((s) => s.canGoForward);
  const controlMode = useBrowserSessionStore((s) => s.controlMode);
  const loading = useBrowserSessionStore((s) => s.loading);
  const lastError = useBrowserSessionStore((s) => s.lastError);
  const addressDraft = useBrowserSessionStore((s) => s.addressDraft);
  const contentVisible = useBrowserSessionStore((s) => s.contentVisible);

  const navigate = useBrowserSessionStore((s) => s.navigate);
  const back = useBrowserSessionStore((s) => s.back);
  const forward = useBrowserSessionStore((s) => s.forward);
  const reload = useBrowserSessionStore((s) => s.reload);
  const takeOver = useBrowserSessionStore((s) => s.takeOver);
  const showContent = useBrowserSessionStore((s) => s.showContent);
  const setAddressDraft = useBrowserSessionStore((s) => s.setAddressDraft);
  const closeSession = useBrowserSessionStore((s) => s.closeSession);

  useEffect(() => {
    if (!hydrateOnMount) return;
    void hydrateFromRust();
  }, [hydrateFromRust, hydrateOnMount]);

  useEffect(() => {
    return ensureBrowserControlModeSync();
  }, []);

  useEffect(() => {
    if (options?.launchPayload == null) return;
    applyLaunchPayload(options.launchPayload as BrowserLaunchPayload);
  }, [applyLaunchPayload, options?.launchPayload]);

  return {
    sessionId,
    currentUrl,
    title,
    canGoBack,
    canGoForward,
    controlMode,
    loading,
    lastError,
    addressDraft,
    contentVisible,
    navigate,
    back,
    forward,
    reload,
    takeOver,
    showContent,
    setAddressDraft,
    closeSession,
    hydrateFromRust,
  };
}
