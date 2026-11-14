import { normalizeBaseUrl } from './providerConfig';
import type {
  ByokPresetId,
  ByokProviderPreset,
  ByokTransportType,
  KeyDetectionInput,
  KeyDetectionResult,
} from './types';

export const BYOK_PRESETS: Readonly<Record<ByokPresetId, ByokProviderPreset>> = {
  siliconflow: {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    i18nProviderKey: 'settings:vendor_modal.providers.siliconflow',
    iconModelId: 'siliconflow',
    providerType: 'openai-compatible',
    vendorProviderType: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    builtinVendorId: 'builtin-siliconflow',
    supportsEmbeddingsByDefault: true,
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    i18nProviderKey: 'settings:vendor_modal.providers.deepseek',
    iconModelId: 'deepseek-v3.1',
    providerType: 'openai-compatible',
    vendorProviderType: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    builtinVendorId: 'builtin-deepseek',
    supportsEmbeddingsByDefault: false,
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    i18nProviderKey: 'settings:vendor_modal.providers.openai',
    iconModelId: 'gpt-4o',
    providerType: 'openai-compatible',
    vendorProviderType: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    builtinVendorId: 'builtin-openai',
    supportsEmbeddingsByDefault: true,
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    i18nProviderKey: 'settings:vendor_modal.providers.anthropic',
    iconModelId: 'claude-3-opus',
    providerType: 'anthropic',
    vendorProviderType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    builtinVendorId: 'builtin-anthropic',
    supportsEmbeddingsByDefault: false,
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    i18nProviderKey: 'settings:vendor_modal.providers.google',
    iconModelId: 'gemini-2.5-flash',
    providerType: 'gemini',
    vendorProviderType: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    builtinVendorId: 'builtin-gemini',
    supportsEmbeddingsByDefault: true,
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    i18nProviderKey: 'settings:vendor_modal.providers.openrouter',
    iconModelId: 'openrouter',
    providerType: 'openai-compatible',
    vendorProviderType: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    builtinVendorId: 'builtin-openrouter',
    supportsEmbeddingsByDefault: true,
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    iconModelId: 'groq',
    providerType: 'openai-compatible',
    vendorProviderType: 'custom',
    baseUrl: 'https://api.groq.com/openai/v1',
    supportsEmbeddingsByDefault: false,
  },
  xai: {
    id: 'xai',
    displayName: 'xAI',
    i18nProviderKey: 'settings:vendor_modal.providers.grok',
    iconModelId: 'grok-2',
    providerType: 'openai-compatible',
    vendorProviderType: 'grok',
    baseUrl: 'https://api.x.ai/v1',
    supportsEmbeddingsByDefault: false,
  },
  zhipu: {
    id: 'zhipu',
    displayName: 'Zhipu AI',
    i18nProviderKey: 'settings:vendor_modal.providers.zhipu',
    iconModelId: 'glm-4.5',
    providerType: 'openai-compatible',
    vendorProviderType: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    builtinVendorId: 'builtin-zhipu',
    supportsEmbeddingsByDefault: true,
  },
  dashscope: {
    id: 'dashscope',
    displayName: 'DashScope',
    i18nProviderKey: 'settings:vendor_modal.providers.qwen',
    iconModelId: 'qwen3-8b',
    providerType: 'openai-compatible',
    vendorProviderType: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    builtinVendorId: 'builtin-qwen',
    supportsEmbeddingsByDefault: true,
  },
  moonshot: {
    id: 'moonshot',
    displayName: 'Moonshot',
    i18nProviderKey: 'settings:vendor_modal.providers.moonshot',
    iconModelId: 'kimi-k2',
    providerType: 'openai-compatible',
    vendorProviderType: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    builtinVendorId: 'builtin-moonshot',
    supportsEmbeddingsByDefault: false,
  },
  custom: {
    id: 'custom',
    displayName: 'Custom Gateway',
    i18nProviderKey: 'settings:vendor_modal.providers.custom',
    iconModelId: 'gpt-4o',
    providerType: 'openai-compatible',
    vendorProviderType: 'custom',
    baseUrl: '',
    supportsEmbeddingsByDefault: true,
  },
};

export const AMBIGUOUS_SK_CANDIDATE_IDS: readonly ByokPresetId[] = [
  'siliconflow',
  'deepseek',
  'openai',
  'dashscope',
  'moonshot',
];

const ZHIPU_JWT_KEY_REGEX = /^(?:def)?[0-9a-f]{20,}\.[A-Za-z0-9_-]{10,}$/i;
const GENERIC_SK_KEY_REGEX = /^sk-[A-Za-z0-9_-]{16,}$/;

