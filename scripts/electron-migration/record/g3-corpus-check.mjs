#!/usr/bin/env node
// Static check of the G3 scenario corpus (the suites g3-batch records, via scanScenarios) for
// problems that would waste a server round regardless of A or B: a scenario that cannot run as
// written fails the same way on both sides, or aborts its runner.
//   node scripts/electron-migration/record/g3-corpus-check.mjs [--json FILE] [--strict]
// Blocking (the scenario cannot produce a comparable trace):
//   invalid-scenario / not-a-v0-suite / unparseable-json   scanScenarios problems
//   duplicate-id          same id twice in one suite (compare files collide)
//   unknown-seed          seed not in host/e2e/data-compat scenario-seeds SEED_NAMES
//   forward-reference     ${N…} / ${wait.N…} to the same or a later step (runner throws)
//   error-step-reference  ${N…} to a step declared `expect: "error"` (runner throws)
//   bad-reference         `${…}` that is neither a step reference nor a known service binding,
//                         ${wait.N…} to a step without a waitAfter, ${seed.…} the scenario's
//                         seed does not supply (a-produced-seeds.ts seedBindings), or a ${runner.…} /
//                         ${search.…} key the run (scenario-v0) / the SearXNG mock does not supply
//   unknown-cloud-seed    scenario.cloud.seed not in the cloud service SEEDS
//   unknown-search-response scenario.search names an engine or response the SearXNG mock does not have
//   wait-without-events   a step waits for an event but capture.events is false: g3-run-a subscribes
//                         only for capturing scenarios, so A times out where B may not
// Warnings (the scenario runs, but the result may not mean what it should):
//   llm-script-missing    the scenario binds the X5 LLM service, but its script (scenario.llm ?? id)
//                         is neither built in nor in the suite's .provider.json; a model call gets 404
//   unknown-embedding-model every binding sits in an `isEmbedding: true` model config (so only
//                         /embeddings is reached, answered for any script) and that model is not in
//                         host/plugins/llm-providers/src/replay/embeddings.ts; the call gets 404
//   a-unregistered-command step command not in src-tauri/src/lib.rs generate_handler! (A answers
//                         "command not found"; the reference A build may carry later registrations)
//   date-literal          arguments carry a calendar date; with the clock not frozen, the scenario's
//                         meaning depends on the recording day (due dates, ranges, expiry). An MCP
//                         `protocolVersion` (a protocol revision named by date) is not one
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scanScenarios } from './g3-report.mjs';
import { runnerBindingKind } from './scenario-v0.mjs';
import { searchBindingKinds, searchGap } from './g3-search-service.mjs';

export const BLOCKING = ['invalid-scenario', 'not-a-v0-suite', 'unparseable-json', 'duplicate-id', 'unknown-seed',
  'forward-reference', 'error-step-reference', 'bad-reference', 'unknown-cloud-seed', 'unknown-search-response', 'wait-without-events'];
const SEARCH_BINDINGS = searchBindingKinds();
const BINDINGS = new Set(['llm.baseUrl', 'provider.url', 'cloud.webdav.endpoint', 'cloud.s3.endpoint',
  'mock.webdav.endpoint', 'mock.webdav.endpointAlias', 'mock.webdav.username', 'mock.webdav.password']);
const DATE = /(?<![0-9])(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![0-9])/;
/** MCP protocol revisions are named by date (`"protocolVersion":"2025-06-18"` in a JSON-RPC message string), not calendar inputs. */
const PROTOCOL_VERSION = /"protocolVersion"\s*:\s*"[^"]*"/g;

/** The first argument string that carries a calendar date, protocol revisions (key or JSON text) aside; null if none. */
function datedText(value, key = null) {
  if (typeof value === 'string') return key !== 'protocolVersion' && DATE.test(value.replace(PROTOCOL_VERSION, '')) ? value : null;
  if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      const found = datedText(item, name);
      if (found !== null) return found;
    }
  }
  return null;
}

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

/** The innermost object around each string that binds the LLM service (`null` when there is none). */
function llmHolders(value, holder = null, out = []) {
  if (typeof value === 'string') { if (/\$\{(llm|provider)\.[^}]*\}/.test(value)) out.push(holder); }
  else if (Array.isArray(value)) for (const item of value) llmHolders(item, holder, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) llmHolders(item, value, out);
  return out;
}

