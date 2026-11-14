// Process fixture: a stand-in for a badly behaved A side (Tauri, xvfb-run, a recording
// worker). Every process it starts appends its pid to PIDFILE so a test can prove that
// nothing survives.
//   node misbehave.mjs MODE [PIDFILE] [...]
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, pidfile, ...rest] = process.argv.slice(2);
// Before anything else, so a slow start under load cannot let a SIGTERM through.
if (mode.startsWith('ignore-term')) process.on('SIGTERM', () => {});
const note = pid => { if (pidfile) appendFileSync(pidfile, `${pid}\n`); };
const forever = () => setInterval(() => {}, 1 << 30);
const IGNORE_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);";
/** A grandchild on our stdout/stderr pipes; `detached` puts it in its own session and process group. */
const holder = ({ detached = false, ignoreTerm = false } = {}) => {
  const child = spawn(process.execPath, ['-e', ignoreTerm ? IGNORE_TERM : 'setInterval(() => {}, 1 << 30);'],
    { stdio: ['ignore', 'inherit', 'inherit'], detached });
  note(child.pid);
  child.unref();
  return child;
};

note(process.pid);
switch (mode) {
  case 'exit': {
    // misbehave.mjs exit PIDFILE CODE
    process.stdout.write('stdout line\n');
    process.stderr.write('stderr line\n');
    process.exitCode = Number(rest[0] ?? 0);
    break;
  }
  case 'orphan-pipe': holder(); setTimeout(() => process.exit(0), 50); break;
  case 'setsid-pipe': holder({ detached: true }); setTimeout(() => process.exit(0), 50); break;
  case 'ignore-term': forever(); process.stdout.write('ready\n'); break;
  case 'ignore-term-orphan': holder({ ignoreTerm: true }); forever(); break;
  case 'hang': forever(); break;
  case 'summary': {
    // misbehave.mjs summary PIDFILE SUMMARY_FILE THEN [runner-error]
    const [file, then, runnerError] = rest;
    const runs = [{ id: 'fixture.recorded', status: 'recorded', trace: 'trace.json.gz' }];
    if (runnerError) runs.push({ id: 'fixture.failed', status: 'runner-error', reason: 'fixture' });
    writeFileSync(file, JSON.stringify({ scenarioFile: 'fixture.json', inputSha256: 'fixture', runs }));
    if (then === 'sigkill') process.kill(process.pid, 'SIGKILL');
    else process.exitCode = Number(then.replace('exit', ''));
    break;
  }
  case 'smart-child': {
    // Xvfb's readiness notice (xorg-server os/connection.c NotifyParentProcess): only a
    // parent with pid > 1 is signalled; under pid 1 the waiting parent never hears back.
    if (process.ppid > 1) process.kill(process.ppid, 'SIGUSR1');
    forever();
    break;
  }
  case 'print-pid': process.stdout.write(`${process.pid}\n`); break;
  case 'oracle-orphan': {
    holder();
    const lines = createInterface({ input: process.stdin });
    lines.on('line', () => process.stdout.write('{"ok":true,"value":1}\n'));
    lines.on('close', () => process.exit(0));
    break;
  }
  default: throw new Error(`unknown mode ${mode}`);
}
