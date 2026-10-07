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

const en = demoLang === 'en-US';
const SETTINGS_STRINGS = {
  mcp_server_list: { builtinServerName: tr('内置工具', 'Built-in Tools') },
  automation: {
    action_type: { notify: tr('通知 + 待办', 'Notification + todo'), agent_turn: tr('Agent 任务', 'Agent task') },
    create: { capacity_full: tr('已达上限（{{max}} 个），请先删除或停用现有任务', 'Capacity reached ({{max}}). Delete or disable an existing automation first.') },
    delete: { heartbeat_blocked: tr('系统心跳任务不可删除，可停用', 'The system heartbeat automation cannot be deleted; you can disable it instead.') },
    errors: {
      desktop_only: tr('自动化管理需要 Deep Student 桌面应用。', 'Automation management requires the Deep Student desktop app.'),
      invalid_response: tr('自动化列表返回了无效数据。', 'The automation list returned invalid data.'),
    },
    weekdays: Object.fromEntries(
      (en ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['日', '一', '二', '三', '四', '五', '六']).map((d, i) => [String(i), d]),
    ),
  },
};

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
    // 待办窗口借用了 settings 命名空间里的几条文案：只补这几条，免得为它下整个 settings 文案包（150KB）
    const { default: i18n } = await import('@/i18n');
    i18n.addResourceBundle(demoLang, 'settings', SETTINGS_STRINGS, true, false);
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
