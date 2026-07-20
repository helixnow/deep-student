import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

import {
  __resetMindMapStoreRegistry,
  createMindMapStore,
  registerMindMapStore,
} from '@/features/mindmap/store/mindmapStore';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { useFlashcardsLibraryStore } from '@/features/flashcards/store/libraryStore';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import { useFinderStore } from '@/features/learning-hub/stores/finderStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type {
  AgentAffordanceNode,
  AgentObservationPatch,
  AppAgentManifest,
} from '../../core/types';
import { filesAgentManifest } from '../files/agentManifest';
import { createMindmapAgentManifest } from '../mindmap/agentManifest';
import { handleMindmapActivation } from '../mindmap/register';
import { createNotesAgentManifest } from '../notes/agentManifest';
import { handleNotesActivation } from '../notes/notesActivation';
import {
  registerWorkspaceHost,
  resetWorkspaceRegistryForTests,
} from '../notes/workspaceRegistry';
import {
  createFlashcardsAgentManifest,
  createPomodoroAgentManifest,
  todoAgentManifest,
} from '../system/agentManifests';
import {
  handleFlashcardsActivation,
  handlePomodoroActivation,
} from '../system/register';
import { createExamAgentManifest, createResourceContentManifest } from '../content/agentManifests';
import { handleExamActivation } from '../content/register';
import { createChatAgentManifest } from '../chat/agentManifest';
import { handleChatActivation } from '../chat/register';
import { createBrowserAgentManifest } from '../browser/agentManifest';
import { createSandboxAgentManifest } from '../sandbox/agentManifest';

const cleanups: Array<() => void> = [];

function flatten(nodes: AgentAffordanceNode[] | undefined): AgentAffordanceNode[] {
  const result: AgentAffordanceNode[] = [];
  const stack = [...(nodes ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    stack.push(...(node.children ?? []));
  }
  return result;
}

function expectTargetKindsReachable(
  manifest: AppAgentManifest,
  observation: AgentObservationPatch,
): void {
  const descriptors = [
    ...(observation.entities ?? []),
    ...flatten(observation.affordances),
  ];
  for (const capability of manifest.capabilities) {
    if (!capability.targetKinds?.length || capability.targetOptional) continue;
    expect(
      descriptors.some((descriptor) =>
        capability.targetKinds!.includes(descriptor.kind)
        && descriptor.actions.includes(capability.name)),
      `${capability.name} must be exposed by one ${capability.targetKinds.join('|')} descriptor`,
    ).toBe(true);
  }
}

beforeEach(() => {
  resetWorkspaceRegistryForTests();
  __resetMindMapStoreRegistry();
  useTodoStore.setState({
    lists: [{
      id: 'list-1', title: '学习', sortOrder: 0, isDefault: true, isFavorite: false,
      createdAt: '2026-01-01', updatedAt: '2026-01-02',
    }],
    activeListId: 'list-1',
    items: [{
      id: 'todo-1', todoListId: 'list-1', title: '复习 ACR', status: 'pending',
      priority: 'high', tagsJson: '[]', sortOrder: 0, attachmentsJson: '[]',
      createdAt: '2026-01-01', updatedAt: '2026-01-02',
    }],
    selectedItemId: 'todo-1',
    isLoadingLists: false,
    isLoadingItems: false,
  });
  useFinderStore.setState({
    items: [{
      id: 'folder-1', sourceId: 'folder-1', path: '/folder-1', name: '资料', type: 'folder',
      createdAt: 1, updatedAt: 2,
    }, {
      id: 'note-1', sourceId: 'note-1', path: '/note-1', name: '笔记', type: 'note',
      createdAt: 1, updatedAt: 3,
    }],
    selectedIds: new Set(['note-1']),
    isLoading: false,
    isSearching: false,
  });
  useFsrsReviewStore.setState({
    screen: 'session',
    queue: [{ id: 'state-1', ankiCardId: 'card-1', front: '正面', back: '背面' }],
    queueIndex: 0,
    flipped: false,
    dueCards: [],
    loading: false,
    ratingBusy: false,
  });
  useFlashcardsLibraryStore.getState().reset();
  useQuestionBankStore.setState({
    currentExamId: 'exam-1',
    currentQuestionId: 'question-1',
    questionOrder: ['question-1'],
    questions: new Map([['question-1', {
      id: 'question-1', exam_id: 'exam-1', content: '1 + 1 = ?', question_type: 'single_choice',
      tags: [], status: 'new', attempt_count: 0, correct_count: 0, is_favorite: false,
      images: [], source_type: 'imported', created_at: '2026-01-01', updated_at: '2026-01-02',
    } as never]]),
    isLoading: false,
    isSubmitting: false,
    practiceMode: 'sequential',
    timedSession: null,
    mockExamSession: null,
    dailyPractice: null,
    mockExamScoreCard: null,
  });
});

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  resetWorkspaceRegistryForTests();
  __resetMindMapStoreRegistry();
  await sessionManager.destroyAll();
});

