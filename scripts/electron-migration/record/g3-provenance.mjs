// Recording provenance: which B (Host) code and runtime and which A (Tauri) build produced
// a G3 run. g3-batch writes RECORDING.json plus host-receipt.json once per output directory;
// every worker receipt points at RECORDING.json by sha256.
//   g3-recording/v2  A, A2 and B recorded into the same directory (--mode combined).
//   g3-recording/v3  only B recorded (--mode b-only); A/A2 come from A stores (--mode a-store,
//                    A-STORE.json g3-a-store/v1), each store receipt used is pinned by an
//                    a-refs/<side>/ reference (g3-a-ref/v1) holding the sha256 of the store
//                    identity and of the store worker receipt.
// g3-manifest seals these files and g3-report admits a compare only when its run has a
// complete recording receipt and each of its traces is listed in an admitted worker receipt
// (for v3 A/A2: an admitted store receipt reached through an intact reference, from a store
// with the same A build receipt, environment and scenario inputs as the recording).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inputDifference, scenarioDifference, scenarioEntries, storeScenarioInputs } from './g3-inputs.mjs';

export const RECORDING_SCHEMA = 'g3-recording/v2';
export const RECORDING_SCHEMA_B_ONLY = 'g3-recording/v3';
export const HOST_RECEIPT_SCHEMA = 'g3-host-receipt/v1';
export const RECORDING_FILE = 'RECORDING.json';
export const HOST_RECEIPT_FILE = 'host-receipt.json';
export const A_STORE_SCHEMA = 'g3-a-store/v1';
export const A_STORE_FILE = 'A-STORE.json';
export const RECORDER_RECEIPT_FILE = 'recorder-receipt.json';
export const A_REF_SCHEMA = 'g3-a-ref/v1';
/** Code whose bytes decide how a run is recorded; hashed into RECORDING.json / A-STORE.json. */
export const RUNNER_FILES = ['g3-batch.mjs', 'g3-worker.mjs', 'supervise.mjs', 'g3-run-a.mjs', 'g3-run-b.mjs', 'g3-harness.mjs',
  'g3-harness-server.mjs', 'g3-services.mjs', 'g3-wait.mjs', 'scenario-v0.mjs', 'json.mjs', 'g3-inputs.mjs'].map(name => `scripts/electron-migration/record/${name}`);

const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256File = file => hex(readFileSync(file));
const SHA = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const posix = value => value.split('\\').join('/');
const sorted = values => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function gitState(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const dirty = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean);
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), clean: dirty.length === 0, dirty };
}

/** Native addons the Host may load; the installed tree can change under a symlinked node_modules. */
function nativeModules(root, depth = 5) {
  const base = join(root, 'node_modules');
  if (!existsSync(base)) return { realpath: null, files: [] };
  const real = realpathSync(base);
  const files = [];
  const walk = (directory, level) => {
    if (level > depth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, level + 1);
      else if (entry.isFile() && entry.name.endsWith('.node')) files.push({ file: posix(relative(real, path)), sha256: sha256File(path) });
    }
  };
  walk(real, 0);
  return { realpath: real, files: files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)) };
}

/**
 * B side receipt: the Host is not compiled, so its "build" is the source revision plus the
 * runtime that executes it. Deterministic (no timestamps), so a rerun can prove equality.
 */
export function hostReceipt(root, { node = process.execPath } = {}) {
  const fileEntry = file => (existsSync(join(root, file)) ? { file, sha256: sha256File(join(root, file)) } : { file, sha256: null });
  const modules = nativeModules(root);
  return { schema: HOST_RECEIPT_SCHEMA, ...gitState(root),
    node: { execPath: node, version: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), sha256: sha256File(node) },
    entry: fileEntry('host/kernel/main.ts'), profile: fileEntry('host/profiles/desktop.json'),
    packageLock: fileEntry('package-lock.json'), installedLock: fileEntry('node_modules/.package-lock.json'),
    nodeModules: modules.realpath, nativeModules: modules.files };
}