export function sanitizeRawApiKey(rawApiKey: string): string {
  return rawApiKey.replace(/[\u200B-\u200D\uFEFF]/gu, '').trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function inferTransportFromBaseUrl(baseUrl: string): ByokTransportType {
  try {
    const candidate = baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`;
    const hostname = new URL(candidate).hostname.toLowerCase();
    if (hostname === 'api.anthropic.com') return 'anthropic';
    if (hostname === 'generativelanguage.googleapis.com') return 'gemini';
  } catch {
    // Keep openai-compatible fallback for partial URLs
  }
  return 'openai-compatible';
}

function matchBasePreset(sanitizedKey: string): {
  preset: ByokProviderPreset | null;
  isAmbiguous: boolean;
  candidates: ByokProviderPreset[];
} {
  if (!sanitizedKey) {
    return { preset: null, isAmbiguous: false, candidates: [] };
  }

  if (sanitizedKey.startsWith('sk-ant-')) {
    return { preset: BYOK_PRESETS.anthropic, isAmbiguous: false, candidates: [] };
  }

  if (sanitizedKey.startsWith('sk-or-v1-')) {
    return { preset: BYOK_PRESETS.openrouter, isAmbiguous: false, candidates: [] };
  }

  if (
    sanitizedKey.startsWith('AIzaSy') &&
    sanitizedKey.length >= 35 &&
    sanitizedKey.length <= 45
  ) {
    return { preset: BYOK_PRESETS.gemini, isAmbiguous: false, candidates: [] };
  }

  if (sanitizedKey.startsWith('gsk_')) {
    return { preset: BYOK_PRESETS.groq, isAmbiguous: false, candidates: [] };
  }

  if (sanitizedKey.startsWith('xai-')) {
    return { preset: BYOK_PRESETS.xai, isAmbiguous: false, candidates: [] };
  }

  if (ZHIPU_JWT_KEY_REGEX.test(sanitizedKey)) {
    return { preset: BYOK_PRESETS.zhipu, isAmbiguous: false, candidates: [] };
  }

  if (sanitizedKey.startsWith('sk-proj-') || sanitizedKey.startsWith('sk-svcacct-')) {
    return { preset: BYOK_PRESETS.openai, isAmbiguous: false, candidates: [] };
  }

  if (GENERIC_SK_KEY_REGEX.test(sanitizedKey)) {
    const candidates = AMBIGUOUS_SK_CANDIDATE_IDS.map((id) => BYOK_PRESETS[id]);
    return {
      preset: BYOK_PRESETS.siliconflow,
      isAmbiguous: true,
      candidates,
    };
  }

  // Unrecognized non-sk token: default to SiliconFlow/custom candidates without locking
  const candidates = AMBIGUOUS_SK_CANDIDATE_IDS.map((id) => BYOK_PRESETS[id]);
  return {
    preset: null,
    isAmbiguous: true,
    candidates,
  };
}

export function detectByokProvider(input: KeyDetectionInput): KeyDetectionResult {
  const sanitizedApiKey = sanitizeRawApiKey(input.rawApiKey);
  const customUrl = normalizeBaseUrl(input.customBaseUrl ?? '');

  if (customUrl) {
    const transportType = inferTransportFromBaseUrl(customUrl);
    const matchedPreset = Object.values(BYOK_PRESETS).find((preset) => {
      if (!preset.baseUrl) return false;
      try {
        return new URL(preset.baseUrl).hostname === new URL(customUrl).hostname;
      } catch {
        return false;
      }
    });
    const customPreset: ByokProviderPreset = matchedPreset
      ? {
          ...matchedPreset,
          baseUrl: customUrl,
          providerType: transportType,
        }
      : {
          ...BYOK_PRESETS.custom,
          baseUrl: customUrl,
          providerType: transportType,
          vendorProviderType: 'custom',
        };

    return {
      sanitizedApiKey,
      preset: customPreset,
      isAmbiguous: false,
      candidates: [],
      effectiveBaseUrl: customUrl,
      usedCustomBaseUrl: true,
    };
  }

  if (input.selectedPresetId && input.selectedPresetId !== 'custom') {
    const explicitPreset = BYOK_PRESETS[input.selectedPresetId];
    if (explicitPreset) {
      const baseMatch = matchBasePreset(sanitizedApiKey);
      return {
        sanitizedApiKey,
        preset: explicitPreset,
        isAmbiguous: false,
        candidates: baseMatch.candidates,
        effectiveBaseUrl: explicitPreset.baseUrl,
        usedCustomBaseUrl: false,
      };
    }
  }

  const detected = matchBasePreset(sanitizedApiKey);
  return {
    sanitizedApiKey,
    preset: detected.preset,
    isAmbiguous: detected.isAmbiguous,
    candidates: detected.candidates,
    effectiveBaseUrl: detected.preset?.baseUrl ?? '',
    usedCustomBaseUrl: false,
  };
}
