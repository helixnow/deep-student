/** Model capability projection, writable slots and optimistic assignment updates. */
import type { ApiConfig, ModelAssignments, ModelAssignments__De } from '../api.ts';
import { EMPTY_MODEL_ASSIGNMENTS, modelAssignmentsFromDe } from './config_values.ts';
import { asciiLower, boundedString, errorMessage, fail, isJsonObject, toolError,
  type SettingsModelsDatabase, type VoiceInputCapabilities } from './settings_models_arguments.ts';

export const ASSIGNMENT_SLOTS = [
  'model2_config_id', 'review_analysis_model_config_id', 'anki_card_model_config_id',
  'qbank_ai_grading_model_config_id', 'qbank_ai_generation_model_config_id', 'reranker_model_config_id',
  'chat_title_model_config_id', 'exam_sheet_ocr_model_config_id', 'translation_model_config_id',
  'vl_reranker_model_config_id', 'memory_decision_model_config_id', 'voice_input_asr_model_config_id',
  'image_generation_model_config_id',
] as const;
export type AssignmentSlot = (typeof ASSIGNMENT_SLOTS)[number];
export function parseAssignmentSlot(value: string): AssignmentSlot {
  const slot = ASSIGNMENT_SLOTS.find(candidate => candidate === value);
  if (slot === undefined) fail(toolError('MODEL_ASSIGNMENT_SLOT_NOT_ALLOWED',
    `Model assignment slot '${value}' is not writable by the agent.`, 'Use a model slot declared by the model assignments tool schema.', false));
  return slot;
}
export function assignmentSlotCurrent(assignments: ModelAssignments, slot: AssignmentSlot): string | null { return assignments[slot]; }
export function assignmentSlotSet(assignments: ModelAssignments, slot: AssignmentSlot, value: string | null): ModelAssignments {
  return { ...assignments, [slot]: value };
}
export function assignmentSlotRequiredCapability(slot: AssignmentSlot): 'reranker' | 'multimodal' | 'audio_transcription' | 'image_generation' | 'text' {
  switch (slot) {
    case 'reranker_model_config_id': case 'vl_reranker_model_config_id': return 'reranker';
    case 'exam_sheet_ocr_model_config_id': return 'multimodal';
    case 'voice_input_asr_model_config_id': return 'audio_transcription';
    case 'image_generation_model_config_id': return 'image_generation';
    default: return 'text';
  }
}
export interface ModelCapabilities {
  enabled: boolean; multimodal: boolean; embedding: boolean; reranker: boolean;
  imageGeneration: boolean; audioTranscription: boolean; providerId: string | null; apiProtocol: string | null;
}
function providerId(config: ApiConfig): string | null {
  const raw = config.providerScope ?? config.providerType;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : asciiLower(trimmed);
}
export function modelCapabilitiesFromConfig(config: ApiConfig, voiceInput: VoiceInputCapabilities): ModelCapabilities {
  return { enabled: config.enabled, multimodal: config.isMultimodal, embedding: config.isEmbedding, reranker: config.isReranker,
    imageGeneration: config.isImageGeneration,
    audioTranscription: !config.isEmbedding && !config.isReranker && voiceInput.isAsrModel(config.model, config.name),
    providerId: providerId(config), apiProtocol: config.apiProtocol };
}
export function validateModelForSlot(slot: AssignmentSlot, capabilities: ModelCapabilities, voiceInput: VoiceInputCapabilities): void {
  if (!capabilities.enabled) fail(toolError('MODEL_DISABLED',
    'The selected model configuration is disabled or has no usable authentication.', 'Choose an enabled model from model_assignments_get.', false));
  let compatible: boolean;
  switch (slot) {
    case 'reranker_model_config_id': case 'vl_reranker_model_config_id': compatible = capabilities.reranker; break;
    case 'exam_sheet_ocr_model_config_id': compatible = capabilities.multimodal; break;
    case 'voice_input_asr_model_config_id': compatible = capabilities.audioTranscription
      && voiceInput.asrProviderSupported(capabilities.providerId, capabilities.apiProtocol); break;
    case 'image_generation_model_config_id': compatible = capabilities.imageGeneration; break;
    default: compatible = !capabilities.embedding && !capabilities.reranker; break;
  }
  if (!compatible) fail(toolError('MODEL_CAPABILITY_MISMATCH',
    `The selected model does not provide the '${assignmentSlotRequiredCapability(slot)}' capability required by '${slot}'.`,
    'Choose a compatible enabled model from model_assignments_get.', false));
}
export interface SafeModelJson {
  id: string; name: string; provider: string;
  model_type: 'audio_transcription' | 'image_generation' | 'reranker' | 'embedding' | 'multimodal_text' | 'text';
  enabled: boolean; truncated: boolean;
  capabilities: { multimodal: boolean; reasoning: boolean; embedding: boolean; reranker: boolean;
    image_generation: boolean; supports_tools: boolean; supports_reasoning: boolean; audio_transcription: boolean };
}
/** Project only display fields: credentials, headers, URL and raw model stay private. */
export function safeModelJson(config: ApiConfig, voiceInput: VoiceInputCapabilities): SafeModelJson {
  const caps = modelCapabilitiesFromConfig(config, voiceInput);
  const id = boundedString(config.id), name = boundedString(config.name);
  const provider = boundedString(config.vendorName ?? config.providerType ?? config.providerScope ?? 'unknown');
  const modelType = caps.audioTranscription ? 'audio_transcription' : caps.imageGeneration ? 'image_generation'
    : caps.reranker ? 'reranker' : caps.embedding ? 'embedding' : caps.multimodal ? 'multimodal_text' : 'text';
  return { id: id.value, name: name.value, provider: provider.value, model_type: modelType, enabled: config.enabled,
    truncated: id.truncated || name.truncated || provider.truncated,
    capabilities: { multimodal: config.isMultimodal, reasoning: config.isReasoning, embedding: config.isEmbedding,
      reranker: config.isReranker, image_generation: config.isImageGeneration, supports_tools: config.supportsTools,
      supports_reasoning: config.supportsReasoning, audio_transcription: caps.audioTranscription } };
}
export type AtomicAssignmentUpdate = { kind: 'updated'; previousConfigId: string | null; assignments: ModelAssignments; changed: boolean }
  | { kind: 'conflict'; currentConfigId: string | null };
