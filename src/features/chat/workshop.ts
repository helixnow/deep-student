/** Public chat-owned assembly port. No other feature reaches into chat stores/navigation. */
import { createSessionWithDefaults } from './core/session/createSessionWithDefaults';
import { sessionManager } from './core/session/sessionManager';
import { requestChatSessionNavigation } from './navigation/pendingChatNavigation';
import { setWorkshopEditing } from './workshopEditing';
import { invoke } from '@tauri-apps/api/core';
import { sessionTitleFromText } from './utils/sessionTitleFromText';
import { adapterManager } from './adapters/AdapterManager';

export const workshopSessions = {
  create(options: { mode: 'chat'; title: string; metadata: Record<string, unknown> }) {
    return createSessionWithDefaults({ ...options, defaultSkillIds: [] });
  },
  async activateSkill(sessionId: string, skillId: string) {
    const store = sessionManager.getOrCreate(sessionId);
    const activated = await store.getState().activateSkill(skillId);
    if (activated) {
      try {
        await store.getState().saveSession();
      } catch {
        // Ignore persistence errors; in-memory store already holds the activated skill.
      }
    }
    return activated;
  },
  /**
   * Starter sentence as an editable draft in that session's composer; nothing is sent.
   * The conversation is named after the starter (same rule as the host's fallback title),
   * so it doesn't sit in the list as a generic 「新对话」/「插件工坊」.
   */
  async prefill(sessionId: string, text: string) {
    const store = sessionManager.getOrCreate(sessionId);
    const { entry, lease } = await adapterManager.getOrCreate(sessionId, store);
    try {
      if (!entry.isReady || entry.error) throw new Error(entry.error ?? 'Chat connection is not ready');
      await adapterManager.waitForListenersReady(sessionId);
      // A cold adapter restores the persisted composer. Apply this new draft after that restore, so it cannot erase it.
      store.getState().setInputValue(text);
      const title = sessionTitleFromText(text);
      if (!title) return;
      try {
        await invoke('chat_v2_update_session_settings', { sessionId, settings: { title } });
        store.setState({ title });
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
      } catch (error) {
        console.warn('[workshop] failed to title the starter conversation:', error);
      }
    } finally {
      adapterManager.release(sessionId, lease);
    }
  },
  /** Submit the user's explicit workshop request through the normal chat adapter. */
  async submit(sessionId: string, text: string) {
    const store = sessionManager.getOrCreate(sessionId);
    const { entry, lease } = await adapterManager.getOrCreate(sessionId, store);
    try {
      if (!entry.isReady || entry.error) throw new Error(entry.error ?? 'Chat connection is not ready');
      await adapterManager.waitForListenersReady(sessionId);
      await store.getState().sendMessage(text);
    } finally {
      adapterManager.release(sessionId, lease);
    }
  },
  /** Focus that session's composer (after navigation settles). */
  focus(sessionId: string) {
    if (typeof window === 'undefined') return;
    const emit = () => window.dispatchEvent(new CustomEvent('CHAT_V2_FOCUS_INPUT', { detail: { sessionId } }));
    requestAnimationFrame(emit);
    window.setTimeout(emit, 150);
    window.setTimeout(emit, 400);
  },
  /** Whether the conversation still exists (it may have been deleted since the work was made). */
  async exists(sessionId: string) {
    try {
      const session = await invoke<{ id?: string } | null>('chat_v2_get_session', { sessionId });
      return Boolean(session);
    } catch {
      return false;
    }
  },
  /** 「正在修改：<名> v<版本>」 above that session's composer; null clears it. */
  setEditing(sessionId: string, label: string | null) {
    setWorkshopEditing(sessionId, label);
  },
  navigate(sessionId: string) {
    requestChatSessionNavigation(sessionId);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    }
  },
};
