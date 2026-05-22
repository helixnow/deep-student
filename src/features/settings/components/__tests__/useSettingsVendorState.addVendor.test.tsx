import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSettingsVendorState } from '../useSettingsVendorState';
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

    expect((result.current.modelEditor?.api as ApiConfig | undefined)?.apiProtocol).toBe('openai_responses');
    expect((result.current.modelEditor?.api as ApiConfig | undefined)?.supportsOpenAIResponses).toBe(true);
  });
});
