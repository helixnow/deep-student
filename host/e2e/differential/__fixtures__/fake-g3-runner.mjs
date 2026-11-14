// Stand-in for g3-run-a.mjs / g3-run-b.mjs inside a throwaway repository: same CLI and
// summary/trace layout, behavior chosen by the scenario id suffix.
//   .ok    recorded trace, exit 0        .error  runner-error, exit 1
//   .crash summary written, then SIGKILL .hang   ignores SIGTERM, never exits (helper too)
//   .rf    like .ok, but B's results carry an extra `"fixed":true` (a deliberate B change)
//   .eagain runner-error whose take log holds a tokio EAGAIN panic (infrastructure); with
//          $W13_EAGAIN_ONCE (a directory) only the first attempt of each take fails, then .ok
// Pids go to $W13_PIDFILE so a test can prove nothing survives. Recorded runs list the
// TZ/LANG/LC_ALL the worker saw.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const note = pid => { if (process.env.W13_PIDFILE) appendFileSync(process.env.W13_PIDFILE, `${pid}\n`); };
note(process.pid);
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  scenario: { type: 'string', multiple: true }, take: { type: 'string', multiple: true }, gzip: { type: 'boolean' },
  compact: { type: 'boolean' }, 'profile-pool': { type: 'string' } } });
const aSide = positionals.length === 3;
const [scenarioFile, output] = aSide ? [positionals[0], positionals[2]] : positionals;
const out = resolve(output);
mkdirSync(out, { recursive: true });
const inputSha256 = createHash('sha256').update(readFileSync(scenarioFile)).digest('hex');
const suite = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const runs = [];
const finish = () => writeFileSync(join(out, 'summary.json'), JSON.stringify({ scenarioFile, inputSha256, ...(aSide ? { build: 'fixture' } : {}), runs }, null, 2));
for (const scenario of suite.scenarios.filter(item => values.scenario.includes(item.id))) {
  const take = aSide ? (values.take ?? ['A1'])[0] : 'B';
  if (scenario.id.endsWith('.hang')) {
    const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"], { stdio: ['ignore', 'inherit', 'inherit'] });
    note(helper.pid);
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1 << 30);
    process.stdout.write(`${scenario.id} hanging\n`);
    break;
  }
  if (scenario.id.endsWith('.error')) { runs.push({ id: scenario.id, side: take, status: 'runner-error', reason: 'fixture runner error' }); continue; }
  const directory = join(out, scenario.id, take);
  const once = process.env.W13_EAGAIN_ONCE ? join(process.env.W13_EAGAIN_ONCE, `${scenario.id}.${take}`) : null;
  if (scenario.id.endsWith('.eagain') && !(once && existsSync(once))) {
    if (once) { mkdirSync(process.env.W13_EAGAIN_ONCE, { recursive: true }); writeFileSync(once, ''); }
    mkdirSync(join(directory, 'run'), { recursive: true });
    writeFileSync(join(directory, 'run', take === 'B' ? 'host.stderr.log' : 'app.stderr.log'),
      "thread 'main' panicked at tokio/src/runtime/blocking/pool.rs:\nOS can't spawn worker thread: Resource temporarily unavailable (os error 11)\n");
    runs.push({ id: scenario.id, side: take, status: 'runner-error', reason: 'Error: harness ready timed out after 120000 ms' });
    continue;
  }
  mkdirSync(directory, { recursive: true });
  const trace = join(directory, values.gzip ? 'trace.json.gz' : 'trace.json');
  // A real v0 observation from the copied scenario-v0.mjs; both sides answer identically.
  const { executeScenario } = await import(new URL('./scenario-v0.mjs', import.meta.url));
  const observation = await executeScenario(scenario, {
    async invoke(command, raw) {
      return { kind: 'result', raw: `{"command":"${command}","args":${raw}${!aSide && scenario.id.endsWith('.rf') ? ',"fixed":true' : ''}}` };
    },
    capture: () => ({ events: [], databases: { version: 0, databases: {} } }),
  });
  const body = JSON.stringify({ ...observation, side: aSide ? take : 'B', inputSha256, eventScope: { kind: 'all' } });
  writeFileSync(trace, values.gzip ? gzipSync(body) : body);
  const { TZ = null, LANG = null, LC_ALL = null } = process.env;
  runs.push({ id: scenario.id, side: take, status: 'recorded', trace, outcomes: [], env: { TZ, LANG, LC_ALL } });
  if (scenario.id.endsWith('.crash')) { finish(); process.kill(process.pid, 'SIGKILL'); }
}
if (!suite.scenarios.some(item => values.scenario.includes(item.id) && item.id.endsWith('.hang'))) {
  finish();
  process.exitCode = runs.some(item => item.status === 'runner-error') ? 1 : 0;
}
