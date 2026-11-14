// WP-076 / WP-141 / WP-157 / WP-233 authoring check only: no backend execution, oracle, or C-level evidence.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
// `${n}` references a whole raw result (the id string from create_custom_template, an
// export path string, or WP-233's card array from get_document_cards);
// `${n.a.b}` references a field. Both must occupy the whole value.
const refPattern = '^\\$\\{(\\d+)(?:\\.([A-Za-z0-9_.]+))?\\}$';
const refRegex = new RegExp(refPattern);
// Each work package owns a cap on its target commands. Other commands in its files are
// setup/readback helpers: L16 commands targeted by an earlier package, or foreign commands
// listed with their owning contract.
const packages = {
  'WP-076': { files: ['cards-crud.json', 'templates-crud.json', 'templates-import.json'], cap: 20 },
  'WP-141': {
    files: ['document-sessions.json'], cap: 10,
    targets: ['list_document_sessions', 'get_document_processing_state', 'get_document_tasks',
      'delete_document_session', 'set_document_session_source', 'pause_document_processing',
      'resume_document_processing', 'cancel_document_processing', 'recover_stuck_document_tasks',
      'get_model_adapter_options'],
    foreign: { fsrs_enqueue_cards: 'L15-review-analytics.json', fsrs_rate: 'L15-review-analytics.json' },
  },
  'WP-157': {
    files: ['anki-connect.json'], cap: 6,
    targets: ['check_anki_connect_status', 'anki_get_deck_names', 'get_anki_deck_names', 'get_anki_model_names',
      'create_anki_deck', 'add_cards_to_anki_connect'],
    foreign: { save_setting: 'L19-mcp-browser.json' },
    // Every scenario needs a deterministic AnkiConnect peer profile (null = nothing listening).
    peers: 'anki-connect.peers.json',
  },
  // D-158: success scenarios only; error branches belong to W-L16 (g3w-*.json).
  'WP-233': {
    files: ['exports-imports.json', 'generation.json', 'anki-connect-import.json', 'anki-media.json',
      'memory-candidates.seeded.json'], cap: 12,
    targets: ['batch_export_cards', 'export_anki_cards', 'export_cards_as_apkg_with_template',
      'export_multi_template_apkg', 'import_apkg_to_library', 'import_anki_package',
      'start_enhanced_document_processing', 'trigger_task_processing', 'read_anki_media',
      'dismiss_pending_memory_candidates', 'mark_pending_memory_candidates_saved'],
    foreign: { notes_save_asset: 'L10-notes.json' },
    successOnly: true,
    peers: 'anki-connect-import.peers.json', peerFiles: ['anki-connect-import.json'],
  },
};
// Seeded suites: each seed name must have its SQL spec next to the scenarios.
const seededFiles = { 'memory-candidates.seeded.json': 'l16-pending-memory-w0' };
const documents = new Map(['L16-anki.json', '_shared.json', 'L15-review-analytics.json', 'L19-mcp-browser.json', 'L10-notes.json'].map(name =>
  [name, JSON.parse(readFileSync(path.join(root, 'contracts/ipc', name), 'utf8'))]));
const commands = new Map();
for (const [file, document] of documents) {
  for (const command of document.commands ?? []) commands.set(command.name, { file, command });
}

