import { defineUiPlugin } from '@/ui-sdk';
import { contributeAnnouncedWidgets, learningTodayWidgets } from '../dashboard/api';

/**
 * The three review lines (cards / mistakes / notes due today) and the weekly report links on the dashboard. They load
 * with the dashboard chunk (`src/features/learning-today/dashboardWidgets.tsx`); `dstu.ui.dashboard` owns the slot.
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.learning-today' },
  apply(ctx) {
    contributeAnnouncedWidgets(ctx, learningTodayWidgets);
  },
}), { order: 155 });
