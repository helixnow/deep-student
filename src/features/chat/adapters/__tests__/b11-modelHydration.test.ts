import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { clearModelsCache } from '../../hooks/useAvailableModels';
import {
  ensureModelMetadataReady,
  getValidChatModelIdSet,
  hydrateDefaultChatModelIfMissing,
  normalizeChatModelSelection,
} from '../tauri/modelSelection';
import type { TauriAdapterHost } from '../tauri/adapterHost';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createHost() {
  const state = { chatParams: { modelId: '', model2OverrideId: null as string | null, modelDisplayName: '' } };
  const setChatParams = vi.fn((params) => { Object.assign(state.chatParams, params); });
  const host = {
    setupGeneration: 1,
    getCurrentState: () => state,
    isSessionRuntimeOwner: () => true,
    store: { setChatParams },
    getValidChatModelIdSet: () => getValidChatModelIdSet(host),
    ensureModelMetadataReady: (id: string) => ensureModelMetadataReady(host, id),
    normalizeChatModelSelection: (id: string, override: string) => normalizeChatModelSelection(host, id, override),
  } as unknown as TauriAdapterHost;
  return { host, state, setChatParams };
}

const configs = [{ id: 'default', name: 'Default', model: 'default-model', enabled: true }];
const selection = { modelId: 'default', effectiveModelId: 'default', modelDisplayName: 'Default' };

describe('B11 session-load model hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModelsCache();
    vi.mocked(invoke).mockResolvedValue(configs);
  });

  it('preserves a model picked while background hydration waits on WAN', async () => {
    const { host, state, setChatParams } = createHost();
    const pending = deferred<typeof selection>();
    host.normalizeChatModelSelection = vi.fn(() => pending.promise);
    const loading = hydrateDefaultChatModelIfMissing(host);
    await vi.waitFor(() => expect(host.normalizeChatModelSelection).toHaveBeenCalled());
    state.chatParams = { ...state.chatParams, model2OverrideId: 'user-picked', modelDisplayName: 'User picked' };
    pending.resolve(selection);
    await loading;
    expect(setChatParams).not.toHaveBeenCalled();
    expect(state.chatParams.model2OverrideId).toBe('user-picked');
  });

  it('does not write metadata after the adapter loses its runtime lease', async () => {
    const { host, setChatParams } = createHost();
    const pending = deferred<typeof selection>();
    host.normalizeChatModelSelection = vi.fn(() => pending.promise);
    const loading = hydrateDefaultChatModelIfMissing(host);
    await vi.waitFor(() => expect(host.normalizeChatModelSelection).toHaveBeenCalled());
    host.isSessionRuntimeOwner = () => false;
    pending.resolve(selection);
    await loading;
    expect(setChatParams).not.toHaveBeenCalled();
  });

  it('does not write metadata from an earlier setup of the same adapter', async () => {
    const { host, setChatParams } = createHost();
    const pending = deferred<typeof selection>();
    host.normalizeChatModelSelection = vi.fn(() => pending.promise);
    const loading = hydrateDefaultChatModelIfMissing(host);
    await vi.waitFor(() => expect(host.normalizeChatModelSelection).toHaveBeenCalled());
    host.setupGeneration++;
    pending.resolve(selection);
    await loading;
    expect(setChatParams).not.toHaveBeenCalled();
  });

  it('starts assignment and validity RPCs without waiting for cold model metadata', async () => {
    const { host, setChatParams } = createHost();
    const metadata = deferred<typeof configs>();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_api_configurations') return metadata.promise;
      if (command === 'get_model_assignments') return Promise.resolve({ model2_config_id: 'default' });
      throw new Error(`Unexpected RPC ${command}`);
    });
    const loading = hydrateDefaultChatModelIfMissing(host);
    const started = vi.mocked(invoke).mock.calls.map(([command]) => command);
    metadata.resolve(configs);
    await loading;
    expect(started).toEqual(['get_api_configurations', 'get_model_assignments', 'get_api_configurations']);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(setChatParams).toHaveBeenCalledWith({ model2OverrideId: null, modelDisplayName: 'default-model' });
  });
});
