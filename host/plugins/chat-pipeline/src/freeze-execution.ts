/** pipeline/context_compiler.rs:63–258. Runs before any stream event or message write. */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type CanonicalContentPart } from '../../chat/api.ts';
import type { ApiConfig, LLMManager, LlmOcrModels } from '../../llm/api.ts';
import { isDedicatedOcrEngine } from '../../llm-providers/api.ts';
import { availableCapability, unavailableCapability, planGeneration } from '../../vfs-index/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import { DEFAULT_IMAGE_BUDGET, DEFAULT_HISTORY_IMAGE_BUDGET } from './images.ts';
import { applySendOverrides, auxiliaryMmEligible, canonicalContentForFreeze, generationModelKind,
  requestedActiveModelId, requestedGenerationModel, resolveStrictRequestedModel, selectGenerationConfig } from './model-selection.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

type Log = Pick<Context['logger'], 'warn'>;
const displayError = (error: unknown): string => error instanceof Error ? error.message
  : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);

/** Canonical content is built by the request compiler from owner APIs, never reconstructed by L02.
 * Returns the full frozen config (including provider/auth fields), not just its selection subset.
 */
export async function freezeExecutionContext(ctx: PipelineContext, manager: LLMManager,
  ocr: LlmOcrModels, buildCanonical: () => CanonicalContentPart[], log: Log): Promise<ApiConfig> {
  const requestedId = requestedActiveModelId(ctx.options);
  // Rust unwrap_or_default: OCR discovery failure does not make ordinary text chat fail.
  const candidates = await ocr.getFreeTextOcrCandidatesByPriority().catch(() => []);
  const ocrAvailable = candidates.some(candidate => candidate.kind === 'systemOcr'
    || isDedicatedOcrEngine(candidate.engineType));
  const ocrConfigs = candidates.flatMap(candidate => candidate.kind === 'remote' ? [candidate] : []);
  const dedicatedIds = new Set(ocrConfigs.filter(candidate => isDedicatedOcrEngine(candidate.engineType))
    .map(candidate => candidate.config.id));
  let configs: ApiConfig[];
  try { configs = await manager.getApiConfigs(); }
  catch (error) { throw new ChatV2Error('Llm', displayError(error)); }
  const strict = resolveStrictRequestedModel(ctx.options.strictModelId ?? false, requestedId, configs, dedicatedIds);
  if (!strict.ok) throw new ChatV2Error('Llm', strict.error);
  const select = async (id: string | null): Promise<ApiConfig | null> => {
    // Rust .await.ok().map(...).filter(...): ordinary selection errors admit capability fallback.
    const selected = await manager.selectModelFor('default', id, {
      temperature: ctx.options.temperature, topP: ctx.options.topP,
      frequencyPenalty: ctx.options.frequencyPenalty, presencePenalty: ctx.options.presencePenalty,
      maxOutputTokens: ctx.options.maxTokens,
    }).then(([config]) => config, () => null);
    return selected !== null && generationModelKind(selected, dedicatedIds) !== null ? selected : null;
  };
  let initiallySelected = strict.config === null ? await select(requestedId)
    : configs.find(config => config.id === strict.config?.id)!;
  if (strict.config === null && initiallySelected === null && requestedId !== null) {
    initiallySelected = await select(null);
    log.warn(`[ChatV2::pipeline] requested model ${JSON.stringify(requestedId)} is unavailable (deleted or disabled); falling back to ${JSON.stringify(initiallySelected?.id ?? null)}`);
  }
  const canonical = canonicalContentForFreeze(ctx.canonicalContent, buildCanonical);
  const capability = (available: boolean) => available ? availableCapability() : unavailableCapability();
  const capabilities = {
    textEmbedding: unavailableCapability(), multimodalEmbedding: unavailableCapability(),
    textModel: capability(configs.some(config => generationModelKind(config, dedicatedIds) === 'text')),
    multimodalModel: capability(configs.some(config => generationModelKind(config, dedicatedIds) === 'multimodal')),
    ocr: capability(ocrAvailable),
  };
  const planner = planGeneration(capabilities, requestedGenerationModel(requestedId, initiallySelected, configs),
    canonical.some(part => part.type === 'image_ref') ? 'mixed' : 'text');
  if (planner.activeModel === null) throw new ChatV2Error('Llm', '没有可用的文本或多模态生成模型');
  const selection = selectGenerationConfig(configs, initiallySelected, planner.activeModel, dedicatedIds);
  if (selection === null) throw new ChatV2Error('Llm', '能力规划未解析到可执行模型');
  if (strict.config !== null && selection.id !== strict.config.id) {
    throw new ChatV2Error('Llm', `Explicit persona model '${strict.config.id}' cannot serve this request; refusing capability fallback to '${selection.id}'`);
  }
  // selectGenerationConfig intentionally exposes a subset; preserve the full selected config here.
  const active = structuredClone(initiallySelected?.id === selection.id ? initiallySelected
    : configs.find(config => config.id === selection.id)!);
  applySendOverrides(active, ctx.options);
  const auxiliary: ApiConfig[] = [];
  const seen = new Set<string>();
  for (const candidate of ocrConfigs) {
    if (!isDedicatedOcrEngine(candidate.engineType)
      && auxiliaryMmEligible(candidate.config, active.id, dedicatedIds) && !seen.has(candidate.config.id)) {
      auxiliary.push(candidate.config); seen.add(candidate.config.id);
    }
  }
  auxiliary.push(...configs.filter(config => auxiliaryMmEligible(config, active.id, dedicatedIds) && !seen.has(config.id))
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || Number(b.isBuiltin) - Number(a.isBuiltin)
      || compareUtf8(a.id, b.id)));
  ctx.options.modelId = active.id;
  ctx.options.model2OverrideId = active.id;
  ctx.modelDisplayName = active.model;
  ctx.canonicalContent = canonical;
  ctx.executionSnapshot = {
    requestedModelId: requestedId, resolvedModelId: active.id, resolvedModelName: active.model,
    resolvedModelIsMultimodal: active.isMultimodal, capabilitySnapshot: capabilities,
    generationPlan: { planner, auxiliaryMultimodalConfigId: auxiliary[0]?.id ?? null,
      imageBudget: DEFAULT_IMAGE_BUDGET, historyImageBudget: DEFAULT_HISTORY_IMAGE_BUDGET },
    executionRoute: null, frozenAt: Date.now(),
  };
  return active;
}
