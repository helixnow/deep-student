import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseExact, stringifyExact } from './json.mjs';
import { validateWaitSpec } from './g3-wait.mjs';

// WAVE0 uses JSONPath, not the legacy recorder's JSON Pointer. This explicit
// subset is only validation: no rule is applied before C2 reviews A1/A2 evidence.
export function parseJsonPath(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) throw new Error(`invalid JSONPath: ${path}`);
  const tokens = [];
  let rest = path.slice(1);
  while (rest) {
    const match = /^(?:\.([A-Za-z_][A-Za-z0-9_]*|\*)|\[(0|[1-9][0-9]*|\*)\]|\[("(?:[^"\\]|\\.)*")\])/.exec(rest);
    if (!match) throw new Error(`unsupported JSONPath syntax: ${path}`);
    tokens.push(match[1] ?? match[2] ?? JSON.parse(match[3]));
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

export function validateScenario(scenario) {
  if (!scenario || typeof scenario.id !== 'string' || typeof scenario.seed !== 'string'
    || !Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error('invalid v0 scenario');
  if (!scenario.capture || typeof scenario.capture.events !== 'boolean'
    || !Array.isArray(scenario.capture.db)
    || scenario.capture.db.some(name => typeof name !== 'string')) throw new Error('capture.events and capture.db are required');
  if (!Array.isArray(scenario.normalize)) throw new Error('normalize must be an explicit array');
  for (const path of scenario.normalize) parseJsonPath(path);
  if (scenario.normalize.length) throw new Error('normalize requires A1/A2 originals and C2 approval; no rules applied');
  for (const [index, step] of scenario.steps.entries()) {
    if (!step || typeof step.cmd !== 'string' || !step.cmd) throw new Error('each step requires cmd');
    if (step.expect !== undefined && step.expect !== 'error') throw new Error('unsupported expect annotation');
    for (const key of ['waitBefore', 'waitAfter']) if (step[key] !== undefined) validateWaitSpec(step[key], `step ${index} ${key}`);
    for (const text of stringValues([step.args, step.waitBefore, step.waitAfter])) {
      for (const [whole] of text.matchAll(/\$\{wait(?:\.[^}]*)?\}/g)) {
        const target = WAITED.exec(whole)?.[1];
        if (target === undefined) throw new Error(`step ${index}: invalid wait reference ${whole} (\${wait.N} or \${wait.N.path})`);
        if (Number(target) >= index || scenario.steps[Number(target)]?.waitAfter === undefined) {
          throw new Error(`step ${index}: ${whole} needs an earlier step ${target} with a waitAfter`);
        }
      }
    }
  }
  return scenario;
}

function stringValues(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (value && typeof value === 'object' && !JSON.isRawJSON(value)) for (const item of Object.values(value)) stringValues(item, out);
  return out;
}

export const usesSeed = scenario => stringifyExact(scenario.steps).includes('${seed.');
export const usesRunner = scenario => stringifyExact(scenario.steps).includes('${runner.');

/** `${runner.fixture.<name>}`: files with fixed bytes in every take's run directory (backup README §5). */
export const RUNNER_FIXTURES = { notZip: { file: 'not-a-zip.zip', text: 'not a zip\n' } };
/** `${runner.unixNow}`, `${runner.unixNow(Plus|Minus)N}`: Unix seconds read when the step is dispatched (backup README §9.4). */
const RUNNER_CLOCK = /^runner\.unixNow(?:(Plus|Minus)(0|[1-9][0-9]*))?$/;

/** 'string' for a `runner.*` key the run supplies, else null. */
export function runnerBindingKind(key) {
  if (RUNNER_CLOCK.test(key) || key === 'runner.scratchDir') return 'string';
  return key.startsWith('runner.fixture.') && Object.hasOwn(RUNNER_FIXTURES, key.slice('runner.fixture.'.length)) ? 'string' : null;
}

/** `bindings` plus the `${runner.unixNow…}` keys `spec` reads, at clock reading `nowMs`; `bindings` itself when it reads none. */
function withRunnerClock(bindings, spec, nowMs) {
  const keys = [...new Set([...stringifyExact(spec ?? null).matchAll(/\$\{(runner\.unixNow[A-Za-z0-9_-]*)\}/g)].map(match => match[1]))];
  const clock = {};
  for (const key of keys) {
    const match = RUNNER_CLOCK.exec(key);
    if (!match) continue;
    const shift = match[1] ? (match[1] === 'Plus' ? 1 : -1) * Number(match[2]) : 0;
    clock[key.slice('runner.'.length)] = String(Math.floor(nowMs / 1000) + shift);
  }
  if (!Object.keys(clock).length) return bindings;
  return { ...bindings, runner: { ...bindings?.runner, ...clock } };
}

/** a-produced-seeds.ts seedBindings: the `${seed.*}` values of seed `name` for its copy at `directory`, or null. */
export async function aProducedBindings(name, directory) {
  const { seedBindings } = await import('../../../host/e2e/data-compat/__fixtures__/a-produced-seeds.ts');
  return seedBindings(name, directory);
}

// The caller creates one closed source with X3 createSeed, then prepares each run
// from that catalog. Never regenerate an incomplete source or fall back to empty.
// NODE_COMPILE_CACHE stays outside the seed copy (default: beside it): the Host's compile
// cache would otherwise land in the seed's TMPDIR, under the snapshot walk and --compact.
// `bindings`: `{ seed }` for a scenario that uses `${seed.*}`, `{ runner }` for one that uses
// `${runner.*}`, else null. Their paths are inside this copy, i.e. under the take's run root, which
// N-007 replaces on every side; `runner/` is outside HOME and the data directories (A sanitizes those).
export async function prepareScenarioRun(scenario, { catalog, directory, env = process.env,
  compileCache = join(dirname(resolve(directory)), 'node-compile-cache'), seedBindings = aProducedBindings }) {
  validateScenario(scenario);
  const { resolveSeed, copySeed } = await import('../../../host/e2e/data-compat/__fixtures__/scenario-seeds.ts');
  const source = resolveSeed(scenario.seed, catalog);
  if (source.name === 'skill-zip-v0') {
    const { SKILL_ZIP_SEED_FILES } = await import('../../../host/e2e/data-compat/__fixtures__/skill-zip-seeds.ts');
    for (const file of SKILL_ZIP_SEED_FILES) {
      const filename = join(source.directory, file.relativePath);
      if (!(await stat(filename)).isFile()) throw new Error(`Seed input is not a file: ${filename}`);
    }
  }
  const seed = copySeed(source.name, catalog, directory);
  const directories = Object.fromEntries(['home', 'config', 'cache', 'runtime', 'tmp'].map(name => [name, join(seed.directory, name)]));
  for (const path of Object.values(directories)) await mkdir(path, { recursive: true, mode: 0o700 });
  const cache = resolve(compileCache);
  if (cache === resolve(seed.directory) || cache.startsWith(resolve(seed.directory) + '/')) throw new Error(`NODE_COMPILE_CACHE ${cache} is inside the seed copy`);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  let bindings = null;
  if (usesSeed(scenario)) {
    const values = await seedBindings(source.name, seed.directory);
    if (!values) throw new Error(`seed ${source.name} provides no \${seed.…} bindings`);
    bindings = { seed: values };
  }
  if (usesRunner(scenario)) {
    const root = join(seed.directory, 'runner');
    if (existsSync(root)) throw new Error(`seed ${source.name} copy already has ${root}`);
    const scratchDir = join(root, 'scratch'), fixture = {};
    await mkdir(scratchDir, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'fixtures'), { mode: 0o700 });
    for (const [name, { file, text }] of Object.entries(RUNNER_FIXTURES)) {
      fixture[name] = join(root, 'fixtures', file);
      await writeFile(fixture[name], text, { flag: 'wx' });
    }
    bindings = { ...bindings, runner: { scratchDir, fixture } };
  }
  return { source, seed, directories, bindings,
    env: { ...env, HOME: directories.home, XDG_DATA_HOME: seed.dataDir,
      XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
      XDG_RUNTIME_DIR: directories.runtime, TMPDIR: directories.tmp, NODE_COMPILE_CACHE: cache } };
}

const NAMESPACE = '(?:llm|provider|cloud|mock|mcp|seed|runner|search)(?:\\.[A-Za-z_][A-Za-z0-9_-]*)+';
const BOUND = new RegExp(`^\\$\\{(${NAMESPACE})\\}$`);
const WAITED = /^\$\{wait\.(0|[1-9][0-9]*)(?:\.([^}]+))?\}$/;
const EMBEDDED = new RegExp(`^\\$\\{(?:${NAMESPACE}|(?:wait\\.)?(?:0|[1-9][0-9]*)(?:\\.[^}]+)?)\\}$`);

