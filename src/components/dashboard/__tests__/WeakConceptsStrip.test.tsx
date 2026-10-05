import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invoke, dispatch } = vi.hoisted(() => ({ invoke: vi.fn(), dispatch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events')>()),
  dispatchAppEvent: dispatch,
}));
import { WeakConceptsStrip } from '../WeakConceptsStrip';

afterEach(() => { cleanup(); invoke.mockReset(); dispatch.mockReset(); });

describe('WeakConceptsStrip', () => {
  it('shows weak concepts with scores, hides item: fallbacks, and opens a fresh chat to explain + practice', async () => {
    invoke.mockResolvedValue({ conceptCount: 3, weakCount: 2, avgScore: 0.5, weakest: [
      { conceptKey: '导数', score: 0.32, total: 6, wrongCount: 4 },
      { conceptKey: 'item:q_1', score: 0.1, total: 3, wrongCount: 3 },
    ] });
    render(<WeakConceptsStrip />);
    fireEvent.click(await screen.findByRole('button', { name: /导数/ }));
    expect(screen.getByText('32%')).toBeInTheDocument();
    expect(screen.queryByText(/item:q_1/)).toBeNull();
    const [eventName, detail] = dispatch.mock.calls[0];
    expect(eventName).toBe('PREFILL_CHAT_INPUT');
    expect(detail).toMatchObject({ autoSend: false, newSession: true });
    // 练习题要写进题目集并以该知识点为首个标签，作答才会回写掌握度
    expect(detail.content).toContain('导数');
    expect(detail.content).toContain('题目集');
  });

  it('renders nothing without mastery data', async () => {
    invoke.mockRejectedValue(new Error('no db'));
    const { container } = render(<WeakConceptsStrip />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('uses concepts handed in by the caller without reading mastery again', () => {
    render(<WeakConceptsStrip concepts={[{ conceptKey: '极限', score: 0.5, total: 2, wrongCount: 1 }]} />);
    expect(screen.getByRole('button', { name: /极限/ })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});
