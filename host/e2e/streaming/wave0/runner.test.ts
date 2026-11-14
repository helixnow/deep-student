/**
 * WAVE0 independent runner on side B: the shared v0 scenario file → runner → production
 * recorder, over the real Host plugins and the real L01 OpenAI parser (no fake adapter).
 * Provider bytes come only from the WAVE0 LLM service. This is not an A/B parity verdict;
 * the A takes are X7's. The existing cancel-after-partial red assertion is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { streamingHost, withoutToolExecutors } from '../__fixtures__/host.ts';
import { startLlmService, type LlmService } from './llm-service.ts';
import { hostDriver, runScenario, type Scenario, type ScenarioFile } from './runner.ts';
import { applyRules, candidateRules } from './normalize-candidates.ts';
import type { StreamRecord } from './recorder.ts';

const file = JSON.parse(readFileSync(new URL('./streaming.scenarios.json', import.meta.url), 'utf8')) as ScenarioFile;
const scenario = (id: string) => file.scenarios.find(item => item.id === id)!;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function recordB(id: string, take = 'B', adapt = (item: Scenario) => item): Promise<{ record: StreamRecord; hostEvents: number; llm: LlmService }> {
  const llm = await startLlmService();
  cleanup.push(() => llm.stop());
  // One host per process at a time: several platform slots (e.g. the deletion journal) are process-wide.
  const fixture = await streamingHost('answer', { diagnostics: true, realProviders: true });
  cleanup.push(() => fixture.dispose());
  const record = await runScenario(adapt(scenario(id)), hostDriver(fixture.host), { side: 'B', take, llm });
  expect(fixture.fake.created).toEqual([]); // real L01 adapter, not the fake
  expect(record.llmIdle).toBe(true);
  return { record, hostEvents: fixture.host.events.length, llm };
}

/** Sequential takes: dispose this take's host and service before the next one starts. */
async function recordAndRelease(id: string, take: string) {
  const { record } = await recordB(id, take);
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return record;
}

const kinds = (record: StreamRecord) => record.events.map(event => {
  const p = event.payload as { eventType?: string; type?: string; phase?: string } | null;
  return p?.eventType ?? (p?.type ? `${p.type}:${p.phase}` : event.channel.replace(/^.*__stream_generation__\d+/, '<scoped>'));
});

