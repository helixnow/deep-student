#!/usr/bin/env node
// G3 A side: the real instrumented Tauri binary (D-156 isolated identifier) driving
// g3-harness.mjs in its main webview, one process per scenario take over a fresh X3
// seed copy. Run through jobs + xvfb:
//   xvfb-run -a dbus-run-session -- node scripts/electron-migration/record/g3-run-a.mjs \
//     SCENARIO_FILE BUILD_RECEIPT OUTPUT_DIR [--scenario ID ...] [--take A1 --take A2]
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startG3HarnessServer } from './g3-harness-server.mjs';
import { evidenceBytes, parseExact, stringifyExact } from './json.mjs';
import { executeScenario, prepareScenarioRun, usesSeed, validateScenario } from './scenario-v0.mjs';
import { waitForEvent } from './g3-wait.mjs';
import { databaseFingerprint, quiesce } from './g3-quiet.mjs';
import { mcpBindingKinds, seedBindingKinds, serviceGap, startScenarioServices, stepTimeout, usesMcp } from './g3-services.mjs';
import { runStartup } from './g3-startup.mjs';
import { processRecord, startSupervised } from './supervise.mjs';

export const IDENTIFIER = 'com.deepstudent.differential';
const STEP_MS = 60_000;
const BOOT_MS = 120_000;
const KILL_GRACE_MS = 10_000;
const CLOSE_GRACE_MS = 10_000;
const SUPPORTED_STEP_KEYS = new Set(['cmd', 'args', 'expect', 'waitAfter', 'waitBefore']);
/** Scenario keys executeScenario does not honour (steps run one after another): the take would be another scenario. */
const UNSUPPORTED_SCENARIO_KEYS = ['concurrent'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function unsupported(scenario) {
  const keys = UNSUPPORTED_SCENARIO_KEYS.filter(key => Object.hasOwn(scenario, key));
  if (keys.length) return `scenario uses ${keys.join(', ')}`;
  for (const [index, step] of scenario.steps.entries()) {
    const extra = Object.keys(step).filter(key => !SUPPORTED_STEP_KEYS.has(key));
    if (extra.length) return `step ${index} uses ${extra.join(', ')}`;
  }
  return null;
}

const FRONTEND_LISTEN = /\b(?:listen|once)(?:<[^>]*>)?\(\s*([`'"])([^`'"]+)\1/g;
function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'debug' && entry.name !== 'node_modules') yield* sourceFiles(path); }
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) yield path;
  }
}
/**
 * Event names a frontend can subscribe to: contract events (contracts/ipc) plus literal
 * `listen(...)`/`once(...)` names in the product frontend (src/, excluding tests and debug
 * plugins). `${expr}`/`{}` segments become `{}` patterns filled from ids the run holds.
 */
export function frontendEvents(contracts = 'contracts/ipc', frontend = 'src') {
  const names = new Set(), patterns = new Set();
  const add = name => (name.includes('{') ? patterns : names).add(name.replace(/\$\{[^}]*\}|\{[^}]*\}/g, '{}'));
  for (const file of readdirSync(contracts).filter(name => name.endsWith('.json'))) {
    const events = JSON.parse(readFileSync(join(contracts, file), 'utf8')).events;
    for (const event of Array.isArray(events) ? events : []) if (typeof event?.name === 'string') add(event.name);
  }
  for (const file of sourceFiles(frontend)) for (const match of readFileSync(file, 'utf8').matchAll(FRONTEND_LISTEN)) add(match[2]);
  // A pattern that is only a placeholder (`${eventName}`) would subscribe to every id; skip it.
  for (const pattern of patterns) if (pattern.replaceAll('{}', '') === '') patterns.delete(pattern);
  return { names: [...names].sort(), patterns: [...patterns].sort() };
}

