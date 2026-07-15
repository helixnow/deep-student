import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { useFlashcardsLibraryStore } from '@/features/flashcards/store/libraryStore';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
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
import {
  getTaskDashboardAgentSurface,
  getTemplateAgentSurface,
} from './agentSurfaceRegistry';

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
    if (!result.changed) {
      return {
        handled: false,
        changed: false,
        code: 'ACTION_UNAVAILABLE',
        hint: `${action.name} 未改变待办状态`,
      };
    }
    result.acknowledged = true;
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
    } else if (action.name === 'setFilters') {
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
    } else if (action.name === 'quickAdd') {
      result.postconditions = [{ kind: 'state_equals', path: 'quickAddOpen', value: true }];
    }
    return result;
  },
};

function cardRef(id: string): string {
  return stableAgentRef('flashcards', 'card', id);
}

function boundedCardText(value: string | null | undefined): { value: string | null; truncated: boolean } {
  if (typeof value !== 'string') return { value: null, truncated: false };
  return value.length <= 2_000
    ? { value, truncated: false }
    : { value: value.slice(0, 2_000), truncated: true };
}

const LIBRARY_CARD_ACTIONS = new Set([
  'editCard',
  'enqueueCard',
  'setSuspended',
  'undoLastReview',
  'deleteCard',
]);

