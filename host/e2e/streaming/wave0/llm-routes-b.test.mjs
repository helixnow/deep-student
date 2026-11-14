// Real B Host (g3-run-b runScenarioB: host/kernel/main.ts, desktop profile) against llm-service.ts
// on /embeddings, w0.directive and /audio/transcriptions. Tool test of the service, not A/B parity.
// Run: node --test host/e2e/streaming/wave0/llm-routes-b.test.mjs (wrapped by llm-routes-b.test.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseExact, stringifyExact } from '../../../../scripts/electron-migration/record/json.mjs';
import { runScenarioB } from '../../../../scripts/electron-migration/record/g3-run-b.mjs';
import { embeddingResponse } from '../../../plugins/llm-providers/src/replay/embeddings.ts';
import { directiveAnswer } from '../../../plugins/llm-providers/src/replay/directive.ts';

const RAG = 'host/plugins/vfs-repos/equivalence/rag-multimodal.json';
const TEMPLATES = 'host/plugins/chatanki/equivalence/templates.json';
const TEMPLATES_SIDECAR = 'host/plugins/chatanki/equivalence/harness.sidecar.json';
const VOICE = 'host/plugins/media/equivalence/voice-input.json';

let prepared;
after(() => prepared && rm(prepared.root, { recursive: true, force: true }));
async function prepare() {
  if (prepared) return prepared;
  // The Host's TMPDIR is inside the snapshotted run directory; its compile-cache flush (5 s after
  // ready) would race the per-step database walk.
  process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  const root = await mkdtemp('/tmp/opencode/w25-llm-routes-');
  const { createSeed } = await import('../../data-compat/__fixtures__/scenario-seeds.ts');
  const catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  prepared = { root, catalog };
  return prepared;
}

async function runB(scenarioFile, scenario) {
  const { root, catalog } = await prepare();
  const directory = join(root, scenario.id, 'run');
  await mkdir(directory, { recursive: true });
  return runScenarioB(scenario, { scenarioFile, catalog, directory });
}

async function scenarioFrom(file, id) {
  const scenario = parseExact(await readFile(file, 'utf8')).scenarios.find(item => item.id === id);
  assert.ok(scenario, `${file}: ${id}`);
  return scenario;
}

/**
 * chat_v2_send_message is fire-and-forget; the wait for the stream's terminal event is in the suite's
 * sidecar (chatanki equivalence README), not in the v0 file. Without it the capture after the send is
 * bounded by quiesce's stream wait (g3-quiet.mjs QUIET.streamMs) and misses round 1 on a loaded machine.
 */
async function withSidecarWaits(sidecarFile, scenario) {
  const binding = JSON.parse(await readFile(sidecarFile, 'utf8')).scenarios[scenario.id];
  assert.ok(binding, `${sidecarFile}: ${scenario.id}`);
  assert.equal(binding.llm, scenario.llm);
  const steps = scenario.steps.map(step => ({ ...step }));
  for (const { step, ...waits } of binding.steps) {
    assert.ok(steps[step], `${sidecarFile}: ${scenario.id} step ${step}`);
    Object.assign(steps[step], waits);
  }
  return { ...scenario, steps };
}

const results = trace => trace.calls.map(call => [call.command, call.outcome.kind]);

test('vfs-repos /embeddings: B indexes and searches a note through the scripted vectors', async () => {
  const scenario = await scenarioFrom(RAG, 'vfs.rag.search.indexed_note_with_mock_embedding');
  const trace = await runB(RAG, scenario);
  assert.deepEqual(results(trace).filter(([, kind]) => kind !== 'result'), []);
  const bound = Number(scenario.steps.find(step => step.cmd === 'vfs_create_dimension').args.dimension);
  assert.ok(trace.llmRequests.length > 0);
  for (const request of trace.llmRequests) {
    assert.equal(request.path, `/s/${scenario.id}/v1/embeddings`);
    assert.deepEqual([request.outcome, request.status, request.end], ['served', 200, 'done']);
    assert.equal(request.body.model, 'w0-text-embedding');
    const answer = embeddingResponse(request.body);
    assert.equal(answer.ok, true);
    for (const item of answer.json.data) assert.equal(item.embedding.length, bound);
  }
  const note = JSON.parse(trace.calls.find(call => call.command === 'dstu_create').outcome.raw);
  assert.equal(trace.calls.find(call => call.command === 'vfs_reindex_resource').outcome.raw, '1');
  const hits = trace.calls.filter(call => call.command === 'vfs_rag_search')
    .map(call => JSON.parse(call.outcome.raw).results.some(hit => hit.resourceId === note.resourceId));
  assert.ok(hits.some(Boolean), 'at least one search finds the indexed note');
});

