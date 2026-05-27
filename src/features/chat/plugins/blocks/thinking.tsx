/**
 * Chat V2 — 思维链块渲染插件
 *
 * 渲染 AI 的思维链/推理过程。
 * 视觉层级：左品牌色 accent bar + 卡片容器，与普通消息块拉开差距。
 * 动画：CSS opacity 过渡 + contain:layout 隔离布局重算。
 *
 * 自动折叠逻辑：
 * - 通过 document.documentElement 上的 data-auto-collapse-thinking 属性读取开关状态
 * - 监听 systemSettingsChanged 事件，设置变化时用 useReducer 强制重渲染
 * - 手动操作过折叠/展开的块不受自动逻辑影响
 */

import React, { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { Brain, CaretDown } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingBlockRenderer } from '../../components/renderers';

function readAutoCollapseSetting(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.getAttribute('data-auto-collapse-thinking') !== 'false';
}

const ThinkingBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const contentId = useId();

  const [, forceRerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.settingKey === 'thinking.auto_collapse') {
        forceRerender();
      }
    };
    window.addEventListener('systemSettingsChanged', handler);
    return () => window.removeEventListener('systemSettingsChanged', handler);
  }, []);

  const autoCollapseEnabled = readAutoCollapseSetting();

  const [isExpanded, setIsExpanded] = useState(() => {
    if (isStreaming) return true;
    return !readAutoCollapseSetting();
  });
  const isManuallyControlled = useRef(false);

  useEffect(() => {
    if (isManuallyControlled.current) return;

    if (isStreaming) {
      setIsExpanded(true);
    } else if (autoCollapseEnabled) {
      setIsExpanded(false);
    }
  }, [isStreaming, autoCollapseEnabled]);

  const toggleExpanded = useCallback(() => {
    isManuallyControlled.current = true;
    setIsExpanded((prev) => !prev);
  }, []);

  const content = block.content || '';
  const hasContent = content.trim().length > 0;

  if (!hasContent && !isStreaming) {
    return null;
  }

  return (
    <div
      className={cn(
        'think-block',
        isExpanded && 'think-block--expanded',
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="think-header"
      >
        <Brain size={15} className="think-header-icon" weight="duotone" />
        <span className="think-header-title">{t('blocks.thinking.title')}</span>

        {isStreaming && (
          <span className="think-status-pulse">
            <span className="think-pulse-dot" />
            <span className="think-pulse-label">{t('blocks.thinking.streaming')}</span>
          </span>
        )}

        <span className={cn('think-chevron', isExpanded && 'think-chevron--expanded')}>
          <CaretDown size={14} weight="bold" />
        </span>
      </button>

      <div
        id={contentId}
        role="region"
        aria-label={t('blocks.thinking.title')}
        className={cn(
          'think-content-wrapper',
          isExpanded && 'think-content-wrapper--expanded',
        )}
      >
        <div className="think-content">
          <StreamingBlockRenderer
            content={content}
            isStreaming={isStreaming ?? false}
            blockId={block.id}
            messageId={block.messageId}
          />
        </div>
      </div>
    </div>
  );
});

blockRegistry.register('thinking', {
  type: 'thinking',
  component: ThinkingBlock,
  onAbort: 'keep-content',
});

export { ThinkingBlock };
