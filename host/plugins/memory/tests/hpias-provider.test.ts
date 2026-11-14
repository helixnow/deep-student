import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsPlugin from '../../vfs/index.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import { BackendEventsSink, ChatV2Emitter, ChatExecutionContext } from '../../chat/api.ts';
import memoryPlugin, { type MemoryPluginConfig } from '../index.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';
import { createIndexDouble, createLogDouble, setupMemoryHost } from './support.ts';
import type { LlmRawPrompt } from '../../llm/api.ts';
import type { RetrievalService } from '../../vfs-index/api.ts';
import { retrievalResponse } from './hpias-retrieval-fixture.ts';

// Rust 读环境变量 DEEP_STUDENT_HPIAS_BACKEND；Host 经 memory 插件配置传入，每次调用时读取。
const memoryConfig: MemoryPluginConfig = {};
const setBackend = (value: string | undefined) => { memoryConfig.hpiasBackend = value; };
const researchIntent = {
  blocks: [
    { type: 'research-plan', props: { title: '  Plan question  ', steps: [{ label: 'Query A' }] } },
    { type: 'research-report', props: { body: 'Actual intent synthesis' } },
  ],
};
const windowRef = { window: 'research-window', webview: 'research-webview' };
const eventTypes = ['session_started', 'round_started', 'plan_generated', 'retrieval_completed',
  'selection_completed', 'subagent_started', 'synthesis_updated', 'subagent_completed',
  'subagents_done', 'session_completed'];
// notes 插件（L10 D005-01）在虚拟时钟里常驻一个 5s lease 清理 interval。HPIAS 的断言只看
// 自己新增的定时器，所以以这个常驻计数为基线；setupMemoryHost 用 notes 替身，没有该 interval。
const LEASE_CLEANUP_TIMERS = 1;
/** stub 时间线 10 个事件 × 350ms ≈ 3.5s；有界推进避免 runAllTimers 与常驻 interval 互锁。 */
const HPIAS_TIMELINE_MS = 10_000;
let cleanup: (() => Promise<void> | void) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  // Dispose with real timers: Host lifecycle is not part of the virtual pipeline clock.
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
  delete memoryConfig.hpiasBackend;
});

async function setup(research?: {
  llmRawPrompt: Pick<LlmRawPrompt, 'callWithConfigIdRawPrompt'>;
  retrieval: Pick<RetrievalService, 'search'>;
}) {
  // 假时钟必须在建 Host 之前装上：notes 的 interval 先以真实定时器登记时，会在测试中途
  // （尤其机器繁忙时）漏进假时钟，使 getTimerCount 与 runAllTimers 的结果依赖运行时长。
  vi.useFakeTimers();
  const { dir, storage } = await createMigratedMemoryStorage('hpias-provider-');
  const disposeStorage = () => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); };
  cleanup = disposeStorage;
  const warnings: string[] = [];
  const settings = createSettingsService({ db: () => storage.database('mistakes'),
    secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  const host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, agentSkillsPlugin, [memoryPlugin, memoryConfig] as const, vfsPlugin],
    provide: { storage, settings, log: createLogDouble(warnings), vfsIndex: createIndexDouble(),
      ...research },
    app: { dataDir: dir },
  });
  cleanup = async () => { try { await host.dispose(); } finally { disposeStorage(); } };
  // 让 notes 的首个 setImmediate tick 跑完，把它的 5s interval 固定进虚拟时钟。
  await vi.advanceTimersByTimeAsync(0);
  const executor = host.ctx.agentTools.toolExecutors().find(item => item.canHandle('render_generative_ui'));
  if (!executor?.execute) throw new Error('real L13 GenerativeUiExecutor was not registered');
  const execute = (intent: unknown = researchIntent, sessionId: string | null = 'research-170',
    window: WindowRef | null = windowRef) => {
    const context = new ChatExecutionContext({ sessionId: 'chat-170', messageId: 'message-170',
      blockId: 'block-170', services: host.ctx, window,
      emitter: new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'chat-170', false),
      toolRegistry: {
        detectToolConflicts: async () => [], stripMcpNamespace: name => name,
        callTool: async () => { throw new Error('generative UI must not invoke MCP'); },
      } }, createLogDouble([]).logger('chat'));
    return executor.execute!({ id: 'call-170', name: 'builtin-render_generative_ui',
      arguments: { intent, ...(sessionId === null ? {} : { researchSessionId: sessionId }) } }, context);
  };
  return { host, warnings, execute };
}

