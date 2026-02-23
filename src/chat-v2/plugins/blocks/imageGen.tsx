/**
 * Chat V2 - 图片生成块渲染插件
 *
 * 渲染 AI 图片生成的过程和结果
 * 自执行注册：import 即注册
 *
 * 功能：
 * 1. 显示生成提示词
 * 2. 生成中进度动画
 * 3. 图片预览（支持全屏）
 * 4. 显示图片尺寸和模型信息
 * 5. 错误状态和重试
 * 6. 暗色/亮色主题支持
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  Loader2,
  AlertCircle,
  RotateCcw,
  ImageIcon,
  Sparkles,
} from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { ImagePreview } from './components';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 图片生成块数据
 */
export interface ImageGenBlockData {
  /** 生成提示词 */
  prompt: string;
  /** 生成的图片 URL */
  imageUrl?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 使用的模型 */
  model?: string;
  /** 生成参数 */
  params?: Record<string, unknown>;
}

// ============================================================================
// 子组件：生成进度
// ============================================================================

interface ImageGenProgressProps {
  prompt?: string;
}

const ImageGenProgress: React.FC<ImageGenProgressProps> = ({ prompt }) => {
  const { t } = useTranslation('chatV2');

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 p-8',
        'min-h-[200px]'
      )}
    >
      {/* 动画容器 */}
      <div className="relative">
        {/* 外圈光效 */}
        <div
          className={cn(
            'absolute inset-0 rounded-full',
            'bg-primary/20 animate-ping'
          )}
          style={{ animationDuration: '1.5s' }}
        />
        {/* 内圈图标 */}
        <div
          className={cn(
            'relative w-16 h-16 rounded-full',
            'bg-primary/10 dark:bg-primary/20',
            'flex items-center justify-center'
          )}
        >
          <Sparkles className="w-8 h-8 text-primary animate-pulse" />
        </div>
      </div>

      {/* 提示文字 */}
      <div className="text-center space-y-1">
        <div className="text-sm font-medium text-foreground">
          {t('blocks.imageGen.generating')}
        </div>
        {prompt && (
          <div className="text-xs text-muted-foreground max-w-[300px] line-clamp-2">
            "{prompt}"
          </div>
        )}
      </div>

      {/* 进度点 */}
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              'w-2 h-2 bg-primary rounded-full animate-bounce'
            )}
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// 子组件：图片信息
// ============================================================================

interface ImageInfoProps {
  width?: number;
  height?: number;
  model?: string;
}