// Literal input is validated by the real contract. A reference is an unresolved
// runtime value, so allow its syntax here and separately verify its result path.
function allowReferences(value) {
  if (Array.isArray(value)) return value.map(allowReferences);
  if (value === null || typeof value !== 'object') return value;
  const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, allowReferences(child)]));
  return value.type || value.$ref || value.anyOf || value.allOf
    ? { anyOf: [mapped, { type: 'string', pattern: refPattern }] } : mapped;
}
const ajv = new Ajv({ strict: false, allErrors: true });
for (const [file, document] of documents) {
  ajv.addSchema({ $id: file, $defs: allowReferences(document.$defs ?? {}) }, file);
}
// Local `#/$defs/...` refs (also nested, e.g. array items) must name the owning contract.
function qualifyRefs(value, file) {
  if (Array.isArray(value)) return value.map(item => qualifyRefs(item, file));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, key === '$ref' && typeof child === 'string' && child.startsWith('#') ? file + child : qualifyRefs(child, file)]));
}
const validators = new Map();
function validator(name) {
  if (!validators.has(name)) {
    const { command, file } = commands.get(name);
    validators.set(name, ajv.compile({
      $id: `${file}.args.${name}`, type: 'object',
      properties: Object.fromEntries(command.args.map(arg => [arg.key,
        allowReferences(qualifyRefs(arg.schema, file))])),
      required: command.args.filter(arg => !arg.optional).map(arg => arg.key),
    }));
  }
  return validators.get(name);
}
function resolve(schema, file) {
  if (!schema.$ref) return { schema, file };
  const [target, pointer] = schema.$ref.split('#');
  const nextFile = target || file;
  const resolved = pointer.split('/').filter(Boolean).reduce((node, key) => node[key], documents.get(nextFile));
  return resolve(resolved, nextFile);
}
function hasResultPath(input, inputFile, keys) {
  const { schema, file } = resolve(input, inputFile);
  if (schema.anyOf) return schema.anyOf.some(item => hasResultPath(item, file, keys));
  if (schema.allOf) return schema.allOf.some(item => hasResultPath(item, file, keys));
  if (!keys.length) return true;
  // Untyped `serde_json::Value` result (e.g. notes_save_asset): the contract cannot confirm
  // the path; the Rust source is cited in README instead.
  if (schema['x-rust'] === 'serde_json::Value' && !schema.type && !schema.properties) return true;
  const [key, ...tail] = keys;
  if (schema.type === 'array' && /^\d+$/.test(key)) return hasResultPath(schema.items, file, tail);
  return schema.properties?.[key] ? hasResultPath(schema.properties[key], file, tail) : false;
}
function isWholeValueResult(input, inputFile) {
  const { schema, file } = resolve(input, inputFile);
  if (schema.anyOf) return schema.anyOf.some(item => isWholeValueResult(item, file));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes('string') || types.includes('array');
}
function references(value, scenario, stepIndex) {
  if (typeof value === 'string' && value.includes('${')) {
    const match = value.match(refRegex);
    assert(match, `${scenario.id}: reference must occupy the whole value: ${value}`);
    const index = Number(match[1]);
    assert(index < stepIndex, `${scenario.id}: forward reference ${value}`);
    const source = scenario.steps[index];
    assert.notEqual(source.expect, 'error', `${scenario.id}: reference to error step ${value}`);
    const { command, file } = commands.get(source.cmd);
    if (match[2]) {
      assert(hasResultPath(command.result, file, match[2].split('.')), `${scenario.id}: unknown result path ${value}`);
    } else {
      assert(isWholeValueResult(command.result, file), `${scenario.id}: bare reference to non-string/array result ${value}`);
    }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) references(child, scenario, stepIndex);
  }
}

const ids = new Set(), used = new Set();
let steps = 0, errorInputs = 0, serdeInputs = 0;
const perFile = {};
const packageOf = new Map(Object.entries(packages).flatMap(([name, pkg]) => pkg.files.map(file => [file, name])));
const packageUse = Object.fromEntries(Object.keys(packages).map(name =>
  [name, { targets: new Set(), helpers: new Set(), steps: 0, targetSteps: 0 }]));
