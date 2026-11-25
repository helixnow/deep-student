import { describe, expect, it } from 'vitest';
import { isUiLayoutCacheKey, resetUiLayoutCache } from '../uiLayoutReset';

function createMemoryStorage(initial: Record<string, string>): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe('SPOF-5B uiLayoutReset', () => {
  it('clears UI layout, workbench snapshot, sidebar, view-state, and split-pane keys while preserving auth, consent, settings, and study data', () => {
    const layoutKeys: Record<string, string> = {
      'desktop.workbenchSnapshot': '{"windows":[{"id":"corrupt"}]}',
      'desktop.workbenchSpaceSnapshots.v1': '{"version":1,"entries":{}}',
      'desktop.workbenchHandoff': '{}',
      'desktop.workbenchMode': 'true',
      'workbench.notesWorkspace.state.v1': '{"tabs":[]}',
      'workbench.dock.magnification.v2': '{"enabled":true}',
      'workbench.desktopWidgets.collapsed': '["agenda"]',
      'wb.resourceWorkspace.essay.sidebar': 'collapsed',
      'sidebar_collapsed': 'true',
      'todo-window-sidebar-width': '9999',
      'todo-sidebar-collapsed-sections': '["lists"]',
      'chat-v2-sidebar-expanded-folders': '["f1"]',
      'notes-backlinks-panel:section-collapse': '{"outgoing":true}',
      'translation.workbench.layout': 'split',
      'translation.workbench.splitRatio': '0.99',
      'learning-hub-tabs-v1': '[]',
      'split-pane:custom-view': '0.5',
      'viewState:dashboard': '{"scrollTop":120}',
      'ui.layout.mainDrawer': 'open',
    };

    const preservedKeys: Record<string, string> = {
      'auth_token': 'secret-bearer-token',
      'openai_api_key': 'sk-live-123456',
      'oauth.refresh_token': 'refresh-xyz',
      'user_agreement_accepted': 'true',
      'deepstudent_legal_consent': '{"accepted":true}',
      'onboarding_completed_flows': '["welcome"]',
      'ds.studySpace.activeId.v1': 'space_math_101',
      'essay_draft_session_1': 'My important essay draft',
      'dstu.chatv2.composerDrafts.lru.v2': '{"s1":"unsent message"}',
      'ds.essay_grading.custom_rubrics.v1': '[{"id":"r1"}]',
      'translation.promptTemplates.v1': '[{"name":"academic"}]',
      'dstu-auto-sync': '{"enabled":true}',
      'mcp.tools.list': '[{"id":"my-mcp"}]',
      'deep-student.skill-enable-overrides': '{"skill-a":true}',
      'i18nextLng': 'zh-CN',
      'theme': 'dark',
      'ui.fontFamily': 'Inter',
      'dstu-custom-shortcuts': '{"cmd+k":"palette"}',
      // Defense-in-depth: protected tokens inside layout-looking prefixes must NEVER be wiped.
      'workbench.auth_token': 'must-stay',
      'sidebar.api_key': 'must-stay',
      'layout.user_study_data': 'must-stay',
    };

    const storage = createMemoryStorage({ ...layoutKeys, ...preservedKeys });

    const cleared = resetUiLayoutCache(storage);

    expect(cleared).toEqual(Object.keys(layoutKeys).sort());
    for (const key of Object.keys(layoutKeys)) {
      expect(storage.getItem(key), `expected layout key ${key} to be cleared`).toBeNull();
    }
    for (const [key, value] of Object.entries(preservedKeys)) {
      expect(storage.getItem(key), `expected protected key ${key} to be preserved`).toBe(value);
    }
  });

  it('returns an empty list cleanly when storage has no layout keys', () => {
    const storage = createMemoryStorage({
      auth_token: 'keep',
      user_agreement_accepted: 'true',
    });

    expect(resetUiLayoutCache(storage)).toEqual([]);
    expect(storage.getItem('auth_token')).toBe('keep');
    expect(isUiLayoutCacheKey('')).toBe(false);
  });
});
