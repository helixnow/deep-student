import { expect, it } from 'vitest';
import type {
  AnkiCard, ChatAnkiPreferenceMemory, ChatAnkiSessionObservation, ChatAnkiToolExecutor,
  CustomAnkiTemplate, ToolExecutionContext,
} from '../api.ts';
import { ChatAnkiMutationExecutor } from '../src/mutation-executor.ts';
import { ChatAnkiRetemplateExecutor } from '../src/retemplate-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';
import { PreferenceMemoryDouble } from './preference-memory-double.ts';

function makeCard(id: string, taskId: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: 'design-swiss',
  };
}

function context(
  repo: CardStoreDouble,
  blocks: ChatBlockStoreDouble,
  preferenceMemory: ChatAnkiPreferenceMemory | null,
  extra: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    sessionId: 'session-mutation',
    messageId: 'msg-mutation',
    blockId: 'block-mutation',
    cards: repo,
    documents: repo,
    chatBlocks: blocks,
    settings: repo,
    preferenceMemory,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
    ...extra,
  };
}

class RecordingPreferenceMemory implements ChatAnkiPreferenceMemory {
  readonly observations: ChatAnkiSessionObservation[] = [];
  private readonly delegate = new PreferenceMemoryDouble();

  emptyStore() { return this.delegate.emptyStore(); }

  consolidateObservation(
    store: ReturnType<PreferenceMemoryDouble['emptyStore']>,
    observation: ChatAnkiSessionObservation,
    nowMs: Parameters<ChatAnkiPreferenceMemory['consolidateObservation']>[2],
  ) {
    this.observations.push(structuredClone(observation));
    return this.delegate.consolidateObservation(store, observation, nowMs);
  }
}

async function execute(
  executor: ChatAnkiToolExecutor, name: string, args: unknown, ctx: ToolExecutionContext,
) {
  return executor.execute({ id: `call-${name}`, name, arguments: args }, ctx);
}

it('test_chatanki_update_card_atomic_version_success_and_conflict via executor persists preferences', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-update', 'session-mutation');
  const card = makeCard('card-update', taskId, 'English front', 'English back');
  expect(repo.insertCard(card)).toBe(true);
  const blocks = new ChatBlockStoreDouble();
  blocks.seedAnkiCardsBlock('block-update', 'session-mutation', 'doc-update');
  const memory = new RecordingPreferenceMemory();
  const ctx = context(repo, blocks, memory);
  const executor = new ChatAnkiMutationExecutor();

  const first = await execute(executor, 'chatanki_update_card', {
    cardId: 'card-update',
    patch: { front: '中文正面一', back: '中文背面一' },
    expectedVersion: card.updated_at,
  }, ctx);
  expect(first.success).toBe(true);
  expect((first.output as Record<string, unknown>).status).toBe('ok');
  expect(repo.getCardWithDocument('card-update')?.card.front).toBe('中文正面一');

  const version = repo.getCardWithDocument('card-update')?.card.updated_at ?? '';
  const second = await execute(executor, 'chatanki_update_card', {
    cardId: 'card-update',
    patch: { front: '中文正面二', back: '中文背面二' },
    expectedVersion: version,
  }, ctx);
  expect(second.success).toBe(true);

  const stale = await execute(executor, 'chatanki_update_card', {
    cardId: 'card-update',
    patch: { front: '不会写入' },
    expectedVersion: card.updated_at,
  }, ctx);
  expect(stale.success).toBe(true);
  expect((stale.output as Record<string, unknown>).error).toBe('version_conflict');

  const edits = memory.observations.flatMap((observation) => observation.edits);
  expect(edits.some((edit) => edit.field === 'front' && edit.after === '中文正面一')).toBe(true);
  expect(edits.some((edit) => edit.field === 'front' && edit.after === '中文正面二')).toBe(true);
});

it('test_chatanki_delete_card_normal_path via executor records deletion observation', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-delete', 'session-mutation');
  const card = makeCard('card-delete', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);
  const blocks = new ChatBlockStoreDouble();
  blocks.seedAnkiCardsBlock('block-delete', 'session-mutation', 'doc-delete');
  const memory = new RecordingPreferenceMemory();
  const executor = new ChatAnkiMutationExecutor();

  const result = await execute(executor, 'chatanki_delete_card', {
    cardId: 'card-delete', expectedVersion: card.updated_at, expectedReviewVersion: null,
  }, context(repo, blocks, memory));

  expect(result.success).toBe(true);
  expect((result.output as Record<string, unknown>).deleted).toBe(true);
  expect(repo.getCardWithDocument('card-delete')).toBeNull();
  expect(memory.observations.flatMap((observation) => observation.deletions)).toContainEqual({
    front: 'front', back: 'back',
  });
});

it('test_chatanki_retemplate_fill_missing_llm_cas_write_back_conflict_and_payload via executor', async () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-retemplate', 'session-mutation');
  const card = makeCard('card-retemplate', taskId, 'front text', 'back text');
  expect(repo.insertCard(card)).toBe(true);
  const blocks = new ChatBlockStoreDouble();
  blocks.seedAnkiCardsBlock('block-retemplate', 'session-mutation', 'doc-retemplate');
  const template: CustomAnkiTemplate = {
    id: 'target-template', name: 'Target', description: '', author: null, version: '1.0.0',
    preview_front: '', preview_back: '', note_type: 'Basic', fields: ['Front', 'Back', 'Example'],
    generation_prompt: '', front_template: '', back_template: '', css_style: '',
    field_extraction_rules: {
      Front: { field_type: 'Text', is_required: true, default_value: null, validation_pattern: null, description: 'front' },
      Back: { field_type: 'Text', is_required: true, default_value: null, validation_pattern: null, description: 'back' },
      Example: { field_type: 'Text', is_required: false, default_value: null, validation_pattern: null, description: 'example' },
    },
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z',
    is_active: true, is_built_in: false, preview_data_json: null,
  };
  const ctx = context(repo, blocks, null, {
    templateLookup: { getCustomTemplateById: (id) => id === template.id ? template : null },
    llmRawPrompt: {
      callAnkiModel2RawPrompt: async () => ({
        assistantMessage: '{"cards":[{"cardId":"card-retemplate","fields":{"Example":"generated example"}}]}',
      }),
    },
  });
  const executor = new ChatAnkiRetemplateExecutor();

  const result = await execute(executor, 'chatanki_retemplate', {
    documentId: 'doc-retemplate',
    targetTemplateId: template.id,
    strategy: 'fill_missing_llm',
    expectedVersions: { 'card-retemplate': card.updated_at },
  }, ctx);

  expect(result.success).toBe(true);
  const output = result.output as Record<string, unknown>;
  expect(output.status).toBe('ok');
  expect(output.missingCards).toBe(0);
  expect(output.fill).toEqual({
    attempted: 1, filled: 1, partial: 0, skipped: 0, conflicts: 0, failed: 0,
  });
  const stored = repo.getCardsForDocument('doc-retemplate')[0];
  expect(stored?.extra_fields.Example).toBe('generated example');
});
