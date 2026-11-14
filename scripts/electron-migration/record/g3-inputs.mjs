// Scenario inputs of a G3 take (g3-inputs/v2), fingerprinted so A/A2 recorded once (A store)
// can be compared with B recorded later from another tree only when both drove the same input.
// Per scenario: its definition, its seed's content, its scripted LLM responses, the code the A
// process can execute for it, the files that process serves or copies, the frontend event list
// it subscribes to, the A worker command, the node runtime and packages that code reaches, the
// pinned environment and the repository files it names.
// The code is the g3-slice.mjs declaration slice of g3-run-a.mjs (the A process entry) with the
// services that scenario's process starts. What only B, compare or report run is not on it, so
// editing that never invalidates an A take (W13-PROGRESS.md「A 指纹 v2」: rules, proof, limits).
// Seeds are fingerprinted by content (X3 logical snapshot plus non-database files), not by
// source: the generator imports Host product code. Seeds embed the build clock (SQLite
// datetime('now') defaults); only cells equal to that clock are masked.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix as posixPath, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseExact, stringifyExact } from './json.mjs';
import { mcpLaunch } from './g3-services.mjs';
import { arrayText, evaluateSlice, literalStrings, sliceFiles, sliceProgram } from './g3-slice.mjs';

export const INPUTS_SCHEMA = 'g3-inputs/v2';
const RECORD = 'scripts/electron-migration/record';
/** The A process entry; g3-batch.mjs builds its command line, g3-worker.mjs the namespace it runs in. */
export const A_ENTRY = `${RECORD}/g3-run-a.mjs`;
const BATCH = `${RECORD}/g3-batch.mjs`;
const WORKER = `${RECORD}/g3-worker.mjs`;
export const SEED_MODULE = 'host/e2e/data-compat/__fixtures__/scenario-seeds.ts';
/** Loaded by SEED_MODULE; the recorder imports its seedBindings (`${seed.*}`) directly, so it is contained the same way. */
export const SEED_BINDINGS_MODULE = 'host/e2e/data-compat/__fixtures__/a-produced-seeds.ts';
/** seedBindings counts by what it returns for a seed (seedDigests `bindings`, per scenario that reads `${seed.*}`). */
export const SEED_BINDINGS_COVERED = ['seedBindings'];
const SNAPSHOT_MODULE = 'host/e2e/data-compat/__fixtures__/database-state.ts';
/** Service modules g3-services.mjs imports; a scenario's code holds only those its process starts. */
export const SERVICE_MODULES = {
  llm: 'host/e2e/streaming/wave0/llm-service.ts',
  cloud: 'host/plugins/sync-providers/equivalence/__fixtures__/cloud-service.ts',
  mcp: 'host/plugins/mcp/equivalence/mcp-service.ts',
};
/**
 * The seed generator counts by what it builds: createSeed by the seed's content, SEED_NAMES only
 * by whether the scenario's seed is in it (createSeed refuses other names and the refusal is the
 * seed digest). Its product imports are not followed; their loading must leave the process as it
 * was (g3-slice.test.mjs checks it). The rest of it that A runs (resolveSeed, copySeed…) is code.
 */
