/**
 * Chat V2 - Built-in Slash Command Execution Engine
 *
 * Implements all 33 built-in common control & DeepStudent signature study commands
 * on top of existing ChatStore actions, Memory v2 APIs, and IPC contracts.
 */

import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import type { StoreApi } from 'zustand';
import {
  getMemoryConfig,
  invalidateMemoryKernelAttributionCache,
  mutateMemoryKernel,
  setMemoryPrivacyMode,
} from '@/api/memoryApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { APP_EVENTS, dispatchAppEvent, dispatchTypedEvent } from '@/events';
import type { ReasoningLevel } from '@/utils/reasoning';
import { branchSessionFromMessage } from '../components/message/branchFromMessage';
import {
  exportConversationSnapshotToFile,
  exportSessionToFile,
} from '../components/session-browser/sessionExport';
import type { ChatStore, PermissionPreset } from '../core/types/store';
import type { PanelStates } from '../core/types/common';
import { requestKbScopePicker } from '../kbScope/kbScope';
import { requestChatNewSession } from '../navigation/pendingChatNavigation';
import {
  buildStudyWorkflowPrompt,
  parseGoalCommandArgs,
  parseRememberRuleArgs,
  type BuiltinSlashCommandId,
} from './slashCommandProtocol';

function extractPlainTextFromBlocks(
  blocks: ReadonlyArray<{ type?: string; content?: string }>,
): string {
  return blocks
    .filter((b) => (!b.type || b.type === 'content' || b.type === 'text') && typeof b.content === 'string')
    .map((b) => b.content!.trim())
    .filter(Boolean)
    .join('\n\n');
}

// ============================================================================
// Overlay Card State Types (rendered inline above composer)
// ============================================================================

export type SlashOverlayCardState =
  | { kind: 'btw'; question: string; nonce: number }
  | { kind: 'learn'; recentContext: string; hint?: string; nonce: number }
  | { kind: 'memory'; mode: 'inspect' | 'clean'; nonce: number }
  | { kind: 'context'; nonce: number }
  | { kind: 'doctor'; nonce: number }
  | { kind: 'help'; nonce: number };

export interface SlashCommandExecutorDeps {
  store: StoreApi<ChatStore>;
  sessionId?: string;
  isStreaming: boolean;
  t: TFunction;
  // Context compaction
  onCompactContext: (focusHint?: string) => Promise<void>;
  // Skills
  activeSkillIds: string[];
  activateSkill: (skillId: string) => Promise<unknown>;
  toggleSkill: (skillId: string) => Promise<unknown>;
  clearAllSkills: () => Promise<unknown>;
  // Runtime Model & Thinking
  runtimeModelOptions: ReadonlyArray<{ id: string; label: string; providerLabel?: string }>;
  onSelectRuntimeModel: (modelId: string) => void;
  onOpenRuntimeModelPanel: (mode?: 'single' | 'compare') => void;
  enableThinking?: boolean;
  thinkingCanDisable?: boolean;
  thinkingDepthOptions?: ReadonlyArray<{ value: ReasoningLevel }>;
  onToggleThinking?: () => void;
  onSetThinkingDepth?: (depth: ReasoningLevel) => void;
  // Permissions & Features
  permissionPreset?: PermissionPreset;
  onPermissionPresetChange?: (preset: PermissionPreset, confirm?: boolean) => void | Promise<void>;
  webSearchEnabled?: boolean;
  onWebSearchEnabledChange?: (enabled: boolean) => void | Promise<void>;
  ragEnabled?: boolean;
  onRagEnabledChange?: (enabled: boolean) => void | Promise<void>;
  knowledgeBaseProactive?: boolean;
  onKnowledgeBaseProactiveChange?: (enabled: boolean) => void | Promise<void>;
  // Panels & Layout
  setPanelState: (panel: keyof PanelStates, open: boolean) => void;
  hasMcpPanel: boolean;
  onTextbookToggle?: () => void;
  // Outbound Send & Overlay Cards
  sendRawPrompt: (prompt: string) => Promise<void>;
  openOverlayCard: (card: SlashOverlayCardState) => void;
}

