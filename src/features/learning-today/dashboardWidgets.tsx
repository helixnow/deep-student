import React from 'react';
import { useTranslation } from 'react-i18next';
import { Cards, Notebook, WarningDiamond } from '@phosphor-icons/react';
import { ActionCard } from '@/components/dashboard/ActionCard';
import { WeeklyReportActions } from '@/components/dashboard/WeeklyReportActions';
import { learningTodayWidgets, type DashboardWidgetProps } from '@/ui-plugins/official/dashboard/api';
import { openTodayReviewTarget } from './openTodayReview';

const CardsDueWidget: React.FC<DashboardWidgetProps> = ({ today }) => {
  const { t } = useTranslation('data');
  return (
    <ActionCard
      icon={<Cards size={18} />}
      label={t('today_center.cards_due', { defaultValue: '到期卡片' })}
      count={today.cardsDue}
      hint={t('today_center.go')}
      highlight={today.cardsDue > 0}
      onClick={() => openTodayReviewTarget('cards')}
    />
  );
};

const MistakesDueWidget: React.FC<DashboardWidgetProps> = ({ today }) => {
  const { t } = useTranslation('data');
  return (
    <ActionCard
      icon={<WarningDiamond size={18} />}
      label={t('today_center.mistakes_due', { defaultValue: '错题复习' })}
      count={today.mistakesDue}
      hint={t('today_center.go')}
      highlight={today.mistakesDue > 0}
      onClick={() => openTodayReviewTarget('mistakes')}
    />
  );
};

const NotesDueWidget: React.FC<DashboardWidgetProps> = ({ today }) => {
  const { t } = useTranslation('data');
  return (
    <ActionCard
      icon={<Notebook size={18} />}
      label={t('today_center.notes_due', { defaultValue: '待复习笔记' })}
      count={today.notesDue}
      hint={t('today_center.go')}
      highlight={today.notesDue > 0}
      onClick={() => openTodayReviewTarget('notes')}
    />
  );
};

const WeeklyReportWidget: React.FC<DashboardWidgetProps> = () => <WeeklyReportActions />;

learningTodayWidgets.announce({ id: 'cards-due', order: 10, value: { size: 'sm', component: CardsDueWidget } });
learningTodayWidgets.announce({ id: 'mistakes-due', order: 20, value: { size: 'sm', component: MistakesDueWidget } });
learningTodayWidgets.announce({ id: 'notes-due', order: 30, value: { size: 'sm', component: NotesDueWidget } });
learningTodayWidgets.announce({ id: 'weekly-report', order: 60, value: { placement: 'header', size: 'sm', component: WeeklyReportWidget } });
