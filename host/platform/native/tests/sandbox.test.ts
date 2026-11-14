import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { SandboxLaunch } from '../sandbox/api.ts';
import native from '../index.ts';

async function outcome(host: TestHost, request: SandboxLaunch): Promise<{ code: number | null; ready: boolean; stderr: string }> {
  const child = await host.ctx.nativeSandbox.spawn(request);
  let stderr = '';
  const read = (async () => { for await (const chunk of child.stderr) stderr += Buffer.from(chunk).toString(); })();
  try {
    const code = await child.wait();
    await read;
    return { code, ready: await child.ready, stderr };
  } finally { await child.cleanupFinishedProcessGroup(); }
}

describe('native sandbox process boundary', () => {
  it('fails closed when a launcher is absent and before an already-cancelled launch', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(await host.ctx.nativeSandbox.probe('linux_bwrap', '/nonexistent/bwrap')).toMatchObject({ available: false });
      await expect(host.ctx.nativeSandbox.spawn({ backend: 'linux_bwrap', program: '/nonexistent/bwrap', args: [],
        cwd: '/', env: {}, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    } finally { await host.dispose(); }
  });

  it.runIf(process.platform === 'linux')('real bwrap confines files/network, applies limits, clears environment and reaps a killed group', async () => {
    const host = await createTestHost({ plugins: [native] });
    const root = await mkdtemp(join(tmpdir(), 'f7-bwrap-'));
    try {
      // Executable location injection only; no opt-in gate. In this lane we test
      // Debian's unpacked bwrap when the system package is not installed.
      const available = await host.ctx.nativeSandbox.probe('linux_bwrap', process.env.F7_TEST_BWRAP);
      if (!available.available) {
        expect(available.reason.length).toBeGreaterThan(0);
        return; // Rust sandbox e2e also returns when the native launcher is unavailable.
      }
      await writeFile(join(root, 'input'), 'sandbox data');
      const base = ['--tmpfs', '/'];
      for (const system of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) base.push('--ro-bind', system, system);
      base.push('--dev', '/dev', '--proc', '/proc', '--bind', root, root,
        '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session', '--chdir', root, '--');
      const request = { backend: 'linux_bwrap' as const, program: available.program, cwd: root,
        env: { PATH: '/usr/bin:/bin' }, args: [...base, '/bin/sh', '-c',
          'cat input > output; test ! -e /home/dsdev; test -z "$HOME"; ulimit -t; ulimit -f; cat /proc/net/route'] };
      const child = await host.ctx.nativeSandbox.spawn(request);
      let stdout = '';
      const output = (async () => { for await (const chunk of child.stdout) stdout += Buffer.from(chunk).toString(); })();
      expect(await child.wait()).toBe(0);
      await output;
      await child.cleanupFinishedProcessGroup();
      expect(await readFile(join(root, 'output'), 'utf8')).toBe('sandbox data');
      expect(stdout).toContain('130');
      expect(stdout).not.toMatch(/^eth\d/mu);
      const waiting = await host.ctx.nativeSandbox.spawn({ ...request, args: [...base, '/bin/sh', '-c', 'sleep 60 & wait'] });
      await waiting.terminateProcessGroup();
      expect(await waiting.wait()).toBeNull();
      expect(await waiting.ready).toBe(false);
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'linux')('fd 3 ready pipe through prlimit + bwrap: true once the script runs, false when bwrap setup fails', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const available = await host.ctx.nativeSandbox.probe('linux_bwrap', process.env.F7_TEST_BWRAP);
      if (!available.available) {
        expect(available.reason.length).toBeGreaterThan(0);
        return;
      }
      const base = ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session'];
      const run = (setup: string[], script: string) => outcome(host, { backend: 'linux_bwrap', program: available.program,
        cwd: '/', env: { PATH: '/usr/bin:/bin' }, args: [...setup, '--', '/bin/sh', '-c', script] });
      expect(await run(base, 'printf R >&3; exec 3>&-; exit 1')).toMatchObject({ code: 1, ready: true });
      const failed = await run([...base, '--ro-bind', '/nonexistent-w01-ready', '/mnt'], 'printf R >&3; exit 0');
      expect(failed.ready).toBe(false);
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).toContain('nonexistent-w01-ready');
      expect(await run(base, 'exit 0')).toMatchObject({ code: 0, ready: false });
    } finally { await host.dispose(); }
  });

  it.runIf(process.platform === 'darwin')('fd 3 ready pipe through ulimit + sandbox-exec: true once the script runs, false when the profile or exec is refused', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const available = await host.ctx.nativeSandbox.probe('macos_seatbelt');
      if (!available.available) {
        expect(available.reason.length).toBeGreaterThan(0);
        return;
      }
      const run = (profile: string, script: string) => outcome(host, { backend: 'macos_seatbelt', program: available.program,
        cwd: '/', env: { PATH: '/usr/bin:/bin' }, args: ['-p', profile, '/bin/sh', '-c', script] });
      const allow = '(version 1)(allow default)';
      expect(await run(allow, 'printf R >&3; exec 3>&-; exit 1')).toMatchObject({ code: 1, ready: true });
      const badProfile = await run('(version 1)(not-a-rule)', 'printf R >&3; exit 0');
      expect(badProfile).toMatchObject({ code: 65, ready: false });
      expect(badProfile.stderr).toContain('not-a-rule');
      const execDenied = await run(`${allow}(deny process-exec)`, 'printf R >&3; exit 0');
      expect(execDenied).toMatchObject({ code: 71, ready: false });
      expect(execDenied.stderr).toContain('execvp()');
      expect(await run(allow, 'exit 0')).toMatchObject({ code: 0, ready: false });
    } finally { await host.dispose(); }
  });

  it.runIf(process.platform === 'darwin')('real Seatbelt launcher enforces its supplied write policy (macOS target test)', async () => {
    const host = await createTestHost({ plugins: [native] });
    const root = await mkdtemp(join(tmpdir(), 'f7-seatbelt-'));
    try {
      const available = await host.ctx.nativeSandbox.probe('macos_seatbelt');
      if (!available.available) {
        expect(available.reason.length).toBeGreaterThan(0);
        return;
      }
      // This tests the native launcher primitive, not L05's policy builder.
      // The profile permits reads/processes but restricts writes to this job.
      const job = await realpath(root);
      const literal = JSON.stringify(job);
      const profile = `(version 1)(allow default)(deny file-write*)(deny network*)(allow file-write* (subpath ${literal}))`;
      const code = `const fs=require('node:fs'),assert=require('node:assert/strict');
        fs.writeFileSync(${JSON.stringify(join(job, 'output'))},'seatbelt data');
        assert.throws(()=>fs.writeFileSync(${JSON.stringify(`${job}-denied`)},'denied'));`;
      const child = await host.ctx.nativeSandbox.spawn({ backend: 'macos_seatbelt', program: available.program,
        cwd: job, env: { PATH: '/usr/bin:/bin' }, args: ['-p', profile, process.execPath, '-e', code] });
      expect(await child.wait()).toBe(0);
      await child.cleanupFinishedProcessGroup();
      expect(await readFile(join(job, 'output'), 'utf8')).toBe('seatbelt data');
    } finally {
      await host.dispose();
      await rm(`${root}-denied`, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
