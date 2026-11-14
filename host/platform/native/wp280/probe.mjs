// WP-280 diagnostic only: one unmodified production probe; observe real spawn.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { return { error: error.code }; }
}
function snapshot() {
  const rows = [];
  const errors = [];
  for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    const status = read(`/proc/${pid}/status`);
    if (typeof status !== 'string') { errors.push({ pid, ...status }); continue; }
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    if (uid === process.getuid()) rows.push({ pid: Number(pid), uid,
      name: /^Name:\s+(.*)/m.exec(status)?.[1], threads: Number(/^Threads:\s+(\d+)/m.exec(status)?.[1]) });
  }
  const files = {};
  for (const file of ['/proc/self/limits', '/proc/self/status', '/proc/self/cgroup',
    '/proc/loadavg', '/proc/meminfo', '/proc/sys/kernel/pid_max', '/proc/sys/kernel/threads-max',
    '/proc/sys/kernel/unprivileged_userns_clone', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    ...fs.readdirSync('/proc/sys/user').filter(x => x.endsWith('_namespaces')).map(x => `/proc/sys/user/${x}`)]) files[file] = read(file);
  const cg = /^0::(.*)$/m.exec(files['/proc/self/cgroup'])?.[1];
  if (cg !== undefined) {
    let dir = path.join('/sys/fs/cgroup', cg);
    while (dir.startsWith('/sys/fs/cgroup')) {
      for (const name of ['pids.current', 'pids.max', 'pids.events', 'pids.peak', 'memory.current', 'memory.max', 'memory.events', 'cpu.max']) files[path.join(dir, name)] = read(path.join(dir, name));
      if (dir === '/sys/fs/cgroup') break;
      dir = path.dirname(dir);
    }
  }
  const namespaces = {};
  for (const name of fs.readdirSync('/proc/self/ns')) namespaces[name] = fs.readlinkSync(`/proc/self/ns/${name}`);
  return { at: new Date().toISOString(), uid: process.getuid(), processes: rows.length,
    threads: rows.reduce((n, x) => n + x.threads, 0), rows, errors, namespaces, files };
}

const before = snapshot();
if (process.argv.includes('--inspect')) {
  process.stdout.write(JSON.stringify(before, null, 2) + '\n');
} else {
  const launches = [];
  const original = childProcess.spawn;
  childProcess.spawn = function(program, args, options) {
    const row = { program, args, options, at: new Date().toISOString() };
    launches.push(row);
    const child = original.call(this, program, args, options);
    row.pid = child.pid;
    row.limitsAtSpawnReturn = read(`/proc/${child.pid}/limits`);
    row.statAtSpawnReturn = read(`/proc/${child.pid}/stat`);
    child.once('spawn', () => { row.limitsAtSpawnEvent = read(`/proc/${child.pid}/limits`); });
    child.once('exit', (code, signal) => { row.code = code; row.signal = signal; });
    child.once('error', error => { row.error = { message: error.message, code: error.code }; });
    row.stderr = '';
    child.stderr?.on('data', bytes => { row.stderr += bytes.toString('utf8'); });
    return child;
  };
  syncBuiltinESMExports();
  const { sandbox } = await import('../sandbox/index.ts');
  const result = await sandbox.probe('linux_bwrap', '/usr/bin/bwrap');
  const after = snapshot();
  childProcess.spawn = original;
  syncBuiltinESMExports();
  process.stdout.write(JSON.stringify({ before, launches, result, after }, null, 2) + '\n');
  process.exitCode = result.available ? 0 : 1;
}
