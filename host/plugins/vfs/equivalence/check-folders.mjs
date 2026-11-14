// WP-200 authoring checks, not Rust coverage or an equivalence verdict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { validateScenario } from '../../../../scripts/electron-migration/record/scenario-v0.mjs';

export const corpus = JSON.parse(readFileSync(new URL('./folders.v0.json', import.meta.url), 'utf8'));
const contract = JSON.parse(readFileSync(new URL('../../../../contracts/ipc/L13-vfs-api.json', import.meta.url), 'utf8'));
const names = ['get', 'rename', 'delete', 'move', 'set_expanded', 'list', 'get_tree', 'get_breadcrumbs']
  .map(name => `dstu_folder_${name}`);
assert.equal(corpus.domain, 'vfs');
assert.deepEqual(corpus.commands, names);
const allowed = new Set([...names, 'dstu_folder_create']);
const ajv = new Ajv({ strict: false });
const validators = new Map([...allowed].map(name => {
  const command = contract.commands.find(command => command.name === name);
  assert.equal(command?.frontend, 'app', `${name}: missing real frontend contract`);
  return [name, ajv.compile({ type: 'object',
    properties: Object.fromEntries(command.args.map(arg => [arg.key, arg.schema])),
    required: command.args.filter(arg => !arg.optional).map(arg => arg.key),
  })];
}));
const ids = new Set();
for (const file of ['dstu-crud.json', 'dstu-crud-limits.json']) {
  for (const scenario of JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).scenarios) {
    assert(!ids.has(scenario.id), `duplicate historical id: ${scenario.id}`);
    ids.add(scenario.id);
  }
}
const counts = Object.fromEntries([...allowed].map(name => [name, { steps: 0, errorIntent: 0, serdeError: 0 }]));
let steps = 0;
for (const scenario of corpus.scenarios) {
  validateScenario(scenario);
  assert(!ids.has(scenario.id), `duplicate id: ${scenario.id}`);
  ids.add(scenario.id);
  assert.equal(scenario.seed, 'empty');
  assert.deepEqual(scenario.capture, { events: true, db: ['*'] });
  for (const [index, step] of scenario.steps.entries()) {
    assert(allowed.has(step.cmd), `${scenario.id}: out-of-scope command ${step.cmd}`);
    assert.deepEqual(Object.keys(step).sort(), step.expect ? ['args', 'cmd', 'expect'] : ['args', 'cmd']);
    for (const value of Object.values(step.args)) {
      if (typeof value !== 'string' || !value.includes('${')) continue;
      const match = /^\$\{(\d+)\.id\}$/.exec(value);
      assert(match, `${scenario.id}: invalid whole-value folder id reference ${value}`);
      const source = Number(match[1]);
      assert(source < index, `${scenario.id}: forward reference ${value}`);
      assert.equal(scenario.steps[source].cmd, 'dstu_folder_create');
      assert.equal(scenario.steps[source].expect, undefined);
    }
    const valid = validators.get(step.cmd)(step.args);
    if (!valid) assert.equal(step.expect, 'error', `${scenario.id}[${index}]: ${ajv.errorsText(validators.get(step.cmd).errors)}`);
    counts[step.cmd].steps++;
    counts[step.cmd].errorIntent += Number(step.expect === 'error');
    counts[step.cmd].serdeError += Number(!valid);
    steps++;
  }
}
for (const name of names) assert(counts[name].steps > counts[name].errorIntent, `${name}: no success-intent step`);
const limits = corpus.scenarios.find(scenario => scenario.id === 'vfs.folder.rename.utf8_limits');
assert.deepEqual([1, 3, 4, 6].map(index => Buffer.byteLength(limits.steps[index].args.title)), [100, 101, 100, 102]);
export const summary = { targets: names.length, helpers: 1, scenarios: corpus.scenarios.length, steps, counts,
  normalization: [], comparison: 'not-run', rustCoverage: 'not-run' };
if (process.argv[1]?.endsWith('check-folders.mjs')) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
