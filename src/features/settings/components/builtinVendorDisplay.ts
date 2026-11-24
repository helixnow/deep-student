/**
 * Localized display helpers for built-in LLM vendors and their catalog notes.
 *
 * Keeps user-customized vendor names/notes verbatim while translating built-in
 * catalog defaults cleanly between zh-CN and en-US (covering both current
 * English canonical strings and legacy persisted Chinese strings).
 */
import type { VendorConfig } from '@/types';

export type VendorTranslateFn = (key: string, options?: { defaultValue?: string }) => string;

interface BuiltinVendorDisplaySpec {
  nameKey: string;
  englishName: string;
  knownDefaultNames: readonly string[];
  notesKey?: string;
  englishNotes?: string;
  knownDefaultNotes?: readonly string[];
}

const BUILTIN_VENDOR_DISPLAY: Record<string, BuiltinVendorDisplaySpec> = {
  'builtin-siliconflow': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.siliconflow',
    englishName: 'SiliconFlow',
    knownDefaultNames: ['SiliconFlow', '硅基流动'],
    notesKey: 'settings:vendor_panel.builtin_siliconflow_notes',
    englishNotes: 'Built-in template for SiliconFlow. Please enter your API Key.',
    knownDefaultNotes: [
      'Built-in template for SiliconFlow. Please enter your API Key.',
      'SiliconFlow（硅基流动）内置模板，填入您的 API 密钥即可开始使用。',
    ],
  },
  'builtin-deepseek': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.deepseek',
    englishName: 'DeepSeek',
    knownDefaultNames: ['DeepSeek'],
  },
  'builtin-qwen': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.qwen',
    englishName: 'Alibaba Qwen',
    knownDefaultNames: ['Alibaba Qwen', '通义千问', 'Qwen'],
    notesKey: 'settings:vendor_panel.builtin_notes.qwen',
    englishNotes:
      'Alibaba Cloud Model Studio (Bailian) API (OpenAI Chat compatible; also supports Responses and native DashScope). Recommended models: qwen3.7-max (flagship), qwen3.7-plus (default recommended / multimodal), qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b.',
    knownDefaultNotes: [
      'Alibaba Cloud Model Studio (Bailian) API (OpenAI Chat compatible; also supports Responses and native DashScope). Recommended models: qwen3.7-max (flagship), qwen3.7-plus (default recommended / multimodal), qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b.',
      '阿里云百炼 API（兼容 OpenAI Chat；平台亦支持 Responses / DashScope 原生）。推荐模型: qwen3.7-max(旗舰), qwen3.7-plus(官方默认推荐/多模态), qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b',
    ],
  },
  'builtin-zhipu': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.zhipu',
    englishName: 'Zhipu AI',
    knownDefaultNames: ['Zhipu AI', '智谱AI', '智谱', 'Zhipu'],
    notesKey: 'settings:vendor_panel.builtin_notes.zhipu',
    englishNotes:
      'Zhipu AI Open Platform. Available models: glm-5.2 (current flagship, 1M context, supports reasoning_effort), glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.7-flash (free).',
    knownDefaultNotes: [
      'Zhipu AI Open Platform. Available models: glm-5.2 (current flagship, 1M context, supports reasoning_effort), glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.7-flash (free).',
      '智谱AI 开放平台。可用模型: glm-5.2(当前旗舰, 1M 上下文, 支持 reasoning_effort), glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.7-flash(免费)',
    ],
  },
  'builtin-doubao': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.doubao',
    englishName: 'ByteDance Doubao',
    knownDefaultNames: ['ByteDance Doubao', '字节豆包', '豆包', 'Doubao'],
    notesKey: 'settings:vendor_panel.builtin_notes.doubao',
    englishNotes:
      'Volcengine Ark LLM Platform. Recommended models: doubao-seed-2-1-pro-260628 / doubao-seed-2-1-turbo-260628 (2.1 flagship, 256K context), doubao-seed-evolving (rolling ID), Seed 2.0 family, Seed 1.8 (doubao-seed-1-8-251228). Call directly by model name or ep-* endpoint.',
    knownDefaultNotes: [
      'Volcengine Ark LLM Platform. Recommended models: doubao-seed-2-1-pro-260628 / doubao-seed-2-1-turbo-260628 (2.1 flagship, 256K context), doubao-seed-evolving (rolling ID), Seed 2.0 family, Seed 1.8 (doubao-seed-1-8-251228). Call directly by model name or ep-* endpoint.',
      '火山方舟大模型平台。推荐模型: doubao-seed-2-1-pro-260628 / doubao-seed-2-1-turbo-260628 (2.1 旗舰, 256K 上下文), doubao-seed-evolving (滚动更新 ID), Seed 2.0 全系, Seed 1.8 (doubao-seed-1-8-251228)。可直接用模型名或 ep-* 接入点调用。',
    ],
  },
  'builtin-minimax': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.minimax',
    englishName: 'MiniMax',
    knownDefaultNames: ['MiniMax'],
    notesKey: 'settings:vendor_panel.builtin_notes.minimax',
    englishNotes:
      'MiniMax API. Available models: MiniMax-M3 (latest flagship, 1M context / multimodal), MiniMax-M2.7, MiniMax-M2.5, M2.5-highspeed, M2.1.',
    knownDefaultNotes: [
      'MiniMax API. Available models: MiniMax-M3 (latest flagship, 1M context / multimodal), MiniMax-M2.7, MiniMax-M2.5, M2.5-highspeed, M2.1.',
      'MiniMax API。可用模型: MiniMax-M3(最新旗舰, 1M 上下文/多模态), MiniMax-M2.7, MiniMax-M2.5, M2.5-highspeed, M2.1',
    ],
  },
  'builtin-moonshot': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.moonshot',
    englishName: 'Moonshot AI',
    knownDefaultNames: ['Moonshot AI', '月之暗面', 'Moonshot'],
    notesKey: 'settings:vendor_panel.builtin_notes.moonshot',
    englishNotes:
      'Kimi API. Available models: kimi-k3 (1M / multimodal / max reasoning), kimi-k2.6 (multimodal), kimi-k2.7-code (coding / thinking enabled), kimi-k2.5 (multimodal), moonshot-v1 series. kimi-k2 series and kimi-k2-thinking retired on 2026-05-25; kimi-latest retired on 2026-01-28. Note: K3 does not accept K2.x thinking objects; K2.5/K2.6 sampling parameters are locked.',
    knownDefaultNotes: [
      'Kimi API. Available models: kimi-k3 (1M / multimodal / max reasoning), kimi-k2.6 (multimodal), kimi-k2.7-code (coding / thinking enabled), kimi-k2.5 (multimodal), moonshot-v1 series. kimi-k2 series and kimi-k2-thinking retired on 2026-05-25; kimi-latest retired on 2026-01-28. Note: K3 does not accept K2.x thinking objects; K2.5/K2.6 sampling parameters are locked.',
      'Kimi API。可用模型: kimi-k3(1M/多模态/强制最高推理), kimi-k2.6(多模态), kimi-k2.7-code(编程/强制思考), kimi-k2.5(多模态), moonshot-v1 系列。kimi-k2 全系与 kimi-k2-thinking 已于 2026-05-25 停服、kimi-latest 已于 2026-01-28 停服。注意: K3 不接受 K2.x thinking 对象；K2.5/K2.6 采样参数锁定。',
    ],
  },
  'builtin-openai': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.openai',
    englishName: 'OpenAI',
    knownDefaultNames: ['OpenAI'],
    notesKey: 'settings:vendor_panel.builtin_notes.openai',
    englishNotes:
      'Official OpenAI API. Current mainlines include gpt-5.6, gpt-5.5/pro, gpt-5.4/pro/mini/nano; full catalog also lists gpt-5.2/pro, gpt-5.1, gpt-5/pro/mini/nano, and o3-pro/o3/o4-mini. The o-series is being retired: o1/o3-mini/o4-mini on 2026-10-23, and o3/o3-pro on 2026-12-11. Responses is recommended as the default protocol.',
    knownDefaultNotes: [
      'Official OpenAI API. Current mainlines include gpt-5.6, gpt-5.5/pro, gpt-5.4/pro/mini/nano; full catalog also lists gpt-5.2/pro, gpt-5.1, gpt-5/pro/mini/nano, and o3-pro/o3/o4-mini. The o-series is being retired: o1/o3-mini/o4-mini on 2026-10-23, and o3/o3-pro on 2026-12-11. Responses is recommended as the default protocol.',
      'OpenAI 官方 API。当前主线包括 gpt-5.6、gpt-5.5/pro、gpt-5.4/pro/mini/nano；全部模型页仍列出 gpt-5.2/pro、gpt-5.1、gpt-5/pro/mini/nano，以及 o3-pro/o3/o4-mini。o 系列已进入退役期: o1/o3-mini/o4-mini 于 2026-10-23 关停，o3/o3-pro 于 2026-12-11 关停。默认协议建议使用 Responses。',
    ],
  },
  'builtin-openai-codex': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.openai_codex',
    englishName: 'Codex',
    knownDefaultNames: ['Codex', 'OpenAI Codex'],
    notesKey: 'settings:vendor_panel.builtin_codex_notes',
    englishNotes:
      'OpenAI Codex subscription access via ChatGPT OAuth. Sign in with ChatGPT instead of entering an API key.',
    knownDefaultNotes: [
      'OpenAI Codex subscription access via ChatGPT OAuth. Sign in with ChatGPT instead of entering an API key.',
      '通过 ChatGPT OAuth 使用 OpenAI Codex 订阅访问，请直接登录 ChatGPT 而无需填写 API 密钥。',
    ],
  },
  'builtin-anthropic': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.anthropic',
    englishName: 'Anthropic',
    knownDefaultNames: ['Anthropic'],
    notesKey: 'settings:vendor_panel.builtin_notes.anthropic',
    englishNotes:
      'Official Anthropic Claude API (Messages protocol). Available models: claude-opus-5 (flagship), claude-sonnet-5 (balanced), claude-fable-5 (always-on thinking), claude-haiku-4-5 (lightweight, latest official Haiku). Note: 5-series / 4.6+ thinking only accepts thinking:{type:"adaptive"} + output_config.effort and rejects non-default sampling parameters with 400; Haiku 4.5 uses manual extended thinking (budget_tokens).',
    knownDefaultNotes: [
      'Official Anthropic Claude API (Messages protocol). Available models: claude-opus-5 (flagship), claude-sonnet-5 (balanced), claude-fable-5 (always-on thinking), claude-haiku-4-5 (lightweight, latest official Haiku). Note: 5-series / 4.6+ thinking only accepts thinking:{type:"adaptive"} + output_config.effort and rejects non-default sampling parameters with 400; Haiku 4.5 uses manual extended thinking (budget_tokens).',
      'Anthropic 官方 Claude API（Messages 协议）。可用模型: claude-opus-5(旗舰), claude-sonnet-5(均衡), claude-fable-5(思考 always-on), claude-haiku-4-5(轻量, 官方最新 Haiku 仍为 4.5)。注意: 5 系/4.6+ 新代际思考仅接受 thinking:{type:"adaptive"}+output_config.effort，非默认采样参数会 400；Haiku 4.5 走 manual extended thinking(budget_tokens)。',
    ],
  },
  'builtin-mistral': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.mistral',
    englishName: 'Mistral',
    knownDefaultNames: ['Mistral'],
  },
  'builtin-nvidia': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.nvidia',
    englishName: 'NVIDIA',
    knownDefaultNames: ['NVIDIA'],
    notesKey: 'settings:vendor_panel.builtin_notes.nvidia',
    englishNotes:
      'NVIDIA NIM hosted API (OpenAI-compatible Chat Completions; fetch models via /models). Thinking/reasoning-specific parameters are not injected by default to avoid schema mismatches across NIM models.',
    knownDefaultNotes: [
      'NVIDIA NIM hosted API (OpenAI-compatible Chat Completions; fetch models via /models). Thinking/reasoning-specific parameters are not injected by default to avoid schema mismatches across NIM models.',
      'NVIDIA NIM hosted API。OpenAI-compatible Chat Completions；模型可通过 /models 拉取。默认不注入 thinking/reasoning 专用参数，避免不同 NIM 模型参数格式不一致。',
    ],
  },
  'builtin-mimo': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.mimo',
    englishName: 'Xiaomi MiMo',
    knownDefaultNames: ['Xiaomi MiMo', '小米 MiMo'],
    notesKey: 'settings:vendor_panel.builtin_notes.mimo',
    englishNotes:
      'Xiaomi MiMo API. Built-in defaults prioritize MiMo V2.5-Pro and MiMo V2.5 (1M context, OpenAI-compatible Chat Completions); for Token Plan, set Base URL to token-plan-*.xiaomimimo.com/v1. Supports thinking: { type } and reasoning_content output. V2.5 TTS/ASR are dedicated speech models and are excluded from the default chat list.',
    knownDefaultNotes: [
      'Xiaomi MiMo API. Built-in defaults prioritize MiMo V2.5-Pro and MiMo V2.5 (1M context, OpenAI-compatible Chat Completions); for Token Plan, set Base URL to token-plan-*.xiaomimimo.com/v1. Supports thinking: { type } and reasoning_content output. V2.5 TTS/ASR are dedicated speech models and are excluded from the default chat list.',
      'Xiaomi MiMo API。优先内置 MiMo V2.5-Pro 与 MiMo V2.5（1M context，OpenAI-compatible Chat Completions）；Token Plan 可将 Base URL 改为 token-plan-*.xiaomimimo.com/v1。支持 thinking: { type } 与 reasoning_content 回传。V2.5 TTS/ASR 属语音专项能力，当前不放入聊天模型默认列表。',
    ],
  },
  'builtin-opencode-go': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.opencode_go',
    englishName: 'OpenCode Go',
    knownDefaultNames: ['OpenCode Go'],
  },
  'builtin-gemini': {
    nameKey: 'settings:vendor_panel.builtin_vendor_names.gemini',
    englishName: 'Google Gemini',
    knownDefaultNames: ['Google Gemini', 'Gemini'],
    notesKey: 'settings:vendor_panel.builtin_notes.gemini',
    englishNotes:
      'Google Gemini API (native mode). Recommended models: gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-pro-preview, gemini-3.1-flash-lite; gemini-2.5-pro/flash/flash-lite remain available until 2026-10-16. Custom sampling parameters are not recommended for 3.x models. Use v1beta for thinking / systemInstruction / thoughtSignature features.',
    knownDefaultNotes: [
      'Google Gemini API (native mode). Recommended models: gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-pro-preview, gemini-3.1-flash-lite; gemini-2.5-pro/flash/flash-lite remain available until 2026-10-16. Custom sampling parameters are not recommended for 3.x models. Use v1beta for thinking / systemInstruction / thoughtSignature features.',
      'Google Gemini API (原生模式)。推荐模型: gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-pro-preview, gemini-3.1-flash-lite；gemini-2.5-pro/flash/flash-lite 于 2026-10-16 关停前仍可用。3.x 模型官方不建议自定义采样参数。启用 thinking / systemInstruction / thoughtSignature 相关能力时建议走 v1beta。',
    ],
  },
};