export const SEED_COVERED = ['createSeed', 'SEED_NAMES'];
/** Computed `new URL(…, import.meta.url)` file lists, read from the module that declares them. */
export const RESOURCE_LISTS = { [SERVICE_MODULES.mcp]: 'STDIO_SERVER_FILES' };
/** Resources that run as processes of their own (spawned by a service): sliced as program entries. */
export const PROGRAMS = ['host/plugins/mcp/equivalence/stdio-server.ts'];
/** What frontendEvents reads; extracted from a commit to recompute an old store's event list. */
const EVENT_SOURCES = ['contracts/ipc', 'src'];
export const DEFAULT_ENVIRONMENT = { TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = value => value.split('\\').join('/');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const union = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort(byName);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function pinnedEnvironment({ tz, locale } = {}) {
  return { TZ: tz ?? DEFAULT_ENVIRONMENT.TZ, LANG: locale ?? DEFAULT_ENVIRONMENT.LANG, LC_ALL: locale ?? DEFAULT_ENVIRONMENT.LC_ALL };
}

/** The worker environment: inherited, minus LANGUAGE (it outranks LC_ALL for messages), plus the pinned values. */
export function workerEnvironment(environment, base = process.env) {
  const { LANGUAGE: _language, ...rest } = base;
  return { ...rest, ...environment };
}

/** `host/plugins/<domain>/…` → domain; otherwise the top-level area (platform, kernel, e2e, electron, fixtures). */
export function domainOf(file) {
  const parts = posix(file).split('/');
  if (parts[0] === 'host' && parts[1] === 'plugins') return parts[2];
  return parts[0] === 'host' ? parts[1] : parts[0];
}

const IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
/**
 * Whole-file relative-import closure of `entries` (static, dynamic and type-only imports); a
 * missing file is listed with sha256 null. Files in `boundary` (other than the entries) are
 * neither listed nor followed. Test trees copy the seed generator with it.
 */
export function importClosure(root, entries, boundary = []) {
  const seen = new Map();
  const stop = new Set(boundary.filter(file => !entries.includes(file)));
  const visit = file => {
    if (seen.has(file) || stop.has(file)) return;
    const absolute = join(root, file);
    if (!existsSync(absolute)) { seen.set(file, null); return; }
    const bytes = readFileSync(absolute);
    seen.set(file, sha256(bytes));
    for (const match of bytes.toString('utf8').matchAll(IMPORT)) {
      const target = posix(relative(root, resolve(dirname(absolute), match[1])));
      if (!target.startsWith('../')) visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  const files = [...seen].sort(([a], [b]) => byName(a, b)).map(([file, digest]) => ({ file, sha256: digest }));
  return { sha256: sha256(JSON.stringify(files)), files };
}

/** g3-services.mjs decides the same way which services a scenario starts. */
export function suiteUses(suite) {
  const seeds = new Set(), services = new Set();
  for (const scenario of suite?.scenarios ?? []) {
    if (typeof scenario?.seed === 'string') seeds.add(scenario.seed);
    const steps = stringifyExact(scenario?.steps ?? []);
    if (scenario?.llm !== undefined || steps.includes('${llm.') || steps.includes('${provider.')) services.add('llm');
    if (steps.includes('${cloud.') || steps.includes('${mock.webdav.')) services.add('cloud');
    if (steps.includes('${mcp.')) services.add('mcp');
  }
  return { seeds: [...seeds].sort(byName), services: [...services].sort(byName) };
}

/**
 * Launch values that reach a scenario's inputs besides source: the MCP placeholders carry the
 * runner's node path and the fixed port and directory (g3-services.mjs), so an A store recorded
 * with another node is not the same input. The batch spawns its runners with its own node.
 */
export const currentLaunch = () => ({ mcp: { ...mcpLaunch(process.execPath), nodeVersion: process.version } });

const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
/** Locked version and integrity of each package the slice's externals (`specifier#name`) reach; `node:` modules are the node version's. */
function packageVersions(read, externals) {
  const names = [...new Set(externals.map(item => item.slice(0, item.lastIndexOf('#'))).filter(item => !item.startsWith('node:')).map(packageName))].sort(byName);
  if (!names.length) return {};
  let lock = null;
  try { lock = JSON.parse(read('package-lock.json')?.toString('utf8') ?? 'null'); } catch { lock = null; }
  return Object.fromEntries(names.map(name => {
    const entry = lock?.packages?.[`node_modules/${name}`];
    return [name, entry ? `${entry.version}${entry.integrity ? ` ${entry.integrity}` : ''}` : null];
  }));
}

export const unitKey = services => ['a', ...services].join('+');
/** The g3-slice slice of A_ENTRY for a process that starts `services` (the other services' modules are boundaries). */
export function aSlice(read, services) {
  const boundaries = Object.fromEntries(Object.entries(SERVICE_MODULES).filter(([name]) => !services.includes(name)).map(([name, file]) => [file, name]));
  const resources = Object.fromEntries(Object.entries(RESOURCE_LISTS).map(([file, name]) => [file,
    () => literalStrings(read, file, name).map(item => posixPath.join(posixPath.dirname(file), item))]));
  return sliceProgram({ read, entries: [{ file: A_ENTRY, program: true }], boundaries, contained: [SEED_MODULE, SEED_BINDINGS_MODULE],
    stop: { [SEED_MODULE]: SEED_COVERED, [SEED_BINDINGS_MODULE]: SEED_BINDINGS_COVERED }, resources, followContained: true });
}

/**
 * What the A process can execute for a scenario whose process starts `services`: its slice
 * (aSlice), the files it serves or copies by URL (bytes), the programs among them (their own
 * slices) and the packages all of that reaches.
 */
export function aUnit(read, services) {
  const slice = aSlice(read, services);
  const externals = slice.files.flatMap(item => item.externals ?? []);
  const unit = { code: sliceFiles(slice), resources: {}, programs: {} };
  for (const file of slice.resources) {
    const bytes = read(file);
    unit.resources[file] = bytes ? sha256(bytes) : null;
    if (!PROGRAMS.includes(file)) continue;
    const program = sliceProgram({ read, entries: [{ file, program: true }] });
    unit.programs[file] = sliceFiles(program);
    externals.push(...program.files.flatMap(item => item.externals ?? []));
  }
  unit.packages = packageVersions(read, externals);
  return { ...unit, sha256: sha256(JSON.stringify(unit)) };
}

/**
 * The A worker command: g3-batch.mjs's A/A2 argument array (tokens) and the namespace wrapper and
 * init around it. Throws when that array cannot be found, unless `strict` is false (an old
 * commit's: `unavailable:…`, never equal to a found one).
 */
export function aLaunch(read, isolation, { strict = true } = {}) {
  let argv;
  try { argv = arrayText(read, BATCH, A_ENTRY); } catch (error) {
    if (strict) throw error;
    return `unavailable:${error.message}`;
  }
  return sha256(JSON.stringify({ argv, isolation: isolation ?? null }));
}

/** g3-worker.mjs's namespace wrapper and init in the tree at `root`, as g3-batch pins them (`runner.isolation`). */
export async function treeIsolation(root) {
  const { NAMESPACE, NAMESPACE_INIT } = await import(pathToFileURL(join(root, WORKER)).href);
  return { wrapper: NAMESPACE.slice(0, NAMESPACE.indexOf('-c')), init: NAMESPACE_INIT };
}

/**
 * The event list g3-run-a.mjs subscribes to, computed by `read`'s own frontendEvents over the
 * contracts/ipc and src of the tree at `root`: sha256, or `unavailable:…` (the A runner fails then too).
 */
export function eventsDigest(read, root) {
  const reason = error => `unavailable:${error?.code ?? String(error?.message ?? error).replaceAll(root, '<root>')}`;
  let frontendEvents;
  try { ({ frontendEvents } = evaluateSlice(read, A_ENTRY, ['frontendEvents'])); } catch (error) { return reason(error); }
  if (typeof frontendEvents !== 'function') return 'unavailable:no frontendEvents';
  try { return sha256(JSON.stringify(frontendEvents(...EVENT_SOURCES.map(path => join(root, path))))); } catch (error) { return reason(error); }
}

const CLOCK_TEXT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
/** A cell whose value is a reading of the clock during [from, to] (UTC text, epoch ms or epoch s). */
function clockCell(cell, low, high) {
  if (cell?.storageClass === 'text') {
    const match = CLOCK_TEXT.exec(cell.value);
    if (!match) return false;
    const zone = match[4] ? match[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z';
    const time = Date.parse(`${match[1]}T${match[2]}${(match[3] ?? '').slice(0, 4)}${zone}`);
    return time >= low && time <= high;
  }
  if (cell?.storageClass === 'integer') {
    const value = Number(cell.value);
    return (value >= low && value <= high) || (value * 1000 >= low && value * 1000 <= high);
  }
  return false;
}

/**
 * Content digest of one generated seed directory: the X3 snapshot of every database with
 * cells equal to the build clock (`window` = {from, to} in ms, widened to whole seconds)
 * replaced by a placeholder, plus every other file's bytes and every directory name.
 */
export async function seedDirectoryDigest(root, directory, window) {
  const { snapshotDirectory, enumerateDatabases } = await import(pathToFileURL(join(root, SNAPSHOT_MODULE)).href);
  const low = Math.floor(window.from / 1000) * 1000 - 1000, high = window.to + 1000;
  const state = snapshotDirectory(directory);
  const clockCells = {};
  for (const [db, database] of Object.entries(state.databases)) {
    for (const [table, content] of Object.entries(database.tables)) {
      for (const row of content.rows) {
        for (const [column, cell] of Object.entries(row.values)) {
          if (!clockCell(cell, low, high)) continue;
          row.values[column] = { storageClass: cell.storageClass, value: '<build-clock>' };
          const key = `${db}|${table}.${column}`;
          clockCells[key] = (clockCells[key] ?? 0) + 1;
        }
      }
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(state));
  digestSeedFiles(digest, directory, new Set(enumerateDatabases(directory)));
  return { sha256: digest.digest('hex'), clockCells: Object.fromEntries(Object.entries(clockCells).sort(([a], [b]) => byName(a, b))) };
}

/**
 * Feeds `digest` every entry under `directory` but the `databases` (relative paths), in name
 * order: directories by name, files by bytes, links by their text, anything else by name.
 */
export function digestSeedFiles(digest, directory, databases = new Set()) {
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name))) {
      const path = join(current, entry.name), name = posix(relative(directory, path));
      if (entry.isDirectory()) { digest.update(`d:${name}\n`); walk(path); continue; }
      if (databases.has(name)) continue;
      // A link is never followed (its target may lie outside the seed; backup README §4.5); a
      // FIFO, socket or device has no content (reading one blocks).
      if (entry.isSymbolicLink()) digest.update(`l:${name}:${readlinkSync(path)}\n`);
      else if (entry.isFile()) digest.update(`f:${name}:`).update(readFileSync(path)).update('\n');
      else digest.update(`o:${name}\n`);
    }
  };
  walk(directory);
  return digest;
}

/**
 * Builds each named seed once with this tree's generator (as the runners do) and digests it.
 * A seed the generator refuses is recorded with its refusal (sha256 null): the runners fail
 * those scenarios the same way, and a later generator that builds it changes the fingerprint.
 * A seed with `${seed.*}` values (SEED_BINDINGS_MODULE seedBindings) also lists their digest
 * as `bindings`, for a copy at `<seed>`.
 */
export async function seedDigests(root, names) {
  const { createSeed } = await import(pathToFileURL(join(root, SEED_MODULE)).href);
  const bindingsOf = existsSync(join(root, SEED_BINDINGS_MODULE))
    ? (await import(pathToFileURL(join(root, SEED_BINDINGS_MODULE)).href)).seedBindings : undefined;
  const catalog = mkdtempSync(join(tmpdir(), 'g3-seed-'));
  try {
    const out = {};
    for (const name of [...new Set(names)].sort(byName)) {
      const from = Date.now();
      let seed;
      try { seed = createSeed(name, catalog); } catch (error) {
        out[name] = { sha256: null, unavailable: String(error?.message ?? error).replaceAll(catalog, '<catalog>') };
        continue;
      }
      out[name] = await seedDirectoryDigest(root, seed.directory, { from, to: Date.now() });
      const bindings = typeof bindingsOf === 'function' ? bindingsOf(name, '<seed>') : null;
      if (bindings) out[name].bindings = sha256(stringifyExact(bindings));
    }
    return out;
  } finally { rmSync(catalog, { recursive: true, force: true }); }
}

const FIXTURE_PATH = /^(?:fixtures|host|src|src-tauri|scripts|tests)\/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+$/;
const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
};
const readsSeed = scenario => typeof scenario.seed === 'string' && stringifyExact(scenario.steps ?? null).includes('${seed.');
/** g3-run-a subscribes to the event list only for scenarios that capture events (a malformed capture counts as capturing). */
const capturesEvents = scenario => !(scenario?.capture && typeof scenario.capture === 'object' && !scenario.capture.events);

