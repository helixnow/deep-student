import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import {
  WIDGET_STREAM_FRAME_CSP,
  WIDGET_STREAM_FRAME_SANDBOX,
  buildWidgetStreamPreviewDocument,
  sanitizeWidgetStreamHtml,
} from './chatHtmlPreviewDocument';
import {
  INTERACTIVE_CANVAS_PRESET_CSS,
  captureHostThemeSnapshot,
  type InteractiveHtmlCanvasThemeSnapshot,
} from './InteractiveHtmlCanvas';

export {
  WIDGET_STREAM_FRAME_CSP,
  WIDGET_STREAM_FRAME_SANDBOX,
  buildWidgetStreamPreviewDocument,
  sanitizeWidgetStreamHtml,
};

export interface WidgetStreamFrameProps {
  html: string;
  theme?: InteractiveHtmlCanvasThemeSnapshot;
  minHeight?: number;
  height?: number;
  title?: string;
  className?: string;
  testId?: string;
  onHeightChange?: (height: number) => void;
}

const DEFAULT_MIN_HEIGHT = 80;
const INERT_ROOT_PROPS = { inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>;

/**
 * 流式生成期间的无脚本高保真首帧预览组件：
 * - `sandbox="allow-same-origin"`（绝不含 `allow-scripts`）；
 * - 注入严格 CSP：`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none';`
 * - 注入与宿主同步的主题 CSS 变量及 `.oc-*` / `.ds-*` 预置样式；
 * - 剥离所有 `<script>`、`on*` 内联事件属性及外链 URL，保留作者 `<style>`、class/id 与内联 `<svg>`；
 * - 根节点与文档 `<body>` 均设置 `inert` 防止流式期间误触；
 * - 支持在后台可执行 iframe 尚未触发 `ready` 前继续保持首帧画面，消除灰框闪烁。
 */
export const WidgetStreamFrame: React.FC<WidgetStreamFrameProps> = ({
  html,
  theme,
  minHeight = DEFAULT_MIN_HEIGHT,
  height,
  title = '画板首帧预览',
  className,
  testId = 'widget-stream-frame',
  onHeightChange,
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [hostTheme, setHostTheme] = useState<InteractiveHtmlCanvasThemeSnapshot>(() =>
    theme ?? captureHostThemeSnapshot(),
  );
  const resolvedTheme = theme ?? hostTheme;

  useEffect(() => {
    if (theme || typeof document === 'undefined' || typeof MutationObserver !== 'function') {
      return;
    }
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setHostTheme(captureHostThemeSnapshot());
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, [theme]);

  const srcDoc = useMemo(
    () =>
      buildWidgetStreamPreviewDocument({
        html,
        themeVars: resolvedTheme as unknown as Record<string, string>,
        presetCss: INTERACTIVE_CANVAS_PRESET_CSS,
      }),
    [html, resolvedTheme],
  );

  const [measuredHeight, setMeasuredHeight] = useState<number>(minHeight);
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

  const measureFrameContent = () => {
    const doc = frameRef.current?.contentDocument;
    const body = doc?.body;
    if (!body) return;
    const rawHeight = Math.ceil(
      Math.max(
        body.scrollHeight || 0,
        body.offsetHeight || 0,
        body.getBoundingClientRect?.().height || 0,
      ),
    );
    if (rawHeight > 0) {
      setMeasuredHeight(rawHeight);
      onHeightChangeRef.current?.(rawHeight);
    }
  };

  useEffect(() => {
    measureFrameContent();
  }, [srcDoc]);

  const displayHeight = Math.max(minHeight, height ?? measuredHeight, DEFAULT_MIN_HEIGHT);

  return (
    <div
      {...INERT_ROOT_PROPS}
      className={cn(
        'widget-stream-frame relative w-full select-none overflow-hidden',
        className,
      )}
      data-testid={testId}
      data-widget-stream-frame=""
      aria-busy="true"
      style={{ height: displayHeight }}
    >
      <iframe
        ref={frameRef}
        className="widget-stream-frame__iframe pointer-events-none h-full w-full border-0 bg-transparent"
        sandbox={WIDGET_STREAM_FRAME_SANDBOX}
        srcDoc={srcDoc}
        title={title}
        tabIndex={-1}
        onLoad={measureFrameContent}
        style={{ height: displayHeight }}
        data-testid="widget-stream-iframe"
      />
    </div>
  );
};

export default WidgetStreamFrame;