const MODEL_ASSIGNMENTS_KEY = 'model_assignments';
function parseStoredModelAssignments(raw: string): ModelAssignments {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { fail(toolError('MODEL_ASSIGNMENTS_INVALID', `Stored model assignments are invalid: ${errorMessage(error)}`,
    'Open Settings and repair the model assignments before retrying.', false)); }
  if (!isJsonObject(parsed)) fail(toolError('MODEL_ASSIGNMENTS_INVALID', 'Stored model assignments are invalid: invalid type: expected a JSON object',
    'Open Settings and repair the model assignments before retrying.', false));
  for (const key of Object.keys(EMPTY_MODEL_ASSIGNMENTS)) {
    const value = parsed[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      fail(toolError('MODEL_ASSIGNMENTS_INVALID', `Stored model assignments are invalid: invalid type for field '${key}'`,
        'Open Settings and repair the model assignments before retrying.', false));
    }
  }
  return modelAssignmentsFromDe(parsed as ModelAssignments__De);
}
export function updateModelAssignmentAtomic(database: SettingsModelsDatabase, slot: AssignmentSlot,
  configId: string | null, expectedCurrentConfigId: string | null): AtomicAssignmentUpdate {
  // Keep the entire read/compare/write synchronous, with no await between operations.
  let stored: string | null;
  try { stored = database.get(MODEL_ASSIGNMENTS_KEY); }
  catch (error) { fail(toolError('MODEL_ASSIGNMENTS_READ_FAILED', `Failed to read current assignments: ${errorMessage(error)}`,
    'Retry after checking the model assignment settings.', true)); }
  const assignments = stored === null ? modelAssignmentsFromDe({}) : parseStoredModelAssignments(stored);
  const previousConfigId = assignmentSlotCurrent(assignments, slot);
  if (previousConfigId !== expectedCurrentConfigId) return { kind: 'conflict', currentConfigId: previousConfigId };
  const changed = previousConfigId !== configId;
  if (!changed) return { kind: 'updated', previousConfigId, assignments, changed };
  const updated = assignmentSlotSet(assignments, slot, configId);
  let serialized: string;
  try { serialized = JSON.stringify(updated); }
  catch (error) { fail(toolError('MODEL_ASSIGNMENTS_SERIALIZE_FAILED', `Failed to serialize model assignments: ${errorMessage(error)}`,
    'Retry after repairing the model assignment settings.', false)); }
  try { database.save(MODEL_ASSIGNMENTS_KEY, serialized); }
  catch (error) { fail(toolError('MODEL_ASSIGNMENTS_WRITE_FAILED', `Failed to save model assignments: ${errorMessage(error)}`,
    'Retry after checking local storage availability.', true)); }
  return { kind: 'updated', previousConfigId, assignments: updated, changed };
}
