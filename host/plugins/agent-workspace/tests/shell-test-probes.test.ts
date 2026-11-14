import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostPidsWithArgv, procPidsWithArgv, procStatState, processRunning, psPidsWithArgv, uniqueSleepArgv, until } from './host-processes.ts';
import { PRLIMIT, probePosixSandbox, type ProbeHost } from './posix-sandbox.ts';

describe('host process probes used by the shell tests', () => {
  it('reads the state after the last parenthesis of /proc/<pid>/stat, whatever the command name holds', () => {
    expect(procStatState('4242 (sleep) S 1 4242 4242 0 -1')).toBe('S');
    expect(procStatState('77 (a) b) (c) Z 1 77 77 0 -1')).toBe('Z');
    expect(procStatState('garbage')).toBeNull();
  });

  it('finds live processes by exact argv in a /proc tree and leaves zombies, other argv and vanished entries out', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 's01-proc-'));
    try {
      const entry = (pid: string, cmdline: string | null, stat: string | null) => {
        fs.mkdirSync(path.join(root, pid));
        if (cmdline !== null) fs.writeFileSync(path.join(root, pid, 'cmdline'), cmdline);
        if (stat !== null) fs.writeFileSync(path.join(root, pid, 'stat'), stat);
      };
      entry('310', 'sleep\u00002000310\u0000', '310 (sleep) S 1');
      entry('311', 'sleep\u00002000310\u0000', '311 (sleep) Z 1');
      entry('312', 'sleep\u00002000311\u0000', '312 (sleep) S 1');
      entry('313', 'sleep\u00002000310\u0000extra\u0000', '313 (sleep) S 1');
      entry('314', null, null);
      entry('self', 'sleep\u00002000310\u0000', 'self (sleep) S 1');
      entry('29', 'sleep\u00002000310\u0000', '29 (sleep) R 1');
      expect(procPidsWithArgv(['sleep', '2000310'], root)).toEqual([29, 310]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('finds live processes by exact argv in ps output and leaves zombies and other argv out', () => {
    const listing = [
      '  310 S    sleep 2000310',
      '  311 Z    sleep 2000310',
      '  312 UN   sleep 2000311',
      '  313 S+   sleep 2000310 extra',
      ' 9001 Ss   sleep 2000310 ',
      '',
    ].join('\n');
    expect(psPidsWithArgv(listing, ['sleep', '2000310'])).toEqual([310, 9001]);
  });

  it.skipIf(process.platform === 'win32')('sees a real child by argv while it runs and not after it is killed', async () => {
    const argv = uniqueSleepArgv();
    const child = spawn(argv[0]!, [argv[1]!], { stdio: 'ignore' });
    try {
      expect(await until(() => hostPidsWithArgv(argv).includes(child.pid!), 5_000)).toBe(true);
      expect(processRunning(child.pid!)).toBe(true);
    } finally { child.kill('SIGKILL'); }
    await new Promise(resolve => { child.once('exit', resolve); });
    expect(await until(() => hostPidsWithArgv(argv).length === 0 && !processRunning(child.pid!), 5_000)).toBe(true);
  });
});

describe('sandbox capability probe used by the shell tests', () => {
  const host = (files: string[], status: number | null, stderr = '') => {
    const runs: string[][] = [];
    const probe: ProbeHost = { exists: file => files.includes(file), run: (program, args) => { runs.push([program, ...args]); return { status, stderr }; } };
    return { probe, runs };
  };

  it('on Linux runs bwrap with the namespaces the sandbox needs under the launcher\'s prlimit, with fixed arguments', () => {
    const { probe, runs } = host([PRLIMIT, '/usr/bin/bwrap'], 0);
    expect(probePosixSandbox('linux', probe, '/usr/bin:/bin')).toEqual({ available: true, reason: '/usr/bin/bwrap creates namespaces under prlimit' });
    expect(runs).toEqual([[PRLIMIT, '--cpu=130:130', '--fsize=4294967296:4294967296', '--nproc=2048:2048', '--', '/usr/bin/bwrap',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session',
      '--', '/bin/sh', '-c', 'exit 0']]);
  });

  it('on Linux names the missing launcher, and quotes bwrap when it is installed but refuses namespaces', () => {
    expect(probePosixSandbox('linux', host([], 0).probe, '/usr/bin')).toEqual({ available: false, reason: '/usr/bin/prlimit is not installed (util-linux)' });
    expect(probePosixSandbox('linux', host([PRLIMIT], 0).probe, '/usr/bin')).toEqual({ available: false, reason: 'bwrap is not installed (bubblewrap)' });
    const onPath = host([PRLIMIT, '/opt/bubblewrap/bin/bwrap'], 0);
    expect(probePosixSandbox('linux', onPath.probe, 'relative:/opt/bubblewrap/bin').available).toBe(true);
    expect(onPath.runs[0]).toContain('/opt/bubblewrap/bin/bwrap');
    const restricted = host([PRLIMIT, '/bin/bwrap'], 1, 'bwrap: setting up uid map: Permission denied\n');
    expect(probePosixSandbox('linux', restricted.probe, '')).toEqual({ available: false,
      reason: '/bin/bwrap is installed but refused to sandbox a command here: bwrap: setting up uid map: Permission denied' });
  });

  it('on macOS asks sandbox-exec to apply a profile; elsewhere there is no POSIX sandbox', () => {
    const ok = host([], 0);
    expect(probePosixSandbox('darwin', ok.probe).available).toBe(true);
    expect(ok.runs).toEqual([['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true']]);
    expect(probePosixSandbox('darwin', host([], 71, 'sandbox-exec: sandbox_apply: Operation not permitted').probe)).toEqual({ available: false,
      reason: 'sandbox-exec is installed but refused to sandbox a command here: sandbox-exec: sandbox_apply: Operation not permitted' });
    expect(probePosixSandbox('darwin', host([], null).probe).reason).toBe('sandbox-exec is installed but refused to sandbox a command here: exit status null');
    expect(probePosixSandbox('win32', host([], 0).probe)).toEqual({ available: false, reason: 'no POSIX shell sandbox on win32' });
  });
});
