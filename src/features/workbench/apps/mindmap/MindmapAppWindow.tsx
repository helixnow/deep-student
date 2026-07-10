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
 * 已知限制（记录在 P8 进度文件）：useMindMapStore 是模块级单例，
 * 同时可见的两个 mindmap 窗口共享同一份文档状态，焦点切换时非焦点窗口
 * 展示的是最后一次渲染的画面。窗口级 store 隔离属后续改造项。
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
  instanceKey,
  isActive,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation(['workbench']);
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleReadyRef = useRef(false);

  const hasResource = Boolean(instanceKey);
  const { phase, markReady } = useContentLoadPhase({
    hostRef,
    enabled: hasResource,
  });

  useResizeSettle(hostRef, contentRef, hasResource);
  useDragRenderPause(hostRef, renderThrottleMs);

  const handleTitleChange = useCallback(
    (title: string) => {
      onTitleChange(title);
      if (!titleReadyRef.current) {
        titleReadyRef.current = true;
        markReady();
      }
    },
    [onTitleChange, markReady],
  );

  if (!instanceKey) {
    return (
      <ContentEmptyState
        title={t('workbench:content.missingResource', '缺少资源标识，无法打开该窗口')}
        description={t(
          'workbench:mindmap.missingResourceHint',
          '请从资源库重新打开思维导图，或检查该导图是否仍存在。',
        )}
      />
    );
  }

  const showSkeleton = phase === 'loading' || phase === 'fading';

  return (
    <div ref={hostRef} className="wb-content-host" data-wb-content-host data-wb-mindmap-host>
      <div ref={contentRef} className="wb-content-viewport">
        <MindMapContentView
          resourceId={instanceKey}
          isActive={isActive}
          onTitleChange={handleTitleChange}
          className="h-full"
        />
      </div>
      {showSkeleton && (
        <ContentSkeleton
          variant="mindmap"
          phase={phase === 'fading' ? 'fading' : 'loading'}
          label={t('workbench:mindmap.loading', '正在加载思维导图…')}
        />
      )}
    </div>
  );
};

export default MindmapAppWindow;
