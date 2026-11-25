import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { convertApiConfigToProfile, convertProfileToApiConfig } from '../modelConverters';
import { useSettingsVendorState } from '../useSettingsVendorState';
import { getKnowledgeModelCapability } from '../knowledgeModelCapabilities';
import type { ApiConfig, ModelAssignments, VendorConfig } from '@/types';

const defaultAssignments: ModelAssignments = {
  model2_config_id: null,
  anki_card_model_config_id: null,
  qbank_ai_grading_model_config_id: null,
  embedding_model_config_id: null,
  reranker_model_config_id: null,
  chat_title_model_config_id: null,
  exam_sheet_ocr_model_config_id: null,
  translation_model_config_id: null,
  vl_embedding_model_config_id: null,
  vl_reranker_model_config_id: null,
  memory_decision_model_config_id: null,
  voice_input_asr_model_config_id: null,
  image_generation_model_config_id: null,
  compaction_model_config_id: null,
  translation_display_mode: null,
};

const createDeps = (overrides: Partial<Parameters<typeof useSettingsVendorState>[0]> = {}) => ({
  resolvedApiConfigs: [],
  vendorLoading: false,
  vendorSaving: false,
  vendors: [] as VendorConfig[],
  modelProfiles: [],
  modelAssignments: defaultAssignments,
  config: {} as Parameters<typeof useSettingsVendorState>[0]['config'],
  t: ((key: string) => key) as Parameters<typeof useSettingsVendorState>[0]['t'],
  loading: false,
  upsertVendor: vi.fn(async (vendor: VendorConfig) => ({ ...vendor, id: vendor.id || 'new-vendor' })),
  upsertModelProfile: vi.fn(),
  deleteModelProfile: vi.fn(),
  persistAssignments: vi.fn(),
  persistModelProfiles: vi.fn(),
  persistVendors: vi.fn(),
  closeRightPanel: vi.fn(),
  refreshVendors: undefined,
  refreshProfiles: undefined,
  refreshApiConfigsFromBackend: vi.fn(),
  isSmallScreen: false,
  setScreenPosition: vi.fn(),
  setRightPanelType: vi.fn(),
  activeTab: 'apis',
  deleteVendorById: vi.fn(),
  ...overrides,
});

describe('useSettingsVendorState add vendor flow', () => {
  it.each([false, true])('closes the mobile model editor only after a successful save (success: %s)', async (saveSucceeds) => {
    const vendor: VendorConfig = {
      id: 'vendor-custom',
      name: 'Custom',
      providerType: 'custom',
      baseUrl: 'https://example.invalid/v1',
      apiKey: '',
    };
    const deps = createDeps({
      vendors: [vendor],
      isSmallScreen: true,
      upsertModelProfile: saveSucceeds
        ? vi.fn().mockResolvedValue({})
        : vi.fn().mockRejectedValue(new Error('save failed')),
    });
    const { result } = renderHook(() => useSettingsVendorState(deps));
    act(() => result.current.handleOpenModelEditor(vendor));
    const draft = { ...result.current.modelEditor!.api, model: 'custom-model' };

    await act(async () => {
      await result.current.handleSaveModelProfileAndClose(draft);
    });

    expect(deps.upsertModelProfile).toHaveBeenCalledTimes(1);
    if (saveSucceeds) {
      expect(result.current.modelEditor).toBeNull();
      expect(deps.closeRightPanel).toHaveBeenCalledTimes(1);
    } else {
      expect(result.current.modelEditor).not.toBeNull();
      expect(deps.closeRightPanel).not.toHaveBeenCalled();
    }
  });

  it('opens the add-vendor form without immediately persisting a default vendor', () => {
    const deps = createDeps();
    const { result } = renderHook(() => useSettingsVendorState(deps));

    act(() => {
      result.current.handleOpenVendorModal(null);
    });

    expect(deps.upsertVendor).not.toHaveBeenCalled();
    expect(result.current.vendorModalOpen).toBe(true);
    expect(result.current.editingVendor).toBeNull();
  });

  it('builds new model drafts with the vendor api protocol inherited into runtime config', () => {
    const vendor: VendorConfig = {
      id: 'vendor-openai',
      name: 'OpenAI Responses Vendor',
      providerType: 'openai',
      apiProtocol: 'openai_responses',
      supportsOpenAIResponses: true,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '***',
    };
    const deps = createDeps({ vendors: [vendor], modelProfiles: [] });
    const { result } = renderHook(() => useSettingsVendorState(deps));

    act(() => {
      result.current.handleOpenModelEditor(vendor);
    });

    const draft = result.current.modelEditor?.api as ApiConfig;
    expect(draft.apiProtocol).toBeUndefined();
    expect(draft.supportsOpenAIResponses).toBe(true);
    const profile = convertApiConfigToProfile(draft, vendor.id);
    expect(profile.apiProtocol).toBeUndefined();
    expect(convertProfileToApiConfig(profile, vendor).apiProtocol).toBe('openai_responses');
    expect(convertProfileToApiConfig(profile, { ...vendor, apiProtocol: 'openai_chat_completions' }).apiProtocol)
      .toBe('openai_chat_completions');
  });
});