/** A side: the instrumented Tauri build receipt, pinned by the sha256 of its bytes. */
export function aBuildEvidence(receiptFile) {
  const file = resolve(receiptFile);
  const bytes = readFileSync(file);
  const receipt = JSON.parse(bytes.toString('utf8'));
  return { file, sha256: hex(bytes), schema: receipt.schema ?? null, job: receipt.job ?? null, code: receipt.code ?? null,
    binarySha256: receipt.binarySha256 ?? null, submittedRevision: receipt.submittedRevision ?? null, identifier: receipt.identifier ?? null };
}

const runnerFiles = root => Object.fromEntries(RUNNER_FILES.map(file => [file, existsSync(join(root, file)) ? sha256File(join(root, file)) : null]));

/**
 * RECORDING.json body: recording identity only (no timestamps, no operational flags).
 * With `inputs` (b-only) the A build receipt is the one of the A stores and the per-suite
 * input fingerprint is pinned; the stores themselves are not identity (top-ups may be added).
 */
export function recordingIdentity({ root, git, host, aBuild, normalizerSha256, approvalsSha256, corpus, isolation, environment, inputs = null }) {
  return { schema: inputs ? RECORDING_SCHEMA_B_ONLY : RECORDING_SCHEMA, cwd: root,
    b: { head: git.head, tree: git.tree, clean: git.clean, dirty: git.dirty, hostReceipt: { file: HOST_RECEIPT_FILE, sha256: host.sha256 } },
    a: inputs ? { source: 'a-store', buildReceipt: aBuild } : { buildReceipt: aBuild },
    environment,
    rules: { normalizerSha256, approvalsSha256 },
    runner: { files: runnerFiles(root), isolation },
    corpus, ...(inputs ? { inputs } : {}) };
}

/** A-STORE.json body: who recorded the A/A2 takes with which A build, environment and scenario inputs. No B. */
export function aStoreIdentity({ root, git, recorder, aBuild, environment, inputs, isolation }) {
  return { schema: A_STORE_SCHEMA, cwd: root,
    recorder: { head: git.head, tree: git.tree, clean: git.clean, dirty: git.dirty, runtimeReceipt: { file: RECORDER_RECEIPT_FILE, sha256: recorder.sha256 } },
    a: { buildReceipt: aBuild }, environment,
    runner: { files: runnerFiles(root), isolation },
    inputs };
}

function aBuildDefects(a = {}) {
  const defects = [];
  if (!SHA.test(a.sha256 ?? '')) defects.push('a-build-receipt-sha256');
  else if (!a.file || !existsSync(a.file)) defects.push('a-build-receipt-missing');
  else if (sha256File(a.file) !== a.sha256) defects.push('a-build-receipt-changed');
  if (!SHA.test(a.binarySha256 ?? '')) defects.push('a-binary-sha256');
  if (a.code !== 0) defects.push('a-build-not-successful');
  return defects;
}

function runtimeReceiptDefects(directory, pinned, head, prefix) {
  const file = join(directory, pinned?.file ?? '');
  if (!SHA.test(pinned?.sha256 ?? '')) return [`${prefix}-sha256`];
  if (!pinned.file || !existsSync(file)) return [`${prefix}-missing`];
  if (sha256File(file) !== pinned.sha256) return [`${prefix}-changed`];
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  return receipt.schema !== HOST_RECEIPT_SCHEMA || receipt.head !== head || receipt.clean !== true || !SHA.test(receipt.node?.sha256 ?? '') ? [`${prefix}-content`] : [];
}

