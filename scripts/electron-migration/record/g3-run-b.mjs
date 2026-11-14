#!/usr/bin/env node
// G3 B side: the real TS Host process (host/kernel/main.ts) with the official desktop
// profile, driven over the same handshake/invoke protocol Electron's HostSupervisor uses
// (electron/shell/host.ts:96-110, electron/main.ts:232-242). There is no Electron main
// here, so every shell-request is answered with an explicit error and recorded in the
// trace (`shellRequests`); a step that depends on main is therefore visible, not faked.
//   node scripts/electron-migration/record/g3-run-b.mjs SCENARIO_FILE OUTPUT_DIR [--scenario ID ...]
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { evidenceBytes, parseExact, stringifyExact } from './json.mjs';
import { executeScenario, prepareScenarioRun, usesSeed, validateScenario } from './scenario-v0.mjs';
import { waitForEvent } from './g3-wait.mjs';
import { databaseFingerprint, quiesce } from './g3-quiet.mjs';
import { mcpBindingKinds, seedBindingKinds, serviceGap, startScenarioServices, stepTimeout, usesMcp } from './g3-services.mjs';
import { runStartup } from './g3-startup.mjs';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const HOST_MAIN = join(REPO, 'host/kernel/main.ts');
const PROFILE = join(REPO, 'host/profiles/desktop.json');
const TAURI_DIR = join(REPO, 'resources/app');
const READY_MS = 120_000;
const STEP_MS = 60_000;
/** Same identifier as the A build (D-156), so both sides use `<copy>/app-data/<identifier>/...`. */
export const IDENTIFIER = 'com.deepstudent.differential';
const SUPPORTED_STEP_KEYS = new Set(['cmd', 'args', 'expect', 'waitAfter', 'waitBefore']);
/** Scenario keys executeScenario does not honour (steps run one after another): the take would be another scenario. */
const UNSUPPORTED_SCENARIO_KEYS = ['concurrent'];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Reason this B runner cannot execute the scenario faithfully, or null. */
export function unsupported(scenario) {
  const keys = UNSUPPORTED_SCENARIO_KEYS.filter(key => Object.hasOwn(scenario, key));
  if (keys.length) return `scenario uses ${keys.join(', ')}`;
  for (const [index, step] of scenario.steps.entries()) {
    const extra = Object.keys(step).filter(key => !SUPPORTED_STEP_KEYS.has(key));
    if (extra.length) return `step ${index} uses ${extra.join(', ')}`;
  }
  return null;
}

class HostProcess {
  constructor(env, { stepMs = STEP_MS } = {}) {
    this.stepMs = stepMs;
    this.received = [];
    this.events = [];
    this.shellRequests = [];
    this.stderr = '';
    this.waiters = new Map();
    this.child = fork(HOST_MAIN, [`--tauri-dir=${TAURI_DIR}`], { env, serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.exited = new Promise(resolve => this.child.on('exit', (code, signal) => resolve({ code, signal })));
    this.child.on('message', message => this.onMessage(message));
  }

  onMessage(message) {
    if (message.kind === 'event') {
      this.events.push({ event: message.event, payloadRaw: message.payloadJson ?? JSON.stringify(message.payload ?? null) });
    } else if (message.kind === 'shell-request') {
      this.shellRequests.push({ op: message.op, argsRaw: stringifyExact(message.args ?? null) });
      this.child.send({ kind: 'shell-result', id: message.id, ok: false, error: `G3 B runner has no Electron main: ${message.op}` });
    } else if (message.kind === 'result' && this.waiters.has(message.id)) {
      const resolveResult = this.waiters.get(message.id);
      this.waiters.delete(message.id);
      resolveResult(message);
    } else this.received.push(message);
  }

  async ready(handshake) {
    this.child.send(handshake);
    const deadline = Date.now() + READY_MS;
    for (;;) {
      const fatal = this.received.find(message => message.kind === 'fatal');
      if (fatal) throw new Error(`Host fatal: ${fatal.message}\n${this.stderr}`);
      if (this.received.some(message => message.kind === 'ready')) return;
      if (this.child.exitCode !== null) throw new Error(`Host exited before ready (${this.child.exitCode})\n${this.stderr}`);
      if (Date.now() > deadline) throw new Error(`Host not ready within ${READY_MS}ms\n${this.stderr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  }

  invoke(id, cmd, argsRaw) {
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${cmd}: no Host result within ${this.stepMs}ms (handler panic or hang)\n${this.stderr.slice(-4000)}`));
      }, this.stepMs);
      this.waiters.set(id, message => { clearTimeout(timer); resolveResult(message); });
      this.child.send({ kind: 'invoke', id, cmd, args: JSON.parse(argsRaw), argsJson: argsRaw, source: { window: 'main', webview: 'main' } });
    });
  }

  async shutdown() {
    if (this.child.exitCode === null && this.child.connected) this.child.send({ kind: 'shutdown' });
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 30_000);
    const exit = await this.exited;
    clearTimeout(timer);
    return exit;
  }
}

