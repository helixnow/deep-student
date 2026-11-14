import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import diagnostics from '../index.ts';
import { runInstallCommand } from '../package-manager.ts';

it('install_command_success_captures_status', async () => { expect((await runInstallCommand('echo hello', 10000))[0]).toBe(true); });
it('install_command_failure_captures_stderr', async () => {
  const [success, stderr] = await runInstallCommand('echo boom >&2; exit 3', 10000);
  expect(success).toBe(false); expect(stderr).toContain('boom');
});
it('install_command_timeout_kills_child', async () => {
  const start = performance.now();
  await expect(runInstallCommand('sleep 60', 100)).rejects.toThrow('超时');
  expect(performance.now() - start).toBeLessThan(10000);
});
it('install_command_large_output_is_capped_and_drained', async () => { expect((await runInstallCommand('yes | head -c 5000000', 30000))[0]).toBe(true); });
it('package command wire values preserve unknown detection and unsupported installation', async () => {
  const host = await createTestHost({ plugins: [diagnostics], provide: { storage: {} } });
  try {
    expect(await host.invoke('check_package_manager', { command: 'npm' })).toEqual({ detected: false, message: "无法识别命令 'npm' 所需的包管理器" });
    expect(await host.invoke('auto_install_package_manager', { managerType: 'npm' })).toEqual({ success: false, message: '不支持自动安装 npm，请手动安装', installed_version: null });
  } finally { await host.dispose(); }
});
