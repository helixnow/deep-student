import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockRunSlotCEmptyDbTest = vi.hoisted(() => vi.fn());
const mockRunSlotDCloneDbTest = vi.hoisted(() => vi.fn());
const mockShowGlobalNotification = vi.hoisted(() => vi.fn());
const mockShowMigrationStatus = vi.hoisted(() => vi.fn());
const mockClearMigrationStatus = vi.hoisted(() => vi.fn());

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: {
    runSlotCEmptyDbTest: mockRunSlotCEmptyDbTest,
    runSlotDCloneDbTest: mockRunSlotDCloneDbTest,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));

vi.mock('@/stores/systemStatusStore', () => ({
  useSystemStatusStore: () => ({
    showMigrationStatus: mockShowMigrationStatus,
    clearMigrationStatus: mockClearMigrationStatus,
  }),
}));

import { DebugTab } from '@/components/settings/DataGovernanceDashboard';

describe('DataGovernance DebugTab slot migration buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers Slot C empty-db test and shows success notification', async () => {
    mockRunSlotCEmptyDbTest.mockResolvedValue({
      success: true,
      report: 'ok',
    });

    render(<DebugTab />);

    fireEvent.click(screen.getByTestId('slot-c-empty-db-test-button'));

    await waitFor(() => {
      expect(mockRunSlotCEmptyDbTest).toHaveBeenCalledTimes(1);
    });
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'success',
      'data:governance.debug_slot_c_test_success'
    );
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('triggers Slot D clone-db test and shows warning when test fails', async () => {
    mockRunSlotDCloneDbTest.mockResolvedValue({
      success: false,
      report: 'failed',
    });

    render(<DebugTab />);

    fireEvent.click(screen.getByTestId('slot-d-clone-db-test-button'));

    await waitFor(() => {
      expect(mockRunSlotDCloneDbTest).toHaveBeenCalledTimes(1);
    });
    expect(mockShowGlobalNotification).toHaveBeenCalledWith(
      'warning',
      'data:governance.debug_slot_d_test_failed'
    );
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('shows actionable error notification when Slot C test throws', async () => {
    mockRunSlotCEmptyDbTest.mockRejectedValue(new Error('boom'));

    render(<DebugTab />);

    fireEvent.click(screen.getByTestId('slot-c-empty-db-test-button'));

    await waitFor(() => {
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        'data:governance.debug_slot_test_error_action'
      );
    });
  });
});