describe('WAVE0 runner (side B, production recorder)', () => {
  it('success.answer: one stream_complete, every host event recorded in order', async () => {
    const { record, hostEvents, llm } = await recordB('chat.stream.success.answer');
    expect(record.events).toHaveLength(hostEvents);
    expect(record.events.map(e => e.index)).toEqual([...record.events.keys()]);
    expect(record.terminal).toMatchObject({ kind: 'stream_complete', eventsAfterFirstTerminal: 0 });
    expect(record.steps.map(s => [s.cmd, s.ok])).toEqual([['save_api_configurations', true], ['save_model_assignments', true],
      ['chat_v2_create_session', true], ['chat_v2_send_message', true]]);
    expect(record.steps[3]!.value).toBe('msg_x5_w0_answer');
    expect(llm.requests.filter(r => r.scriptId === 'success.answer' && r.round === 0 && r.end === 'done').length).toBeGreaterThanOrEqual(1);
    expect(record.llmRequests).toEqual(llm.requests);
    const chunks = record.events.filter(e => (e.payload as { type?: string; phase?: string }).type === 'content'
      && (e.payload as { phase?: string }).phase === 'chunk').map(e => (e.payload as { chunk: string }).chunk).join('');
    expect(chunks).toBe('固定回答');
    console.log(JSON.stringify({ x5wave0: 'success.answer', kinds: kinds(record), llm: llm.requests.map(r => [r.round, r.outcome, r.end]) }));
  }, 60_000);

  it('error.eof-after-partial: stream_error is recorded with the partial chunk before it', async () => {
    const { record, hostEvents } = await recordB('chat.stream.error.eof-after-partial');
    expect(record.events).toHaveLength(hostEvents);
    expect(record.terminal.kind).toBe('stream_error');
    const terminal = record.events[record.terminal.indices[0]!]!;
    expect(typeof (terminal.payload as { error?: unknown }).error).toBe('string');
    expect(kinds(record).slice(0, record.terminal.indices[0])).toContain('content:chunk');
    console.log(JSON.stringify({ x5wave0: 'error.eof-after-partial', kinds: kinds(record), error: (terminal.payload as { error: string }).error }));
  }, 60_000);

  it('interrupt.cancel-after-partial: cancel after the first chunk; cancel events and the client close are kept', async () => {
    const { record, hostEvents, llm } = await recordB('chat.stream.interrupt.cancel-after-partial');
    expect(record.events).toHaveLength(hostEvents);
    expect(record.steps[4]).toMatchObject({ cmd: 'chat_v2_cancel_stream', ok: true });
    expect(record.terminal.kind).toBe('stream_cancelled');
    expect(record.llmRequests[0]).toMatchObject({ scriptId: 'interrupt.hold-after-partial', framesWritten: 1, end: 'client-closed' });
    expect(record.llmRequests).toEqual(llm.requests);
    // Recorder keeps every cancel-family event; whether B's extra scoped `_cancelled` matches A is
    // decided by the A/B diff and the existing red cancel-after-partial test, not here.
    console.log(JSON.stringify({ x5wave0: 'cancel-after-partial', kinds: kinds(record) }));
  }, 60_000);

  it('tool.second-round without a tool runtime: round 0 offers the tool and is served, the tool round fails closed in one stream_error', async () => {
    const { record, hostEvents, llm } = await recordB('chat.stream.tool.second-round', 'B', withoutToolExecutors);
    const error = (record.events[record.terminal.indices[0]!]!.payload as { error?: string }).error ?? null;
    expect(record.events).toHaveLength(hostEvents);
    expect(record.terminal).toMatchObject({ kind: 'stream_error', eventsAfterFirstTerminal: 0 });
    expect(record.terminal.indices).toHaveLength(1);
    expect(llm.requests.map(r => [r.round, r.outcome, r.status, r.end])).toEqual([[0, 'served', 200, 'done']]);
    const body = llm.requests[0]!.body as { tools: Array<{ function: { name: string } }>; tool_choice: unknown };
    expect([body.tools.map(tool => tool.function.name), body.tool_choice]).toEqual([['builtin-template_list'], 'auto']);
    expect(kinds(record).slice(-3)).toEqual(['tool_call_preparing:start', '<scoped>_usage', 'stream_error']);
    expect(error).toBe('Tool error: tool round execution requires the chatToolRuntime owner service, which is not installed');
    console.log(JSON.stringify({ x5wave0: 'tool.second-round', terminal: record.terminal, kinds: kinds(record),
      llm: llm.requests.map(r => [r.round, r.outcome, r.status, r.end]), error }));
  }, 60_000);

  it('two B takes of success.answer through the candidate generator (self-repeat check; not A evidence)', async () => {
    const one = await recordAndRelease('chat.stream.success.answer', 'B1');
    const two = await recordAndRelease('chat.stream.success.answer', 'B2');
    const report = candidateRules(one, two);
    expect(report.side).toBe('B');
    expect(report.candidates.every(c => c.c2 === 'pending')).toBe(true);
    expect(report.candidates.filter(c => c.kind === 'llm-origin')).toHaveLength(1);
    // After applying the candidates, the takes must differ only where a rule was refused.
    const [n1, n2] = [applyRules(one, report.candidates), applyRules(two, report.candidates)];
    expect([n1.unbound, n1.conflicts, n2.unbound, n2.conflicts]).toEqual([[], [], [], []]);
    const again = candidateRules(n1.normalized, n2.normalized);
    expect(again.candidates).toEqual([]);
    expect(again.unrepeatable).toEqual(report.unrepeatable.map(u => expect.objectContaining({ pointer: u.pointer })));
    expect(n1.normalized.events.map(e => e.index)).toEqual(one.events.map(e => e.index));
    console.log(JSON.stringify({ x5wave0: 'B-self-repeat', verdict: report.verdict,
      candidates: [...new Set(report.candidates.map(c => `${c.kind} ${c.pattern}`))],
      unrepeatable: report.unrepeatable.map(u => [u.jsonPath, u.reason, u.a1, u.a2]) }));
  }, 120_000);
});
