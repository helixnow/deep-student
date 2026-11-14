import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { ChatV2TauriAdapter } from '../TauriAdapter';
import type { SendOptions } from '../types';
import { clearModelsCache, ensureModelsCacheLoaded } from '../../hooks/useAvailableModels';
import { inferInputContextBudget } from '@/utils/modelCapabilities';

const ID = 'RF-W09-stale-model-cache-context-budget';
const invokeMock = vi.mocked(invoke);
const MAX_TOKENS = 8192;

interface Config {
  id: string;
  name: string;
  model: string;
  contextWindow: number;
}

const smoke = (contextWindow: number): Config => ({ id: 'smoke-model', name: 'Smoke Fake Chat', model: 'fake-chat', contextWindow });
const other: Config = { id: 'other-model', name: 'Other', model: 'other-chat', contextWindow: 32_768 };

let configs: Config[] = [];
let defaultModelId: string | null = null;

const budgetFor = (config: Config) =>
  inferInputContextBudget({ modelLike: config.model, maxOutputTokens: MAX_TOKENS, configContextWindow: config.contextWindow });
const fallbackBudget = inferInputContextBudget({ modelLike: '', maxOutputTokens: MAX_TOKENS });

function createAdapter(chatParams: Record<string, unknown> = {}) {
  const state = {
    sessionId: 'sess_budget',
    chatParams: { modelId: '', model2OverrideId: null, maxTokens: MAX_TOKENS, ...chatParams },
    setChatParams: vi.fn(),
    setPendingParallelModelIds: vi.fn(),
  };
  const adapter = new ChatV2TauriAdapter('sess_budget', state as any, { getState: () => state } as any) as any;
  return { adapter, state };
}

/** buildSendOptions reduced to the fields the budget depends on (sendOptions.ts budgets the session's own selection). */
function sessionSendOptions(adapter: any): SendOptions {
  const { chatParams } = adapter.getCurrentState();
  return {
    modelId: chatParams.modelId || undefined,
    model2OverrideId: chatParams.model2OverrideId || undefined,
    maxTokens: chatParams.maxTokens,
    contextLimit: adapter.resolveInputContextLimit(
      chatParams.modelId,
      chatParams.model2OverrideId || undefined,
      chatParams.maxTokens,
      chatParams.contextLimit,
    ),
  };
}

/** The steps sendOperations.executeSendMessage runs before the IPC call. */
async function prepareSend(adapter: any): Promise<SendOptions> {
  const { chatParams } = adapter.getCurrentState();
  await adapter.ensureModelMetadataReady(chatParams.model2OverrideId || chatParams.modelId);
  const options = sessionSendOptions(adapter);
  await adapter.applyRuntimeModelSelection(options);
  return options;
}

describe('ChatV2TauriAdapter context budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModelsCache();
    configs = [];
    defaultModelId = null;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') return configs.map((c) => ({ ...c, enabled: true }));
      if (cmd === 'get_model_assignments') return { model2_config_id: defaultModelId };
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  it(`${ID}: a session on the global default model budgets against that model's configured window`, async () => {
    configs = [smoke(1_048_576)];
    defaultModelId = 'smoke-model';
    await ensureModelsCacheLoaded();
    const { adapter } = createAdapter();

    const options = await prepareSend(adapter);

    expect(options.modelId).toBe('smoke-model');
    expect(fallbackBudget).toBeLessThan(budgetFor(smoke(1_048_576)));
    expect(options.contextLimit).toBe(budgetFor(smoke(1_048_576)));
  });

  it(`${ID}: a model added while the cache is still fresh is found on the next send`, async () => {
    configs = [other];
    defaultModelId = 'other-model';
    await ensureModelsCacheLoaded();
    configs = [other, smoke(1_048_576)];
    const { adapter, state } = createAdapter({ model2OverrideId: 'smoke-model' });

    const options = await prepareSend(adapter);

    expect(options.modelId).toBe('smoke-model');
    expect(options.contextLimit).toBe(budgetFor(smoke(1_048_576)));
    expect(state.setChatParams).toHaveBeenLastCalledWith({ modelDisplayName: 'fake-chat' });
  });

  it(`${ID}: a context window changed in Settings applies to the next send while no chat view is mounted`, async () => {
    configs = [smoke(131_072)];
    defaultModelId = 'smoke-model';
    await ensureModelsCacheLoaded();
    configs = [smoke(1_048_576)];
    window.dispatchEvent(new CustomEvent('api_configurations_changed'));
    const { adapter } = createAdapter({ model2OverrideId: 'smoke-model' });

    const options = await prepareSend(adapter);

    expect(options.contextLimit).toBe(budgetFor(smoke(1_048_576)));
  });

  it(`${ID}: retrying with another model budgets against that model`, async () => {
    configs = [smoke(1_048_576), other];
    defaultModelId = 'smoke-model';
    await ensureModelsCacheLoaded();
    const { adapter } = createAdapter();
    vi.spyOn(adapter, 'buildSendOptions').mockImplementation(async () => sessionSendOptions(adapter));
    const sent: SendOptions[] = [];
    const backend = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'chat_v2_retry_message') {
        sent.push(args.options);
        return { message_id: args.messageId };
      }
      return backend(cmd, args);
    });

    await adapter.executeRetry('msg_assistant', 'other-model');

    expect(sent).toHaveLength(1);
    expect(sent[0].modelId).toBe('other-model');
    expect(sent[0].contextLimit).toBe(budgetFor(other));
  });

  it(`${ID}: a context limit the user set still wins over the model window`, async () => {
    configs = [smoke(1_048_576)];
    defaultModelId = 'smoke-model';
    await ensureModelsCacheLoaded();
    const { adapter } = createAdapter({ contextLimit: 50_000 });

    const options = await prepareSend(adapter);

    expect(options.modelId).toBe('smoke-model');
    expect(options.contextLimit).toBe(50_000);
  });
});
