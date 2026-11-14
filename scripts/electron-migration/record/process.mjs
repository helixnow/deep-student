import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseExact, stringifyExact } from './json.mjs';

// One long-lived reference process per run; no rebuild per vector.
export class JsonLineProcess {
  constructor(command, { cwd = process.cwd(), env = process.env, timeout = 30_000 } = {}) {
    this.timeout = timeout;
    this.pending = [];
    // Own process group, so close() also reaps helpers the oracle left behind.
    this.child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'inherit'], detached: process.platform !== 'win32' });
    this.exit = new Promise(resolve => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => this.fail(new Error(`oracle exited: ${code ?? signal}`)));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      const pending = this.pending.shift();
      if (!pending) return this.fail(new Error('unsolicited oracle output'));
      clearTimeout(pending.timer);
      try {
        const response = parseExact(line);
        if (typeof response?.ok !== 'boolean' || (response.ok ? !Object.hasOwn(response, 'value') : !Object.hasOwn(response, 'error'))) {
          throw new Error('invalid oracle response envelope');
        }
        pending.resolve(response);
      } catch (error) { pending.reject(error); this.fail(error); }
    });
  }
  fail(error) {
    this.failure = error;
    for (const pending of this.pending.splice(0)) { clearTimeout(pending.timer); pending.reject(error); }
  }
  request(request) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`oracle timeout: ${request.fn}`));
        this.child.kill('SIGKILL');
      }, this.timeout);
      this.pending.push({ resolve, reject, timer });
      this.child.stdin.write(stringifyExact(request) + '\n', error => { if (error) this.fail(error); });
    });
  }
  /** Exit is waited for (SIGKILL after 1s); stdout EOF only briefly, since a descendant may hold it. */
  async close() {
    this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    let held;
    try {
      await this.exit;
      const closed = await Promise.race([this.exited.then(() => true), new Promise(resolve => { held = setTimeout(resolve, 1000, false); })]);
      if (!closed) this.child.stdout.destroy();
    } finally {
      clearTimeout(kill);
      clearTimeout(held);
      if (this.child.pid && process.platform !== 'win32') { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* group already empty */ } }
      this.lines.close();
    }
  }
}
