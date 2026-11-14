import { defineUiPlugin } from '@/ui-sdk';
import {
  contributeAnnouncedCharts,
  contributeAnnouncedStats,
  contributeAnnouncedWidgets,
  dashboardCoreCharts,
  dashboardCoreStats,
  dashboardCoreWidgets,
} from './api';

/**
 * Dashboard "today" section and overview. Declares `dashboard.widgets`, `dashboard.stats` and `dashboard.charts` and
 * contributes the todo / running-jobs cards, the weak concepts strip, the five statistics cards and the two charts,
 * which load with the dashboard chunk (`src/components/dashboard/coreWidgets.tsx`, `coreStats.tsx`, `coreCharts.tsx`).
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.dashboard' },
  apply(ctx) {
    ctx.ui.declareSlot({ name: 'dashboard.widgets', cardinality: 'list', description: '仪表盘「今日」区的小部件：placement header | row | below（默认 row），size sm | md | lg' });
    ctx.ui.declareSlot({ name: 'dashboard.stats', cardinality: 'list', description: '仪表盘总览的统计卡片：每条一个网格单元' });
    ctx.ui.declareSlot({ name: 'dashboard.charts', cardinality: 'list', description: '仪表盘总览的图表卡片：hasData 为 false 的不显示，全部没有数据时显示「暂无图表数据」' });
    contributeAnnouncedWidgets(ctx, dashboardCoreWidgets);
    contributeAnnouncedStats(ctx, dashboardCoreStats);
    contributeAnnouncedCharts(ctx, dashboardCoreCharts);
  },
}), { order: 145 });
