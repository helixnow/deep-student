import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { useSettingsShellStore } from '../settingsShellStore';

const initialState = useSettingsShellStore.getInitialState();

// Legacy deep links arrive at runtime, although the public event type only
// declares canonical tabs. Exercise that compatibility boundary explicitly.
function applyRoute(tab: string, dataGovernanceTab?: string): void {
  useSettingsShellStore.getState().applySettingsRoute({
    tab: tab as PendingSettingsRoute['tab'],
    dataGovernanceTab,
  });
}

describe('settings shell route compatibility', () => {
  beforeEach(() => {
    useSettingsShellStore.setState(initialState, true);
  });

  afterEach(() => {
    useSettingsShellStore.setState(initialState, true);
  });

  it.each([
    ['app', 'general'],
    ['api', 'apis'],
    ['automations', 'automation'],
    ['plugin', 'plugins'],
    ['data', 'data-governance'],
    ['voice', 'voice-input'],
    ['dictation', 'voice-input'],
    ['documents', 'document-processing'],
    ['pdf', 'document-processing'],
    ['ocr', 'document-processing'],
  ])('keeps the legacy %s route mapped to %s', (legacyTab, canonicalTab) => {
    applyRoute(legacyTab);

    expect(useSettingsShellStore.getState().activeTab).toBe(canonicalTab);
    expect(useSettingsShellStore.getState().dataGovernanceTabTarget).toBeNull();
  });

  it.each([
    'apis', 'models', 'params', 'general', 'appearance', 'workbench',
    'shortcuts', 'voice-input', 'memory', 'mcp', 'search', 'plugins',
    'automation', 'document-processing', 'statistics', 'data-governance', 'about',
  ])('keeps the canonical %s route independent of category IDs', (tab) => {
    applyRoute(tab);

    expect(useSettingsShellStore.getState().activeTab).toBe(tab);
  });

  it('normalizes whitespace in legacy and nested route values', () => {
    applyRoute(' data ', ' sync ');

    expect(useSettingsShellStore.getState()).toMatchObject({
      activeTab: 'data-governance',
      dataGovernanceTabTarget: { tab: 'sync', requestId: 1 },
    });
  });

  it.each(['sync', 'backup', 'archive'])('preserves direct navigation to data governance / %s', (tab) => {
    applyRoute('data-governance', tab);

    expect(useSettingsShellStore.getState()).toMatchObject({
      activeTab: 'data-governance',
      dataGovernanceTabTarget: { tab, requestId: 1 },
    });
  });

  it('resolves the legacy trash route to the archive tab', () => {
    applyRoute('data', 'trash');

    expect(useSettingsShellStore.getState()).toMatchObject({
      activeTab: 'data-governance',
      dataGovernanceTabTarget: { tab: 'archive', requestId: 1 },
    });
  });

  it('issues a new request when the same nested destination is opened repeatedly', () => {
    applyRoute('data-governance', 'archive');
    const firstTarget = useSettingsShellStore.getState().dataGovernanceTabTarget;
    applyRoute('data', 'archive');

    expect(firstTarget).toEqual({ tab: 'archive', requestId: 1 });
    expect(useSettingsShellStore.getState().dataGovernanceTabTarget)
      .toEqual({ tab: 'archive', requestId: 2 });

    applyRoute('data-governance', 'backup');
    expect(useSettingsShellStore.getState().dataGovernanceTabTarget)
      .toEqual({ tab: 'backup', requestId: 3 });
  });

  it('ignores invalid nested destinations without replacing a valid pending request', () => {
    applyRoute('data-governance', 'sync');
    applyRoute('data-governance', 'not-a-tab');

    expect(useSettingsShellStore.getState().dataGovernanceTabTarget)
      .toEqual({ tab: 'sync', requestId: 1 });
  });

  it('does not apply a data governance subtab when opening another settings page', () => {
    applyRoute('models', 'backup');

    expect(useSettingsShellStore.getState().activeTab).toBe('models');
    expect(useSettingsShellStore.getState().dataGovernanceTabTarget).toBeNull();
  });
});
