/** B transport/consumer evidence only. No A oracle, DB parity or verdict expected-output fixture. */
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { streamingHost } from '../__fixtures__/host.ts';
import qbank from '../../../plugins/qbank/index.ts';
import review from '../../../plugins/review/index.ts';
import { defaultSingleShotOptions } from '../../../plugins/llm/api.ts';
import { providerScripts, startLlmService } from './llm-service.ts';
import { hostDriver, runScenario, type Scenario } from './runner.ts';

const source: unknown = JSON.parse(readFileSync(new URL('./__fixtures__/ai-grading-scripted.provider.json', import.meta.url), 'utf8'));
const scripts = providerScripts(source);
const prefix = 'qbank.ai_grade.scripted.';
// ApiConfig fields from ee55bf25e: .../pending-provider/ai-grading-scripted.json.
const config = (baseUrl: string) => ({ id: 'wp052-mock', name: 'WP052 wp052-mock', apiKey: 'sk-wp052-local', baseUrl,
  model: 'wp052-model', isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
  enabled: true, modelAdapter: 'general', maxOutputTokens: 1024, temperature: 0 });

// These are transport text expectations extracted from the external input, NOT grading results.
function responseText(chunks: string[]): string {
  return chunks.filter(chunk => chunk !== 'data: [DONE]\n\n').map(chunk => {
    const value = JSON.parse(chunk.slice('data: '.length));
    return value.choices[0].delta.content;
  }).join('');
}

it('B public L02 client consumes all 11 L14 responses through real L01/HTTP, preserving errors', async () => {
  const llm = await startLlmService({ extraScripts: scripts });
  const fixture = await streamingHost('answer', { realProviders: true });
  const observations: unknown[] = [];
  try {
    for (const [id, script] of Object.entries(scripts)) {
      await fixture.host.invoke('save_api_configurations', { configs: [config(llm.baseUrl(id))] });
      const selected = (await fixture.host.ctx.llm.getApiConfigs())[0]!;
      for (const expected of script.responses) {
        const deltas: string[] = [];
        // Same public transport used by qbank runSingleShotGrading; external response is the only substitution.
        const outcome = await fixture.host.ctx.llmStreaming.singleShotCompletion(selected,
          { model: selected.model, stream: true, messages: [{ role: 'system', content: 'Teacher' }, { role: 'user', content: 'Grade answer' }],
            temperature: 0.3, max_tokens: 1024 }, 'sk-wp052-local', 'wp123-transport', '评判请求构建失败',
          { ...defaultSingleShotOptions('WP-123'), maxRetries: 0 }, delta => { deltas.push(delta); return true; })
          .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        observations.push({ id, deltas, outcome });
        if (expected.status === 500) {
          expect(outcome.ok).toBe(false);
          if (!outcome.ok) expect(outcome.error).toMatchObject({ details: { status: 500, body: expected.chunks.join('') } });
        } else {
          expect(outcome.ok).toBe(true);
          if (outcome.ok) expect(outcome.value).toMatchObject({ content: responseText(expected.chunks), mode: 'stream', attempts: 1 });
          expect(deltas.join('')).toBe(responseText(expected.chunks));
        }
        expect(llm.requests.at(-1)).toMatchObject({ scriptId: id, status: expected.status, raw: { chunks: expected.chunks } });
      }
    }
    expect(fixture.fake.created).toEqual([]);
    expect(llm.requests).toHaveLength(11);
    expect(await llm.whenIdle(1000)).toBe(true);
  } finally {
    const dir = mkdtempSync('/tmp/opencode/x5-wp123-b-client-');
    writeFileSync(`${dir}/raw.json`, JSON.stringify({ observations, requests: llm.requests, events: fixture.host.events }, null, 2));
    console.log(`WP-123 B client raw: ${dir}/raw.json`);
    await fixture.dispose();
    await llm.stop();
  }
}, 60_000);

it('B qbank public command uses L14 provider.url through the existing wave0 runner', async () => {
  const llm = await startLlmService({ extraScripts: scripts });
  const fixture = await streamingHost('answer', { realProviders: true });
  let record: unknown;
  try {
    await fixture.host.install(review, qbank);
    // Exact first five steps of L14 correct_verdict (no prewritten business output).
    const scenario: Scenario = { id: `${prefix}correct_verdict`, llm: `${prefix}correct_verdict`, seed: 'empty', steps: [
      { cmd: 'dstu_create', args: { path: '/', options: { type: 'exam', name: '新题目集', metadata: { status: 'empty', pageCount: 0, questionCount: 0 } } } },
      { cmd: 'qbank_create_question', args: { params: { exam_id: '${0.id}', content: '简述光合作用的能量转化。', question_type: 'short_answer',
        options: null, answer: '光合作用把光能转化为化学能。', structured_data: null, explanation: '7 只能被 1 和自身整除。', difficulty: 'easy',
        tags: ['生物'], question_label: null, card_id: null, source_type: 'manual', source_ref: null, images: null, parent_id: null } } },
      { cmd: 'qbank_submit_answer', args: { request: { question_id: '${1.id}', user_answer: '把光能变成化学能', client_request_id: 'ai-sub-1' } } },
      { cmd: 'save_api_configurations', args: { configs: [config('${provider.url}')] } },
      { cmd: 'qbank_ai_grade', args: { request: { question_id: '${1.id}', submission_id: '${2.submission_id}', stream_session_id: 'wp052ok', mode: 'grade', model_config_id: 'wp052-mock' } } },
    ], normalize: [] };
    const result = await runScenario(scenario, hostDriver(fixture.host), { side: 'B', take: 'WP-123-consumer', llm });
    record = result;
    expect(result.steps.map(step => [step.cmd, step.ok])).toEqual(scenario.steps.map(step => [step.cmd, true]));
    expect(result.steps[3]!.args).toEqual({ configs: [config(llm.baseUrl(scenario.id))] });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toMatchObject({ scriptId: scenario.id, stream: true, status: 200,
      body: { model: 'wp052-model', temperature: 0.3, max_tokens: 1024 }, raw: { chunks: scripts[scenario.id]!.responses[0]!.chunks } });
    const data = fixture.host.eventsNamed('qbank_grading_stream_wp052ok').filter((v): v is { type: 'data'; chunk: string } =>
      v !== null && typeof v === 'object' && 'type' in v && v.type === 'data' && 'chunk' in v && typeof v.chunk === 'string');
    expect(data.map(v => v.chunk).join('')).toBe(responseText(scripts[scenario.id]!.responses[0]!.chunks));
    expect(result.events).toHaveLength(fixture.host.events.length);
    expect(result.llmIdle).toBe(true);
    expect(await fixture.host.ctx.llm.consumePendingCancel('qbank_grading_stream_wp052ok')).toBe(false);
    expect(fixture.fake.created).toEqual([]);
  } finally {
    const dir = mkdtempSync('/tmp/opencode/x5-wp123-qbank-');
    writeFileSync(`${dir}/raw.json`, JSON.stringify({ record, requests: llm.requests, events: fixture.host.events }, null, 2));
    console.log(`WP-123 B qbank raw: ${dir}/raw.json`);
    await fixture.dispose();
    await llm.stop();
  }
}, 60_000);
