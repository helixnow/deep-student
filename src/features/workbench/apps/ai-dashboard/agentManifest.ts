/**
 * AI 学习仪表盘 agentManifest（Generative UI Round 13）
 *
 * 观察闪卡到期 / 待办 / 制卡任务指标；execute 映射 workbenchBus 快捷动作。
 */
import { workbenchBus } from '../../core/workbenchBus';
import type { ActivationDispatchResult } from '../../core/workbenchBus';
import type {
  AgentActionResult,
  AppAgentManifest,
} from '../../core/types';
import {
  NO_ARGS_SCHEMA,
  objectSchema,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';
import {
  getActiveAnkiTaskCount,
  refreshAnkiTaskCount,
} from '../system/ankiTaskSource';
import {
  getFlashcardsDueCount,
  refreshFlashcardsDueCount,
} from '../system/flashcardsDueSource';
import {
  getTodoAgendaSnapshot,
  refreshTodoAgenda,
} from '../system/todoAgendaSource';
import { formatLocalDateKey } from '../../components/DesktopAgendaWidget';

export const AI_DASHBOARD_TYPE_ID = 'aiDashboard';

const FLASHCARDS_DUE_ACTIVATE = {
  typeId: 'flashcards',
  instanceKey: '',
  action: 'startReview',
  payload: { screen: 'session', mode: 'due' } as const,
  fallbackLaunch: {
    typeId: 'flashcards',
    reason: 'api' as const,
    payload: { screen: 'session', mode: 'due' } as const,
  },
};

function dashboardRef(): string {
  return stableAgentRef(AI_DASHBOARD_TYPE_ID, 'briefing');
}

function computeTodoMetrics(): { pendingTodos: number; overdueTodos: number } {
  const todayKey = formatLocalDateKey(new Date());
  const items = getTodoAgendaSnapshot().items;
  let overdueTodos = 0;
  for (const item of items) {
    if (item.dueDate && item.dueDate < todayKey) overdueTodos += 1;
  }
  return { pendingTodos: items.length, overdueTodos };
}

function observeMetrics() {
  const { pendingTodos, overdueTodos } = computeTodoMetrics();
  return {
    dueFlashcards: getFlashcardsDueCount(),
    pendingTodos,
    overdueTodos,
    activeAnkiTasks: getActiveAnkiTaskCount(),
    agendaLoading: getTodoAgendaSnapshot().isLoading,
  };
}

function launchAck(typeId: string): AgentActionResult {
  const windowId = workbenchBus.launch({ typeId, reason: 'api' });
  if (!windowId) {
    return {
      handled: false,
      changed: false,
      code: 'DISABLED',
      hint: '学习桌面未启用，无法打开应用',
    };
  }
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    details: { windowId, typeId },
  };
}

function activationActionResult(
  activation: ActivationDispatchResult,
  failureHint: string,
): AgentActionResult {
  const activationResult = activation.result ?? { handled: false };
  const handled = activation.delivered && activationResult.handled;
  return {
    handled,
    changed: handled,
    acknowledged: activationResult.acknowledged ?? handled,
    ...(handled ? {} : {
      code: activationResult.code ?? 'ACTIVATION_FAILED',
      hint: activationResult.hint ?? failureHint,
    }),
  };
}

export const aiDashboardAgentManifest: AppAgentManifest = {
  version: 2,
  description:
    '观察 AI 学习仪表盘简报（到期闪卡、待办进度、制卡任务），并触发复习、打开题库或制卡任务等快捷动作。',
  capabilities: [
    {
      name: 'startReview',
      description: '开始到期闪卡复习会话。',
      inputSchema: NO_ARGS_SCHEMA,
      risk: 'low',
      mutates: true,
      reversible: false,
      idempotent: false,
    },
    {
      name: 'openQbank',
      description: '打开题库应用窗口。',
      inputSchema: NO_ARGS_SCHEMA,
      risk: 'low',
      mutates: true,
      reversible: false,
      idempotent: true,
    },
    {
      name: 'openTaskDashboard',
      description: '打开制卡任务面板。',
      inputSchema: NO_ARGS_SCHEMA,
      risk: 'low',
      mutates: true,
      reversible: false,
      idempotent: true,
    },
    {
      name: 'refreshBriefing',
      description: '刷新仪表盘数据源（闪卡到期数、待办、制卡任务）。',
      inputSchema: NO_ARGS_SCHEMA,
      risk: 'read',
      mutates: true,
      reversible: false,
      idempotent: true,
    },
    {
      name: 'launchAction',
      description: '通过 ActionBar action id 触发仪表盘快捷动作（start-review / open-qbank / open-task-dashboard）。',
      inputSchema: objectSchema({
        actionId: {
          type: 'string',
          enum: ['start-review', 'open-qbank', 'open-task-dashboard'],
        },
      }, ['actionId']),
      risk: 'low',
      mutates: true,
      reversible: false,
      idempotent: false,
    },
  ],
  observe() {
    const metrics = observeMetrics();
    const ref = dashboardRef();
    const availableActions = ['refreshBriefing', 'startReview', 'openQbank'];
    if (metrics.activeAnkiTasks > 0) availableActions.push('openTaskDashboard');

    return {
      revision: stableRevision(metrics),
      route: 'ai-dashboard/briefing',
      busy: metrics.agendaLoading,
      availableActions,
      entities: [{
        ref,
        kind: 'ai-dashboard-briefing',
        label: 'AI 学习简报',
        actions: availableActions,
        state: metrics,
      }],
      affordances: [{
        ref,
        kind: 'ai-dashboard-briefing',
        label: 'AI 学习简报',
        actions: availableActions,
        selected: true,
        value: metrics,
      }],
      state: metrics,
    };
  },
  async execute(_ctx, action) {
    switch (action.name) {
      case 'startReview': {
        const result = await workbenchBus.activateDetailed(FLASHCARDS_DUE_ACTIVATE);
        return activationActionResult(result, '无法启动到期闪卡复习');
      }
      case 'openQbank':
        return launchAck('exam');
      case 'openTaskDashboard':
        return launchAck('taskDashboard');
      case 'refreshBriefing': {
        await Promise.all([
          refreshFlashcardsDueCount(),
          refreshTodoAgenda(),
          refreshAnkiTaskCount(),
        ]);
        return {
          handled: true,
          changed: true,
          acknowledged: true,
          details: observeMetrics(),
        };
      }
      case 'launchAction': {
        const actionId = action.args && typeof action.args === 'object'
          ? (action.args as { actionId?: unknown }).actionId
          : undefined;
        if (actionId === 'start-review') {
          const result = await workbenchBus.activateDetailed(FLASHCARDS_DUE_ACTIVATE);
          return activationActionResult(result, '无法启动到期闪卡复习');
        }
        if (actionId === 'open-qbank') {
          return launchAck('exam');
        }
        if (actionId === 'open-task-dashboard') {
          return launchAck('taskDashboard');
        }
        return {
          handled: false,
          changed: false,
          code: 'INVALID_ARGS',
          hint: 'actionId 必须是 start-review / open-qbank / open-task-dashboard',
        };
      }
      default:
        return {
          handled: false,
          code: 'CAPABILITY_NOT_FOUND',
          hint: `aiDashboard 未声明动作 ${action.name}`,
        };
    }
  },
};