/** --compact: after the trace (lossless DB snapshot) is written, drop this run's seed-copy directories; logs stay. */
function compactRun(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(directory, entry.name), { recursive: true });
  }
}

/** Run one scenario on a fresh Host process over a fresh X3 seed copy. */
export async function runScenarioB(scenario, { scenarioFile, catalog, directory, workerStartedAt = null, compileCache, startupLimits, llmPort }) {
  validateScenario(scenario);
  const startedAt = new Date().toISOString();
  const inputSha256 = sha256(readFileSync(scenarioFile));
  const run = await prepareScenarioRun(scenario, { catalog, directory, ...(compileCache ? { compileCache } : {}) });
  const appDataDir = join(run.seed.dataDir, IDENTIFIER);
  mkdirSync(appDataDir, { recursive: true });
  const { snapshotDirectory } = await import('../../../host/e2e/data-compat/__fixtures__/database-state.ts');
  const env = { ...run.env, DS_MIGRATIONS_DIR: join(TAURI_DIR, 'migrations') };
  const services = await startScenarioServices(scenario, scenarioFile, llmPort === undefined ? {} : { llmPort });
  const host = new HostProcess(services.appEnv(env), { stepMs: stepTimeout(scenario, STEP_MS) });
  let exit = null;
  try {
    await host.ready({ kind: 'handshake', protocol: 1, appDataDir, appVersion: JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8')).version,
      platform: 'linux', debug: true, profile: PROFILE });
    const readyAt = Date.now();
    let sequence = 0, step = -1;
    const toOutcome = message => ({ kind: message.ok ? 'result' : 'error',
      raw: message.json ?? JSON.stringify(message.ok ? message.value ?? null : message.error ?? null) });
    // G3-STARTUP (g3-startup.mjs): same settle and setup as A; the Host's boot events (heard from
    // fork) stay in `startup`, the scenario's lists start at the boundary like A's.
    const fingerprint = () => databaseFingerprint(run.seed.directory);
    const startup = await runStartup({ events: () => host.events, fingerprint, readyAt,
      invoke: async (command, argsRaw) => toOutcome(await host.invoke('g3b-setup', command, argsRaw)), ...(startupLimits ? { limits: startupLimits } : {}) });
    const scenarioEvents = () => host.events.slice(startup.boundary);
    const trace = await executeScenario(scenario, {
      bindings: run.bindings ? { ...services.bindings, ...run.bindings } : services.bindings,
      eventCount: () => scenarioEvents().length,
      wait: (spec, { step, phase, since }) => waitForEvent(spec, scenarioEvents, `step ${step} ${phase}`, { since }),
      async invoke(cmd, argsRaw) {
        step += 1;
        return toOutcome(await host.invoke(`g3b-${sequence++}`, cmd, argsRaw));
      },
      capture: async (_, { phase }) => {
        const settled = await services.settle(phase);
        const quiet = await quiesce({ events: scenarioEvents, fingerprint,
          step: scenario.steps[step] ?? null, next: scenario.steps[step + 1] ?? null });
        return { events: structuredClone(scenarioEvents()), databases: snapshotDirectory(run.seed.directory), quiet, ...(settled ? { services: settled } : {}) };
      },
    });
    exit = await host.shutdown();
    if (exit.code !== 0) throw new Error(`Host shutdown exit ${exit.code}/${exit.signal}\n${host.stderr.slice(-4000)}`);
    // N-014: clock readings of this take (and of the seed built by its worker) fall inside this window.
    const recording = { workerStartedAt, startedAt, endedAt: new Date().toISOString() };
    return { ...trace, side: 'B', inputSha256, recording, startup: structuredClone(startup.record), finalDatabases: snapshotDirectory(run.seed.directory),
      eventScope: { kind: 'all' }, ...services.record(), shellRequests: host.shellRequests, hostExit: exit,
      host: { entry: 'host/kernel/main.ts', profile: 'host/profiles/desktop.json', appDataDir, transport: 'child_process.fork ipc (advanced)' } };
  } finally {
    if (!exit) { host.child.kill('SIGKILL'); await host.exited; }
    await services.stop();
    writeFileSync(join(directory, 'host.stderr.log'), host.stderr);
  }
}