/** Findings over the corpus under `root`; registries are injectable for tests. */
export async function checkCorpus(root, registries = null) {
  root = resolve(root);
  const registry = registries ?? await loadRegistries(root);
  const { suites, problems } = scanScenarios(root);
  const findings = problems.map(problem => ({ kind: problem.kind, file: problem.file, id: problem.id ?? null, detail: problem.message ?? null }));
  let scenarios = 0;
  for (const suite of suites) {
    const json = JSON.parse(readFileSync(join(root, suite.file), 'utf8'));
    const sidecar = join(root, suite.file.replace(/\.json$/, '.provider.json'));
    let sidecarScripts = [];
    try { sidecarScripts = existsSync(sidecar) ? Object.keys(JSON.parse(readFileSync(sidecar, 'utf8'))).filter(key => key !== 'note') : []; }
    catch (error) { findings.push({ kind: 'unparseable-json', file: sidecar.slice(root.length + 1), id: null, detail: error.message }); }
    const seen = new Set();
    for (const scenario of json.scenarios) {
      scenarios++;
      const add = (kind, detail, step = null) => findings.push({ kind, file: suite.file, id: scenario.id ?? null, step, detail });
      if (seen.has(scenario.id)) add('duplicate-id', `id ${scenario.id} appears more than once`);
      seen.add(scenario.id);
      if (typeof scenario.seed === 'string' && !registry.seeds.includes(scenario.seed)) add('unknown-seed', scenario.seed);
      if (scenario.cloud?.seed !== undefined && typeof scenario.cloud.seed === 'string' && !registry.cloudSeeds.includes(scenario.cloud.seed)) {
        add('unknown-cloud-seed', scenario.cloud.seed);
      }
      const searchProblem = searchGap(scenario);
      if (searchProblem) add('unknown-search-response', searchProblem);
      let usesLlm = scenario.llm !== undefined;
      const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
      const holders = steps.flatMap(step => llmHolders(step?.args ?? null));
      const embeddingOnly = scenario.llm === undefined && holders.length > 0
        && holders.every(holder => holder?.isEmbedding === true && typeof holder.model === 'string');
      for (const [index, step] of steps.entries()) {
        for (const key of ['waitBefore', 'waitAfter']) {
          if (step?.[key] !== undefined && scenario.capture?.events === false) add('wait-without-events', `step ${index} ${key}`, index);
        }
        // `plugin:<name>|<command>` commands are registered by Tauri plugins, not generate_handler!.
        if (typeof step?.cmd === 'string' && !step.cmd.startsWith('plugin:') && !registry.rustCommands.has(step.cmd)) add('a-unregistered-command', step.cmd, index);
        const texts = strings(step?.args ?? null);
        for (const text of texts) {
          for (const [whole, inner] of text.matchAll(/\$\{([^}]*)\}/g)) {
            const ref = /^(0|[1-9][0-9]*)(?:\.[^}]+)?$/.exec(inner);
            const waited = /^wait\.(0|[1-9][0-9]*)(?:\.[^}]+)?$/.exec(inner);
            if (ref) {
              const target = Number(ref[1]);
              if (target >= index) add('forward-reference', `${whole} in step ${index}`, index);
              else if (steps[target]?.expect === 'error') add('error-step-reference', `${whole} refers to step ${target}, declared expect: "error"`, index);
            } else if (waited) {
              const target = Number(waited[1]);
              if (target >= index) add('forward-reference', `${whole} in step ${index}`, index);
              else if (steps[target]?.waitAfter === undefined) add('bad-reference', `${whole}: step ${target} has no waitAfter`, index);
            } else if (BINDINGS.has(inner)) {
              if (/^(llm|provider)\./.test(inner)) usesLlm = true;
            } else if (runnerBindingKind(inner) || Object.hasOwn(SEARCH_BINDINGS, inner)) {
              // Strings: whole or embedded (`AUDIT_CLEANUP_${runner.unixNow}`, `${runner.scratchDir}/x.zip`).
            } else if (inner.startsWith('seed.') && !registry.seedBindings?.[scenario.seed]) {
              add('bad-reference', `${whole}: seed ${scenario.seed ?? '(none)'} provides no \${seed.…} bindings`, index);
            } else if (Object.hasOwn(registry.mcpBindings ?? {}, inner) || Object.hasOwn(registry.seedBindings?.[scenario.seed] ?? {}, inner)) {
              // A whole-value binding is its JSON value; inside a longer string only strings resolve.
              const kind = inner.startsWith('seed.') ? registry.seedBindings[scenario.seed][inner] : registry.mcpBindings[inner];
              if (text !== whole && kind !== 'string') add('bad-reference', `${whole} (${kind}) embedded in "${text}"`, index);
            } else add('bad-reference', whole, index);
          }
        }
        const dated = datedText(step?.args ?? null);
        if (dated) add('date-literal', `${step.cmd}: ${dated.length > 80 ? dated.slice(0, 80) + '…' : dated}`, index);
      }
      if (usesLlm && embeddingOnly) {
        for (const model of new Set(holders.map(holder => holder.model))) {
          if (!(registry.embeddingModels ?? []).includes(model)) add('unknown-embedding-model', `model ${model}`);
        }
      } else if (usesLlm) {
        const script = scenario.llm ?? scenario.id;
        if (!registry.llmScripts.includes(script) && !sidecarScripts.includes(script)) add('llm-script-missing', `script ${script}`);
      }
    }
  }
  const counts = {};
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  const blocking = findings.filter(finding => BLOCKING.includes(finding.kind));
  return { suites: suites.length, scenarios, counts, blocking: blocking.length,
    blockedScenarios: new Set(blocking.map(finding => `${finding.file}#${finding.id}`)).size, findings };
}