/** Identity, sha256 and missing or inconsistent provenance items of an A store; empty defects means usable. */
export function storeDefects(storeDir) {
  const file = join(storeDir, A_STORE_FILE);
  if (!existsSync(file)) return { identity: null, sha256: null, defects: ['a-store-missing'] };
  const bytes = readFileSync(file);
  let identity;
  try { identity = JSON.parse(bytes.toString('utf8')); } catch { return { identity: null, sha256: hex(bytes), defects: ['a-store-unreadable'] }; }
  const defects = [];
  if (identity.schema !== A_STORE_SCHEMA) defects.push('a-store-schema');
  const recorder = identity.recorder ?? {};
  if (!GIT_SHA.test(recorder.head ?? '')) defects.push('recorder-head');
  if (recorder.clean !== true) defects.push('recorder-tree-not-clean');
  defects.push(...runtimeReceiptDefects(storeDir, recorder.runtimeReceipt, recorder.head, 'recorder-receipt'));
  defects.push(...aBuildDefects(identity.a?.buildReceipt));
  if (typeof identity.environment?.TZ !== 'string') defects.push('environment');
  if (!identity.inputs?.suites) defects.push('inputs');
  return { identity, sha256: hex(bytes), defects };
}

/** A worker receipt that proves a clean worker exit and an admitted summary. */
const cleanReceipt = receipt => receipt?.admitted === true && receipt.process?.outcome === 'exited' && receipt.process?.stdio === 'closed'
  && receipt.process?.signal === null && [0, 1].includes(receipt.process?.code);
const windowOf = receipt => ({ startedAt: receipt.process?.startedAt ?? null, endedAt: receipt.process?.endedAt ?? null });

/** Admitted A/A2 worker receipts of an A store that point at its current A-STORE.json. */
export function storeReceipts(storeDir, storeSha256) {
  const out = [];
  for (const side of ['A', 'A2']) {
    const directory = join(storeDir, 'receipts', side);
    if (!existsSync(directory)) continue;
    for (const name of sorted(readdirSync(directory).filter(entry => entry.endsWith('.json')))) {
      const file = join(directory, name);
      const bytes = readFileSync(file);
      const receipt = JSON.parse(bytes.toString('utf8'));
      if (cleanReceipt(receipt) && receipt.recording?.sha256 === storeSha256) out.push({ side, file, sha256: hex(bytes), receipt });
    }
  }
  return out;
}

/** Pins one store receipt for a b-only run (rewritten when the receipt bytes changed since). */
export function writeARef(out, { side, storeDir, storeSha256, receiptFile, receiptSha256, receipt }) {
  const file = join(out, 'a-refs', side, `${storeSha256.slice(0, 12)}__${basename(receiptFile)}`);
  const text = JSON.stringify({ schema: A_REF_SCHEMA, side, shard: receipt.shard, scenarioFile: receipt.scenarioFile,
    store: { dir: storeDir, identity: { file: join(storeDir, A_STORE_FILE), sha256: storeSha256 } },
    receipt: { file: receiptFile, sha256: receiptSha256 }, traces: receipt.traces }, null, 2) + '\n';
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return file;
}

/** Why a reference's store receipt cannot be admitted for this recording; null if it can. */
function refProblem(ref, side, recording, store) {
  if (ref.schema !== A_REF_SCHEMA || ref.side !== side) return 'reference malformed';
  if (!store.identity || store.sha256 !== ref.store?.identity?.sha256 || ref.store.identity.file !== join(ref.store.dir, A_STORE_FILE)) return 'A store identity changed';
  const receiptFile = ref.receipt?.file ?? '';
  if (!receiptFile.startsWith(join(ref.store.dir, 'receipts', side) + '/')) return 'A store receipt outside its store';
  if (!existsSync(receiptFile) || sha256File(receiptFile) !== ref.receipt.sha256) return 'A store receipt changed';
  if (store.defects.length) return `A store defects: ${store.defects.join(',')}`;
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (!cleanReceipt(receipt) || receipt.side !== side || receipt.recording?.sha256 !== store.sha256) return 'A store receipt not admitted';
  if (recording?.schema !== RECORDING_SCHEMA_B_ONLY) return 'not a b-only recording';
  if (store.identity.a?.buildReceipt?.sha256 !== recording.a?.buildReceipt?.sha256) return 'A store has a different A build receipt';
  if (JSON.stringify(store.identity.environment) !== JSON.stringify(recording.environment)) return 'A store has a different environment';
  return null;
}

