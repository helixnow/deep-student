/**
 * 数据统计页面
 *
 * ⚠️ 2026-01: 错题系统已完全废弃，由 Chat V2 完全取代
 * 此组件现在显示 Chat V2 会话统计和 LLM 使用统计
 */
import { useTranslation } from 'react-i18next';
import { ChatV2StatsSection } from './ChatV2StatsSection';
import { LlmUsageStatsSection } from './llm-usage';
import { useChatV2Stats } from '../hooks/useChatV2Stats';

interface DataStatsProps {
  className?: string;
  embedded?: boolean;
}

export const DataStats: React.FC<DataStatsProps> = ({ className }) => {
  const { t } = useTranslation('common');
  // 获取会话统计数据，用于合并趋势图
  const chatStats = useChatV2Stats(false);

  return (
    <div className={`w-full max-w-7xl mx-auto pb-12 ${className || ''}`}>
      {/* Header */}
      <div className="mb-8 pt-2">
        <h2 className="text-2xl font-semibold text-foreground tracking-tight">{t('dataStats.title')}</h2>
        <p className="text-sm text-muted-foreground/60 mt-1">
           {t('dataStats.subtitle')}
        </p>
      </div>

      <div className="space-y-12">
        {/* Chat V2 Stats Section */}
        <section>
          <ChatV2StatsSection />
        </section>

        <div className="h-px bg-border/20 w-full" />

        {/* LLM Usage Stats Section - 传入会话趋势数据以合并显示 */}
        <section>
          <LlmUsageStatsSection days={30} sessionTrends={chatStats.dailyActivity} />
        </section>
      </div>
    </div>
  );
};

export default DataStats;
