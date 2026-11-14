// WP-223 authoring checks for *.g3.json, not Rust coverage or an equivalence verdict.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { validateScenario } from '../../../../scripts/electron-migration/record/scenario-v0.mjs';

const dir = new URL('./', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const contractDir = new URL('../../../../contracts/ipc/', import.meta.url);
const contracts = readdirSync(contractDir).filter(name => name.endsWith('.json') && name !== '_shared.json')
  .map(name => JSON.parse(readFileSync(new URL(name, contractDir), 'utf8')))
  .filter(contract => Array.isArray(contract.commands));
const ajv = new Ajv({ strict: false, allErrors: false });
ajv.addSchema({ $id: '_shared.json', $defs: JSON.parse(readFileSync(new URL('_shared.json', contractDir), 'utf8')).$defs });
const definitions = new Map();
const frontend = new Map();
for (const contract of contracts) {
  for (const command of contract.commands) {
    if (definitions.has(command.name)) continue;
    frontend.set(command.name, command.frontend);
    definitions.set(command.name, { contract, command });
  }
}
const compiled = new Map();
const validators = {
  has: name => definitions.has(name),
  get(name) {
    if (!compiled.has(name)) {
      const { contract, command } = definitions.get(name);
      compiled.set(name, ajv.compile({ type: 'object', $defs: contract.$defs ?? {},
        properties: Object.fromEntries(command.args.map(arg => [arg.key, arg.schema])),
        required: command.args.filter(arg => !arg.optional).map(arg => arg.key) }));
    }
    return compiled.get(name);
  },
};

const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
const g3 = files.filter(name => name.endsWith('.g3.json'));
const ids = new Set();
for (const file of files.filter(name => !g3.includes(name))) {
  for (const scenario of read(file).scenarios) {
    assert(!ids.has(scenario.id), `duplicate historical id: ${scenario.id}`);
    ids.add(scenario.id);
  }
}

const counts = {};
const perFile = {};
let scenarios = 0;
let steps = 0;
const refPattern = /^\$\{(0|[1-9][0-9]*)(?:\.[^}]+)?\}$/;
function checkRefs(value, index, scenario, where) {
  if (typeof value === 'string') {
    if (!value.includes('${')) return;
    const match = refPattern.exec(value);
    assert(match, `${where}: reference must occupy the whole value: ${value}`);
    const source = Number(match[1]);
    assert(source < index, `${where}: forward reference ${value}`);
    assert.equal(scenario.steps[source].expect, undefined, `${where}: reference to error-intent step ${value}`);
  } else if (Array.isArray(value)) value.forEach(item => checkRefs(item, index, scenario, where));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => checkRefs(item, index, scenario, where));
}
const hasRef = value => typeof value === 'string' ? value.includes('${')
  : Array.isArray(value) ? value.some(hasRef)
    : value && typeof value === 'object' ? Object.values(value).some(hasRef) : false;

for (const file of g3) {
  const corpus = read(file);
  assert.equal(corpus.domain, 'vfs', `${file}: domain`);
  assert(Array.isArray(corpus.commands) && corpus.commands.length, `${file}: commands`);
  for (const name of corpus.commands) {
    assert(validators.has(name), `${file}: target ${name} missing from contracts`);
    counts[name] ??= { file, scenarios: new Set(), steps: 0, successSteps: 0, errorSteps: 0, serdeErrorSteps: 0 };
  }
  perFile[file] = { commands: corpus.commands.length, scenarios: corpus.scenarios.length, steps: 0 };
  for (const scenario of corpus.scenarios) {
    validateScenario(scenario);
    assert(!ids.has(scenario.id), `duplicate id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.equal(scenario.seed, 'empty', `${scenario.id}: seed`);
    assert.deepEqual(scenario.capture, { events: true, db: ['*'] }, `${scenario.id}: capture`);
    assert.deepEqual(scenario.normalize, [], `${scenario.id}: normalize`);
    scenarios++;
    for (const [index, step] of scenario.steps.entries()) {
      const where = `${scenario.id}[${index}]`;
      assert.deepEqual(Object.keys(step).sort(), step.expect ? ['args', 'cmd', 'expect'] : ['args', 'cmd'], `${where}: step keys`);
      assert(validators.has(step.cmd), `${where}: ${step.cmd} not in any contract`);
      assert(step.args && typeof step.args === 'object' && !Array.isArray(step.args), `${where}: args object`);
      checkRefs(step.args, index, scenario, where);
      // Referenced values are only known at run time; validate the literal shape only.
      const valid = hasRef(step.args) ? true : validators.get(step.cmd)(step.args);
      if (!valid) assert.equal(step.expect, 'error', `${where}: ${step.cmd} ${ajv.errorsText(validators.get(step.cmd).errors)}`);
      steps++;
      perFile[file].steps++;
      const count = counts[step.cmd];
      if (!count) continue;
      count.scenarios.add(scenario.id);
      count.steps++;
      if (step.expect === 'error') count.errorSteps++;
      else count.successSteps++;
      if (!valid) count.serdeErrorSteps++;
    }
  }
}

const listFile = process.argv[2];
const required = listFile
  ? [...readFileSync(listFile, 'utf8').matchAll(/^\| `([a-z0-9_]+)`/gm)].map(match => match[1])
  : [];
const missing = required.filter(name => !counts[name]);
for (const [name, count] of Object.entries(counts)) {
  assert(count.successSteps > 0, `${name}: no success-intent step`);
}
const table = Object.fromEntries(Object.entries(counts).sort().map(([name, count]) => [name,
  { file: count.file, frontend: frontend.get(name), scenarios: count.scenarios.size, steps: count.steps,
    success: count.successSteps, errorIntent: count.errorSteps, serdeError: count.serdeErrorSteps }]));
const summary = { files: perFile, targets: Object.keys(counts).length, scenarios, steps,
  targetsWithErrorIntent: Object.values(counts).filter(count => count.errorSteps > count.serdeErrorSteps).length,
  requiredFromList: required.length, missingFromList: missing, commands: table,
  normalization: [], comparison: 'not-run', rustCoverage: 'not-run' };
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
if (missing.length) process.exitCode = 1;