export function createFlashcardsAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察并管理真实闪卡库与复习会话；支持搜索、分页、编辑、入队、暂停、撤销和确认删除，但评分始终保留给用户。',
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
      {
        name: 'searchLibrary', description: '搜索真实卡片库；空字符串清除搜索。',
        inputSchema: objectSchema({ query: { type: 'string', maxLength: 500 } }, ['query']),
        risk: 'read', mutates: true, reversible: true, idempotent: true,
      },
      {
        name: 'setLibraryPage', description: '切换卡片库分页。',
        inputSchema: objectSchema({ page: { type: 'integer', minimum: 1 } }, ['page']),
        risk: 'read', mutates: true, reversible: true, idempotent: true,
      },
      {
        name: 'editCard', description: '编辑观察到的卡片内容；不会评分。',
        inputSchema: {
          ...objectSchema({
            cardId: { type: 'string', minLength: 1 },
            front: { type: 'string', maxLength: 20_000 },
            back: { type: 'string', maxLength: 20_000 },
            text: { type: 'string', maxLength: 20_000 },
            tags: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 100 },
          }, ['cardId']),
          anyOf: [
            { required: ['front'] },
            { required: ['back'] },
            { required: ['text'] },
            { required: ['tags'] },
          ],
        },
        risk: 'medium', mutates: true, reversible: false, idempotent: true,
        targetKinds: ['flashcard'], targetOptional: true, targetIdPath: 'cardId',
      },
      {
        name: 'enqueueCard', description: '将观察到的未入队卡片加入复习计划。',
        inputSchema: objectSchema({ cardId: { type: 'string', minLength: 1 } }, ['cardId']),
        risk: 'medium', mutates: true, reversible: false, idempotent: true,
        targetKinds: ['flashcard'], targetOptional: true, targetIdPath: 'cardId',
      },
      {
        name: 'setSuspended', description: '暂停或恢复观察到的已入队卡片。',
        inputSchema: objectSchema({
          cardId: { type: 'string', minLength: 1 },
          suspended: { type: 'boolean' },
        }, ['cardId', 'suspended']),
        risk: 'medium', mutates: true, reversible: true, idempotent: true,
        targetKinds: ['flashcard'], targetOptional: true, targetIdPath: 'cardId',
      },
      {
        name: 'undoLastReview', description: '撤销观察到的卡片最新一次评分；不会产生新评分。',
        inputSchema: objectSchema({ cardId: { type: 'string', minLength: 1 } }, ['cardId']),
        risk: 'high', mutates: true, reversible: false, idempotent: false,
        targetKinds: ['flashcard'], targetOptional: true, targetIdPath: 'cardId',
      },
      {
        name: 'deleteCard', description: '永久删除观察到的单张库卡；必须经过 High 风险确认。',
        inputSchema: objectSchema({ cardId: { type: 'string', minLength: 1 } }, ['cardId']),
        risk: 'high', mutates: true, reversible: false, idempotent: false,
        targetKinds: ['flashcard'], targetOptional: true, targetIdPath: 'cardId',
      },
    ],
    observe() {
      const state = useFsrsReviewStore.getState();
      const library = useFlashcardsLibraryStore.getState();
      const current = state.queue[state.queueIndex];
      const visibleReviewCards = state.screen === 'session'
        ? state.queue.slice(Math.max(0, state.queueIndex), state.queueIndex + 30)
        : state.screen === 'library' ? [] : state.dueCards.slice(0, 30);
      const entities: AgentEntitySummary[] = state.screen === 'library'
        ? library.items.slice(0, 30).map((card) => {
          const actions = [
            'editCard',
            'deleteCard',
            ...(card.enqueued ? ['startReview', 'setSuspended'] : ['enqueueCard']),
            ...(card.latestReview?.undoable ? ['undoLastReview'] : []),
          ];
          return {
            ref: cardRef(card.id),
            kind: 'flashcard',
            label: shortLabel(card.front) ?? card.id,
            actions,
            state: {
              ankiCardId: card.id,
              cardStateId: card.stateId ?? null,
              version: card.version ?? card.updated_at,
              reviewVersion: card.reviewVersion ?? null,
              enqueued: card.enqueued,
              suspended: card.suspended,
              due: card.isDue,
              latestReviewLogId: card.latestReview?.logId ?? null,
            },
          };
        })
        : visibleReviewCards.map((card, index) => {
          const isCurrent = index === 0 && state.screen === 'session';
          const canUndo = isCurrent && state.lastReview?.cardStateId === card.id;
          return {
            ref: cardRef(card.ankiCardId ?? card.id),
            kind: 'flashcard',
            label: shortLabel(card.front) ?? card.ankiCardId ?? card.id,
            actions: isCurrent
              ? ['flipCard', 'editCard', 'setSuspended', ...(canUndo ? ['undoLastReview'] : [])]
              : [],
            state: {
              cardStateId: card.id,
              ankiCardId: card.ankiCardId ?? null,
              current: card.id === current?.id,
              suspended: card.suspended ?? false,
            },
          };
        });
      const entityActions = new Set(entities.flatMap((entity) => entity.actions));
      const libraryItems = library.items.slice(0, 30).map((card) => {
        const front = boundedCardText(card.front);
        const back = boundedCardText(card.back);
        const text = boundedCardText(card.text);
        return {
          id: card.id,
          documentId: card.documentId ?? null,
          version: card.version ?? card.updated_at,
          reviewVersion: card.reviewVersion ?? null,
          front: front.value,
          back: back.value,
          text: text.value,
          tags: card.tags.slice(0, 100),
          enqueued: card.enqueued,
          suspended: card.suspended,
          due: card.isDue,
          latestReview: card.latestReview ?? null,
          truncated: front.truncated || back.truncated || text.truncated || card.tags.length > 100,
        };
      });
      return {
        revision: stableRevision(
          state.screen,
          state.dueCards.map((card) => card.id),
          state.queue.map((card) => card.id),
          state.queueIndex,
          state.flipped,
          state.loading,
          state.ratingBusy,
          library.page,
          library.query,
          library.loading,
          library.busyCardId,
          library.items.map((card) => [
            card.id,
            card.version ?? card.updated_at,
            card.reviewVersion ?? null,
            card.suspended,
            card.enqueued,
          ]),
        ),
        route: `flashcards/${state.screen}`,
        mode: state.screen === 'session' ? (state.flipped ? 'back' : 'front') : state.screen,
        busy: state.loading || state.ratingBusy || (state.screen === 'library' && (library.loading || library.busyCardId !== null)),
        selection: current ? [cardRef(current.ankiCardId ?? current.id)] : [],
        availableActions: [
          'startReview',
          'showScreen',
          'startDueReview',
          ...(state.screen === 'library' ? ['searchLibrary', 'setLibraryPage'] : []),
          ...(state.screen === 'session' && current ? ['flipCard', 'endReview'] : []),
          ...entityActions,
        ],
        entities,
        affordances: entities.map((entity) => ({
          ref: entity.ref,
          kind: entity.kind,
          label: entity.label,
          actions: entity.actions,
          selected: entity.state?.current === true,
          value: { cardId: entity.state?.ankiCardId ?? null },
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
          library: {
            items: libraryItems,
            total: library.total,
            page: library.page,
            pageSize: library.pageSize,
            query: library.query,
            loading: library.loading,
            loaded: library.loaded,
            loadError: library.loadError,
            actionError: library.actionError,
            busyCardId: library.busyCardId,
            itemsTruncated: library.items.length > 30,
          },
          ratingAvailableToAgent: false,
        },
      };
    },
    async execute(ctx, action) {
      const before = useFsrsReviewStore.getState();
      const beforeLibrary = useFlashcardsLibraryStore.getState();
      const snapshot = {
        screen: before.screen,
        queueIndex: before.queueIndex,
        currentCardId: before.queue[before.queueIndex]?.id ?? null,
        flipped: before.flipped,
        libraryPage: beforeLibrary.page,
        libraryQuery: beforeLibrary.query,
        libraryRevision: stableRevision(beforeLibrary.items.map((card) => [card.id, card.version ?? card.updated_at, card.reviewVersion ?? null, card.suspended, card.enqueued])),
      };
      const requestedArgs = actionArgs(action);
      if (LIBRARY_CARD_ACTIONS.has(action.name)) {
        const cardId = typeof requestedArgs.cardId === 'string' ? requestedArgs.cardId.trim() : '';
        if (!cardId) return { handled: false, changed: false, code: 'INVALID_ARGS', hint: `${action.name} 需要 cardId` };
        if (!action.targetRef) return { handled: false, changed: false, code: 'TARGET_REQUIRED', hint: `${action.name} 需要最近观察返回的 targetRef` };
        const mismatch = rejectMismatchedTarget(action, cardRef(cardId));
        if (mismatch) return mismatch;
      } else if (action.name === 'flipCard' && before.queue[before.queueIndex]) {
        const current = before.queue[before.queueIndex];
        const mismatch = rejectMismatchedTarget(
          action,
          cardRef(current.ankiCardId ?? current.id),
        );
        if (mismatch) return mismatch;
      }
      let result;
      if (action.name === 'searchLibrary') {
        if (before.screen !== 'library') return { handled: false, changed: false, code: 'INVALID_STATE', hint: '当前不在卡片库页面' };
        const query = typeof requestedArgs.query === 'string' ? requestedArgs.query : '';
        const ok = await beforeLibrary.submitSearch(query);
        result = ok ? { handled: true, acknowledged: true } : { handled: false, changed: false, code: 'LOAD_FAILED', hint: useFlashcardsLibraryStore.getState().loadError ?? '卡片库搜索失败' };
      } else if (action.name === 'setLibraryPage') {
        if (before.screen !== 'library' || typeof requestedArgs.page !== 'number') return { handled: false, changed: false, code: 'INVALID_ARGS', hint: 'setLibraryPage 需要卡片库页面和有效 page' };
        const ok = await beforeLibrary.goToPage(requestedArgs.page);
        result = ok ? { handled: true, acknowledged: true } : { handled: false, changed: false, code: 'ACTION_UNAVAILABLE', hint: '目标页不可用或未变化' };
      } else if (LIBRARY_CARD_ACTIONS.has(action.name)) {
        const cardId = String(requestedArgs.cardId);
        const libraryCard = beforeLibrary.items.find((card) => card.id === cardId);
        const currentBefore = before.queue[before.queueIndex];
        const currentAnkiId = currentBefore?.ankiCardId ?? currentBefore?.id;
        let ok = false;
        if (action.name === 'editCard') {
          const hasPatch = ['front', 'back', 'text', 'tags'].some((key) => requestedArgs[key] !== undefined);
          if (!hasPatch) return { handled: false, changed: false, code: 'INVALID_ARGS', hint: 'editCard 至少需要一个修改字段' };
          if (before.screen === 'session' && currentBefore && currentAnkiId === cardId) {
            const front = typeof requestedArgs.text === 'string'
              ? requestedArgs.text
              : typeof requestedArgs.front === 'string'
                ? requestedArgs.front
                : currentBefore.text ?? currentBefore.front;
            const back = typeof requestedArgs.back === 'string' ? requestedArgs.back : currentBefore.back;
            ok = await before.updateCurrentCard(front, back);
          } else if (libraryCard) {
            ok = await beforeLibrary.updateCard(cardId, {
              ...(typeof requestedArgs.front === 'string' ? { front: requestedArgs.front } : {}),
              ...(typeof requestedArgs.back === 'string' ? { back: requestedArgs.back } : {}),
              ...(typeof requestedArgs.text === 'string' ? { text: requestedArgs.text } : {}),
              ...(Array.isArray(requestedArgs.tags) && requestedArgs.tags.every((tag) => typeof tag === 'string')
                ? { tags: requestedArgs.tags as string[] }
                : {}),
            });
          }
        } else if (action.name === 'enqueueCard' && libraryCard && !libraryCard.enqueued) {
          ok = await beforeLibrary.enqueueCard(cardId);
        } else if (action.name === 'setSuspended' && typeof requestedArgs.suspended === 'boolean') {
          if (libraryCard?.enqueued) {
            ok = await beforeLibrary.setCardSuspended(cardId, requestedArgs.suspended);
          } else if (before.screen === 'session' && currentBefore && currentAnkiId === cardId && requestedArgs.suspended) {
            ok = await before.suspendCurrent();
          }
        } else if (action.name === 'undoLastReview') {
          const reviewed = before.lastReview
            ? before.queue.find((card) => card.id === before.lastReview?.cardStateId)
            : undefined;
          if (reviewed && (reviewed.ankiCardId ?? reviewed.id) === cardId) {
            ok = await before.undoLastReview();
          } else if (libraryCard?.latestReview?.undoable) {
            ok = await beforeLibrary.undoLastReview(cardId);
          }
        } else if (action.name === 'deleteCard' && libraryCard) {
          ok = await beforeLibrary.deleteCard(cardId);
        }
        if (!ok) {
          return {
            handled: false,
            changed: false,
            code: 'ACTION_FAILED',
            hint: useFlashcardsLibraryStore.getState().actionError ?? useFsrsReviewStore.getState().error ?? `${action.name} 未执行`,
          };
        }
        result = { handled: true, acknowledged: true };
      } else if (action.name === 'startReview') {
        const store = useFsrsReviewStore.getState();
        const mode = requestedArgs.mode;
        const screen = requestedArgs.screen;
        if (screen === 'session' && mode === 'due') {
          if (!(await store.loadDue())) {
            return {
              handled: false,
              changed: false,
              code: 'LOAD_FAILED',
              hint: useFsrsReviewStore.getState().error ?? '到期卡加载失败',
            };
          }
          useFsrsReviewStore.getState().startDueSession();
          result = { handled: true, acknowledged: true };
        } else if (screen === 'session' && mode === 'batch' && Array.isArray(requestedArgs.cardIds)) {
          const ids = requestedArgs.cardIds.filter((id): id is string => typeof id === 'string');
          if (!(await store.startBatchSession(ids))) {
            return {
              handled: false,
              changed: false,
              code: 'ENQUEUE_FAILED',
              hint: useFsrsReviewStore.getState().error ?? '复习批次准备失败',
            };
          }
          result = { handled: true, acknowledged: true };
        } else if (screen === 'today' || screen === 'library' || screen === 'settings') {
          store.setScreen(screen);
          result = { handled: true, acknowledged: true };
        } else {
          return { handled: false, changed: false, code: 'INVALID_ARGS', hint: 'startReview 需要有效 screen/mode/cardIds' };
        }
      } else {
        result = await executeActivation(activation, ctx, action);
      }
      if (!result.handled) return result;
      const after = useFsrsReviewStore.getState();
      const afterLibrary = useFlashcardsLibraryStore.getState();
      const current = after.queue[after.queueIndex];
      result.changed = stableRevision(snapshot) !== stableRevision({
        screen: after.screen,
        queueIndex: after.queueIndex,
        currentCardId: current?.id ?? null,
        flipped: after.flipped,
        libraryPage: afterLibrary.page,
        libraryQuery: afterLibrary.query,
        libraryRevision: stableRevision(afterLibrary.items.map((card) => [card.id, card.version ?? card.updated_at, card.reviewVersion ?? null, card.suspended, card.enqueued])),
      });
      if (!result.changed) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 未改变闪卡复习状态`,
        };
      }
      result.acknowledged = true;
      const requestedCardId = typeof requestedArgs.cardId === 'string' ? requestedArgs.cardId : null;
      if (requestedCardId) result.entityRefs = [cardRef(requestedCardId)];
      else if (current) result.entityRefs = [cardRef(current.ankiCardId ?? current.id)];
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
        result.postconditions = [{ kind: 'state_equals', path: 'flipped', value: !snapshot.flipped }];
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
        result.postconditions = [{
          kind: 'state_equals',
          path: 'screen',
          value: requestedArgs.screen === 'session' ? 'session' : String(requestedArgs.screen ?? ''),
        }];
      } else if (action.name === 'searchLibrary') {
        result.postconditions = [{ kind: 'state_equals', path: 'library.query', value: String(requestedArgs.query ?? '').trim() }];
        result.undo = {
          inverse: { name: 'searchLibrary', args: { query: snapshot.libraryQuery }, expect: [{ kind: 'state_equals', path: 'library.query', value: snapshot.libraryQuery }] },
          label: '恢复卡片库搜索',
        };
      } else if (action.name === 'setLibraryPage') {
        result.postconditions = [{ kind: 'state_equals', path: 'library.page', value: afterLibrary.page }];
        result.undo = {
          inverse: { name: 'setLibraryPage', args: { page: snapshot.libraryPage }, expect: [{ kind: 'state_equals', path: 'library.page', value: snapshot.libraryPage }] },
          label: '恢复卡片库页码',
        };
      } else if (requestedCardId && action.name === 'deleteCard') {
        result.postconditions = [{ kind: 'ref_absent', ref: cardRef(requestedCardId) }];
      } else if (requestedCardId && LIBRARY_CARD_ACTIONS.has(action.name)) {
        result.postconditions = [{ kind: 'ref_exists', ref: cardRef(requestedCardId) }];
        if (action.name === 'setSuspended' && typeof requestedArgs.suspended === 'boolean') {
          result.undo = {
            inverse: {
              name: 'setSuspended',
              args: { cardId: requestedCardId, suspended: !requestedArgs.suspended },
              targetRef: cardRef(requestedCardId),
              expect: [{ kind: 'ref_exists', ref: cardRef(requestedCardId) }],
            },
            label: requestedArgs.suspended ? '恢复卡片' : '重新暂停卡片',
          };
        }
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
      if (!result.changed) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 未改变番茄钟状态`,
        };
      }
      result.acknowledged = true;
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

const SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'automation',
  'apis',
  'search',
  'models',
  'mcp',
  'statistics',
  'data-governance',
  'params',
  'shortcuts',
  'about',
] as const;

