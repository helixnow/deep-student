import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  HEADLESS_ALLOWED_TOOLS, ShellCommandGuardEffect, immutableShellCommandGuard,
  authorizeRuntimeRootPath, runtimeRootById, revalidateRuntimeRoot,
  newSubagentTask, newSleepBlockData, writeBytes, type WorkspaceCoordinator, type WorkspaceMutationReceipt,
} from '../api.ts';
import { createWorkspaceHost } from './host-support.ts';

it('publishes L04 workspace managers and events through the production service contract', async () => {
  const { host, storage } = await createWorkspaceHost();
  const coordinator: WorkspaceCoordinator = host.ctx.agentWorkspace;
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const workspace = coordinator.createWorkspace('coord', 'public API');
    coordinator.registerAgent(workspace.id, 'coord', 'coordinator', null, null);
    coordinator.registerAgent(workspace.id, 'worker', 'worker', null, null);
    const tasks = coordinator.getTaskManager(workspace.id);
    const task = newSubagentTask(workspace.id, 'worker', null, 'test');
    tasks.createTask(task);
    tasks.markRunning(task.id);
    expect(tasks.getTask(task.id)?.status).toBe('running');
    const sleeps = coordinator.getSleepManager(workspace.id);
    const sleep = newSleepBlockData(workspace.id, 'coord', [], { type: 'result_message' });
    const receiver = sleeps.beginSleep(sleep);
    expect(sleeps.isSleepActive(sleep.id)).toBe(true);
    coordinator.emitWarning({ workspace_id: workspace.id, code: 'worker_failed', message: 'failed', agent_session_id: 'worker', message_id: null, retry_count: null, max_retries: null });
    coordinator.emitCoordinatorAwakened({ workspaceId: workspace.id, coordinatorSessionId: 'coord', sleepId: sleep.id, awakenedBy: 'worker', awakenMessage: 'done', wakeReason: 'message' });
    expect(host.eventsNamed('workspace_warning')).toEqual([{ workspace_id: workspace.id, code: 'worker_failed', message: 'failed', agent_session_id: 'worker', message_id: null, retry_count: null, max_retries: null }]);
    expect(host.eventsNamed('workspace_coordinator_awakened')).toEqual([{ workspace_id: workspace.id, coordinator_session_id: 'coord', sleep_id: sleep.id, awakened_by: 'worker', awaken_message: 'done', wake_reason: 'message' }]);
    coordinator.closeWorkspace(workspace.id);
    expect(receiver.tryRecv()?.reason).toBe('cancelled');
  } finally {
    coordinator.shutdownAllSleeps();
    await coordinator.enterMaintenanceMode();
    storage.dispose();
    await host.dispose();
  }
});

it('publishes L03 guard and L19 read-only authorization without broadening headless access', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    expect(immutableShellCommandGuard('', null, [])).toEqual({ effect: ShellCommandGuardEffect.Deny, reason: 'empty_command' });
    expect(immutableShellCommandGuard('git status --short', null, []).effect).toBe(ShellCommandGuardEffect.Allow);
    expect(HEADLESS_ALLOWED_TOOLS).toContain('builtin-resource_read');
    expect(HEADLESS_ALLOWED_TOOLS.filter(name => name.startsWith('builtin-browser_'))).toEqual([]);
    const rootPath = path.join(host.app.dataDir, 'upload');
    fs.mkdirSync(rootPath);
    const outcome = authorizeRuntimeRootPath(host.ctx.settings, rootPath, 'Upload', host.ctx.get('nativeWindowsFiles'));
    const root = runtimeRootById({ settings: host.ctx.settings, dataDir: host.app.dataDir, windowsFiles: host.ctx.get('nativeWindowsFiles') }, 'session', null, outcome.rootId, false);
    expect(root.access).toBe('read_only');
    expect(revalidateRuntimeRoot(host.ctx.settings, root, host.ctx.get('nativeWindowsFiles'))).toBe(fs.realpathSync.native(rootPath));
    await host.invoke('chat_v2_revoke_runtime_root', { rootId: outcome.rootId });
    expect(() => revalidateRuntimeRoot(host.ctx.settings, root, host.ctx.get('nativeWindowsFiles'))).toThrow('Authorized runtime root was revoked');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('publishes writeBytes for owner-delegated workspace writes (W04 Office output_target=workspace)', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-write-bytes-'));
  try {
    const checkpoints = path.join(root, '.checkpoints');
    const created: WorkspaceMutationReceipt = writeBytes(root, checkpoints, 'workspace', 'out/report.docx', Buffer.from('v1'));
    expect(created).toMatchObject({ root_id: 'workspace', op: 'created', relative_path: 'out/report.docx', bytes: 2 });
    expect(fs.readFileSync(path.join(root, 'out/report.docx'), 'utf8')).toBe('v1');
    expect(() => writeBytes(root, checkpoints, 'workspace', 'out/report.docx', Buffer.from('v2'))).toThrow(
      'expected_current_hash is required when overwriting an existing workspace file');
    const modified = writeBytes(root, checkpoints, 'workspace', 'out/report.docx', Buffer.from('v2'), created.after_hash);
    expect(modified).toMatchObject({ op: 'modified', before_hash: created.after_hash });
    expect(typeof modified.backup_ref).toBe('string');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