export async function loadRegistries(root) {
  const { SEED_NAMES } = await import(pathToFileURL(join(root, 'host/e2e/data-compat/__fixtures__/scenario-seeds.ts')).href);
  const { scripts } = await import(pathToFileURL(join(root, 'host/e2e/streaming/wave0/llm-service.ts')).href);
  const { embeddingModels } = await import(pathToFileURL(join(root, 'host/plugins/llm-providers/src/replay/embeddings.ts')).href);
  const { SEEDS } = await import(pathToFileURL(join(root, 'host/plugins/sync-providers/equivalence/__fixtures__/cloud-service.ts')).href);
  const { mcpBindingKinds, seedBindingKinds } = await import(pathToFileURL(join(root, 'scripts/electron-migration/record/g3-services.mjs')).href);
  const seedBindings = {};
  for (const name of SEED_NAMES) seedBindings[name] = await seedBindingKinds(name);
  return { seeds: [...SEED_NAMES], llmScripts: Object.keys(scripts), embeddingModels: Object.keys(embeddingModels), cloudSeeds: Object.keys(SEEDS),
    rustCommands: rustCommands(root), mcpBindings: await mcpBindingKinds(), seedBindings };
}

/** Command names in every `generate_handler![…]` of src-tauri/src/lib.rs (what the A binary dispatches). */
export function rustCommands(root, file = 'src-tauri/src/lib.rs') {
  const text = readFileSync(join(root, file), 'utf8');
  const names = new Set();
  for (let start = text.indexOf('generate_handler!['); start >= 0; start = text.indexOf('generate_handler![', start + 1)) {
    let depth = 0, end = start + 'generate_handler!'.length;
    for (; end < text.length; end++) {
      if (text[end] === '[') depth++;
      else if (text[end] === ']' && --depth === 0) break;
    }
    const body = text.slice(start + 'generate_handler!['.length, end).replace(/\/\/.*$/gm, '').replace(/#\[[^\]]*\]/g, '');
    for (const item of body.split(',')) {
      const name = item.trim().split('::').at(-1);
      if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { json: { type: 'string' }, strict: { type: 'boolean' } } });
  const result = await checkCorpus(process.cwd());
  if (values.json) writeFileSync(values.json, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ suites: result.suites, scenarios: result.scenarios, blocking: result.blocking,
    blockedScenarios: result.blockedScenarios, counts: result.counts }));
  if (values.strict && result.blocking) process.exitCode = 1;
}
