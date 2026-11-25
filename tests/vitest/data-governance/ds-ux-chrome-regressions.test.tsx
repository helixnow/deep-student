import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import enCommon from '@/locales/en-US/common.json';
import enData from '@/locales/en-US/data.json';
import enSync from '@/locales/en-US/sync.json';
import enWorkbench from '@/locales/en-US/workbench.json';
import zhCommon from '@/locales/zh-CN/common.json';
import zhData from '@/locales/zh-CN/data.json';
import zhSync from '@/locales/zh-CN/sync.json';
import zhWorkbench from '@/locales/zh-CN/workbench.json';

const mockShowGlobalNotification = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn(async () => null));

let activeLocale: 'en-US' | 'zh-CN' = 'en-US';

function lookupNested(obj: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function realTranslate(
  defaultNs: string | readonly string[] | undefined,
  key: string,
  opts?: Record<string, unknown>,
): string {
  const fallbackNs = Array.isArray(defaultNs) ? defaultNs[0] : (defaultNs ?? 'common');
  const [ns, rest] = key.includes(':') ? key.split(':', 2) : [fallbackNs, key];
  const bundles: Record<string, Record<string, unknown>> =
    activeLocale === 'en-US'
      ? {
          common: enCommon as Record<string, unknown>,
          data: enData as Record<string, unknown>,
          sync: enSync as Record<string, unknown>,
          workbench: enWorkbench as Record<string, unknown>,
        }
      : {
          common: zhCommon as Record<string, unknown>,
          data: zhData as Record<string, unknown>,
          sync: zhSync as Record<string, unknown>,
          workbench: zhWorkbench as Record<string, unknown>,
        };
  const bundle = bundles[ns];
  let value =
    (bundle ? lookupNested(bundle, rest) : undefined) ??
    (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'defaultValue') continue;
      value = value.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v));
    }
  }
  return value;
}

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: (ns?: string | readonly string[]) => ({
    t: (key: string, opts?: Record<string, unknown>) => realTranslate(ns, key, opts),
    i18n: { language: activeLocale, changeLanguage: () => Promise.resolve() },
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));
vi.mock('@/features/settings/components/CloudStorageSection', () => ({
  CloudStorageSection: () => <div data-testid="cloud-storage-stub" />,
}));
vi.mock('@/features/settings/components/DevicePairingSection', () => ({
  DevicePairingSection: () => <div data-testid="device-pairing-stub" />,
}));
vi.mock('@/features/settings/components/data-governance/RecordConflictsPanel', () => ({
  RecordConflictsPanel: () => <div id="record-conflicts-panel" data-testid="record-conflicts-panel" />,
  default: () => <div id="record-conflicts-panel" data-testid="record-conflicts-panel" />,
}));
vi.mock('@/features/settings/components/data-governance/SyncQuarantinePanel', () => ({
  SyncQuarantinePanel: () => <div data-testid="quarantine-stub" />,
}));
vi.mock('@/features/settings/components/data-governance/UnsyncedItemsPanel', () => ({
  UnsyncedItemsPanel: () => <div data-testid="unsynced-stub" />,
}));
vi.mock('@/features/settings/components/data-governance/SyncIndicator', () => ({
  SyncIndicator: () => <div data-testid="sync-indicator-stub" />,
}));

import { StatusBarItems } from '@/features/workbench/components/StatusBarItems';
import { UnifiedMobileHeader } from '@/components/layout/UnifiedMobileHeader';
import { SyncTab } from '@/features/settings/components/data-governance/SyncTab';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { APP_EVENTS, addAppEventListener } from '@/events';
import { consumePendingSettingsRoute } from '@/utils/pendingSettingsTab';

beforeEach(() => {
  vi.clearAllMocks();
  activeLocale = 'en-US';
  window.localStorage.clear();
  consumePendingSettingsRoute();
  useGlobalSyncStore.setState({
    isSyncing: false,
    source: null,
    progress: null,
    cancelRequested: false,
    unresolvedConflictCount: 0,
    unresolvedConflictPerDb: {},
    hasUnsavedCloudDraft: false,
    conflictJumpRequestSeq: 0,
  });
  useSettingsShellStore.setState({ activeTab: 'apis', dataGovernanceTabTarget: null });
});

afterEach(() => {
  consumePendingSettingsRoute();
});