describe('useSettingsVendorState bulk import capability inference (embed-gateway prefix)', () => {
  const gwVendor: VendorConfig = {
    id: 'vendor-embed-gw',
    name: 'Embed Gateway',
    providerType: 'custom',
    baseUrl: 'https://gw.example/v1',
    apiKey: 'sk-test',
  };

  const importModels = async (modelIds: string[]) => {
    const deps = createDeps({ vendors: [gwVendor], modelProfiles: [] });
    const { result } = renderHook(() => useSettingsVendorState(deps));
    await act(async () => {
      await result.current.handleAddVendorModels(
        gwVendor,
        modelIds.map(modelId => ({ modelId, label: modelId }))
      );
    });
    expect(deps.persistModelProfiles).toHaveBeenCalledTimes(1);
    const profiles = deps.persistModelProfiles.mock.calls[0][0] as Array<{
      model: string;
      isEmbedding: boolean;
      isReranker: boolean;
      isMultimodal: boolean;
      isReasoning: boolean;
      supportsTools: boolean;
      maxOutputTokens?: number;
      reasoningEffort?: string;
    }>;
    return Object.fromEntries(profiles.map(p => [p.model, p]));
  };

  it('imports prefixed VL embedding as multimodal embedding without tool flags', async () => {
    const byModel = await importModels(['embed-gateway_qwen3-vl-embedding']);
    const p = byModel['embed-gateway_qwen3-vl-embedding'];
    expect(p.isEmbedding).toBe(true);
    expect(p.isReranker).toBe(false);
    expect(p.isMultimodal).toBe(true);
    expect(p.isReasoning).toBe(false);
    expect(p.supportsTools).toBe(false);
  });

  it('imports prefixed VL rerank as vl reranker (bindable, no embedding flag)', async () => {
    const byModel = await importModels(['embed-gateway_qwen3-vl-rerank']);
    const p = byModel['embed-gateway_qwen3-vl-rerank'];
    expect(p.isEmbedding).toBe(false);
    expect(p.isReranker).toBe(true);
    expect(p.isMultimodal).toBe(true);
    expect(p.supportsTools).toBe(false);
  });

  it('imports tongyi-embedding-vision-plus dated snapshot as multimodal embedding', async () => {
    const byModel = await importModels(['embed-gateway_tongyi-embedding-vision-plus-2026-03-06']);
    const p = byModel['embed-gateway_tongyi-embedding-vision-plus-2026-03-06'];
    expect(p.isEmbedding).toBe(true);
    expect(p.isMultimodal).toBe(true);
    expect(p.supportsTools).toBe(false);
  });

  it('imports prefixed text rerank without chat-record inheritance (no tools/reasoning)', async () => {
    const byModel = await importModels(['embed-gateway_qwen3.7-text-rerank']);
    const p = byModel['embed-gateway_qwen3.7-text-rerank'];
    expect(p.isEmbedding).toBe(false);
    expect(p.isReranker).toBe(true);
    expect(p.isMultimodal).toBe(false);
    expect(p.isReasoning).toBe(false);
    expect(p.supportsTools).toBe(false);
  });

  it('imports prefixed qwen3.8-max as a chat model with registry max output and xhigh default', async () => {
    const byModel = await importModels(['embed-gateway_qwen3.8-max']);
    const p = byModel['embed-gateway_qwen3.8-max'];
    expect(p.isEmbedding).toBe(false);
    expect(p.isReranker).toBe(false);
    expect(p.isReasoning).toBe(true);
    expect(p.supportsTools).toBe(true);
    expect(p.maxOutputTokens).toBe(131072);
    expect(p.reasoningEffort).toBe('xhigh');
  });

  it('binds imported embedding/rerank models to the right knowledge slots', async () => {
    const byModel = await importModels([
      'embed-gateway_qwen3-vl-embedding',
      'embed-gateway_qwen3-vl-rerank',
      'embed-gateway_tongyi-embedding-vision-plus-2026-03-06',
      'embed-gateway_qwen3.7-text-rerank',
      'embed-gateway_qwen3.8-max',
    ]);
    const bindingOf = (model: string) =>
      getKnowledgeModelCapability({
        isEmbedding: byModel[model].isEmbedding,
        isReranker: byModel[model].isReranker,
        isMultimodal: byModel[model].isMultimodal,
      });
    expect(bindingOf('embed-gateway_qwen3-vl-embedding')).toBe('multimodal_embedding');
    expect(bindingOf('embed-gateway_qwen3-vl-rerank')).toBe('vl_reranker');
    expect(bindingOf('embed-gateway_tongyi-embedding-vision-plus-2026-03-06')).toBe('multimodal_embedding');
    expect(bindingOf('embed-gateway_qwen3.7-text-rerank')).toBe('text_reranker');
    expect(bindingOf('embed-gateway_qwen3.8-max')).toBeNull();
  });
});