export function getProviderDisplayName(providerType?: string | null, t?: VendorTranslateFn): string {
  if (!providerType) return 'OpenAI';
  const normalizedProviderType = providerType.toLowerCase();
  const map: Record<string, string> = {
    openai: 'OpenAI',
    openai_codex: 'OpenAI Codex',
    anthropic: 'Anthropic',
    google: 'Google',
    gemini: 'Google Gemini',
    siliconflow: 'SiliconFlow',
    deepseek: 'DeepSeek',
    qwen: 'Alibaba Qwen',
    zhipu: 'Zhipu AI',
    doubao: 'ByteDance Doubao',
    minimax: 'MiniMax',
    moonshot: 'Moonshot AI',
    ollama: 'Ollama',
    nvidia: 'NVIDIA',
    mimo: 'Xiaomi MiMo',
    opencode_go: 'OpenCode Go',
    mistral: 'Mistral',
  };
  const fallback = map[normalizedProviderType] || providerType;
  return t?.(`settings:vendor_modal.providers.${normalizedProviderType}`, { defaultValue: fallback }) ?? fallback;
}

export function getVendorDisplayName(
  vendor: Pick<VendorConfig, 'id' | 'name' | 'providerType' | 'isBuiltin'>,
  providerLabel: string,
  t?: VendorTranslateFn,
): string {
  if ((vendor.providerType ?? '').toLowerCase() === 'siliconflow') {
    return providerLabel;
  }
  const spec = BUILTIN_VENDOR_DISPLAY[vendor.id];
  if (spec && (vendor.isBuiltin || vendor.id.startsWith('builtin-'))) {
    const trimmed = vendor.name?.trim() ?? '';
    if (!trimmed || spec.knownDefaultNames.includes(trimmed)) {
      const translated = t?.(spec.nameKey, { defaultValue: spec.englishName });
      if (translated && translated !== spec.nameKey) {
        return translated;
      }
      return spec.englishName;
    }
  }
  return vendor.name || providerLabel;
}

