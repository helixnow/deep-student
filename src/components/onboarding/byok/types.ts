import type { ModelAssignments, ModelProfile, VendorConfig } from '@/types';

export type ByokProvisionerState =
  | 'idle'
  | 'detecting'
  | 'probing'
  | 'provisioning'
  | 'completed'
  | 'partial_chat_only'
  | 'error';

export type ByokPresetId =
  | 'siliconflow'
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'xai'
  | 'zhipu'
  | 'dashscope'
  | 'moonshot'
  | 'custom';

export type ByokTransportType = 'openai-compatible' | 'anthropic' | 'gemini';

export interface ByokProviderPreset {
  id: ByokPresetId;
  displayName: string;
  /** Key in settings:vendor_modal.providers.* when available */
  i18nProviderKey?: string;
  /** Model/brand identifier passed to ProviderIcon */
  iconModelId: string;
  /** Transport wire family used by endpointProber */
  providerType: ByokTransportType;
  /** Canonical VendorConfig.providerType stored in settings */
  vendorProviderType: string;
  baseUrl: string;
  builtinVendorId?: string;
  supportsEmbeddingsByDefault: boolean;
}

export interface KeyDetectionInput {
  rawApiKey: string;
  customBaseUrl?: string;
  selectedPresetId?: ByokPresetId | null;
}

export interface KeyDetectionResult {
  sanitizedApiKey: string;
  preset: ByokProviderPreset | null;
  isAmbiguous: boolean;
  candidates: ByokProviderPreset[];
  effectiveBaseUrl: string;
  usedCustomBaseUrl: boolean;
}

export interface ProbedModelDescriptor {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface EmbeddingDimensionProbeResult {
  embeddingModelId: string;
  dimension: number;
}

export interface ByokEndpointProbeResult {
  resolvedPreset: ByokProviderPreset;
  resolvedBaseUrl: string;
  chatModels: ProbedModelDescriptor[];
  embeddingCandidates: ProbedModelDescriptor[];
  rerankCandidates: ProbedModelDescriptor[];
  embeddingResult: EmbeddingDimensionProbeResult | null;
  chatOnlyReason?: 'no_embedding_endpoint' | 'provider_chat_only';
  latencyMs: number;
}

export type ByokSlotRoleId =
  | 'primary_chat'
  | 'fast_utility'
  | 'summary_memory'
  | 'coding_agent'
  | 'vision_parse'
  | 'document_ocr'
  | 'text_embedding'
  | 'rag_reranker';

export interface ByokSlotAssignment {
  slotNumber: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  roleId: ByokSlotRoleId;
  primaryAssignmentKey: keyof ModelAssignments;
  secondaryAssignmentKeys: Array<keyof ModelAssignments>;
  configId: string | null;
  modelId: string | null;
  modelLabel: string | null;
  preservedExisting: boolean;
}

export interface SlotProvisionResult {
  vendor: VendorConfig;
  enabledModelProfiles: ModelProfile[];
  assignments: ModelAssignments;
  slots: ByokSlotAssignment[];
  assignedSlotCount: number;
  embeddingConfigId: string | null;
  embeddingModelId: string | null;
}

export interface VectorProfileProvisionResult {
  status: 'completed' | 'partial_chat_only';
  dimension: number | null;
  setAsDefault: boolean;
  keptExistingDefaultDimension: number | null;
}

export interface ByokAutoProvisionSummary {
  status: 'completed' | 'partial_chat_only';
  preset: ByokProviderPreset;
  baseUrl: string;
  probedModelCount: number;
  enabledModelCount: number;
  assignedSlotCount: number;
  slots: ByokSlotAssignment[];
  dimension: number | null;
  keptExistingDefaultDimension: number | null;
  latencyMs: number;
}

export type ByokErrorCode =
  | 'empty_key'
  | 'auth_failed'
  | 'no_models'
  | 'network_timeout'
  | 'probe_failed';

export interface ByokErrorInfo {
  code: ByokErrorCode;
  httpStatus?: number;
  message: string;
}
