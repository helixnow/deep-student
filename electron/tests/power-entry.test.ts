/** Real command registry and Cordis exporter; only the final OS inhibitor executable is isolated. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../host/kernel/testing.ts';
import plugin from '../index.ts';

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-power-entry-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function host(platform: 'linux' | 'win32') {
  const h = await createTestHost({ plugins: [plugin], app: { platform } });
  const logs: Array<{ type: string; content: string; name: string }> = [];
  h.ctx.logger.exporter({ levels: { default: 4 }, export: (message) => {
    if (message.name === 'deep_student_lib::cmd::power') logs.push({ type: message.type, content: String(message.args[0]), name: message.name });
  } });
  return { h, logs };
}

it('unsupported power enable warns, while querying and disabling stay silent', async () => {
  const { h, logs } = await host('win32');
  try {
    await expect(h.invoke('set_prevent_sleep', { enabled: true })).resolves.toBe(false);
    await expect(h.invoke('get_prevent_sleep')).resolves.toBe(false);
    await expect(h.invoke('set_prevent_sleep', { enabled: false })).resolves.toBe(false);
    expect(logs).toEqual([{ name: 'deep_student_lib::cmd::power', type: 'warn', content: '[power] prevent-sleep not supported on this platform' }]);
  } finally { await h.dispose(); }
});

it.skipIf(process.platform !== 'linux')('power spawn failure warns with the returned Rust error and does not poison later calls', async () => {
  const { h, logs } = await host('linux');
  vi.stubEnv('PATH', temp()); // Real spawn fails ENOENT; no system inhibitor is invoked.
  try {
    const error = 'failed to spawn systemd-inhibit: No such file or directory (os error 2)';
    await expect(h.invoke('set_prevent_sleep', { enabled: true })).rejects.toBe(error);
    await expect(h.invoke('get_prevent_sleep')).resolves.toBe(false);
    await expect(h.invoke('set_prevent_sleep', { enabled: false })).resolves.toBe(false);
    expect(logs).toEqual([{ name: 'deep_student_lib::cmd::power', type: 'warn', content: `[power] failed to enable prevent-sleep: ${error}` }]);
  } finally { await h.dispose(); }
});

it.skipIf(process.platform !== 'linux')('power enable is idempotent and disable waits for the isolated child before logging', async () => {
  const { h, logs } = await host('linux');
  const bin = temp();
  // This OS-boundary fixture only keeps a real child alive. It does not assert Linux inhibitor behavior.
  writeFileSync(join(bin, 'systemd-inhibit'), '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 });
  vi.stubEnv('PATH', bin);
  try {
    await expect(h.invoke('set_prevent_sleep', { enabled: true })).resolves.toBe(true);
    await expect(h.invoke('set_prevent_sleep', { enabled: true })).resolves.toBe(true);
    await expect(h.invoke('get_prevent_sleep')).resolves.toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ name: 'deep_student_lib::cmd::power', type: 'info', content: expect.stringMatching(/^\[power\] prevent-sleep enabled \(pid=\d+\)$/) });
    const pid = Number(logs[0]!.content.match(/pid=(\d+)/)![1]);
    await expect(h.invoke('set_prevent_sleep', { enabled: false })).resolves.toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(h.invoke('set_prevent_sleep', { enabled: false })).resolves.toBe(false);
    await expect(h.invoke('get_prevent_sleep')).resolves.toBe(false);
    expect(logs.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'info', content: `[power] prevent-sleep enabled (pid=${pid})` },
      { type: 'info', content: '[power] prevent-sleep disabled' },
    ]);
  } finally { await h.dispose(); }
});

it.skipIf(process.platform !== 'linux')('querying an exited inhibitor clears it without a later disabled log', async () => {
  const { h, logs } = await host('linux');
  const bin = temp();
  writeFileSync(join(bin, 'systemd-inhibit'), '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 });
  vi.stubEnv('PATH', bin);
  try {
    await expect(h.invoke('set_prevent_sleep', { enabled: true })).resolves.toBe(true);
    const pid = Number(logs[0]!.content.match(/pid=(\d+)/)![1]);
    process.kill(pid, 'SIGKILL'); // Only this test's own isolated child.
    await vi.waitFor(async () => expect(await h.invoke('get_prevent_sleep')).toBe(false));
    await expect(h.invoke('set_prevent_sleep', { enabled: false })).resolves.toBe(false);
    expect(logs).toEqual([{ name: 'deep_student_lib::cmd::power', type: 'info', content: `[power] prevent-sleep enabled (pid=${pid})` }]);
  } finally { await h.dispose(); }
});