function findActiveCompactionId(state: ChatStore): string | null {
  for (let i = state.messageOrder.length - 1; i >= 0; i -= 1) {
    const msg = state.messageMap.get(state.messageOrder[i]!);
    const blockIds = msg?.blockIds ?? [];
    for (let j = blockIds.length - 1; j >= 0; j -= 1) {
      const block = state.blocks.get(blockIds[j]!);
      if (block?.type !== 'compaction_summary') continue;
      let raw: unknown = block.toolOutput;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch {
          continue;
        }
      }
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if (obj.isActive !== false && typeof obj.compactionId === 'string' && obj.compactionId) {
          return obj.compactionId;
        }
      }
    }
  }
  return null;
}

function extractRecentExchangeText(state: ChatStore, maxChars = 2400): string {
  const lines: string[] = [];
  const tailIds = state.messageOrder.slice(-6);
  for (const id of tailIds) {
    const msg = state.messageMap.get(id);
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const blockIds = state.getDisplayBlockIds ? state.getDisplayBlockIds(id) : (msg.blockIds ?? []);
    const blocks = blockIds
      .map((bid) => state.blocks.get(bid))
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    const fallbackContent = (msg as { content?: string }).content ?? '';
    const text = (extractPlainTextFromBlocks(blocks) || fallbackContent).trim();
    if (!text) continue;
    lines.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 800)}`);
  }
  return lines.join('\n\n').slice(-maxChars);
}

const VALID_REASONING_LEVELS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function normalizePermissionArg(arg: string): PermissionPreset | null {
  const lower = arg.trim().toLowerCase();
  if (lower === 'cautious' || lower === 'readonly' || lower === '谨慎') return 'cautious';
  if (lower === 'relaxed' || lower === 'default' || lower === '宽松') return 'relaxed';
  if (lower === 'full' || lower === 'full_access' || lower === 'full-access' || lower === '完全访问') {
    return 'full_access';
  }
  if (
    lower === 'danger'
    || lower === 'danger_full_access'
    || lower === 'danger-full-access'
    || lower === '危险'
  ) {
    return 'danger_full_access';
  }
  return null;
}

export async function executeBuiltinSlashCommand(
  deps: SlashCommandExecutorDeps,
  invocation: {
    commandId: BuiltinSlashCommandId;
    subcommandId?: string;
    args: string;
  },
): Promise<void> {
  const { store, sessionId, isStreaming, t } = deps;
  const rawArgs = invocation.args.trim();
  const spaceIdx = rawArgs.search(/\s/);
  const firstToken = invocation.subcommandId
    ?? (spaceIdx === -1 ? rawArgs.toLowerCase() : rawArgs.slice(0, spaceIdx).toLowerCase());
  const trailingAfterSub = invocation.subcommandId
    ? rawArgs
    : (spaceIdx === -1 ? '' : rawArgs.slice(spaceIdx + 1).trim());

  const activateAndSendWorkflow = async (
    kind: Parameters<typeof buildStudyWorkflowPrompt>[0],
    workflowArgs: string,
    extra?: Parameters<typeof buildStudyWorkflowPrompt>[2],
  ) => {
    const built = buildStudyWorkflowPrompt(kind, workflowArgs, extra);
    for (const skillId of built.skillIds) {
      if (!deps.activeSkillIds.includes(skillId)) {
        try {
          await deps.activateSkill(skillId);
        } catch {
          // Non-fatal if optional skill cannot be activated in mock/minimal environments
        }
      }
    }
    await deps.sendRawPrompt(built.prompt);
  };

  switch (invocation.commandId) {
    // ========================================================================
    // 1. Context & Session Lifecycle
    // ========================================================================
    case 'compact': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      if (firstToken === 'undo') {
        const state = store.getState();
        const sid = sessionId || state.sessionId;
        const compactionId = findActiveCompactionId(state);
        if (!sid || !compactionId) {
          showGlobalNotification('info', t('chatV2:slashCommands.compact.noActiveToUndo'));
          return;
        }
        try {
          await invoke('chat_v2_undo_compaction', { sessionId: sid, compactionId });
          await state.loadSession(sid);
          showGlobalNotification('success', t('chatV2:slashCommands.compact.undoSuccess'));
        } catch (err) {
          showGlobalNotification(
            'error',
            err instanceof Error ? err.message : String(err),
          );
        }
        return;
      }
      await deps.onCompactContext(rawArgs || undefined);
      return;
    }

    case 'new': {
      store.getState().setInputValue('');
      requestChatNewSession();
      if (rawArgs && typeof window !== 'undefined') {
        setTimeout(() => {
          dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, { content: rawArgs });
        }, 80);
      }
      return;
    }

    case 'branch': {
      const state = store.getState();
      const lastMsgId = state.messageOrder[state.messageOrder.length - 1];
      if (!lastMsgId) {
        showGlobalNotification('info', t('chatV2:slashCommands.branch.emptySession'));
        return;
      }
      try {
        await branchSessionFromMessage(store, lastMsgId);
        showGlobalNotification('success', t('chatV2:slashCommands.branch.success'));
        if (rawArgs && typeof window !== 'undefined') {
          setTimeout(() => {
            dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, { content: rawArgs });
          }, 100);
        }
      } catch (err) {
        showGlobalNotification('error', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    case 'undo': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      const state = store.getState();
      const sid = sessionId || state.sessionId;
      if (!sid || state.messageOrder.length === 0) {
        showGlobalNotification('info', t('chatV2:slashCommands.undo.emptySession'));
        return;
      }
      // Collect trailing assistant messages + the immediately preceding user message
      const toDelete: string[] = [];
      let restoredUserText = '';
      for (let i = state.messageOrder.length - 1; i >= 0; i -= 1) {
        const msgId = state.messageOrder[i]!;
        const msg = state.messageMap.get(msgId);
        if (!msg) continue;
        if (msg.role === 'assistant') {
          toDelete.push(msgId);
        } else if (msg.role === 'user') {
          toDelete.push(msgId);
          const blocks = (msg.blockIds ?? [])
            .map((bid) => state.blocks.get(bid))
            .filter((b): b is NonNullable<typeof b> => Boolean(b));
          const fallbackContent = (msg as { content?: string }).content ?? '';
          restoredUserText = (extractPlainTextFromBlocks(blocks) || fallbackContent).trim();
          break;
        } else if (toDelete.length > 0) {
          break;
        }
      }
      if (toDelete.length === 0) {
        showGlobalNotification('info', t('chatV2:slashCommands.undo.emptySession'));
        return;
      }
      try {
        for (const messageId of toDelete) {
          await invoke('chat_v2_delete_message', { sessionId: sid, messageId });
        }
        await state.loadSession(sid);
        if (restoredUserText) {
          store.getState().setInputValue(restoredUserText);
        }
        showGlobalNotification('success', t('chatV2:slashCommands.undo.success'));
      } catch (err) {
        showGlobalNotification('error', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    case 'export': {
      const sid = sessionId || store.getState().sessionId;
      if (!sid) return;
      const title = store.getState().title || undefined;
      if (firstToken === 'snapshot') {
        await exportConversationSnapshotToFile({ sessionId: sid, title });
      } else if (firstToken === 'json') {
        await exportSessionToFile({ sessionId: sid, title, format: 'json' });
      } else {
        await exportSessionToFile({ sessionId: sid, title, format: 'markdown' });
      }
      return;
    }

    case 'rename': {
      const sid = sessionId || store.getState().sessionId;
      if (!sid) return;
      if (!rawArgs) {
        showGlobalNotification('info', t('chatV2:slashCommands.rename.emptyHint'));
        return;
      }
      try {
        await invoke('chat_v2_update_session_settings', {
          sessionId: sid,
          settings: { title: rawArgs },
        });
        store.setState({ title: rawArgs });
        showGlobalNotification(
          'success',
          t('chatV2:slashCommands.rename.success', { title: rawArgs }),
        );
      } catch (err) {
        showGlobalNotification('error', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // ========================================================================
    // 2. Goal, Plan, Thinking, Model & Permissions
    // ========================================================================
    case 'goal': {
      const state = store.getState();
      const currentGoal = state.goal;
      if (!rawArgs && !invocation.subcommandId) {
        if (currentGoal) {
          deps.openOverlayCard({ kind: 'context', nonce: Date.now() });
        } else {
          showGlobalNotification('info', t('chatV2:slashCommands.goal.emptyHint'));
        }
        return;
      }
      if (firstToken === 'status') {
        if (!currentGoal) {
          showGlobalNotification('info', t('chatV2:slashCommands.goal.noActiveGoal'));
          return;
        }
        showGlobalNotification(
          'info',
          t('chatV2:slashCommands.goal.statusToast', {
            objective: currentGoal.objective,
            status: currentGoal.status,
            tokens: currentGoal.tokensUsed.toLocaleString(),
          }),
        );
        return;
      }
      if (firstToken === 'pause') {
        if (!currentGoal) {
          showGlobalNotification('info', t('chatV2:slashCommands.goal.noActiveGoal'));
          return;
        }
        await state.pauseGoal();
        showGlobalNotification('success', t('chatV2:slashCommands.goal.pausedToast'));
        return;
      }
      if (firstToken === 'resume') {
        if (!currentGoal) {
          showGlobalNotification('info', t('chatV2:slashCommands.goal.noActiveGoal'));
          return;
        }
        await state.resumeGoal();
        showGlobalNotification('success', t('chatV2:slashCommands.goal.resumedToast'));
        return;
      }
      if (firstToken === 'clear') {
        await state.clearGoal();
        showGlobalNotification('success', t('chatV2:slashCommands.goal.clearedToast'));
        return;
      }
      if (firstToken === 'edit' && trailingAfterSub) {
        const parsedEdit = parseGoalCommandArgs(trailingAfterSub);
        if (currentGoal && currentGoal.status !== 'complete' && parsedEdit.objective) {
          await state.editGoal(parsedEdit.objective, parsedEdit.tokenBudget);
          showGlobalNotification('success', t('chatV2:slashCommands.goal.updatedToast'));
          return;
        }
      }

      const parsed = parseGoalCommandArgs(rawArgs);
      if (!parsed.objective) {
        showGlobalNotification('info', t('chatV2:slashCommands.goal.emptyHint'));
        return;
      }
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('goal', parsed.objective, {
        tokenBudget: parsed.tokenBudget,
      });
      return;
    }

    case 'plan': {
      const state = store.getState();
      if (firstToken === 'off') {
        await state.setAuthorityMode('ask');
        showGlobalNotification('success', t('chatV2:slashCommands.plan.disabledToast'));
        return;
      }
      if (!rawArgs || firstToken === 'on') {
        const nextMode = firstToken === 'on'
          ? 'plan'
          : (state.authorityMode === 'plan' ? 'ask' : 'plan');
        await state.setAuthorityMode(nextMode);
        showGlobalNotification(
          'success',
          nextMode === 'plan'
            ? t('chatV2:slashCommands.plan.enabledToast')
            : t('chatV2:slashCommands.plan.disabledToast'),
        );
        return;
      }
      await state.setAuthorityMode('plan');
      await deps.sendRawPrompt(rawArgs);
      return;
    }

    case 'think': {
      if (!firstToken || firstToken === 'toggle') {
        deps.onToggleThinking?.();
        return;
      }
      if (firstToken === 'off' || firstToken === 'false' || firstToken === '关') {
        if (deps.enableThinking && deps.thinkingCanDisable !== false) {
          deps.onToggleThinking?.();
        }
        showGlobalNotification('success', t('chatV2:slashCommands.think.switchedOff'));
        return;
      }
      if (VALID_REASONING_LEVELS.has(firstToken)) {
        if (!deps.enableThinking) {
          deps.onToggleThinking?.();
        }
        deps.onSetThinkingDepth?.(firstToken as ReasoningLevel);
        showGlobalNotification(
          'success',
          t('chatV2:slashCommands.think.switchedLevel', {
            level: t(`chatV2:slashCommands.think.sub.${firstToken}`),
          }),
        );
        return;
      }
      deps.onToggleThinking?.();
      return;
    }

    case 'model': {
      if (!firstToken || firstToken === '__open_panel__') {
        deps.onOpenRuntimeModelPanel('single');
        return;
      }
      const exactOrFuzzy = deps.runtimeModelOptions.find(
        (m) => m.id.toLowerCase() === firstToken || m.label.toLowerCase() === firstToken,
      ) ?? deps.runtimeModelOptions.find(
        (m) =>
          m.id.toLowerCase().includes(firstToken)
          || m.label.toLowerCase().includes(firstToken)
          || (m.providerLabel && m.providerLabel.toLowerCase().includes(firstToken)),
      );
      if (exactOrFuzzy) {
        deps.onSelectRuntimeModel(exactOrFuzzy.id);
        showGlobalNotification(
          'success',
          t('chatV2:slashCommands.model.switchedToast', { model: exactOrFuzzy.label }),
        );
      } else {
        deps.onOpenRuntimeModelPanel('single');
      }
      return;
    }

    case 'mode': {
      const preset = normalizePermissionArg(firstToken);
      if (!preset || !deps.onPermissionPresetChange) {
        return;
      }
      // For danger_full_access, confirm=true reflects explicit slash selection while UI badge turns red immediately
      await deps.onPermissionPresetChange(
        preset,
        preset === 'danger_full_access' ? true : undefined,
      );
      showGlobalNotification(
        'success',
        t('chatV2:slashCommands.mode.switchedToast', {
          mode: t(`chatV2:authority.permissionPreset.modes.${preset}`),
        }),
      );
      return;
    }

    // ========================================================================
    // 3. Switches, Diagnostics & Help
    // ========================================================================
    case 'web': {
      if (!deps.onWebSearchEnabledChange) return;
      const next =
        firstToken === 'on'
          ? true
          : firstToken === 'off'
            ? false
            : !deps.webSearchEnabled;
      await deps.onWebSearchEnabledChange(next);
      showGlobalNotification(
        'success',
        next
          ? t('chatV2:slashCommands.web.enabledToast')
          : t('chatV2:slashCommands.web.disabledToast'),
      );
      return;
    }

    case 'kb': {
      if (firstToken === 'scope') {
        const sid = sessionId || store.getState().sessionId;
        if (sid) requestKbScopePicker(sid);
        return;
      }
      if (firstToken === 'proactive') {
        if (!deps.ragEnabled && deps.onRagEnabledChange) {
          await deps.onRagEnabledChange(true);
        }
        const nextProactive = !deps.knowledgeBaseProactive;
        await deps.onKnowledgeBaseProactiveChange?.(nextProactive);
        showGlobalNotification(
          'success',
          nextProactive
            ? t('chatV2:slashCommands.kb.proactiveEnabledToast')
            : t('chatV2:slashCommands.kb.proactiveDisabledToast'),
        );
        return;
      }
      const nextRag =
        firstToken === 'on'
          ? true
          : firstToken === 'off'
            ? false
            : !deps.ragEnabled;
      await deps.onRagEnabledChange?.(nextRag);
      showGlobalNotification(
        'success',
        nextRag
          ? t('chatV2:slashCommands.kb.enabledToast')
          : t('chatV2:slashCommands.kb.disabledToast'),
      );
      return;
    }

    case 'context': {
      deps.openOverlayCard({ kind: 'context', nonce: Date.now() });
      return;
    }

    case 'mcp': {
      if (!deps.hasMcpPanel) {
        showGlobalNotification('info', t('chatV2:slashCommands.mcp.emptyToast'));
        return;
      }
      deps.setPanelState('mcp', true);
      return;
    }

    case 'skills': {
      if (firstToken === 'clear') {
        await deps.clearAllSkills();
        showGlobalNotification('success', t('chatV2:slashCommands.skills.clearedToast'));
        return;
      }
      deps.setPanelState('skill', true);
      return;
    }

    case 'doctor': {
      deps.openOverlayCard({ kind: 'doctor', nonce: Date.now() });
      return;
    }

    case 'help': {
      deps.openOverlayCard({ kind: 'help', nonce: Date.now() });
      return;
    }

    // ========================================================================
    // 4. DeepStudent Signature Study Commands
    // ========================================================================
    case 'btw': {
      if (!rawArgs) {
        showGlobalNotification('info', t('chatV2:slashCommands.btw.emptyHint'));
        return;
      }
      deps.openOverlayCard({ kind: 'btw', question: rawArgs, nonce: Date.now() });
      return;
    }

    case 'remember': {
      const parsedRule = parseRememberRuleArgs(rawArgs);
      if (!parsedRule.instruction) {
        showGlobalNotification('info', t('chatV2:slashCommands.remember.emptyHint'));
        return;
      }
      try {
        const updated = await mutateMemoryKernel({
          kind: 'upsert_rule',
          input: {
            instruction: parsedRule.instruction,
            scope: parsedRule.scope,
            origin: 'user_explicit',
            pinned: true,
          },
        });
        invalidateMemoryKernelAttributionCache(updated);
        showGlobalNotification('success', t('chatV2:slashCommands.remember.savedToast'));
      } catch (err) {
        showGlobalNotification('error', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    case 'learn': {
      const recentContext = extractRecentExchangeText(store.getState());
      if (!recentContext && !rawArgs) {
        showGlobalNotification('info', t('chatV2:slashCommands.learn.emptySession'));
        return;
      }
      deps.openOverlayCard({
        kind: 'learn',
        recentContext,
        hint: rawArgs || undefined,
        nonce: Date.now(),
      });
      return;
    }

    case 'memory': {
      if (firstToken === 'privacy') {
        try {
          const cfg = await getMemoryConfig();
          const nextPrivacy = !cfg.privacyMode;
          await setMemoryPrivacyMode(nextPrivacy);
          showGlobalNotification(
            'success',
            nextPrivacy
              ? t('chatV2:slashCommands.memory.privacyEnabledToast')
              : t('chatV2:slashCommands.memory.privacyDisabledToast'),
          );
        } catch (err) {
          showGlobalNotification('error', err instanceof Error ? err.message : String(err));
        }
        return;
      }
      deps.openOverlayCard({
        kind: 'memory',
        mode: firstToken === 'clean' ? 'clean' : 'inspect',
        nonce: Date.now(),
      });
      return;
    }

    case 'feynman': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('feynman', rawArgs);
      return;
    }

    case 'tutor': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      if (!rawArgs) {
        await deps.toggleSkill('tutor-mode');
        return;
      }
      await activateAndSendWorkflow('tutor', rawArgs);
      return;
    }

    case 'anki': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('anki', rawArgs);
      return;
    }

    case 'quiz': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('quiz', rawArgs);
      return;
    }

    case 'mindmap': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('mindmap', rawArgs);
      return;
    }

    case 'handout': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('handout', rawArgs);
      return;
    }

    case 'grade': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      const knownRubrics = new Set(['general', 'kaoyan', 'ielts', 'gaokao']);
      const rubric = knownRubrics.has(firstToken) ? firstToken : 'general';
      const essayBody = knownRubrics.has(firstToken) ? trailingAfterSub : rawArgs;
      await activateAndSendWorkflow('grade', essayBody, { rubric });
      return;
    }

    case 'today': {
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('today', rawArgs);
      return;
    }

    case 'read': {
      if (deps.onTextbookToggle) {
        deps.onTextbookToggle();
      } else if (typeof window !== 'undefined') {
        dispatchTypedEvent('command:chat.toggle-panel', undefined);
      }
      return;
    }

    case 'schedule': {
      if (!rawArgs) {
        showGlobalNotification('info', t('chatV2:slashCommands.schedule.emptyHint'));
        return;
      }
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      await activateAndSendWorkflow('schedule', rawArgs);
      return;
    }

    case 'workshop': {
      const workshopSkillId = 'dstu-plugin-development';
      if (!rawArgs) {
        await deps.toggleSkill(workshopSkillId);
        return;
      }
      if (isStreaming) {
        showGlobalNotification('info', t('chatV2:slashCommands.common.busyStreaming'));
        return;
      }
      if (!deps.activeSkillIds.includes(workshopSkillId)) {
        await deps.activateSkill(workshopSkillId);
      }
      await deps.sendRawPrompt(rawArgs);
      return;
    }
  }
}
