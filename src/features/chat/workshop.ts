/** Public chat-owned assembly port. No other feature reaches into chat stores/navigation. */
import { createSessionWithDefaults } from './core/session/createSessionWithDefaults';
import { sessionManager } from './core/session/sessionManager';
import { requestChatSessionNavigation } from './navigation/pendingChatNavigation';

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
  navigate(sessionId: string) {
    requestChatSessionNavigation(sessionId);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    }
  },
};