/** `root` at dot `path` (absent: root itself), exactly as a step reference reads its result. */
function referenceField(root, path, value) {
  let result = root;
  for (const key of path?.split('.') ?? []) {
    if (result === null || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new Error(`missing reference field: ${value}`);
    result = result[key];
  }
  return result;
}

/**
 * `waits[N]`: the recorded event `{event, payloadRaw}` that satisfied step N's waitAfter;
 * `${wait.N.path}` reads its payload like `${N.path}` reads step N's result.
 */
export function resolveReferences(value, outcomes, bindings = null, waits = null) {
  if (typeof value === 'string') {
    // Service bindings (g3-services.mjs): X5 `${llm.baseUrl}` / `${provider.url}`,
    // WP-046 `${cloud.webdav.endpoint}` / `${mock.webdav.username}`, MCP `${mcp.disconnect-on-list.args}` …;
    // local SearXNG `${search.searxngUrl}`; seed and runner bindings (prepareScenarioRun):
    // `${seed.file.portableZip}`, `${runner.scratchDir}`, and `${runner.unixNow}` (executeScenario) …
    // A whole-value placeholder is the binding's JSON value (MCP args is an array, env an object).
    const bound = BOUND.exec(value);
    if (bound) {
      let found = bindings;
      for (const key of bound[1].split('.')) found = found !== null && typeof found === 'object' && Object.hasOwn(found, key) ? found[key] : undefined;
      if (typeof found === 'string') return found;
      const text = found === undefined ? undefined : JSON.stringify(found);
      if (text === undefined) throw new Error(`unbound reference: ${value}`);
      return parseExact(text);
    }
    const waited = WAITED.exec(value);
    if (waited) {
      const event = waits?.[Number(waited[1])];
      if (!event) throw new Error(`reference is not a prior step's matched waitAfter: ${value}`);
      return referenceField(parseExact(event.payloadRaw), waited[2], value);
    }
    const match = /^\$\{(0|[1-9][0-9]*)(?:\.([^}]+))?\}$/.exec(value);
    if (!match) {
      if (!value.includes('${')) return value;
      // Embedded `${N.path}` inside a longer string (X5 resolvePlaceholders, X1 B driver):
      // strings insert as-is, exact step numbers by their source text; anything else is an error.
      return value.replace(/\$\{([^}]*)\}/g, whole => {
        if (!EMBEDDED.test(whole)) throw new Error(`invalid reference: ${whole} in ${value}`);
        const found = resolveReferences(whole, outcomes, bindings, waits);
        if (typeof found === 'string') return found;
        if (BOUND.test(whole)) throw new Error(`embedded service binding is not a string: ${whole} in ${value}`);
        if (typeof found === 'bigint') return found.toString();
        if (JSON.isRawJSON(found)) return found.rawJSON;
        throw new Error(`embedded reference is not a string or number: ${whole} in ${value}`);
      });
    }
    const index = Number(match[1]);
    if (index >= outcomes.length || outcomes[index]?.kind !== 'result') throw new Error(`reference is not a prior successful step: ${value}`);
    return referenceField(parseExact(outcomes[index].raw), match[2], value);
  }
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, outcomes, bindings, waits));
  if (value && typeof value === 'object' && !JSON.isRawJSON(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, outcomes, bindings, waits)]));
  }
  return value;
}

