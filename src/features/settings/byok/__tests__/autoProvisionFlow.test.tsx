import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAssignments, ModelProfile, VendorConfig } from '@/types';
import type { ByokEndpointProbeResult } from '../types';

const ipcState = vi.hoisted(() => ({
  vendors: [] as VendorConfig[],
  profiles: [] as ModelProfile[],
  assignments: {
    model2_config_id: null,
    anki_card_model_config_id: null,
    qbank_ai_grading_model_config_id: null,
    qbank_ai_generation_model_config_id: null,
    embedding_model_config_id: null,
    reranker_model_config_id: null,
    chat_title_model_config_id: null,
    exam_sheet_ocr_model_config_id: null,
    translation_model_config_id: null,
    vl_embedding_model_config_id: null,
    vl_reranker_model_config_id: null,
    memory_decision_model_config_id: null,
    review_analysis_model_config_id: null,
    voice_input_asr_model_config_id: null,
    image_generation_model_config_id: null,
    compaction_model_config_id: null,
    translation_display_mode: null,
  } as ModelAssignments,
  savedSettings: new Map<string, string>(),
  dimensions: [] as Array<{
    dimension: number;
    modality: string;
    modelConfigId?: string;
    modelName?: string;
    recordCount: number;
    lanceTableName: string;
    createdAt: number;
    lastUsedAt: number;
  }>,
  defaultTextDimension: null as number | null,
  invokeCalls: [] as Array<{ cmd: string; args?: Record<string, unknown> }>,
  failCommand: '',
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    ipcState.invokeCalls.push({ cmd, args });
    if (cmd === ipcState.failCommand) throw new Error('fixture-credential-in-ipc-error');

    switch (cmd) {
      case 'get_vendor_configs':
        return ipcState.vendors;
      case 'save_vendor_configs':
        ipcState.vendors = (args?.configs as VendorConfig[]) ?? [];
        return;
      case 'get_model_profiles':
        return ipcState.profiles;
      case 'save_model_profiles':
        ipcState.profiles = (args?.profiles as ModelProfile[]) ?? [];
        return;
      case 'get_model_assignments':
        return ipcState.assignments;
      case 'save_model_assignments':
        ipcState.assignments = args?.assignments as ModelAssignments;
        return;
      case 'save_setting':
        ipcState.savedSettings.set(String(args?.key), String(args?.value));
        return;
      case 'get_setting':
        return ipcState.savedSettings.get(String(args?.key)) ?? null;
      case 'vfs_list_dimensions':
        return ipcState.dimensions;
      case 'vfs_create_dimension': {
        const created = {
          dimension: Number(args?.dimension),
          modality: String(args?.modality),
          lanceTableName: `vfs_text_${String(args?.dimension)}`,
          recordCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          modelConfigId: (args?.modelConfigId as string | undefined) ?? undefined,
          modelName: (args?.modelName as string | undefined) ?? undefined,
        };
        ipcState.dimensions.push(created);
        return created;
      }
      case 'vfs_assign_dimension_model':
        return true;
      case 'vfs_get_default_embedding_dimension': {
        if (args?.modality === 'text' && ipcState.defaultTextDimension !== null) {
          return (
            ipcState.dimensions.find(
              (d) => d.modality === 'text' && d.dimension === ipcState.defaultTextDimension,
            ) ?? null
          );
        }
        return null;
      }
      case 'vfs_set_default_embedding_dimension':
        if (args?.modality === 'text') {
          ipcState.defaultTextDimension = Number(args?.dimension);
        }
        return true;
      case 'add_ocr_engine':
        return true;
      default:
        return null;
    }
  }),
}));

vi.mock('@/utils/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/shared')>();
  return {
    ...actual,
    isTauriRuntime: true,
  };
});

