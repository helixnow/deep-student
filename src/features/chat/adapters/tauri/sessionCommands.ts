/**
 * Chat V2 - TauriAdapter 拆分模块 —— 会话级后端命令：保存/创建/设置/归档/分支，以及块内容与流式块持久化
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import type { SessionSettings, BranchSessionResult } from '../types';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { getLoadedSkills } from '../../skills/progressiveDisclosure';
import { isTauriRuntimeAvailable } from './runtime';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import type { TauriAdapterHost } from './adapterHost';

export async function saveSession(host: TauriAdapterHost): Promise<void> {
  console.log(LOG_PREFIX, 'Saving session:', host.sessionId);

  if (!isTauriRuntimeAvailable()) {
    console.warn(LOG_PREFIX, 'Skip save session: not in Tauri runtime');
    return;
  }

  try {
    // 从 store 构建 session_state（使用 getCurrentState 获取最新状态）
    const state = host.getCurrentState();
    
    // 🔧 笔记引用持久化
    const modeStateWithCanvas = state.modeState;
    
    // 🆕 Prompt 7: 序列化待发送的上下文引用
    const pendingContextRefsForPersistence = state.skillStateJson
      ? state.pendingContextRefs.filter((ref) => ref.typeId !== SKILL_INSTRUCTION_TYPE_ID)
      : state.pendingContextRefs;
    const pendingContextRefsJson = pendingContextRefsForPersistence.length > 0
      ? JSON.stringify(pendingContextRefsForPersistence)
      : null;

    const loadedSkills = getLoadedSkills(host.sessionId);
    const skillStateJson = state.skillStateJson;
    const loadedSkillIdsJson = loadedSkills.length > 0
      ? JSON.stringify(loadedSkills.map((skill) => skill.id))
      : null;

    const sessionState = {
      sessionId: host.sessionId,
      chatParams: state.chatParams,
      features: Object.fromEntries(state.features),
      modeState: modeStateWithCanvas,
      inputValue: state.inputValue || null,
      panelStates: state.panelStates,
      pendingContextRefsJson, // 🆕 Prompt 7: 上下文引用持久化
      loadedSkillIdsJson,
      activeSkillIdsJson: state.activeSkillIds.length > 0 ? JSON.stringify(state.activeSkillIds) : null, // 🆕 手动激活 Skills 持久化（多选）
      skillStateJson: skillStateJson ?? null,
      updatedAt: new Date().toISOString(),
    };

    await invoke('chat_v2_save_session', {
      sessionId: host.sessionId,
      sessionState,
    });

    console.log(LOG_PREFIX, 'Session saved');
  } catch (error) {
    console.error(LOG_PREFIX, 'Save session failed:', getErrorMessage(error));
    throw error;
  }
}

export async function createSession(
  host: TauriAdapterHost,
  mode: string,
  title?: string
): Promise<string> {
  console.log(LOG_PREFIX, 'Creating session:', { mode, title });

  try {
    const session = await invoke<{ id: string }>('chat_v2_create_session', {
      mode,
      title,
      metadata: null,
    });

    console.log(LOG_PREFIX, 'Session created:', session.id);
    return session.id;
  } catch (error) {
    console.error(LOG_PREFIX, 'Create session failed:', getErrorMessage(error));
    throw error;
  }
}

export async function updateSessionSettings(host: TauriAdapterHost, settings: SessionSettings): Promise<void> {
  console.log(LOG_PREFIX, 'Updating session settings:', settings);

  try {
    await invoke('chat_v2_update_session_settings', {
      sessionId: host.sessionId,
      settings,
    });

    console.log(LOG_PREFIX, 'Session settings updated');
  } catch (error) {
    console.error(LOG_PREFIX, 'Update session settings failed:', getErrorMessage(error));
    throw error;
  }
}

export async function archiveSession(host: TauriAdapterHost): Promise<void> {
  console.log(LOG_PREFIX, 'Archiving session:', host.sessionId);

  try {
    await invoke('chat_v2_archive_session', {
      sessionId: host.sessionId,
    });

    console.log(LOG_PREFIX, 'Session archived');
  } catch (error) {
    console.error(LOG_PREFIX, 'Archive session failed:', getErrorMessage(error));
    throw error;
  }
}

export async function branchSession(host: TauriAdapterHost, upToMessageId: string): Promise<BranchSessionResult> {
  console.log(LOG_PREFIX, 'Branching session:', host.sessionId, 'upTo:', upToMessageId);

  try {
    const newSession = await invoke<BranchSessionResult>('chat_v2_branch_session', {
      sourceSessionId: host.sessionId,
      upToMessageId,
    });

    console.log(LOG_PREFIX, 'Session branched:', newSession.id);
    return newSession;
  } catch (error) {
    console.error(LOG_PREFIX, 'Branch session failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 执行更新块内容操作（内部方法，供 callback 使用）
 * 用于 editMessage 后同步块内容到后端
 */
export async function executeUpdateBlockContent(host: TauriAdapterHost, blockId: string, content: string): Promise<void> {
  console.log(LOG_PREFIX, 'Executing update block content:', blockId, 'len:', content.length);

  try {
    await invoke('chat_v2_update_block_content', {
      blockId,
      content,
    });

    console.log(LOG_PREFIX, 'Block content updated successfully:', blockId);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Update block content failed:', errorMsg);
    throw error;
  }
}

/**
 * 执行更新会话设置操作（内部方法，供 callback 使用）
 * 用于 setTitle 后同步设置到后端
 */
export async function executeUpdateSessionSettings(host: TauriAdapterHost, settings: { title?: string }): Promise<void> {
  console.log(LOG_PREFIX, 'Executing update session settings:', settings);

  try {
    await invoke('chat_v2_update_session_settings', {
      sessionId: host.sessionId,
      settings,
    });

    console.log(LOG_PREFIX, 'Session settings updated successfully');
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Update session settings failed:', errorMsg);
    throw error;
  }
}

/**
 * 执行 UPSERT 流式块操作（内部方法，供防闪退保存使用）
 * 用于流式过程中定期保存块内容到后端
 */
export async function executeUpsertStreamingBlock(
  host: TauriAdapterHost,
  blockId: string,
  messageId: string,
  blockType: string,
  content: string,
  sessionId?: string
): Promise<void> {
  console.log(LOG_PREFIX, 'Executing upsert streaming block:', blockId, 'len:', content.length);

  try {
    await invoke('chat_v2_upsert_streaming_block', {
      blockId,
      messageId,
      blockType,
      content,
      sessionId,
    });

    console.log(LOG_PREFIX, 'Streaming block upserted successfully:', blockId);
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'Upsert streaming block failed:', errorMsg);
    // 不抛出错误，防闪退保存失败不应影响流式过程
  }
}
