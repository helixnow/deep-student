import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('@/features/chat/components/ui/TextShimmer', () => ({
  TextShimmer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

import { ActivityTimeline } from '../ActivityTimeline/ActivityTimeline';
import {
  StreamingMarkdownRenderer,
  stabilizeStreamingMarkdownTables,
} from '../renderers/StreamingMarkdownRenderer';
import {
  computeUnifiedDiffSummary,
  TurnDiffLedger,
  TurnDiffReviewCard,
  type TurnFileDiffEntry,
} from '../TurnDiffReviewCard';

function createToolStepBlock(id: string, pathLabel: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    type: 'mcp_tool',
    status: 'success',
    messageId: 'msg-stream-1',
    toolName: 'builtin-read_file',
    toolInput: { path: pathLabel },
    toolOutput: { content: `content of ${pathLabel}` },
    startedAt: 1_000,
    endedAt: 1_080,
    ...overrides,
  };
}

describe('Lane 2: Streaming Table Debounce, 7-Row Activity Window & Turn Diff Review', () => {
  describe('1. StreamingMarkdownRenderer & stabilizeStreamingMarkdownTables', () => {
    it('strips trailing unclosed half table rows and pads missing cells while isStreaming is true', () => {
      const streamingMarkdown = [
        '| 模块 | 耗时 | 完成率 |',
        '| --- | --- | --- |',
        '| 解析器 | 12ms | 98% |',
        '| 调度器 | 8ms |',
        '| 索引器 | 正在流式生成半截行',
      ].join('\n');

      const stabilized = stabilizeStreamingMarkdownTables(streamingMarkdown, true);
      expect(stabilized).toContain('| 解析器 | 12ms | 98% |');
      expect(stabilized).toContain('| 调度器 | 8ms |  |');
      expect(stabilized).not.toContain('正在流式生成半截行');

      render(
        <StreamingMarkdownRenderer
          content={streamingMarkdown}
          isStreaming={true}
          streamRenderingMode="legacy"
        />,
      );

      expect(screen.getByText('解析器')).toBeInTheDocument();
      expect(screen.getByText('调度器')).toBeInTheDocument();
      expect(screen.queryByText(/正在流式生成半截行/)).not.toBeInTheDocument();
    });

    it('renders full markdown content untouched when isStreaming is false', () => {
      const rawMarkdown = [
        '| 模块 | 耗时 | 完成率 |',
        '| --- | --- | --- |',
        '| 解析器 | 12ms | 98% |',
        '| 索引器 | 45ms | 100% |',
      ].join('\n');

      expect(stabilizeStreamingMarkdownTables(rawMarkdown, false)).toBe(rawMarkdown);

      render(
        <StreamingMarkdownRenderer
          content={rawMarkdown}
          isStreaming={false}
          streamRenderingMode="legacy"
        />,
      );

      expect(screen.getByText('解析器')).toBeInTheDocument();
      expect(screen.getByText('索引器')).toBeInTheDocument();
      expect(screen.getByText('45ms')).toBeInTheDocument();
    });

    it('preserves pipe characters inside fenced code blocks during streaming', () => {
      const codeFenceWithPipe = [
        '```ts',
        'const unionType: "a" | "b" = "a"',
        '```',
      ].join('\n');

      expect(stabilizeStreamingMarkdownTables(codeFenceWithPipe, true)).toBe(codeFenceWithPipe);
    });

    it('stabilizes streaming markdown tables in mainContent when enableChainOfThought is active', () => {
      const cotStreamingMarkdown = [
        '<thinking>正在推导各模块复杂度与延迟对比</thinking>',
        '| 模块 | 耗时 | 完成率 |',
        '| --- | --- | --- |',
        '| 解析器 | 12ms | 98% |',
        '| 调度器 | 8ms |',
        '| 索引器 | 思维链分支流式半截行',
      ].join('\n');

      render(
        <StreamingMarkdownRenderer
          content={cotStreamingMarkdown}
          isStreaming={true}
          enableChainOfThought={true}
          streamRenderingMode="legacy"
        />,
      );

      expect(screen.getByText('正在推导各模块复杂度与延迟对比')).toBeInTheDocument();
      expect(screen.getByText('解析器')).toBeInTheDocument();
      expect(screen.getByText('调度器')).toBeInTheDocument();
      expect(screen.queryByText(/思维链分支流式半截行/)).not.toBeInTheDocument();
    });
  });

  describe('2. ActivityTimeline 7-Row Sliding Window & 12px Block-Line Collapse Rail', () => {
    it('shows latest 7 regular steps while streaming > 7 items and expands all when clicking the expand button', () => {
      const tenSteps: Block[] = Array.from({ length: 10 }, (_, idx) =>
        createToolStepBlock(`step-${idx + 1}`, `src/module-${idx + 1}.ts`, {
          status: idx === 9 ? 'running' : 'success',
        }),
      );

      render(<ActivityTimeline blocks={tenSteps} isStreaming={true} />);

      const expandBtn = screen.getByTestId('activity-window-expand-all');
      expect(expandBtn).toHaveTextContent('已折叠 3 项早期步骤 · 点击展开全部');

      // 前 3 项早期步骤被折叠隐藏，最新 7 项（module-4 ~ module-10）可见
      expect(screen.queryByText('src/module-1.ts')).not.toBeInTheDocument();
      expect(screen.queryByText('src/module-2.ts')).not.toBeInTheDocument();
      expect(screen.queryByText('src/module-3.ts')).not.toBeInTheDocument();
      expect(screen.getByText('src/module-4.ts')).toBeInTheDocument();
      expect(screen.getByText('src/module-10.ts')).toBeInTheDocument();

      // 点击“展开全部”后，全部 10 项步骤可见
      fireEvent.click(expandBtn);
      expect(screen.getByText('src/module-1.ts')).toBeInTheDocument();
      expect(screen.getByText('src/module-2.ts')).toBeInTheDocument();
      expect(screen.getByText('src/module-3.ts')).toBeInTheDocument();
      expect(screen.queryByTestId('activity-window-expand-all')).not.toBeInTheDocument();
    });

    it('applies minHeight: 96px floor when sliding window is collapsed during streaming and resets isWindowExpandedAll on new turn or <=7 items', () => {
      const tenSteps: Block[] = Array.from({ length: 10 }, (_, idx) =>
        createToolStepBlock(`floor-step-${idx + 1}`, `src/floor-${idx + 1}.ts`, {
          status: idx === 9 ? 'running' : 'success',
        }),
      );

      const { rerender } = render(<ActivityTimeline blocks={tenSteps} isStreaming={true} />);

      const timelineRoot = screen.getByTestId('activity-timeline');
      expect(timelineRoot).toHaveStyle({ minHeight: '96px' });

      // Click expand all -> minHeight floor removed
      fireEvent.click(screen.getByTestId('activity-window-expand-all'));
      expect(timelineRoot.style.minHeight).toBe('');

      // Drop back to <= 7 items, then grow to 10 items again -> isWindowExpandedAll resets to false and minHeight: 96px re-applies
      rerender(<ActivityTimeline blocks={tenSteps.slice(0, 5)} isStreaming={true} />);
      rerender(<ActivityTimeline blocks={tenSteps} isStreaming={true} />);

      expect(screen.getByTestId('activity-window-expand-all')).toBeInTheDocument();
      expect(screen.getByTestId('activity-timeline')).toHaveStyle({ minHeight: '96px' });
    });

    it('uses post-preflight filtered count when deciding whether to skip running ask_user in <=7 window', () => {
      // 3 shell preflight blocks for the same command + 1 execute block -> 3 preflights hidden, leaving 1 visible shell block
      const preflightBlocks: Block[] = [1, 2, 3].map((n) => ({
        id: `pre-${n}`,
        type: 'mcp_tool',
        status: 'success',
        messageId: 'msg-preflight',
        toolName: 'builtin-shell',
        toolInput: { command: 'npm test', phase: 'preflight' },
        toolOutput: { phase: 'preflight', command: 'npm test' },
      }));
      const execBlock: Block = {
        id: 'exec-1',
        type: 'mcp_tool',
        status: 'success',
        messageId: 'msg-preflight',
        toolName: 'builtin-shell',
        toolInput: { command: 'npm test', phase: 'execute' },
        toolOutput: { phase: 'execute', command: 'npm test', exitCode: 0 },
      };
      const regularBlocks: Block[] = Array.from({ length: 4 }, (_, idx) =>
        createToolStepBlock(`norm-${idx + 1}`, `src/norm-${idx + 1}.ts`),
      );
      const runningAskUser: Block = {
        id: 'ask-running-short',
        type: 'ask_user',
        status: 'running',
        messageId: 'msg-preflight',
        content: '不应在短窗口时间线重复渲染的提问',
      };

      // Raw blocks length = 3 + 1 + 4 + 1 = 9 (> 7), but effective count after hiding 3 preflights is 6 (<= 7)
      render(
        <ActivityTimeline
          blocks={[...preflightBlocks, execBlock, ...regularBlocks, runningAskUser]}
          isStreaming={true}
        />,
      );

      expect(screen.queryByText('不应在短窗口时间线重复渲染的提问')).not.toBeInTheDocument();
    });

    it('hoists interactive ask_user steps outside the fold even when they appear among the earliest items', () => {
      const interactiveBlock: Block = {
        id: 'ask-early-1',
        type: 'ask_user',
        status: 'running',
        messageId: 'msg-stream-2',
        content: '请选择目标数据库迁移策略',
        toolInput: {
          question: '请选择目标数据库迁移策略',
          options: ['蓝绿切换', '滚动升级'],
        },
      };

      const regularBlocks: Block[] = Array.from({ length: 9 }, (_, idx) =>
        createToolStepBlock(`reg-${idx + 1}`, `src/service-${idx + 1}.ts`),
      );

      render(
        <ActivityTimeline
          blocks={[regularBlocks[0], interactiveBlock, ...regularBlocks.slice(1)]}
          isStreaming={true}
        />,
      );

      // 早期普通步骤 reg-1 与 reg-2 被折叠（共 9 个普通步骤，保留最新 7 个 reg-3..reg-9）
      expect(screen.getByTestId('activity-window-expand-all')).toHaveTextContent(
        '已折叠 2 项早期步骤 · 点击展开全部',
      );
      expect(screen.queryByText('src/service-1.ts')).not.toBeInTheDocument();
      expect(screen.queryByText('src/service-2.ts')).not.toBeInTheDocument();

      // 但排在第 2 位的阻塞态交互项被强制 Hoisting 提升，始终可见
      expect(screen.getByText('请选择目标数据库迁移策略')).toBeInTheDocument();
      expect(screen.getByText('src/service-3.ts')).toBeInTheDocument();
      expect(screen.getByText('src/service-9.ts')).toBeInTheDocument();
    });

    it('collapses the expanded timeline in one click via the 12px left block-line rail and allows re-expanding', () => {
      const steps: Block[] = [
        createToolStepBlock('step-a', 'src/alpha.ts'),
        createToolStepBlock('step-b', 'src/beta.ts'),
      ];

      render(<ActivityTimeline blocks={steps} isStreaming={true} />);

      const collapseRail = screen.getByTestId('activity-block-line-collapse');
      expect(collapseRail.className).toContain('w-3');

      fireEvent.click(collapseRail);

      const expandTimelineBtn = screen.getByTestId('activity-timeline-expand');
      expect(expandTimelineBtn).toBeInTheDocument();

      fireEvent.click(expandTimelineBtn);
      expect(screen.getByTestId('activity-block-line-collapse')).toBeInTheDocument();
    });
  });

  describe('3. TurnDiffLedger & TurnDiffReviewCard', () => {
    it('computes additions, deletions, and unified diff lines accurately in computeUnifiedDiffSummary', () => {
      const before = ['const a = 1;', 'const b = 2;', 'export { a, b };'].join('\n');
      const after = [
        'const a = 1;',
        'const b = 20;',
        'const c = 30;',
        'export { a, b, c };',
      ].join('\n');

      const summary = computeUnifiedDiffSummary(before, after);
      expect(summary.additions).toBe(3);
      expect(summary.deletions).toBe(2);
      expect(summary.lines.some((l) => l.type === 'del' && l.content === 'const b = 2;')).toBe(true);
      expect(summary.lines.some((l) => l.type === 'add' && l.content === 'const b = 20;')).toBe(true);
      expect(summary.lines.some((l) => l.type === 'context' && l.content === 'const a = 1;')).toBe(true);
    });

    it('tracks turn file modifications, single-file revert/redo, and full-turn revert/redo in TurnDiffLedger', () => {
      const ledger = new TurnDiffLedger();

      ledger.recordChange({
        id: 'entry-1',
        path: 'src/notes/calculus.md',
        beforeContent: '# 微积分导论\n旧段落',
        afterContent: '# 微积分导论\n新段落第一行\n新段落第二行',
      });
      ledger.recordChange({
        id: 'entry-2',
        path: 'src/notes/algebra.md',
        beforeContent: null,
        afterContent: '# 线性代数讲义\n矩阵特征值',
      });

      const totals = ledger.getTotals();
      expect(totals.totalFiles).toBe(2);
      expect(totals.additions).toBe(4);
      expect(totals.deletions).toBe(1);
      expect(totals.allReverted).toBe(false);

      const singleRevert = ledger.revertFile('entry-1');
      expect(singleRevert?.entry.reverted).toBe(true);
      expect(singleRevert?.restoredContent).toBe('# 微积分导论\n旧段落');
      expect(ledger.getTotals().revertedFiles).toBe(1);

      const singleRedo = ledger.redoFile('entry-1');
      expect(singleRedo?.entry.reverted).toBe(false);
      expect(singleRedo?.appliedContent).toContain('新段落第二行');

      const revertedAll = ledger.revertAll();
      expect(revertedAll).toHaveLength(2);
      expect(ledger.getTotals().allReverted).toBe(true);

      ledger.redoAll();
      expect(ledger.getTotals().allReverted).toBe(false);
    });

    it('renders unified diff lines with tabular-nums counters and supports single-file revert and redo', () => {
      const onRevertFile = vi.fn();
      const onRedoFile = vi.fn();
      const entries: TurnFileDiffEntry[] = [
        {
          id: 'file-1',
          path: 'src/features/chat/StreamView.tsx',
          kind: 'modified',
          beforeContent: 'const limit = 5;\nreturn limit;',
          afterContent: 'const limit = 7;\nreturn limit;',
          additions: 1,
          deletions: 1,
        },
      ];

      render(
        <TurnDiffReviewCard
          entries={entries}
          onRevertFile={onRevertFile}
          onRedoFile={onRedoFile}
        />,
      );

      expect(screen.getByTestId('turn-diff-file-count')).toHaveTextContent('1 个文件');
      expect(screen.getByTestId('turn-diff-total-additions')).toHaveTextContent('+1');
      expect(screen.getByTestId('turn-diff-total-deletions')).toHaveTextContent('-1');
      expect(screen.getByText('const limit = 7;')).toBeInTheDocument();
      expect(screen.getByText('const limit = 5;')).toBeInTheDocument();

      // 点击单文件回滚
      fireEvent.click(screen.getByTestId('turn-diff-revert-file-file-1'));
      expect(onRevertFile).toHaveBeenCalledTimes(1);
      expect(onRevertFile.mock.calls[0][0]).toBe('file-1');
      expect(screen.getByTestId('turn-diff-reverted-status-file-1')).toHaveTextContent(
        '已回滚 (Reverted)',
      );

      // 点击单文件恢复 (Redo)
      fireEvent.click(screen.getByTestId('turn-diff-redo-file-file-1'));
      expect(onRedoFile).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('turn-diff-reverted-status-file-1')).not.toBeInTheDocument();
    });

    it('supports one-click Revert All Turn Changes and Redo All in TurnDiffReviewCard', () => {
      const onRevertAll = vi.fn();
      const onRedoAll = vi.fn();
      const entries: TurnFileDiffEntry[] = [
        {
          id: 'f1',
          path: 'docs/handout-1.md',
          kind: 'modified',
          beforeContent: '旧内容 A',
          afterContent: '新内容 A',
          additions: 1,
          deletions: 1,
        },
        {
          id: 'f2',
          path: 'docs/handout-2.md',
          kind: 'created',
          beforeContent: null,
          afterContent: '新建讲义 B',
          additions: 1,
          deletions: 0,
        },
      ];

      render(
        <TurnDiffReviewCard
          entries={entries}
          onRevertAll={onRevertAll}
          onRedoAll={onRedoAll}
        />,
      );

      fireEvent.click(screen.getByTestId('turn-diff-revert-all'));
      expect(onRevertAll).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('turn-diff-all-reverted-badge')).toHaveTextContent(
        '已回滚 (Reverted)',
      );
      expect(screen.getByTestId('turn-diff-entry-f1')).toHaveAttribute('data-reverted', 'true');
      expect(screen.getByTestId('turn-diff-entry-f2')).toHaveAttribute('data-reverted', 'true');

      // 恢复整轮全部修改
      fireEvent.click(screen.getByTestId('turn-diff-redo-all'));
      expect(onRedoAll).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('turn-diff-entry-f1')).toHaveAttribute('data-reverted', 'false');
      expect(screen.getByTestId('turn-diff-entry-f2')).toHaveAttribute('data-reverted', 'false');
    });
  });
});
