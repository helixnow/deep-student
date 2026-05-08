import { invoke } from '@tauri-apps/api/core';

import type { ApiConfig, ModelAssignments } from '@/types';

import { loadVoiceInputConfig } from './config';
import { resolveVoiceInputModelAssignment } from './modelSelection';
import type { VoiceInputRuntimeConfig } from './types';

const EMPTY_ASSIGNMENTS: Pick<ModelAssignments, 'voice_input_asr_model_config_id'> = {
  voice_input_asr_model_config_id: null,
};

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

export async function loadVoiceInputRuntimeConfig(): Promise<VoiceInputRuntimeConfig> {
  const behaviorConfig = await loadVoiceInputConfig();

  if (!isTauriRuntime()) {
    return {
      ...behaviorConfig,
      assignedModel: resolveVoiceInputModelAssignment(EMPTY_ASSIGNMENTS, []),
    };
  }

  const [assignments, apis] = await Promise.all([
    invoke<Pick<ModelAssignments, 'voice_input_asr_model_config_id'>>('get_model_assignments').catch(
      () => EMPTY_ASSIGNMENTS
    ),
    invoke<ApiConfig[]>('get_api_configurations').catch(() => []),
  ]);

  return {
    ...behaviorConfig,
    assignedModel: resolveVoiceInputModelAssignment(assignments, apis),
  };
}
