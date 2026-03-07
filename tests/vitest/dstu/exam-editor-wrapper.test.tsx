import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockCreateEmpty } = vi.hoisted(() => ({
  mockCreateEmpty: vi.fn(),
}));

vi.mock('@/dstu/factory', () => ({
  createEmpty: mockCreateEmpty,
}));

vi.mock('@/components/learning-hub/apps/views/ExamContentView', () => ({
  default: () => <div data-testid="exam-content-view">exam-content-view</div>,
}));

import { ExamEditorWrapper } from '@/dstu/editors/ExamEditorWrapper';

describe('ExamEditorWrapper create mode', () => {
  beforeEach(() => {
    mockCreateEmpty.mockReset();
  });

  it('creates a real exam resource before opening instead of rendering a fake __create_new__ session', async () => {
    const onCreate = vi.fn();
    const onClose = vi.fn();

    mockCreateEmpty.mockResolvedValue({
      ok: true,
      value: {
        path: '/exam_123',
      },
    });

    render(
      <ExamEditorWrapper
        mode="create"
        type="exam"
        onCreate={onCreate}
        onClose={onClose}
      />
    );

    await waitFor(() => {
      expect(mockCreateEmpty).toHaveBeenCalledWith({ type: 'exam' });
    });

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith('/exam_123');
      expect(onClose).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('exam-content-view')).not.toBeInTheDocument();
  });
});
