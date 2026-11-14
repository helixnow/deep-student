// The streaming suite's error, retry and cancel scenarios on the real B Host (g3-run-b runScenarioB:
// host/kernel/main.ts, desktop profile) against llm-service.ts and streaming.scenarios.provider.json.
// Side B only: the A/B comparison of these scenarios is G3's, once A is recorded. The expectations
// below are what the Rust paths do for the same provider bytes (cited per test).
// Run: node --test host/e2e/streaming/wave0/streaming-b.test.mjs (wrapped by streaming-b.test.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseExact } from '../../../../scripts/electron-migration/record/json.mjs';
import { runScenarioB } from '../../../../scripts/electron-migration/record/g3-run-b.mjs';

const SUITE = 'host/e2e/streaming/wave0/streaming.scenarios.json';

let prepared;
after(() => prepared && rm(prepared.root, { recursive: true, force: true }));
async function prepare() {
  if (prepared) return prepared;
  // The Host's TMPDIR is inside the snapshotted run directory; its compile-cache flush (5 s after
  // ready) would race the per-step database walk.
  process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  const root = await mkdtemp('/tmp/opencode/w05-streaming-b-');
  const { createSeed } = await import('../../data-compat/__fixtures__/scenario-seeds.ts');
  const catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  prepared = { root, catalog, suite: parseExact(await readFile(SUITE, 'utf8')) };
  return prepared;
}

async function run(id) {
  const { root, catalog, suite } = await prepare();
  const scenario = suite.scenarios.find(item => item.id === id);
  assert.ok(scenario, id);
  const directory = join(root, id, 'run');
  await mkdir(directory, { recursive: true });
  const trace = await runScenarioB(scenario, { scenarioFile: SUITE, catalog, directory });
  assert.deepEqual(trace.calls.filter(call => call.outcome.kind !== 'result').map(call => call.command), []);
  const events = trace.calls.at(-1).capture.events.map(event => JSON.parse(event.payloadRaw));
  const session = events.filter(event => typeof event?.eventType === 'string');
  const blocks = events.filter(event => typeof event?.type === 'string' && typeof event?.phase === 'string' && event.type !== 'skill_injection_audit');
  return {
    trace,
    llm: trace.llmRequests.map(r => [r.round, r.outcome, r.status, r.end, r.framesWritten]),
    session,
    sessionTypes: session.map(event => event.eventType),
    blockKinds: blocks.map(event => `${event.type}:${event.phase}`),
    blocks,
  };
}

test('success.thinking: reasoning and content blocks close in order; usage carries reasoning_tokens', async () => {
  // model2_pipeline.rs:6819-6833 reasoning chunks; llm_adapter.rs:63-81 reasoning_tokens extraction.
  const { llm, sessionTypes, blockKinds, blocks, session } = await run('chat.stream.success.thinking');
  assert.deepEqual(llm, [[0, 'served', 200, 'done', 4]]);
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_complete']);
  assert.deepEqual(blockKinds, ['thinking:start', 'thinking:chunk', 'thinking:end', 'content:start', 'content:chunk', 'content:end']);
  assert.deepEqual(blocks.filter(event => event.phase === 'chunk').map(event => event.chunk), ['先分析', '再回答']);
  assert.deepEqual([session[1].usage.totalTokens, session[1].usage.reasoningTokens], [15, 2]);
});

test('success.empty: an empty answer is retried twice by the tool loop, then fails with the empty-response error', async () => {
  // model2_pipeline.rs:591 empty response → "模型返回空响应，请重试"; tool_loop.rs:60-75 retryable, :1245-1343 two retries.
  const { llm, sessionTypes, session } = await run('chat.stream.success.empty');
  assert.deepEqual(llm, [[0, 'served', 200, 'done', 2], [0, 'served', 200, 'done', 2], [0, 'served', 200, 'done', 2]]);
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_reconnect', 'stream_reconnect', 'stream_error']);
  assert.deepEqual(session.slice(1, 3).map(event => [event.retryAttempt, event.retryMax]), [[1, 2], [2, 2]]);
  assert.equal(session[3].error, 'LLM error: 模型返回空响应，请重试');
});

test('retry.http-500-then-answer: one establish retry after the 5xx, then the answer completes', async () => {
  // model2_pipeline.rs:6515-6536: 5xx → stream_reconnect (n/5), 4-5 s cancellable wait, same request again.
  const { llm, sessionTypes, session, blocks } = await run('chat.stream.retry.http-500-then-answer');
  assert.deepEqual(llm, [[0, 'served', 500, 'http-error', 1], [1, 'served', 200, 'eof', 5]]);
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_reconnect', 'stream_complete']);
  assert.deepEqual([session[1].retryAttempt, session[1].retryMax], [1, 5]);
  assert.deepEqual(blocks.filter(event => event.phase === 'chunk').map(event => event.chunk).join(''), '重试后回答');
});

