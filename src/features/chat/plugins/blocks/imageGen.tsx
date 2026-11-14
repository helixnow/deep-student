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

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { PulseDot } from '@/components/ui/PulseDot';
import {
  WarningCircle,
  ArrowCounterClockwise,
  Image as ImageIcon,
  Sparkle,
  ChatDots,
  CaretDown,
  CaretRight,
  CheckCircle,
} from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';
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
  /** VFS ContextRef resource id */
  resourceId?: string;
  /** VFS ContextRef resource hash */
  resourceHash?: string;
  /** VFS attachment source id */
  sourceId?: string;
  /** 图片 MIME 类型 */
  mimeType?: string;
  /** OpenAI 兼容接口可能返回的修订提示词 */
  revisedPrompt?: string;
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
    <div className="p-3">
      <div className="relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-border/40 bg-muted/35 px-4 py-5">
        <ToolActivitySweep active className="justify-center">
          <div className="flex items-center gap-2">
            <PulseDot className="h-1.5 w-1.5 text-primary" />
            <TextShimmer
              className="text-xs font-medium text-muted-foreground"
              duration={1.5}
              spread={3}
            >
              {t('blocks.imageGen.generating')}
            </TextShimmer>
          </div>
        </ToolActivitySweep>
        {prompt && (
          <p className="max-w-full truncate text-xs text-muted-foreground/80" title={prompt}>
            {prompt}
          </p>
        )}
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
  if (!width && !height && !model) return null;

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-3 py-2',
        'text-xs text-muted-foreground',
        'border-t border-border/40'
      )}
    >
      {/* 尺寸 */}
      {width && height && (
        <div className="flex items-center gap-1 tabular-nums">
          <ImageIcon size={12} />
          <span>
            {width} × {height}
          </span>
        </div>
      )}

      {/* 模型 */}
      {model && (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <Sparkle size={12} className="shrink-0" />
          <span className="truncate">{model}</span>
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
  /** 无法重试时的提示文案（与重试按钮互斥） */
  retryUnavailableHint?: string;
}

const ImageGenError: React.FC<ImageGenErrorProps> = ({
  error,
  prompt,
  onRetry,
  retryUnavailableHint,
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
          <WarningCircle size={16} className="text-destructive shrink-0 mt-0.5" />
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
        <DsButton variant="ghost" size="sm" onClick={onRetry} className="mt-3 text-primary hover:bg-primary/10 [@media(pointer:coarse)]:!min-h-11">
          <ArrowCounterClockwise size={14} />
          <span>{t('blocks.imageGen.retry')}</span>
        </DsButton>
      )}
      {!onRetry && retryUnavailableHint && (
        <div className="mt-3 text-xs text-muted-foreground">
          {retryUnavailableHint}
        </div>
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
  store,
}) => {
  const { t } = useTranslation('chatV2');

  // 从 block 中提取数据
  // 输入信息存储在 toolInput 中（由 updateBlock 设置）
  // 输出结果存储在 toolOutput 中（由 setBlockResult 设置）
  const inputData = block.toolInput as Partial<ImageGenBlockData> | undefined;
  const outputData = block.toolOutput as ImageGenBlockData | undefined;
  
  // 优先使用 toolOutput 中的结果，fallback 到 toolInput
  const prompt = outputData?.prompt || inputData?.prompt || '';
  const revisedPrompt = outputData?.revisedPrompt;
  const params = outputData?.params || inputData?.params;
  const imageUrl = outputData?.imageUrl;
  const width = outputData?.width || inputData?.width;
  const height = outputData?.height || inputData?.height;
  const model = outputData?.model || inputData?.model;
  const resourceId = outputData?.resourceId;
  const resourceHash = outputData?.resourceHash;

  const isPending = block.status === 'pending';
  const isError = block.status === 'error';
  const isRunning = !isPending && !isError && (block.status === 'running' || (Boolean(isStreaming) && !imageUrl));
  const isActive = isPending || isRunning;
  const isSuccess = !isActive && !isError;
  const durationMs =
    block.startedAt && block.endedAt ? block.endedAt - block.startedAt : undefined;
  const paramEntries = useMemo(
    () => (params ? Object.entries(params).filter(([, value]) => value !== undefined && value !== null) : []),
    [params]
  );
  const hasPromptDetails = Boolean(prompt || revisedPrompt || paramEntries.length > 0);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);

  // 重试：与 mcp_tool 一致，通过 store.retryMessage 重试所属消息
  const canRetry = useMemo(() => {
    if (!store || !block.messageId) return false;
    return Boolean(store.getState()?.retryMessage);
  }, [store, block.messageId]);

  const handleRetry = useCallback(() => {
    if (!store || !block.messageId) return;
    const state = store.getState();
    if (state.retryMessage) {
      state.retryMessage(block.messageId).catch((error) => {
        console.error('[ImageGenBlock] Retry failed:', error);
      });
    }
  }, [store, block.messageId]);

  const handleUseForFollowup = useCallback(() => {
    if (!store || !resourceId || !resourceHash) return;
    store.getState().addContextRef({
      resourceId,
      hash: resourceHash,
      typeId: 'image',
      displayName: prompt || t('blocks.imageGen.generatedImage'),
      injectModes: { image: ['image'] },
    });
  }, [store, resourceId, resourceHash, prompt, t]);

  const headerSubtitle = isPending
    ? t('blocks.imageGen.pending')
    : isRunning
      ? t('blocks.imageGen.generating')
      : isError
        ? t('blocks.imageGen.generationFailed')
        : model || (width && height ? `${width} × ${height}` : t('blocks.imageGen.generatedImage'));

  return (
    <div
      className={cn(
        'image-gen-block',
        'rounded-lg border overflow-hidden bg-card dark:bg-card/80',
        isError ? 'border-destructive/30' : 'border-border/50'
      )}
    >
      {/* 统一头部 */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left',
          'transition-colors hover:bg-muted/40 [@media(pointer:coarse)]:!min-h-11',
          isExpanded && 'border-b border-border/40'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ToolActivitySweep
            active={isActive}
            className="h-7 w-7 shrink-0 justify-center rounded-md bg-muted/70 dark:bg-muted/40"
          >
            <ImageIcon size={16} className="text-muted-foreground" />
          </ToolActivitySweep>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <ToolActivitySweep active={isActive} className="min-w-0 max-w-full leading-4">
              <span className="block truncate text-xs font-medium leading-4 text-muted-foreground">
                {t('blocks.imageGen.title')}
              </span>
            </ToolActivitySweep>
            {isActive ? (
              <TextShimmer
                className="text-xs leading-4 text-muted-foreground"
                duration={1.5}
                spread={3}
              >
                {headerSubtitle}
              </TextShimmer>
            ) : (
              <span
                className={cn(
                  'truncate text-xs leading-4 tabular-nums',
                  isError ? 'text-destructive' : 'text-muted-foreground/80'
                )}
              >
                {headerSubtitle}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!isActive && durationMs !== undefined && durationMs >= 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatToolDurationShort(durationMs)}
            </span>
          )}
          {isSuccess && <CheckCircle size={14} className="shrink-0 text-success" />}
          {isError && <WarningCircle size={14} className="shrink-0 text-destructive" />}
          {isExpanded ? (
            <CaretDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <CaretRight size={14} className="shrink-0 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* 内容区 */}
      {isExpanded && (
        <div>
          {isPending && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <PulseDot className="h-1.5 w-1.5 text-primary" />
              <TextShimmer className="text-xs text-muted-foreground" duration={1.5} spread={3}>
                {t('blocks.imageGen.pending')}
              </TextShimmer>
            </div>
          )}

          {isRunning && <ImageGenProgress prompt={prompt} />}

          {isError && (
            <ImageGenError
              error={block.error || t('blocks.imageGen.unknownError')}
              prompt={prompt}
              onRetry={canRetry ? handleRetry : undefined}
              retryUnavailableHint={t('blocks.imageGen.retryUnavailable')}
            />
          )}

          {isSuccess && (
            <>
              {/* 可折叠提示词与参数区 */}
              {hasPromptDetails && (
                <div className="border-b border-border/40">
                  <button
                    type="button"
                    onClick={() => setIsPromptExpanded((prev) => !prev)}
                    aria-expanded={isPromptExpanded}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30 [@media(pointer:coarse)]:!min-h-11"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <Sparkle size={12} className="shrink-0" />
                      <span className="shrink-0 font-medium">
                        {t('blocks.imageGen.prompt')}
                      </span>
                      {!isPromptExpanded && prompt && (
                        <span className="min-w-0 truncate text-foreground/80">
                          {prompt}
                        </span>
                      )}
                    </div>
                    {isPromptExpanded ? (
                      <CaretDown size={12} className="shrink-0" />
                    ) : (
                      <CaretRight size={12} className="shrink-0" />
                    )}
                  </button>

                  {isPromptExpanded && (
                    <div className="space-y-2 border-t border-border/30 bg-muted/20 px-3 py-2.5 text-xs">
                      {prompt && (
                        <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
                          {prompt}
                        </p>
                      )}
                      {revisedPrompt && revisedPrompt !== prompt && (
                        <p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
                          {revisedPrompt}
                        </p>
                      )}
                      {paramEntries.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-0.5 tabular-nums">
                          {paramEntries.map(([key, value]) => (
                            <span
                              key={key}
                              className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/60 px-1.5 py-0.5 text-2xs text-muted-foreground"
                            >
                              <span className="font-medium text-foreground/80">{key}:</span>
                              <span>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {t('blocks.imageGen.noImage')}
                </div>
              )}

              {/* 图片信息 */}
              <ImageInfo width={width} height={height} model={model} />

              {resourceId && resourceHash && (
                <div className="flex items-center justify-end gap-2 border-t border-border/40 px-3 py-2">
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={handleUseForFollowup}
                    className="text-primary hover:bg-primary/10 [@media(pointer:coarse)]:!min-h-11"
                  >
                    <ChatDots size={14} />
                    <span>{t('blocks.imageGen.useForFollowup')}</span>
                  </DsButton>
                </div>
              )}
            </>
          )}
        </div>
      )}
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
