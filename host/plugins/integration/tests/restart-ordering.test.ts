import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-impl: L22 集成测试必须用真实 L21 备份插件验证清理标记先于重启请求
import { createBackupHost } from '../../backup/tests/helpers.ts';

/**
 * `sync_r10_android.rs::restart_command_shell_registration_and_ordering_are_anchored`
 * 的 Electron 侧等价：`data_governance_purge_all_data` 必须先把清理标记落盘，
 * 再发出 `process:restart`；标记写失败时不得重启。
 */
it('restart_command_shell_registration_and_ordering_are_anchored', async () => {
  const observed: Array<{ op: string; markerExists: boolean; markerContent: string | null }> = [];
  let host!: TestHost;

  const created = await createBackupHost({
    shell: (op) => {
      if (op === 'process:restart') {
        const marker = join(host.app.dataDir, '.purge_on_next_start');
        observed.push({
          op,
          markerExists: existsSync(marker),
          markerContent: existsSync(marker) ? readFileSync(marker, 'utf8') : null,
        });
      }
      return null;
    },
  });
  host = created.host;
  try {
    // 命令已注册：能通过真实命令表执行；F2 shell 收到重启请求后本进程仍存活，
    // 因此命令必须以「应用重启未生效」失败，而不是假装成功。
    await expect(host.invoke('data_governance_purge_all_data'))
      .rejects.toThrow('应用重启未生效：进程仍在运行');

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      op: 'process:restart',
      markerExists: true,
      markerContent: '1',
    });
    expect(host.shellRequests.map(request => request.op)).toContain('process:restart');
  } finally {
    await host.dispose();
  }
});
