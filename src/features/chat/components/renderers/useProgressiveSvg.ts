import { useEffect, useMemo, useRef, useState } from 'react';

import { buildSvgFrame } from './progressiveSvg';

/** 流式期间 SVG 重渲染的最小间隔 */
export const SVG_STREAM_INTERVAL_MS = 120;

/**
 * 返回当前应显示的已消毒 SVG 标记。
 * - 流式：节流到 {@link SVG_STREAM_INTERVAL_MS}，且只有"又有标签写完"才重渲染；
 *   修复/消毒失败时保留上一帧；
 * - 非流式：同步计算最终结果（流结束的那次渲染里直接得到终帧，无空档、无闪烁）。
 */
export function useProgressiveSvg(source: string, streaming: boolean, enabled: boolean): string | null {
  const [frame, setFrame] = useState<string | null>(() =>
    enabled && streaming ? buildSvgFrame(source)?.markup ?? null : null,
  );
  const latestRef = useRef(source);
  latestRef.current = source;
  const lastFlushRef = useRef(0);
  const lastStableRef = useRef(-1);

  useEffect(() => {
    if (!enabled || !streaming) {
      lastStableRef.current = -1;
      return;
    }
    const flush = () => {
      const next = buildSvgFrame(latestRef.current);
      lastFlushRef.current = Date.now();
      if (!next || next.stableLength === lastStableRef.current) return;
      lastStableRef.current = next.stableLength;
      setFrame(next.markup);
    };
    const wait = SVG_STREAM_INTERVAL_MS - (Date.now() - lastFlushRef.current);
    if (wait <= 0) {
      flush();
      return;
    }
    const timer = setTimeout(flush, wait);
    return () => clearTimeout(timer);
  }, [enabled, source, streaming]);

  const finalMarkup = useMemo(
    () => (enabled && !streaming ? buildSvgFrame(source)?.markup ?? null : null),
    [enabled, source, streaming],
  );

  if (!enabled) return null;
  // 终帧消毒失败（极端异常输入）时退回最后一帧流式结果
  return streaming ? frame : finalMarkup ?? frame;
}
