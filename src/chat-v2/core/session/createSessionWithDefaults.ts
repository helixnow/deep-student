import { invoke } from '@tauri-apps/api/core';
import type { ChatSession } from '../../types/session';
import { sessionManager } from './sessionManager';
import { groupCache } from '../store/groupCache';
import { skillDefaults } from '../../skills/skillDefaults';
import { getErrorMessage } from '@/utils/errorUtils';

interface CreateSessionWithDefaultsOptions {
  mode: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  groupId?: string | null;
  initConfig?: Record<string, unknown>;
}

function buildMetadata(
  metadata: Record<string, unknown> | null | undefined,
  groupId: string | null | undefined
): Record<string, unknown> | null {
  if (!groupId) return metadata ?? null;
  const group = groupCache.get(groupId);
  if (!group?.systemPrompt) return metadata ?? null;

  const base = metadata ? { ...metadata } : {};
  if (!base.groupSystemPromptSnapshot) {
    base.groupSystemPromptSnapshot = group.systemPrompt;
  }
  return base;
}

export async function createSessionWithDefaults(options: CreateSessionWithDefaultsOptions): Promise<ChatSession> {
  const metadata = buildMetadata(options.metadata, options.groupId);
  const session = await invoke<ChatSession>('chat_v2_create_session', {
    mode: options.mode,
    title: options.title ?? null,
    metadata: metadata ?? null,
    groupId: options.groupId ?? null,
  });

  const store = sessionManager.getOrCreate(session.id, {
    mode: options.mode,
    initConfig: options.initConfig,
  });

  store.setState({
    groupId: session.groupId ?? options.groupId ?? null,
    sessionMetadata: (metadata ?? null) as Record<string, unknown> | null,
  });

  const groupDefaults = options.groupId ? groupCache.get(options.groupId)?.defaultSkillIds ?? [] : [];
  const effectiveDefaults = skillDefaults.getEffective(groupDefaults);

  if (effectiveDefaults.length > 0) {
    // 等待 skills 加载完成，避免首次安装时 skills 尚未注册导致激活失败
    const { skillRegistry } = await import('../../skills/registry');
    await skillRegistry.waitForSkillsLoaded();

    const failedSkills: string[] = [];
    for (const skillId of effectiveDefaults) {
      try {
        const success = await store.getState().activateSkill(skillId);
        if (!success) {
          failedSkills.push(skillId);
        }
      } catch (error: unknown) {
        failedSkills.push(skillId);
        console.warn('[createSessionWithDefaults] Failed to activate skill:', skillId, getErrorMessage(error));
      }
    }
    // 🔧 通知用户哪些默认技能激活失败
    if (failedSkills.length > 0) {
      const { showGlobalNotification } = await import('@/components/UnifiedNotification');
      const { default: i18n } = await import('@/i18n');
      showGlobalNotification(
        'warning',
        i18n.t('skills:errors.defaultActivationFailed', {
          defaultValue: '以下默认技能无法激活: {{skills}}，请前往技能管理页面检查',
          skills: failedSkills.join(', '),
        })
      );
    }
  }

  return session;
}
