import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

const mockTemplate = {
  id: 'basic',
  name: 'Basic',
  description: 'Basic template',
  fields: ['Front', 'Back'],
  is_active: true,
  note_type: 'Basic',
  field_extraction_rules: {},
};

vi.mock('@/data/ankiTemplates', () => ({
  templateManager: {
    loadTemplates: vi.fn().mockResolvedValue(undefined),
    getActiveTemplates: vi.fn(() => [mockTemplate]),
    getAllTemplates: vi.fn(() => [mockTemplate]),
  },
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    batchExportCards: vi.fn(),
  },
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveTextFile: vi.fn(),
  },
}));

vi.mock('@/components/anki/cardforge/prompts', () => ({
  buildCardGenerationSystemPrompt: vi.fn(() => 'system'),
  buildContentAnalysisPrompt: vi.fn(() => 'analysis'),
}));

vi.mock('@/components/anki/cardforge/engines/SegmentEngine', () => ({
  SegmentEngine: class {
    async segment() {
      return ['segment'];
    }
  },
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type GenerationCallback = (event: { payload: any }) => void;

const createBackendCard = (overrides: Record<string, unknown> = {}) => ({
  id: 'card-1',
  task_id: 'task-1',
  front: 'Front',
  back: 'Back',
  text: 'Text',
  tags: [],
  images: [],
  is_error_card: false,
  created_at: '2026-02-08T00:00:00.000Z',
  updated_at: '2026-02-08T00:00:00.000Z',
  ...overrides,
});

describe('CardAgent', () => {
  let CardAgent: typeof import('@/components/anki/cardforge/engines/CardAgent').CardAgent;
  let generationCallback: GenerationCallback | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    generationCallback = null;

    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      if (eventName === 'anki_generation_event') {
        generationCallback = handler as GenerationCallback;
      }
      return vi.fn();
    });

    ({ CardAgent } = await import('@/components/anki/cardforge/engines/CardAgent'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns init error when listeners fail', async () => {
    vi.mocked(listen).mockRejectedValue(new Error('listen failed'));
    const agent = new CardAgent();

    const result = await agent.generateCards({ content: 'Hello' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('CardAgent 初始化失败');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('only listens to anki_generation_event — the anki_tool_call bridge is gone', async () => {
    // 死链路清理证明：pipeline 不再注册后端 AnkiToolExecutor，
    // CardAgent 不得再监听任何工具桥事件（anki_tool_call），
    // 否则会在生产环境挂上一个永远不会触发、却可能被伪造事件命中的监听器。
    const agent = new CardAgent();
    await agent.waitForReady();

    // 注意：模块级单例 cardAgent 与本测试的实例各注册一次生成事件监听，
    // 这里按事件名去重后断言：除 anki_generation_event 外不得监听任何事件
    const listenedEvents = vi.mocked(listen).mock.calls.map(([eventName]) => eventName);
    expect([...new Set(listenedEvents)]).toEqual(['anki_generation_event']);
    expect(listenedEvents).not.toContain('anki_tool_call');
  });

  it('rejects empty content', async () => {
    const agent = new CardAgent();
    await agent.waitForReady();

    const result = await agent.generateCards({ content: '   ' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('内容不能为空');
    expect(invoke).not.toHaveBeenCalledWith('start_enhanced_document_processing', expect.anything());
  });

  it('collects cards until document completes', async () => {
    const agent = new CardAgent();
    await agent.waitForReady();

    let startResolve: (() => void) | null = null;
    const startPromise = new Promise<void>((resolve) => {
      startResolve = resolve;
    });

    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'start_enhanced_document_processing') {
        startResolve?.();
        return 'doc-1';
      }
      if (command === 'get_document_tasks') {
        return [
          { id: 'task-1', document_id: 'doc-1', segment_index: 0, status: 'completed' },
          { id: 'task-2', document_id: 'doc-1', segment_index: 1, status: 'completed' },
        ];
      }
      return undefined;
    });

    const promise = agent.generateCards({ content: 'Hello', options: { deckName: 'Deck' } });

    await startPromise;
    await Promise.resolve();

    expect(generationCallback).toBeTruthy();

    generationCallback?.({
      payload: {
        NewCard: {
          card: createBackendCard({ id: 'card-ignore', task_id: 'task-ignore' }),
          document_id: 'doc-other',
        },
      },
    });
    generationCallback?.({
      payload: {
        NewCard: {
          card: createBackendCard({ id: 'card-1', task_id: 'task-1', template_id: 'basic' }),
          document_id: 'doc-1',
        },
      },
    });
    generationCallback?.({
      payload: {
        DocumentProcessingCompleted: {
          document_id: 'doc-1',
        },
      },
    });

    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(1);
    expect(result.cards?.[0].id).toBe('card-1');
    expect(result.cards?.[0].templateId).toBe('basic');
    expect(result.stats?.segments).toBe(2);
    expect(result.stats?.templatesUsed).toEqual(['basic']);
    expect(result.paused).toBe(false);

    const startCall = vi
      .mocked(invoke)
      .mock.calls.find(([command]) => command === 'start_enhanced_document_processing');
    expect(startCall).toBeTruthy();
    const startArgs = startCall?.[1] as {
      documentContent?: string;
      options?: Record<string, unknown>;
    } | undefined;

    // Prompt 装配契约：材料只经 documentContent 注入 user 消息，
    // system prompt 经 custom_anki_prompt 作为后端 system 消息基础层，
    // 不再使用 {{DOCUMENT_CONTENT}} 占位符，也不再误传 options.system_prompt
    expect(startArgs?.documentContent).toBe('Hello');
    expect(startArgs?.options?.custom_anki_prompt).toBe('system');
    expect(startArgs?.options).not.toHaveProperty('system_prompt');

    expect(startArgs?.options).toEqual(
      expect.objectContaining({
        template_ids: ['basic'],
        template_descriptions: expect.arrayContaining([
          expect.objectContaining({
            id: 'basic',
            fields: ['Front', 'Back'],
          }),
        ]),
        template_fields: ['Front', 'Back'],
        template_fields_by_id: expect.objectContaining({
          basic: ['Front', 'Back'],
        }),
        field_extraction_rules: expect.objectContaining({
          Front: expect.any(Object),
          Back: expect.any(Object),
        }),
        field_extraction_rules_by_id: expect.objectContaining({
          basic: expect.objectContaining({
            Front: expect.any(Object),
            Back: expect.any(Object),
          }),
        }),
      })
    );
  });

  describe('startGeneration (划词制卡生产路径)', () => {
    it('starts the backend pipeline and returns documentId without waiting for events', async () => {
      const agent = new CardAgent();
      await agent.waitForReady();

      vi.mocked(invoke).mockResolvedValue('doc-selection');

      const result = await agent.startGeneration({
        content: '划词选中的学习材料',
        maxCards: 10,
        options: { deckName: 'Selection', customRequirements: '优先关键概念' },
      });

      // 非阻塞：不等待 DocumentProcessingCompleted，直接返回
      expect(result).toEqual({ ok: true, documentId: 'doc-selection' });

      const startCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === 'start_enhanced_document_processing');
      expect(startCalls).toHaveLength(1);

      const startArgs = startCalls[0]?.[1] as {
        documentContent?: string;
        originalDocumentName?: string;
        options?: Record<string, unknown>;
      };

      // 与 generateCards 共用同一套选项装配（Prompt/模板契约一致）
      expect(startArgs.documentContent).toBe('划词选中的学习材料');
      expect(startArgs.originalDocumentName).toBe('Selection');
      expect(startArgs.options?.custom_anki_prompt).toBe('system');
      // maxCards 是"总数上限"：写入 max_cards_total 由后端按分段分配额度，
      // max_cards_per_mistake 只作单段兜底（0824 评审 #4）
      expect(startArgs.options?.max_cards_per_mistake).toBe(10);
      expect(startArgs.options?.max_cards_total).toBe(10);
      // FSRS 画像注入默认不授权（0824 评审 #1）
      expect(startArgs.options?.fsrs_feedback).toBe(false);
      expect(startArgs.options?.custom_requirements).toBe('优先关键概念');
      expect(startArgs.options?.template_ids).toEqual(['basic']);
      expect(startArgs.options).not.toHaveProperty('system_prompt');
    });

    const startOptionsOf = async (
      agent: InstanceType<typeof CardAgent>,
      input: Parameters<InstanceType<typeof CardAgent>['startGeneration']>[0]
    ): Promise<Record<string, unknown>> => {
      vi.mocked(invoke).mockClear();
      vi.mocked(invoke).mockResolvedValue('doc-x');
      const result = await agent.startGeneration(input);
      expect(result.ok).toBe(true);
      const call = vi
        .mocked(invoke)
        .mock.calls.find(([command]) => command === 'start_enhanced_document_processing');
      return (call?.[1] as { options?: Record<string, unknown> })?.options ?? {};
    };

    it('validates maxCards explicitly: 0/negative/NaN fall back to the default total of 50', async () => {
      // 0824 评审 #4：`input.maxCards || 50` 的 falsy 巧合改为显式校验，
      // 非法值（0/负数/NaN）与缺省一样回退默认，且默认同样写入总额度
      const agent = new CardAgent();
      await agent.waitForReady();

      for (const invalid of [0, -5, Number.NaN]) {
        const options = await startOptionsOf(agent, { content: '材料', maxCards: invalid });
        expect(options.max_cards_total).toBe(50);
        expect(options.max_cards_per_mistake).toBe(50);
      }

      const omitted = await startOptionsOf(agent, { content: '材料' });
      expect(omitted.max_cards_total).toBe(50);
      expect(omitted.max_cards_per_mistake).toBe(50);
    });

    it('caps per-segment limit at backend maximum while keeping the full total', async () => {
      // 后端 EnhancedAnkiService 拒绝单段 >100；总额度仍完整传递，
      // 由 DocumentProcessingService 按分段分配
      const agent = new CardAgent();
      await agent.waitForReady();

      const options = await startOptionsOf(agent, { content: '材料', maxCards: 250 });
      expect(options.max_cards_total).toBe(250);
      expect(options.max_cards_per_mistake).toBe(100);
    });

    it('only forwards FSRS feedback authorization on explicit opt-in', async () => {
      // 0824 评审 #1：公开输入新增 fsrsFeedback 开关；不显式传 true
      // 一律以 false 发给后端（后端同样只认显式 true）
      const agent = new CardAgent();
      await agent.waitForReady();

      const optedIn = await startOptionsOf(agent, {
        content: '材料',
        options: { fsrsFeedback: true },
      });
      expect(optedIn.fsrs_feedback).toBe(true);

      const optedOut = await startOptionsOf(agent, {
        content: '材料',
        options: { fsrsFeedback: false },
      });
      expect(optedOut.fsrs_feedback).toBe(false);

      const unspecified = await startOptionsOf(agent, { content: '材料' });
      expect(unspecified.fsrs_feedback).toBe(false);
    });

    it('rejects empty content without touching the backend', async () => {
      const agent = new CardAgent();
      await agent.waitForReady();

      const result = await agent.startGeneration({ content: '   ' });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('内容不能为空');
      expect(invoke).not.toHaveBeenCalledWith(
        'start_enhanced_document_processing',
        expect.anything()
      );
    });

    it('does not depend on event listener initialization', async () => {
      // 与 generateCards 不同：startGeneration 不注册卡片收集器，
      // 即使事件监听初始化失败也应能直启后端管线
      vi.mocked(listen).mockRejectedValue(new Error('listen failed'));
      vi.mocked(invoke).mockResolvedValue('doc-no-listener');

      const agent = new CardAgent();
      const result = await agent.startGeneration({ content: '监听失败也能启动' });

      expect(result).toEqual({ ok: true, documentId: 'doc-no-listener' });
    });

    it('propagates backend start failures', async () => {
      const agent = new CardAgent();
      await agent.waitForReady();

      vi.mocked(invoke).mockRejectedValue(new Error('backend down'));

      const result = await agent.startGeneration({ content: '会失败的启动' });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('backend down');
    });
  });

  it('returns idle-timeout with task:error event after inactivity', async () => {
    vi.useFakeTimers();
    const agent = new CardAgent();
    await agent.waitForReady();

    let startResolve: (() => void) | null = null;
    const startPromise = new Promise<void>((resolve) => {
      startResolve = resolve;
    });

    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'start_enhanced_document_processing') {
        startResolve?.();
        return 'doc-timeout';
      }
      if (command === 'get_document_tasks') {
        return [];
      }
      return undefined;
    });

    const onError = vi.fn();
    agent.on('task:error', onError);

    const promise = agent.generateCards({ content: 'Hello timeout' });

    await startPromise;
    await Promise.resolve();
    vi.advanceTimersByTime(300000);
    await Promise.resolve();

    const result = await promise;

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-timeout',
        payload: expect.objectContaining({
          error: expect.stringContaining('空闲超时'),
          isTimeout: true,
          partialCards: 0,
        }),
      })
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('生成空闲超时');
    expect(result.cards).toHaveLength(0);
    expect(result.paused).toBe(false);
  });

  it('does not idle-timeout while cards keep arriving (F21 idle reset)', async () => {
    vi.useFakeTimers();
    const agent = new CardAgent();
    await agent.waitForReady();

    let startResolve: (() => void) | null = null;
    const startPromise = new Promise<void>((resolve) => {
      startResolve = resolve;
    });

    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'start_enhanced_document_processing') {
        startResolve?.();
        return 'doc-idle';
      }
      if (command === 'get_document_tasks') {
        return [{ id: 'task-1', document_id: 'doc-idle', segment_index: 0, status: 'completed' }];
      }
      return undefined;
    });

    const onError = vi.fn();
    agent.on('task:error', onError);

    const promise = agent.generateCards({ content: 'Hello idle' });

    await startPromise;
    await Promise.resolve();

    // 每个空闲窗口（300s）快到期前发来一张卡以重置计时器；总推进 750s 远超旧固定总超时
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(250000);
      generationCallback?.({
        payload: {
          NewCard: {
            card: createBackendCard({ id: `card-${i}`, task_id: 'task-1', template_id: 'basic' }),
            document_id: 'doc-idle',
          },
        },
      });
      await Promise.resolve();
    }

    // 因持续有生成活动，空闲计时器一直被重置，不应触发超时
    expect(onError).not.toHaveBeenCalled();

    generationCallback?.({
      payload: { DocumentProcessingCompleted: { document_id: 'doc-idle' } },
    });

    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(3);
    expect(result.paused).toBe(false);
  });
});
