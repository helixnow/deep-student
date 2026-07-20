/**
 * 思维导图应用窗口（P8 + O17）
 *
 * 直接复用 @/features/mindmap 的 MindMapContentView（只读消费）。
 *
 * isActive 映射说明：
 * - MindMapContentView 的 isActive prop 承担"标签页活跃"语义：
 *   活跃时接管全局键盘/剪贴板、加载文档、同步标题；非活跃时 saveDraftSync
 *   并暂停画布交互（经 MindMapActiveContext 下发）。
 * - 这里映射为窗口的 isActive（focused）：与标签页语义等价——同一时刻
 *   只有焦点窗口接管键盘与 store，避免多窗口争抢全局快捷键。
 *   isVisible=false 时窗口壳（WindowBody）已对内容做 visibility:hidden，
 *   画布渲染成本归零，无需额外处理。
 *
 * O17：复用 content 侧 ContentSkeleton（mindmap 变体）+ ContentEmptyState +
 * useContentLoadPhase / useResizeSettle / useDragRenderPause；不改 legacy MindMapContentView。
 *
 * ANTI-REGRESSION：拖拽降频只走 useDragRenderPause（CSS 冻结动画），禁止因
 * renderThrottleMs>0 把 isActive 置 false——MindMapContentView 失活会同步
 * saveDraftSync，拖拽热路径写草稿比动画更伤帧。
 *
 * 每个 MindMapContentView 持有独立 store；windowId 作为实例路由键，保证同资源
 * 出现在多个宿主时 activation 也只命中目标窗口。
 */
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MindMapContentView } from '@/features/mindmap/MindMapContentView';
import type { AppWindowProps } from '../../core/types';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import { ContentEmptyState } from '../content/ContentEmptyState';
import { ContentSkeleton } from '../content/ContentSkeleton';
import { useContentLoadPhase } from '../content/useContentLoadPhase';
import { useResizeSettle } from '../content/useResizeSettle';
import '../content/ContentAppWindow.css';

const MindmapAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  isActive,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation(['workbench']);
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const hasResource = Boolean(instanceKey);
  const { phase, markReady } = useContentLoadPhase({
    hostRef,
    enabled: hasResource,
  });

  useResizeSettle(hostRef, contentRef, hasResource);
  useDragRenderPause(hostRef, renderThrottleMs);

  // B-9：独立窗口的窗口级保存指示——dirty/saving 时窗口标题追加 ●，
  // 与 Notes 标签条圆点语义对齐（AppWindowProps 无专用保存通道，经标题透出）。
  const lastTitleRef = useRef('');
  const saveStateRef = useRef<'saved' | 'saving' | 'dirty'>('saved');

  const emitTitle = useCallback(() => {
    const title = lastTitleRef.current;
    const showMarker = saveStateRef.current !== 'saved';
    onTitleChange(showMarker && title ? `● ${title}` : title);
  }, [onTitleChange]);

  const handleTitleChange = useCallback(
    (title: string) => {
      lastTitleRef.current = title;
      emitTitle();
    },
    [emitTitle],
  );

  const handleSaveStateChange = useCallback(
    (state: 'saved' | 'saving' | 'dirty') => {
      const wasMarked = saveStateRef.current !== 'saved';
      saveStateRef.current = state;
      const isMarked = state !== 'saved';
      if (wasMarked !== isMarked) emitTitle();
    },
    [emitTitle],
  );

  const handleContentReady = useCallback(() => markReady(), [markReady]);
  const handleLoadError = useCallback(() => markReady(), [markReady]);

  if (!instanceKey) {
    return (
      <ContentEmptyState
        title={t('workbench:content.missingResource')}
        description={t('workbench:mindmap.missingResourceHint')}
      />
    );
  }

  const showSkeleton = phase === 'loading' || phase === 'fading';

  return (
    <div
      ref={hostRef}
      className="wb-content-host"
      data-wb-content-host
      data-wb-mindmap-host
      // 骨架屏期间向辅助技术标记加载中
      aria-busy={showSkeleton || undefined}
    >
      <div ref={contentRef} className="wb-content-viewport">
        <MindMapContentView
          resourceId={instanceKey}
          storeInstanceId={windowId}
          isActive={isActive}
          onTitleChange={handleTitleChange}
          onSaveStateChange={handleSaveStateChange}
          onReady={handleContentReady}
          onLoadError={handleLoadError}
          className="h-full"
        />
      </div>
      {showSkeleton && (
        <ContentSkeleton
          variant="mindmap"
          phase={phase === 'fading' ? 'fading' : 'loading'}
          label={t('workbench:mindmap.loading')}
        />
      )}
    </div>
  );
};

export default MindmapAppWindow;
