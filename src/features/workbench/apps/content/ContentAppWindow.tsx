/**
 * 内容应用窗口组件（P8 + O17）
 *
 * AppWindowProps → UnifiedAppPanel props 的薄映射层。
 * 资源加载（dstu.get）、错误/加载态、Suspense、错误边界与
 * 各 views/*ContentView 的分发全部直接复用 UnifiedAppPanel（只读消费）。
 *
 * O17 适配层增强（不侵入 legacy）：
 * - ContentSkeleton + useContentLoadPhase：类型化骨架，onTitleChange 首调 = 就绪；
 * - ContentEmptyState：缺 instanceKey 的精致空态；
 * - useResizeSettle：缩放手势中锁定内容尺寸 + 滚动位置保持；
 * - useDragRenderPause：renderThrottleMs>0 时冻结内容动画/过渡。
 *
 * ANTI-REGRESSION：拖拽降频只走 useDragRenderPause（CSS），禁止因
 * renderThrottleMs>0 把 isActive 置 false——试卷练习会暂停秒表，笔记会卸
 * 键盘监听后又在松手瞬间重绑，比冻动画更伤。壳层已关 pointer-events。
 * 禁止在本层动态切 contain/content-visibility（由 WindowShell 纪律约束）。
 */
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import type { ResourceType } from '@/features/learning-hub/types';
import type { AppWindowProps } from '../../core/types';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import { ContentEmptyState } from './ContentEmptyState';
import { ContentSkeleton, skeletonVariantForType } from './ContentSkeleton';
import { useContentLoadPhase } from './useContentLoadPhase';
import { useResizeSettle } from './useResizeSettle';
import './ContentAppWindow.css';

/**
 * 为指定资源类型生成窗口组件（type 在注册时绑定，
 * instanceKey=resourceId 在运行时由窗口壳传入）。
 */
export function createContentWindowComponent(type: ResourceType): React.FC<AppWindowProps> {
  const ContentAppWindow: React.FC<AppWindowProps> = ({
    instanceKey,
    isActive,
    renderThrottleMs = 0,
    onTitleChange,
    requestClose,
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
            'workbench:content.missingResourceHint',
            '请从资源库重新打开，或检查该资源是否仍存在。',
          )}
        />
      );
    }

    const showSkeleton = phase === 'loading' || phase === 'fading';

    return (
      <div ref={hostRef} className="wb-content-host" data-wb-content-host>
        <div ref={contentRef} className="wb-content-viewport">
          <UnifiedAppPanel
            type={type}
            resourceId={instanceKey}
            dstuPath={`/${instanceKey}`}
            isActive={isActive}
            onTitleChange={handleTitleChange}
            onClose={requestClose}
            className="h-full"
          />
        </div>
        {showSkeleton && (
          <ContentSkeleton
            variant={skeletonVariantForType(type)}
            phase={phase === 'fading' ? 'fading' : 'loading'}
          />
        )}
      </div>
    );
  };

  ContentAppWindow.displayName = `ContentAppWindow(${type})`;
  return ContentAppWindow;
}
