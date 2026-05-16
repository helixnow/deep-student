/**
 * Chat V2 - BlockingToolLimitBar
 *
 * 工具递归限制提示 - 输入栏内联版本。
 * 单行布局：警告图标 + 提示文字 + 继续按钮。
 */

import React, { useCallback, useState } from 'react';
import { Warning, Play, CircleNotch } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import type { BlockingInteraction } from '../../core/types/store';

type ToolLimitInteraction = Extract<BlockingInteraction, { kind: 'tool_limit' }>;

interface BlockingToolLimitBarProps {
  interaction: ToolLimitInteraction;
}

export const BlockingToolLimitBar: React.FC<BlockingToolLimitBarProps> = React.memo(({ interaction }) => {
  const { t } = useTranslation('chatV2');
  const [isContinuing, setIsContinuing] = useState(false);

  const handleContinue = useCallback(async () => {
    if (isContinuing || !interaction.onContinue) return;
    setIsContinuing(true);
    try {
      await interaction.onContinue();
    } catch (error) {
      console.error('[BlockingToolLimitBar] Continue failed:', error);
    } finally {
      setIsContinuing(false);
    }
  }, [isContinuing, interaction]);

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Warning size={18} className="text-amber-500 flex-shrink-0" />
        <span className="text-sm text-amber-700 dark:text-amber-300 truncate">
          {interaction.content || t('tool_limit.title')}
        </span>
      </div>
      {interaction.onContinue && (
        <NotionButton
          variant="primary"
          size="sm"
          onClick={handleContinue}
          disabled={isContinuing}
          className="flex-shrink-0 bg-amber-500 hover:bg-amber-600 text-white"
        >
          {isContinuing ? (
            <>
              <CircleNotch size={14} className="animate-spin" />
              <span className="ml-1.5">{t('tool_limit.continuing')}</span>
            </>
          ) : (
            <>
              <Play size={14} />
              <span className="ml-1.5">{t('tool_limit.continue')}</span>
            </>
          )}
        </NotionButton>
      )}
    </div>
  );
});

BlockingToolLimitBar.displayName = 'BlockingToolLimitBar';
