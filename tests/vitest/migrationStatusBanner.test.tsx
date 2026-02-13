import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MigrationStatusBanner } from '@/components/system-status/MigrationStatusBanner';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

describe('MigrationStatusBanner', () => {
  beforeEach(() => {
    useSystemStatusStore.getState().clearMigrationStatus();
  });

  it('renders persistent warning with action buttons', () => {
    useSystemStatusStore.getState().showMigrationStatus({
      level: 'warning',
      message: '数据库迁移存在警告',
      details: '有 1 个迁移待执行',
    });

    render(<MigrationStatusBanner />);

    expect(screen.getByTestId('migration-status-toast')).toBeInTheDocument();
    expect(screen.getByText('数据库迁移存在警告')).toBeInTheDocument();
    expect(screen.getByText('有 1 个迁移待执行')).toBeInTheDocument();
    expect(screen.getByText(/查看详情|data:governance.toast_view_details/)).toBeInTheDocument();
    expect(screen.getByText(/稍后处理|common:actions.later/)).toBeInTheDocument();
  });

  it('can dismiss banner', () => {
    vi.useFakeTimers();
    useSystemStatusStore.getState().showMigrationStatus({
      level: 'error',
      message: '数据库迁移失败',
      details: 'schema mismatch',
    });

    render(<MigrationStatusBanner />);

    fireEvent.click(screen.getByText(/稍后处理|common:actions.later/));
    vi.advanceTimersByTime(250);

    expect(useSystemStatusStore.getState().migrationVisible).toBe(false);
    vi.useRealTimers();
  });
});