const ImageInfo: React.FC<ImageInfoProps> = ({ width, height, model }) => {
  const { t } = useTranslation('chatV2');

  if (!width && !height && !model) return null;

  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2',
        'text-xs text-muted-foreground',
        'border-t border-border/30'
      )}
    >
      {/* 尺寸 */}
      {width && height && (
        <div className="flex items-center gap-1">
          <ImageIcon className="w-3 h-3" />
          <span>
            {width} × {height}
          </span>
        </div>
      )}

      {/* 模型 */}
      {model && (
        <div className="flex items-center gap-1">
          <Sparkles className="w-3 h-3" />
          <span>{model}</span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 子组件：错误展示
// ============================================================================

interface ImageGenErrorProps {
  error: string;
  prompt?: string;
  onRetry?: () => void;
}

const ImageGenError: React.FC<ImageGenErrorProps> = ({
  error,
  prompt,
  onRetry,
}) => {
  const { t } = useTranslation('chatV2');

  return (
    <div className="p-4">
      {/* 提示词 */}
      {prompt && (
        <div className="mb-3 text-xs text-muted-foreground">
          <span className="font-medium">{t('blocks.imageGen.prompt')}:</span>
          <span className="ml-1">"{prompt}"</span>
        </div>
      )}

      {/* 错误信息 */}
      <div
        className={cn(
          'p-3 rounded-md',
          'bg-destructive/10 border border-destructive/30'
        )}
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-destructive">
              {t('blocks.imageGen.generationFailed')}
            </div>
            <div className="mt-1 text-xs text-destructive/80 break-words">
              {error}
            </div>
          </div>
        </div>
      </div>

      {/* 重试按钮 */}
      {onRetry && (
        <NotionButton variant="ghost" size="sm" onClick={onRetry} className="mt-3 text-primary hover:bg-primary/10">
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{t('blocks.imageGen.retry')}</span>
        </NotionButton>
      )}
    </div>
  );
};

// ============================================================================
// 主组件：图片生成块
// ============================================================================

/**
 * ImageGenBlock - 图片生成块渲染组件
 */
const ImageGenBlockComponent: React.FC<BlockComponentProps> = React.memo(({
  block,
  isStreaming,
}) => {
  const { t } = useTranslation('chatV2');

  // 从 block 中提取数据
  // 输入信息存储在 toolInput 中（由 updateBlock 设置）
  // 输出结果存储在 toolOutput 中（由 setBlockResult 设置）
  const inputData = block.toolInput as Partial<ImageGenBlockData> | undefined;
  const outputData = block.toolOutput as ImageGenBlockData | undefined;
  
  // 优先使用 toolOutput 中的结果，fallback 到 toolInput
  const prompt = outputData?.prompt || inputData?.prompt || '';
  const imageUrl = outputData?.imageUrl;
  const width = outputData?.width || inputData?.width;
  const height = outputData?.height || inputData?.height;
  const model = outputData?.model || inputData?.model;

  // 重试回调（TODO: 实际实现）
  const handleRetry = useCallback(() => {
    console.log('[ImageGenBlock] Retry generation:', prompt);
  }, [prompt]);

  // 待处理状态
  if (block.status === 'pending') {
    return (
      <div
        className={cn(
          'image-gen-block',
          'rounded-lg border border-border/50 overflow-hidden',
          'bg-card dark:bg-card/80'
        )}
      >
        <div className="p-4 text-center text-muted-foreground text-sm">
          {t('blocks.imageGen.pending')}
        </div>
      </div>
    );
  }

  // 生成中状态
  if (block.status === 'running' || (isStreaming && !imageUrl)) {
    return (
      <div
        className={cn(
          'image-gen-block',
          'rounded-lg border border-border/50 overflow-hidden',
          'bg-card dark:bg-card/80'
        )}
      >
        <ImageGenProgress prompt={prompt} />
      </div>
    );
  }

  // 错误状态
  if (block.status === 'error') {
    return (
      <div
        className={cn(
          'image-gen-block',
          'rounded-lg border border-destructive/30 overflow-hidden',
          'bg-card dark:bg-card/80'
        )}
      >
        <ImageGenError
          error={block.error || t('blocks.imageGen.unknownError')}
          prompt={prompt}
          onRetry={handleRetry}
        />
      </div>
    );
  }

  // 成功状态
  return (
    <div
      className={cn(
        'image-gen-block',
        'rounded-lg border border-border/50 overflow-hidden',
        'bg-card dark:bg-card/80'
      )}
    >
      {/* 提示词 */}
      {prompt && (
        <div className="px-3 py-2 border-b border-border/30">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="w-3 h-3" />
            <span className="font-medium">{t('blocks.imageGen.prompt')}:</span>
          </div>
          <div className="mt-1 text-sm text-foreground line-clamp-2">
            {prompt}
          </div>
        </div>
      )}

      {/* 图片预览 */}
      {imageUrl ? (
        <div className="p-3">
          <ImagePreview
            src={imageUrl}
            alt={prompt}
            width={width}
            height={height}
            showActions
          />
        </div>
      ) : (
        <div className="p-8 text-center text-muted-foreground text-sm">
          {t('blocks.imageGen.noImage')}
        </div>
      )}

      {/* 图片信息 */}
      <ImageInfo width={width} height={height} model={model} />
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('image_gen', {
  type: 'image_gen',
  component: ImageGenBlockComponent,
  onAbort: 'mark-error', // 中断时标记为错误
});

// 导出组件和类型（可选，用于测试）
export { ImageGenBlockComponent };
