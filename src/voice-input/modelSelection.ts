import type { ApiConfig, ModelAssignments } from '@/types';
import { inferApiCapabilities } from '@/utils/apiCapabilityEngine';

import type { VoiceInputAssignedModel } from './types';

export type VoiceInputSelectableApiDisabledReason =
  | 'provider-unavailable'
  | 'model-disabled';

export type VoiceInputSelectableApi = ApiConfig & {
  _isDisabledInList?: boolean;
  _voiceInputDisabledReason?: VoiceInputSelectableApiDisabledReason;
};

const SUPPORTED_VOICE_INPUT_PROVIDERS = new Set(['siliconflow']);
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  siliconflow: 'SiliconFlow',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  assemblyai: 'AssemblyAI',
  groq: 'Groq',
};

function trimOrUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getProviderId(api: Pick<ApiConfig, 'providerScope' | 'providerType'>): string | undefined {
  const providerScope = trimOrUndefined(api.providerScope)?.toLowerCase();
  const providerType = trimOrUndefined(api.providerType)?.toLowerCase();
  return providerScope ?? providerType;
}

function getProviderLabel(api: Pick<ApiConfig, 'vendorName' | 'providerType' | 'providerScope'>): string {
  const providerId = getProviderId(api);
  if (providerId && PROVIDER_LABELS[providerId]) {
    return PROVIDER_LABELS[providerId];
  }

  return (
    trimOrUndefined(api.vendorName) ??
    trimOrUndefined(api.providerType) ??
    trimOrUndefined(api.providerScope) ??
    'Unknown'
  );
}

export function isVoiceInputProviderSupported(providerId: string | undefined): boolean {
  if (!providerId) {
    return false;
  }
  return SUPPORTED_VOICE_INPUT_PROVIDERS.has(providerId.toLowerCase());
}

export function isAudioTranscriptionApi(api: ApiConfig): boolean {
  if (api.isEmbedding || api.isReranker) {
    return false;
  }

  if (api.isAudioTranscription === true) {
    return true;
  }

  const inferred = inferApiCapabilities({
    id: api.model,
    name: api.name,
    providerScope: api.providerScope ?? api.providerType,
  });

  return inferred.audioTranscription;
}

export function isVoiceInputAssignableApi(api: ApiConfig): boolean {
  return isAudioTranscriptionApi(api) && isVoiceInputProviderSupported(getProviderId(api));
}

export function getAssignableVoiceInputApis(
  apis: ApiConfig[],
  currentValue?: string
): VoiceInputSelectableApi[] {
  const enabledApis = apis.filter((api) => api.enabled && isVoiceInputAssignableApi(api));
  let candidates: VoiceInputSelectableApi[] = enabledApis;

  if (currentValue && !enabledApis.some((api) => api.id === currentValue)) {
    const disabledCurrent = apis.find((api) => api.id === currentValue && isVoiceInputAssignableApi(api));
    if (disabledCurrent) {
      candidates = [...enabledApis, { ...disabledCurrent, _isDisabledInList: true }];
    }
  }

  return candidates;
}

export function getVisibleVoiceInputApis(
  apis: ApiConfig[],
  currentValue?: string
): VoiceInputSelectableApi[] {
  const audioApis = apis.filter((api) => isAudioTranscriptionApi(api));
  let candidates: VoiceInputSelectableApi[] = audioApis.map((api) => {
    const providerId = getProviderId(api);
    const disabledReason: VoiceInputSelectableApiDisabledReason | undefined = !isVoiceInputProviderSupported(
      providerId
    )
      ? 'provider-unavailable'
      : !api.enabled
      ? 'model-disabled'
      : undefined;

    if (!disabledReason) {
      return api;
    }

    return {
      ...api,
      _isDisabledInList: true,
      _voiceInputDisabledReason: disabledReason,
    };
  });

  if (currentValue && !candidates.some((api) => api.id === currentValue)) {
    const currentApi = audioApis.find((api) => api.id === currentValue);
    if (currentApi) {
      const providerId = getProviderId(currentApi);
      const disabledReason: VoiceInputSelectableApiDisabledReason | undefined = !currentApi.enabled
        ? 'model-disabled'
        : !isVoiceInputProviderSupported(providerId)
        ? 'provider-unavailable'
        : undefined;

      candidates = [
        ...candidates,
        disabledReason
          ? {
              ...currentApi,
              _isDisabledInList: true,
              _voiceInputDisabledReason: disabledReason,
            }
          : currentApi,
      ];
    }
  }

  return candidates;
}

function buildAssignedModel(
  api: ApiConfig,
  status: VoiceInputAssignedModel['status']
): VoiceInputAssignedModel {
  const providerId = getProviderId(api);

  return {
    status,
    configId: api.id,
    providerId,
    providerLabel: getProviderLabel(api),
    model: api.model,
    modelLabel: api.name || api.model,
    disabled: !api.enabled,
  };
}

export function resolveVoiceInputModelAssignment(
  assignments: Pick<ModelAssignments, 'voice_input_asr_model_config_id'>,
  apis: ApiConfig[]
): VoiceInputAssignedModel {
  const assignedId = assignments.voice_input_asr_model_config_id;
  if (!assignedId) {
    return { status: 'model-assignment-required' };
  }

  const assignedApi = apis.find((api) => api.id === assignedId);
  if (!assignedApi) {
    return { status: 'model-config-missing', configId: assignedId };
  }

  if (!isAudioTranscriptionApi(assignedApi)) {
    return buildAssignedModel(assignedApi, 'model-config-missing');
  }

  const providerId = getProviderId(assignedApi);
  if (!isVoiceInputProviderSupported(providerId)) {
    return buildAssignedModel(assignedApi, 'provider-unavailable');
  }

  if (!assignedApi.enabled) {
    return buildAssignedModel(assignedApi, 'model-disabled');
  }

  return buildAssignedModel(assignedApi, 'ready');
}
