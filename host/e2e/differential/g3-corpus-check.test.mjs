// Corpus check: problems in the scenario corpus itself that would waste a server round (both
// sides fail the same way), and the runners' up-front `unsupported` for inputs no G3 service
// provides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCorpus, loadRegistries, rustCommands } from '../../../scripts/electron-migration/record/g3-corpus-check.mjs';
import { serviceGap } from '../../../scripts/electron-migration/record/g3-services.mjs';
import { unsupported as unsupportedA } from '../../../scripts/electron-migration/record/g3-run-a.mjs';
import { unsupported as unsupportedB } from '../../../scripts/electron-migration/record/g3-run-b.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const REGISTRY = { seeds: ['empty'], llmScripts: ['success.answer'], embeddingModels: ['emb'], cloudSeeds: ['empty'], rustCommands: new Set(['a', 'b']) };
const model = (name, isEmbedding, url = '${llm.baseUrl}') => ({ id: name, baseUrl: url, model: name, isEmbedding });
const scenario = (id, steps, extra = {}) => ({ id, seed: 'empty', steps, capture: { events: false, db: [] }, normalize: [], ...extra });

test('corpus check: seeds, step references, bindings, LLM scripts, cloud seeds, A commands, date literals', async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/w13-corpus-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'host/plugins/x/equivalence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'x.json'), JSON.stringify({ scenarios: [
    scenario('x.ok', [{ cmd: 'a', args: { id: 'n' } }, { cmd: 'b', args: { id: '${0.id}', url: '${llm.baseUrl}' } }], { llm: 'success.answer' }),
    scenario('x.seed', [{ cmd: 'a' }], { seed: 'nope' }),
    scenario('x.forward', [{ cmd: 'a', args: { id: '${0}' } }]),
    scenario('x.error-ref', [{ cmd: 'a', expect: 'error' }, { cmd: 'b', args: { id: '${0.id}' } }]),
    scenario('x.mcp', [{ cmd: 'a', args: { c: '${mcp.success.command}', s: 'x ${fixture.unixNow} y' } }]),
    scenario('x.llm', [{ cmd: 'a', args: { url: '${provider.url}' } }]),
    scenario('x.sidecar', [{ cmd: 'a', args: { url: '${provider.url}' } }]),
    scenario('x.cloud', [{ cmd: 'a', args: { e: '${cloud.webdav.endpoint}' } }], { cloud: { seed: 'missing' } }),
    scenario('x.cmd', [{ cmd: 'zzz' }, { cmd: 'plugin:clipboard-manager|read_text' }]),
    scenario('x.date', [{ cmd: 'a', args: { due: '2026-11-07T00:00:00Z' } }]),
    scenario('x.ok', [{ cmd: 'a' }]),
    // Embedding-only model configs reach /embeddings, which answers any script: the model is what must exist.
    scenario('x.embed', [{ cmd: 'a', args: { configs: [model('emb', true), model('emb', true, '${provider.url}')] } }]),
    scenario('x.embed-unknown', [{ cmd: 'a', args: { configs: [model('emb', true), model('nope', true)] } }]),
    scenario('x.embed-and-chat', [{ cmd: 'a', args: { configs: [model('emb', true)] } }, { cmd: 'b', args: { configs: [model('chat', false)] } }]),
    scenario('x.embed-and-url', [{ cmd: 'a', args: { configs: [model('emb', true)], url: '${llm.baseUrl}' } }]),
    scenario('x.embed-named', [{ cmd: 'a', args: { configs: [model('emb', true)] } }], { llm: 'missing.script' }),
    scenario('x.wait', [{ cmd: 'a', waitAfter: { channel: 'c' } }, { cmd: 'b', waitBefore: { channel: 'c' } }]),
    scenario('x.wait-events', [{ cmd: 'a', waitAfter: { channel: 'c' } }], { capture: { events: true, db: [] } }),
  ] }));
  writeFileSync(join(dir, 'x.provider.json'), JSON.stringify({ note: 'n', 'x.sidecar': [{ status: 200, headers: {}, chunks: [] }] }));
  const result = await checkCorpus(root, REGISTRY);
  const found = result.findings.map(item => [item.kind, item.id]).sort((a, b) => `${a}`.localeCompare(`${b}`));
  assert.deepEqual(found, [
    ['a-unregistered-command', 'x.cmd'],
    ['bad-reference', 'x.mcp'], ['bad-reference', 'x.mcp'],
    ['date-literal', 'x.date'],
    ['duplicate-id', 'x.ok'],
    ['error-step-reference', 'x.error-ref'],
    ['forward-reference', 'x.forward'],
    ['llm-script-missing', 'x.embed-and-chat'], ['llm-script-missing', 'x.embed-and-url'], ['llm-script-missing', 'x.embed-named'],
    ['llm-script-missing', 'x.llm'],
    ['unknown-cloud-seed', 'x.cloud'],
    ['unknown-embedding-model', 'x.embed-unknown'],
    ['unknown-seed', 'x.seed'],
    ['wait-without-events', 'x.wait'], ['wait-without-events', 'x.wait'],
  ]);
  assert.equal(result.findings.find(item => item.kind === 'unknown-embedding-model').detail, 'model nope');
  assert.equal(result.scenarios, 18);
  assert.equal(result.blockedScenarios, 7, 'seed, forward, error-ref, mcp, cloud, duplicate, wait');
});

