import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';

import {
  buildHtmlSandboxDocument,
  getHtmlSandboxPermissions,
  sanitizeCssForPreview,
  sanitizeHtmlForPreview,
  type HtmlSandboxMode,
} from './htmlSandboxPolicy';

export interface SandboxImageClickPayload {
  src: string;
  alt: string;
}

const SAFE_LIGHTBOX_IMAGE_SRC_RE = /^(?:data:image\/|blob:|https?:\/\/)/i;

export interface HtmlSandboxPreviewProps {
  mode: HtmlSandboxMode;
  htmlContent: string;
  cssContent?: string;
  compact?: boolean;
  height?: number | string;
  fidelity?: 'default' | 'anki';
  /** 应用暗色模式时向沙箱 body 透传 Anki `nightMode night_mode` 类名 */
  darkMode?: boolean;
  title?: string;
  /** iframe 最小高度（px）：内容不足时也撑满宿主区域（复习舞台） */
  minHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  /** iframe 内点击非交互区域时回调（卡面辅助脚本发出 `sdp-click`） */
  onFrameClick?: () => void;
  /** iframe 内点击图片时回调（卡面辅助脚本发出 `sdp-image-click`，用于全分辨率缩放灯箱，不翻面） */
  onFrameImageClick?: (payload: SandboxImageClickPayload) => void;
  /** iframe 内点击待加载/重试音频按钮时回调（卡面辅助脚本发出 `sdp-sound-click`） */
  onFrameSoundClick?: (soundFile: string) => void;
  /**
   * iframe 文档自身滚不动时回调（卡面辅助脚本发出 `sdp-wheel`）。
   * 复习舞台把 iframe 高度设成内容高度，WebKit 不会把 iframe 里的滚轮链回宿主，
   * 宿主需要据此自行滚动统一 viewport。
   */
  onFrameWheel?: (deltaY: number, deltaMode: number) => void;
  /** 应用自有样式（不经 CSS 净化），见 buildHtmlSandboxDocument 的 trustedCss */
  trustedCss?: string;
}

/** srcDoc 的轻量指纹（djb2），仅用作 React key */
function srcDocKey(doc: string): string {
  let hash = 5381;
  for (let i = 0; i < doc.length; i += 1) hash = ((hash << 5) + hash + doc.charCodeAt(i)) | 0;
  return `${doc.length}:${hash >>> 0}`;
}

export const HtmlSandboxPreview: React.FC<HtmlSandboxPreviewProps> = ({
  mode,
  htmlContent,
  cssContent = '',
  compact = false,
  height,
  fidelity = 'default',
  darkMode = false,
  title = 'html-preview',
  minHeight,
  className,
  style,
  onFrameClick,
  onFrameImageClick,
  onFrameSoundClick,
  onFrameWheel,
  trustedCss,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(typeof height === 'number' ? height : 200);

  const srcDoc = useMemo(() => {
    const safeHtml = sanitizeHtmlForPreview(htmlContent, mode);
    const safeCss = sanitizeCssForPreview(cssContent, mode);
    return buildHtmlSandboxDocument({
      html: safeHtml,
      css: safeCss,
      mode,
      compact,
      height,
      fidelity,
      darkMode,
      trustedCss,
    });
  }, [compact, cssContent, darkMode, fidelity, height, htmlContent, mode, trustedCss]);

  useEffect(() => {
    if (typeof height === 'number') {
      setIframeHeight(height);
    }
  }, [height]);

  const shouldListenResize = height === undefined && mode === 'template-safe';
  const handleResizeMessage = useCallback((rawEvent: Event) => {
    const event = rawEvent as MessageEvent;
    if (event.source !== iframeRef.current?.contentWindow) return;
    if (event.data?.type === 'sdp-resize' && typeof event.data.height === 'number') {
      const nextHeight = Math.max(20, Math.min(event.data.height, 5000));
      if (Number.isFinite(nextHeight)) {
        setIframeHeight(nextHeight);
      }
    }
  }, []);

  useEventRegistry(
    shouldListenResize ? [{ target: 'window', type: 'message', listener: handleResizeMessage }] : [],
    [shouldListenResize, handleResizeMessage],
  );

  const shouldListenInteraction =
    Boolean(onFrameClick || onFrameWheel || onFrameImageClick || onFrameSoundClick)
    && mode === 'template-safe';
  const handleInteractionMessage = useCallback((rawEvent: Event) => {
    const event = rawEvent as MessageEvent;
    if (event.source !== iframeRef.current?.contentWindow) return;
    const data = event.data as {
      type?: string;
      deltaY?: number;
      deltaMode?: number;
      src?: unknown;
      alt?: unknown;
      soundFile?: unknown;
    } | null;
    if (!data) return;
    if (data.type === 'sdp-click') {
      onFrameClick?.();
    } else if (data.type === 'sdp-wheel') {
      onFrameWheel?.(Number(data.deltaY) || 0, Number(data.deltaMode) || 0);
    } else if (data.type === 'sdp-image-click' && typeof data.src === 'string') {
      const src = data.src.trim();
      if (SAFE_LIGHTBOX_IMAGE_SRC_RE.test(src)) {
        onFrameImageClick?.({ src, alt: typeof data.alt === 'string' ? data.alt : '' });
      }
    } else if (data.type === 'sdp-sound-click' && typeof data.soundFile === 'string') {
      onFrameSoundClick?.(data.soundFile);
    }
  }, [onFrameClick, onFrameImageClick, onFrameSoundClick, onFrameWheel]);

  useEventRegistry(
    shouldListenInteraction ? [{ target: 'window', type: 'message', listener: handleInteractionMessage }] : [],
    [shouldListenInteraction, handleInteractionMessage],
  );

  return (
    <iframe
      // 内容变化即重建 iframe：WebKit 对快速连续的 srcdoc 更新会漏掉重载，
      // 画面停在旧文档（复习切卡时出现过上一张卡的模板）
      key={srcDocKey(srcDoc)}
      ref={iframeRef}
      className={className}
      sandbox={getHtmlSandboxPermissions(mode)}
      srcDoc={srcDoc}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        height: height !== undefined ? height : Math.max(iframeHeight, minHeight ?? 0),
        // 高度即内容高度，宿主容器负责滚动（复习卡面靠外层 .wb-fc-card 的 viewport 滚）。
        // 宿主若是高度受限的 flex 容器，WebKit 会把 iframe 当可压缩 flex item 压回容器高度
        // （Chromium 不压），内容于是被挤进 iframe 自身文档且滚不动，宿主也就没有可滚内容、
        // 滚动条被判为无用而不显示——长模板卡在 WebKit 上因此完全无法滚动。
        flexShrink: 0,
        border: 'none',
        overflow: 'auto',
        background: 'hsl(var(--background))',
        colorScheme: 'light dark',
        ...style,
      }}
      title={title}
    />
  );
};

export default HtmlSandboxPreview;
