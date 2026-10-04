import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  INITIAL_HTML_PREVIEW_BUFFER,
  buildChatHtmlPreviewDocument,
  htmlPreviewBufferReducer,
  repairPartialHtml,
} from './chatHtmlPreviewDocument';
import { getHtmlSandboxPermissions } from './htmlSandboxPolicy';

/** 流式期间预览文档的最小重建间隔：每次重建都是一次 iframe 加载，比 SVG 更重 */
export const HTML_PREVIEW_STREAM_INTERVAL_MS = 320;
/** load 事件迟迟不来（极端情况）时强制交换，避免预览卡在旧帧 */
const LOAD_TIMEOUT_MS = 2500;

export interface ChatHtmlPreviewProps {
  html: string;
  /** 源码仍在流式输出：按节流渐进重建预览 */
  streaming?: boolean;
  title?: string;
  className?: string;
}

/**
 * 聊天代码块里的 HTML 预览。
 *
 * - 无脚本沙箱（sandbox=""）+ 文档内 CSP：dev 与 release 行为一致（release 的
 *   app CSP 本就禁止 srcdoc 内联脚本）；
 * - 流式渐进：截取已完整前缀、节流重建文档；
 * - 双缓冲 iframe：新文档在隐藏帧加载完成后才换到前台，不重建可见帧、不闪白；
 * - 高度由外层容器决定（父页面读不到跨源无脚本帧的内容高度），帧内自行滚动。
 */
export const ChatHtmlPreview: React.FC<ChatHtmlPreviewProps> = ({
  html,
  streaming = false,
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

  useEffect(() => {
    dispatch({ type: 'submit', doc });
  }, [doc]);

  const loadingKey = buffer.loading?.key;
  useEffect(() => {
    if (loadingKey === undefined) return;
    const timer = setTimeout(() => dispatch({ type: 'loaded', key: loadingKey }), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loadingKey]);

  const slots = [buffer.front, buffer.loading].filter(Boolean) as Array<{ key: number; doc: string }>;
  const sandbox = getHtmlSandboxPermissions('chat-safe');

  return (
    <div className={className} data-html-preview-stage="">
      {slots.map((slot) => {
        const isFront = slot === buffer.front;
        return (
          <iframe
            key={slot.key}
            className="chat-html-preview-frame"
            data-state={isFront ? 'front' : 'loading'}
            aria-hidden={isFront ? undefined : true}
            tabIndex={isFront ? undefined : -1}
            sandbox={sandbox}
            srcDoc={slot.doc}
            title={title}
            onLoad={isFront ? undefined : () => dispatch({ type: 'loaded', key: slot.key })}
          />
        );
      })}
    </div>
  );
};

export default ChatHtmlPreview;
