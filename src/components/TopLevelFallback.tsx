import React from 'react';
import i18n from '../i18n';
import {
  chooseAndExportDiagnostics,
  revealDiagnostics,
} from '../logging/exportDiagnostics';
import { isMobilePlatform } from '../utils/platform';

const safeT = (key: string, fallback: string, options?: Record<string, unknown>): string => {
  try {
    return i18n.t(key, { defaultValue: fallback, ...options }) as string;
  } catch {
    return fallback;
  }
};

export interface TopLevelFallbackProps {
  error?: unknown;
  componentStack?: string;
}

/**
 * The fatal fallback must also work in a normal browser, where requesting a
 * native window effect is neither possible nor desirable.  Keep this check
 * local and dependency-free: this component is rendered precisely when other
 * application modules may have failed to initialise.
 */
const isMacOSTauriDesktop = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  const platform = navigator.platform || '';
  // iPadOS can report MacIntel when using a desktop user agent; it cannot host
  // the macOS NSVisualEffectView used by the desktop command.
  const isMac = /^Mac/.test(platform) && navigator.maxTouchPoints < 2;
  // `withGlobalTauri` is disabled, but Tauri v2 still injects this internal
  // bridge for the official API package. Checking its callable invoke method
  // avoids treating a browser test stub as a desktop runtime.
  const isTauri = typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function';

  return isMac && isTauri;
};

/** Resolve the active app theme without relying on the app's theme provider. */
const getErrorFallbackIsDark = (): boolean => {
  if (typeof document !== 'undefined') {
    const theme = document.documentElement.dataset.theme;
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
  }

  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
};