/**
 * Per scenario: what decides its takes — its own definition, its seed's content (and the seed's
 * `${seed.*}` values when it reads them: `seedBindings`, absent otherwise), its scripted
 * LLM responses (sidecar entry `llm ?? id`), the A code unit its process runs (`unit`, digest
 * `a`; units are shared and listed once), the event list when it captures events (or when the
 * list cannot be computed: then no take runs), the A launch, the node version, the pinned
 * environment and repository files it names. `read(path)` returns bytes or null.
 */
export function scenarioInputs({ read, files, environment, seeds, events = null, launch = null, isolation = null, node = null, strict = true }) {
  const units = {}, scenarios = {};
  const launchA = aLaunch(read, isolation, { strict });
  const unitOf = services => {
    const key = unitKey(services);
    units[key] ??= aUnit(read, services);
    return key;
  };
  for (const file of [...files].sort(byName)) {
    const bytes = read(file);
    if (!bytes) continue;
    let suite = null;
    try { suite = parseExact(bytes.toString('utf8')); } catch { continue; }
    const sidecarBytes = read(file.replace(/\.json$/, '.provider.json'));
    let sidecar = null;
    try { sidecar = sidecarBytes ? parseExact(sidecarBytes.toString('utf8')) : null; } catch { sidecar = { '<unparseable>': sha256(sidecarBytes) }; }
    // g3-run-a starts a throwaway MCP service (mcpBindingKinds) in every shard that holds an MCP scenario.
    const suiteMcp = suiteUses(suite).services.includes('mcp');
    const entries = {};
    for (const scenario of suite?.scenarios ?? []) {
      if (typeof scenario?.id !== 'string') continue;
      const uses = suiteUses({ scenarios: [scenario] });
      const unit = unitOf([...new Set([...uses.services, ...(suiteMcp ? ['mcp'] : [])])].sort(byName));
      const script = typeof scenario.llm === 'string' ? scenario.llm : scenario.id;
      const named = [...new Set(strings(scenario).filter(text => FIXTURE_PATH.test(text)))].sort(byName);
      const entry = {
        scenario: sha256(stringifyExact(scenario)),
        seed: typeof scenario.seed === 'string' ? seeds[scenario.seed]?.sha256 ?? null : null,
        llm: uses.services.includes('llm') && sidecar && Object.hasOwn(sidecar, script) ? sha256(stringifyExact(sidecar[script])) : null,
        unit,
        a: units[unit].sha256,
        events: capturesEvents(scenario) || String(events).startsWith('unavailable:') ? events : null,
        environment,
        launch: { a: launchA, ...(uses.services.includes('mcp') ? { mcp: launch?.mcp ?? null } : {}) },
        node,
        files: Object.fromEntries(named.map(path => { const content = read(path); return [path, content ? sha256(content) : null]; })),
        ...(readsSeed(scenario) ? { seedBindings: seeds[scenario.seed]?.bindings ?? null } : {}),
      };
      entries[scenario.id] = { ...entry, digest: sha256(JSON.stringify(entry)) };
    }
    scenarios[file] = entries;
  }
  return { units, scenarios };
}

