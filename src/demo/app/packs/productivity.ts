/**
 * 第 10 章「效率工具」：待办应用窗口（右侧驻留番茄钟面板），打开在「今日」视图。
 * 数据是一位同时备战考研和期末的学生这一周的待办；增删改、完成、子任务、改期、四象限、
 * 回收站、定时任务、番茄计时与统计都走 ./productivity/backend 的内存后端。
 */
import { demoLang, tr } from '../../lang';
import type { DemoAppPack, DemoArgs } from '../types';
import { handleProductivity, pomodoroStorageSeed } from './productivity/backend';

/** 待办主区顶部的「今日待复习」条（learning-today）：到期卡片 / 错题 */
function handleTodayLearning(cmd: string, _args: DemoArgs): unknown {
  if (cmd === 'fsrs_get_stats') {
    return { total: 186, due: 12, newCount: 20, learning: 6, review: 156, relearning: 4, suspended: 0, reviewsToday: 0, backlog: 0 };
  }
  if (cmd === 'review_plan_get_stats') return { due_today: 5, total_plans: 64 };
  return handleProductivity(cmd, _args);
}

let todoStore: typeof import('@/features/todo/stores/useTodoStore').useTodoStore | null = null;

const pack: DemoAppPack = {
  title: '待办与番茄钟',
  load: () => import('@/features/workbench/apps/system/TodoAppWindow').then((m) => m.default),
  handle: handleTodayLearning,
  namespaces: ['todo', 'common', 'workbench', 'app_menu'],
  localStorage: {
    'pomodoro-storage': pomodoroStorageSeed(),
  },
  async prepare() {
    // 待办窗口间接读到 MCP 内置服务器的显示名：只补这一条，免得为它下整个 settings 文案包
    const { default: i18n } = await import('@/i18n');
    i18n.addResource(demoLang, 'settings', 'mcp_server_list.builtinServerName', tr('内置工具', 'Built-in Tools'));
    const { useTodoStore } = await import('@/features/todo/stores/useTodoStore');
    useTodoStore.getState().setViewFilter('today');
    todoStore = useTodoStore;
  },
  async afterMount() {
    // initialize() 选中默认清单时会清空条目（非「全部」视图不自动重载），等它落定后重载今日视图
    const store = todoStore;
    if (!store) return;
    for (let i = 0; i < 50 && !store.getState().activeListId; i++) await new Promise((r) => setTimeout(r, 50));
    await store.getState().reloadCurrentView();
  },
  isReady: () => Boolean(todoStore && todoStore.getState().items.length > 0),
};

export default pack;
