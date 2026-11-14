/**
 * `src/cmd/handout.rs:74-127` handout_llm_complete / handout_vlm_caption, plus the VLM model
 * choice they share with question import (`dstu-vision/src/vlm_grounding_service.rs:1364-1494`
 * `get_vlm_config_candidates` / `get_vlm_config`). The model calls are L02 `llmRawPrompt`.
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { Logger } from '../../../platform/log/api.ts';
import type { ApiConfig, LlmOcrModels, LlmRawPrompt, LLMManager } from '../../llm/api.ts';
import { isDiscontinuedOcrModel } from '../../llm/api.ts';
import { checkPrompt, runCancellable, type HandoutRegistry } from './handout.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

/** handout.rs:22 单张帧图 base64 上限（约 6 MB 原图）。 */
export const MAX_FRAME_BASE64_LEN = 8 * 1024 * 1024;

export interface HandoutLlmDeps {
  registry: HandoutRegistry;
  llm(): LLMManager;
  ocrModels(): LlmOcrModels;
  rawPrompt(): LlmRawPrompt;
  log: Pick<Logger, 'info' | 'debug'>;
}

/** L02 services reject with plain AppError values; `?` propagates them unchanged. */
function rethrow(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
    const value = error as { error_type: string; message: string; details?: unknown };
    throw new CommandError({ ...value, details: value.details ?? null } as AppError);
  }
  throw error;
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) { rethrow(error); }
}

/** vlm_grounding_service.rs:1364-1482 `get_vlm_config_candidates`. */
export async function getVlmConfigCandidates(deps: Pick<HandoutLlmDeps, 'llm' | 'ocrModels' | 'log'>): Promise<ApiConfig[]> {
  // get_api_configs().await.unwrap_or_default()
  let configs: ApiConfig[];
  try { configs = await deps.llm().getApiConfigs(); } catch { configs = []; }

  // 黑名单：GLM-4.1V / GLM-4.0V / GLM-4V- 质量差，即使在 OCR 引擎中也跳过
  const isBlacklisted = (model: string): boolean => {
    const lower = model.toLowerCase();
    return lower.includes('glm-4.1v') || lower.includes('glm-4.0v') || lower.includes('glm-4v-');
  };
  const result: ApiConfig[] = [];
  const seen = new Set<string>();
  const push = (config: ApiConfig, tier: string): void => {
    if (isBlacklisted(config.model)) {
      deps.log.info(`[VLM-Grounding] 跳过黑名单模型: ${config.model} (${config.name})`);
      return;
    }
    if (isDiscontinuedOcrModel(config)) {
      deps.log.info(`[VLM-Grounding] 跳过已停服模型: ${config.model} (${config.name})`);
      return;
    }
    if (!config.enabled || !config.isMultimodal) return;
    if (!seen.has(config.id)) {
      seen.add(config.id);
      deps.log.info(`[VLM-Grounding] 候选 (${tier}): ${config.model} (${config.name})`);
      result.push(config);
    }
  };

  // Tier 0: OCR 引擎中的 GLM 视觉模型（按 priority 稳定排序）
  const ocrModels = await deps.ocrModels().getAvailableOcrModels();
  const byPriority = <T extends { priority: number }>(items: T[]): T[] =>
    items.map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)
      .map(entry => entry.item);
  const ocrGlm = byPriority(ocrModels.filter(m => m.enabled && m.engine_type === 'glm4v_ocr'));
  for (const ocrCfg of ocrGlm) {
    const config = configs.find(c => c.id === ocrCfg.config_id);
    if (config !== undefined) push(config, 'Tier0-GLM');
  }
  const ocrVlm = byPriority(ocrModels.filter(m => m.enabled
    && (m.engine_type === 'generic_vlm' || m.engine_type === 'paddle_ocr_vl' || m.engine_type === 'paddle_ocr_vl_v1')));

  // Tier 1-5: 普通模型列表按名称匹配
  const glmTopTier = /glm-(?:4\.[6-9]|4\.\d{2,}|5(?:\.\d+)?)v/i;
  const glm45 = /glm-4\.5v/i;
  const isThinking = (m: string): boolean => m.includes('thinking');
  const priorities: Array<(m: string) => boolean> = [
    m => glmTopTier.test(m) && !isThinking(m),
    m => glm45.test(m) && !isThinking(m),
    m => m.includes('qwen3-vl'),
    m => m.includes('qwen2.5-vl'),
    m => m.includes('qwen-vl'),
  ];
  for (const matcher of priorities) {
    for (const config of configs.filter(c => matcher(c.model.toLowerCase()))) push(config, 'name-match');
  }

  // Tier 6: OCR 引擎中的通用 VLM 模型
  for (const ocrCfg of ocrVlm) {
    const config = configs.find(c => c.id === ocrCfg.config_id);
    if (config !== undefined) push(config, 'Tier6-OCR-VLM');
  }
  // Tier 7: 任意多模态模型
  for (const config of configs) push(config, 'Tier7-any-multimodal');

  deps.log.debug(`[VLM-Grounding] VLM 候选模型: ${result.map(c => `${c.model}(${c.name})`).join(' → ')}`);
  return result;
}

/** vlm_grounding_service.rs:1484-1494 `get_vlm_config`. */
export async function getVlmConfig(deps: Pick<HandoutLlmDeps, 'llm' | 'ocrModels' | 'log'>): Promise<ApiConfig> {
  const first = (await getVlmConfigCandidates(deps))[0];
  if (first === undefined) {
    throw new CommandError(AppError.configuration(
      '未找到可用的 VLM 模型（需要 GLM-4.6V / Qwen-VL 等多模态模型），请在设置中配置'));
  }
  return first;
}

/** handout.rs:74-94. */
export async function handoutLlmComplete(deps: HandoutLlmDeps, args: {
  prompt: string; jsonMode?: boolean | null; requestId?: string | null;
}): Promise<string> {
  checkPrompt(args.prompt);
  const token = deps.registry.tokenFor(args.requestId);
  return await runCancellable(token, () => guarded(() => deps.rawPrompt().callModel2RawPromptOpts(
    args.prompt, args.jsonMode ?? false, { other: 'media_handout' }, 'media_handout')));
}

/** handout.rs:96-127. */
export async function handoutVlmCaption(deps: HandoutLlmDeps, args: {
  prompt: string; imageBase64: string; mime?: string | null; requestId?: string | null;
}): Promise<string> {
  checkPrompt(args.prompt);
  // Rust String::len() counts UTF-8 bytes.
  if (args.imageBase64.length === 0 || utf8ByteLength(args.imageBase64) > MAX_FRAME_BASE64_LEN) {
    throw new CommandError(AppError.validation('invalid frame image'));
  }
  const token = deps.registry.tokenFor(args.requestId);
  const config = await getVlmConfig(deps);
  const payload = { mime: args.mime ?? 'image/jpeg', base64: args.imageBase64 };
  return await runCancellable(token, () => guarded(() => deps.rawPrompt().callRawPromptWithConfigIdAndImages(
    config.id, args.prompt, [payload], { other: 'media_handout_vlm' })));
}