/** Per suite: its bytes, its provider sidecar and its scenarios' digests (the fallback when per-scenario inputs are unavailable). */
function suiteFingerprints(read, files, scenarios) {
  const out = {};
  for (const file of [...files].sort(byName)) {
    const bytes = read(file);
    if (!bytes) continue;
    const sidecar = read(file.replace(/\.json$/, '.provider.json'));
    const entry = { sha256: sha256(bytes), provider: sidecar ? sha256(sidecar) : null,
      scenarios: sha256(JSON.stringify(Object.fromEntries(Object.entries(scenarios[file] ?? {}).map(([id, item]) => [id, item.digest])))) };
    out[file] = { ...entry, digest: sha256(JSON.stringify(entry)) };
  }
  return out;
}

const readTree = root => path => {
  try { return readFileSync(join(root, path)); } catch { return null; }
};

/**
 * The input fingerprint of every suite of the corpus in the tree at `root` (selection-independent,
 * deterministic). `seeds: false` skips building seeds (every seed component is then null).
 */
export async function inputFingerprint(root, files, environment, launch = currentLaunch(), { seeds: build = true } = {}) {
  const read = readTree(root);
  const used = new Set();
  for (const file of files) for (const seed of suiteUses(JSON.parse(readFileSync(join(root, file), 'utf8'))).seeds) used.add(seed);
  const seeds = build ? await seedDigests(root, [...used]) : {};
  const events = eventsDigest(read, root);
  const isolation = await treeIsolation(root);
  const node = process.version;
  const { units, scenarios } = scenarioInputs({ read, files, environment, seeds, events, launch, isolation, node });
  return { schema: INPUTS_SCHEMA, environment, seeds, launch, events, isolation, node, units, suites: suiteFingerprints(read, files, scenarios), scenarios };
}