import { QuickByokProvisionerCard } from '../QuickByokProvisionerCard';
import { BYOK_PRESETS } from '../keyDetector';
import { provisionByokSlots } from '../slotProvisioner';
import { provisionByokVectorProfile } from '../vectorProfileProvisioner';
import { useByokAutoProvisioner } from '../useByokAutoProvisioner';
import { WelcomeOnboardingDialog } from '@/components/onboarding/WelcomeOnboardingDialog';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fixtureProbe(): ByokEndpointProbeResult {
  return {
    resolvedPreset: BYOK_PRESETS.siliconflow,
    resolvedBaseUrl: BYOK_PRESETS.siliconflow.baseUrl,
    chatModels: [{ id: 'deepseek-chat', label: 'DeepSeek' }],
    embeddingCandidates: [{ id: 'BAAI/bge-m3', label: 'BGE' }],
    rerankCandidates: [],
    embeddingResult: { embeddingModelId: 'BAAI/bge-m3', dimension: 1024 },
    latencyMs: 10,
  };
}

describe('autoProvisionFlow (QuickByokProvisionerCard + 8-Slot + Vector Index)', () => {
  beforeEach(() => {
    ipcState.vendors = [
      {
        id: 'builtin-siliconflow',
        name: 'SiliconFlow',
        providerType: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: '',
        apiKeys: [],
        headers: {},
        isBuiltin: true,
      },
      {
        id: 'builtin-anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        apiKeys: [],
        headers: {},
        isBuiltin: true,
      },
    ];
    ipcState.profiles = [];
    ipcState.assignments = {
      model2_config_id: null,
      anki_card_model_config_id: null,
      qbank_ai_grading_model_config_id: null,
      qbank_ai_generation_model_config_id: null,
      embedding_model_config_id: null,
      reranker_model_config_id: null,
      chat_title_model_config_id: null,
      exam_sheet_ocr_model_config_id: null,
      translation_model_config_id: null,
      vl_embedding_model_config_id: null,
      vl_reranker_model_config_id: null,
      memory_decision_model_config_id: null,
      review_analysis_model_config_id: null,
      voice_input_asr_model_config_id: null,
      image_generation_model_config_id: null,
      compaction_model_config_id: null,
      translation_display_mode: null,
    };
    ipcState.savedSettings.clear();
    ipcState.dimensions = [];
    ipcState.defaultTextDimension = null;
    ipcState.invokeCalls = [];
    ipcState.failCommand = '';
  });

  it('preserves configured vendors, tuned models and user-selected slots when adding another key', async () => {
    ipcState.vendors[0].apiKey = 'existing-fixture-key';
    ipcState.vendors[0].baseUrl = 'https://customized.example/v1';
    const beforeVendor = { ...ipcState.vendors[0] };
    const existingProfile = { id: 'tuned-chat', vendorId: beforeVendor.id, model: 'deepseek-chat', label: 'My tuned model', enabled: true, temperature: 0.13 } as ModelProfile;
    ipcState.profiles = [existingProfile];
    ipcState.assignments.model2_config_id = existingProfile.id;
    ipcState.assignments.embedding_model_config_id = 'old-1536-model';
    const result = await provisionByokSlots(fixtureProbe(), 'new-fixture-key');
    expect(ipcState.vendors.find((v) => v.id === beforeVendor.id)).toEqual(beforeVendor);
    expect(result.vendor.id).not.toBe(beforeVendor.id);
    expect(ipcState.profiles.find((p) => p.id === existingProfile.id)).toEqual(existingProfile);
    expect(ipcState.assignments.model2_config_id).toBe(existingProfile.id);
    expect(ipcState.assignments.embedding_model_config_id).toBe('old-1536-model');
    expect(result.slots[0]).toMatchObject({ configId: existingProfile.id, preservedExisting: true });
    expect(ipcState.invokeCalls.filter((call) => call.cmd === 'save_model_assignments')).toHaveLength(1);
  });

  it('reuses matching enabled model profiles without resetting tuned parameters', async () => {
    ipcState.vendors[0].apiKey = 'same-fixture-key';
    const tuned = { id: 'tuned', vendorId: ipcState.vendors[0].id, model: 'deepseek-chat', label: 'Tuned', enabled: true, temperature: 0.11, maxOutputTokens: 777 } as ModelProfile;
    ipcState.profiles = [tuned];
    await provisionByokSlots(fixtureProbe(), 'same-fixture-key');
    expect(ipcState.profiles.find((p) => p.id === 'tuned')).toEqual(tuned);
    expect(ipcState.profiles.filter((p) => p.model === tuned.model)).toHaveLength(1);
  });

  it('does not replace an existing secure-only builtin key', async () => {
    ipcState.savedSettings.set('builtin-siliconflow.api_key', 'old-secure-fixture-key');
    const result = await provisionByokSlots(fixtureProbe(), 'new-fixture-key');
    expect(result.vendor.id).not.toBe('builtin-siliconflow');
    expect(ipcState.savedSettings.get('builtin-siliconflow.api_key')).toBe('old-secure-fixture-key');
  });

  it('fails closed on configuration read errors without saving or logging credential-bearing errors', async () => {
    ipcState.failCommand = 'get_vendor_configs';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(provisionByokSlots(fixtureProbe(), 'fixture-key')).rejects.toThrow('BYOK configuration operation failed');
      expect(ipcState.invokeCalls.some((call) => call.cmd.startsWith('save_'))).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally { errorSpy.mockRestore(); }
  });

  it('preserves an occupied vector table model even when the new model has the same dimension', async () => {
    ipcState.dimensions = [{ dimension: 1024, modality: 'text', modelConfigId: 'existing-bge', modelName: 'old-model', recordCount: 12, lanceTableName: 'vfs_text_1024', createdAt: 0, lastUsedAt: 0 }];
    ipcState.defaultTextDimension = 1024;
    await provisionByokVectorProfile({ embeddingResult: fixtureProbe().embeddingResult, embeddingConfigId: 'new-embedding' });
    expect(ipcState.invokeCalls.some((call) => call.cmd === 'vfs_assign_dimension_model')).toBe(false);
    expect(ipcState.invokeCalls.some((call) => call.cmd === 'vfs_set_default_embedding_dimension')).toBe(false);
  });

  it('preserves an explicitly configured empty 1536-dimensional default when adding 1024 dimensions', async () => {
    ipcState.dimensions = [{ dimension: 1536, modality: 'text', modelConfigId: 'existing-model', recordCount: 0, lanceTableName: 'vfs_text_1536', createdAt: 0, lastUsedAt: 0 }];
    ipcState.defaultTextDimension = 1536;
    const result = await provisionByokVectorProfile({ embeddingResult: fixtureProbe().embeddingResult, embeddingConfigId: 'new-embedding' });
    expect(result.keptExistingDefaultDimension).toBe(1536);
    expect(ipcState.defaultTextDimension).toBe(1536);
  });

  it('cancels a slow probe as soon as the pasted key changes, before the next submission', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetcher = vi.fn(() => oldResponse);
    const { result } = renderHook(() => useByokAutoProvisioner({ fetcher }));
    act(() => result.current.setRawApiKey('sk-ant-oldfixture1234567890'));
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.submitProvision(); });
    act(() => result.current.handlePasteApiKey('sk-ant-newfixture1234567890'));
    await act(async () => {
      resolveOld(jsonResponse({ data: [{ id: 'claude-sonnet-4' }] }));
      await pending;
    });
    expect(result.current.state).toBe('detecting');
    expect(result.current.summary).toBeNull();
    expect(ipcState.invokeCalls.some((call) => call.cmd.startsWith('save_'))).toBe(false);
  });

  it('never displays API keys carried by transport error messages', async () => {
    const key = 'sk-proj-fixture1234567890abcdef';
    render(<QuickByokProvisionerCard fetcher={vi.fn(async () => { throw new Error(`Authorization: Bearer ${key}`); })} />);
    fireEvent.change(screen.getByTestId('byok-key-input'), { target: { value: key } });
    fireEvent.click(screen.getByTestId('byok-submit-button'));
    await waitFor(() => expect(screen.getByTestId('byok-error-alert')).toBeInTheDocument());
    expect(screen.getByTestId('byok-error-alert')).not.toHaveTextContent(key);
  });

  it('keeps the newer probe result when an older request completes last', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetcher = vi.fn()
      .mockImplementationOnce(() => oldResponse)
      .mockImplementation(async () => jsonResponse({ data: [{ id: 'claude-sonnet-4', display_name: 'New result' }] }));
    const { result } = renderHook(() => useByokAutoProvisioner({ fetcher }));
    act(() => result.current.setRawApiKey('sk-ant-oldfixture1234567890'));
    let oldPending!: Promise<unknown>;
    act(() => { oldPending = result.current.submitProvision(); });
    act(() => result.current.handlePasteApiKey('sk-ant-newfixture1234567890'));
    await act(async () => { await result.current.submitProvision(); });
    const newerSummary = result.current.summary;
    await act(async () => {
      resolveOld(jsonResponse({ data: [{ id: 'claude-3-haiku', display_name: 'Old result' }] }));
      await oldPending;
    });
    expect(result.current.summary).toBe(newerSummary);
    expect(result.current.state).toBe('partial_chat_only');
    expect(ipcState.savedSettings.get('builtin-anthropic.api_key')).toBe('sk-ant-newfixture1234567890');
  });

  it('does not mutate vector configuration when reading dimensions fails', async () => {
    ipcState.failCommand = 'vfs_list_dimensions';
    await expect(provisionByokVectorProfile({ embeddingResult: fixtureProbe().embeddingResult, embeddingConfigId: 'new-embedding' })).rejects.toThrow();
    expect(ipcState.invokeCalls.some((call) => call.cmd === 'vfs_create_dimension' || call.cmd === 'vfs_assign_dimension_model' || call.cmd === 'vfs_set_default_embedding_dimension')).toBe(false);
  });

  it('provisions all 8 core functional slots, binds 1024-dim vector index, and renders tabular-nums ready state', async () => {
    const mockFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.siliconflow.cn/v1/models') {
        return jsonResponse({
          data: [
            { id: 'deepseek-ai/DeepSeek-V3.2', context_length: 163840 },
            { id: 'Qwen/Qwen3-8B', context_length: 131072 },
            { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', context_length: 262144 },
            { id: 'Qwen/Qwen2.5-VL-72B-Instruct', context_length: 128000 },
            { id: 'PaddlePaddle/PaddleOCR-VL-1.5', context_length: 16384 },
            { id: 'Qwen/Qwen3-Embedding-8B' },
            { id: 'BAAI/bge-reranker-v2-m3' },
          ],
        });
      }
      if (url === 'https://api.siliconflow.cn/v1/embeddings' && init?.method === 'POST') {
        return jsonResponse({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.05) }],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const onCompleted = vi.fn();
    const { container } = render(
      <QuickByokProvisionerCard
        mode="onboarding"
        fetcher={mockFetcher}
        onCompleted={onCompleted}
      />,
    );

    const input = screen.getByTestId('byok-key-input');
    fireEvent.change(input, {
      target: { value: 'sk-siliconflow1234567890abcdefghijklmnop' },
    });
    fireEvent.click(screen.getByTestId('byok-pill-siliconflow'));
    fireEvent.click(screen.getByTestId('byok-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('byok-completed-summary')).toBeInTheDocument();
    });

    // Verify all 8 Core Functional Slots in ModelAssignments are populated
    expect(ipcState.assignments.model2_config_id).toBeTruthy();
    expect(ipcState.assignments.chat_title_model_config_id).toBeTruthy();
    expect(ipcState.assignments.memory_decision_model_config_id).toBeTruthy();
    expect(ipcState.assignments.compaction_model_config_id).toBeTruthy();
    expect(ipcState.assignments.qbank_ai_generation_model_config_id).toBeTruthy();
    expect(ipcState.assignments.qbank_ai_grading_model_config_id).toBeTruthy();
    expect(ipcState.assignments.exam_sheet_ocr_model_config_id).toBeTruthy();
    expect(ipcState.assignments.embedding_model_config_id).toBeTruthy();
    expect(ipcState.assignments.reranker_model_config_id).toBeTruthy();

    // Verify synchronized secondary aliases were populated too
    expect(ipcState.assignments.translation_model_config_id).toBe(
      ipcState.assignments.chat_title_model_config_id,
    );
    expect(ipcState.assignments.anki_card_model_config_id).toBe(
      ipcState.assignments.chat_title_model_config_id,
    );

    // Verify VFS vector index dimension creation + default binding
    const createDimCall = ipcState.invokeCalls.find((c) => c.cmd === 'vfs_create_dimension');
    expect(createDimCall?.args).toEqual({
      dimension: 1024,
      modality: 'text',
      modelConfigId: ipcState.assignments.embedding_model_config_id,
      modelName: 'Qwen/Qwen3-Embedding-8B',
    });

    const setDefaultCall = ipcState.invokeCalls.find(
      (c) => c.cmd === 'vfs_set_default_embedding_dimension',
    );
    expect(setDefaultCall?.args).toEqual({
      dimension: 1024,
      modality: 'text',
    });

    // Verify 1024 dimension badge uses font-mono tabular-nums and zero emojis exist
    const dimBadge = screen.getByTestId('byok-vector-dimension-badge');
    const numericSpan = dimBadge.querySelector('.font-mono.tabular-nums');
    expect(numericSpan?.textContent).toBe('1024');
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);

    fireEvent.click(screen.getByTestId('byok-enter-app-button'));
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('populates chat/summary/code/vision slots for chat-only providers, preserves existing embedding_model_config_id, and renders FTS banner', async () => {
    ipcState.assignments.embedding_model_config_id = 'existing_openai_emb_1536';

    const anthropicFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.anthropic.com/v1/models?limit=100') {
        return jsonResponse({
          data: [
            { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', type: 'model' },
            { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku', type: 'model' },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const { container } = render(
      <QuickByokProvisionerCard mode="settings" fetcher={anthropicFetcher} />,
    );

    const input = screen.getByTestId('byok-key-input');
    fireEvent.change(input, {
      target: { value: 'sk-ant-api03-chatonlykey1234567890abcdef' },
    });
    expect(screen.getByTestId('byok-detected-chip')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('byok-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('byok-chat-only-banner')).toBeInTheDocument();
    });

    // Chat, fast, summary, coding, vision, and OCR slots populated from Claude
    expect(ipcState.assignments.model2_config_id).toBeTruthy();
    expect(ipcState.assignments.chat_title_model_config_id).toBeTruthy();
    expect(ipcState.assignments.memory_decision_model_config_id).toBeTruthy();
    expect(ipcState.assignments.qbank_ai_generation_model_config_id).toBeTruthy();
    expect(ipcState.assignments.qbank_ai_grading_model_config_id).toBeTruthy();

    // Pre-existing embedding_model_config_id from another vendor MUST NOT be overwritten
    expect(ipcState.assignments.embedding_model_config_id).toBe('existing_openai_emb_1536');

    // vfs_create_dimension MUST NOT be called
    expect(ipcState.invokeCalls.some((c) => c.cmd === 'vfs_create_dimension')).toBe(false);
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('maintains 1:1 structural parity and zero emojis in zh-CN and en-US settings.json byok keys', () => {
    const rootDir = path.resolve(__dirname, '../../../../..');
    const zhSettings = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'src/locales/zh-CN/settings.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const enSettings = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'src/locales/en-US/settings.json'), 'utf-8'),
    ) as Record<string, unknown>;

    const collectLeaves = (obj: unknown, prefix = ''): Array<[string, string]> => {
      if (!obj || typeof obj !== 'object') return [];
      const entries: Array<[string, string]> = [];
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const nextPath = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') {
          entries.push([nextPath, v]);
        } else {
          entries.push(...collectLeaves(v, nextPath));
        }
      }
      return entries.sort(([a], [b]) => a.localeCompare(b));
    };

    const zhByok = collectLeaves(zhSettings.byok);
    const enByok = collectLeaves(enSettings.byok);

    expect(zhByok.length).toBeGreaterThanOrEqual(28);
    expect(zhByok.map(([k]) => k)).toEqual(enByok.map(([k]) => k));

    for (const [, text] of [...zhByok, ...enByok]) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('preserves an already-populated 1536-dim default vector index when adding a 1024-dim model', async () => {
    ipcState.dimensions = [
      {
        dimension: 1536,
        modality: 'text',
        modelConfigId: 'existing_openai_emb',
        modelName: 'text-embedding-3-small',
        recordCount: 420,
        lanceTableName: 'vfs_text_1536',
        createdAt: Date.now() - 100000,
        lastUsedAt: Date.now() - 5000,
      },
    ];
    ipcState.defaultTextDimension = 1536;

    const mockFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.siliconflow.cn/v1/models') {
        return jsonResponse({
          data: [
            { id: 'deepseek-ai/DeepSeek-V3.2', context_length: 163840 },
            { id: 'BAAI/bge-m3' },
          ],
        });
      }
      if (url === 'https://api.siliconflow.cn/v1/embeddings' && init?.method === 'POST') {
        return jsonResponse({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.02) }],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<QuickByokProvisionerCard mode="settings" fetcher={mockFetcher} />);

    fireEvent.change(screen.getByTestId('byok-key-input'), {
      target: { value: 'sk-siliconflow1234567890abcdefghijklmnop' },
    });
    fireEvent.click(screen.getByTestId('byok-pill-siliconflow'));
    fireEvent.click(screen.getByTestId('byok-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('byok-completed-summary')).toBeInTheDocument();
    });

    // Created 1024 dimension, but did NOT overwrite populated 1536 default
    expect(ipcState.invokeCalls.some((c) => c.cmd === 'vfs_create_dimension')).toBe(true);
    expect(
      ipcState.invokeCalls.some((c) => c.cmd === 'vfs_set_default_embedding_dimension'),
    ).toBe(false);
    expect(ipcState.defaultTextDimension).toBe(1536);
  });

  it('supports collapsed/expanded settings mode and surfaces HTTP 401 auth errors cleanly', async () => {
    const unauthorizedFetcher = vi.fn(async () =>
      jsonResponse({ error: 'Unauthorized' }, 401),
    ) as unknown as typeof fetch;

    render(
      <QuickByokProvisionerCard
        mode="settings"
        defaultCollapsed={true}
        fetcher={unauthorizedFetcher}
      />,
    );

    expect(screen.getByTestId('byok-provisioner-collapsed')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('byok-expand-button'));
    expect(screen.getByTestId('byok-provisioner-card')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('byok-key-input'), {
      target: { value: 'sk-proj-invalid1234567890abcdefghijklmnop' },
    });
    fireEvent.click(screen.getByTestId('byok-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('byok-error-alert')).toBeInTheDocument();
    });
    expect(screen.getByTestId('byok-error-alert').textContent).toContain('401');
  });

  it('renders QuickByokProvisionerCard inside WelcomeOnboardingDialog with zero emojis and preserves dialog a11y', () => {
    render(<WelcomeOnboardingDialog onConfigure={vi.fn()} onSkip={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'welcome-onboarding-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'welcome-onboarding-subtitle');
    expect(screen.getByTestId('byok-provisioner-card')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
