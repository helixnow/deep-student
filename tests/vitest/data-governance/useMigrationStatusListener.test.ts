import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSystemStatusStore } from '@/stores/systemStatusStore';

const mockListen = vi.fn();
const mockInvoke = vi.fn();
const mockShowGlobalNotification = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mockShowGlobalNotification(...args),
}));

import { useMigrationStatusListener } from '@/hooks/useMigrationStatusListener';

describe('useMigrationStatusListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSystemStatusStore.getState().clearMigrationStatus();

    mockInvoke.mockResolvedValue({
      global_version: 1,
      all_healthy: true,
      databases: [],
      pending_migrations_total: 0,
      has_pending_migrations: false,
      last_error: null,
    });
  });

  it('handles multiple distinct events and dedupes repeated payloads', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | null = null;

    mockListen.mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      eventHandler = handler;
      return () => undefined;
    });

    renderHook(() => useMigrationStatusListener({ showSuccessNotification: false }));

    await waitFor(() => {
      expect(eventHandler).not.toBeNull();
    });

    const warningPayload = {
      success: true,
      has_warnings: true,
      warnings: ['pending migration warning'],
      global_version: 2,
    };

    act(() => {
      eventHandler?.({ payload: warningPayload });
    });

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledTimes(1);
      expect(useSystemStatusStore.getState().migrationLevel).toBe('warning');
    });

    act(() => {
      eventHandler?.({ payload: warningPayload });
    });

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledTimes(1);
    });

    act(() => {
      eventHandler?.({
        payload: {
          success: false,
          error: 'schema mismatch',
          global_version: 2,
        },
      });
    });

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledTimes(2);
      expect(useSystemStatusStore.getState().migrationLevel).toBe('error');
      expect(useSystemStatusStore.getState().migrationDetails).toContain('schema mismatch');
    });
  });
});
