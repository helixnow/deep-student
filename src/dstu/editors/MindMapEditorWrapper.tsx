/**
 * 知识导图编辑器包装组件
 *
 * 将 MindMapContentView 包装为符合 DSTU EditorProps 接口的组件。
 * 
 * 设计原则：
 * - 使用 DSTU 原生的 MindMapContentView
 * - 从 DSTU path 获取 DstuNode
 * - 可在 Learning Hub 或其他地方复用
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, WarningCircle, ArrowClockwise } from '@phosphor-icons/react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { dstu } from '../index';
import { createEmpty } from '../factory';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import type { DstuNode } from '../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// 懒加载 MindMapContentView
const MindMapContentView = lazy(() => 
  import('@/features/mindmap/MindMapContentView').then(m => ({ default: m.MindMapContentView }))
);

/**
 * B-8：DSTU 宿主可选增强 props（在 EditorProps 公共协议之上透传给 MindMapContentView，
 * 不破坏 create/path 模式；未增强的宿主走默认值）。
 */
export interface MindMapEditorEnhancedProps {
  /** 宿主标签/窗口是否活跃；多开时的键盘/剪贴板门控（默认 true 语义由 ContentView 承担） */
  isActive?: boolean;
  /** 多宿主 activation 精确路由键；缺省时按本挂载实例自动生成稳定 id */
  storeInstanceId?: string;
  /** 根节点标题变化回调（宿主标题条同步） */
  onTitleChange?: (title: string) => void;
  /** 保存状态回调（宿主可显示 dirty/saving 指示） */
  onSaveStateChange?: (state: 'saved' | 'saving' | 'dirty') => void;
}

/**
 * 知识导图编辑器包装组件
 */
export const MindMapEditorWrapper: React.FC<
  (EditorProps & MindMapEditorEnhancedProps) | CreateEditorProps
> = (props) => {
  const { t } = useTranslation(['dstu', 'mindmap', 'common']);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // storeInstanceId 缺省值：按挂载实例生成稳定 id，保证同资源多开时 activation 可精确路由
  const reactInstanceId = useId();

  // 判断是否为创建模式
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取 mindmapId
  const path = !isCreateMode && 'path' in props ? props.path : '';

  // 获取回调
  const onClose = 'onClose' in props ? props.onClose : undefined;
  const onCreate = isCreateMode && 'onCreate' in props ? props.onCreate : undefined;

  // 从路径提取资源 ID
  const extractResourceId = (dstuPath: string): string | null => {
    // 路径格式: /mm_xxx 或 /folder/mm_xxx
    const match = dstuPath.match(/\/(mm_[a-zA-Z0-9_-]+)$/);
    return match ? match[1] : null;
  };

  // 加载 DstuNode
  const loadNode = useCallback(async () => {
    if (!path) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const result = await dstu.get(path);
    setIsLoading(false);

    if (result.ok) {
      if (result.value) {
        setNode(result.value);
      } else {
        const errMsg = t('mindmap:errors.notFound');
        setError(errMsg);
        showGlobalNotification('error', errMsg);
      }
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [path, t]);

  useEffect(() => {
    if (!isCreateMode) {
      return;
    }

    let cancelled = false;
    const createMindMapResource = async () => {
      setIsLoading(true);
      setError(null);
      const result = await createEmpty({ type: 'mindmap' });
      if (cancelled) return;

      if (result.ok) {
        setIsLoading(false);
        onCreate?.(result.value.path);
        if (onClose) {
          onClose();
          return;
        }
        return;
      }

      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      setIsLoading(false);
      showGlobalNotification('error', errMsg);
    };

    void createMindMapResource();
    return () => {
      cancelled = true;
    };
  }, [isCreateMode, onCreate, onClose]);

  useEffect(() => {
    if (!isCreateMode) {
      void loadNode();
    }
  }, [isCreateMode, loadNode]);

  // 创建模式
  if (isCreateMode) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-3', props.className)}>
        {error ? (
          <>
            <WarningCircle size={40} className="text-destructive/60" />
            <span className="text-sm text-destructive text-center max-w-md">{error}</span>
            {onClose && (
              <DsButton variant="ghost"
                className="px-4 py-2 border rounded-md hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
                onClick={onClose}
              >
                {t('common:actions.close')}
              </DsButton>
            )}
          </>
        ) : isLoading ? (
          <>
            <CircleNotch size={24} className="animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('dstu:actions.createMindMap')}...
            </span>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">{t('dstu:actions.mindMapCreated')}</span>
            {onClose && (
              <DsButton variant="ghost"
                className="px-4 py-2 border rounded-md hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
                onClick={onClose}
              >
                {t('common:actions.close')}
              </DsButton>
            )}
          </>
        )}
      </div>
    );
  }

  // 加载中
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full', props.className)}>
        <CircleNotch size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <WarningCircle size={48} className="text-destructive/50" />
        <span className="text-destructive text-center max-w-md">{error}</span>
        <DsButton variant="ghost"
          className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
          onClick={loadNode}
        >
          <ArrowClockwise size={16} />
          {t('common:actions.retry')}
        </DsButton>
      </div>
    );
  }

  // 节点不存在
  if (!node) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <WarningCircle size={48} className="text-muted-foreground/50" />
        <span className="text-muted-foreground text-center">
          {t('mindmap:errors.notFound')}
        </span>
      </div>
    );
  }

  // 提取资源 ID
  const resourceId = extractResourceId(path) || node.id;

  // B-8：补齐集成契约——isActive / storeInstanceId / onTitleChange / onSaveStateChange 透传；
  // 同时把保存状态桥接到 DSTU 公共协议的 onDirtyChange（saved 之外均视为 dirty）
  const enhanced = props as EditorProps & MindMapEditorEnhancedProps;
  const storeInstanceId = enhanced.storeInstanceId ?? `dstu:${reactInstanceId}`;
  const onDirtyChange = enhanced.onDirtyChange;
  const onSaveStateChangeProp = enhanced.onSaveStateChange;
  const handleSaveStateChange = (state: 'saved' | 'saving' | 'dirty') => {
    onSaveStateChangeProp?.(state);
    onDirtyChange?.(state !== 'saved');
  };

  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center h-full', props.className)}>
          <CircleNotch size={24} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <MindMapContentView
        resourceId={resourceId}
        storeInstanceId={storeInstanceId}
        isActive={enhanced.isActive}
        onTitleChange={enhanced.onTitleChange}
        onSaveStateChange={handleSaveStateChange}
        className={props.className}
      />
    </Suspense>
  );
};