function payloads(host: TestHost): Array<Record<string, unknown>> {
  return host.eventsNamed('hpias_event') as Array<Record<string, unknown>>;
}

function trace(label: string, host: TestHost, warnings: string[]): void {
  console.info('WP-170', JSON.stringify({ label,
    events: host.events.filter(event => event.event === 'hpias_event'), warnings }));
}

describe('WP-170 real Host / L13 registration / memory provider', () => {
  it('backend_kind_defaults_to_disabled: every disabled branch remains silent beyond the complete timeline', async () => {
    const { host, warnings, execute } = await setup();
    for (const value of [undefined, '', '  \t\n', 'disabled', 'off', ' \u0085OFF\u0085 ']) {
      setBackend(value);
      await expect(execute()).resolves.toMatchObject({ success: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(payloads(host)).toEqual([]);
      expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
      expect(warnings).toEqual([]);
      trace(`disabled:${String(value)}`, host, warnings);
    }
  });

  it('backend_kind_unknown_value_fails_closed: normalized unknown preserves WARN, including ASCII-only case folding', async () => {
    const { host, warnings, execute } = await setup();
    for (const [value, normalized] of [[' Unexpected ', 'unexpected'], ['\uFEFFstub', '\uFEFFstub'],
      ['DİSABLED', 'dİsabled']]) {
      setBackend(value);
      await execute();
      await vi.advanceTimersByTimeAsync(5000);
      expect(payloads(host)).toEqual([]);
      expect(warnings.at(-1)).toBe(`[HpiasResearchService] Unknown DEEP_STUDENT_HPIAS_BACKEND=${JSON.stringify(normalized)}; pipeline disabled`);
      expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
      trace(`unknown:${value}`, host, warnings);
    }
    expect(warnings).toHaveLength(3);
  });

  it('backend_kind_reads_env_stub: emits synchronously, waits 350ms, then completes the original ordered timeline', async () => {
    const { host, warnings, execute } = await setup();
    setBackend('\u0085 StUb \u0085');
    const result = execute({ ...researchIntent, meta: { title: '  Explicit question  ' } });
    expect(payloads(host)).toEqual([{ type: 'session_started', session_id: 'research-170', question: 'Explicit question' }]);
    await expect(result).resolves.toMatchObject({ success: true });
    expect(host.events.map(event => event.event)).toEqual([
      'chat_v2_event_chat-170', 'chat_v2_event_chat-170', 'chat_v2_event_chat-170', 'hpias_event',
    ]);
    await vi.advanceTimersByTimeAsync(349);
    expect(payloads(host)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(payloads(host)[1]).toEqual({ type: 'round_started', session_id: 'research-170', round: 1 });
    await vi.advanceTimersByTimeAsync(HPIAS_TIMELINE_MS);
    expect(payloads(host).map(event => event.type)).toEqual(eventTypes);
    expect(payloads(host).every(event => event.session_id === 'research-170')).toBe(true);
    // hpias/events.rs:24-26 `Window::emit`：Tauri 2 默认 Emitter::emit 是全局广播，不限定到发起窗口。
    expect(host.events.filter(event => event.event === 'hpias_event').map(event => event.target))
      .toEqual(eventTypes.map(() => ({ kind: 'Any' })));
    expect(payloads(host)[2]).toMatchObject({ plan: { core: { queries: ['Query A'] } } });
    expect(payloads(host)[6]).toMatchObject({ synthesis: 'Actual intent synthesis' });
    expect(payloads(host)[7]).toMatchObject({ citations: [['paper-1', 1]] });
    expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
    expect(warnings).toEqual([]);
    trace('explicit-stub-completed', host, warnings);
  });

  it('title Option wins even when empty; only absent title uses the existing intent question fallback', async () => {
    const { host, warnings, execute } = await setup();
    setBackend('stub');
    for (const [title, question] of [[undefined, 'Plan question'], ['', undefined], ['   ', undefined],
      ['\u0085Q\u0085', 'Q'], ['\uFEFFQ\uFEFF', '\uFEFFQ\uFEFF']] as const) {
      host.events.length = 0;
      await execute({ ...researchIntent, ...(title === undefined ? {} : { meta: { title } }) });
      expect(payloads(host)[0]).toEqual({ type: 'session_started', session_id: 'research-170',
        ...(question === undefined ? {} : { question }) });
      await vi.advanceTimersByTimeAsync(HPIAS_TIMELINE_MS);
      expect(payloads(host).map(event => event.type)).toEqual(eventTypes);
      expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
      trace(`title:${String(title)}`, host, warnings);
    }
  });

  it('research block, session and window gates prevent both the first event and scheduling', async () => {
    const { host, warnings, execute } = await setup();
    setBackend('stub');
    await execute({ blocks: [{ type: 'text', props: { text: 'hi' } }] });
    await execute(researchIntent, null);
    await execute(researchIntent, 's', null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads(host)).toEqual([]);
    expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
    for (const type of ['research-plan', 'research-report', 'paper-digest']) {
      host.events.length = 0;
      await execute({ blocks: [{ type, props: {} }] }, `s-${type}`, { window: 'window-only', webview: '' });
      expect(payloads(host)[0]).toEqual({ type: 'session_started', session_id: `s-${type}` });
      await vi.advanceTimersByTimeAsync(HPIAS_TIMELINE_MS);
      expect(payloads(host).at(-1)?.type).toBe('session_completed');
      expect(host.events.filter(event => event.event === 'hpias_event').every(event => event.target.kind === 'Any')).toBe(true);
      expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
    }
    expect(warnings).toEqual([]);
  });

  it('session_started send failure warns and continues; later send failure warns and stops', async () => {
    const { host, warnings, execute } = await setup();
    setBackend('stub');
    const events = host.ctx.backendEvents;
    const send = events.emit.bind(events);
    let failNext: string | null = 'first send failed';
    vi.spyOn(events, 'emit').mockImplementation((...args: Parameters<typeof events.emit>) => {
      if (args[0] !== 'hpias_event' || failNext === null) return send(...args);
      const message = failNext;
      failNext = null;
      throw new Error(message);
    });
    await execute();
    expect(warnings).toEqual(['[GenerativeUiExecutor] hpias_event session_started emit failed: first send failed']);
    await vi.advanceTimersByTimeAsync(350);
    expect(payloads(host)[0]).toEqual({ type: 'round_started', session_id: 'research-170', round: 1 });
    await vi.advanceTimersByTimeAsync(HPIAS_TIMELINE_MS);
    expect(payloads(host).map(event => event.type)).toEqual(eventTypes.slice(1));
    expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
    trace('first-send-failed-continued', host, warnings);
    host.events.length = 0;
    await execute();
    failNext = 'later send failed';
    await vi.advanceTimersByTimeAsync(HPIAS_TIMELINE_MS);
    expect(payloads(host).map(event => event.type)).toEqual(['session_started']);
    expect(warnings.at(-1)).toBe('[HpiasPipelineOrchestrator] emit failed at index 1: later send failed');
    expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
    trace('later-send-failed-stopped', host, warnings);
  });

  it('retrieval with missing VFS/LLM preserves the Rust WARN/None branch', async () => {
    const fixture = await setupMemoryHost({ memoryConfig });
    cleanup = () => fixture.dispose();
    setBackend('retrieval');
    vi.useFakeTimers();
    fixture.host.ctx.hpiasResearch.startFromIntent({ window: windowRef, sessionId: 'missing', title: null, intent: researchIntent });
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads(fixture.host)).toEqual([]);
    expect(fixture.warnings).toEqual(['[HpiasResearchService] retrieval backend requested but VFS/LLM unavailable; pipeline disabled']);
    expect(vi.getTimerCount()).toBe(0);
    trace('retrieval-missing-both', fixture.host, fixture.warnings);
  });

  it('retrieval with VFS but no LLM remains unavailable, without falling back to stub', async () => {
    const { host, warnings, execute } = await setup();
    setBackend('retrieval');
    await execute();
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads(host)).toEqual([]);
    expect(warnings).toEqual(['[HpiasResearchService] retrieval backend requested but VFS/LLM unavailable; pipeline disabled']);
    expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
    trace('retrieval-missing-llm', host, warnings);
  });

  it('retrieval with LLM but no VFS preserves the missing-dependency WARN', async () => {
    const fixture = await setupMemoryHost({ memoryConfig, memoryDecision: () => { throw new Error('must not call LLM'); } });
    cleanup = () => fixture.dispose();
    setBackend('retrieval');
    vi.useFakeTimers();
    fixture.host.ctx.hpiasResearch.startFromIntent({ window: windowRef, sessionId: 'missing-vfs', title: null, intent: researchIntent });
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads(fixture.host)).toEqual([]);
    expect(fixture.warnings).toEqual(['[HpiasResearchService] retrieval backend requested but VFS/LLM unavailable; pipeline disabled']);
    expect(fixture.memoryDecision?.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    trace('retrieval-missing-vfs', fixture.host, fixture.warnings);
  });

  it('retrieval from the real L13 executor searches VFS and synthesizes evidence through the published L02 port', async () => {
    const search = vi.fn(async () => retrievalResponse([{ title: 'VFS document', text: 'retrieved evidence', sourceId: 'note-a' }]));
    const call = vi.fn(async () => ({ assistant_message: '  ## 综合结论\nGrounded report [note-a-1]  ',
      raw_response: '', chain_of_thought_details: null, cancelled: false }));
    const { host, warnings, execute } = await setup({ retrieval: { search }, llmRawPrompt: { callWithConfigIdRawPrompt: call } });
    setBackend('retrieval');
    const result = execute();
    expect(payloads(host)[0]).toEqual({ type: 'session_started', session_id: 'research-170', question: 'Plan question' });
    await expect(result).resolves.toMatchObject({ success: true });
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(119);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledWith({ queryText: 'Query A', queryImageBase64: null, queryImageMediaType: null,
      queryModality: 'text', topK: 8, folderIds: null, resourceIds: null, resourceTypes: null });
    await vi.advanceTimersByTimeAsync(120);
    expect(call).toHaveBeenCalledWith('_hpias_synthesis_', expect.stringContaining('[note-a-1] VFS document — retrieved evidence'),
      expect.any(AbortSignal));
    expect(payloads(host).map(event => event.type)).toEqual(['session_started', 'round_started', 'plan_generated',
      'subagent_started', 'subagent_completed', 'retrieval_completed', 'selection_completed',
      'synthesis_updated', 'subagents_done', 'session_completed']);
    expect(payloads(host).find(event => event.type === 'synthesis_updated')?.synthesis).toBe('## 综合结论\nGrounded report [note-a-1]');
    expect(payloads(host).find(event => event.type === 'subagent_completed')).toMatchObject({ steps: 2,
      summary_md: 'VFS document：retrieved evidence…', citations: [['note-a', 1]] });
    expect(host.events.filter(event => event.event === 'hpias_event').every(event => event.target.kind === 'Any')).toBe(true);
    expect(warnings).toEqual([]);
    expect(vi.getTimerCount()).toBe(LEASE_CLEANUP_TIMERS);
  });

  it('the actual 350ms scheduler reaches completion and drains after provider disposal', async () => {
    const { host, warnings, execute } = await setup();
    // 本条按真实时钟等 350ms 调度；切回真实定时器（同时丢弃 notes 留在虚拟时钟里的 interval）。
    vi.useRealTimers();
    setBackend('stub');
    await execute();
    expect(payloads(host)[0]).toMatchObject({ type: 'session_started' });
    await expect.poll(() => payloads(host).at(-1)?.type, { timeout: 5000 }).toBe('session_completed');
    expect(payloads(host).map(event => event.type)).toEqual(eventTypes);
    trace('real-clock-completed', host, warnings);
    await execute();
    const count = payloads(host).length;
    await host.dispose();
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(payloads(host)).toHaveLength(count);
    expect(warnings).toEqual([]);
  });
});