const corpusFiles = readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('.peers.json')).sort();
for (const file of corpusFiles) {
  const corpus = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
  const seedName = seededFiles[file] ?? 'empty';
  if (seedName !== 'empty') assert(existsSync(path.join(directory, `${seedName}.sql`)), `${file}: missing seed spec ${seedName}.sql`);
  const pkgName = packageOf.get(file);
  assert(pkgName, `${file}: not assigned to a work package`);
  const pkg = packages[pkgName], pkgUse = packageUse[pkgName];
  assert.deepEqual(Object.keys(corpus).sort(), ['commands', 'domain', 'scenarios']);
  assert.equal(corpus.domain, 'anki');
  assert.equal(new Set(corpus.commands).size, corpus.commands.length);
  const fileUsed = new Set();
  let fileSteps = 0;
  for (const scenario of corpus.scenarios) {
    assert.deepEqual(Object.keys(scenario).sort(), ['capture', 'id', 'normalize', 'seed', 'steps']);
    assert(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.equal(scenario.seed, seedName);
    assert.deepEqual(scenario.capture, { events: true, db: ['*'] });
    assert.deepEqual(scenario.normalize, []);
    assert(scenario.steps.length > 0);
    for (const [index, step] of scenario.steps.entries()) {
      assert.deepEqual(Object.keys(step).sort(), step.expect ? ['args', 'cmd', 'expect'] : ['args', 'cmd']);
      assert(corpus.commands.includes(step.cmd), `${file}: undeclared ${step.cmd}`);
      assert(commands.has(step.cmd), `${file}: missing command contract ${step.cmd}`);
      assert.equal(commands.get(step.cmd).command.frontend, 'app', `${step.cmd} is not a frontend command`);
      const owner = commands.get(step.cmd).file;
      if (owner === 'L16-anki.json') {
        assert(!pkg.foreign?.[step.cmd], `${step.cmd} is not foreign`);
      } else {
        assert.equal(pkg.foreign?.[step.cmd], owner, `${file}: unlisted foreign helper ${step.cmd}`);
      }
      const isTarget = pkg.targets ? pkg.targets.includes(step.cmd) : owner === 'L16-anki.json';
      (isTarget ? pkgUse.targets : pkgUse.helpers).add(step.cmd);
      pkgUse.steps++;
      if (isTarget) pkgUse.targetSteps++;
      if (step.expect) { assert.equal(step.expect, 'error'); assert(!pkg.successOnly, `${scenario.id}: ${pkgName} is success-only`); errorInputs++; }
      references(step.args, scenario, index);
      const validate = validator(step.cmd);
      if (!validate(step.args)) {
        assert.equal(step.expect, 'error', `${scenario.id} step ${index}: ${ajv.errorsText(validate.errors)}`);
        serdeInputs++;
      }
      used.add(step.cmd); fileUsed.add(step.cmd); steps++; fileSteps++;
    }
  }
  assert.deepEqual([...fileUsed].sort(), [...corpus.commands].sort());
  perFile[file] = { scenarios: corpus.scenarios.length, steps: fileSteps, commands: corpus.commands.length };
}
// Peer sidecar: one profile per scenario, faults keyed by AnkiConnect action, valid fault shapes.
const peerSummary = {};
const faultKinds = { reply: ['body', 'contentType', 'kind', 'status'], disconnect: ['at', 'body', 'kind'] };
const profileKeys = ['decks', 'existingNotes', 'faults', 'firstNoteId', 'models', 'version'];
for (const [name, pkg] of Object.entries(packages).filter(([, pkg]) => pkg.peers)) {
  const sidecar = JSON.parse(readFileSync(path.join(directory, pkg.peers), 'utf8'));
  assert.deepEqual(Object.keys(sidecar).sort(), ['address', 'package', 'peer', 'scenarios']);
  assert.equal(sidecar.package, name);
  assert(existsSync(path.join(root, sidecar.peer.split('#')[0])), `${pkg.peers}: missing peer module`);
  const expected = (pkg.peerFiles ?? pkg.files).flatMap(file =>
    JSON.parse(readFileSync(path.join(directory, file), 'utf8')).scenarios.map(scenario => scenario.id)).sort();
  assert.deepEqual(Object.keys(sidecar.scenarios).sort(), expected, `${pkg.peers}: scenarios differ from corpus`);
  let faults = 0, offline = 0;
  for (const [id, profile] of Object.entries(sidecar.scenarios)) {
    if (profile === null) { offline++; continue; }
    for (const key of Object.keys(profile)) assert(profileKeys.includes(key), `${id}: unknown profile key ${key}`);
    for (const [action, entry] of Object.entries(profile.faults ?? {})) {
      assert(/^[A-Za-z]+$/.test(action), `${id}: bad fault action ${action}`);
      for (const fault of Array.isArray(entry) ? entry : [entry]) {
        const allowed = faultKinds[fault.kind];
        assert(allowed, `${id}: unknown fault kind ${fault.kind}`);
        for (const key of Object.keys(fault)) assert(allowed.includes(key), `${id}: bad fault key ${key}`);
        if (fault.kind === 'reply') assert.equal(typeof fault.body, 'string');
        else assert(['before-headers', 'mid-body'].includes(fault.at));
        faults++;
      }
    }
  }
  peerSummary[name] = { profiles: Object.keys(sidecar.scenarios).length, offline, scriptedFaults: faults, address: sidecar.address };
}
const perPackage = {};
for (const [name, pkg] of Object.entries(packages)) {
  const pkgUse = packageUse[name];
  assert(pkgUse.targets.size <= pkg.cap, `${name} command cap exceeded: ${pkgUse.targets.size}`);
  if (pkg.targets) assert.deepEqual([...pkgUse.targets].sort(), [...pkg.targets].sort(), `${name}: unused target`);
  perPackage[name] = { targets: pkgUse.targets.size, targetSteps: pkgUse.targetSteps,
    helpers: [...pkgUse.helpers].sort(), steps: pkgUse.steps };
}
process.stdout.write(JSON.stringify({ scenarios: ids.size, commands: used.size, steps,
  successIntentSteps: steps - errorInputs, errorIntentSteps: errorInputs,
  serdeErrorInputs: serdeInputs, businessErrorInputs: errorInputs - serdeInputs,
  perFile, perPackage, peers: peerSummary, replay: 'not run', levelC: 0 }, null, 2) + '\n');