test('corpus check: ${wait.N…} must name an earlier step with a waitAfter', async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/w13-corpus-wait-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'host/plugins/x/equivalence');
  mkdirSync(dir, { recursive: true });
  const events = { capture: { events: true, db: [] } };
  writeFileSync(join(dir, 'w.json'), JSON.stringify({ scenarios: [
    scenario('w.ok', [{ cmd: 'a', waitAfter: { channel: 'c' } }, { cmd: 'b', args: { id: '${wait.0.request_id}', path: 'x/${wait.0.request_id}' } }], events),
    scenario('w.forward', [{ cmd: 'a', args: { id: '${wait.0.x}' }, waitAfter: { channel: 'c' } }], events),
    scenario('w.no-wait', [{ cmd: 'a' }, { cmd: 'b', args: { id: '${wait.0.x}' } }], events),
  ] }));
  const result = await checkCorpus(root, REGISTRY);
  const found = result.findings.map(item => [item.kind, item.id]).sort((a, b) => `${a}`.localeCompare(`${b}`));
  assert.deepEqual(found, [['bad-reference', 'w.no-wait'], ['forward-reference', 'w.forward'], ['invalid-scenario', 'w.forward'], ['invalid-scenario', 'w.no-wait']]);
  assert.equal(result.findings.find(item => item.kind === 'bad-reference').detail, '${wait.0.x}: step 0 has no waitAfter');
  assert.equal(result.blockedScenarios, 2);
});

test('corpus check: A commands are read from every generate_handler! of lib.rs', t => {
  const root = mkdtempSync('/tmp/opencode/w13-corpus-rs-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src-tauri/src'), { recursive: true });
  writeFileSync(join(root, 'src-tauri/src/lib.rs'), [
    'tauri::generate_handler![', '  crate::cmd::a::first,', '  // crate::cmd::b::commented,', '  #[cfg(feature = "x")]', '  second,', '  crate::vfs::todo_handlers::third', ']',
    'other();', 'tauri::generate_handler![fourth, mod_x::fifth]',
  ].join('\n'));
  assert.deepEqual([...rustCommands(root)].sort(), ['fifth', 'first', 'fourth', 'second', 'third']);
});