const expanded = new WeakMap();
/** Per-file per-scenario entries of a v2 fingerprint with their code unit attached (`detail`), for scenarioDifference; null for other schemas. */
export function scenarioEntries(inputs) {
  if (inputs?.schema !== INPUTS_SCHEMA || !inputs.scenarios) return null;
  if (!expanded.has(inputs)) {
    expanded.set(inputs, Object.fromEntries(Object.entries(inputs.scenarios).map(([file, entries]) => [file,
      Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { ...entry, detail: inputs.units?.[entry.unit] ?? null }]))])));
  }
  return expanded.get(inputs);
}

/** Reader of one commit through git (path → bytes or null, cached); null when `root` cannot read that commit. */
export function gitReader(root, commit) {
  const git = args => spawnSync('git', ['--no-optional-locks', ...args], { cwd: root, maxBuffer: 1 << 30 });
  const tree = git(['ls-tree', '-r', '--name-only', commit]);
  if (tree.status !== 0) return null;
  const present = new Set(tree.stdout.toString('utf8').split('\n').filter(Boolean));
  const cache = new Map();
  const read = path => {
    if (!present.has(path)) return null;
    if (!cache.has(path)) {
      const shown = git(['show', `${commit}:${path}`]);
      cache.set(path, shown.status === 0 ? shown.stdout : null);
    }
    return cache.get(path);
  };
  read.has = prefix => present.has(prefix) || [...present].some(path => path.startsWith(`${prefix}/`));
  return read;
}

