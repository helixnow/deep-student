import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECTIVE_PREFIX, directiveAnswer } from '../../../plugins/llm-providers/src/replay/directive.ts';
import { startLlmService, type LlmService, type RawResponse } from './llm-service.ts';

const services: LlmService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); });
async function service() { const s = await startLlmService(); services.push(s); return s; }

async function post(url: string, payload: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
}

/** B's chat pipeline wraps the user text (chat-pipeline user_query + injected_context). */
const wrapped = (content: string) => `<user_query>\n${content}\n</user_query>\n\n<injected_context>\n<runtime_facts>\nos: x\n</runtime_facts>\n</injected_context>`;
const directive = (value: unknown) => `${DIRECTIVE_PREFIX}${JSON.stringify(value)}`;
type Call = { id: string; name: string; arguments: unknown };
const assistantCalls = (calls: Call[]) => ({ role: 'assistant', content: null, tool_calls: calls.map(call =>
  ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
const toolResults = (calls: Call[]) => calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' }));

const two = { v: 1, rounds: [[{ id: 'call_a', name: 'builtin-template_get', arguments: { templateId: 'tpl-1' } }],
  [{ id: 'call_b', name: 'builtin-x', arguments: [1, 'two'] }, { id: 'call_c', name: 'builtin-y', arguments: null }]], final: 'W0_DONE' };

describe('WAVE0 w0.directive rule', () => {
  it('rounds follow the assistant tool_calls answered after the directive message, then the final answer', () => {
    const user = { role: 'user', content: wrapped(directive(two)) };
    expect(directiveAnswer({ messages: [{ role: 'system', content: 's' }, user] })).toEqual({ ok: true, index: 0,
      step: { kind: 'tools', calls: [{ id: 'call_a', name: 'builtin-template_get', arguments: '{"templateId":"tpl-1"}' }] } });
    const after1 = [user, assistantCalls(two.rounds[0]!), ...toolResults(two.rounds[0]!)];
    expect(directiveAnswer({ messages: after1 })).toMatchObject({ ok: true, index: 1,
      step: { kind: 'tools', calls: [{ id: 'call_b', arguments: '[1,"two"]' }, { id: 'call_c', arguments: 'null' }] } });
    const after2 = [...after1, assistantCalls(two.rounds[1]!), ...toolResults(two.rounds[1]!)];
    expect(directiveAnswer({ messages: after2 })).toEqual({ ok: true, index: 2, step: { kind: 'final', content: 'W0_DONE' } });
    expect(directiveAnswer({ messages: [...after2, assistantCalls(two.rounds[1]!)] })).toMatchObject({ ok: false, index: 3, outcome: 'unscripted-round', status: 409 });
  });

  it('a later send in the same session answers its own directive; text parts are concatenated', () => {
    const first = { v: 1, rounds: [], final: 'first' };
    const history = [{ role: 'user', content: directive(first) }, { role: 'assistant', content: 'first' }];
    const second = { role: 'user', content: [{ type: 'text', text: '<user_query>\nW0_DIRECTIVE {"v":1,"rounds":[],' }, { type: 'image_url', image_url: { url: 'x' } },
      { type: 'text', text: '"final":"second"}\n</user_query>' }] };
    expect(directiveAnswer({ messages: [...history, second] })).toEqual({ ok: true, index: 0, step: { kind: 'final', content: 'second' } });
  });

  it('arguments keep the digits the recorder wrote (no float re-spelling)', () => {
    const content = `${DIRECTIVE_PREFIX}{"v":1,"rounds":[[{"id":"c","name":"n","arguments":{"version":1.0,"big":12345678901234567890,"e":1e3,"s":"} ]"}}]],"final":"f"}`;
    expect(directiveAnswer({ messages: [{ role: 'user', content }] })).toMatchObject({ ok: true,
      step: { calls: [{ arguments: '{"version":1.0,"big":12345678901234567890,"e":1e3,"s":"} ]"}' }] } });
  });

  it('never guesses: missing, duplicated or malformed directives are explicit 400s', () => {
    const answer = (content: unknown) => directiveAnswer({ messages: [{ role: 'user', content }] });
    expect(directiveAnswer({ messages: [{ role: 'assistant', content: directive(two) }] })).toMatchObject({ outcome: 'no-directive', status: 400 });
    expect(directiveAnswer(null)).toMatchObject({ outcome: 'no-directive' });
    expect(answer(`${directive(two)} ${directive(two)}`)).toMatchObject({ outcome: 'ambiguous-directive', status: 400 });
    const bad = [
      `${DIRECTIVE_PREFIX} {"v":1,"rounds":[],"final":"f"}`,
      `${DIRECTIVE_PREFIX}{"v":1,"rounds":[],"final":"f"`,
      `${DIRECTIVE_PREFIX}{"v":1,"rounds":[],"final":"f",}`,
      directive({ v: 2, rounds: [], final: 'f' }),
      directive({ v: 1, rounds: [], final: 'f', extra: true }),
      directive({ v: 1, rounds: [[]], final: 'f' }),
      directive({ v: 1, rounds: [[{ id: '', name: 'n', arguments: {} }]], final: 'f' }),
      directive({ v: 1, rounds: [[{ id: 'c', name: 'n' }]], final: 'f' }),
      directive({ v: 1, rounds: [], final: 3 }),
    ];
    for (const content of bad) expect(answer(content), content).toMatchObject({ ok: false, outcome: 'bad-directive', status: 400 });
  });

  it('serves SSE rounds (tool_calls index per call) and logs failures as HTTP errors', async () => {
    const s = await service();
    const url = `${s.baseUrl('w0.directive')}/chat/completions`;
    const user = { role: 'user', content: wrapped(directive(two)) };
    const round1 = await post(url, { model: 'w0-chatanki-model', stream: true, messages: [user, assistantCalls(two.rounds[0]!), ...toolResults(two.rounds[0]!)] });
    expect(round1.headers['content-type']).toBe('text/event-stream');
    expect(round1.headers.date).toBeUndefined();
    expect(round1.text.split('\n\n').filter(Boolean)).toEqual([
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"w0-chatanki-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"builtin-x","arguments":"[1,\\"two\\"]"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"w0-chatanki-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_c","type":"function","function":{"name":"builtin-y","arguments":"null"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"w0-chatanki-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"id":"chatcmpl-x5-fixed","object":"chat.completion.chunk","created":1700000000,"model":"w0-chatanki-model","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}',
      'data: [DONE]',
    ]);
    const folded = await post(url, { model: 'm', stream: false, messages: [user] });
    expect(JSON.parse(folded.text).choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'builtin-template_get', arguments: '{"templateId":"tpl-1"}' } }]);
    const missing = await post(url, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect([missing.status, JSON.parse(missing.text).error.message]).toEqual([400, 'x5 llm service: w0.directive: no user message contains "W0_DIRECTIVE "']);
    expect(s.requests.map(r => [r.round, r.stream, r.outcome, r.status, r.end])).toEqual([
      [1, true, 'served', 200, 'done'], [0, false, 'served', 200, 'done'], [null, true, 'no-directive', 400, 'http-error']]);
  });
});

const CHATANKI = 'host/plugins/chatanki/equivalence';
interface Step { cmd: string; args: Record<string, any> }
interface Scenario { id: string; llm?: string; steps: Step[] }
const suites = readdirSync(CHATANKI).filter(name => name.endsWith('.json') && !name.endsWith('.provider.json') && !name.endsWith('.sidecar.json')).sort()
  .map(name => ({ name, scenarios: (JSON.parse(readFileSync(join(CHATANKI, name), 'utf8')) as { scenarios: Scenario[] }).scenarios,
    provider: JSON.parse(readFileSync(join(CHATANKI, name.replace(/\.json$/, '.provider.json')), 'utf8')) as Record<string, RawResponse[] | string> }));
const sends = (scenario: Scenario) => scenario.steps.filter(step => step.cmd === 'chat_v2_send_message');

describe('WAVE0 w0.directive against the chatanki corpus', () => {
  it('reproduces every static W21 sidecar answer byte for byte from the same directives (A-plain and B-wrapped requests)', async () => {
    const s = await service();
    const url = `${s.baseUrl('w0.directive')}/chat/completions`;
    let compared = 0;
    for (const suite of suites) {
      for (const scenario of suite.scenarios) {
        const expected = suite.provider[scenario.id];
        if (!Array.isArray(expected)) continue;
        const models = new Map<string, string>();
        for (const step of scenario.steps) if (step.cmd === 'save_api_configurations') for (const config of step.args.configs) models.set(config.id, config.model);
        for (const wrap of [(text: string) => text, wrapped]) {
          let cursor = 0;
          const history: unknown[] = [];
          for (const send of sends(scenario)) {
            const { content, options } = send.args.request;
            const parsed = JSON.parse(content.slice(DIRECTIVE_PREFIX.length)) as { rounds: Call[][]; final: string };
            const turn: unknown[] = [{ role: 'user', content: wrap(content) }];
            for (let k = 0; k <= parsed.rounds.length; k++) {
              const served = await post(url, { model: models.get(options.modelId), stream: true, messages: [...history, ...turn] });
              const want = expected[cursor++]!;
              expect([served.status, served.headers['content-type'], served.text], `${scenario.id} response ${cursor - 1}`)
                .toEqual([want.status, want.headers['content-type'], want.chunks.join('')]);
              if (k < parsed.rounds.length) turn.push(assistantCalls(parsed.rounds[k]!), ...toolResults(parsed.rounds[k]!));
            }
            // Session metadata answer of an untitled session: not a directive round.
            if (expected[cursor]?.headers['content-type'] === 'application/json') cursor++;
            history.push(...turn, { role: 'assistant', content: parsed.final });
          }
          expect(cursor, scenario.id).toBe(expected.length);
        }
        compared++;
      }
    }
    expect(compared).toBe(suites.reduce((sum, suite) => sum + Object.keys(suite.provider).filter(key => key !== 'note').length, 0));
    expect(compared).toBeGreaterThan(0);
  }, 120_000);

  it('every dynamic scenario decodes once its run-time references are substituted, and only creates titled sessions', () => {
    const dynamic = suites.flatMap(suite => suite.scenarios.filter(scenario => scenario.llm === 'w0.directive'));
    expect(dynamic.length).toBeGreaterThan(0);
    for (const scenario of dynamic) {
      // Untitled sessions would make a session-metadata call that this script does not answer.
      for (const step of scenario.steps.filter(step => step.cmd === 'chat_v2_create_session')) expect(step.args.title, scenario.id).toEqual(expect.any(String));
      for (const send of sends(scenario)) {
        const content = (send.args.request.content as string).replaceAll(/\$\{[^}]+\}/g, 'w0-ref');
        expect(directiveAnswer({ messages: [{ role: 'user', content: wrapped(content) }] }), scenario.id).toMatchObject({ ok: true });
      }
    }
  });
});
