import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryKernelPanel } from '../MemoryKernelPanel';
import * as memoryApi from '@/api/memoryApi';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const mockView: memoryApi.MemoryInspectionView = {
  providerId: 'dstu.memory.local',
  privacyMode: false,
  hardRules: {
    version: 1,
    updated_at: '2026-11-23T12:00:00Z',
    rules: [
      {
        id: 'rule_1',
        instruction: '每次回答结尾附 1 道变式自测题',
        scope: 'global',
        origin: 'user_explicit',
        pinned: true,
        createdAt: '2026-11-23T12:00:00Z',
        updatedAt: '2026-11-23T12:00:00Z',
      },
    ],
  },
  learnerProfile: {
    version: 2,
    updated_at: '2026-11-23T12:00:00Z',
    weak_points: [
      {
        subject: '线性代数',
        knowledge_point: '特征值分解',
        error_pattern: '特征向量方向常算反',
        evidence_count: 3,
      },
    ],
    preferences: { others: [] },
    goals: [{ goal: '考研数学一 130+', deadline: '2026-12-20' }],
    recent_status: '刷真题冲刺期',
  },
  profileHistory: [
    {
      version: 2,
      updated_at: '2026-11-23T12:00:00Z',
      weak_points: [],
      preferences: { others: [] },
      goals: [],
    },
    {
      version: 1,
      updated_at: '2026-11-22T12:00:00Z',
      weak_points: [],
      preferences: { others: [] },
      goals: [],
    },
  ],
  renderedKernelPreview: '## 互动硬性规则\n- [必遵] 每次回答结尾附 1 道变式自测题',
  budgets: {
    rulesChars: 42,
    rulesMaxChars: 1500,
    profileChars: 120,
    profileMaxChars: 2500,
  },
};

describe('MemoryKernelPanel (RFC-001 M3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders HardRules, LearnerProfile weak points/goals, budgets, and snapshot preview', async () => {
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(mockView);
    const mutateSpy = vi.spyOn(memoryApi, 'mutateMemoryKernel').mockResolvedValue(mockView);

    render(<MemoryKernelPanel />);

    expect(await screen.findByText('每次回答结尾附 1 道变式自测题')).toBeTruthy();
    expect(screen.getByText('特征值分解')).toBeTruthy();
    expect(screen.getByText('线性代数')).toBeTruthy();
    expect(screen.getByText('考研数学一 130+')).toBeTruthy();
    expect(screen.getByText('42/1500')).toBeTruthy();

    // Open raw frozen snapshot preview
    fireEvent.click(screen.getByText('预览快照'));
    expect(screen.getByText(/实际接收的 <memory_kernel>/)).toBeTruthy();

    // Add a new hard rule
    const input = screen.getByPlaceholderText(/新增常驻互动规则/);
    fireEvent.change(input, { target: { value: '先提示思路，不直接给答案' } });
    fireEvent.click(screen.getByText('添加规则'));

    await waitFor(() => {
      expect(mutateSpy).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'upsert_rule',
        input: expect.objectContaining({ instruction: '先提示思路，不直接给答案', scope: 'global', pinned: true }),
      }));
    });
  });
});
