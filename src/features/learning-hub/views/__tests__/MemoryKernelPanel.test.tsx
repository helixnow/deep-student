import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryKernelPanel } from '../MemoryKernelPanel';
import * as memoryApi from '@/api/memoryApi';
import * as attributionPill from '@/features/chat/components/message/MemoryKernelAttributionPill';

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
  renderedKernelPreview: '<memory_kernel>\n## 互动硬性规则\n- [必遵] 每次回答结尾附 1 道变式自测题\n</memory_kernel>',
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders HardRules, LearnerProfile weak points/goals, budgets, learner-friendly copy, and snapshot preview', async () => {
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(mockView);
    const mutateSpy = vi.spyOn(memoryApi, 'mutateMemoryKernel').mockResolvedValue(mockView);

    const { container } = render(<MemoryKernelPanel />);

    expect(await screen.findByText('每次回答结尾附 1 道变式自测题')).toBeTruthy();
    expect(screen.getByText('长期记忆内核')).toBeTruthy();
    expect(screen.getByText('新会话首轮自动生效，会话内保持稳定')).toBeTruthy();
    expect(screen.getByText('特征值分解')).toBeTruthy();
    expect(screen.getByText('线性代数')).toBeTruthy();
    expect(screen.getByText('考研数学一 130+')).toBeTruthy();
    expect(screen.getByText('42/1500')).toBeTruthy();
    expect(screen.queryByText(/冻结/)).toBeNull();
    expect(screen.queryByText(/<memory_kernel>/)).toBeNull();

    // Open expandable injected content preview; raw <memory_kernel> inside <pre> remains untouched
    fireEvent.click(screen.getByText('预览注入内容'));
    expect(screen.getByText(/新会话首轮自动读取的长期记忆注入内容/)).toBeTruthy();
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('<memory_kernel>');
    expect(pre?.textContent).toContain('每次回答结尾附 1 道变式自测题');

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

  it('always displays 历史 (0) in disabled state with explanatory tooltip when profileHistory is empty', async () => {
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue({
      ...mockView,
      profileHistory: [],
    });

    render(<MemoryKernelPanel />);

    const historyButton = await screen.findByRole('button', { name: /历史 \(0\)/ });
    expect(historyButton).toBeTruthy();
    expect((historyButton as HTMLButtonElement).disabled).toBe(true);
    expect(historyButton.getAttribute('title')).toBe('每次画像变化会自动保留最近 10 个版本，支持一键回滚');
  });

  it('shows a 5-second undo banner on rule delete and restores the rule when 撤销 is clicked', async () => {
    const viewWithoutRule: memoryApi.MemoryInspectionView = {
      ...mockView,
      hardRules: {
        ...mockView.hardRules,
        rules: [],
      },
    };
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(mockView);
    const mutateSpy = vi
      .spyOn(memoryApi, 'mutateMemoryKernel')
      .mockResolvedValueOnce(viewWithoutRule)
      .mockResolvedValueOnce(mockView);
    const invalidateSpy = vi.spyOn(attributionPill, 'invalidateMemoryKernelAttributionCache');

    render(<MemoryKernelPanel />);

    expect(await screen.findByText('每次回答结尾附 1 道变式自测题')).toBeTruthy();

    // Delete the rule
    fireEvent.click(screen.getByTitle('删除规则'));

    await waitFor(() => {
      expect(mutateSpy).toHaveBeenCalledWith({
        kind: 'remove_rule',
        idOrInstruction: 'rule_1',
      });
    });

    expect(await screen.findByText('已删除规则「每次回答结尾附 1 道变式自测题」')).toBeTruthy();
    const undoButton = screen.getByTestId('memory-kernel-undo-rule');
    expect(undoButton.textContent).toContain('撤销');

    // Click undo to restore
    fireEvent.click(undoButton);

    await waitFor(() => {
      expect(mutateSpy).toHaveBeenCalledWith({
        kind: 'upsert_rule',
        input: {
          instruction: '每次回答结尾附 1 道变式自测题',
          scope: 'global',
          origin: 'user_explicit',
          pinned: true,
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('memory-kernel-undo-rule')).toBeNull();
    });
    expect(screen.getByText('每次回答结尾附 1 道变式自测题')).toBeTruthy();
    expect(invalidateSpy).toHaveBeenCalledWith(viewWithoutRule);
    expect(invalidateSpy).toHaveBeenCalledWith(mockView);
  });

  it('auto-dismisses the rule undo banner after 5 seconds', async () => {
    const viewWithoutRule: memoryApi.MemoryInspectionView = {
      ...mockView,
      hardRules: {
        ...mockView.hardRules,
        rules: [],
      },
    };
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(mockView);
    vi.spyOn(memoryApi, 'mutateMemoryKernel').mockResolvedValue(viewWithoutRule);

    render(<MemoryKernelPanel />);
    expect(await screen.findByText('每次回答结尾附 1 道变式自测题')).toBeTruthy();

    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('删除规则'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('memory-kernel-undo-rule')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('memory-kernel-undo-rule')).toBeNull();
  });
});
