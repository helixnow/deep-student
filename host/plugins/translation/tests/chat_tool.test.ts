/**
 * Rust `translation_executor.rs:1474-1559`: the roster executor frames every call with
 * tool_call start/end|error events and a saved tool block; dependencies are checked
 * llm → main_db → vfs_db; multi-segment runs emit progress chunks; saves emit DSTU
 * watch events. The plugin registers it through agentTools.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { APP_EXECUTOR_ROSTER } from '../../../kernel/agent-roster.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import { createdEvent, type DstuNode } from '../../vfs/api.ts';
import translation from '../index.ts';
import { TranslationChatToolExecutor, type TranslationChatContext, type TranslationChatToolDeps } from '../src/chat_tool.ts';
import { MAX_PIPELINE_SEGMENT_CHARS, TranslationToolExecutor, type TranslationPersistenceOwner } from '../src/tool_executor.ts';
import type { TranslationRequest } from '../api.ts';

function recordingContext(overrides: Partial<TranslationChatContext> = {}) {
  const events: Array<[string, ...unknown[]]> = [];
  const saved: ToolResultInfo[] = [];
  const emitter = {
    emitChunkWithMeta: (...args: unknown[]) => { events.push(['chunk', ...args]); },
    emitChunk: (...args: unknown[]) => { events.push(['plain-chunk', ...args]); },
  };
  const context = {
    session_id: 'sess_tr', block_id: 'blk_tr', variant_id: 'var_1', skill_state_version: 2, round_id: 'round_1',
    emitter, tauri_window: { window: 'main' }, vfs_db: { getConnSafe: () => ({}) }, llm_manager: {}, main_db: {},
    isCancelled: () => false,
    emitToolCallStart: (...args: unknown[]) => { events.push(['start', ...args]); },
    emitToolCallEnd: (result: unknown) => { events.push(['end', result]); },
    emitToolCallError: (error: string) => { events.push(['error', error]); },
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
    ...overrides,
  } as unknown as TranslationChatContext;
  return { context, events, saved };
}

function deps(overrides: Partial<TranslationChatToolDeps> = {}) {
  const requests: TranslationRequest[] = [];
  const emitted: Array<[string, unknown]> = [];
  const value: TranslationChatToolDeps = {
    runner: () => ({
      run: async request => {
        requests.push(request);
        return { translated_text: `[${request.tgt_lang}]${request.text.length}` } as never;
      },
    }),
    owner: () => null,
    emit: (channel, payload) => { emitted.push([channel, payload]); },
    createdEvent,
    info: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
  return { value, requests, emitted };
}

const call = (name: string, args: unknown) => ({ id: 'call_tr', name: `builtin-${name}`, arguments: args });

describe('TranslationChatToolExecutor', () => {
  it('keeps the Rust roster identity and tool gates', () => {
    const executor = new TranslationChatToolExecutor(new TranslationToolExecutor(), deps().value);
    expect(executor.name()).toBe('TranslationToolExecutor');
    expect(APP_EXECUTOR_ROSTER as readonly string[]).toContain('TranslationToolExecutor');
    for (const tool of ['translate_text', 'translation_result_read', 'translation_save']) {
      expect(executor.canHandle(`builtin-${tool}`)).toBe(true);
    }
    expect(executor.canHandle('builtin-docx_create')).toBe(false);
    expect(executor.sensitivityLevel('builtin-translation_save')).toBe('medium');
    expect(executor.concurrencyClass('builtin-translation_result_read')).toBe('read_only');
    const schema = fs.readFileSync(new URL('../../../../src/features/chat/skills/builtin-tools/translation-tools.ts', import.meta.url), 'utf8');
    for (const tool of ['translate_text', 'translation_save']) expect(schema).toContain(`'builtin-${tool}'`);
  });

  it('frames translate_text with start/end events, saves the block, and streams multi-segment progress', async () => {
    const { value, requests } = deps();
    const executor = new TranslationChatToolExecutor(new TranslationToolExecutor(), value);
    const recorded = recordingContext();
    const text = `${'a'.repeat(MAX_PIPELINE_SEGMENT_CHARS)}\n${'b'.repeat(10)}`;
    const result = await executor.execute(call('translate_text', { text, source_lang: 'en', target_lang: 'zh' }), recorded.context);
    expect(result.success, result.error ?? '').toBe(true);
    expect(requests).toHaveLength(2);
    expect(recorded.events[0]).toEqual([
      'start', 'builtin-translate_text', expect.objectContaining({ source_lang: 'en', target_lang: 'zh' }), 'call_tr',
    ]);
    const chunks = recorded.events.filter(event => event[0] === 'chunk');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.slice(1, 3)).toEqual(['tool_call', 'blk_tr']);
    expect(JSON.parse(chunks[1]![3] as string)).toEqual({ progress: {
      tool: 'translate_text', stage: 'translating', completed_segments: 2, segment_count: 2,
      translated_chars: (result.output as { translated_chars: number }).translated_chars,
    } });
    expect(chunks[0]!.slice(4)).toEqual(['var_1', 2, 'round_1']);
    const end = recorded.events.at(-1)!;
    expect(end[0]).toBe('end');
    expect(end[1]).toEqual({ result: result.output, durationMs: result.durationMs });
    expect(result).toMatchObject({ toolCallId: 'call_tr', blockId: 'blk_tr', toolName: 'builtin-translate_text' });
    expect(recorded.saved).toEqual([result]);

    const single = recordingContext();
    await executor.execute(call('translate_text', { text: 'hello', source_lang: 'en', target_lang: 'zh' }), single.context);
    expect(single.events.filter(event => event[0] === 'chunk')).toEqual([]);
  });

  it('reports missing dependencies in Rust order as failed results with output null', async () => {
    const executor = new TranslationChatToolExecutor(new TranslationToolExecutor(), deps().value);
    const args = { text: 'hello', source_lang: 'en', target_lang: 'zh' };
    for (const [overrides, message] of [
      [{ llm_manager: null }, 'LLM manager is not available.'],
      [{ main_db: null }, 'Main database is not available.'],
      [{ vfs_db: null }, 'VFS database is not available.'],
    ] as const) {
      const recorded = recordingContext(overrides as Partial<TranslationChatContext>);
      const result = await executor.execute(call('translate_text', args), recorded.context);
      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(JSON.parse(result.error!)).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', message, retryable: true });
      expect(recorded.events.map(event => event[0])).toEqual(['start', 'error']);
      expect(recorded.events[1]![1]).toBe(result.error);
      expect(recorded.saved).toEqual([result]);
    }
    const invalid = await executor.execute(call('translate_text', { text: '' }), recordingContext({ llm_manager: null }).context);
    expect(JSON.parse(invalid.error!)).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('translation_save persists through the L11 owner and emits created watch events', async () => {
    const metadata: unknown[] = [];
    const owner: TranslationPersistenceOwner = {
      createTranslationInFolder: (_conn, params) => ({
        id: 'tr_1', resourceId: 'res_tr_1', title: params.title ?? null, srcLang: params.srcLang, tgtLang: params.tgtLang,
        engine: null, model: null, sourceText: params.source, translatedText: params.translated,
        isFavorite: false, qualityRating: null, createdAt: '2026-11-07T00:00:00Z', updatedAt: null, metadata: null,
      }) as never,
      updateTranslationMetadata: (_conn, id, value) => { metadata.push([id, value]); },
    };
    const { value, emitted } = deps({ owner: () => owner });
    const executor = new TranslationChatToolExecutor(new TranslationToolExecutor(), value);
    const recorded = recordingContext();
    const result = await executor.execute(call('translation_save', {
      source: 'hello', translated: '你好', source_lang: 'en', target_lang: 'zh', title: '问候',
    }), recorded.context);
    expect(result.success, result.error ?? '').toBe(true);
    expect(result.output).toMatchObject({ translation_id: 'tr_1', resource_id: 'res_tr_1', metadata_persisted: true });
    expect(metadata).toHaveLength(1);
    const path = (result.output as { path: string }).path;
    expect(emitted.map(([channel]) => channel)).toEqual([`dstu:change:${path}`, 'dstu:change']);
    expect(emitted[0]![1]).toMatchObject({ type: 'created', path });
    expect((emitted[0]![1] as { node: DstuNode }).node.path).toBe(path);

    const noOwner = await new TranslationChatToolExecutor(new TranslationToolExecutor(), deps().value)
      .execute(call('translation_save', { source: 'a', translated: 'b', source_lang: 'en', target_lang: 'zh' }), recordingContext().context);
    expect(JSON.parse(noOwner.error!)).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});

it('translation plugin registers the chat tool executor through agentTools and disposes it on unload', async () => {
  const registered: AgentToolExecutor[][] = [];
  const disposed: AgentToolExecutor[][] = [];
  const host = await createTestHost({
    plugins: [translation],
    provide: {
      llm: {}, llmCodexAuth: {}, llmHttp: { fetch },
      agentTools: {
        registerToolExecutors(executors: readonly AgentToolExecutor[]) {
          const batch = [...executors];
          registered.push(batch);
          return { dispose: () => { disposed.push(batch); } };
        },
      },
    },
  });
  try {
    expect(registered.map(batch => batch.map(executor => executor.name()))).toEqual([['TranslationToolExecutor']]);
    expect(typeof registered[0]![0]!.execute).toBe('function');
  } finally { await host.dispose(); }
  expect(disposed).toEqual(registered);
});