test('error.http-400-no-retry: a 4xx is neither retried at establish nor by the tool loop', async () => {
  // model2_pipeline.rs:6551-6577 other statuses fail at once; tool_loop.rs:60-75 the message is not retryable.
  const { llm, sessionTypes, session } = await run('chat.stream.error.http-400-no-retry');
  assert.deepEqual(llm, [[0, 'served', 400, 'http-error', 1]]);
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_error']);
  assert.equal(session[1].error,
    'LLM error: 模型二API请求失败: HTTP 400 - {"error":{"message":"x5 deterministic bad request","type":"invalid_request_error"}}');
});

test('interrupt.cancel-during-retry: cancelling during the 5xx retry wait ends the stream without another request', async () => {
  // model2_pipeline.rs:6532-6535 sleep_checking_cancel → "请求已被用户取消"; no second attempt.
  const { llm, sessionTypes } = await run('chat.stream.interrupt.cancel-during-retry');
  assert.deepEqual(llm, [[0, 'served', 500, 'http-error', 0]]);
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_reconnect', 'stream_cancelled']);
});

test('tool.second-round: the tool result reaches round 2 in Rust\'s message shape and the answer completes', async () => {
  // tool_loop.rs:1004 offers the schema (B: an executable tool, RF-W02-executable-only-tool-face); context.rs:576-631 appends
  // the assistant call and its tool message (content = serde_json::to_string(output)); model2_pipeline.rs:5447-5458,
  // 5562-5566 and 5796-5801 serialize them (workspace serde_json preserve_order: keys in json! order).
  const { trace, llm, sessionTypes, blockKinds, blocks } = await run('chat.stream.tool.second-round');
  assert.deepEqual(llm, [[0, 'served', 200, 'done', 3], [1, 'served', 200, 'done', 3]]);
  assert.deepEqual(blockKinds, ['tool_call_preparing:start', 'tool_call:start', 'tool_call:end', 'content:start', 'content:chunk', 'content:end']);
  assert.deepEqual(blocks.find(event => event.type === 'tool_call' && event.phase === 'start').payload,
    { toolName: 'builtin-template_list', toolInput: { text: 'hello' }, toolCallId: 'call_x5_fixed' });
  assert.deepEqual(blocks.filter(event => event.phase === 'chunk').map(event => event.chunk), ['工具结果已收到']);
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_complete']);
  const [first, second] = trace.llmRequests.map(request => request.body);
  assert.deepEqual([second.tools, second.tool_choice], [first.tools, 'auto']);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  const turn = second.messages.slice(first.messages.length);
  const output = blocks.find(event => event.type === 'tool_call' && event.phase === 'end').result.result;
  assert.deepEqual(turn.map(message => JSON.stringify(message)), [
    JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ id: 'call_x5_fixed', type: 'function',
      function: { name: 'builtin-template_list', arguments: '{"text":"hello"}' } }] }),
    JSON.stringify({ role: 'tool', tool_call_id: 'call_x5_fixed', content: JSON.stringify(output) }),
  ]);
});

test('tool.second-round-error: the tool round completes, the second round breaks after partial content', async () => {
  // model2_pipeline.rs:7193 missing terminal after output (message :559-561); tool_loop.rs:1300-1305 no retry once output exists.
  const { trace, llm, sessionTypes, session, blockKinds, blocks } = await run('chat.stream.tool.second-round-error');
  assert.deepEqual(llm, [[0, 'served', 200, 'eof', 4], [1, 'served', 200, 'eof', 1]]);
  assert.deepEqual(blockKinds, ['tool_call_preparing:start', 'tool_call:start', 'tool_call:end', 'content:start', 'content:chunk', 'content:error']);
  assert.deepEqual(blocks.find(event => event.type === 'tool_call' && event.phase === 'start').payload,
    { toolName: 'builtin-template_list', toolInput: { activeOnly: true }, toolCallId: 'call_x5_list' });
  const messages = trace.llmRequests[1].body.messages;
  assert.deepEqual(messages.filter(m => m.role === 'assistant' && m.tool_calls?.length).at(-1).tool_calls.map(call => [call.id, call.function.name]),
    [['call_x5_list', 'builtin-template_list']]);
  assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_x5_list'));
  assert.deepEqual(sessionTypes, ['stream_start', 'stream_error']);
  assert.equal(session[1].error, 'LLM error: LLM provider 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试');
});
