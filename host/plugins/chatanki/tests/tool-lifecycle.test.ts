import { expect, it } from 'vitest';
import type { ChatAnkiChatBlock, DocumentTask, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import { ChatAnkiApkgExecutor } from '../src/apkg-executor.ts';
import { ChatAnkiExecutor } from '../src/chatanki-executor.ts';
import { ChatAnkiGetCardsExecutor } from '../src/get-cards-executor.ts';
import { ChatAnkiMutationExecutor } from '../src/mutation-executor.ts';
import { ChatAnkiRetemplateExecutor } from '../src/retemplate-executor.ts';
import { ChatAnkiStatusExecutor } from '../src/status-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';

function context(
  events: unknown[][], overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    sessionId: 'session-lifecycle', messageId: 'message-lifecycle', blockId: 'block-lifecycle',
    info: (message) => { events.push(['info', message]); },
    emitToolCallStart: (name, args, callId) => { events.push(['start', name, args, callId]); },
    emitToolCallEnd: (payload) => { events.push(['end', payload]); },
    emitToolCallError: (error) => { events.push(['error', error]); },
    saveToolBlock: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}

const lifecycle = (events: unknown[][]): unknown[][] => events.filter(([kind]) => kind !== 'info');

it('analysis logs info before a single start, then end', async () => {
  const events: unknown[][] = [];
  const result = await new ChatAnkiExecutor().execute(
    { id: 'call-analyze-start', name: 'chatanki_analyze', arguments: { content: '一段普通文本' } },
    context(events),
  );
  expect(result.success).toBe(true);
  expect(events[0]).toEqual([
    'info', '[ChatAnkiToolExecutor] execute: tool_name=chatanki_analyze,'
      + ' tool_call_id=call-analyze-start, session_id=session-lifecycle,'
      + ' message_id=message-lifecycle',
  ]);
  expect(events[1]).toEqual([
    'start', 'chatanki_analyze', { content: '一段普通文本' }, 'call-analyze-start',
  ]);
  expect(events.filter(([kind]) => kind === 'start')).toHaveLength(1);
  expect(events[2]?.[0]).toBe('end');
});

it('validation failures log info, emit one start, then the terminal error', async () => {
  const events: unknown[][] = [];
  const result = await new ChatAnkiGetCardsExecutor().execute(
    { id: 'call-get-start', name: 'chatanki_get_cards', arguments: {} },
    context(events),
  );
  expect(result.success).toBe(false);
  expect(events[0]?.[0]).toBe('info');
  expect(events[0]?.[1]).toContain('tool_name=chatanki_get_cards');
  expect(events[1]?.[0]).toBe('start');
  expect(events.filter(([kind]) => kind === 'start')).toHaveLength(1);
  expect(events[2]?.[0]).toBe('error');
});

it.each([
  ['mutation', new ChatAnkiMutationExecutor(), 'chatanki_update_card'],
  ['apkg', new ChatAnkiApkgExecutor(), 'chatanki_import_apkg'],
  ['retemplate', new ChatAnkiRetemplateExecutor(), 'chatanki_retemplate'],
])('%s entry logs info before one start and then the validation failure', async (_name, executor, tool) => {
  const events: unknown[][] = [];
  const result = await executor.execute(
    { id: `call-${tool}`, name: tool, arguments: {} },
    context(events),
  );
  expect(result.success).toBe(false);
  expect(events[0]?.[0]).toBe('info');
  expect(events[0]?.[1]).toContain(`tool_name=${tool}`);
  expect(events[1]?.[0]).toBe('start');
  expect(events[1]?.[1]).toBe(tool);
  expect(events.filter(([kind]) => kind === 'start')).toHaveLength(1);
  expect(events[2]?.[0]).toBe('error');
});

// Retain the no-info harness path used by callers that do not implement logging.
it('analysis emits start before end when info is unavailable', async () => {
  const events: unknown[][] = [];
  const result = await new ChatAnkiExecutor().execute(
    { id: 'call-analyze-no-info', name: 'chatanki_analyze', arguments: { content: '一段普通文本' } },
    context(events, { info: undefined }),
  );
  expect(result.success).toBe(true);
  expect(lifecycle(events)[0]).toEqual([
    'start', 'chatanki_analyze', { content: '一段普通文本' }, 'call-analyze-no-info',
  ]);
  expect(lifecycle(events)[1]?.[0]).toBe('end');
});

it('status refreshes a failed terminal block through the anki_cards error channel', async () => {
  const repo = new CardStoreDouble();
  repo.insertDocumentTask(failedTask('doc-failed', 'task-failed'));
  repo.setDocumentSessionSource('doc-failed', 'session-lifecycle');
  const blocks = new ChatBlockStoreDouble();
  blocks.addBlock({
    id: 'block-failed', sessionId: 'session-lifecycle', type: 'anki_cards',
    status: 'success', messageId: 'message-lifecycle', blockIndex: 0,
    toolOutput: { documentId: 'doc-failed', cards: [{ id: 'ghost-card' }] },
  } satisfies ChatAnkiChatBlock);

  const events: unknown[][] = [];
  const warnings: string[] = [];
  const blockErrors: Array<[string, string]> = [];
  const result = await new ChatAnkiStatusExecutor().execute(
    { id: 'call-status', name: 'chatanki_status', arguments: { documentId: 'doc-failed' } },
    context(events, {
      cards: repo,
      documents: repo,
      chatBlocks: blocks,
      warn: (message) => { warnings.push(message); },
      emitChunk: (blockId, update) => { events.push(['chunk', blockId, update]); },
      emitBlockError: (blockId, error) => {
        blockErrors.push([blockId, error]);
        events.push(['block-error', blockId, error]);
      },
    }),
  );
  expect(result.success).toBe(true);
  expect(blockErrors).toHaveLength(1);
  expect(blockErrors[0]?.[0]).toBe('block-failed');
  expect(blockErrors[0]?.[1].length).toBeGreaterThan(0);
  expect(warnings.some((message) => message.includes('terminal error'))).toBe(false);
});

function failedTask(documentId: string, taskId: string): DocumentTask {
  const now = '2026-08-24T00:00:00Z';
  return {
    id: taskId,
    document_id: documentId,
    original_document_name: 'failed.md',
    segment_index: 0,
    content_segment: '',
    status: 'Failed',
    created_at: now,
    updated_at: now,
    error_message: 'generation failed',
    anki_generation_options_json: '{}',
  };
}