export const settingsAgentManifest: AppAgentManifest = {
  version: 2,
  description: 'Observe settings navigation and open a safe settings section. Setting values still use domain tools or direct user input.',
  capabilities: [
    {
      name: 'openSection',
      description: 'Open a settings section without changing any setting value.',
      inputSchema: objectSchema(
        { section: { type: 'string', enum: [...SETTINGS_SECTIONS] } },
        ['section'],
      ),
      risk: 'read',
      mutates: true,
      reversible: true,
      idempotent: true,
    },
  ],
  observe() {
    const state = useSettingsShellStore.getState();
    return {
      revision: stableRevision(state.activeTab, state.dataGovernanceTabTarget),
      route: `settings/${state.activeTab}`,
      mode: state.activeTab,
      availableActions: ['openSection'],
      state: {
        activeSection: state.activeTab,
        dataGovernanceTab: state.dataGovernanceTabTarget?.tab ?? null,
      },
    };
  },
  async execute(_ctx, action) {
    const args = actionArgs(action);
    const section = typeof args.section === 'string' ? args.section : '';
    if (action.name !== 'openSection' || !SETTINGS_SECTIONS.includes(section as never)) {
      return { handled: false, changed: false, code: 'INVALID_ARGUMENT', hint: 'Choose a declared settings section.' };
    }
    const previous = useSettingsShellStore.getState().activeTab;
    useSettingsShellStore.getState().setActiveTab(section);
    const acknowledged = useSettingsShellStore.getState().activeTab === section;
    if (!acknowledged) {
      return { handled: false, changed: false, code: 'ACTION_UNAVAILABLE', hint: 'The settings store did not acknowledge the section change.' };
    }
    return {
      handled: true,
      acknowledged: true,
      changed: previous !== section,
      postconditions: [{ kind: 'state_equals', path: 'activeSection', value: section }],
      ...(previous !== section
        ? {
            undo: {
              inverse: {
                name: 'openSection',
                args: { section: previous },
                expect: [{ kind: 'state_equals' as const, path: 'activeSection', value: previous }],
              },
              label: 'Restore settings section',
            },
          }
        : {}),
    };
  },
};