export function getVendorNotesDisplay(
  vendor: Pick<VendorConfig, 'id' | 'notes' | 'isBuiltin'>,
  t?: VendorTranslateFn,
): string {
  const raw = vendor.notes ?? '';
  if (!raw) return '';
  const trimmed = raw.trim();

  // Preserve legacy exact-string translation even if vendor.id differs in fixtures/tests
  if (trimmed === 'Built-in template for SiliconFlow. Please enter your API Key.') {
    return t?.('settings:vendor_panel.builtin_siliconflow_notes', { defaultValue: raw }) ?? raw;
  }
  if (
    trimmed ===
    'OpenAI Codex subscription access via ChatGPT OAuth. Sign in with ChatGPT instead of entering an API key.'
  ) {
    return t?.('settings:vendor_panel.builtin_codex_notes', { defaultValue: raw }) ?? raw;
  }

  const spec = BUILTIN_VENDOR_DISPLAY[vendor.id];
  if (spec?.notesKey && spec.knownDefaultNotes?.includes(trimmed)) {
    const fallback = spec.englishNotes ?? raw;
    const translated = t?.(spec.notesKey, { defaultValue: fallback });
    if (translated && translated !== spec.notesKey) {
      return translated;
    }
    return fallback;
  }

  return raw;
}