/** Extracts `paths` (the whole tree when null) of a commit (40-hex) into a new temporary directory; the caller removes it. */
export function extractTree(root, commit, paths = null) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`extractTree: ${commit} is not a commit id`);
  const directory = mkdtempSync(join(tmpdir(), 'g3-tree-'));
  if (paths?.length === 0) return directory;
  const quoted = (paths ?? []).map(path => `'${path.replaceAll("'", "'\\''")}'`).join(' ');
  const result = spawnSync('sh', ['-c', `git --no-optional-locks archive --format=tar ${commit} ${quoted ? `-- ${quoted}` : ''} | tar -x -C "$1"`, 'extract', directory],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`extractTree ${commit}: ${result.stderr.toString('utf8').trim()}`);
  }
  return directory;
}

/** The node version in an A store's recorder runtime receipt (g3-provenance hostReceipt); null when unreadable. */
function recorderNode(identity, storeDir) {
  const file = identity?.recorder?.runtimeReceipt?.file;
  if (!storeDir || !file) return null;
  try { return JSON.parse(readFileSync(join(storeDir, file), 'utf8')).node?.version ?? null; } catch { return null; }
}

/**
 * Per-scenario inputs of an A store (scenarioEntries form). Stores recorded before g3-inputs/v2
 * (or without `inputs.scenarios`) are recomputed from their recording commit (`recorder.head`,
 * read with git from `root`): code, launch and event list as that commit had them, with the
 * seeds, environment and launch values the store pinned, its `runner.isolation` and the node of
 * its recorder receipt (`storeDir`). null when that commit is not readable.
 */
