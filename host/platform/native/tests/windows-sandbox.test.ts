import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('Windows native AppContainer/Job bridge', () => {
  it.runIf(process.platform === 'win32')('creates/deletes a real profile, derives capability SIDs and cancels before process launch', async () => {
    const host = await createTestHost({ plugins: [native] });
    const api = host.ctx.nativeWindowsSandbox;
    const profile = api.createProfile(`DeepStudentShell-${randomUUID()}`);
    try {
      expect(profile.sid.length).toBeGreaterThan(8);
      expect(api.deriveCapabilitySids('internetClient').length).toBeGreaterThan(0);
      const system = api.systemDirectory();
      expect(await api.runAppContainer(profile, { application: `${system}\\cmd.exe`,
        commandLine: `"${system}\\cmd.exe" /d /c exit 7`, cwd: system, signal: AbortSignal.abort() })).toBe(124);
      expect(await api.runAppContainer(profile, { application: `${system}\\cmd.exe`,
        commandLine: `"${system}\\cmd.exe" /d /c exit 7`, cwd: system })).toBe(7);
    } finally { profile.close(); await host.dispose(); }
  });

  it.runIf(process.platform === 'win32')('run_unsandboxed_job_process: full-access Job returns the exit code and 124 when cancelled', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeWindowsSandbox;
      const system = api.systemDirectory();
      const launch = { application: `${system}\\cmd.exe`, commandLine: `"${system}\\cmd.exe" /d /c exit 7`, cwd: system };
      expect(await api.runFullAccessJob(launch)).toBe(7);
      expect(await api.runFullAccessJob({ ...launch, signal: AbortSignal.abort() })).toBe(124);
      const controller = new AbortController();
      const running = api.runFullAccessJob({ ...launch, commandLine: `"${system}\\cmd.exe" /d /c ping -n 30 127.0.0.1`,
        signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      expect(await running).toBe(124);
    } finally { await host.dispose(); }
  });

  it.runIf(process.platform === 'win32')('acquire_acl_mutex: serializes in-process holders and returns null when cancelled while waiting', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const api = host.ctx.nativeWindowsSandbox;
      const first = await api.acquireAclMutex();
      expect(first).not.toBeNull();
      expect(await api.acquireAclMutex(AbortSignal.timeout(250))).toBeNull();
      first!.release();
      const second = await api.acquireAclMutex(AbortSignal.timeout(1000));
      expect(second).not.toBeNull();
      second!.release();
    } finally { await host.dispose(); }
  });

  it.runIf(process.platform !== 'win32')('does not report AppContainer available on a non-Windows kernel', async () => {
    const host = await createTestHost({ plugins: [native] });
    try { expect(() => host.ctx.nativeWindowsSandbox.createProfile('DeepStudentShell-test')).toThrow('require Windows x64');
      await expect(host.ctx.nativeWindowsSandbox.acquireAclMutex()).rejects.toThrow('require Windows x64');
      await expect(host.ctx.nativeWindowsSandbox.runFullAccessJob({ application: 'cmd.exe', commandLine: 'cmd.exe', cwd: '/' }))
        .rejects.toThrow('require Windows x64'); }
    finally { await host.dispose(); }
  });
});