const EVENT_NAME = /^[A-Za-z0-9\-/:_]+$/;
const ID_LIKE = /^[A-Za-z0-9_\-/:]{3,256}$/;
/** Channels a frontend could subscribe to for ids/paths it holds (chat_v2_session_<id>, dstu:change:<path>). */
export function dynamicChannels(patterns, valueRaw) {
  const ids = new Map(); // id -> first JSON pointer it was found at
  const escape = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
  const visit = (value, pointer) => {
    if (typeof value === 'string') { if (ID_LIKE.test(value) && !ids.has(value)) ids.set(value, pointer); }
    else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${pointer}/${index}`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, `${pointer}/${escape(key)}`);
  };
  visit(JSON.parse(valueRaw), '');
  const out = [];
  for (const pattern of patterns) for (const [id, pointer] of ids) {
    const name = pattern.replaceAll('{}', id);
    if (EVENT_NAME.test(name)) out.push({ name, pattern, pointer });
  }
  return out;
}

/** --compact: after the trace (lossless DB snapshot) is written, drop this run's seed-copy directories; logs stay. */
function compactRun(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(directory, entry.name), { recursive: true });
  }
}

async function verifyReceipt(receiptFile) {
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (receipt.schema !== 'wp043-tauri-build' || receipt.code !== 0 || !receipt.binarySha256) throw new Error('successful instrumented Tauri build receipt required');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(receipt.binary)) digest.update(chunk);
  if (digest.digest('hex') !== receipt.binarySha256) throw new Error('binary differs from recorded build');
  const config = JSON.parse(readFileSync(new URL('./tauri.effective.json', pathToFileURL(resolve(receiptFile))), 'utf8'));
  if (config.identifier !== IDENTIFIER || receipt.identifier !== IDENTIFIER) throw new Error('D-156: isolated identifier must be in the built configuration');
  if (config.build.devUrl !== 'http://127.0.0.1:1422') throw new Error('built devUrl does not match the harness server');
  return receipt;
}

/** One take: fresh seed copy, fresh process, scenario, clean exit, final snapshot. */
export async function runScenarioA(scenario, { scenarioFile, catalog, directory, receipt, events, side = 'A1', profilePool = null,
  timeouts = {}, harnessPort = 1422, workerStartedAt = null, compileCache }) {
  const { boot: bootMs = BOOT_MS, step: stepMs = stepTimeout(scenario, STEP_MS), killGrace = KILL_GRACE_MS, closeGrace = CLOSE_GRACE_MS } = timeouts;
  validateScenario(scenario);
  const startedAt = new Date().toISOString();
  const inputSha256 = sha256(readFileSync(scenarioFile));
  const { snapshotDirectory } = await import('../../../host/e2e/data-compat/__fixtures__/database-state.ts');
  const { seed, directories, env, bindings: seedReferences } = await prepareScenarioRun(scenario, { catalog, directory, ...(compileCache ? { compileCache } : {}) });
  directories.profiles = join(seed.directory, 'profiles');
  await mkdir(directories.profiles, { mode: 0o700 });
  // Pool mode: LLVM online merge (%4m) adds every process's counters into 4 shared files.
  env.LLVM_PROFILE_FILE = profilePool ? join(profilePool, 'g3-%4m.profraw') : join(directories.profiles, '%p-%m.profraw');
  const started = Date.now();
  delete env.TAURI_LAB_INSTANCE_ID;
  const services = await startScenarioServices(scenario, scenarioFile);
  const harness = await startG3HarnessServer(harnessPort);
  const stdout = createWriteStream(join(directory, 'app.stdout.log'));
  const stderr = createWriteStream(join(directory, 'app.stderr.log'));
  const logsClosed = Promise.all([finished(stdout), finished(stderr)]);
  // Own process group: WebKit helpers that outlive the app (or keep its pipes) go with it.
  const app = startSupervised(receipt.binary, [], { cwd: process.cwd(), env: services.appEnv(env), label: 'tauri', captureStdout: false,
    onStdout: chunk => stdout.write(chunk), onStderr: chunk => stderr.write(chunk), killGraceMs: killGrace, closeGraceMs: closeGrace });
  const exited = app.exited.then(({ code, signal, error }) => {
    if (error) throw error;
    return [code, signal];
  });
  exited.catch(error => harness.abort(error));
  exited.then(([code, signal]) => { if (!harness.evidence.closing) harness.abort(new Error(`Tauri exited before recorder completion: ${code}/${signal}`)); }, () => {});
  const timed = (promise, ms, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no harness answer within ${ms}ms`)), ms); })])
      .finally(() => clearTimeout(timer));
  };
  // name -> first step whose emissions it can hear (-1 = subscribed before step 0).
  // derived: how a dynamic name was built, so the comparator can rebuild it from the other side's ids.
  const since = new Map(), derived = new Map();
  let step = -1;
  const listen = async (entries, from, field) => {
    const fresh = [];
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (since.has(name) || fresh.includes(name)) continue;
      fresh.push(name);
      if (typeof entry !== 'string') derived.set(name, { pattern: entry.pattern, step: field === 'args' ? from : from - 1, field, pointer: entry.pointer });
    }
    if (!fresh.length) return;
    await timed(harness.listen(fresh), stepMs, 'listen');
    fresh.forEach(name => since.set(name, from));
  };
  const wire = [];
  try {
    await timed(harness.ready, bootMs, 'Tauri boot');
    const readyAt = Date.now();
    // G3-STARTUP (g3-startup.mjs): subscribe at ready, like B's fork-time stream; what either
    // side hears before the boundary is kept in `startup`, the scenario's lists start after it.
    if (scenario.capture.events) await listen(events.names, -1, null);
    const fingerprint = () => databaseFingerprint(seed.directory);
    const startup = await runStartup({ events: harness.events, fingerprint, readyAt, async invoke(command, argsRaw) {
      const outcome = await timed(harness.invoke(command, argsRaw), stepMs, `startup ${command}`);
      return { kind: outcome.kind, raw: outcome.raw };
    } });
    const scenarioEvents = () => harness.events().slice(startup.boundary);
    const trace = await executeScenario(scenario, {
      bindings: seedReferences ? { ...services.bindings, ...seedReferences } : services.bindings,
      eventCount: () => scenarioEvents().length,
      async invoke(command, argsRaw) {
        step += 1;
        if (scenario.capture.events) await listen(dynamicChannels(events.patterns, argsRaw), step, 'args');
        const outcome = await timed(harness.invoke(command, argsRaw), stepMs, command);
        // Ids/paths returned by this step can only be listened to from the next step on.
        if (scenario.capture.events && outcome.kind === 'result') await listen(dynamicChannels(events.patterns, outcome.raw), step + 1, 'result');
        if (outcome.requestRaw !== argsRaw) {
          throw new Error(`${command}: request body differs from argsRaw (type ${outcome.requestType}); A transport is not exact for this input`);
        }
        wire.push(...outcome.wire);
        return { kind: outcome.kind, raw: outcome.raw };
      },
      wait: (spec, { step, phase, since }) => waitForEvent(spec, scenarioEvents, `step ${step} ${phase}`, { since }),
      capture: async (_, { phase }) => {
        const settled = await services.settle(phase);
        const quiet = await quiesce({ events: scenarioEvents, fingerprint,
          step: scenario.steps[step] ?? null, next: scenario.steps[step + 1] ?? null });
        return { events: scenarioEvents(), databases: snapshotDirectory(seed.directory), quiet, ...(settled ? { services: settled } : {}) };
      },
    });
    harness.requestExit();
    const [code, signal] = await timed(exited, stepMs, 'Tauri exit');
    if (code !== 0 || signal) throw new Error(`Tauri exit is not clean: ${code}/${signal}`);
    const named = async name => (await readdir(seed.directory, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name === name).map(entry => join(entry.parentPath, entry.name));
    const production = await named('com.deepstudent.app');
    if (production.length) throw new Error(`production identifier directory created: ${production.join(', ')}`);
    if (!(await named(IDENTIFIER)).length) throw new Error(`no ${IDENTIFIER} data directory under ${seed.directory}`);
    const profileDir = profilePool ?? directories.profiles;
    const profiles = (await readdir(profileDir)).filter(name => name.endsWith('.profraw')
      && (!profilePool || statSync(join(profileDir, name)).mtimeMs >= started - 1000));
    if (!profiles.length) throw new Error('instrumented application produced no raw coverage');
    // N-014: clock readings of this take (and of the seed built by its worker) fall inside this window.
    const recording = { workerStartedAt, startedAt, endedAt: new Date().toISOString() };
    return { ...trace, side, inputSha256, recording, startup: startup.record, finalDatabases: snapshotDirectory(seed.directory),
      eventScope: { kind: 'named', sources: ['contracts/ipc', 'src listen()/once() literals'], since: Object.fromEntries([...since].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
        derived: Object.fromEntries([...derived].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) }, eventPayloadSource: 'webview-evaluated-js-value',
      ...services.record(), rawWire: wire,
      build: { job: receipt.job, binarySha256: receipt.binarySha256 }, coverage: { profiles, pool: profilePool, report: null } };
  } finally {
    // Bounded: SIGTERM → SIGKILL to the app's group if it is still running, then at most
    // closeGrace for its stdout/stderr to reach EOF before the pipes are cut.
    const appProcess = processRecord(await app.stop('recorder cleanup'));
    writeFileSync(join(directory, 'app-process.json'), JSON.stringify(appProcess, null, 2) + '\n');
    stdout.end(); stderr.end();
    await harness.close();
    await services.stop();
    await logsClosed;
    if (harness.evidence.failures.length) writeFileSync(join(directory, 'harness-failures.json'), JSON.stringify(harness.evidence.failures, null, 2));
  }
}

/** The app process outcome of one take, for its summary entry (null if the take never started it). */
function appOutcome(runDirectory) {
  const file = join(runDirectory, 'app-process.json');
  if (!existsSync(file)) return null;
  const { outcome, code, signal, stdio, escalation, leftovers, durationMs } = JSON.parse(readFileSync(file, 'utf8'));
  return { outcome, code, signal, stdio, escalation: escalation.map(step => step.signal), leftovers, durationMs };
}

const WORKER_STARTED_AT = new Date().toISOString();

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DISPLAY) throw new Error('Xvfb DISPLAY required');
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    scenario: { type: 'string', multiple: true }, take: { type: 'string', multiple: true },
    gzip: { type: 'boolean' }, compact: { type: 'boolean' }, 'profile-pool': { type: 'string' } } });
  const profilePool = values['profile-pool'] ? resolve(values['profile-pool']) : null;
  if (values.compact && !profilePool) throw new Error('--compact would delete per-run profraw; use --profile-pool');
  if (profilePool) mkdirSync(profilePool, { recursive: true });
  const [scenarioFile, receiptFile, outputDirectory] = positionals;
  if (!outputDirectory || positionals.length !== 3) throw new Error('usage: g3-run-a.mjs SCENARIO_FILE BUILD_RECEIPT OUTPUT_DIR [--scenario ID ...] [--take A1 ...]');
  const takes = values.take ?? ['A1'];
  if (takes.some(take => !/^A[12]$/.test(take))) throw new Error('takes are A1/A2');
  const receipt = await verifyReceipt(receiptFile);
  const output = resolve(outputDirectory);
  if (existsSync(output) && readdirSync(output).length) throw new Error(`output directory is not empty: ${output}`);
  mkdirSync(output, { recursive: true });
  const suite = parseExact(readFileSync(scenarioFile, 'utf8'));
  const selected = suite.scenarios.filter(item => !values.scenario || values.scenario.includes(item.id));
  for (const id of values.scenario ?? []) if (!selected.some(item => item.id === id)) throw new Error(`unknown scenario: ${id}`);
  const { createSeed, SEED_NAMES } = await import('../../../host/e2e/data-compat/__fixtures__/scenario-seeds.ts');
  const catalog = join(output, 'catalog');
  const compileCache = join(output, 'node-compile-cache');
  const created = new Set();
  const events = frontendEvents();
  const mcp = selected.some(usesMcp) ? await mcpBindingKinds() : null;
  const summary = [];
  for (const scenario of selected) {
    const reason = unsupported(scenario) ?? serviceGap(scenario, { mcp, seed: usesSeed(scenario) ? await seedBindingKinds(scenario.seed) : null })
      ?? (SEED_NAMES.includes(scenario.seed) ? null : `seed ${scenario.seed} is not defined in scenario-seeds.ts SEED_NAMES`);
    if (reason) { summary.push({ id: scenario.id, status: 'unsupported', reason }); continue; }
    for (const side of takes) {
      const directory = join(output, scenario.id, side);
      try {
        if (!created.has(scenario.seed)) { createSeed(scenario.seed, catalog); created.add(scenario.seed); }
        mkdirSync(directory, { recursive: true });
        const trace = await runScenarioA(scenario, { scenarioFile, catalog, directory: join(directory, 'run'), receipt, events, side, profilePool,
          workerStartedAt: WORKER_STARTED_AT, compileCache });
        const file = join(directory, values.gzip ? 'trace.json.gz' : 'trace.json');
        writeFileSync(file, evidenceBytes(file, stringifyExact(trace, 2) + '\n'), { flag: 'wx' });
        if (values.compact) compactRun(join(directory, 'run'));
        summary.push({ id: scenario.id, side, status: 'recorded', trace: file, outcomes: trace.calls.map(call => call.outcome.kind), app: appOutcome(join(directory, 'run')) });
      } catch (error) {
        summary.push({ id: scenario.id, side, status: 'runner-error', reason: String(error?.stack ?? error), app: appOutcome(join(directory, 'run')) });
      }
      process.stdout.write(JSON.stringify(summary.at(-1)).slice(0, 600) + '\n');
    }
  }
  if (values.compact) rmSync(compileCache, { recursive: true, force: true });
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ scenarioFile, inputSha256: sha256(readFileSync(scenarioFile)),
    build: receipt.job, runs: summary }, null, 2) + '\n');
  process.exitCode = summary.some(item => item.status === 'runner-error') ? 1 : 0;
  // The summary is final; a handle that would keep this worker alive is reported, not waited on.
  setTimeout(() => {
    process.stderr.write(`g3-run-a: still running 30s after summary.json; active: ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
    process.exit();
  }, 30_000).unref();
}