// Adapter errors reject the run; only an explicit raw result/error envelope is a
// business outcome. DB and events are requested, never replaced with empty values.
// `adapter.capture(spec, {phase: 'before'|'step'|'after', step})`; `adapter.eventCount()`
// (the scenario's event list length) anchors waits: a step's waitAfter, and the next step's
// waitBefore, only see events recorded after that step's invoke started. `adapter.wait`
// resolves with the matched event; a waitAfter's is what later `${wait.N…}` references read.
// `adapter.now()` (default Date.now) is read once per step that uses `${runner.unixNow…}`, just
// before its args resolve; its waitAfter reads the same instant.
export async function executeScenario(scenario, adapter) {
  validateScenario(scenario);
  const capture = async (phase, step) => {
    const result = await adapter.capture(scenario.capture, { phase, step });
    if (scenario.capture.events && !Array.isArray(result?.events)) throw new Error('missing captured events');
    if (scenario.capture.db.length && (!result?.databases || typeof result.databases !== 'object')) throw new Error('missing captured databases');
    return result;
  };
  const outcomes = [];
  const before = await capture('before', -1);
  const calls = [];
  const eventCount = () => (typeof adapter.eventCount === 'function' ? adapter.eventCount() : 0);
  // Waits (g3-wait.mjs) are explicit backend-event barriers, never sleeps.
  const waits = [];
  const now = () => (typeof adapter.now === 'function' ? adapter.now() : Date.now());
  const clocked = spec => (/\$\{runner\.unixNow/.test(stringifyExact(spec ?? null)) ? withRunnerClock(adapter.bindings ?? null, spec, now()) : adapter.bindings ?? null);
  const wait = async (spec, index, phase, since, bindings = clocked(spec)) => {
    if (!spec) return;
    if (typeof adapter.wait !== 'function') throw new Error(`step ${index} ${phase} needs an adapter event barrier`);
    const matched = await adapter.wait(resolveReferences(spec, outcomes, bindings, waits), { step: index, phase, since });
    if (phase === 'waitAfter') waits[index] = matched ?? null;
  };
  let anchor = 0;
  for (const [index, step] of scenario.steps.entries()) {
    await wait(step.waitBefore, index, 'waitBefore', anchor);
    const dispatched = clocked([step.args ?? null, step.waitAfter ?? null]);
    // Absent args are sent as {} exactly like Tauri invoke(cmd) and the X1 B driver.
    const args = stringifyExact(resolveReferences(Object.hasOwn(step, 'args') ? step.args : {}, outcomes, dispatched, waits));
    anchor = eventCount();
    const outcome = await adapter.invoke(step.cmd, args);
    if (!['result', 'error'].includes(outcome?.kind) || typeof outcome.raw !== 'string') throw new Error('missing raw IPC outcome');
    parseExact(outcome.raw);
    outcomes.push(outcome);
    await wait(step.waitAfter, index, 'waitAfter', anchor, dispatched);
    const captured = await capture('step', index);
    calls.push({ command: step.cmd, argsRaw: args, outcome, capture: captured });
  }
  return { schema: 'wave0-v0-observation', scenario: scenario.id, before, calls,
    after: await capture('after', scenario.steps.length), normalization: [], comparison: 'not-run' };
}
