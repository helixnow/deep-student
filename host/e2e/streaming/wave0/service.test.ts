import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { startLlmService, scripts, type LlmService } from './llm-service.ts';
import { StreamRecorder, terminalOf } from './recorder.ts';
import { applyRules, candidateRules } from './normalize-candidates.ts';

const services: LlmService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); });
async function service() { const s = await startLlmService(); services.push(s); return s; }

const body = (extra: Record<string, unknown> = {}) => ({ model: 'm', stream: true, messages: [{ role: 'user', content: 'q' }], ...extra });
async function post(url: string, payload: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
}

describe('WAVE0 LLM service: same input → same bytes', () => {
  it('success.answer streams fixed OpenAI chunks then [DONE]; a second instance returns identical bytes', async () => {
    const [one, two] = [await service(), await service()];
    const first = await post(`${one.baseUrl('success.answer')}/chat/completions`, body());
    const second = await post(`${two.baseUrl('success.answer')}/chat/completions`, body());
    expect(first).toEqual(second);
    expect(first.status).toBe(200);
    expect(first.type).toBe('text/event-stream');
    const frames = first.text.split('\n\n').filter(Boolean);
    expect(frames).toEqual([
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"content":"固定"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"content":"回答"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
      'data: [DONE]',
    ]);
    expect(one.requests).toEqual([{ seq: 0, method: 'POST', path: '/s/success.answer/v1/chat/completions', scriptId: 'success.answer',
      round: 0, stream: true, body: body(), outcome: 'served', status: 200, framesWritten: 4, end: 'done' }]);
  });

  it('error.eof-after-partial ends without finish/[DONE]; error.http-500 returns the fixed body', async () => {
    const s = await service();
    const eof = await post(`${s.baseUrl('error.eof-after-partial')}/chat/completions`, body());
    expect(eof.text).not.toContain('[DONE]');
    expect(eof.text).not.toContain('finish_reason":"stop');
    expect(eof.text.split('\n\n').filter(Boolean)).toHaveLength(1);
    const failed = await post(`${s.baseUrl('error.http-500')}/chat/completions`, body());
    expect(failed).toEqual({ status: 500, type: 'application/json', text: scripts['error.http-500'].rounds[0]!.body });
    expect(s.requests.map(r => [r.scriptId, r.outcome, r.status, r.end])).toEqual([
      ['error.eof-after-partial', 'served', 200, 'eof'], ['error.http-500', 'served', 500, 'http-error']]);
  });

  it('interrupt.hold-after-partial keeps the response open until the client closes; the close is logged, not dropped', async () => {
    const s = await service();
    const url = new URL(`${s.baseUrl('interrupt.hold-after-partial')}/chat/completions`);
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    req.end(JSON.stringify(body()));
    const [response] = await once(req, 'response') as [import('node:http').IncomingMessage];
    response.setEncoding('utf8');
    const [first] = await once(response, 'data') as [string];
    expect(first).toContain('取消前内容');
    expect(s.requests[0]).toMatchObject({ framesWritten: 1, end: null });
    req.destroy();
    for (let i = 0; i < 1000 && s.requests[0]!.end === null; i++) await new Promise(resolve => setImmediate(resolve));
    expect(s.requests[0]).toMatchObject({ outcome: 'served', framesWritten: 1, end: 'client-closed' });
  });

  it('stop() closes a held stream as server-stopped', async () => {
    const s = await startLlmService();
    const req = httpRequest(new URL(`${s.baseUrl('interrupt.hold-after-partial')}/chat/completions`), { method: 'POST' });
    req.on('error', () => {});
    req.end(JSON.stringify(body()));
    const [response] = await once(req, 'response') as [import('node:http').IncomingMessage];
    response.on('error', () => {});
    await once(response, 'data');
    await s.stop();
    expect(s.requests[0]!.end).toBe('server-stopped');
  });

  it('tool.second-round: round is derived from the request body (stateless), and uses the first offered tool', async () => {
    const s = await service();
    const tools = [{ type: 'function', function: { name: 'builtin-echo_text', parameters: {} } }];
    const round0 = await post(`${s.baseUrl('tool.second-round')}/chat/completions`, body({ tools }));
    expect(round0.text).toContain('"tool_calls":[{"index":0,"id":"call_x5_fixed","type":"function","function":{"name":"builtin-echo_text","arguments":"{\\"text\\":\\"hello\\"}"}}]');
    expect(round0.text).toContain('"finish_reason":"tool_calls"');
    const followUp = body({ tools, messages: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x5_fixed', type: 'function', function: { name: 'builtin-echo_text', arguments: '{"text":"hello"}' } }] },
      { role: 'tool', tool_call_id: 'call_x5_fixed', content: '{"echoed":"hello"}' }] });
    const round1 = await post(`${s.baseUrl('tool.second-round')}/chat/completions`, followUp);
    expect(round1.text).toContain('"content":"工具结果已收到"');
    // Same round-0 input again → same bytes (no cursor shared between requests).
    expect(await post(`${s.baseUrl('tool.second-round')}/chat/completions`, body({ tools }))).toEqual(round0);
    expect(s.requests.map(r => r.round)).toEqual([0, 1, 0]);
    const noTool = await post(`${s.baseUrl('tool.second-round')}/chat/completions`, body());
    expect(noTool.status).toBe(400);
    const extra = await post(`${s.baseUrl('success.answer')}/chat/completions`, followUp);
    expect(extra.status).toBe(409);
    const unknown = await post(`${s.baseUrl('nope')}/chat/completions`, body());
    expect(unknown.status).toBe(404);
    expect(s.requests.slice(3).map(r => r.outcome)).toEqual(['no-tool-offered', 'unscripted-round', 'unknown-script']);
  });

  it('non-stream callers get the same round folded into one completion', async () => {
    const s = await service();
    const result = await post(`${s.baseUrl('success.thinking')}/chat/completions`, body({ stream: false }));
    expect(JSON.parse(result.text)).toEqual({ id: 'chatcmpl-x5-fixed', object: 'chat.completion', created: 1700000000, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '再回答', reasoning_content: '先分析' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } } });
  });

  it('CLI: prints its URL, serves, and prints the full request log on SIGTERM', async () => {
    const child = spawn(process.execPath, ['host/e2e/streaming/wave0/llm-service.ts'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    for (let i = 0; i < 2000 && !out.includes('\n'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const started = JSON.parse(out.split('\n')[0]!) as { url: string; scripts: string[] };
    expect(started.scripts).toEqual(Object.keys(scripts));
    const served = await post(`${started.url}/s/success.answer/v1/chat/completions`, body());
    expect(served.status).toBe(200);
    expect((await post(`${started.url}/not-a-route`, body())).status).toBe(404);
    const log = await fetch(`${started.url}/__x5/requests`).then(r => r.json()) as Array<{ outcome: string }>;
    expect(log.map(r => r.outcome)).toEqual(['served', 'not-found']); // introspection itself is not logged
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    const stopped = JSON.parse(out.trim().split('\n').at(-1)!) as { stopped: boolean; requests: Array<{ outcome: string }> };
    expect(stopped.stopped).toBe(true);
    expect(stopped.requests.map(r => r.outcome)).toEqual(['served', 'not-found']);
  });
});

describe('WAVE0 recorder', () => {
  it('keeps every event in order, including events after a terminal and multiple terminals', () => {
    const r = new StreamRecorder({ scenario: 's', side: 'A', take: 'A1' });
    r.push('chat_v2_session_x', { eventType: 'stream_start' });
    r.push('chat_v2_event_x', { type: 'content', phase: 'chunk', chunk: 'a' });
    r.push('chat_v2_session_x', { eventType: 'stream_cancelled' });
    r.push('scoped_x_cancelled', { reason: 'user_cancelled' });
    r.push('chat_v2_session_x', { eventType: 'stream_error', error: 'e' });
    const record = r.finish();
    expect(record.events.map(e => [e.index, e.channel])).toEqual([[0, 'chat_v2_session_x'], [1, 'chat_v2_event_x'],
      [2, 'chat_v2_session_x'], [3, 'scoped_x_cancelled'], [4, 'chat_v2_session_x']]);
    expect(record.terminal).toEqual({ kind: 'multiple', indices: [2, 4], eventsAfterFirstTerminal: 2 });
    expect(terminalOf(record.events.slice(0, 2))).toEqual({ kind: 'none', indices: [], eventsAfterFirstTerminal: 0 });
  });

  it('pullHostEvents copies kernel events from a cursor, preferring the source-preserving JSON text', () => {
    const r = new StreamRecorder({ scenario: 's', side: 'B', take: 'B' });
    const source = [{ kind: 'event' as const, event: 'a', payload: { n: 1 }, target: { kind: 'Any' as const } },
      { kind: 'event' as const, event: 'b', payload: { n: 2 }, payloadJson: '{"n":12345678901234567890}', target: { kind: 'Any' as const } }];
    expect(r.pullHostEvents(source, 0)).toBe(2);
    expect(r.events).toEqual([{ index: 0, channel: 'a', payload: { n: 1 }, payloadJson: '{"n":1}' },
      { index: 1, channel: 'b', payload: { n: 12345678901234567890 }, payloadJson: '{"n":12345678901234567890}' }]);
  });
});

describe('WAVE0 normalisation candidates (synthetic A1/A2; real A takes come from X7)', () => {
  // Synthetic inputs originate here, so supply their wire at creation, unlike a real
  // A object-only tap (which cannot recover the original JSON and stays unsupported).
  const pushSynthetic = (r: StreamRecorder, channel: string, payload: unknown) => r.push(channel, payload, JSON.stringify(payload));
  const take = (label: string, run: string, eventId: string, ts: number, tmp: string, extra: (r: StreamRecorder) => void = () => {}) => {
    const r = new StreamRecorder({ scenario: 'chat.stream.success.answer', side: 'A', take: label, llmScript: 'success.answer' });
    const value = { id: `sess_${eventId}`, dir: `${tmp}/data` };
    r.step({ cmd: 'chat_v2_create_session', args: {}, argsJson: '{}', ok: true, value, valueJson: JSON.stringify(value), eventsBefore: 0, eventsAfter: 0 });
    pushSynthetic(r, `chat_v2_session_sess_${eventId}`, { eventType: 'stream_start', sessionId: `sess_${eventId}`, timestamp: ts });
    pushSynthetic(r, `chat_v2_event_sess_${eventId}_var_m_run_${run}__stream_generation__1_start`, { id: eventId, durationMs: 5 });
    extra(r);
    pushSynthetic(r, `chat_v2_session_sess_${eventId}`, { eventType: 'stream_complete', sessionId: `sess_${eventId}`, timestamp: ts + 9 });
    return r.finish();
  };
  const run1 = 'a'.repeat(32), run2 = 'b'.repeat(32);
  const id1 = '11111111-1111-4111-8111-111111111111', id2 = '22222222-2222-4222-8222-222222222222';

  it('maps ids consistently across return/channel/payload, proposes timestamp and temp-path rules, all pending C2', () => {
    const a1 = take('A1', run1, id1, 1_762_300_000_000, '/tmp/opencode/x5-AAAAAA');
    const a2 = take('A2', run2, id2, 1_762_300_000_500, '/tmp/opencode/x5-BBBBBB');
    const report = candidateRules(a1, a2);
    expect(report.verdict).toBe('candidates-only');
    expect(report.unrepeatable).toEqual([]);
    expect(new Set(report.candidates.map(c => c.kind))).toEqual(new Set(['dynamic-id', 'timestamp', 'temp-path']));
    expect(report.candidates.every(c => c.c2 === 'pending' && c.pointer.startsWith('/') && c.jsonPath.startsWith('$'))).toBe(true);
    const idSlots = new Set(report.candidates.filter(c => c.kind === 'dynamic-id' && c.a1 === id1).map(c => c.slot));
    expect(idSlots.size).toBe(1);
    expect(report.candidates.find(c => c.kind === 'temp-path')).toMatchObject({ a1: '/tmp/opencode/x5-AAAAAA', jsonPath: '$.steps[0].value.dir' });
    const n1 = applyRules(a1, report.candidates), n2 = applyRules(a2, report.candidates);
    expect(n1.conflicts).toEqual([]);
    expect(n1.unbound).toEqual([]);
    const { take: _1, ...left } = n1.normalized; const { take: _2, ...right } = n2.normalized;
    expect(left).toEqual(right);
    // Raw takes stay untouched; event count/order and non-dynamic text are preserved.
    expect(a1.events[1]!.channel).toContain(run1);
    expect(n1.normalized.events.map(e => e.channel)).toEqual(['chat_v2_session_sess_<id:1>',
      'chat_v2_event_sess_<id:1>_var_m_run_<id:2>__stream_generation__1_start', 'chat_v2_session_sess_<id:1>']);
    expect(n1.normalized.events[0]!.payload).toEqual({ eventType: 'stream_start', sessionId: 'sess_<id:1>', timestamp: '<ts>' });
  });

  it('a B take with a different id at the same slot binds its own value; a FK that points elsewhere stays visible', () => {
    const a1 = take('A1', run1, id1, 1_762_300_000_000, '/tmp/opencode/x5-AAAAAA');
    const a2 = take('A2', run2, id2, 1_762_300_000_500, '/tmp/opencode/x5-BBBBBB');
    const rules = candidateRules(a1, a2).candidates;
    const id3 = '33333333-3333-4333-8333-333333333333', id4 = '44444444-4444-4444-8444-444444444444';
    const b = take('A1', 'c'.repeat(32), id3, 1_762_300_009_000, '/tmp/opencode/x5-CCCCCC');
    (b.events[2]!.payload as { sessionId: string }).sessionId = `sess_${id4}`; // wrong cross reference
    b.events[2]!.payloadJson = b.events[2]!.payloadJson!.replace(id3, id4);
    const { normalized, conflicts } = applyRules(b, rules);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(JSON.stringify(normalized)).toContain(id4);
  });

  it('the runner-injected LLM origin is one record-wide rule; text around it is still compared', () => {
    const withOrigin = (label: string, origin: string, path: string) => {
      const r = new StreamRecorder({ scenario: 'o', side: 'A', take: label });
      pushSynthetic(r, 'chat_v2_llm_request_body', { url: `${origin}${path}` });
      return { ...r.finish(), llmOrigin: origin };
    };
    const a1 = withOrigin('A1', 'http://127.0.0.1:40001', '/s/success.answer/v1/chat/completions');
    const a2 = withOrigin('A2', 'http://127.0.0.1:40002', '/s/success.answer/v1/chat/completions');
    const report = candidateRules(a1, a2);
    expect(report.verdict).toBe('candidates-only');
    expect(report.candidates).toEqual([expect.objectContaining({ kind: 'llm-origin', pointer: '/llmOrigin', c2: 'pending' })]);
    expect(applyRules(a1, report.candidates).normalized.events[0]!.payload).toEqual({ url: '${llm.origin}/s/success.answer/v1/chat/completions' });
    const wrongPath = withOrigin('A2', 'http://127.0.0.1:40002', '/s/other/v1/chat/completions');
    expect(candidateRules(a1, wrongPath).unrepeatable.map(u => u.jsonPath)).toEqual(['$.events[0].payload.url']);
  });

  it('never normalises event count, error text, null vs missing, or durations: they are unrepeatable', () => {
    const a1 = take('A1', run1, id1, 1_762_300_000_000, '/tmp/x', r => pushSynthetic(r, 'chat_v2_event_x', { type: 'content', phase: 'error', error: 'boom', durationMs: 5, usage: null }));
    const a2 = take('A2', run1, id1, 1_762_300_000_000, '/tmp/x', r => pushSynthetic(r, 'chat_v2_event_x', { type: 'content', phase: 'error', error: 'bang', durationMs: 6 }));
    const report = candidateRules(a1, a2);
    expect(report.verdict).toBe('unrepeatable');
    expect(report.unrepeatable.map(u => [u.jsonPath, u.reason.split(' ')[0]])).toEqual([
      ['$.events[2].payload.durationMs', 'number'],
      ['$.events[2].payload.error', 'text'],
      ['$.events[2].payload.usage', 'key'],
    ]);
    const a3 = take('A2', run1, id1, 1_762_300_000_000, '/tmp/x', r => pushSynthetic(r, 'extra', {}));
    expect(candidateRules(take('A1', run1, id1, 1_762_300_000_000, '/tmp/x'), a3).unrepeatable)
      .toEqual(expect.arrayContaining([expect.objectContaining({ jsonPath: '$.events.length', a1: 3, a2: 4 })]));
  });
});
