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
  buildCardGenerationUserPrompt: vi.fn(() => 'user'),
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
    const startArgs = startCall?.[1] as { options?: Record<string, unknown> } | undefined;
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

  it('returns timeout with task:error event', async () => {
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
          error: expect.stringContaining('生成超时'),
          isTimeout: true,
          partialCards: 0,
        }),
      })
    );
    expect(result.ok).toBe(true);
    expect(result.cards).toHaveLength(0);
    expect(result.paused).toBe(false);
  });
});
