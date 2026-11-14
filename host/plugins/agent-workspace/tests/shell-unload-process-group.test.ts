import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { memorySettings } from './support.ts';
import { tempRoot } from '../src/runtime-roots.ts';
import type { AgentWorkspaceToolExecutors } from '../src/tools/executors.ts';
import type { LocalShellExecuteExecutor } from '../src/tools/shell-execute.ts';
import type { JsonValue } from '../src/tools/shared.ts';
import type { AuthorityMode, PermissionPreset } from '../src/tools/shell-authority.ts';
import { processRunning, until } from './host-processes.ts';

const FULL_ACCESS: [AuthorityMode, PermissionPreset] = ['craft', 'full_access'];

interface RegisteredShell {
  host: Awaited<ReturnType<typeof createTestHost>>;
  pluginId: string;
  temp: string;
  run(command: string): Promise<JsonValue>;
}

/** The production registration with a stand-in L04 roster, around the shell it registered. */
async function withRegisteredShell(body: (env: RegisteredShell) => Promise<void>): Promise<void> {
  const host = await createTestHost({ provide: { settings: memorySettings() } });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    host.ctx.provide('storage', storage);
    const [installed] = await host.install(plugin);
    const tools = host.ctx.get('agentWorkspaceTools') as AgentWorkspaceToolExecutors;
    const shells: LocalShellExecuteExecutor[] = [];
    const createShell = tools.createShell.bind(tools);
    (tools as { createShell: () => LocalShellExecuteExecutor }).createShell = () => {
      const shell = createShell();
      shells.push(shell);
      return shell;
    };
    host.ctx.provide('agentTools', { registerToolExecutors: () => ({ dispose: () => undefined }) } as never);
    expect(await until(() => shells.length > 0, 2_000)).toBe(true);
    expect(shells).toHaveLength(1);
    const sessionId = 'unload';
    const temp = tempRoot(host.app.dataDir, sessionId, true).path;
    await body({ host, pluginId: installed!.id, temp, run: command => shells[0]!.executeShell(
      { command, cwd: temp, track_file_changes: false, timeout_ms: 20_000 },
      { sessionId, dataDir: host.app.dataDir, settings: host.ctx.settings, authority: FULL_ACCESS,
        shellAuthorityAdmission: FULL_ACCESS, shellGuardApproved: true }) });
  } finally { storage.dispose(); await host.dispose(); }
}

describe.skipIf(process.platform === 'win32')('local shell process groups follow the agent-workspace plugin lifetime', () => {
  it('RF-S01-shell-orphaned-on-unload: unloading the plugin kills a running command and its background children', async () => {
    await withRegisteredShell(async env => {
      const pidFile = path.join(env.temp, 'bg.pid');
      const pending = env.run(`sleep 30 & echo $! > '${pidFile}'; wait`);
      expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 5_000)).toBe(true);
      const background = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(processRunning(background)).toBe(true);
      const started = Date.now();
      await env.host.unload(env.pluginId);
      expect(await until(() => !processRunning(background), 3_000)).toBe(true);
      const output = await pending;
      expect(output).toMatchObject({ success: false, timed_out: false, cancelled: true });
      expect((output as { stderr: string }).stderr).toContain('sandbox process tree was terminated');
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }, 30_000);

  it('RF-S01-shell-orphaned-on-unload: a shell left over after unload refuses to spawn', async () => {
    await withRegisteredShell(async env => {
      const marker = path.join(env.temp, 'ran');
      await env.host.unload(env.pluginId);
      await expect(env.run(`touch '${marker}'`)).rejects.toThrow('Local shell executor was disposed with its plugin; command not started');
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});
