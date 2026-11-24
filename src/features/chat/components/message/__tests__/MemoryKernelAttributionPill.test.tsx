import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  MemoryKernelAttributionPill,
  invalidateMemoryKernelAttributionCache,
} from '../MemoryKernelAttributionPill';
import * as memoryApi from '@/api/memoryApi';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

describe('MemoryKernelAttributionPill', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateMemoryKernelAttributionCache(null);
  });

  it('shows active rules & weak points and allows one-click rule removal', async () => {
    const initialView: memoryApi.MemoryInspectionView = {
      providerId: 'dstu.memory.local',
      privacyMode: false,
      hardRules: {
        version: 1,
        updated_at: '2026-11-23T00:00:00Z',
        rules: [
          {
            id: 'rule-1',
            instruction: '回答末尾必须留一道思考题',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-23T00:00:00Z',
            updatedAt: '2026-11-23T00:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-23T00:00:00Z',
        weak_points: [
          {
            subject: '线性代数',
            knowledge_point: '特征值几何意义',
            error_pattern: '几何直觉混淆',
            evidence_count: 2,
          },
        ],
        preferences: { others: [] },
        goals: [],
      },
      profileHistory: [],
      renderedKernelPreview: '<memory_kernel>...</memory_kernel>',
      budgets: { rulesChars: 20, rulesMaxChars: 1500, profileChars: 30, profileMaxChars: 2500 },
    };

    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(initialView);
    const mutateSpy = vi.spyOn(memoryApi, 'mutateMemoryKernel').mockResolvedValue({
      ...initialView,
      hardRules: { ...initialView.hardRules, rules: [] },
    });

    render(<MemoryKernelAttributionPill />);

    const pill = await screen.findByTestId('memory-kernel-attribution-pill');
    expect(pill.textContent).toContain('1 规则');
    expect(pill.textContent).toContain('1 薄弱点');

    fireEvent.click(pill);
    expect(await screen.findByText('回答末尾必须留一道思考题')).toBeTruthy();
    expect(screen.getByText(/特征值几何意义/)).toBeTruthy();

    fireEvent.click(screen.getByTitle('忘掉这条规则'));
    await waitFor(() => {
      expect(mutateSpy).toHaveBeenCalledWith({ kind: 'remove_rule', idOrInstruction: 'rule-1' });
    });
  });

  it('shows session-frozen snapshot rules consistently when live global rules diverge', async () => {
    const liveView: memoryApi.MemoryInspectionView = {
      providerId: 'dstu.memory.local',
      privacyMode: false,
      hardRules: {
        version: 3,
        updated_at: '2026-11-24T00:00:00Z',
        rules: [
          {
            id: 'rule-live-new',
            instruction: '只用英文回答',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 2,
        updated_at: '2026-11-24T00:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
      profileHistory: [],
      renderedKernelPreview: '<memory_kernel>...</memory_kernel>',
      budgets: { rulesChars: 20, rulesMaxChars: 1500, profileChars: 30, profileMaxChars: 2500 },
    };
    vi.spyOn(memoryApi, 'inspectMemoryKernel').mockResolvedValue(liveView);

    render(
      <MemoryKernelAttributionPill
        sessionMetadata={{
          memoryKernelSnapshot: {
            providerId: 'dstu.memory.local',
            renderedKernel: '<memory_kernel>frozen</memory_kernel>',
            rulesVersion: 1,
            profileVersion: 1,
            includedRuleIds: ['rule-frozen-1'],
            includedRules: [
              { id: 'rule-frozen-1', instruction: '先给反例再总结', scope: 'global' },
            ],
            includedWeakPointKeys: ['微积分:洛必达法则'],
            includedLegacyNoteIds: [],
            charCount: 40,
            maxChars: 1500,
            snapshotAt: '2026-11-23T00:00:00Z',
            generation: 1,
          },
        }}
      />,
    );

    const pill = await screen.findByTestId('memory-kernel-attribution-pill');
    expect(pill.textContent).toContain('1 规则');
    expect(pill.textContent).toContain('1 薄弱点');

    fireEvent.click(pill);
    expect(await screen.findByText('先给反例再总结')).toBeTruthy();
    expect(screen.queryByText('只用英文回答')).toBeNull();
    expect(screen.getByTestId('memory-kernel-frozen-drift-hint')).toBeTruthy();
    expect(screen.getByText(/洛必达法则/)).toBeTruthy();
  });
});
