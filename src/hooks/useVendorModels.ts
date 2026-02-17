import { useCallback, useEffect, useMemo, useState } from 'react';
import { TauriAPI } from '../utils/tauriApi';
import type { VendorConfig, ModelProfile, ApiConfig, ModelAssignments } from '../types';
import { getErrorMessage } from '../utils/errorUtils';

const DEFAULT_ASSIGNMENTS: ModelAssignments = {
  model2_config_id: null,
  anki_card_model_config_id: null,
  qbank_ai_grading_model_config_id: null,
  embedding_model_config_id: null,
  reranker_model_config_id: null,
  chat_title_model_config_id: null,
  exam_sheet_ocr_model_config_id: null,
  translation_model_config_id: null,
  // 多模态知识库模型
  vl_embedding_model_config_id: null,
  vl_reranker_model_config_id: null,
  // 两阶段题目集识别：专用题目解析模型
  question_parsing_model_config_id: null,
};

const normalizeAssignments = (input?: Partial<ModelAssignments>): ModelAssignments => ({
  ...DEFAULT_ASSIGNMENTS,
  ...(input ?? {}),
});

const broadcastModelAssignmentsChange = () => {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('model_assignments_changed'));
    }
  } catch (err: unknown) {
    console.warn('broadcast model assignments change failed', err);
  }
};

const getUuid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `vendor-${Math.random().toString(36).slice(2)}`;
};

const hasValidApiKey = (apiKey: string | undefined | null): boolean => {
  if (!apiKey) return false;
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '***') return false;
  const isAllAsterisks = trimmed.split('').every(c => c === '*');
  if (isAllAsterisks) return false;
  return true;
};

const buildResolvedConfigs = (vendors: VendorConfig[], profiles: ModelProfile[]): ApiConfig[] => {
  const vendorMap = new Map<string, VendorConfig>();
  vendors.forEach(v => {
    vendorMap.set(v.id, v);
  });

  return profiles
    .map(profile => {
      const vendor = vendorMap.get(profile.vendorId);
      if (!vendor) {
        return null;
      }
      const hasApiKey = hasValidApiKey(vendor.apiKey);
      const profileEnabled = Boolean(profile.enabled) && profile.status !== 'disabled' && hasApiKey;
      
      return {
        id: profile.id,
        name: profile.label,
        vendorId: vendor.id,
        vendorName: vendor.name,
        providerType: vendor.providerType,
        apiKey: vendor.apiKey ?? '',
        baseUrl: vendor.baseUrl,
        model: profile.model,
        // 确保布尔值正确转换（后端可能返回 0/1 或其他类型）
        isMultimodal: Boolean(profile.isMultimodal),
        isReasoning: Boolean(profile.isReasoning),
        isEmbedding: Boolean(profile.isEmbedding),
        isReranker: Boolean(profile.isReranker),
        enabled: profileEnabled,
        modelAdapter: profile.modelAdapter,
        maxOutputTokens: profile.maxOutputTokens ?? 0,
        temperature: profile.temperature ?? 0.7,
        supportsTools: profile.supportsTools ?? false,
        geminiApiVersion: profile.geminiApiVersion ?? 'v1',
        isBuiltin: profile.isBuiltin ?? false,
        isReadOnly: vendor.isReadOnly ?? false,
        reasoningEffort: profile.reasoningEffort,
        thinkingEnabled: profile.thinkingEnabled,
        thinkingBudget: profile.thinkingBudget,
        includeThoughts: profile.includeThoughts,
        enableThinking: profile.enableThinking,
        minP: profile.minP,
        topK: profile.topK,
        supportsReasoning: profile.supportsReasoning ?? profile.isReasoning,
        headers: vendor.headers,
      } as ApiConfig;
    })
    .filter((cfg): cfg is ApiConfig => Boolean(cfg));
};

const dispatchVendorModelChange = (vendors: VendorConfig[], profiles: ModelProfile[]) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }
  try {
    window.dispatchEvent(
      new CustomEvent('api_configurations_changed', {
        detail: { vendors, modelProfiles: profiles },
      })
    );
  } catch (error: unknown) {
    console.warn('broadcast vendor/model change failed:', error);
  }
};