function templateRef(id: string): string {
  return stableAgentRef('templates', 'template', id);
}

export const templatesAgentManifest: AppAgentManifest = {
  version: 2,
  description: 'Observe, search, and open templates. Template content mutations remain in the template domain UI/tools.',
  capabilities: [
    {
      name: 'openTemplate',
      description: 'Open an existing template in the editor.',
      inputSchema: objectSchema({ templateId: { type: 'string', minLength: 1 } }, ['templateId']),
      risk: 'read',
      mutates: true,
      reversible: true,
      idempotent: true,
      targetKinds: ['template'],
    },
    {
      name: 'search',
      description: 'Filter templates by name or description; an empty query clears the filter.',
      inputSchema: objectSchema({ query: { type: 'string', maxLength: 500 } }, ['query']),
      risk: 'read',
      mutates: true,
      reversible: true,
      idempotent: true,
    },
  ],
  observe(ctx) {
    const surface = getTemplateAgentSurface(ctx.windowId);
    if (!surface) {
      return {
        revision: stableRevision('templates', 'unmounted'),
        route: 'templates/unmounted',
        busy: true,
        availableActions: [],
        state: { ready: false },
      };
    }
    const snapshot = surface.snapshot();
    const entities = snapshot.templates.map((template) => ({
      ref: templateRef(template.id),
      kind: 'template',
      label: shortLabel(template.name) ?? template.id,
      description: shortLabel(template.description),
      actions: ['openTemplate'],
      state: { updatedAt: template.updatedAt ?? null },
    }));
    return {
      revision: stableRevision(snapshot),
      route: `templates/${snapshot.activeTab}/${snapshot.selectedTemplateId ?? 'none'}`,
      mode: snapshot.activeTab,
      busy: snapshot.loading,
      selection: snapshot.selectedTemplateId ? [templateRef(snapshot.selectedTemplateId)] : [],
      availableActions: ['openTemplate', 'search'],
      entities,
      affordances: entities.map((entity) => ({ ...entity, selected: snapshot.selectedTemplateId === decodeURIComponent(entity.ref.split(':').at(-1) ?? '') })),
      state: {
        ready: true,
        activeTab: snapshot.activeTab,
        selectedTemplateId: snapshot.selectedTemplateId,
        searchQuery: snapshot.searchQuery,
        templateCount: snapshot.totalTemplates,
        templatesTruncated: snapshot.totalTemplates > snapshot.templates.length,
        error: snapshot.error,
      },
    };
  },
  async execute(ctx, action) {
    const surface = getTemplateAgentSurface(ctx.windowId);
    if (!surface) return { handled: false, changed: false, code: 'APP_NOT_READY', hint: 'The template surface is not mounted.' };
    const before = surface.snapshot();
    const args = actionArgs(action);
    if (action.name === 'openTemplate' && typeof args.templateId === 'string') {
      const mismatch = rejectMismatchedTarget(action, templateRef(args.templateId));
      if (mismatch) return mismatch;
      if (!surface.openTemplate(args.templateId)) {
        return { handled: false, changed: false, code: 'ENTITY_NOT_FOUND', hint: 'The requested template is not present in the current surface.' };
      }
      return {
        handled: true,
        acknowledged: true,
        changed: before.selectedTemplateId !== args.templateId || before.activeTab !== 'edit',
        entityRefs: [templateRef(args.templateId)],
        postconditions: [{ kind: 'selection_includes', ref: templateRef(args.templateId) }],
        ...(before.selectedTemplateId
          ? {
              undo: {
                inverse: {
                  name: 'openTemplate',
                  args: { templateId: before.selectedTemplateId },
                  targetRef: templateRef(before.selectedTemplateId),
                  expect: [{ kind: 'selection_includes' as const, ref: templateRef(before.selectedTemplateId) }],
                },
                label: 'Restore open template',
              },
            }
          : {}),
      };
    }
    if (action.name === 'search' && typeof args.query === 'string') {
      surface.search(args.query);
      return {
        handled: true,
        acknowledged: true,
        changed: before.searchQuery !== args.query,
        postconditions: [{ kind: 'state_equals', path: 'searchQuery', value: args.query }],
        undo: {
          inverse: {
            name: 'search',
            args: { query: before.searchQuery },
            expect: [{ kind: 'state_equals', path: 'searchQuery', value: before.searchQuery }],
          },
          label: 'Restore template search',
        },
      };
    }
    return { handled: false, changed: false, code: 'INVALID_ARGUMENT', hint: 'Use openTemplate or search with valid arguments.' };
  },
};