describe('Global Persistent Sync Conflict Badge (Desktop StatusBar & 360px Mobile Header)', () => {
  it('renders ZERO DOM nodes when idle (unresolvedConflictCount === 0)', () => {
    render(
      <>
        <StatusBarItems dueCount={0} taskCount={0} automation={null} />
        <UnifiedMobileHeader fallbackTitle="Notes" />
      </>,
    );
    expect(screen.queryByTestId('global-sync-conflict-badge')).toBeNull();
  });

  it('renders clickable conflict chip in Desktop StatusBarItems (zero CJK in en-US) and navigates to Settings > Data Governance > Sync > #record-conflicts-panel', () => {
    const launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const onBeforeNavigate = vi.fn();
    const navEvents: unknown[] = [];
    const settingsEvents: unknown[] = [];
    const offNav = addAppEventListener(APP_EVENTS.NAVIGATE_TO_TAB, (d) => navEvents.push(d));
    const offSettings = addAppEventListener(APP_EVENTS.SETTINGS_NAVIGATE_TAB, (d) =>
      settingsEvents.push(d),
    );

    try {
      act(() => {
        useGlobalSyncStore.getState().setUnresolvedConflictCount(3);
      });
      render(
        <StatusBarItems
          dueCount={0}
          taskCount={0}
          automation={null}
          onBeforeNavigate={onBeforeNavigate}
        />,
      );

      const badge = screen.getByTestId('global-sync-conflict-badge');
      expect(badge).toHaveTextContent('Conflicts');
      expect(badge).toHaveTextContent('3');
      expect(badge.getAttribute('aria-label')).toContain('3');
      expect(badge.textContent).not.toMatch(/[\u4e00-\u9fff]/);
      expect(badge.getAttribute('aria-label')).not.toMatch(/[\u4e00-\u9fff]/);

      fireEvent.click(badge);

      expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
      expect(launchSpy).toHaveBeenCalledWith({ typeId: 'settings', reason: 'api' });
      expect(useSettingsShellStore.getState().activeTab).toBe('data-governance');
      expect(useSettingsShellStore.getState().dataGovernanceTabTarget?.tab).toBe('sync');
      expect(useGlobalSyncStore.getState().conflictJumpRequestSeq).toBeGreaterThan(0);
      expect(navEvents).toEqual([{ tabName: 'settings' }]);
      expect(settingsEvents).toEqual([{ tab: 'data-governance', dataGovernanceTab: 'sync' }]);
      expect(
        dispatchSpy.mock.calls.some(
          ([evt]) => evt instanceof Event && evt.type === 'data-governance:jump-to-conflicts',
        ),
      ).toBe(true);
    } finally {
      launchSpy.mockRestore();
      dispatchSpy.mockRestore();
      offNav();
      offSettings();
    }
  });

  it('renders clickable conflict pill in UnifiedMobileHeader (standard & floating menu) and navigates to Sync conflicts', () => {
    const navEvents: unknown[] = [];
    const offNav = addAppEventListener(APP_EVENTS.NAVIGATE_TO_TAB, (d) => navEvents.push(d));
    try {
      act(() => {
        useGlobalSyncStore.getState().setUnresolvedConflictCount(2);
      });

      const { rerender } = render(<UnifiedMobileHeader fallbackTitle="Notes" />);
      const badge = screen.getByTestId('global-sync-conflict-badge');
      expect(badge).toHaveTextContent('2 conflict(s)');
      expect(badge.textContent).not.toMatch(/[\u4e00-\u9fff]/);

      fireEvent.click(badge);
      expect(useSettingsShellStore.getState().activeTab).toBe('data-governance');
      expect(useSettingsShellStore.getState().dataGovernanceTabTarget?.tab).toBe('sync');
      expect(navEvents).toEqual([{ tabName: 'settings' }]);

      // Also mounts cleanly in floatingMenuButton mode
      activeLocale = 'zh-CN';
      rerender(
        <UnifiedMobileHeader
          configOverride={{
            title: '对话',
            showMenu: true,
            floatingMenuButton: true,
            onMenuClick: vi.fn(),
          }}
        />,
      );
      const zhBadge = screen.getByTestId('global-sync-conflict-badge');
      expect(zhBadge).toHaveTextContent('2 组冲突');
    } finally {
      offNav();
    }
  });
});

describe('Unsaved Cloud Draft Guard & Anchored Sync Feedback in SyncTab', () => {
  const baseProps = () => ({
    syncStatus: {
      has_pending_changes: true,
      total_pending_changes: 2,
      total_synced_changes: 10,
      databases: [
        { id: 'vfs', has_change_log: true, pending_changes: 2, synced_changes: 10, last_sync_at: null },
      ],
      last_sync_at: null,
      device_id: 'dev-test-1',
    },
    conflicts: null,
    loading: false,
    onRefresh: vi.fn(),
    onDetectConflicts: vi.fn(),
    cloudSyncConfigured: true,
    cloudSyncSummary: { provider: 'webdav' as const, root: 'sync' },
    syncRunning: false,
    syncProgress: null,
    syncStrategy: 'keep_latest' as const,
    onSyncStrategyChange: vi.fn(),
    showCloudSettingsEditor: false,
    onToggleCloudSettingsEditor: vi.fn(),
    onSetCloudSettingsEditorOpen: vi.fn(),
    onCloudConfigChanged: vi.fn(),
    onRunSync: vi.fn(),
  });

  it('blocks 立即同步 with a non-silent warning banner + toast when hasUnsavedCloudDraft is true', () => {
    const props = baseProps();
    act(() => {
      useGlobalSyncStore.getState().setHasUnsavedCloudDraft(true);
    });

    render(<SyncTab {...props} />);

    expect(screen.getByTestId('sync-unsaved-cloud-draft-banner')).toBeInTheDocument();

    const syncNowBtn = screen.getByRole('button', { name: /Sync Now|立即同步/i });
    fireEvent.click(syncNowBtn);

    expect(props.onRunSync).not.toHaveBeenCalled();
    expect(props.onSetCloudSettingsEditorOpen).toHaveBeenCalledWith(true);
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Save Configuration'),
    );

    // Clearing draft allows syncing normally
    act(() => {
      useGlobalSyncStore.getState().setHasUnsavedCloudDraft(false);
    });
    expect(screen.queryByTestId('sync-unsaved-cloud-draft-banner')).toBeNull();
    fireEvent.click(syncNowBtn);
    expect(props.onRunSync).toHaveBeenCalledWith('bidirectional', 'keep_latest');
  });

  it('consumes global conflictJumpRequestSeq on mount and scrolls to #record-conflicts-panel', () => {
    const props = baseProps();
    const scrollIntoViewMock = vi.fn();
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    try {
      act(() => {
        useGlobalSyncStore.getState().requestJumpToConflicts();
      });
      render(<SyncTab {...props} />);
      expect(scrollIntoViewMock).toHaveBeenCalled();
      expect(useGlobalSyncStore.getState().conflictJumpRequestSeq).toBe(0);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });
});
