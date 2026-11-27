/**
 * 闪卡调度设置独立标签页 — 承接每日限额、目标保持率、排序偏好、进阶调度步与 FSRS 参数优化。
 *
 * 与学习统计（StatisticsScreen）解耦为平级标签页，避免统计页读写混排与信息过载；
 * 桌面端与移动端均保持统一画布底色，限制舒适表单阅读宽度。
 */
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  SchedulerSettingsSection,
  type SchedulerSettingsSectionProps,
} from '../components/SchedulerSettingsSection';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';
import { useFlashcardsMobileChrome } from '../useFlashcardsMobileChrome';

export interface SchedulerSettingsScreenProps {
  /** 切入本页后需要自动聚焦的字段（例如从今日页「调整每日新卡上限」跳转而来） */
  initialFocusField?: SchedulerSettingsSectionProps['initialFocusField'];
  /** 自动聚焦消费完毕后的清理回调 */
  onInitialFocusConsumed?: () => void;
}

export const SchedulerSettingsScreen: React.FC<SchedulerSettingsScreenProps> = ({
  initialFocusField,
  onInitialFocusConsumed,
}) => {
  const { t } = useTranslation('flashcards');
  const setScreen = useFsrsReviewStore((state) => state.setScreen);
  const backToToday = useCallback(() => setScreen('today'), [setScreen]);

  useFlashcardsMobileChrome({
    title: t('settings.scheduler.title'),
    onBack: backToToday,
  }, [t, backToToday]);

  useEffect(() => {
    if (!initialFocusField || !onInitialFocusConsumed) return;
    const timer = window.setTimeout(onInitialFocusConsumed, 400);
    return () => window.clearTimeout(timer);
  }, [initialFocusField, onInitialFocusConsumed]);

  return (
    <div className="wb-fc-screen" data-testid="fc-scheduler-screen">
      <CustomScrollArea className="min-h-0 flex-1">
        <div className="wb-fcx-scroll">
          <SchedulerSettingsSection flushTop initialFocusField={initialFocusField} />
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default SchedulerSettingsScreen;
