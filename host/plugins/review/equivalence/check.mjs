// WP-053/WP-113/WP-147/WP-229 authoring check only: no backend execution, oracle, or C-level evidence.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const refPattern = '^\\$\\{(\\d+)\\.([A-Za-z0-9_.]+)\\}$';
const refRegex = new RegExp(refPattern);
const documents = new Map(['L15-review-analytics.json', 'L16-anki.json', 'L02-llm-manager.json', 'L13-vfs-api.json', 'L14-qbank.json', '_shared.json'].map(name =>
  [name, JSON.parse(readFileSync(path.join(root, 'contracts/ipc', name), 'utf8'))]));
const commands = new Map();
// WP-229: the contract marks these `frontend: none`, but they are invoked from
// src/features/insights/api.ts, learning-today/weeklyReport.ts and
// flashcards/store/fsrsReviewStore.ts. The contract flag is stale (see README).
const staleFrontendNone = new Set(['insight_create_draft', 'insight_confirm', 'insight_correct', 'insight_get',
  'insight_list', 'insight_list_revisions', 'insight_list_evidence', 'insight_list_relations', 'insight_add_relation',
  'insight_record_feedback', 'insight_delete', 'insight_run_jobs', 'study_time_range', 'fsrs_bury_card', 'fsrs_unbury_card']);
const providerUrl = '${provider.url}';
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
const validators = new Map();
function qualify(value, file) {
  if (Array.isArray(value)) return value.map(child => qualify(child, file));
  if (value === null || typeof value !== 'object') return value;
  const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, qualify(child, file)]));
  return value.$ref?.startsWith('#') ? { ...mapped, $ref: file + value.$ref } : mapped;
}
function validator(name) {
  if (!validators.has(name)) {
    const { command, file } = commands.get(name);
    validators.set(name, ajv.compile({
      $id: `${file}.args.${name}`, type: 'object',
      properties: Object.fromEntries(command.args.map(arg => [arg.key, allowReferences(qualify(arg.schema, file))])),
      required: command.args.filter(arg => !arg.optional).map(arg => arg.key),
    }));
  }
  return validators.get(name);
}
function hasResultPath(schema, file, keys) {
  if (schema.$ref) {
    const [target, pointer] = schema.$ref.split('#');
    const nextFile = target || file;
    const resolved = pointer.split('/').filter(Boolean).reduce((node, key) => node[key], documents.get(nextFile));
    return hasResultPath(resolved, nextFile, keys);
  }
  if (schema.anyOf) return schema.anyOf.some(item => hasResultPath(item, file, keys));
  if (schema.allOf) return schema.allOf.some(item => hasResultPath(item, file, keys));
  if (!keys.length) return true;
  const [key, ...tail] = keys;
  if (schema.type === 'array' && /^\d+$/.test(key)) return hasResultPath(schema.items, file, tail);
  return schema.properties?.[key] ? hasResultPath(schema.properties[key], file, tail) : false;
}
function references(value, scenario, stepIndex) {
  if (value === providerUrl && scenario.pendingProvider) return;
  if (typeof value === 'string' && value.includes('${')) {
    const match = value.match(refRegex);
    assert(match, `${scenario.id}: reference must occupy the whole value: ${value}`);
    const index = Number(match[1]);
    assert(index < stepIndex, `${scenario.id}: forward reference ${value}`);
    const source = scenario.steps[index];
    assert.notEqual(source.expect, 'error', `${scenario.id}: reference to error step ${value}`);
    const { command, file } = commands.get(source.cmd);
    assert(hasResultPath(command.result, file, match[2].split('.')), `${scenario.id}: unknown result path ${value}`);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) references(child, scenario, stepIndex);
  }
}

const ids = new Set(), used = new Set(), groups = new Map();
let steps = 0, errorInputs = 0, serdeInputs = 0;
const files = {};
const pendingDirectory = path.join(directory, 'pending-provider');
const pendingFiles = readdirSync(pendingDirectory).filter(name => name.endsWith('.json') && !name.endsWith('.provider.json'))
  .sort().map(name => path.join('pending-provider', name));
for (const file of [...readdirSync(directory).filter(name => name.endsWith('.v0.json')).sort(), ...pendingFiles]) {
  const pending = file.startsWith('pending-provider');
  const corpus = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
  if (pending) {
    const script = JSON.parse(readFileSync(path.join(directory, file.replace(/\.json$/, '.provider.json')), 'utf8'));
    for (const scenario of corpus.scenarios) assert(Array.isArray(script[scenario.id]), `${file}: no provider script for ${scenario.id}`);
  }
  assert.equal(corpus.domain, 'review');
  assert.equal(new Set(corpus.commands).size, corpus.commands.length);
  const fileUsed = new Set();
  const fileCount = files[file] = { scenarios: corpus.scenarios.length, steps: 0, errorIntentSteps: 0, serdeErrorInputs: 0 };
  for (const scenario of corpus.scenarios) {
    assert(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    Object.defineProperty(scenario, 'pendingProvider', { value: pending });
    assert.equal(scenario.seed, 'empty');
    assert.deepEqual(scenario.capture, { events: true, db: ['*'] });
    assert.deepEqual(scenario.normalize, []);
    assert(scenario.steps.length > 0);
    for (const [index, step] of scenario.steps.entries()) {
      assert.deepEqual(Object.keys(step).sort(), step.expect ? ['args', 'cmd', 'expect'] : ['args', 'cmd']);
      assert(corpus.commands.includes(step.cmd), `${file}: undeclared ${step.cmd}`);
      assert(commands.has(step.cmd), `${file}: missing command contract ${step.cmd}`);
      if (!staleFrontendNone.has(step.cmd)) assert.equal(commands.get(step.cmd).command.frontend, 'app', `${file}: ${step.cmd} not frontend app`);
      if (step.expect) { assert.equal(step.expect, 'error'); errorInputs++; fileCount.errorIntentSteps++; }
      references(step.args, scenario, index);
      const validate = validator(step.cmd);
      if (!validate(step.args)) {
        assert.equal(step.expect, 'error', `${scenario.id} step ${index}: ${ajv.errorsText(validate.errors)}`);
        serdeInputs++; fileCount.serdeErrorInputs++;
      }
      used.add(step.cmd); fileUsed.add(step.cmd); steps++; fileCount.steps++;
    }
  }
  assert.deepEqual([...fileUsed].sort(), [...corpus.commands].sort());
  // Each work package (fsrs- = WP-053, review-plan-aggregate = WP-147, review-plan- = WP-113) has its own 20-command cap.
  // WP-229 (wp229- and its pending-provider file) is exempt from the cap by brief.
  const group = pending ? 'wp229-' : ['fsrs-', 'review-plan-aggregate', 'review-plan-', 'wp229-'].find(prefix => file.startsWith(prefix)) ?? file;
  if (!groups.has(group)) groups.set(group, new Set());
  for (const name of fileUsed) groups.get(group).add(name);
}
for (const [group, names] of groups) assert(group === 'wp229-' || names.size <= 20, `${group} command cap exceeded: ${names.size}`);
process.stdout.write(JSON.stringify({ scenarios: ids.size, commands: used.size,
  files, groups: Object.fromEntries([...groups].map(([group, names]) => [group, names.size])), steps,
  successIntentSteps: steps - errorInputs, errorIntentSteps: errorInputs,
  serdeErrorInputs: serdeInputs, businessErrorInputs: errorInputs - serdeInputs,
  replay: 'not run', levelC: 0 }, null, 2) + '\n');