export const useVendorModels = () => {
  const [vendors, setVendors] = useState<VendorConfig[]>([]);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>([]);
  const [modelAssignments, setModelAssignments] = useState<ModelAssignments>(DEFAULT_ASSIGNMENTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [vendorData, profileData, assignmentData] = await Promise.all([
        TauriAPI.getVendorConfigs(),
        TauriAPI.getModelProfiles(),
        TauriAPI.getModelAssignments(),
      ]);
      setVendors(vendorData ?? []);
      setModelProfiles(profileData ?? []);
      setModelAssignments(normalizeAssignments(assignmentData ?? undefined));
      setError(null);
    } catch (err: unknown) {
      console.error('[useVendorModels] Failed to load vendor/model configs:', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const clearAssignmentsForProfiles = useCallback(
    async (profileIds: string[]) => {
      if (!profileIds.length) {
        return;
      }
      const next = { ...modelAssignments };
      let changed = false;
      (Object.keys(next) as Array<keyof ModelAssignments>).forEach(key => {
        const current = next[key];
        if (current && profileIds.includes(current)) {
          next[key] = null;
          changed = true;
        }
      });
      if (changed) {
        await TauriAPI.saveModelAssignments(next);
        setModelAssignments(next);
        broadcastModelAssignmentsChange();
      }
    },
    [modelAssignments]
  );

  const persistVendors = useCallback(
    async (next: VendorConfig[]) => {
      setSaving(true);
      try {
        await TauriAPI.saveVendorConfigs(next);
        setVendors(next);
        dispatchVendorModelChange(next, modelProfiles);
        setError(null);
      } catch (err: unknown) {
        console.error('[useVendorModels] Failed to save vendor configs:', err);
        setError(getErrorMessage(err));
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [modelProfiles]
  );

  const persistModelProfiles = useCallback(
    async (next: ModelProfile[]) => {
      setSaving(true);
      try {
        await TauriAPI.saveModelProfiles(next);
        setModelProfiles(next);
        dispatchVendorModelChange(vendors, next);
        setError(null);
      } catch (err: unknown) {
        console.error('[useVendorModels] Failed to save model profiles:', err);
        setError(getErrorMessage(err));
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [vendors]
  );

  const upsertVendor = useCallback(
    async (vendor: VendorConfig) => {
      const sanitized = { ...vendor, id: vendor.id || getUuid() };
      const next = vendors.filter(v => v.id !== sanitized.id);
      next.push(sanitized);
      await persistVendors(next);
      return sanitized;
    },
    [vendors, persistVendors]
  );

  const deleteVendor = useCallback(
    async (vendorId: string) => {
      const nextVendors = vendors.filter(v => v.id !== vendorId);
      const removedProfileIds = modelProfiles
        .filter(mp => mp.vendorId === vendorId)
        .map(mp => mp.id);
      const nextProfiles = modelProfiles.filter(mp => mp.vendorId !== vendorId);
      await persistVendors(nextVendors);
      await persistModelProfiles(nextProfiles);
      await clearAssignmentsForProfiles(removedProfileIds);
    },
    [vendors, modelProfiles, persistVendors, persistModelProfiles, clearAssignmentsForProfiles]
  );

  const upsertModelProfile = useCallback(
    async (profile: ModelProfile) => {
      const sanitized = { ...profile, id: profile.id || getUuid(), vendorId: profile.vendorId };
      const next = modelProfiles.filter(mp => mp.id !== sanitized.id);
      next.push(sanitized);
      await persistModelProfiles(next);
      return sanitized;
    },
    [modelProfiles, persistModelProfiles]
  );

  const deleteModelProfile = useCallback(
    async (profileId: string) => {
      const next = modelProfiles.filter(mp => mp.id !== profileId);
      await persistModelProfiles(next);
      await clearAssignmentsForProfiles([profileId]);
    },
    [modelProfiles, persistModelProfiles, clearAssignmentsForProfiles]
  );

  const saveModelAssignments = useCallback(
    async (assignments: ModelAssignments) => {
      await TauriAPI.saveModelAssignments(assignments);
      setModelAssignments(assignments);
      broadcastModelAssignmentsChange();
    },
    []
  );

  const resolvedApiConfigs = useMemo(
    () => buildResolvedConfigs(vendors, modelProfiles),
    [vendors, modelProfiles]
  );

  return {
    vendors,
    modelProfiles,
    modelAssignments,
    resolvedApiConfigs,
    loading,
    saving,
    error,
    loadAll,
    upsertVendor,
    deleteVendor,
    upsertModelProfile,
    deleteModelProfile,
    saveModelAssignments,
    persistVendors,
    persistModelProfiles,
  };
};
