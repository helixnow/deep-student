import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyMock = vi.fn(async (_text: string) => true);
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: (text: string) => copyMock(text) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { TranscriptPanel, formatTranscriptForCopy } from '../TranscriptPanel';
import type { TranscriptSegment } from '../mediaTranscriptApi';

const segments: TranscriptSegment[] = [
  { idx: 0, startMs: 0, endMs: 4000, text: '梯度下降的直觉', status: 'done' },
  { idx: 1, startMs: 4000, endMs: 9000, text: '学习率太大会震荡', status: 'done' },
  { idx: 2, startMs: 9000, endMs: 12000, text: '', status: 'failed' },
  { idx: 3, startMs: 12000, endMs: 15000, text: '', status: 'pending' },
  { idx: 4, startMs: 65000, endMs: 70000, text: '动量法加速收敛', status: 'done' },
];

afterEach(cleanup);
beforeEach(() => copyMock.mockClear());

function renderPanel(overrides: Partial<React.ComponentProps<typeof TranscriptPanel>> = {}) {
  const onSeek = vi.fn();
  render(
    <TranscriptPanel
      segments={segments}
      activeSegmentIdx={1}
      onSeek={onSeek}
      status="partial"
      progress={null}
      layout="side"
      {...overrides}
    />,
  );
  return { onSeek };
}

describe('TranscriptPanel', () => {
  it('lists done and failed segments (not pending) and marks the active line', () => {
    renderPanel();
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    const activeButton = within(list).getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'true');
    expect(activeButton?.textContent).toContain('学习率太大会震荡');
    expect(screen.getByText('01:05')).toBeInTheDocument();
  });

  it('click-to-seek passes the segment', () => {
    const { onSeek } = renderPanel();
    fireEvent.click(screen.getByText('动量法加速收敛'));
    expect(onSeek).toHaveBeenCalledWith(expect.objectContaining({ idx: 4, startMs: 65000 }));
  });

  it('filters by search query with highlight and shows the empty state', () => {
    renderPanel();
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: '学习率' } });
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('mark')?.textContent).toBe('学习率');
    fireEvent.change(input, { target: { value: '不存在' } });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('没有匹配的字幕')).toBeInTheDocument();
  });

  it('copies all done lines with timestamps', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));
    await Promise.resolve();
    expect(copyMock).toHaveBeenCalledWith('[00:00] 梯度下降的直觉\n[00:04] 学习率太大会震荡\n[01:05] 动量法加速收敛');
    expect(formatTranscriptForCopy([])).toBe('');
  });

  it('shows progress with cancel while running, and retry when partial', () => {
    const onCancel = vi.fn();
    renderPanel({
      status: 'running',
      progress: { stage: 'asr', completedSegments: 3, totalSegments: 5, percent: 60 },
      onCancel,
    });
    expect(screen.getByText('语音识别')).toBeInTheDocument();
    expect(screen.getByText('3/5 段')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    fireEvent.click(screen.getByRole('button', { name: '取消转写' }));
    expect(onCancel).toHaveBeenCalled();
    cleanup();

    const onRetry = vi.fn();
    renderPanel({ status: 'partial', onRetry });
    expect(screen.getByText('2 段未完成，已完成的段已保留')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试失败段/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('offers selection only when the host can quote or make cards', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: '选择字幕段' })).toBeNull();
  });

  it('selects lines (shift for a range, skipping failed ones) and hands them over in time order', () => {
    const onQuoteSelection = vi.fn();
    const onMakeCardsFromSelection = vi.fn();
    const { onSeek } = renderPanel({ onQuoteSelection, onMakeCardsFromSelection });
    fireEvent.click(screen.getByRole('button', { name: '选择字幕段' }));
    fireEvent.click(screen.getByText('动量法加速收敛'));
    fireEvent.click(screen.getByText('梯度下降的直觉'), { shiftKey: true });
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByText('已选 3 段')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /引用到对话/ }));
    expect(onQuoteSelection.mock.calls[0][0].map((seg: TranscriptSegment) => seg.idx)).toEqual([0, 1, 4]);
    expect(screen.queryByRole('toolbar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '选择字幕段' }));
    fireEvent.click(screen.getByText('学习率太大会震荡'));
    fireEvent.click(screen.getByRole('button', { name: /制卡/ }));
    expect(onMakeCardsFromSelection.mock.calls[0][0].map((seg: TranscriptSegment) => seg.idx)).toEqual([1]);
  });
});
