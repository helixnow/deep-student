import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockGetStatus = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());
const mockRestart = vi.hoisted(() => vi.fn());
const mockListIncidents = vi.hoisted(() => vi.fn());
const mockRetryPreflight = vi.hoisted(() => vi.fn());
const mockOpenIncident = vi.hoisted(() => vi.fn());
const mockExportIncident = vi.hoisted(() => vi.fn());
const mockExportReport = vi.hoisted(() => vi.fn());

vi.mock('@/features/data-recovery/dataRecoveryApi', () => ({
  getStartupRecoveryStatus: mockGetStatus,
  resolveStartupRecovery: mockResolve,
  restartAfterRecovery: mockRestart,
  retryRecoveryStartup: mockRestart,
  listStartupRecoveryIncidents: mockListIncidents,
  retryStartupRecoveryPreflight: mockRetryPreflight,
  openStartupRecoveryIncidentFolder: mockOpenIncident,
  exportStartupRecoveryIncident: mockExportIncident,
  exportStartupRecoveryReport: mockExportReport,
}));

import { RecoveryCenter } from '@/features/data-recovery/RecoveryCenter';

const conflictStatus = {
  recovery_required: true,
  incident: {
    id: 'incident-1',
    kind: 'legacy_root_vs_slots',
    created_at: '2026-07-21T04:00:00Z',
    status: 'awaiting_selection' as const,
    reason: 'Multiple timelines found',
    quarantined_entry_count: 4,
    selected_candidate: null,
    resolved_at: null,
    candidates: [
      {
        id: 'legacy' as const,
        has_data: true,
        has_database: true,
        size_bytes: 2048,
        latest_modified_at: '2026-07-20T12:00:00Z',
        database_files: ['mistakes.db'],
        core_database_files: ['mistakes.db'],
        valid_core_database_files: ['mistakes.db'],
        selectable: true,
        selection_block_reason: null,
        recommended: false,
        recommendation_reason: null,
      },
      {
        id: 'slotA' as const,
        has_data: false,
        has_database: false,
        size_bytes: 0,
        latest_modified_at: null,
        database_files: [],
        core_database_files: [],
        valid_core_database_files: [],
        selectable: false,
        selection_block_reason: 'No core database',
        recommended: false,
        recommendation_reason: null,
      },
      {
        id: 'slotB' as const,
        has_data: true,
        has_database: true,
        size_bytes: 4096,
        latest_modified_at: '2026-07-21T02:00:00Z',
        database_files: ['mistakes.db', 'chat_v2.db'],
        core_database_files: ['mistakes.db', 'chat_v2.db'],
        valid_core_database_files: ['mistakes.db', 'chat_v2.db'],
        selectable: true,
        selection_block_reason: null,
        recommended: true,
        recommendation_reason: 'state.json points to slotB',
      },
    ],
  },
};

describe('RecoveryCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus.mockResolvedValue(conflictStatus);
    mockListIncidents.mockResolvedValue([]);
    mockResolve.mockResolvedValue({
      resolved: true,
      restart_required: true,
      selected_candidate: 'slotB',
      incident_id: 'incident-1',
    });
  });

  it('shows timeline choices inline without a dialog', async () => {
    render(<RecoveryCenter mode="startup" />);

    expect(await screen.findByText(/冲突数据已安全隔离|data:recovery\.protected_title/)).toBeInTheDocument();
    expect(screen.getByText(/升级前的旧版数据|data:recovery\.candidate_legacy/)).toBeInTheDocument();
    expect(screen.getAllByText(/数据空间 B|data:recovery\.candidate_slot_b/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /数据空间 A|data:recovery\.candidate_slot_a/ }),
    ).toBeDisabled();
  });

  it('confirms the selected timeline inline and resolves it', async () => {
    render(<RecoveryCenter mode="startup" />);

    await screen.findByText(/冲突数据已安全隔离|data:recovery\.protected_title/);
    fireEvent.click(screen.getByText(/继续确认|data:recovery\.continue/));

    expect(screen.getByText(/确认将|data:recovery\.confirm_inline/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/确认并准备重启|data:recovery\.confirm_activate/));

    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalledWith('slotB');
    });
    expect(await screen.findByText(/活动数据已准备好|data:recovery\.resolved_title/)).toBeInTheDocument();
  });

  it('renders a healthy inline state when no recovery is pending', async () => {
    mockGetStatus.mockResolvedValue({
      recovery_required: false,
      incident: null,
    });

    render(<RecoveryCenter />);
    expect(await screen.findByText(/数据空间状态正常|data:recovery\.healthy_title/)).toBeInTheDocument();
  });

  it('keeps debug previews interactive without invoking backend recovery', async () => {
    render(
      <RecoveryCenter
        mode="startup"
        initialStatus={conflictStatus}
        debugPreview
      />,
    );

    fireEvent.click(screen.getByText(/继续确认|data:recovery\.continue/));
    fireEvent.click(screen.getByText(/确认并准备重启|data:recovery\.confirm_activate/));

    expect(mockResolve).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/活动数据已准备好|data:recovery\.resolved_title/),
    ).toBeInTheDocument();
  });
});