describe('ACR 2.0 app manifests', () => {
  it('only exposes Files actions that can produce a real state transition', async () => {
    useFinderStore.setState({
      currentPath: {
        viewKind: 'folder',
        folderId: null,
        breadcrumbs: [],
        typeFilter: null,
      },
      history: [],
      historyIndex: 0,
      items: [],
      selectedIds: new Set(),
    });

    const observation = await filesAgentManifest.observe!({
      windowId: 'files-window',
      typeId: 'files',
      instanceKey: null,
    });
    expect(observation.availableActions).not.toEqual(expect.arrayContaining([
      'goBack',
      'goForward',
      'goUp',
      'selectAll',
      'clearSelection',
    ]));

    const result = await filesAgentManifest.execute!({
      windowId: 'files-window',
      typeId: 'files',
      instanceKey: null,
    }, { name: 'goBack' });
    expect(result).toMatchObject({
      handled: false,
      code: 'ACTION_UNAVAILABLE',
    });
  });

  it('marks every control action as mutating and never exposes answer/submit/rate', () => {
    const noop = vi.fn(async () => ({ handled: true as const }));
    const manifests = [
      filesAgentManifest,
      todoAgentManifest,
      createMindmapAgentManifest(noop),
      createNotesAgentManifest(noop),
      createFlashcardsAgentManifest(noop),
      createPomodoroAgentManifest(noop),
      createExamAgentManifest(noop),
      createResourceContentManifest('file-preview', noop),
      createChatAgentManifest(noop),
      createBrowserAgentManifest(noop),
      createSandboxAgentManifest(noop),
    ];
    for (const manifest of manifests) {
      expect(manifest.capabilities.every((capability) => capability.mutates)).toBe(true);
    }
    expect(createExamAgentManifest(noop).capabilities.map((item) => item.name)).not.toEqual(
      expect.arrayContaining(['answer', 'submit', 'submitAnswer', 'submitExam']),
    );
    expect(createFlashcardsAgentManifest(noop).capabilities.map((item) => item.name)).not.toContain('rate');
  });

  it('observes hydrated exam sessions without exposing answers or enabling Agent answering', async () => {
    useQuestionBankStore.setState({
      practiceMode: 'mock_exam',
      timedSession: {
        id: 'timed-1', exam_id: 'exam-1', duration_minutes: 30, question_count: 1,
        question_ids: ['question-1'], started_at: '2026-07-14T08:00:00Z',
        answered_count: 0, correct_count: 0, is_timeout: false, is_submitted: false,
        paused_seconds: 0, is_paused: false,
      },
      mockExamSession: {
        id: 'mock-1', exam_id: 'exam-1',
        config: {
          duration_minutes: 60, type_distribution: {}, difficulty_distribution: {},
          total_count: 1, shuffle: true, include_mistakes: true,
        },
        question_ids: ['question-1'], started_at: '2026-07-14T08:00:00Z',
        answers: {}, results: {}, is_submitted: false,
      },
    });
    const manifest = createExamAgentManifest(handleExamActivation);
    const observation = await manifest.observe!({
      windowId: 'exam-window', typeId: 'exam', instanceKey: 'exam-1',
    });

    expect(manifest.capabilities.map((capability) => capability.name)).toContain(
      'hydratePracticeSession',
    );
    expect(observation.state).toMatchObject({
      agentCanAnswer: false,
      agentCanSubmit: false,
      activePracticeSession: {
        mode: 'mock_exam',
        sessionId: 'mock-1',
        questionIds: ['question-1'],
        answeredCount: 0,
      },
      practiceSessions: {
        timed: { sessionId: 'timed-1' },
        mockExam: { sessionId: 'mock-1' },
      },
    });
    expect(JSON.stringify(observation.state)).not.toContain('answers');
  });

  it('observes the real library page and exposes confirmed card mutations without rating', async () => {
    useFsrsReviewStore.setState({ screen: 'library', dueCards: [] });
    useFlashcardsLibraryStore.setState({
      items: [{
        id: 'library-1',
        task_id: 'task-library-1',
        front: 'Library front',
        back: 'Library back',
        text: 'Library text',
        tags: ['agent-visible'],
        images: [],
        created_at: '2026-07-14T00:00:00Z',
        updated_at: 'version-1',
        version: 'version-1',
        stateId: 'state-library-1',
        reviewVersion: 7,
        enqueued: true,
        suspended: false,
        isDue: true,
        latestReview: {
          logId: 'log-library-1',
          rating: 3,
          reviewedAt: '2026-07-14T01:00:00Z',
          undoable: true,
        },
      }],
      total: 41,
      page: 2,
      pageSize: 20,
      query: 'Library',
      searchInput: 'Library',
      loading: false,
      loaded: true,
    });

    const manifest = createFlashcardsAgentManifest(handleFlashcardsActivation);
    const observation = await manifest.observe!({
      windowId: 'flash-library', typeId: 'flashcards', instanceKey: null,
    });
    expect(observation.state).toMatchObject({
      ratingAvailableToAgent: false,
      library: {
        total: 41,
        page: 2,
        pageSize: 20,
        query: 'Library',
        loading: false,
        items: [expect.objectContaining({
          id: 'library-1',
          version: 'version-1',
          reviewVersion: 7,
          front: 'Library front',
          latestReview: expect.objectContaining({ logId: 'log-library-1', undoable: true }),
        })],
      },
    });
    expect(observation.entities).toEqual([
      expect.objectContaining({
        ref: 'flashcards:card:library-1',
        actions: expect.arrayContaining([
          'editCard', 'setSuspended', 'undoLastReview', 'deleteCard',
        ]),
      }),
    ]);
    expect(observation.availableActions).toEqual(expect.arrayContaining([
      'searchLibrary', 'setLibraryPage', 'editCard', 'setSuspended',
      'undoLastReview', 'deleteCard',
    ]));
    expect(observation.availableActions).not.toContain('rate');

    const risks = Object.fromEntries(manifest.capabilities.map((capability) => [
      capability.name,
      capability.risk,
    ]));
    expect(risks).toMatchObject({ undoLastReview: 'high', deleteCard: 'high' });

    const mismatch = await manifest.execute!(
      { windowId: 'flash-library', typeId: 'flashcards', instanceKey: null },
      {
        name: 'editCard',
        targetRef: 'flashcards:card:another-card',
        args: { cardId: 'library-1', front: 'Changed' },
      },
    );
    expect(mismatch).toMatchObject({ handled: false, code: 'TARGET_REF_MISMATCH' });
  });

  it('keeps targetKinds aligned with bounded semantic observations', async () => {
    const mindmapStore = createMindMapStore();
    mindmapStore.setState({
      mindmapId: 'map-1',
      document: {
        version: '1.0',
        root: { id: 'root-1', text: '根', children: [{ id: 'node-1', text: '节点', children: [] }] },
        meta: { createdAt: '2026-01-01' },
      },
      focusedNodeId: 'node-1',
    });
    cleanups.push(registerMindMapStore('map-1', mindmapStore, 'mindmap-window'));
    cleanups.push(registerMindMapStore('map-1', mindmapStore, 'notes-window:mindmap:map-1'));
    cleanups.push(registerWorkspaceHost('notes-window', {
      openResource: () => undefined,
      getActiveResource: () => ({ type: 'mindmap', id: 'map-1' }),
      listResources: () => [{ type: 'mindmap', id: 'map-1' }],
      listResourceDetails: () => [{ type: 'mindmap', id: 'map-1', title: '课程图', saveState: 'saved' }],
    }));

    const chatStore = sessionManager.getOrCreate('session-1');
    chatStore.setState({
      title: '学习对话',
      messageOrder: ['message-1'],
      messageMap: new Map([['message-1', {
        id: 'message-1', role: 'user', blockIds: [], timestamp: 1,
      }]]),
    });
    sessionManager.setCurrentSessionId('session-1');

    const cases: Array<[AppAgentManifest, AgentObservationPatch]> = [
      [filesAgentManifest, await filesAgentManifest.observe!({ windowId: 'files-window', typeId: 'files', instanceKey: null })],
      [todoAgentManifest, await todoAgentManifest.observe!({ windowId: 'todo-window', typeId: 'todo', instanceKey: null })],
      [createMindmapAgentManifest(handleMindmapActivation), await createMindmapAgentManifest(handleMindmapActivation).observe!({ windowId: 'mindmap-window', typeId: 'mindmap', instanceKey: 'map-1' })],
      [createNotesAgentManifest(handleNotesActivation), await createNotesAgentManifest(handleNotesActivation).observe!({ windowId: 'notes-window', typeId: 'notes', instanceKey: null })],
      [createFlashcardsAgentManifest(handleFlashcardsActivation), await createFlashcardsAgentManifest(handleFlashcardsActivation).observe!({ windowId: 'flash-window', typeId: 'flashcards', instanceKey: null })],
      [createExamAgentManifest(handleExamActivation), await createExamAgentManifest(handleExamActivation).observe!({ windowId: 'exam-window', typeId: 'exam', instanceKey: 'exam-1' })],
      [createChatAgentManifest(handleChatActivation), await createChatAgentManifest(handleChatActivation).observe!({ windowId: 'chat-window', typeId: 'chat', instanceKey: 'session-1' })],
    ];
    for (const [manifest, observation] of cases) {
      expectTargetKindsReachable(manifest, observation);
      expect((observation.entities ?? []).length).toBeLessThanOrEqual(200);
      expect(flatten(observation.affordances).length).toBeLessThanOrEqual(200);
    }
  });

  it('bounds large mindmaps and rejects a targetRef that disagrees with nodeId', async () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'large-map',
      document: {
        version: '1.0',
        root: {
          id: 'root-large', text: '根',
          children: Array.from({ length: 120 }, (_, index) => ({ id: `node-${index}`, text: `节点 ${index}`, children: [] })),
        },
        meta: { createdAt: '2026-01-01' },
      },
    });
    cleanups.push(registerMindMapStore('large-map', store, 'large-window'));
    const activation = vi.fn(handleMindmapActivation);
    const manifest = createMindmapAgentManifest(activation);
    const observation = await manifest.observe!({ windowId: 'large-window', typeId: 'mindmap', instanceKey: 'large-map' });
    expect(observation.entities).toHaveLength(80);
    expect(observation.state?.entitiesTruncated).toBe(true);

    const mismatch = await manifest.execute!(
      { windowId: 'large-window', typeId: 'mindmap', instanceKey: 'large-map' },
      { name: 'focusNode', targetRef: 'mindmap:node:node-2', args: { nodeId: 'node-1' } },
    );
    expect(mismatch).toMatchObject({ handled: false, code: 'TARGET_REF_MISMATCH' });
    expect(activation).not.toHaveBeenCalled();
  });

  it('writes inverse expectations for the state produced by undo', async () => {
    const store = createMindMapStore();
    store.setState({ mindmapId: 'undo-map', currentView: 'mindmap' });
    cleanups.push(registerMindMapStore('undo-map', store, 'undo-window'));
    const mindmap = createMindmapAgentManifest(handleMindmapActivation);
    const switched = await mindmap.execute!(
      { windowId: 'undo-window', typeId: 'mindmap', instanceKey: 'undo-map' },
      { name: 'setView', args: { view: 'outline' } },
    );
    expect(switched).toMatchObject({
      handled: true,
      changed: true,
      undo: {
        inverse: {
          name: 'setView',
          args: { view: 'mindmap' },
          expect: [{ kind: 'state_equals', path: 'currentView', value: 'mindmap' }],
        },
      },
    });
    const searched = await mindmap.execute!(
      { windowId: 'undo-window', typeId: 'mindmap', instanceKey: 'undo-map' },
      { name: 'search', args: { query: '重点' } },
    );
    expect(searched.undo).toMatchObject({
      inverse: {
        name: 'clearSearch',
        expect: [{ kind: 'state_equals', path: 'searchQuery', value: '' }],
      },
    });

    const notesStore = createMindMapStore();
    notesStore.setState({ mindmapId: 'notes-map', currentView: 'mindmap' });
    cleanups.push(registerMindMapStore('notes-map', notesStore, 'notes-undo:mindmap:notes-map'));
    cleanups.push(registerWorkspaceHost('notes-undo', {
      openResource: () => undefined,
      getActiveResource: () => ({ type: 'mindmap', id: 'notes-map' }),
      listResources: () => [{ type: 'mindmap', id: 'notes-map' }],
    }));
    const notes = createNotesAgentManifest(handleNotesActivation);
    const notesSwitched = await notes.execute!(
      { windowId: 'notes-undo', typeId: 'notes', instanceKey: null },
      { name: 'setView', args: { resourceType: 'mindmap', resourceId: 'notes-map', view: 'outline' } },
    );
    expect(notesSwitched.undo).toMatchObject({
      inverse: {
        name: 'setView',
        args: { resourceType: 'mindmap', resourceId: 'notes-map', view: 'mindmap' },
        expect: [{ kind: 'state_equals', path: 'view', value: 'mindmap' }],
      },
    });

    useFsrsReviewStore.setState({ screen: 'library' });
    const flashcards = createFlashcardsAgentManifest(handleFlashcardsActivation);
    const changedScreen = await flashcards.execute!(
      { windowId: 'flash-window', typeId: 'flashcards', instanceKey: null },
      { name: 'showScreen', args: { screen: 'today' } },
    );
    expect(changedScreen.undo).toMatchObject({
      inverse: {
        name: 'showScreen',
        args: { screen: 'library' },
        expect: [{ kind: 'state_equals', path: 'screen', value: 'library' }],
      },
    });

    usePomodoroStore.setState({
      mode: 'work', status: 'running',
      settings: { ...DEFAULT_POMODORO_SETTINGS, strictMode: false },
    });
    const pomodoro = createPomodoroAgentManifest(handlePomodoroActivation);
    const paused = await pomodoro.execute!(
      { windowId: 'timer-window', typeId: 'pomodoro', instanceKey: null },
      { name: 'pause' },
    );
    expect(paused.undo).toMatchObject({
      inverse: {
        name: 'resume',
        expect: [{ kind: 'state_equals', path: 'status', value: 'running' }],
      },
    });
  });

  it('fails closed for mutating no-ops and surfaces without an ACK', async () => {
    const store = createMindMapStore();
    store.setState({ mindmapId: 'noop-map', currentView: 'mindmap' });
    cleanups.push(registerMindMapStore('noop-map', store, 'noop-window'));
    const mindmap = createMindmapAgentManifest(handleMindmapActivation);
    const sameView = await mindmap.execute!(
      { windowId: 'noop-window', typeId: 'mindmap', instanceKey: 'noop-map' },
      { name: 'setView', args: { view: 'mindmap' } },
    );
    expect(sameView).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });

    const notesActivation = vi.fn(async () => ({ handled: true as const }));
    const notes = createNotesAgentManifest(notesActivation);
    // scrollToHeading 现经 workspaceRegistry 定向本窗编辑器；无活动笔记时
    // 返回 ANCHOR_NOT_FOUND（此前是无差别 ACTION_UNAVAILABLE 硬拦截）
    const heading = await notes.execute!(
      { windowId: 'notes-no-ack', typeId: 'notes', instanceKey: null },
      { name: 'scrollToHeading', args: { heading: 'Intro' } },
    );
    expect(heading).toMatchObject({ handled: false, code: 'ANCHOR_NOT_FOUND' });
    expect(notesActivation).not.toHaveBeenCalled();

    const preview = createResourceContentManifest(
      'file-preview',
      vi.fn(async () => ({ handled: true as const })),
    );
    const page = await preview.execute!(
      { windowId: 'preview-no-ack', typeId: 'file-preview', instanceKey: 'file-1' },
      { name: 'gotoPage', args: { page: 2 } },
    );
    expect(page).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });

    useFsrsReviewStore.setState({ screen: 'today' });
    const flashcards = createFlashcardsAgentManifest(handleFlashcardsActivation);
    const sameScreen = await flashcards.execute!(
      { windowId: 'flash-noop', typeId: 'flashcards', instanceKey: null },
      { name: 'showScreen', args: { screen: 'today' } },
    );
    expect(sameScreen).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });
  });

  it('derives search navigation postconditions from before state', async () => {
    const store = createMindMapStore();
    store.setState({
      mindmapId: 'search-map',
      searchQuery: 'node',
      searchResults: ['node-1', 'node-2', 'node-3'],
      currentSearchIndex: 0,
    });
    cleanups.push(registerMindMapStore('search-map', store, 'search-window'));
    const mindmap = createMindmapAgentManifest(handleMindmapActivation);
    const next = await mindmap.execute!(
      { windowId: 'search-window', typeId: 'mindmap', instanceKey: 'search-map' },
      { name: 'nextSearchResult' },
    );
    expect(next).toMatchObject({
      handled: true,
      acknowledged: true,
      postconditions: [{ kind: 'state_equals', path: 'currentSearchIndex', value: 1 }],
    });
  });
});
