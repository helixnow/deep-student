import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { executeEditAndResend } from '../tauri/messageOperations';
import { validateAndCleanupContextRefs } from '../contextHelper';
import type { TauriAdapterHost } from '../tauri/adapterHost';
import type { ContextRef } from '../../resources/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('../../core/middleware/eventBridge', () => ({ resetBridgeState: vi.fn() }));
vi.mock('../../core/session/sessionManager', () => ({ sessionManager: { get: vi.fn() } }));
vi.mock('../contextHelper', () => ({
  validateAndCleanupContextRefs: vi.fn(),
  buildSendContextRefsWithPaths: vi.fn(),
  truncateContextByTokens: vi.fn(),
}));

function createHost(): TauriAdapterHost {
  return {
    sessionId: 'sess_edit',
    store: { setPendingParallelModelIds: vi.fn() },
    getCurrentState: () => ({ chatParams: { modelId: 'model_edit' } }),
    ensureModelMetadataReady: vi.fn(),
    buildSendOptions: vi.fn().mockResolvedValue({ modelId: 'model_edit' }),
    applyOriginalReplaySkillState: (_id: string, options: unknown) => options,
    applyRuntimeModelSelection: vi.fn(),
    beginStreamExpectation: vi.fn(),
  } as unknown as TauriAdapterHost;
}

describe('edit and resend context refs IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue({ new_message_id: 'msg_new' });
    vi.mocked(validateAndCleanupContextRefs).mockResolvedValue([]);
  });

  it('explicitly clears the snapshot when every selected resource was deleted', async () => {
    const host = createHost();
    const refs = [{ resourceId: 'deleted_resource', typeId: 'image' }] as ContextRef[];

    await executeEditAndResend(host, 'msg_user', 'edited content', refs);

    expect(validateAndCleanupContextRefs).toHaveBeenCalledWith(host.store, refs,
      { notifyUser: true, logDetails: true });
    expect(invoke).toHaveBeenCalledWith('chat_v2_edit_and_resend', expect.objectContaining({
      newContextRefs: [],
      newPathMap: undefined,
    }));
  });

  it('preserves the original snapshot when the caller does not supply a replacement', async () => {
    await executeEditAndResend(createHost(), 'msg_user', 'edited content');

    expect(validateAndCleanupContextRefs).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('chat_v2_edit_and_resend', expect.objectContaining({
      newContextRefs: undefined,
    }));
  });

  it('keeps an explicitly empty selection empty', async () => {
    await executeEditAndResend(createHost(), 'msg_user', 'edited content', []);

    expect(validateAndCleanupContextRefs).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('chat_v2_edit_and_resend', expect.objectContaining({
      newContextRefs: [],
    }));
  });
});
