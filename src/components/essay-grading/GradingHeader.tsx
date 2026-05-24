import React from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '../ui/shad/Badge';
import { Tabs, TabsList, TabsTrigger } from '../ui/shad/Tabs';
import { Pen, ArrowClockwise, ClockCounterClockwise, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

interface GradingHeaderProps {
  activeTab: 'grading' | 'history';
  setActiveTab: (tab: 'grading' | 'history') => void;
  historyTotal: number;
  isGrading: boolean;
  onRefreshHistory: () => void;
  // 轮次导航
  currentRound: number;
  totalRounds: number;
  onPrevRound: () => void;
  onNextRound: () => void;
  sessionTitle?: string;
  /** DSTU 模式下隐藏历史 Tab */
  showHistoryTab?: boolean;
}

export const GradingHeader: React.FC<GradingHeaderProps> = ({
  activeTab,
  setActiveTab,
  historyTotal,
  isGrading,
  onRefreshHistory,
  currentRound,
  totalRounds,
  onPrevRound,
  onNextRound,
  sessionTitle,
  showHistoryTab = true,
}) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  return (
    <div className="px-4 py-3 border-b flex items-center justify-between bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10">
      <div className="flex items-center gap-4">
        {showHistoryTab ? (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as 'grading' | 'history')}
            className="w-auto"
          >
            <TabsList className="h-auto bg-transparent border border-border/60 rounded-full px-1 py-1 shadow-none gap-1 items-center">
              <TabsTrigger
                value="grading"
                className="text-[12px] leading-none px-3 py-1 h-7 gap-1.5 rounded-full border border-transparent data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
              >
                <Pen size={14} />
                {t('essay_grading:tabs.grading')}
              </TabsTrigger>
              <TabsTrigger
                value="history"
                className="text-[12px] leading-none px-3 py-1 h-7 gap-1.5 rounded-full border border-transparent data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
              >
                <ClockCounterClockwise size={14} />
                {t('essay_grading:tabs.history')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          /* DSTU 模式下只显示批改标签 */
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Pen size={16} />
            {t('essay_grading:tabs.grading')}
          </div>
        )}

        {/* 会话标题 */}
        {activeTab === 'grading' && sessionTitle && (
          <span className="text-sm text-muted-foreground truncate max-w-[200px]">
            {sessionTitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* 轮次导航（仅在批改标签页显示） */}
        {activeTab === 'grading' && totalRounds > 0 && (
          <div className="flex items-center gap-1 mr-2">
            <CommonTooltip content={t('essay_grading:round.previous')}>
              <NotionButton
                variant="ghost"
                size="icon"
                onClick={onPrevRound}
                disabled={currentRound <= 1 || isGrading}
                className="h-7 w-7 rounded-full"
              >
                <CaretLeft size={16} />
              </NotionButton>
            </CommonTooltip>

            <Badge variant="secondary" className="h-6 px-2 text-xs font-normal">
              {t('essay_grading:round.label', { number: currentRound })} / {totalRounds}
            </Badge>

            <CommonTooltip content={t('essay_grading:round.next')}>
              <NotionButton
                variant="ghost"
                size="icon"
                onClick={onNextRound}
                disabled={currentRound >= totalRounds || isGrading}
                className="h-7 w-7 rounded-full"
              >
                <CaretRight size={16} />
              </NotionButton>
            </CommonTooltip>
          </div>
        )}

        {showHistoryTab && historyTotal > 0 && (
          <Badge variant="secondary" className="h-7 px-2.5 bg-muted/50 text-muted-foreground hover:bg-[var(--interactive-hover)] font-normal text-xs">
            <ClockCounterClockwise size={12} className="mr-1.5" />
            {historyTotal}
          </Badge>
        )}
        <CommonTooltip content={t('common:refresh')}>
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={onRefreshHistory}
            disabled={isGrading}
 className="w-8 h-8 rounded-full hover:bg-[var(--interactive-hover)]"
          >
            <ArrowClockwise className={`h-3.5 w-3.5 ${isGrading ? 'animate-spin' : ''}`} />
          </NotionButton>
        </CommonTooltip>
      </div>
    </div>
  );
};
