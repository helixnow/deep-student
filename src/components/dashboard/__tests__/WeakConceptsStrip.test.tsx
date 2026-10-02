import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invoke, prefill } = vi.hoisted(() => ({ invoke: vi.fn(), prefill: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/features/pdf/selectionStudyActions', () => ({ sendSelectionToChatInput: prefill }));
import { WeakConceptsStrip } from '../WeakConceptsStrip';

afterEach(() => { cleanup(); invoke.mockReset(); prefill.mockReset(); });

describe('WeakConceptsStrip', () => {
  it('shows weak concepts with scores, hides item: fallbacks, and asks chat to explain + practice', async () => {
    invoke.mockResolvedValue({ conceptCount: 3, weakCount: 2, avgScore: 0.5, weakest: [
      { conceptKey: '导数', score: 0.32, total: 6, wrongCount: 4 },
      { conceptKey: 'item:q_1', score: 0.1, total: 3, wrongCount: 3 },
    ] });
    render(<WeakConceptsStrip />);
    fireEvent.click(await screen.findByRole('button', { name: /导数/ }));
    expect(screen.getByText('32%')).toBeInTheDocument();
    expect(screen.queryByText(/item:q_1/)).toBeNull();
    expect(prefill.mock.calls[0][0].text).toContain('导数');
  });

  it('renders nothing without mastery data', async () => {
    invoke.mockRejectedValue(new Error('no db'));
    const { container } = render(<WeakConceptsStrip />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
