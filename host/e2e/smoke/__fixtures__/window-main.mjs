// Observation-only entry: production start(), preload, profile and transport.
// No handlers, services, results or permissions are substituted. Process hooks are
// production too, except under X1_RECORD_PROCESS_HOOKS=1 (restart-smoke.mjs only):
// then start()'s documented processHooks option records restart/exit instead of the
// irreversible app.relaunch()/app.exit() (electron/main.ts:96–101).
// W12_HOST_INSPECT_PORT (memory diagnostics only) adds `--inspect` to every Host fork, from the first
// one: Electron does not pass NODE_OPTIONS to utility processes.
// W12_HOST_TIMER_SCALE (`file=<fragment>&delays=<from>:<to>,…`) forks host-timer-scale.mjs in place of the Host
// entry, which rescales those product timers and then imports the real entry (`--import` is ignored there).
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// boundary-allow native-import: Test-only Electron entry observes real IPC before production start(); never imported by Host plugins.
import { app, ipcMain, utilityProcess } from 'electron';
import { HostSupervisor } from '../../../../electron/shell/host.ts';

if (process.env.W12_HOST_INSPECT_PORT) {
  const fork = utilityProcess.fork.bind(utilityProcess);
  utilityProcess.fork = (modulePath, args, options = {}) => fork(modulePath, args,
    { ...options, execArgv: [...(options.execArgv ?? []), `--inspect=127.0.0.1:${process.env.W12_HOST_INSPECT_PORT}`] });
}
if (process.env.W12_HOST_TIMER_SCALE) {
  const fork = utilityProcess.fork.bind(utilityProcess);
  const wrapper = fileURLToPath(new URL('./host-timer-scale.mjs', import.meta.url));
  utilityProcess.fork = (modulePath, args, options = {}) => fork(wrapper, args,
    { ...options, env: { ...(options.env ?? process.env), W12_HOST_ENTRY: modulePath } });
}

let sequence = 0;
let phase = 'boot';
const record = (kind, data) => {
  const bytes = kind === 'renderer-invoke' ? data.message.payload?.data
    : kind === 'host-out' && data.message.kind === 'invoke' ? data.message.args : undefined;
  // Observe the real object before JSON serialization erases the view's type.
  const binary = bytes instanceof Uint8Array ? { type: 'Uint8Array', byteLength: bytes.byteLength,
    base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') } : undefined;
  appendFileSync(process.env.X1_TRACE,
    JSON.stringify({ seq: ++sequence, time: performance.now(), phase, kind, ...data, binary }) + '\n');
  return sequence;
};
globalThis.__x1Mark = (name) => { phase = name; record('mark', { name }); return sequence; };

// Listen on the real MessagePort after production creates it. Keep raw JSON text:
// parsing/reserializing message.json would lose D3 numbers and negative zero.
const startHost = HostSupervisor.prototype.start;
HostSupervisor.prototype.start = function (...args) {
  const hostStartSeq = record('host-start', { handshake: this.options.handshake, entry: this.options.entry });
  const result = startHost.apply(this, args);
  this.child.once('spawn', () => record('host-spawn', { hostStartSeq, pid: this.child?.pid }));
  this.child.once('exit', code => record('host-exit', { hostStartSeq, code }));
  this.port.on('message', event => record('host-in', { message: event.data }));
  const post = this.port.postMessage.bind(this.port);
  this.port.postMessage = (message, ...rest) => {
    record('host-out', { message });
    return post(message, ...rest);
  };
  return result;
};
const shutdownHost = HostSupervisor.prototype.shutdown;
HostSupervisor.prototype.shutdown = async function (...args) {
  record('host-shutdown-request', {});
  const result = await shutdownHost.apply(this, args);
  record('host-shutdown-complete', {});
  return result;
};
ipcMain.on('dstu-shell:to-main', (event, message) =>
  record('renderer-invoke', { webContents: event.sender.id, message }));
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents);
  contents.send = (channel, ...args) => {
    if (channel === 'dstu-shell:to-renderer') record('renderer-result', { webContents: contents.id, message: args[0] });
    return send(channel, ...args);
  };
  contents.on('console-message', event => record('console', {
    webContents: contents.id, level: event.level, message: event.message,
    line: event.lineNumber, source: event.sourceId,
  }));
  contents.on('render-process-gone', (_event, details) => record('renderer-gone', { details }));
  contents.on('did-fail-load', (_event, code, description, url) => record('load-failed', { code, description, url }));
});
const { start } = await import('../../../../electron/main.ts');
if (!app.requestSingleInstanceLock()) throw new Error('isolated Electron single-instance lock failed');
// Electron waits for the ESM entry to finish before ready; a top-level await on
// whenReady deadlocks that lifecycle (also under Playwright's ready barrier).
void app.whenReady().then(() => start(process.env.X1_RECORD_PROCESS_HOOKS === '1'
  ? { processHooks: { restart: () => record('process-hook', { op: 'restart' }), exit: code => record('process-hook', { op: 'exit', code }) } }
  : {}));
