import { describe, expect, it } from 'vitest';
import { MobileApprovalManager } from '../src/mobile-approval.ts';

describe('mobile agentApproval provider', () => {
  it('resolves a pending permission request through respondWithResult', async () => {
    const manager = new MobileApprovalManager();
    const pending = manager.registerWithPermissionPreset('ses', 'call', 'vfs_upload_file', {}, 'relaxed', 'medium');
    expect(manager.pendingCount()).toBe(1);
    expect(manager.respondWithResult({
      sessionId: 'ses', toolCallId: 'call', toolName: 'vfs_upload_file',
      approved: true, reason: null, remember: true, rememberSession: true,
    })).toEqual({ delivered: true, settingKey: null });
    await expect(pending).resolves.toMatchObject({ approved: true, remember: false, rememberSession: false });
    expect(manager.pendingCount()).toBe(0);
  });

  it('cancels by session and rejects all remaining requests', async () => {
    const manager = new MobileApprovalManager();
    const first = manager.registerWithScope('ses-a', 'a', 'tool_a', null);
    const second = manager.registerWithScope('ses-b', 'b', 'tool_b', null);
    expect(manager.cancelWithSession('ses-a', 'a')).toBe(true);
    await expect(first).resolves.toMatchObject({ approved: false });
    expect(manager.rejectAllPending('stream closed')).toBe(1);
    await expect(second).resolves.toMatchObject({ approved: false, reason: 'stream closed' });
  });

  it('never persists remembered approvals on mobile', () => {
    const manager = new MobileApprovalManager();
    expect(manager.checkRemembered('tool', null)).toBeNull();
    expect(manager.checkSessionRemembered('ses', 'tool', null)).toBeNull();
    expect(manager.defaultTimeout()).toBe(300);
  });
});
