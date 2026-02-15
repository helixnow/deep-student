import React from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '../ui/shad/Badge';
import { Tabs, TabsList, TabsTrigger } from '../ui/shad/Tabs';
import { Languages, RefreshCw, History } from 'lucide-react';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

interface TranslationHeaderProps {
  activeTab: 'translate' | 'history';
  setActiveTab: (tab: 'translate' | 'history') => void;
  historyTotal: number;
  isTranslating: boolean;
  onRefreshHistory: () => void;
  /** DSTU 模式下隐藏历史 Tab（由 Learning Hub 管理历史） */
  hideHistoryTab?: boolean;
}

export const TranslationHeader: React.FC<TranslationHeaderProps> = ({
  activeTab,
  setActiveTab,
  historyTotal,
  isTranslating,
  onRefreshHistory,
  hideHistoryTab = false,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  return (
    <div className="px-4 py-3 border-b flex items-center justify-between bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10">
      <div className="flex items-center gap-4">
        {hideHistoryTab ? (
          // DSTU 模式：只显示翻译标题，无 Tab 切换
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Languages className="h-4 w-4 text-primary" />
            {t('translation:tabs.translate')}
          </div>
        ) : (
          // 普通模式：显示 Tab 切换
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as 'translate' | 'history')}
            className="w-auto"
          >
            <TabsList className="h-auto bg-transparent border border-border/60 rounded-full px-1 py-1 shadow-none gap-1 items-center">
              <TabsTrigger
                value="translate"
                className="text-[12px] leading-none px-3 py-1 h-7 gap-1.5 rounded-full border border-transparent data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
              >
                <Languages className="h-3.5 w-3.5" />
                {t('translation:tabs.translate')}
              </TabsTrigger>
              <TabsTrigger
                value="history"
                className="text-[12px] leading-none px-3 py-1 h-7 gap-1.5 rounded-full border border-transparent data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
              >
                <History className="h-3.5 w-3.5" />
                {t('translation:tabs.history')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* DSTU 模式下隐藏历史计数和刷新按钮 */}
        {!hideHistoryTab && (
          <>
            {historyTotal > 0 && (
              <Badge variant="secondary" className="h-7 px-2.5 bg-muted/50 text-muted-foreground hover:bg-muted font-normal text-xs">
                <History className="w-3 h-3 mr-1.5" />
                {historyTotal}
              </Badge>
            )}
            <CommonTooltip content={t('common:refresh')}>
                <NotionButton
                  variant="ghost"
                  size="icon"
                  onClick={onRefreshHistory}
                  disabled={isTranslating}
                  className="h-8 w-8 rounded-full hover:bg-muted"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isTranslating ? 'animate-spin' : ''}`} />
                </NotionButton>
            </CommonTooltip>
          </>
        )}
      </div>
    </div>
  );
};
