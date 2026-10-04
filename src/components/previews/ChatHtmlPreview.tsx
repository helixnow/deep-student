import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { openUrl } from '@/utils/urlOpener';

import {
  CHAT_HTML_PREVIEW_SANDBOX,
  INITIAL_HTML_PREVIEW_BUFFER,
  buildChatHtmlPreviewDocument,
  htmlPreviewBufferReducer,
  repairPartialHtml,
  type HtmlPreviewSlot,
} from './chatHtmlPreviewDocument';
import { attachPreviewFrame } from './chatHtmlPreviewFrame';

/** 流式期间预览文档的最小重建间隔：每次重建都是一次 iframe 加载，比 SVG 更重 */
export const HTML_PREVIEW_STREAM_INTERVAL_MS = 320;
/** load 事件迟迟不来（极端情况）时强制交换，避免预览卡在旧帧 */
const LOAD_TIMEOUT_MS = 2500;
/** 首次测量前的占位高度 */
const INITIAL_HEIGHT = 160;
const MIN_HEIGHT = 48;
/** 展开态上限：基本等于"整页内联"，只防极端长页撑爆布局 */
const EXPANDED_MAX_HEIGHT = 8000;

/** 收起态上限：桌面 640px；触屏 60% 视口高 */
export function getCollapsedMaxHeight(): number {
  if (typeof window === 'undefined') return 640;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarse ? Math.max(240, Math.round(window.innerHeight * 0.6)) : 640;
}

export interface ChatHtmlPreviewProps {
  html: string;
  /** 源码仍在流式输出：按节流渐进重建预览 */
  streaming?: boolean;
  /** 展开：内容多高显示多高（不再帧内滚动） */
  expanded?: boolean;
  /** 内容是否超出收起态上限（宿主据此决定是否显示"展开"按钮） */
  onOverflowChange?: (overflowing: boolean) => void;
  title?: string;
  className?: string;
}

interface PreviewFrameProps {
  slot: HtmlPreviewSlot;
  isFront: boolean;
  title: string;
  onLoaded: (key: number, contentHeight: number) => void;
  onContentHeight: (height: number) => void;
}

const BACKGROUND_FRAME_PROPS = { inert: '' } as Record<string, string>;

const PreviewFrame: React.FC<PreviewFrameProps> = ({ slot, isFront, title, onLoaded, onContentHeight }) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const latest = useRef({ isFront, onLoaded, onContentHeight });
  latest.current = { isFront, onLoaded, onContentHeight };

  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const handleLoad = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    let measured = 0;
    const doc = ref.current?.contentDocument;
    if (doc) {
      try {
        cleanupRef.current = attachPreviewFrame(doc, {
          onExternalLink: (url) => { void openUrl(url); },
          onContentHeight: (height) => {
            measured = height;
            if (latest.current.isFront) latest.current.onContentHeight(height);
          },
        });
      } catch (err) {
        console.warn('[ChatHtmlPreview] attach failed:', err);
      }
    }
    // 后台帧：带着测得的高度交换到前台，同一次提交里生效，不跳动
    if (!latest.current.isFront) latest.current.onLoaded(slot.key, measured);
  };

  return (
    <iframe
      ref={ref}
      className="chat-html-preview-frame"
      data-state={isFront ? 'front' : 'loading'}
      aria-hidden={isFront ? undefined : true}
      tabIndex={isFront ? undefined : -1}
      {...(isFront ? null : BACKGROUND_FRAME_PROPS)}
      sandbox={CHAT_HTML_PREVIEW_SANDBOX}
      srcDoc={slot.doc}
      title={title}
      onLoad={handleLoad}
    />
  );
};

/**
 * 聊天代码块里的 HTML 预览。
 *
 * - sandbox="allow-same-origin"（无 allow-scripts）+ 文档内 CSP：帧内不执行任何脚本，
 *   dev 与 release 行为一致；同源让父页面能测量高度、接管链接；
 * - 流式渐进：截取已完整前缀、节流重建文档；
 * - 双缓冲 iframe：新文档在隐藏帧加载并测量完成后才换到前台，不重建可见帧、不闪白；
 * - 自动高度：内容多高预览多高（收起态有上限，超出时帧内滚动，宿主可展开）。
 */
export const ChatHtmlPreview: React.FC<ChatHtmlPreviewProps> = ({
  html,
  streaming = false,
  expanded = false,
  onOverflowChange,
  title = 'html-preview',
  className,
}) => {
  const [source, setSource] = useState(() => (streaming ? repairPartialHtml(html).html : html));
  const latestRef = useRef(html);
  latestRef.current = html;
  const lastFlushRef = useRef(0);
  const lastStableRef = useRef(-1);

  // 节流：流式期间只在"又有标签写完"且距上次重建足够久时更新；结束时立即落最终版
  useEffect(() => {
    if (!streaming) {
      lastStableRef.current = -1;
      setSource(html);
      return;
    }
    const flush = () => {
      const repaired = repairPartialHtml(latestRef.current);
      if (repaired.stableLength === lastStableRef.current) return;
      lastStableRef.current = repaired.stableLength;
      lastFlushRef.current = Date.now();
      setSource(repaired.html);
    };
    const wait = HTML_PREVIEW_STREAM_INTERVAL_MS - (Date.now() - lastFlushRef.current);
    if (wait <= 0) {
      flush();
      return;
    }
    const timer = setTimeout(flush, wait);
    return () => clearTimeout(timer);
  }, [html, streaming]);

  const doc = useMemo(() => buildChatHtmlPreviewDocument(source), [source]);
  // 首帧直接作为前台，不经过隐藏加载
  const [buffer, dispatch] = useReducer(htmlPreviewBufferReducer, doc, (initialDoc: string) =>
    htmlPreviewBufferReducer(INITIAL_HTML_PREVIEW_BUFFER, { type: 'submit', doc: initialDoc }));
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  useEffect(() => {
    dispatch({ type: 'submit', doc });
  }, [doc]);

  const loadingKey = buffer.loading?.key;
  useEffect(() => {
    if (loadingKey === undefined) return;
    const timer = setTimeout(() => dispatch({ type: 'loaded', key: loadingKey }), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loadingKey]);

  const collapsedMax = getCollapsedMaxHeight();
  const overflowing = contentHeight !== null && contentHeight > collapsedMax;
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;
  useEffect(() => {
    onOverflowChangeRef.current?.(overflowing);
  }, [overflowing]);

  const stageHeight = contentHeight === null
    ? INITIAL_HEIGHT
    : Math.max(MIN_HEIGHT, Math.min(contentHeight, expanded ? EXPANDED_MAX_HEIGHT : collapsedMax));

  const handleLoaded = (key: number, height: number) => {
    if (height > 0) setContentHeight(height);
    dispatch({ type: 'loaded', key });
  };

  const slots = [buffer.front, buffer.loading].filter(Boolean) as HtmlPreviewSlot[];

  return (
    <div className={className} data-html-preview-stage="" style={{ height: stageHeight }}>
      {slots.map((slot) => (
        <PreviewFrame
          key={slot.key}
          slot={slot}
          isFront={slot === buffer.front}
          title={title}
          onLoaded={handleLoaded}
          onContentHeight={setContentHeight}
        />
      ))}
    </div>
  );
};

export default ChatHtmlPreview;