export function storeScenarioInputs(root, identity, storeDir = null) {
  const inputs = identity?.inputs;
  if (!inputs?.suites) return null;
  if (inputs.schema === INPUTS_SCHEMA && inputs.scenarios) return scenarioEntries(inputs);
  const head = identity.recorder?.head;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return null;
  const read = gitReader(root, head);
  if (!read) return null;
  let events = inputs.schema === INPUTS_SCHEMA ? inputs.events : undefined;
  if (events === undefined) {
    const directory = extractTree(root, head, EVENT_SOURCES.filter(path => read.has(path)));
    try { events = eventsDigest(read, directory); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const computed = scenarioInputs({ read, files: Object.keys(inputs.suites), environment: inputs.environment, seeds: inputs.seeds ?? {},
    launch: inputs.launch ?? null, events, isolation: inputs.isolation ?? identity.runner?.isolation ?? null, node: inputs.node ?? recorderNode(identity, storeDir),
    strict: false });
  return scenarioEntries({ schema: INPUTS_SCHEMA, ...computed });
}

/** A suite file as the store's recording commit had it; null when that commit or file is not readable. */
export function storeSuiteFile(root, identity, file) {
  const head = identity?.recorder?.head;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return null;
  const shown = spawnSync('git', ['--no-optional-locks', 'show', `${head}:${file}`], { cwd: root, maxBuffer: 1 << 30 });
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * Components of one scenario's inputs that differ; null if equal. With scenarioEntries entries a
 * changed code unit is named per file (`code:<file>`, `resource:<file>`, `program:<entry>:<file>`,
 * `package:<name>`); `services` when the scenario's process starts other services.
 */
export function scenarioDifference(stored, current) {
  if (!stored) return ['not-in-store'];
  if (!current) return ['not-in-tree'];
  if (typeof stored.digest === 'string' && stored.digest === current.digest) return null;
  if (!('unit' in stored) || !('unit' in current)) return ['schema'];
  const reasons = [];
  for (const name of ['scenario', 'seed', 'seedBindings', 'llm', 'events']) if (stored[name] !== current[name]) reasons.push(name);
  if (stored.unit !== current.unit) reasons.push('services');
  if (stored.a !== current.a) {
    const a = stored.detail, b = current.detail;
    if (!a || !b) reasons.push('code');
    else {
      for (const file of union(a.code, b.code)) if (a.code?.[file] !== b.code?.[file]) reasons.push(`code:${file}`);
      for (const file of union(a.resources, b.resources)) if (a.resources?.[file] !== b.resources?.[file]) reasons.push(`resource:${file}`);
      for (const entry of union(a.programs, b.programs)) {
        for (const file of union(a.programs?.[entry], b.programs?.[entry])) if (a.programs?.[entry]?.[file] !== b.programs?.[entry]?.[file]) reasons.push(`program:${entry}:${file}`);
      }
      for (const name of union(a.packages, b.packages)) if (a.packages?.[name] !== b.packages?.[name]) reasons.push(`package:${name}`);
    }
  }
  if (!same(stored.environment, current.environment)) reasons.push('environment');
  if (!same(stored.launch?.a, current.launch?.a)) reasons.push('launch:a');
  if (!same(stored.launch?.mcp, current.launch?.mcp)) reasons.push('launch:mcp');
  if (stored.node !== current.node) reasons.push('runtime:node');
  for (const path of union(stored.files, current.files)) if (stored.files?.[path] !== current.files?.[path]) reasons.push(`file:${path}`);
  return reasons.length ? reasons : stored.digest === current.digest ? null : ['digest'];
}

/** Components of `file` that differ between a stored and the current fingerprint (suite level); null if equal. */
export function inputDifference(stored, current, file) {
  const a = stored?.suites?.[file], b = current?.suites?.[file];
  if (!a) return ['not-in-store'];
  if (!b) return ['not-in-tree'];
  if ((stored.schema ?? null) !== (current.schema ?? null)) return ['schema'];
  if (a.digest === b.digest) return null;
  const reasons = [];
  if (a.sha256 !== b.sha256) reasons.push('suite');
  if (a.provider !== b.provider) reasons.push('provider');
  if (a.scenarios !== b.scenarios) reasons.push('scenarios');
  for (const name of union(a.seeds, b.seeds)) if (a.seeds?.[name] !== b.seeds?.[name]) reasons.push(`seed:${name}`);
  for (const name of union(a.closures, b.closures)) if (a.closures?.[name] !== b.closures?.[name]) reasons.push(`closure:${name}`);
  if (!same(a.environment, b.environment)) reasons.push('environment');
  if (!same(a.launch?.mcp, b.launch?.mcp)) reasons.push('launch:mcp');
  return reasons.length ? reasons : ['digest'];
}
