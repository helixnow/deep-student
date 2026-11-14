import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSquare, CircleNotch } from '@phosphor-icons/react';
import { ActionCard } from './ActionCard';
import { WeakConceptsStrip } from './WeakConceptsStrip';
import { dashboardCoreWidgets, type DashboardWidgetProps } from '@/ui-plugins/official/dashboard/api';

const TodoDueWidget: React.FC<DashboardWidgetProps> = ({ today, onNavigate }) => {
  const { t } = useTranslation('data');
  return (
    <ActionCard
      icon={<CheckSquare size={18} />}
      label={t('today_center.todo_due')}
      count={today.todoDue}
      hint={t('today_center.go')}
      highlight={today.todoDue > 0}
      onClick={() => onNavigate?.('todo')}
    />
  );
};

const ActiveJobsWidget: React.FC<DashboardWidgetProps> = ({ today, onNavigate }) => {
  const { t } = useTranslation('data');
  return (
    <ActionCard
      icon={<CircleNotch size={18} />}
      label={t('today_center.active_jobs')}
      count={today.activeJobs}
      hint={t('today_center.go')}
      highlight={false}
      spinning={today.activeJobs > 0}
      onClick={() => onNavigate?.('task-dashboard')}
    />
  );
};

const WeakConceptsWidget: React.FC<DashboardWidgetProps> = () => <WeakConceptsStrip />;

dashboardCoreWidgets.announce({ id: 'todo-due', order: 40, value: { size: 'sm', component: TodoDueWidget } });
dashboardCoreWidgets.announce({ id: 'active-jobs', order: 50, value: { size: 'sm', component: ActiveJobsWidget } });
dashboardCoreWidgets.announce({ id: 'weak-concepts', order: 70, value: { placement: 'below', size: 'sm', component: WeakConceptsWidget } });