const WORKER_STARTED_AT = new Date().toISOString();

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { scenario: { type: 'string', multiple: true }, gzip: { type: 'boolean' }, compact: { type: 'boolean' } } });
  const [scenarioFile, outputDirectory] = positionals;
  if (!outputDirectory || positionals.length !== 2) throw new Error('usage: g3-run-b.mjs SCENARIO_FILE OUTPUT_DIR [--scenario ID ...]');
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
  const mcp = selected.some(usesMcp) ? await mcpBindingKinds() : null;
  const summary = [];
  for (const scenario of selected) {
    const reason = unsupported(scenario) ?? serviceGap(scenario, { mcp, seed: usesSeed(scenario) ? await seedBindingKinds(scenario.seed) : null })
      ?? (SEED_NAMES.includes(scenario.seed) ? null : `seed ${scenario.seed} is not defined in scenario-seeds.ts SEED_NAMES`);
    if (reason) { summary.push({ id: scenario.id, status: 'unsupported', reason }); continue; }
    const directory = join(output, scenario.id, 'B');
    try {
      if (!created.has(scenario.seed)) { createSeed(scenario.seed, catalog); created.add(scenario.seed); }
      mkdirSync(directory, { recursive: true });
      const trace = await runScenarioB(scenario, { scenarioFile, catalog, directory: join(directory, 'run'), workerStartedAt: WORKER_STARTED_AT, compileCache });
      const file = join(directory, values.gzip ? 'trace.json.gz' : 'trace.json');
      writeFileSync(file, evidenceBytes(file, stringifyExact(trace, 2) + '\n'), { flag: 'wx' });
      if (values.compact) compactRun(join(directory, 'run'));
      summary.push({ id: scenario.id, status: 'recorded', trace: file, outcomes: trace.calls.map(call => call.outcome.kind),
        shellRequests: trace.shellRequests.length });
    } catch (error) {
      summary.push({ id: scenario.id, status: 'runner-error', reason: String(error?.stack ?? error) });
    }
    process.stdout.write(JSON.stringify(summary.at(-1)).slice(0, 400) + '\n');
  }
  if (values.compact) rmSync(compileCache, { recursive: true, force: true });
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ scenarioFile, inputSha256: sha256(readFileSync(scenarioFile)), runs: summary }, null, 2) + '\n');
  process.exitCode = summary.some(item => item.status === 'runner-error') ? 1 : 0;
  // The summary is final; a handle that would keep this worker alive is reported, not waited on.
  setTimeout(() => {
    process.stderr.write(`g3-run-b: still running 30s after summary.json; active: ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
    process.exit();
  }, 30_000).unref();
}
