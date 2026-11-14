import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSubagentCancellationNote,
  computeLiveRowsFloorPx,
  computeRemainingShineLockMs,
  EXPANDABLE_TOOL_MIN_SHINE_MS,
  isStaticNavigationTool,
  LIVE_ACTIVITY_MIN_FLOOR_PX,
  LIVE_ACTIVITY_VISIBLE_ROWS,
  sliceLiveActivityWindow,
  splitPathForRtlTruncation,
  STATIC_TOOL_MIN_SHINE_MS,
  summarizeTurnActivity,
  type LiveActivityItem,
} from '../liveActivityEngine';
import {
  BlockLineCollapsible,
  MinDurationShineBadge,
} from '../BlockLineCollapsible';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('OpenChamber Activity & Tool UX Engine', () => {
  describe('1. Live Activity 7-Row Sliding Window, 96px Floor & Interactive Hoisting', () => {
    it('exports canonical OpenChamber constants', () => {
      expect(LIVE_ACTIVITY_VISIBLE_ROWS).toBe(7);
      expect(LIVE_ACTIVITY_MIN_FLOOR_PX).toBe(96);
      expect(STATIC_TOOL_MIN_SHINE_MS).toBe(1000);
      expect(EXPANDABLE_TOOL_MIN_SHINE_MS).toBe(300);
    });

    it('keeps only the latest 7 regular rows when collapsed and hoists all interactive items outside the fold', () => {
      const items: LiveActivityItem[] = [
        { id: 'r1', kind: 'thinking', status: 'completed' },
        { id: 'r2', kind: 'tool', toolName: 'read', status: 'completed' },
        { id: 'i1', kind: 'ask_user', status: 'running' },
        { id: 'r3', kind: 'tool', toolName: 'grep', status: 'completed' },
        { id: 'r4', kind: 'tool', toolName: 'glob', status: 'completed' },
        { id: 'i2', kind: 'secret_request', status: 'pending' },
        { id: 'r5', kind: 'tool', toolName: 'edit', status: 'completed' },
        { id: 'r6', kind: 'tool', toolName: 'shell', status: 'completed' },
        { id: 'i3', kind: 'approval', status: 'running' },
        { id: 'r7', kind: 'tool', toolName: 'read', status: 'completed' },
        { id: 'r8', kind: 'tool', toolName: 'write', status: 'completed' },
        { id: 'i4', kind: 'generative_ui_await', status: 'running' },
        { id: 'r9', kind: 'thinking', status: 'running' },
        { id: 'i5', kind: 'tool', toolName: 'custom_prompt', requiresUserAction: true },
        { id: 'r10', kind: 'tool', toolName: 'shell', status: 'running' },
      ];

      const collapsed = sliceLiveActivityWindow(items, true);

      expect(collapsed.visibleRows.map((item) => item.id)).toEqual([
        'r4',
        'r5',
        'r6',
        'r7',
        'r8',
        'r9',
        'r10',
      ]);
      expect(collapsed.hiddenCount).toBe(3);
      expect(collapsed.hiddenRows.map((item) => item.id)).toEqual(['r1', 'r2', 'r3']);
      expect(collapsed.hoistedInteractiveItems.map((item) => item.id)).toEqual([
        'i1',
        'i2',
        'i3',
        'i4',
        'i5',
      ]);
      expect(collapsed.minFloorPx).toBe(96);

      const expanded = sliceLiveActivityWindow(items, false);
      expect(expanded.visibleRows).toHaveLength(10);
      expect(expanded.hiddenCount).toBe(0);
      expect(expanded.hoistedInteractiveItems).toHaveLength(5);
    });

    it('holds the 96px floor against minor height shrinkages and releases on large drops or width changes', () => {
      expect(computeLiveRowsFloorPx(220, 180, false)).toBe(220);
      expect(computeLiveRowsFloorPx(220, 260, false)).toBe(260);
      expect(computeLiveRowsFloorPx(260, 120, false)).toBe(120);
      expect(computeLiveRowsFloorPx(220, 180, true)).toBe(180);
    });
  });

  describe('2. Multi-dimensional Turn Activity Summary', () => {
    it('aggregates filesChanged, linesAdded, linesDeleted, exploredCount, commandsRun, researchedCount, and subagentsUsed', () => {
      const items: LiveActivityItem[] = [
        {
          id: '1',
          kind: 'tool',
          toolName: 'edit',
          status: 'completed',
          input: { path: 'src/a.ts' },
          linesAdded: 30,
          linesDeleted: 5,
        },
        {
          id: '2',
          kind: 'tool',
          toolName: 'write',
          status: 'completed',
          input: { path: 'src/b.ts' },
          linesAdded: 18,
          linesDeleted: 7,
        },
        {
          id: '3',
          kind: 'tool',
          toolName: 'patch',
          status: 'completed',
          metadata: {
            files: [{ file: 'src/c.ts', additions: 0, deletions: 0 }],
          },
        },
        { id: '4', kind: 'tool', toolName: 'read', status: 'completed' },
        { id: '5', kind: 'tool', toolName: 'grep', status: 'completed' },
        { id: '6', kind: 'tool', toolName: 'shell', status: 'completed' },
        { id: '7', kind: 'tool', toolName: 'bash', status: 'completed' },
        { id: '8', kind: 'tool', toolName: 'exec_command', status: 'completed' },
        { id: '9', kind: 'tool', toolName: 'shell', status: 'error', metadata: { exit: 1 } },
        { id: '10', kind: 'tool', toolName: 'webfetch', status: 'completed' },
        { id: '11', kind: 'tool', toolName: 'subagent', status: 'completed', subagentSessionId: 'ses_sub_1' },
        { id: '12', kind: 'tool', toolName: 'subagent', status: 'completed', subagentSessionId: 'ses_sub_2' },
      ];

      const summary = summarizeTurnActivity(items);

      expect(summary).toEqual({
        filesChanged: 3,
        linesAdded: 48,
        linesDeleted: 12,
        exploredCount: 2,
        commandsRun: 4,
        researchedCount: 1,
        subagentsUsed: 2,
        segments: [
          '3 files +48/-12',
          'Explored',
          'Ran 4 commands',
          'Researched',
          'Used 2 subagents',
        ],
        summaryText: '3 files +48/-12 · Explored · Ran 4 commands · Researched · Used 2 subagents',
      });
    });
  });

  describe('3. Static Read-Only Navigation Tool Routing, RTL Path Splitting & Minimum Shine Lock', () => {
    it('classifies read-only navigation tools vs heavy side-effect tools', () => {
      expect(isStaticNavigationTool('read')).toBe(true);
      expect(isStaticNavigationTool('builtin-grep')).toBe(true);
      expect(isStaticNavigationTool('glob')).toBe(true);
      expect(isStaticNavigationTool('webfetch')).toBe(true);
      expect(isStaticNavigationTool('skill')).toBe(true);
      expect(isStaticNavigationTool('kb_search')).toBe(true);
      expect(isStaticNavigationTool('memory_read')).toBe(true);

      expect(isStaticNavigationTool('shell')).toBe(false);
      expect(isStaticNavigationTool('edit')).toBe(false);
      expect(isStaticNavigationTool('write')).toBe(false);
      expect(isStaticNavigationTool('subagent')).toBe(false);
    });

    it('splits directory prefix and highlighted baseName for RTL left truncation', () => {
      expect(
        splitPathForRtlTruncation('/tmp/opencode/oc-agent-ux/src/features/chat/ActivityTimeline.tsx'),
      ).toEqual({
        dirPrefix: '/tmp/opencode/oc-agent-ux/src/features/chat',
        baseName: 'ActivityTimeline.tsx',
        hasAbsoluteRoot: true,
        displayDir: 'tmp/opencode/oc-agent-ux/src/features/chat',
        normalizedPath: '/tmp/opencode/oc-agent-ux/src/features/chat/ActivityTimeline.tsx',
      });

      expect(splitPathForRtlTruncation('src/components/Button.tsx')).toEqual({
        dirPrefix: 'src/components',
        baseName: 'Button.tsx',
        hasAbsoluteRoot: false,
        displayDir: 'src/components',
        normalizedPath: 'src/components/Button.tsx',
      });

      expect(splitPathForRtlTruncation('package.json')).toEqual({
        dirPrefix: '',
        baseName: 'package.json',
        hasAbsoluteRoot: false,
        displayDir: '',
        normalizedPath: 'package.json',
      });
    });

    it('computes 960ms remaining shine lock when a static tool finishes in 40ms', () => {
      expect(computeRemainingShineLockMs(1000, 1040, true)).toBe(960);
      expect(computeRemainingShineLockMs(1000, 1040, false)).toBe(260);
      expect(computeRemainingShineLockMs(1000, 2200, true)).toBe(0);
    });
  });

  describe('4. Subagent Cancellation Anti-Retry Synthetic Note', () => {
    it('builds a synthetic note with cancelledByUser: true and doNotRetry: true', () => {
      const note = buildSubagentCancellationNote('ses_child_42', 'Explore timeline components');

      expect(note.cancelledByUser).toBe(true);
      expect(note.doNotRetry).toBe(true);
      expect(note.role).toBe('synthetic');
      expect(note.subagentSessionId).toBe('ses_child_42');
      expect(note.text).toContain('The user stopped the subagent "Explore timeline components" (sessionID: ses_child_42).');
      expect(note.text).toContain('Do not start it again just because of that result.');
      expect(note.metadata.openchamberSubagentCancellation).toEqual({
        sessionID: 'ses_child_42',
        cancelledByUser: true,
        doNotRetry: true,
      });
    });
  });

  describe('5. BlockLineCollapsible & MinDurationShineBadge Components', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('renders 1px border-border/35 vertical line inside a 12px (w-3) hit area and triggers onCollapse on click', () => {
      const handleCollapse = vi.fn();

      render(
        <BlockLineCollapsible onCollapse={handleCollapse}>
          <div>Line 1 of long output</div>
          <div>Line 200 of long output</div>
        </BlockLineCollapsible>,
      );

      const hitArea = screen.getByTestId('block-line-hit-area');
      const rail = screen.getByTestId('block-line-rail');

      expect(hitArea.className).toContain('w-3');
      expect(rail.className).toContain('w-px');
      expect(rail.className).toContain('border-border/35');
      expect(rail.className).toContain('group-hover/blockline:bg-primary/50');

      fireEvent.click(hitArea);
      expect(handleCollapse).toHaveBeenCalledTimes(1);
    });

    it('maintains shine animation for full 1000ms when a static tool completes in 40ms', () => {
      vi.setSystemTime(new Date(10_000));

      const { rerender } = render(
        <MinDurationShineBadge active={true} isStaticTool={true} startedAtMs={10_000}>
          <span>Read</span>
        </MinDurationShineBadge>,
      );

      const badge = screen.getByTestId('min-duration-shine-badge');
      expect(badge.getAttribute('data-shining')).toBe('true');

      // Tool finishes after 40ms
      vi.setSystemTime(new Date(10_040));
      rerender(
        <MinDurationShineBadge active={false} isStaticTool={true} startedAtMs={10_000}>
          <span>Read</span>
        </MinDurationShineBadge>,
      );

      // Still locked in shining state during the remaining 960ms
      expect(badge.getAttribute('data-shining')).toBe('true');

      act(() => {
        vi.advanceTimersByTime(959);
      });
      expect(badge.getAttribute('data-shining')).toBe('true');

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(badge.getAttribute('data-shining')).toBe('false');
    });
  });
});
