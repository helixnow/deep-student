import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, flush: vi.fn(), refresh: vi.fn() }));
vi.mock('@/components/practice/BatchPracticeWorkspace', () => ({
  default: function MockBatchPracticeWorkspace(props: { onFlushReady?: (flush: () => Promise<void>) => void }) {
    mocks.props = props;
    React.useEffect(() => { props.onFlushReady?.(mocks.flush); }, [props.onFlushReady]);
    return <div data-testid="batch-workspace" />;
  },
}));
vi.mock('@/features/learning-today/todayLearningStore', () => ({ refreshTodayLearning: mocks.refresh }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({ BACK_PRIORITY: { overlay: 100 }, registerBackHandler: vi.fn(() => () => {}) }));
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => {} }, useTranslation: () => ({ t: (key: string) => key === 'common:close' ? '关闭' : '错题重做' }) }));

import { MistakeRedoOverlay } from '../MistakeRedoOverlay';

beforeEach(() => { vi.clearAllMocks(); mocks.flush.mockResolvedValue(undefined); });

describe('MistakeRedoOverlay', () => {
  it('creates a durable cross-question-set batch and flushes before closing', async () => {
    const close = vi.fn();
    render(<MistakeRedoOverlay questionIds={['q1', 'q2', 'q3']} examNames={{}} onClose={close} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(mocks.props?.request).toMatchObject({ scope_id: '__mistake_redo__', mode: 'mistake_redo', question_ids: ['q1', 'q2', 'q3'] });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(mocks.flush).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the overlay open when persistence fails and resumes an existing record by id', async () => {
    mocks.flush.mockRejectedValue(new Error('disk full'));
    const close = vi.fn();
    render(<MistakeRedoOverlay questionIds={[]} practiceId="draft1" submitted={false} examNames={{}} onClose={close} />);
    expect(mocks.props).toMatchObject({ request: undefined, practiceId: 'draft1', submitted: false });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(mocks.flush).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId('batch-workspace')).toBeInTheDocument();
  });
});
