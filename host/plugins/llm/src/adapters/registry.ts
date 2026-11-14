/** Adapter registry and config routing (adapters/mod.rs + request_adapter_for_config). */
import type { ApiConfig } from '../../api.ts';
import { requestAdapterIdForConfig } from '../protocol.ts';
import type { RequestAdapter } from './base.ts';
import { GenericOpenAIAdapter } from './generic_openai.ts';
import { MiniMaxAdapter } from './minimax.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { DeepSeekAdapter } from './deepseek.ts';
import { QwenAdapter } from './qwen.ts';
import { ZhipuAdapter } from './zhipu.ts';
import { DoubaoAdapter } from './doubao.ts';
import { ErnieAdapter } from './ernie.ts';
import { GrokAdapter } from './grok.ts';
import { MistralAdapter } from './mistral.ts';
import { MoonshotAdapter } from './moonshot.ts';
import { GeminiAdapter } from './gemini.ts';
import { MimoAdapter } from './mimo.ts';

export const ADAPTER_IDS = [
  'general', 'google', 'anthropic', 'mistral', 'deepseek', 'qwen', 'zhipu',
  'doubao', 'ernie', 'moonshot', 'grok', 'minimax', 'mimo',
] as const;

export const AGGREGATOR_PLATFORMS = new Set([
  'siliconflow', 'openrouter', 'together', 'fireworks', 'groq', 'custom', 'general',
  'one-api', 'one_api', 'sub2api', 'cpa',
]);

const generic = new GenericOpenAIAdapter();
const minimax = new MiniMaxAdapter();
const anthropic = new AnthropicAdapter();
const deepseek = new DeepSeekAdapter();
const qwen = new QwenAdapter();
const zhipu = new ZhipuAdapter();
const doubao = new DoubaoAdapter();
const ernie = new ErnieAdapter();
const grok = new GrokAdapter();
const mistral = new MistralAdapter();
const moonshot = new MoonshotAdapter();
const gemini = new GeminiAdapter();
const mimo = new MimoAdapter();

const INSTANCES: Record<string, RequestAdapter> = {
  openai: generic,
  general: generic,
  siliconflow: generic,
  nvidia: generic,
  mimo,
  minimax,
  anthropic,
  deepseek,
  qwen,
  zhipu,
  doubao,
  ernie,
  grok,
  mistral,
  moonshot,
  google: gemini,
  gemini,
  xai: grok,
  baidu: ernie,
  claude: anthropic,
  kimi: moonshot,
};

export function getAdapter(
  providerType: string | null | undefined,
  providerScope: string | null | undefined,
  modelAdapter: string,
): RequestAdapter {
  const siliconflowHost =
    providerType?.toLowerCase() === 'siliconflow' || providerScope?.toLowerCase() === 'siliconflow';
  if (siliconflowHost) {
    const family = modelAdapter.toLowerCase();
    if (family === 'deepseek') return deepseek;
    if (family === 'qwen') return qwen;
    return generic;
  }
  const aggregatorHost =
    (providerType !== null && providerType !== undefined
      && AGGREGATOR_PLATFORMS.has(providerType.toLowerCase()))
    || (providerScope !== null && providerScope !== undefined
      && AGGREGATOR_PLATFORMS.has(providerScope.toLowerCase()));
  if (aggregatorHost) return generic;

  if (providerScope !== null && providerScope !== undefined) {
    const scope = providerScope.toLowerCase();
    if (!AGGREGATOR_PLATFORMS.has(scope)) {
      const adapter = INSTANCES[scope];
      if (adapter !== undefined) return adapter;
    }
  }
  if (providerType !== null && providerType !== undefined) {
    const provider = providerType.toLowerCase();
    if (!AGGREGATOR_PLATFORMS.has(provider)) {
      const adapter = INSTANCES[provider];
      if (adapter !== undefined) return adapter;
    }
  }
  return INSTANCES[modelAdapter.toLowerCase()] ?? generic;
}

/** `request_adapter_for_config`（mod.rs:4054）。 */
export function requestAdapterForConfig(config: ApiConfig): RequestAdapter {
  return getAdapter(null, null, requestAdapterIdForConfig(config));
}

/** Registered adapter ids without aliases (list_adapters). */
export function listAdapters(): string[] {
  return Object.keys(INSTANCES);
}

/** Rust list_adapter_infos: primary IDs only, in the UI's explicit order. */
export function listAdapterInfos(): { value: string; label: string; description: string }[] {
  return ADAPTER_IDS.map(id => {
    const adapter = INSTANCES[id]!;
    return { value: adapter.id, label: adapter.label, description: adapter.description };
  });
}