/** Why one store trace was recorded from other scenario inputs than this recording's; null if the same. */
function inputProblem(root, store, recording, scenarioFile, id) {
  store.scenarios ??= storeScenarioInputs(root, store.identity, store.dir) ?? false;
  const current = scenarioEntries(recording.inputs);
  const difference = store.scenarios && current
    ? scenarioDifference(store.scenarios[scenarioFile]?.[id], current[scenarioFile]?.[id])
    : inputDifference(store.identity.inputs, recording.inputs, scenarioFile);
  return difference ? `A store inputs differ for ${scenarioFile} ${id}: ${difference.join(',')}` : null;
}

/** Missing or inconsistent provenance items of a run directory; empty means the run is attributable. */
export function recordingDefects(root, runsDir) {
  const dir = isAbsolute(runsDir) ? runsDir : join(root, runsDir);
  const file = join(dir, RECORDING_FILE);
  if (!existsSync(file)) return { recording: null, defects: ['recording-receipt-missing'] };
  let recording;
  try { recording = JSON.parse(readFileSync(file, 'utf8')); } catch { return { recording: null, defects: ['recording-receipt-unreadable'] }; }
  const defects = [];
  if (![RECORDING_SCHEMA, RECORDING_SCHEMA_B_ONLY].includes(recording.schema)) defects.push('recording-schema');
  if (recording.schema === RECORDING_SCHEMA_B_ONLY) {
    if (recording.a?.source !== 'a-store') defects.push('a-source');
    if (!recording.inputs?.suites) defects.push('inputs');
    if (typeof recording.environment?.TZ !== 'string') defects.push('environment');
  }
  const b = recording.b ?? {}, a = recording.a?.buildReceipt ?? {};
  if (!GIT_SHA.test(b.head ?? '')) defects.push('b-head');
  if (b.clean !== true) defects.push('b-tree-not-clean');
  defects.push(...runtimeReceiptDefects(dir, b.hostReceipt, b.head, 'b-host-receipt'));
  defects.push(...aBuildDefects(a));
  return { recording, defects };
}

/**
 * Admitted traces of a run directory: absolute trace path → sha256, from worker receipts
 * that were admitted after a clean exit and that point at this RECORDING.json, and (b-only)
 * from A store receipts reached through intact a-refs. `windows` holds each admitted trace's
 * worker process window; `refused` names why a referenced store trace is not admitted.
 */
