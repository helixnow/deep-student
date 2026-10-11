import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.notify }));

import { AiExplanationWriteButton } from '../AiExplanationWriteButton';

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
  mocks.notify.mockReset();
  vi.useRealTimers();
});

const writeCall = () => mocks.invoke.mock.calls.find(([cmd]) => cmd === 'qbank_update_question');

describe('AiExplanationWriteButton', () => {
  it('writes straight into an empty explanation', async () => {
    mocks.invoke.mockResolvedValue({});
    const onWritten = vi.fn();
    render(<AiExplanationWriteButton questionId="q1" explanation="" aiText={'思路\n<score value="80"/>'} onWritten={onWritten} />);

    fireEvent.click(screen.getByRole('button', { name: /写入解析/ }));

    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
    expect(writeCall()?.[1]).toEqual({
      request: { question_id: 'q1', params: { explanation: '思路' }, record_history: true },
    });
  });

  it('asks before replacing an existing explanation', async () => {
    mocks.invoke.mockResolvedValue({});
    render(<AiExplanationWriteButton questionId="q1" explanation="老师写的" aiText="AI 解析" />);

    fireEvent.click(screen.getByRole('button', { name: /写入解析/ }));
    expect(writeCall()).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: /替换现有解析/ }));
    await waitFor(() => expect(writeCall()?.[1]).toMatchObject({
      request: { params: { explanation: 'AI 解析' } },
    }));
  });

  it('disarms the replace confirmation after a pause', () => {
    vi.useFakeTimers();
    render(<AiExplanationWriteButton questionId="q1" explanation="老师写的" aiText="AI 解析" />);

    fireEvent.click(screen.getByRole('button', { name: /写入解析/ }));
    expect(screen.getByRole('button', { name: /替换现有解析/ })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('button', { name: /写入解析/ })).toBeInTheDocument();
    expect(writeCall()).toBeUndefined();
  });

  it('renders nothing when the AI text already is the explanation', () => {
    render(<AiExplanationWriteButton questionId="q1" explanation="同一段" aiText="同一段" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reports a failed write without calling onWritten', async () => {
    mocks.invoke.mockRejectedValue(new Error('db locked'));
    const onWritten = vi.fn();
    render(<AiExplanationWriteButton questionId="q1" explanation="" aiText="AI 解析" onWritten={onWritten} />);

    fireEvent.click(screen.getByRole('button', { name: /写入解析/ }));

    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('error', expect.any(String)));
    expect(onWritten).not.toHaveBeenCalled();
  });
});
