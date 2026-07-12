import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import type {
  ActivationContext,
  ActivationHandlerResult,
  AgentAffordanceNode,
  AgentEntitySummary,
  AppAgentManifest,
} from '../../core/types';
import {
  NO_ARGS_SCHEMA,
  actionArgs,
  executeActivation,
  objectSchema,
  rejectMismatchedTarget,
  shortLabel,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';
import { handleTodoActivation } from './todoActivation';

function todoListRef(id: string): string {
  return stableAgentRef('todo', 'list', id);
}

function todoItemRef(id: string): string {
  return stableAgentRef('todo', 'item', id);
}

export const todoAgentManifest: AppAgentManifest = {
  version: 2,
  description: '观察待办清单和可见事项并进行导航、搜索与筛选；待办数据增删改仍走 user_todo。',
  capabilities: [
    {
      name: 'showList', description: '打开指定待办清单。',
      inputSchema: objectSchema({ listId: { type: 'string', minLength: 1 } }, ['listId']),
      risk: 'read', mutates: true, reversible: true, idempotent: true,
      targetKinds: ['todo-list'],
    },
    {
      name: 'focusItem', description: '定位并选中指定待办事项。',
      inputSchema: objectSchema({ itemId: { type: 'string', minLength: 1 } }, ['itemId']),
      risk: 'read', mutates: true, reversible: false, idempotent: true,
      targetKinds: ['todo-item'],
    },
    {
      name: 'quickAdd', description: '打开快速添加表单，但不代替用户创建事项。',
      inputSchema: objectSchema({
        listId: { type: 'string', minLength: 1 },
        dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      }),
      risk: 'low', mutates: true, reversible: false, idempotent: false,
    },
    {
      name: 'showView', description: '切换全部、今日、近期、逾期、已完成或四象限视图。',
      inputSchema: objectSchema({ view: { type: 'string', enum: ['all', 'today', 'upcoming', 'overdue', 'completed', 'matrix'] } }, ['view']),
      risk: 'read', mutates: true, reversible: true, idempotent: true,
    },
    {
      name: 'search', description: '搜索待办事项；空字符串清除搜索。',
      inputSchema: objectSchema({ query: { type: 'string', maxLength: 500 } }, ['query']),
      risk: 'read', mutates: true, reversible: true, idempotent: true,
    },
    {
      name: 'setFilters', description: '设置优先级、完成项显示和排序方式。',
      inputSchema: objectSchema({
        priority: { type: ['string', 'null'], enum: [null, 'none', 'low', 'medium', 'high', 'urgent'] },
        showCompleted: { type: 'boolean' },
        sortBy: { type: 'string', enum: ['manual', 'dueDate', 'priority', 'title'] },
      }),
      risk: 'read', mutates: true, reversible: true, idempotent: true,
    },
  ],
  observe() {
    const state = useTodoStore.getState();
    const lists = state.lists.slice(0, 30);
    const items = state.items.slice(0, 80);
    const entities: AgentEntitySummary[] = [
      ...lists.map((list) => ({
        ref: todoListRef(list.id),
        kind: 'todo-list',
        label: shortLabel(list.title) ?? list.id,
        actions: ['showList'],
        state: { favorite: list.isFavorite, default: list.isDefault, updatedAt: list.updatedAt },
      })),
      ...items.map((item) => ({
        ref: todoItemRef(item.id),
        kind: 'todo-item',
        label: shortLabel(item.title) ?? item.id,
        actions: ['focusItem'],
        state: {
          listId: item.todoListId,
          status: item.status,
          priority: item.priority,
          dueDate: item.dueDate ?? null,
          dueTime: item.dueTime ?? null,
          updatedAt: item.updatedAt,
        },
      })),
    ];
    const listNodes: AgentAffordanceNode[] = lists.map((list) => ({
      ref: todoListRef(list.id), kind: 'todo-list', label: shortLabel(list.title) ?? list.id,
      actions: ['showList'], selected: list.id === state.activeListId, value: { listId: list.id },
    }));
    const itemNodes: AgentAffordanceNode[] = items.map((item) => ({
      ref: todoItemRef(item.id), kind: 'todo-item', label: shortLabel(item.title) ?? item.id,
      description: [item.priority, item.dueDate].filter(Boolean).join(' · '),
      actions: ['focusItem'], selected: item.id === state.selectedItemId,
      value: { itemId: item.id, listId: item.todoListId },
    }));
    return {
      revision: stableRevision(
        state.activeListId,
        state.selectedItemId,
        state.filter,
        state.quickAddPreset?.requestId,
        lists.map((list) => [list.id, list.updatedAt]),
        items.map((item) => [item.id, item.updatedAt]),
      ),
      route: `todo/${state.filter.view}/${state.activeListId ?? 'all'}`,
      mode: state.filter.view,
      busy: state.isLoadingLists || state.isLoadingItems,
      selection: state.selectedItemId ? [todoItemRef(state.selectedItemId)] : [],
      availableActions: ['showList', 'focusItem', 'quickAdd', 'showView', 'search', 'setFilters'],
      entities,
      affordances: [
        { ref: stableAgentRef('todo', 'lists'), kind: 'todo-lists', label: '清单', actions: [], children: listNodes },
        { ref: stableAgentRef('todo', 'items'), kind: 'todo-items', label: '当前事项', actions: [], children: itemNodes },
      ],
      state: {
        activeListId: state.activeListId,
        selectedItemId: state.selectedItemId,
        listCount: state.lists.length,
        itemCount: state.items.length,
        listsTruncated: state.lists.length > lists.length,
        itemsTruncated: state.items.length > items.length,
        overdueCount: state.overdueCount,
        view: state.filter.view,
        search: state.filter.search,
        priority: state.filter.priorityFilter,
        showCompleted: state.filter.showCompleted,
        sortBy: state.filter.sortBy,
        filtersRevision: stableRevision(state.filter),
        quickAddOpen: Boolean(state.quickAddPreset),
        error: state.error,
      },
    };
  },
  async execute(ctx, action) {
    const before = useTodoStore.getState();
    const requestedArgs = actionArgs(action);
    if (action.name === 'showList' && typeof requestedArgs.listId === 'string') {
      const mismatch = rejectMismatchedTarget(action, todoListRef(requestedArgs.listId));
      if (mismatch) return mismatch;
    }
    if (action.name === 'focusItem' && typeof requestedArgs.itemId === 'string') {
      const mismatch = rejectMismatchedTarget(action, todoItemRef(requestedArgs.itemId));
      if (mismatch) return mismatch;
    }
    const snapshot = {
      activeListId: before.activeListId,
      selectedItemId: before.selectedItemId,
      filter: { ...before.filter },
      quickAddRequestId: before.quickAddPreset?.requestId ?? null,
    };
      const result = await executeActivation(handleTodoActivation, ctx, action);
    if (!result.handled) return result;
    const after = useTodoStore.getState();
    result.changed = stableRevision(snapshot) !== stableRevision({
      activeListId: after.activeListId,
      selectedItemId: after.selectedItemId,
      filter: after.filter,
      quickAddRequestId: after.quickAddPreset?.requestId ?? null,
    });
    const args = requestedArgs;
    if (action.name === 'focusItem' && typeof args.itemId === 'string') {
      result.entityRefs = [todoItemRef(args.itemId)];
      result.postconditions = [{ kind: 'selection_includes', ref: todoItemRef(args.itemId) }];
    } else if (action.name === 'showList' && typeof args.listId === 'string') {
      result.entityRefs = [todoListRef(args.listId)];
      result.postconditions = [{ kind: 'state_equals', path: 'activeListId', value: args.listId }];
      if (result.changed && snapshot.activeListId) {
        result.undo = {
          inverse: {
            name: 'showList',
            args: { listId: snapshot.activeListId },
            targetRef: todoListRef(snapshot.activeListId),
            expect: [{ kind: 'state_equals', path: 'activeListId', value: snapshot.activeListId }],
          },
          label: '恢复待办清单',
        };
      }
    } else if (action.name === 'showView') {
      result.postconditions = [{ kind: 'state_equals', path: 'view', value: String(args.view ?? '') }];
      if (result.changed) result.undo = { inverse: { name: 'showView', args: { view: snapshot.filter.view }, expect: [{ kind: 'state_equals', path: 'view', value: snapshot.filter.view }] }, label: '恢复待办视图' };
    } else if (action.name === 'search') {
      result.postconditions = [{ kind: 'state_equals', path: 'search', value: String(args.query ?? '') }];
      if (result.changed) result.undo = { inverse: { name: 'search', args: { query: snapshot.filter.search }, expect: [{ kind: 'state_equals', path: 'search', value: snapshot.filter.search }] }, label: '恢复待办搜索' };
    } else if (action.name === 'setFilters' && result.changed) {
      const restoredRevision = stableRevision(snapshot.filter);
      result.undo = {
        inverse: {
          name: 'setFilters',
          args: {
            priority: snapshot.filter.priorityFilter,
            showCompleted: snapshot.filter.showCompleted,
            sortBy: snapshot.filter.sortBy,
          },
          expect: [{ kind: 'state_equals', path: 'filtersRevision', value: restoredRevision }],
        },
        label: '恢复待办筛选',
      };
    } else if (action.name === 'setFilters') {
      result.postconditions = [{ kind: 'state_equals', path: 'filtersRevision', value: stableRevision(after.filter) }];
    } else if (action.name === 'quickAdd') {
      result.postconditions = [{ kind: 'state_equals', path: 'quickAddOpen', value: true }];
    }
    return result;
  },
};

function cardRef(id: string): string {
  return stableAgentRef('flashcards', 'card', id);
}

export function createFlashcardsAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察并导航闪卡复习；翻面可用，但评分始终保留给用户。',
    capabilities: [
      {
        name: 'startReview', description: '按到期卡或指定卡片批次开始复习。',
        inputSchema: objectSchema({
          screen: { type: 'string', enum: ['today', 'library', 'settings', 'session'] },
          mode: { type: 'string', enum: ['due', 'batch'] },
          cardIds: { type: 'array', items: { type: 'string' }, maxItems: 200 },
        }),
        risk: 'medium', mutates: true, reversible: false, idempotent: false,
      },
      {
        name: 'showScreen', description: '切换到今日、卡片库、设置或复习界面。',
        inputSchema: objectSchema({ screen: { type: 'string', enum: ['today', 'library', 'settings', 'session'] } }, ['screen']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
      { name: 'startDueReview', description: '加载到期卡并开始复习会话。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: false },
      { name: 'flipCard', description: '在当前卡片正反面之间切换；不会评分。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: true, idempotent: false, targetKinds: ['flashcard'] },
      { name: 'endReview', description: '结束当前复习会话并返回今日页面。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: true },
    ],
    observe() {
      const state = useFsrsReviewStore.getState();
      const current = state.queue[state.queueIndex];
      const visible = state.screen === 'session'
        ? state.queue.slice(Math.max(0, state.queueIndex), state.queueIndex + 30)
        : state.dueCards.slice(0, 30);
      const entities: AgentEntitySummary[] = visible.map((card, index) => ({
        ref: cardRef(card.ankiCardId ?? card.id),
        kind: 'flashcard',
        label: shortLabel(card.front) ?? card.ankiCardId ?? card.id,
        actions: index === 0 && state.screen === 'session' ? ['flipCard'] : [],
        state: {
          cardStateId: card.id,
          ankiCardId: card.ankiCardId ?? null,
          current: card.id === current?.id,
        },
      }));
      return {
        revision: stableRevision(state.screen, state.dueCards.map((card) => card.id), state.queue.map((card) => card.id), state.queueIndex, state.flipped, state.loading, state.ratingBusy),
        route: `flashcards/${state.screen}`,
        mode: state.screen === 'session' ? (state.flipped ? 'back' : 'front') : state.screen,
        busy: state.loading || state.ratingBusy,
        selection: current ? [cardRef(current.ankiCardId ?? current.id)] : [],
        availableActions: ['startReview', 'showScreen', 'startDueReview', ...(state.screen === 'session' && current ? ['flipCard', 'endReview'] : [])],
        entities,
        affordances: visible.map((card) => ({
          ref: cardRef(card.ankiCardId ?? card.id),
          kind: 'flashcard',
          label: shortLabel(card.front) ?? card.ankiCardId ?? card.id,
          actions: card.id === current?.id ? ['flipCard'] : [],
          selected: card.id === current?.id,
          value: { cardId: card.ankiCardId ?? card.id },
        })),
        state: {
          screen: state.screen,
          dueCount: state.dueCards.length,
          queueLength: state.queue.length,
          queueIndex: state.queueIndex,
          currentCardId: current?.id ?? null,
          currentAnkiCardId: current?.ankiCardId ?? null,
          flipped: state.flipped,
          sessionDone: state.queue.length > 0 && state.queueIndex >= state.queue.length,
          usingMock: state.usingMock,
          error: state.error,
          ratingAvailableToAgent: false,
        },
      };
    },
    async execute(ctx, action) {
      const before = useFsrsReviewStore.getState();
      const snapshot = { screen: before.screen, queueIndex: before.queueIndex, currentCardId: before.queue[before.queueIndex]?.id ?? null, flipped: before.flipped };
      const requestedArgs = actionArgs(action);
      if (action.name === 'flipCard' && before.queue[before.queueIndex]) {
        const current = before.queue[before.queueIndex];
        const mismatch = rejectMismatchedTarget(
          action,
          cardRef(current.ankiCardId ?? current.id),
        );
        if (mismatch) return mismatch;
      }
      let result;
      if (action.name === 'startReview') {
        const store = useFsrsReviewStore.getState();
        const mode = requestedArgs.mode;
        const screen = requestedArgs.screen;
        if (screen === 'session' && mode === 'due') {
          await store.loadDue();
          useFsrsReviewStore.getState().startDueSession();
          result = { handled: true };
        } else if (screen === 'session' && mode === 'batch' && Array.isArray(requestedArgs.cardIds)) {
          const ids = requestedArgs.cardIds.filter((id): id is string => typeof id === 'string');
          await store.startBatchSession(ids);
          result = { handled: true };
        } else if (screen === 'today' || screen === 'library' || screen === 'settings') {
          store.setScreen(screen);
          result = { handled: true };
        } else {
          return { handled: false, changed: false, code: 'INVALID_ARGS', hint: 'startReview 需要有效 screen/mode/cardIds' };
        }
      } else {
        result = await executeActivation(activation, ctx, action);
      }
      if (!result.handled) return result;
      const after = useFsrsReviewStore.getState();
      const current = after.queue[after.queueIndex];
      result.changed = stableRevision(snapshot) !== stableRevision({ screen: after.screen, queueIndex: after.queueIndex, currentCardId: current?.id ?? null, flipped: after.flipped });
      if (current) result.entityRefs = [cardRef(current.ankiCardId ?? current.id)];
      const args = requestedArgs;
      if (action.name === 'showScreen' && typeof args.screen === 'string') {
        result.postconditions = [{ kind: 'state_equals', path: 'screen', value: args.screen }];
        if (result.changed) {
          result.undo = {
            inverse: { name: 'showScreen', args: { screen: snapshot.screen }, expect: [{ kind: 'state_equals', path: 'screen', value: snapshot.screen }] },
            label: '恢复闪卡页面',
          };
        }
      } else if (action.name === 'flipCard' && current) {
        result.postconditions = [{ kind: 'state_equals', path: 'flipped', value: after.flipped }];
        if (result.changed && snapshot.currentCardId === current.id) {
          result.undo = {
            inverse: {
              name: 'flipCard',
              targetRef: cardRef(current.ankiCardId ?? current.id),
              expect: [
                { kind: 'state_equals', path: 'currentCardId', value: current.id },
                { kind: 'state_equals', path: 'flipped', value: snapshot.flipped },
              ],
            },
            label: '恢复卡片正反面',
          };
        }
      } else if (action.name === 'endReview') {
        result.postconditions = [{ kind: 'state_equals', path: 'screen', value: 'today' }];
      } else if (action.name === 'startDueReview') {
        result.postconditions = [{ kind: 'state_equals', path: 'screen', value: 'session' }];
      } else if (action.name === 'startReview') {
        result.postconditions = [{ kind: 'state_equals', path: 'screen', value: after.screen }];
      }
      return result;
    },
  };
}

export function createPomodoroAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察和控制番茄钟。停止会写入中断记录，属于高风险且不可完整撤销。',
    capabilities: [
      {
        name: 'start', description: '开始番茄，可关联待办任务。',
        inputSchema: objectSchema({ taskId: { type: 'string' }, taskTitle: { type: 'string', maxLength: 500 } }),
        risk: 'medium', mutates: true, reversible: false, idempotent: false,
      },
      { name: 'pause', description: '暂停当前番茄；严格模式工作阶段会拒绝。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: true, idempotent: true },
      { name: 'resume', description: '继续已暂停的番茄。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: true },
      { name: 'stop', description: '停止番茄并按中断写入记录。', inputSchema: NO_ARGS_SCHEMA, risk: 'high', mutates: true, reversible: false, idempotent: true },
    ],
    observe() {
      const state = usePomodoroStore.getState();
      const sessionRef = state.sessionStartTime
        ? stableAgentRef('pomodoro', 'session', state.sessionStartTime)
        : stableAgentRef('pomodoro', 'idle');
      return {
        revision: stableRevision(state.mode, state.status, state.sessionStartTime, state.currentTaskId, state.phaseEndsAt, state.phaseStartedAt, state.timeLeft),
        route: `pomodoro/${state.mode}`,
        mode: state.mode,
        availableActions: state.mode === 'idle'
          ? ['start']
          : state.status === 'running'
            ? ['pause', 'stop']
            : ['resume', 'stop'],
        entities: [{
          ref: sessionRef,
          kind: 'pomodoro-session',
          label: shortLabel(state.currentTaskTitle) ?? (state.mode === 'idle' ? '未开始' : '未关联任务'),
          actions: state.mode === 'idle' ? ['start'] : state.status === 'running' ? ['pause', 'stop'] : ['resume', 'stop'],
          state: { mode: state.mode, status: state.status, taskId: state.currentTaskId, timeLeft: state.timeLeft },
        }],
        affordances: [{ ref: sessionRef, kind: 'pomodoro-session', label: shortLabel(state.currentTaskTitle) ?? state.mode, actions: state.mode === 'idle' ? ['start'] : state.status === 'running' ? ['pause', 'stop'] : ['resume', 'stop'], selected: state.mode !== 'idle' }],
        state: {
          mode: state.mode,
          status: state.status,
          timeLeft: state.timeLeft,
          currentTaskId: state.currentTaskId,
          currentTaskTitle: state.currentTaskTitle,
          sessionStartTime: state.sessionStartTime,
          phaseStartedAt: state.phaseStartedAt,
          phaseEndsAt: state.phaseEndsAt,
          strictMode: state.settings.strictMode,
          countUp: state.settings.countUp,
          completedPomodorosToday: state.completedPomodorosToday,
        },
      };
    },
    async execute(ctx, action) {
      const before = usePomodoroStore.getState();
      const snapshot = { mode: before.mode, status: before.status, sessionStartTime: before.sessionStartTime, currentTaskId: before.currentTaskId };
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const after = usePomodoroStore.getState();
      result.changed = stableRevision(snapshot) !== stableRevision({ mode: after.mode, status: after.status, sessionStartTime: after.sessionStartTime, currentTaskId: after.currentTaskId });
      if (action.name === 'start') {
        result.postconditions = [
          { kind: 'state_equals', path: 'mode', value: 'work' },
          { kind: 'state_equals', path: 'status', value: 'running' },
        ];
      } else if (action.name === 'pause') {
        result.postconditions = [{ kind: 'state_equals', path: 'status', value: 'paused' }];
        if (result.changed) {
          result.undo = {
            inverse: { name: 'resume', expect: [{ kind: 'state_equals', path: 'status', value: 'running' }] },
            label: '继续番茄钟',
          };
        }
      } else if (action.name === 'resume') {
        result.postconditions = [{ kind: 'state_equals', path: 'status', value: 'running' }];
      } else if (action.name === 'stop') {
        result.postconditions = [{ kind: 'state_equals', path: 'mode', value: 'idle' }];
      }
      return result;
    },
  };
}
