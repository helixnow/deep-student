/**
 * Chat V2 - 工具递归限制提示块渲染插件
 *
 * 当工具调用达到最大递归次数时显示提示
 * 🆕 支持消息内"继续执行"按钮
 * 自执行注册：import 即注册
 */

import React, { useCallback, useState } from 'react';
import { Warning, Play, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 工具限制提示块组件
// ============================================================================

/**
 * ToolLimitBlock - 工具递归限制提示块渲染组件
 *
 * 功能：
 * 1. 显示警告样式卡片
 * 2. 提示用户工具调用已达到限制
 * 3. 🆕 提供"继续执行"按钮，点击后在同一消息内继续执行
 */
const ToolLimitBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming, onContinue }) => {
  const { t } = useTranslation('chatV2');
  const content = block.content || '';
  const [isContinuing, setIsContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  // 🔧 竞态修复：同时检查本地 isContinuing 和 store 的 isStreaming，双重保护
  const isDisabled = isContinuing || !!isStreaming;

  // 解析内容为段落
  const paragraphs = content.split('\n\n').filter(Boolean);

  // 🆕 处理继续执行
  const handleContinue = useCallback(async () => {
    if (isDisabled || !onContinue) return;

    setIsContinuing(true);
    setContinueError(null);
    try {
      await onContinue();
    } catch (error: unknown) {
      console.error('[ToolLimitBlock] Continue failed:', error);
      // 🔧 P3-4：继续执行失败要给用户可见的内联错误，而非仅 console
      const detail =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : '';
      setContinueError(detail);
    } finally {
      setIsContinuing(false);
    }
  }, [isDisabled, onContinue]);

  return (
    <div
      className={cn(
        'rounded-lg border border-warning/30 bg-warning/10 p-4',
        'shadow-sm'
      )}
    >
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-3">
        <Warning size={20} className="text-warning" />
        <span className="text-sm font-medium text-warning">
          {t('chatV2:tool_limit.title')}
        </span>
      </div>

      {/* 内容 */}
      <div className="text-sm text-warning/80 space-y-2">
        {paragraphs.map((paragraph, index) => {
          // 检查是否是列表项
          if (paragraph.includes('•')) {
            const items = paragraph.split('\n').filter((line) => line.trim());
            return (
              <ul key={index} className="list-none space-y-1 ml-0">
                {items.map((item, itemIndex) => (
                  <li
                    key={itemIndex}
                    className="flex items-start gap-2 text-warning/90"
                  >
                    <span className="text-warning mt-0.5">•</span>
                    <span>{item.replace(/^[•\s]+/, '')}</span>
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <p key={index} className="leading-relaxed">
              {paragraph}
            </p>
          );
        })}
      </div>

      {/* 🆕 继续执行失败的内联错误 */}
      {continueError !== null && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
          <WarningCircle size={14} className="mt-0.5 flex-shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 break-words text-destructive">
            {t('chatV2:tool_limit.continueFailed')}
            {continueError && <span className="ml-1 text-destructive/80">{continueError}</span>}
          </span>
        </div>
      )}

      {/* 🆕 继续执行按钮 + 快捷操作提示 */}
      <div className="mt-4 pt-3 border-t border-warning/30 flex items-center justify-between">
        <p className="text-xs text-warning">
          {t('chatV2:tool_limit.hint')}
        </p>
        
        {onContinue && (
          <DsButton
            variant="primary"
            size="sm"
            onClick={handleContinue}
            disabled={isDisabled}
            className="bg-warning hover:bg-warning/90 text-white [@media(pointer:coarse)]:!min-h-11"
          >
            {isDisabled ? (
              <>
                <CircleNotch size={14} className="animate-spin" />
                {t('chatV2:tool_limit.continuing')}
              </>
            ) : (
              <>
                <Play size={14} />
                {t('chatV2:tool_limit.continue')}
              </>
            )}
          </DsButton>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('tool_limit', {
  type: 'tool_limit',
  component: ToolLimitBlock,
  onAbort: 'keep-content',
});

// 导出组件（可选，用于测试）
export { ToolLimitBlock };
