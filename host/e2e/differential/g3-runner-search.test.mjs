// `${runner.*}` (backup README §5 / §9.4: per-take scratch directory, fixed fixture files, Unix seconds
// read when the step is dispatched) and `${search.*}` (browser README pending-mock: a local SearXNG
// mock), both sides, checked up front (serviceGap, corpus check); and the LLM port as a parameter
// (W28 H-B3) whose default stays the fixed G3 port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeScenario, prepareScenarioRun, runnerBindingKind, usesRunner } from '../../../scripts/electron-migration/record/scenario-v0.mjs';
import { serviceGap, startScenarioServices } from '../../../scripts/electron-migration/record/g3-services.mjs';
import { SEARCH_PORT, SEARXNG_RESPONSES, searchGap, startSearchService } from '../../../scripts/electron-migration/record/g3-search-service.mjs';
import { LLM_PORT } from '../../../scripts/electron-migration/record/g3-wait.mjs';
import { checkCorpus } from '../../../scripts/electron-migration/record/g3-corpus-check.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const scenario = (id, steps, extra = {}) => ({ id, seed: 'empty', steps, capture: { events: false, db: [] }, normalize: [], ...extra });
const tempRoot = (t, prefix) => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync(`/tmp/opencode/${prefix}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const suite = file => JSON.parse(readFileSync(join(REPO, file), 'utf8')).scenarios;

test('${runner.unixNow…} is the Unix second read when the step is dispatched; ±N shifts it; waitAfter reads the same instant', async () => {
  const clock = [1_794_000_000_999, 1_794_000_065_000];
  const invoked = [], waited = [];
  const steps = [
    { cmd: 'c', args: { token: 'AUDIT_CLEANUP_${runner.unixNow}', minus: '${runner.unixNowMinus30}', plus: 'p${runner.unixNowPlus120}' },
      waitAfter: { channel: 'x', payload: { at: '${runner.unixNowMinus120}' } } },
    { cmd: 'c', args: { token: 'AUDIT_CLEANUP_${runner.unixNow}', plus: '${runner.unixNowPlus30}' } },
  ];
  await executeScenario(scenario('s', steps), {
    bindings: { runner: { scratchDir: '/r/scratch' } },
    now: () => clock.shift(),
    eventCount: () => 0,
    async invoke(command, argsRaw) { invoked.push(argsRaw); return { kind: 'result', raw: 'null' }; },
    wait: async spec => { waited.push(spec); return { event: 'x', payloadRaw: '{}' }; },
    capture: async () => ({}),
  });
  assert.deepEqual(invoked, [
    '{"token":"AUDIT_CLEANUP_1794000000","minus":"1793999970","plus":"p1794000120"}',
    '{"token":"AUDIT_CLEANUP_1794000065","plus":"1794000095"}',
  ]);
  assert.deepEqual(waited, [{ channel: 'x', payload: { at: '1793999880' } }]);
  assert.equal(clock.length, 0, 'one clock reading per dispatched step, none for steps without ${runner.unixNow…}');
  for (const key of ['runner.unixNow', 'runner.unixNowMinus30', 'runner.unixNowPlus120', 'runner.scratchDir', 'runner.fixture.notZip']) assert.equal(runnerBindingKind(key), 'string', key);
  for (const key of ['runner.unixNowPlus', 'runner.unixNowMinus030', 'runner.unixnow', 'runner.fixture.nope', 'runner.scratch', 'runner']) assert.equal(runnerBindingKind(key), null, key);
  await assert.rejects(executeScenario(scenario('s', [{ cmd: 'c', args: { a: '${runner.scratchDir}' } }]), {
    bindings: null, eventCount: () => 0, invoke: async () => ({ kind: 'result', raw: 'null' }), wait: async () => null, capture: async () => ({}),
  }), /unbound reference: \$\{runner\.scratchDir\}/);
});

test('prepareScenarioRun: ${runner.scratchDir} is an empty per-take directory and ${runner.fixture.notZip} a fixed file, both under the run root (N-007) outside home and the data directories', async t => {
  const { createSeed } = await import('../data-compat/__fixtures__/scenario-seeds.ts');
  const root = tempRoot(t, 'w13-runner-run-');
  const catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  const reads = scenario('s', [{ cmd: 'a', args: { out: '${runner.scratchDir}/x.zip' } }, { cmd: 'b', args: { zip: '${runner.fixture.notZip}' } }]);
  const runs = {};
  for (const side of ['A1', 'B']) runs[side] = await prepareScenarioRun(reads, { catalog, directory: join(root, side, 'run'), seedBindings: () => null });
  for (const side of ['A1', 'B']) {
    const run = runs[side], runRoot = join(root, side, 'run');
    const { scratchDir, fixture } = run.bindings.runner;
    assert.deepEqual(Object.keys(run.bindings), ['runner']);
    assert.equal(scratchDir, join(runRoot, 'runner', 'scratch'));
    assert.deepEqual(readdirSync(scratchDir), []);
    assert.ok(statSync(scratchDir).isDirectory());
    assert.equal(fixture.notZip, join(runRoot, 'runner', 'fixtures', 'not-a-zip.zip'));
    assert.equal(readFileSync(fixture.notZip, 'latin1'), 'not a zip\n');
    for (const outside of [run.env.HOME, run.seed.dataDir, run.seed.dataLocalDir, run.env.TMPDIR]) {
      for (const path of [scratchDir, fixture.notZip]) assert.ok(relative(outside, path).startsWith('..'), `${path} is not under ${outside}`);
    }
  }
  assert.equal(relative(join(root, 'A1', 'run'), runs.A1.bindings.runner.scratchDir), relative(join(root, 'B', 'run'), runs.B.bindings.runner.scratchDir),
    'same path below each take\'s run root, so N-007 makes A and B args equal');
  const plain = await prepareScenarioRun(scenario('p', [{ cmd: 'a' }]), { catalog, directory: join(root, 'P', 'run') });
  assert.equal(plain.bindings, null);
  assert.deepEqual(readdirSync(join(root, 'P', 'run')).filter(name => name === 'runner'), [], 'a scenario without ${runner.*} gets no runner directory');
  const clockOnly = await prepareScenarioRun(scenario('c', [{ cmd: 'a', args: { t: 'T_${runner.unixNow}' } }]), { catalog, directory: join(root, 'C', 'run') });
  assert.deepEqual(clockOnly.bindings, { runner: { scratchDir: join(root, 'C', 'run', 'runner', 'scratch'), fixture: { notZip: join(root, 'C', 'run', 'runner', 'fixtures', 'not-a-zip.zip') } } });
  assert.equal(usesRunner(reads), true);
  assert.equal(usesRunner(scenario('n', [{ cmd: 'a', args: { note: 'runner.scratchDir' } }])), false);
});

test('SearXNG mock: fixed JSON per scripted response, in order, the last repeating; request log; unknown names are a gap', async t => {
  const service = await startSearchService({ port: 0, searxng: ['success', 'http-500'] });
  t.after(() => service.stop());
  assert.match(service.searxngUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const get = async query => {
    const response = await fetch(`${service.searxngUrl}/search?${query}`, { headers: { 'user-agent': 'web_search_tool/0.1' } });
    return [response.status, response.headers.get('content-type'), await response.text()];
  };
  const first = await get('q=test&format=json&categories=general&language=all&safesearch=0');
  assert.deepEqual(first, [200, 'application/json', JSON.stringify(SEARXNG_RESPONSES.success.body)]);
  assert.ok(SEARXNG_RESPONSES.success.body.results.length > 0);
  assert.deepEqual(await get('q=a&format=json'), [500, 'application/json', JSON.stringify(SEARXNG_RESPONSES['http-500'].body)]);
  assert.deepEqual(await get('q=b&format=json'), [500, 'application/json', JSON.stringify(SEARXNG_RESPONSES['http-500'].body)]);
  const notFound = await fetch(`${service.searxngUrl}/other`);
  assert.equal(notFound.status, 404);
  await notFound.text();
  assert.deepEqual(service.requests().map(request => [request.method, request.url, request.response]), [
    ['GET', '/search?q=test&format=json&categories=general&language=all&safesearch=0', 'success'],
    ['GET', '/search?q=a&format=json', 'http-500'], ['GET', '/search?q=b&format=json', 'http-500'], ['GET', '/other', null]]);
  assert.equal(SEARCH_PORT, 47140);

  assert.equal(searchGap(scenario('s', [{ cmd: 'a', args: { u: '${search.searxngUrl}' } }])), null, 'no `search` field: one success');
  assert.equal(searchGap(scenario('s', [{ cmd: 'a' }], { search: { searxng: ['success', 'nope'] } })), 'search.searxng response nope is not one of empty, http-500, success');
  assert.equal(searchGap(scenario('s', [{ cmd: 'a' }], { search: { searxng: [] } })), 'search.searxng must be a non-empty list of response names');
  assert.equal(searchGap(scenario('s', [{ cmd: 'a' }], { search: { bing: ['success'] } })), 'search engine bing has no mock (known: searxng)');
});

test('${search.searxngUrl} and ${runner.*} are provided; unknown keys of either are a gap like any other unprovided binding', () => {
  const step = args => ({ cmd: 'a', args });
  assert.equal(serviceGap(scenario('s', [step({ u: '${search.searxngUrl}', s: '${runner.scratchDir}/a.zip', t: 'T_${runner.unixNowMinus120}', f: '${runner.fixture.notZip}' })])), null);
  assert.equal(serviceGap(scenario('s', [step({ u: '${search.nope}' })])), 'binding ${search.nope} is not provided by the search service');
  assert.equal(serviceGap(scenario('s', [step({ a: '${runner.nope}', b: '${runner.fixture.x}' })])), 'binding ${runner.fixture.x}, ${runner.nope} is not provided by the run (scenario-v0 runner bindings)');
  assert.equal(serviceGap(scenario('s', [step({ u: '${search.searxngUrl}' })], { search: { searxng: ['nope'] } })), 'search.searxng response nope is not one of empty, http-500, success');
  for (const file of ['host/plugins/backup/equivalence/pending-runner/audit-cleanup-token.json', 'host/plugins/backup/equivalence/pending-runner/import-job-lifecycle.json',
    'host/plugins/browser/equivalence/pending-mock/websearch-searxng.json']) {
    for (const item of suite(file)) assert.equal(serviceGap(item), null, item.id);
  }
});

test('corpus check: ${runner.*} and ${search.*} keys the recorder supplies pass; unknown keys and unknown search responses block', async t => {
  const root = tempRoot(t, 'w13-corpus-runner-');
  const dir = join(root, 'host/plugins/x/equivalence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.json'), JSON.stringify({ scenarios: [
    scenario('s.ok', [{ cmd: 'a', args: { t: 'AUDIT_CLEANUP_${runner.unixNowPlus30}', z: '${runner.scratchDir}/x.zip', n: '${runner.fixture.notZip}', u: '${search.searxngUrl}' } }],
      { search: { searxng: ['success'] } }),
    scenario('s.runner-key', [{ cmd: 'a', args: { t: '${runner.unixNowPlus}' } }]),
    scenario('s.search-key', [{ cmd: 'a', args: { u: '${search.bingUrl}' } }]),
    scenario('s.search-response', [{ cmd: 'a', args: { u: '${search.searxngUrl}' } }], { search: { searxng: ['nope'] } }),
  ] }));
  const result = await checkCorpus(root, { seeds: ['empty'], llmScripts: [], embeddingModels: [], cloudSeeds: [], rustCommands: new Set(['a']) });
  assert.deepEqual(result.findings.map(item => [item.kind, item.id, item.detail]), [
    ['bad-reference', 's.runner-key', '${runner.unixNowPlus}'],
    ['bad-reference', 's.search-key', '${search.bingUrl}'],
    ['unknown-search-response', 's.search-response', 'search.searxng response nope is not one of empty, http-500, success'],
  ]);
  assert.equal(result.blockedScenarios, 3);
});

test('startScenarioServices: llmPort / searchPort default to the fixed G3 ports; 0 (tests outside a worker namespace) binds a free port and records it', async () => {
  assert.equal(LLM_PORT, 47110);
  const file = join(REPO, 'host/plugins/browser/equivalence/pending-mock/websearch-searxng.json');
  const both = scenario('s', [{ cmd: 'a', args: { u: '${llm.baseUrl}', s: '${search.searxngUrl}' } }], { llm: 'success.answer', search: { searxng: ['empty'] } });
  const services = await startScenarioServices(both, file, { llmPort: 0, searchPort: 0 });
  try {
    const llmPort = Number(new URL(services.bindings.llm.baseUrl).port), searchPort = Number(new URL(services.bindings.search.searxngUrl).port);
    for (const port of [llmPort, searchPort]) assert.ok(port > 0 && port !== LLM_PORT && port !== SEARCH_PORT, String(port));
    assert.equal(services.bindings.provider.url, services.bindings.llm.baseUrl);
    const response = await fetch(`${services.bindings.search.searxngUrl}/search?q=x&format=json`);
    assert.equal(await response.text(), JSON.stringify(SEARXNG_RESPONSES.empty.body));
    const record = services.record();
    assert.equal(record.llmService.port, llmPort);
    assert.deepEqual(record.search, { port: searchPort, searxng: ['empty'], requests: [{ method: 'GET', url: '/search?q=x&format=json', response: 'empty' }] });
  } finally { await services.stop(); }
  const none = await startScenarioServices(scenario('n', [{ cmd: 'a', args: { t: '${runner.unixNow}' } }]), file);
  assert.equal(none.bindings, null, '${runner.*} is the run\'s, not a service');
  assert.equal(none.record().search, undefined);
  await none.stop();
});