function taskSessionRef(id: string): string {
  return stableAgentRef('taskDashboard', 'session', id);
}

const TASK_FILTERS = ['all', 'active', 'attention', 'completed'] as const;

export const taskDashboardAgentManifest: AppAgentManifest = {
  version: 2,
  description: 'Observe and navigate document-to-card task sessions. It never changes task execution state.',
  capabilities: [
    {
      name: 'focusSession',
      description: 'Expand and focus an existing task session.',
      inputSchema: objectSchema({ sessionId: { type: 'string', minLength: 1 } }, ['sessionId']),
      risk: 'read',
      mutates: true,
      reversible: true,
      idempotent: true,
      targetKinds: ['task-session'],
    },
    {
      name: 'filter',
      description: 'Filter task sessions by operational state.',
      inputSchema: objectSchema({ filter: { type: 'string', enum: [...TASK_FILTERS] } }, ['filter']),
      risk: 'read',
      mutates: true,
      reversible: true,
      idempotent: true,
    },
  ],
  observe(ctx) {
    const surface = getTaskDashboardAgentSurface(ctx.windowId);
    if (!surface) {
      return {
        revision: stableRevision('taskDashboard', 'unmounted'),
        route: 'taskDashboard/unmounted',
        busy: true,
        availableActions: [],
        state: { ready: false },
      };
    }
    const snapshot = surface.snapshot();
    const entities = snapshot.sessions.map((session) => ({
      ref: taskSessionRef(session.id),
      kind: 'task-session',
      label: shortLabel(session.name) ?? session.id,
      description: session.status,
      actions: ['focusSession'],
      state: {
        status: session.status,
        sourceSessionId: session.sourceSessionId,
        updatedAt: session.updatedAt,
      },
    }));
    return {
      revision: stableRevision(snapshot),
      route: `taskDashboard/${snapshot.filter}/${snapshot.focusedSessionId ?? 'none'}`,
      mode: snapshot.filter,
      busy: snapshot.loading,
      selection: snapshot.focusedSessionId ? [taskSessionRef(snapshot.focusedSessionId)] : [],
      availableActions: ['focusSession', 'filter'],
      entities,
      affordances: entities.map((entity) => ({ ...entity, selected: snapshot.focusedSessionId === decodeURIComponent(entity.ref.split(':').at(-1) ?? '') })),
      state: {
        ready: true,
        filter: snapshot.filter,
        focusedSessionId: snapshot.focusedSessionId,
        sessionCount: snapshot.totalSessions,
        sessionsTruncated: snapshot.totalSessions > snapshot.sessions.length,
      },
    };
  },
  async execute(ctx, action) {
    const surface = getTaskDashboardAgentSurface(ctx.windowId);
    if (!surface) return { handled: false, changed: false, code: 'APP_NOT_READY', hint: 'The task dashboard surface is not mounted.' };
    const before = surface.snapshot();
    const args = actionArgs(action);
    if (action.name === 'focusSession' && typeof args.sessionId === 'string') {
      const mismatch = rejectMismatchedTarget(action, taskSessionRef(args.sessionId));
      if (mismatch) return mismatch;
      if (!surface.focusSession(args.sessionId)) {
        return { handled: false, changed: false, code: 'ENTITY_NOT_FOUND', hint: 'The requested task session is not present.' };
      }
      return {
        handled: true,
        acknowledged: true,
        changed: before.focusedSessionId !== args.sessionId,
        entityRefs: [taskSessionRef(args.sessionId)],
        postconditions: [{ kind: 'selection_includes', ref: taskSessionRef(args.sessionId) }],
        ...(before.focusedSessionId
          ? {
              undo: {
                inverse: {
                  name: 'focusSession',
                  args: { sessionId: before.focusedSessionId },
                  targetRef: taskSessionRef(before.focusedSessionId),
                  expect: [{ kind: 'selection_includes' as const, ref: taskSessionRef(before.focusedSessionId) }],
                },
                label: 'Restore focused task session',
              },
            }
          : {}),
      };
    }
    if (action.name === 'filter' && typeof args.filter === 'string' && TASK_FILTERS.includes(args.filter as never)) {
      const nextFilter = args.filter as (typeof TASK_FILTERS)[number];
      surface.filter(nextFilter);
      return {
        handled: true,
        acknowledged: true,
        changed: before.filter !== nextFilter,
        postconditions: [{ kind: 'state_equals', path: 'filter', value: nextFilter }],
        undo: {
          inverse: {
            name: 'filter',
            args: { filter: before.filter },
            expect: [{ kind: 'state_equals', path: 'filter', value: before.filter }],
          },
          label: 'Restore task filter',
        },
      };
    }
    return { handled: false, changed: false, code: 'INVALID_ARGUMENT', hint: 'Use focusSession or filter with valid arguments.' };
  },
};
