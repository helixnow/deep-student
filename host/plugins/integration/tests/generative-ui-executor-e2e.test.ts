import { afterEach, expect, it } from 'vitest';
import {
  BackendEventsSink, ChatV2Emitter,
  type BackendEvent, type ToolCall, type ToolResultInfo,
} from '../../chat/api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-impl: L22 集成测试经 L13 的真实 GenerativeUiExecutor 验证事件链与拒绝路径
import { GenerativeUiExecutor } from '../../vfs/src/tools/generative-ui.ts';

/**
 * `tests/generative_ui_executor_e2e.rs` 的 TS 行为级移植。
 *
 * 不复制 executor 或事件协议：直接调用 L13 生产 `GenerativeUiExecutor`，用
 * L04 `ChatV2Emitter` 把事件投到 Host `backendEvents`，再按 Rust 的
 * `capture_block_events` 通道 `chat_v2_event_<session>` 取回断言。
 */
const hosts: TestHost[] = [];
const SESSION_ID = 'generative-ui-executor-e2e';
const MESSAGE_ID = 'msg-generative-ui-e2e';

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setup(): Promise<{ host: TestHost; executor: GenerativeUiExecutor }> {
  const host = await createTestHost({});
  hosts.push(host);
  return { host, executor: new GenerativeUiExecutor(() => {
    throw new Error('these Rust windowless cases do not start research');
  }) };
}

async function execute(
  host: TestHost,
  executor: GenerativeUiExecutor,
  blockId: string,
  arguments_: unknown,
  toolName = 'builtin-render_generative_ui',
): Promise<ToolResultInfo> {
  const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), SESSION_ID, false);
  const persisted: ToolResultInfo[] = [];
  const call: ToolCall = { id: 'call-generative-ui-e2e', name: toolName, arguments: arguments_ };
  const result = await executor.execute(call, {
    message_id: MESSAGE_ID,
    block_id: blockId,
    variant_id: null,
    skill_state_version: null,
    round_id: null,
    emitter,
    tryWindow: () => null,
    saveToolBlock: (value: ToolResultInfo) => { persisted.push(value); },
  } as never);
  expect(persisted).toEqual([result]);
  return result;
}

function blockEvents(host: TestHost): BackendEvent[] {
  return host.eventsNamed(`chat_v2_event_${SESSION_ID}`) as BackendEvent[];
}

function generativeEvents(host: TestHost): BackendEvent[] {
  return blockEvents(host).filter(event => event.type === 'generative_ui');
}

it('execute_emits_generative_ui_start_chunk_end_events', async () => {
  const { host, executor } = await setup();
  const blockId = 'block-generative-ui-e2e';
  const intent = {
    version: '1',
    meta: { title: 'Briefing' },
    blocks: [{ type: 'stat-card', props: { title: 'Due flashcards', value: 4 } }],
  };

  const result = await execute(host, executor, blockId, { intent });

  expect(result.success).toBe(true);

  const events = generativeEvents(host);
  expect(events.some(event => event.phase === 'start'), 'missing start event').toBe(true);
  expect(events.some(event => event.phase === 'chunk'), 'missing chunk event').toBe(true);
  const end = events.find(event => event.phase === 'end');
  expect(end, 'missing end event').toBeDefined();
  expect(end!.blockId).toBe(blockId);
  const endResult = end!.result as {
    intent: { blocks: unknown[] };
    isStreaming: boolean;
  };
  expect(endResult.intent.blocks).toHaveLength(1);
  expect(endResult.isStreaming).toBe(false);
});

it('execute_v1_1_grid_layout_emits_generative_ui', async () => {
  const { host, executor } = await setup();
  const blockId = 'block-generative-ui-v11-e2e';
  const intent = {
    version: '1.1',
    layout: { mode: 'grid', columns: 2 },
    meta: { title: 'Grid briefing' },
    blocks: [{ type: 'stat-card', props: { title: 'Due flashcards', value: 4 }, span: 2 }],
  };

  const result = await execute(host, executor, blockId, { intent });

  expect(result.success).toBe(true);
  expect((result.output as { status: string }).status).toBe('rendered');

  const events = generativeEvents(host);
  expect(events.some(event => event.phase === 'start'), 'missing start event').toBe(true);
  expect(events.some(event => event.phase === 'chunk'), 'missing chunk event').toBe(true);
  const end = events.find(event => event.phase === 'end');
  expect(end, 'missing end event').toBeDefined();
  expect(end!.blockId).toBe(blockId);
  const endResult = end!.result as {
    intent: { version: string; layout: { mode: string }; blocks: Array<{ span?: number }> };
    isStreaming: boolean;
  };
  expect(endResult.intent.version).toBe('1.1');
  expect(endResult.intent.layout.mode).toBe('grid');
  expect(endResult.intent.blocks[0]!.span).toBe(2);
  expect(endResult.isStreaming).toBe(false);
});

it('execute_rejects_version_2', async () => {
  const { host, executor } = await setup();
  const blockId = 'block-generative-ui-v2-e2e';

  const result = await execute(host, executor, blockId, {
    intent: {
      version: '2',
      layout: { mode: 'grid', columns: 2 },
      blocks: [{ type: 'text', props: { text: 'hi' } }],
    },
  });

  expect(result.success).toBe(false);
  expect(result.error ?? '').toContain('version');
  expect(generativeEvents(host).some(event => event.phase === 'error')).toBe(true);
});

it('execute_rejects_unknown_block_type', async () => {
  const { host, executor } = await setup();
  const blockId = 'block-generative-ui-unknown-type-e2e';

  const result = await execute(host, executor, blockId, {
    intent: {
      version: '1',
      blocks: [{ type: 'unknown-widget', props: {} }],
    },
  });

  expect(result.success).toBe(false);
  expect(result.error ?? '').toContain('unknown-widget');
  expect(generativeEvents(host).some(event => event.phase === 'error')).toBe(true);
});

it('execute_rejects_too_many_blocks', async () => {
  const { host, executor } = await setup();
  const blockId = 'block-generative-ui-too-many-e2e';
  const blocks = Array.from({ length: 33 }, (_, index) => ({
    type: 'text', props: { text: `block-${index}` },
  }));

  const result = await execute(host, executor, blockId, {
    intent: { version: '1', blocks },
  });

  expect(result.success).toBe(false);
  const error = result.error ?? '';
  expect(error.includes('32') || error.includes('上限')).toBe(true);
  expect(generativeEvents(host).some(event => event.phase === 'error')).toBe(true);
});

it('execute_with_note_edit_preserves_input_payload', async () => {
  const { host, executor } = await setup();
  const noteEdit = { operation: 'append', content: '## E2E' };
  const intent = {
    version: '1',
    blocks: [
      { type: 'text', props: { body: 'Preview' } },
      { type: 'action-bar', props: { actions: [{ id: 'apply-note-edit', label: 'Apply' }] } },
    ],
  };

  const result = await execute(host, executor, 'block-generative-ui-note-edit-e2e', {
    intent, noteEdit,
  });

  expect(result.success).toBe(true);
  const input = result.input as { noteEdit?: { operation?: string } };
  expect(input.noteEdit?.operation).toBe('append');
});
