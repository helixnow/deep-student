import type { TFunction } from 'i18next';
import type { WorkspaceAgent } from './types';

export function getLocalizedSkillName(
  skillId: string | undefined,
  t: TFunction,
  fallback?: string
): string {
  if (!skillId) return fallback || '';
  const translatedName = t(`skills:builtinNames.${skillId}`, { defaultValue: '' });
  return translatedName || skillId || fallback || '';
}

export function getAgentDisplayName(
  agent: Pick<WorkspaceAgent, 'role' | 'skillId'> | undefined,
  t: TFunction,
  fallbackId?: string
): string {
  if (!agent) return fallbackId || '';
  if (agent.role === 'coordinator') {
    return t('chatV2:workspace.agent.coordinator', '协调者');
  }
  const workerFallback = t('chatV2:workspace.agent.worker', 'Worker');
  return getLocalizedSkillName(agent.skillId, t, workerFallback) || workerFallback;
}
