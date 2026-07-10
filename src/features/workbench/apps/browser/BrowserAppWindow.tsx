/**
 * 内置浏览器 chrome 窗（BROWSER · B2b）
 *
 * 工具条壳：AddressBar / NavControls / Agent·Take over / SessionHint。
 * 真实页面在独立 WebviewWindow（label `browser-content`），不进本窗 DOM。
 * 状态消费 `@/features/browser`（B2a sessionStore / useBrowserSession）。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  HandPalm,
  LockSimple,
  Robot,
} from '@phosphor-icons/react';
import { useBrowserSession } from '@/features/browser/hooks/useBrowserSession';
import type { BrowserControlMode } from '@/features/browser/types';
import type { AppWindowProps } from '../../core/types';
import { BROWSER_FOCUS_ADDRESS_EVENT } from './browserChromeEvents';
import './BrowserAppWindow.css';

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const NavControls: React.FC<{
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}> = ({ canGoBack, canGoForward, loading, onBack, onForward, onReload }) => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-nav" role="group" aria-label={t('browser.nav', '导航')}>
      <button
        type="button"
        className="wb-browser-icon-btn"
        disabled={!canGoBack || loading}
        onClick={onBack}
        aria-label={t('browser.back', '后退')}
        title={t('browser.back', '后退')}
      >
        <ArrowLeft size={16} weight="bold" />
      </button>
      <button
        type="button"
        className="wb-browser-icon-btn"
        disabled={!canGoForward || loading}
        onClick={onForward}
        aria-label={t('browser.forward', '前进')}
        title={t('browser.forward', '前进')}
      >
        <ArrowRight size={16} weight="bold" />
      </button>
      <button
        type="button"
        className="wb-browser-icon-btn"
        disabled={loading}
        onClick={onReload}
        aria-label={t('browser.reload', '刷新')}
        title={t('browser.reload', '刷新')}
      >
        <ArrowClockwise size={16} weight="bold" />
      </button>
    </div>
  );
};

const AddressBar: React.FC<{
  draft: string;
  loading: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
}> = ({ draft, loading, inputRef, onDraftChange, onSubmit }) => {
  const { t } = useTranslation('workbench');

  return (
    <form
      className="wb-browser-address"
      onSubmit={(e) => {
        e.preventDefault();
        const next = draft.trim();
        if (next) onSubmit(next);
      }}
    >
      <span className="wb-browser-lock" aria-hidden>
        <LockSimple size={14} weight="fill" />
      </span>
      <input
        ref={inputRef}
        className="wb-browser-address-input"
        type="text"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={t('browser.addressPlaceholder', '输入网址或搜索')}
        aria-label={t('browser.addressPlaceholder', '输入网址或搜索')}
        spellCheck={false}
        autoComplete="off"
        data-wb-browser-address
      />
      {loading ? <span className="wb-browser-spinner" aria-hidden /> : null}
    </form>
  );
};

const AgentBar: React.FC<{
  controlMode: BrowserControlMode;
  onTakeOver: () => void;
}> = ({ controlMode, onTakeOver }) => {
  const { t } = useTranslation('workbench');
  const agentActive = controlMode === 'agent';

  return (
    <div
      className={`wb-browser-agent${agentActive ? ' is-agent' : ' is-user'}`}
      role="status"
      data-control-mode={controlMode}
    >
      <span className="wb-browser-agent-label">
        {agentActive ? (
          <>
            <Robot size={14} weight="fill" aria-hidden />
            {t('browser.agentActive', '助手正在操控此页')}
          </>
        ) : (
          <>
            <HandPalm size={14} weight="fill" aria-hidden />
            {t('browser.userControl', '由你控制')}
          </>
        )}
      </span>
      {agentActive ? (
        <button type="button" className="wb-browser-takeover" onClick={onTakeOver}>
          {t('browser.takeOver', '接管')}
        </button>
      ) : null}
    </div>
  );
};

const SessionHint: React.FC<{ onShowContent: () => void }> = ({ onShowContent }) => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-hint" data-wb-browser-hint>
      <p className="wb-browser-hint-text">
        {t('browser.sessionHint', '网页在旁边的窗口')}
      </p>
      <button type="button" className="wb-browser-hint-action" onClick={onShowContent}>
        {t('browser.showContent', '显示页面')}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const BrowserAppWindow: React.FC<AppWindowProps> = ({
  launchPayload,
  onTitleChange,
  isActive,
}) => {
  const { t } = useTranslation('workbench');
  const session = useBrowserSession({ launchPayload, hydrateOnMount: true });
  const addressRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const pageTitle = session.title?.trim();
    onTitleChange(pageTitle || t('workbench:apps.browser', '浏览器'));
  }, [onTitleChange, t, session.title]);

  useEffect(() => {
    const onFocusAddress = () => {
      addressRef.current?.focus();
      addressRef.current?.select();
    };
    window.addEventListener(BROWSER_FOCUS_ADDRESS_EVENT, onFocusAddress);
    return () => window.removeEventListener(BROWSER_FOCUS_ADDRESS_EVENT, onFocusAddress);
  }, []);

  useEffect(() => {
    if (!launchPayload || typeof launchPayload !== 'object') return;
    if ((launchPayload as { focusAddress?: unknown }).focusAddress === true) {
      const emit = () => {
        addressRef.current?.focus();
        addressRef.current?.select();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(emit);
      window.setTimeout(emit, 120);
    }
  }, [launchPayload]);

  const handleNavigate = useCallback(
    (url: string) => {
      void session.navigate(url);
    },
    [session],
  );

  const handleTakeOver = useCallback(() => {
    void session.takeOver();
  }, [session]);

  const handleShowContent = useCallback(() => {
    void session.showContent();
  }, [session]);

  return (
    <div
      className="wb-browser-root"
      data-wb-browser-app
      data-wb-browser-chrome
      data-active={isActive ? 'true' : 'false'}
    >
      <div className="wb-browser-toolbar">
        <NavControls
          canGoBack={session.canGoBack}
          canGoForward={session.canGoForward}
          loading={session.loading}
          onBack={() => void session.back()}
          onForward={() => void session.forward()}
          onReload={() => void session.reload()}
        />
        <AddressBar
          draft={session.addressDraft}
          loading={session.loading}
          inputRef={addressRef}
          onDraftChange={session.setAddressDraft}
          onSubmit={handleNavigate}
        />
      </div>
      <AgentBar controlMode={session.controlMode} onTakeOver={handleTakeOver} />
      {session.lastError ? (
        <p className="wb-browser-error" role="alert">
          {session.lastError}
        </p>
      ) : null}
      <SessionHint onShowContent={handleShowContent} />
    </div>
  );
};

export default BrowserAppWindow;