export const TopLevelFallback: React.FC<TopLevelFallbackProps> = ({
  error,
  componentStack,
}) => {
  const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const errorStack = error instanceof Error ? error.stack : undefined;
  const fullLog = [
    `Error: ${errorMessage}`,
    errorStack ? `\nStack:\n${errorStack}` : '',
    componentStack ? `\nComponent Stack:\n${componentStack}` : '',
    `\nTimestamp: ${new Date().toISOString()}`,
    `\nUserAgent: ${navigator.userAgent}`,
  ].filter(Boolean).join('');

  const [showDetails, setShowDetails] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [exportStatus, setExportStatus] = React.useState<string | null>(null);
  const [isDark, setIsDark] = React.useState(getErrorFallbackIsDark);
  const useMacOSGlass = isMacOSTauriDesktop();

  React.useEffect(() => {
    const syncTheme = () => setIsDark(getErrorFallbackIsDark());
    const root = document.documentElement;
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    mediaQuery?.addEventListener?.('change', syncTheme);

    return () => {
      observer.disconnect();
      mediaQuery?.removeEventListener?.('change', syncTheme);
    };
  }, []);

  React.useEffect(() => {
    if (!useMacOSGlass) return;

    // NSVisualEffectView lives behind WKWebView. Its material becomes visible
    // only once the root's opaque application surface is removed. Do this only
    // after the native command succeeds, and restore the exact inline value
    // when the fallback unmounts.
    const appRoot = document.getElementById('root');
    const previousBackground = appRoot?.style.backgroundColor ?? '';
    let cancelled = false;

    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<boolean>('set_sidebar_vibrancy', { enabled: true }))
      .then((nativeApplied) => {
        if (nativeApplied === true && !cancelled) {
          appRoot?.style.setProperty('background-color', 'transparent');
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      appRoot?.style.setProperty('background-color', previousBackground);
    };
  }, [useMacOSGlass]);

  const glassStyle: React.CSSProperties = useMacOSGlass
    ? {
        // Match the macOS-native sidebar material tint so this fallback feels
        // like part of the same window, not a separately coloured overlay.
        backgroundColor: isDark
          ? 'hsl(var(--nav-background) / 0.32)'
          : 'hsl(var(--nav-background) / 0.88)',
      }
    : { backgroundColor: isDark ? '#181d26' : '#fafafa' };

  const secondaryButtonStyle: React.CSSProperties = {
    color: isDark ? '#eef2f7' : '#333',
    backgroundColor: isDark ? 'rgba(255, 255, 255, 0.12)' : '#fff',
    border: `1px solid ${isDark ? 'rgba(255, 255, 255, 0.18)' : '#ddd'}`,
  };

  const selectErrorText = () => {
    const el = document.getElementById('error-log-content');
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullLog);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      selectErrorText();
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setExportStatus(null);
    try {
      const result = await chooseAndExportDiagnostics(false);
      if (!result) return;
      setExportStatus(
        result.skippedCount > 0
          ? safeT(
              'common:error_boundary.diagnostics_partial',
              `诊断包已导出，但有 ${result.skippedCount} 个文件未包含`,
              { count: result.skippedCount },
            )
          : safeT('common:error_boundary.diagnostics_exported', '诊断包已导出'),
      );
      void revealDiagnostics(result).catch(() => undefined);
    } catch {
      setExportStatus(safeT('common:error_boundary.diagnostics_failed', '诊断包导出失败'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // dvh：移动端动态工具栏/键盘下取真实可视高度（旧内核回退 100vh 由内联双写不可行，
        // 此处兜底页无滚动内容，100dvh 不支持时浏览器忽略该行保留 100vh）
        height: '100vh',
        ...(typeof CSS !== 'undefined' && CSS.supports?.('height', '100dvh') ? { height: '100dvh' } : {}),
        width: '100vw',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        ...glassStyle,
        color: isDark ? '#f4f7fb' : '#1a1a1a',
      }}
    >
      <div
        aria-hidden
        style={{
          width: 64,
          height: 64,
          marginBottom: 16,
          borderRadius: '50%',
          backgroundColor: 'rgba(220, 38, 38, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="#dc2626"
            strokeOpacity="0.75"
            strokeWidth="1.6"
          />
          <path
            d="M12 7.4v5.4"
            stroke="#dc2626"
            strokeOpacity="0.9"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="16.4" r="1.05" fill="#dc2626" fillOpacity="0.9" />
        </svg>
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
        {safeT('common:error_boundary.title', '应用遇到严重错误')}
      </h1>
      <p
        style={{
          fontSize: 14,
          color: isDark ? '#c3cbd7' : '#666',
          marginBottom: 24,
          maxWidth: 400,
          textAlign: 'center',
        }}
      >
        {safeT(
          'common:error_boundary.description',
          '应用发生了无法恢复的错误。请尝试刷新页面，如果问题持续请联系支持。',
        )}
      </p>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 24px',
            fontSize: 14,
            fontWeight: 500,
            color: '#fff',
            backgroundColor: '#2563eb',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          {safeT('common:error_boundary.refresh', '刷新页面')}
        </button>
        <button
          onClick={() => setShowDetails((value) => !value)}
          style={{
            padding: '10px 24px',
            fontSize: 14,
            fontWeight: 500,
            ...secondaryButtonStyle,
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          {showDetails
            ? safeT('common:error_boundary.hide_details', '隐藏详情')
            : safeT('common:error_boundary.show_details', '查看错误详情')}
        </button>
        {!isMobilePlatform() && (
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            style={{
              padding: '10px 24px',
              fontSize: 14,
              fontWeight: 500,
              ...secondaryButtonStyle,
              borderRadius: 8,
              cursor: exporting ? 'wait' : 'pointer',
              opacity: exporting ? 0.7 : 1,
            }}
          >
            {exporting
              ? safeT('common:error_boundary.exporting_diagnostics', '正在导出…')
              : safeT('common:error_boundary.export_diagnostics', '导出诊断包')}
          </button>
        )}
      </div>
      {exportStatus && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: isDark ? '#c3cbd7' : '#666' }}>{exportStatus}</p>
      )}
      {showDetails && (
        <div style={{ width: '100%', maxWidth: 640, padding: '0 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button
              onClick={handleCopy}
              style={{
                padding: '6px 16px',
                fontSize: 13,
                ...secondaryButtonStyle,
                color: copied ? '#34d399' : secondaryButtonStyle.color,
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {copied
                ? safeT('common:error_boundary.copied', '已复制')
                : safeT('common:error_boundary.copy_error', '复制错误日志')}
            </button>
          </div>
          <pre
            id="error-log-content"
            style={{
              padding: 16,
              fontSize: 12,
              lineHeight: 1.6,
              backgroundColor: isDark ? 'rgba(10, 14, 20, 0.58)' : '#f5f5f5',
              border: `1px solid ${isDark ? 'rgba(255, 255, 255, 0.14)' : '#e5e5e5'}`,
              borderRadius: 8,
              overflow: 'auto',
              maxHeight: 300,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: '#d32f2f',
              userSelect: 'text',
            }}
          >
            {fullLog}
          </pre>
        </div>
      )}
    </div>
  );
};

export default TopLevelFallback;