export function admittedTraces(root, runsDir) {
  const dir = isAbsolute(runsDir) ? runsDir : join(root, runsDir);
  const recordingFile = join(dir, RECORDING_FILE);
  const recordingSha = existsSync(recordingFile) ? sha256File(recordingFile) : null;
  const traces = {}, windows = {}, refused = {}, receipts = [], refs = [], stores = new Map(), sources = {};
  const admit = (receipt, through, check = null, source = null) => {
    for (const trace of receipt.traces ?? []) {
      const path = resolve(root, trace.file);
      const problem = check?.(trace);
      if (problem) { if (!through?.has(path)) { delete traces[path]; refused[path] = problem; } continue; }
      if (source) sources[path] = source;
      traces[path] = trace.sha256;
      windows[path] = windowOf(receipt);
      delete refused[path];
      if (through) through.add(path);
    }
  };
  const subdirectories = directory => (existsSync(directory)
    ? sorted(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) : []);
  const jsonFiles = directory => sorted(readdirSync(directory).filter(entry => entry.endsWith('.json')));
  const receiptsDir = join(dir, 'receipts');
  for (const side of subdirectories(receiptsDir)) {
    for (const name of jsonFiles(join(receiptsDir, side))) {
      const file = join(receiptsDir, side, name);
      const bytes = readFileSync(file);
      receipts.push({ file: posix(relative(root, file)), sha256: hex(bytes) });
      const receipt = JSON.parse(bytes.toString('utf8'));
      if (cleanReceipt(receipt) && recordingSha !== null && receipt.recording?.sha256 === recordingSha) admit(receipt);
    }
  }
  const refsDir = join(dir, 'a-refs');
  const refSides = subdirectories(refsDir);
  if (refSides.length) {
    let recording = null;
    try { recording = JSON.parse(readFileSync(recordingFile, 'utf8')); } catch { /* recordingDefects reports it */ }
    const admittedThroughRef = new Set();
    for (const side of refSides) {
      for (const name of jsonFiles(join(refsDir, side))) {
        const file = join(refsDir, side, name);
        const bytes = readFileSync(file);
        refs.push({ file: posix(relative(root, file)), sha256: hex(bytes) });
        const ref = JSON.parse(bytes.toString('utf8'));
        const storeDir = ref.store?.dir ?? '';
        if (!stores.has(storeDir)) stores.set(storeDir, { ...storeDefects(storeDir), dir: storeDir });
        const store = stores.get(storeDir);
        const problem = refProblem(ref, side, recording, store);
        if (!problem) {
          const receipt = JSON.parse(readFileSync(ref.receipt.file, 'utf8'));
          admit(receipt, admittedThroughRef, trace => inputProblem(root, store, recording, receipt.scenarioFile, trace.id), store.sha256);
          continue;
        }
        let current = [];
        try { current = JSON.parse(readFileSync(ref.receipt?.file, 'utf8')).traces ?? []; } catch { /* unreadable: the reference's copy names the traces */ }
        for (const trace of [...(ref.traces ?? []), ...current]) {
          const path = resolve(root, trace.file);
          if (!admittedThroughRef.has(path)) { delete traces[path]; refused[path] = problem; }
        }
      }
    }
  }
  const aStores = sorted(stores.keys()).filter(Boolean).map(storeDir => ({ dir: storeDir, sha256: stores.get(storeDir).sha256 }));
  return { traces, windows, refused, receipts, refs, aStores, sources };
}

/** The provenance a report needs for one run directory (plain data, safe for worker threads). */
export function runProvenance(root, runsDir) {
  const { recording, defects } = recordingDefects(root, runsDir);
  const { traces, windows, refused, receipts, refs, aStores, sources } = admittedTraces(root, runsDir);
  const dir = isAbsolute(runsDir) ? runsDir : join(root, runsDir);
  const recordingFile = join(dir, RECORDING_FILE);
  return { defects, traces, windows, refused, aSources: sources,
    recording: recording ? { file: posix(relative(root, recordingFile)), sha256: sha256File(recordingFile), schema: recording.schema ?? null,
      bHead: recording.b?.head ?? null, bClean: recording.b?.clean ?? null, hostReceiptSha256: recording.b?.hostReceipt?.sha256 ?? null,
      aBuildReceiptSha256: recording.a?.buildReceipt?.sha256 ?? null, aBinarySha256: recording.a?.buildReceipt?.binarySha256 ?? null,
      environment: recording.environment ?? null, aSource: recording.a?.source ?? 'recorded', aStores } : null,
    workerReceipts: { count: receipts.length, sha256: hex(JSON.stringify(receipts)) },
    aRefs: { count: refs.length, sha256: hex(JSON.stringify(refs)) } };
}

/** Why a compare's traces cannot be attributed to a recorded, provenance-complete run; null if they can. */
export function attributionProblem(root, provenance, evidence) {
  if (provenance.defects.length) return `recording receipt incomplete: ${provenance.defects.join(',')}`;
  for (const side of ['A', 'B', 'A2']) {
    if (!evidence[side]) continue;
    const path = resolve(root, evidence[side].file);
    const listed = provenance.traces[path];
    if (!listed && provenance.refused?.[path]) return `${side} trace not admitted: ${provenance.refused[path]}`;
    if (!listed) return `${side} trace has no admitted worker receipt`;
    if (listed !== evidence[side].sha256) return `${side} trace differs from its worker receipt`;
  }
  return null;
}