describe('useSettingsVendorState model validation and deduplication (G22)', () => {
  const vendor: VendorConfig = {
    id: 'vendor-custom',
    name: 'Custom',
    providerType: 'custom',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-test',
  };

  it('rejects saving empty/whitespace-only model IDs in modal and inline editors', async () => {
    const deps = createDeps({ vendors: [vendor], modelProfiles: [] });
    const { result } = renderHook(() => useSettingsVendorState(deps));

    act(() => result.current.handleOpenModelEditor(vendor));
    const blankModalDraft = { ...result.current.modelEditor!.api, model: '   ' };
    await act(async () => {
      await result.current.handleSaveModelProfile(blankModalDraft);
    });
    expect(deps.upsertModelProfile).not.toHaveBeenCalled();
    expect(result.current.modelEditor).not.toBeNull();

    act(() => result.current.handleAddModelInline(vendor));
    const blankInlineDraft = { ...result.current.inlineEditState!.api, model: '' };
    await act(async () => {
      await result.current.handleSaveInlineEdit(blankInlineDraft);
    });
    expect(deps.upsertModelProfile).not.toHaveBeenCalled();
    expect(result.current.inlineEditState).not.toBeNull();
  });

  it('deduplicates (vendorId, model) on save by merging into existing profile ID and preserving favorite', async () => {
    const existingProfile = {
      id: 'existing-profile-1',
      vendorId: vendor.id,
      label: 'Existing GPT',
      model: 'gpt-4o',
      modelAdapter: 'general',
      isMultimodal: false,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
      enabled: true,
      status: 'enabled' as const,
      isFavorite: true,
    };
    const deps = createDeps({
      vendors: [vendor],
      modelProfiles: [existingProfile],
      upsertModelProfile: vi.fn().mockResolvedValue(existingProfile),
    });
    const { result } = renderHook(() => useSettingsVendorState(deps));

    act(() => result.current.handleOpenModelEditor(vendor));
    const duplicateDraft = {
      ...result.current.modelEditor!.api,
      id: 'new-temp-id',
      name: '  ',
      model: ' GPT-4O ',
      isFavorite: false,
    };
    await act(async () => {
      await result.current.handleSaveModelProfile(duplicateDraft);
    });

    expect(deps.upsertModelProfile).toHaveBeenCalledTimes(1);
    expect(deps.upsertModelProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-profile-1',
        vendorId: vendor.id,
        model: 'GPT-4O',
        label: 'GPT-4O',
        isFavorite: true,
      })
    );
  });

  it('skips blank model IDs during bulk handleAddVendorModels', async () => {
    const deps = createDeps({ vendors: [vendor], modelProfiles: [] });
    const { result } = renderHook(() => useSettingsVendorState(deps));

    await act(async () => {
      await result.current.handleAddVendorModels(vendor, [
        { modelId: '', label: 'Empty' },
        { modelId: '   ', label: 'Whitespace' },
        { modelId: 'gpt-5', label: '  ' },
      ]);
    });

    expect(deps.persistModelProfiles).toHaveBeenCalledTimes(1);
    const saved = deps.persistModelProfiles.mock.calls[0][0] as Array<{ model: string; label: string }>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ model: 'gpt-5', label: 'gpt-5' });
  });
});
