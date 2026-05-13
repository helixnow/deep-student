/**
 * Chat V2 - 工具递归限制提示块渲染插件
 *
 * 当工具调用达到最大递归次数时显示提示
 * 🆕 支持消息内"继续执行"按钮
 * 自执行注册：import 即注册
 */

import React, { useCallback, useState } from 'react';
import { AlertTriangle, Play, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
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
  const { t } = useTranslation();
  const content = block.content || '';
  const [isContinuing, setIsContinuing] = useState(false);

  // 🔧 竞态修复：同时检查本地 isContinuing 和 store 的 isStreaming，双重保护
  const isDisabled = isContinuing || !!isStreaming;

  // 解析内容为段落
  const paragraphs = content.split('\n\n').filter(Boolean);

  // 🆕 处理继续执行
  const handleContinue = useCallback(async () => {
    if (isDisabled || !onContinue) return;
    
    setIsContinuing(true);
    try {
      await onContinue();
    } catch (error: unknown) {
      console.error('[ToolLimitBlock] Continue failed:', error);
    } finally {
      setIsContinuing(false);
    }
  }, [isDisabled, onContinue]);

  return (
    <div
      className={cn(
        'rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-4',
        'shadow-sm'
      )}
    >
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {t('chatV2:tool_limit.title')}
        </span>
      </div>

      {/* 内容 */}
      <div className="text-sm text-amber-900/80 dark:text-amber-100/80 space-y-2">
        {paragraphs.map((paragraph, index) => {
          // 检查是否是列表项
          if (paragraph.includes('•')) {
            const items = paragraph.split('\n').filter((line) => line.trim());
            return (
              <ul key={index} className="list-none space-y-1 ml-0">
                {items.map((item, itemIndex) => (
                  <li
                    key={itemIndex}
                    className="flex items-start gap-2 text-amber-800/90 dark:text-amber-200/90"
                  >
                    <span className="text-amber-500 mt-0.5">•</span>
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

      {/* 🆕 继续执行按钮 + 快捷操作提示 */}
      <div className="mt-4 pt-3 border-t border-amber-300/30 dark:border-amber-700/30 flex items-center justify-between">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('chatV2:tool_limit.hint')}
        </p>
        
        {onContinue && (
          <NotionButton
            variant="primary"
            size="sm"
            onClick={handleContinue}
            disabled={isDisabled}
            className="bg-amber-500 hover:bg-amber-600 text-white"
          >
            {isDisabled ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('chatV2:tool_limit.continuing')}
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                {t('chatV2:tool_limit.continue')}
              </>
            )}
          </NotionButton>
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