test('chatanki w0.directive: the run-time template id reaches the tool call; the final answer closes the stream', async () => {
  const scenario = await withSidecarWaits(TEMPLATES_SIDECAR, await scenarioFrom(TEMPLATES, 'chatanki.template.get.custom'));
  assert.equal(scenario.llm, 'w0.directive');
  assert.deepEqual(scenario.steps.at(-1).waitAfter, { event: 'stream_complete|stream_error|stream_cancelled',
    channelPrefix: 'chat_v2_session_', messageId: scenario.steps.at(-1).args.request.assistantMessageId });
  const trace = await runB(TEMPLATES, scenario);
  assert.deepEqual(results(trace).filter(([, kind]) => kind !== 'result'), []);
  const templateId = JSON.parse(trace.calls.find(call => call.command === 'create_custom_template').outcome.raw);
  assert.deepEqual(trace.llmRequests.map(r => [r.path, r.round, r.outcome, r.status, r.end]), [
    ['/s/w0.directive/v1/chat/completions', 0, 'served', 200, 'done'],
    ['/s/w0.directive/v1/chat/completions', 1, 'served', 200, 'done']]);
  const first = directiveAnswer(trace.llmRequests[0].body);
  assert.equal(first.ok && first.step.kind, 'tools');
  const [call] = first.step.calls;
  assert.equal(JSON.parse(call.arguments).templateId, templateId);
  // B sends the scripted call back as the assistant turn of round 1.
  const echoed = trace.llmRequests[1].body.messages.filter(m => m.role === 'assistant' && m.tool_calls?.length).at(-1).tool_calls[0];
  assert.deepEqual([echoed.id, echoed.function.name, echoed.function.arguments], [call.id, call.name, call.arguments]);
  const last = directiveAnswer(trace.llmRequests[1].body);
  assert.equal(last.ok && last.step.kind, 'final');
  assert.deepEqual(trace.calls.at(-1).capture.quiet.streamsOpen, []);
  const events = trace.calls.at(-1).capture.events.map(event => JSON.parse(event.payloadRaw));
  assert.ok(events.some(e => e.type === 'content' && e.phase === 'chunk' && e.chunk === last.step.content));
  assert.ok(events.some(e => e.eventType === 'stream_complete'));
});

/** voice.transcribe.success_answer with a non-qwen3-asr model, so B speaks multipart /audio/transcriptions. */
async function transcriptionSuite(root) {
  const base = await scenarioFrom(VOICE, 'voice.transcribe.success_answer');
  const configure = base.steps.slice(0, 2).map(step => structuredClone(step));
  configure[0].args.configs[0].model = 'FunAudioLLM/SenseVoiceSmall';
  const transcribe = structuredClone(base.steps[2]);
  const scenario = (id, llm) => ({ ...structuredClone(base), id, llm, steps: [...structuredClone(configure), structuredClone(transcribe)] });
  const file = join(root, 'transcriptions.json');
  const suite = { domain: 'w25-llm-routes', commands: ['voice_input_transcribe'],
    scenarios: [scenario('w25.transcribe.multipart_answer', 'success.answer'), scenario('w25.transcribe.multipart_500', 'error.http-500')] };
  await writeFile(file, stringifyExact(suite, 2));
  return { file, suite, audio: Buffer.from(transcribe.args.request.audioBase64, 'base64') };
}

test('/audio/transcriptions: B posts multipart and gets the script text; error.http-500 surfaces as a transcription failure', async () => {
  const { root } = await prepare();
  const { file, suite, audio } = await transcriptionSuite(root);
  const [answer, failure] = suite.scenarios;

  const served = await runB(file, answer);
  assert.deepEqual(results(served), [['save_api_configurations', 'result'], ['save_model_assignments', 'result'], ['voice_input_transcribe', 'result']]);
  assert.equal(JSON.parse(served.calls[2].outcome.raw).text, '固定回答');
  assert.equal(served.llmRequests.length, 1);
  const [request] = served.llmRequests;
  assert.deepEqual([request.path, request.round, request.outcome, request.status, request.end],
    ['/s/success.answer/v1/audio/transcriptions', 0, 'served', 200, 'done']);
  const parts = Object.fromEntries(request.body.parts.map(part => [part.name, part]));
  assert.equal(parts.model.value, 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(parts.file.sha256, createHash('sha256').update(audio).digest('hex'));
  assert.equal(parts.file.size, audio.length);

  const failed = await runB(file, failure);
  assert.equal(failed.calls[2].outcome.kind, 'error');
  assert.match(failed.calls[2].outcome.raw, /x5 deterministic upstream failure/);
  assert.deepEqual(failed.llmRequests.map(r => [r.path, r.outcome, r.status, r.end]),
    [['/s/error.http-500/v1/audio/transcriptions', 'served', 500, 'http-error']]);
});