test('corpus check: registries load from the modules the G3 services answer from in this tree', async () => {
  const registry = await loadRegistries(REPO);
  assert.ok(registry.seeds.includes('empty'));
  assert.ok(registry.llmScripts.includes('success.answer'));
  assert.deepEqual([...registry.embeddingModels].sort(), ['w0-text-embedding', 'w0-vl-embedding'], 'the models vfs-repos scenarios configure');
  assert.ok(registry.cloudSeeds.includes('empty'));
  assert.ok(registry.rustCommands.size > 0);
  assert.ok(Object.keys(registry.mcpBindings).length > 0);
  assert.deepEqual(Object.keys(registry.seedBindings), registry.seeds, 'every seed is asked for its ${seed.*} keys');
  assert.equal(registry.seedBindings.empty, null);
});

test('runners skip, as unsupported, scenarios whose bindings no G3 service provides', () => {
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', args: { a: '${0.id}', b: '${llm.baseUrl}', c: '${mock.webdav.endpoint}', d: '${cloud.s3.endpoint}', e: '${provider.url}',
    f: '${mcp.disconnect-on-list.args}', g: '${mcp.url}/mcp/success' } }])), null);
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', args: { a: '${mcp.success.args}', b: 'at ${fixture.unixNow}' } }])),
    'binding namespace ${fixture.…} is not provided by g3-services.mjs');
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', args: { a: '${seed.file.sealedZip}' } }])), 'seed empty provides no ${seed.…} bindings (a-produced-seeds.ts seedBindings)');
  // A wait capture is the run's own value, not a service binding.
  assert.equal(serviceGap(scenario('s', [{ cmd: 'a', waitAfter: { channel: 'c' } }, { cmd: 'b', args: { a: '${wait.0.request_id}', b: 'x ${wait.0.n}' } }])), null);
});

test('runners skip, as unsupported, scenario keys they would silently ignore (scenario-level concurrent)', () => {
  const oauth = JSON.parse(readFileSync(join(REPO, 'host/plugins/mcp/equivalence/pending-runner/mcp-oauth-browser.json'), 'utf8')).scenarios;
  for (const unsupported of [unsupportedA, unsupportedB]) {
    assert.equal(unsupported(scenario('s', [{ cmd: 'a' }, { cmd: 'b' }], { concurrent: [[0, 1]] })), 'scenario uses concurrent');
    assert.equal(unsupported(scenario('s', [{ cmd: 'a', rawBody: 'AA' }])), 'step 0 uses rawBody');
    assert.deepEqual(oauth.map(item => [item.id, unsupported(item)]), [
      ['mcp.pending.oauth.start_success_with_mock_as', null], ['mcp.pending.oauth.start_with_client_id_then_cancel', 'scenario uses concurrent']]);
  }
});

test('corpus check: an MCP protocolVersion is a protocol revision, not a date literal; other dates in the same text still are', async t => {
  const root = mkdtempSync('/tmp/opencode/w13-corpus-proto-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'host/plugins/x/equivalence');
  mkdirSync(dir, { recursive: true });
  const message = params => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
  writeFileSync(join(dir, 'p.json'), JSON.stringify({ scenarios: [
    scenario('p.message', [{ cmd: 'a', args: { message: message({ protocolVersion: '2025-06-18', capabilities: {} }) } }]),
    scenario('p.key', [{ cmd: 'a', args: { config: { protocolVersion: '2024-11-05' } } }]),
    scenario('p.spaced', [{ cmd: 'a', args: { message: '{"protocolVersion" : "2025-03-26"}' } }]),
    scenario('p.message-and-date', [{ cmd: 'a', args: { message: message({ protocolVersion: '2025-06-18', due: '2026-11-07' }) } }]),
    scenario('p.other-key', [{ cmd: 'a', args: { version: '2025-06-18' } }]),
  ] }));
  const result = await checkCorpus(root, REGISTRY);
  assert.deepEqual(result.findings.map(item => [item.kind, item.id]), [['date-literal', 'p.message-and-date'], ['date-literal', 'p.other-key']]);
});
