import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, labTemplate, redactionTemplate, templateState } = vi.hoisted(() => {
  const lab = {
    id: 'design-lab',
    fields: ['Subject', 'Question', 'optiona', 'optionb', 'optionc', 'optiond', 'correct', 'explanation'],
    note_type: 'Basic',
  };
  const redaction = {
    id: 'design-redaction',
    fields: ['Header', 'Text', 'Extra'],
    note_type: 'Cloze',
  };
  return {
    invokeMock: vi.fn(async () => null as unknown),
    labTemplate: lab,
    redactionTemplate: redaction,
    templateState: { lab },
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: () => <div data-testid="card-face" />,
}));
vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: (templateId?: string | null) => ({
    template: templateId === 'design-redaction' ? redactionTemplate : templateState.lab,
    loading: false,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'card.noBack': '无背面',
      'card.untitled': '无正面',
      'session.again': '重来',
      'session.back': '背面',
      'session.cancelEdit': '取消',
      'session.easy': '简单',
      'session.edit': '编辑卡片',
      'session.exit': '退出',
      'session.front': '正面',
      'session.good': '良好',
      'session.hard': '困难',
      'session.progress': '复习进度',
      'session.saveEdit': '保存',
      'session.suspend': '暂停卡片',
      'session.undo': '撤销评分',
    }[key] ?? key),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ReviewSessionScreen } from '../screens/ReviewSessionScreen';
import { useFsrsReviewStore, type ReviewCard } from '../store/fsrsReviewStore';

function seedCard(card: ReviewCard): void {
  useFsrsReviewStore.setState({
    screen: 'session',
    dueCards: [card],
    queue: [card],
    queueIndex: 0,
    flipped: false,
    loading: false,
    ratingBusy: false,
    error: null,
    errorKind: null,
    lastRated: null,
    lastReview: null,
    lastSuspended: null,
    retryBatchRequest: null,
  });
}

describe('ReviewSessionScreen template-aware editing', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    templateState.lab = labTemplate;
  });

  it('preserves an in-progress draft when the same card template refreshes', () => {
    seedCard({
      id: 'state-refresh',
      ankiCardId: 'anki-refresh',
      front: 'core question',
      back: 'core answer',
      templateId: 'design-lab',
      extraFields: {
        Question: 'Stored question',
        explanation: 'Stored explanation',
      },
    });

    const view = render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }));
    fireEvent.change(screen.getByLabelText('正面'), { target: { value: 'Unsaved draft' } });

    templateState.lab = { ...labTemplate };
    view.rerender(<ReviewSessionScreen />);

    expect(screen.getByLabelText('正面')).toHaveValue('Unsaved draft');
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('opens with design-lab primary fields and saves them through the store payload', async () => {
    seedCard({
      id: 'state-1',
      ankiCardId: 'anki-1',
      front: 'stale core question',
      back: 'stale core explanation',
      templateId: 'design-lab',
      extraFields: {
        Subject: 'Biology',
        Question: 'Actual question',
        optiona: 'A',
        optionb: 'B',
        optionc: 'C',
        optiond: 'D',
        correct: 'A',
        explanation: 'Actual explanation',
        Untouched: 'keep',
      },
    });

    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }));
    const front = screen.getByLabelText('正面');
    const back = screen.getByLabelText('背面');
    expect(front).toHaveValue('Actual question');
    expect(back).toHaveValue('Actual explanation');

    fireEvent.change(front, { target: { value: 'Edited question' } });
    fireEvent.change(back, { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.change(back, { target: { value: 'Edited explanation' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('update_anki_card', {
      card: expect.objectContaining({
        id: 'anki-1',
        front: 'Edited question',
        back: 'Edited explanation',
        extra_fields: expect.objectContaining({
          Question: 'Edited question',
          explanation: 'Edited explanation',
          Subject: 'Biology',
          Untouched: 'keep',
        }),
      }),
    }));
    expect(useFsrsReviewStore.getState().queue[0]).toEqual(expect.objectContaining({
      front: 'Edited question',
      back: 'Edited explanation',
      extraFields: expect.objectContaining({
        Question: 'Edited question',
        explanation: 'Edited explanation',
      }),
    }));
  });

  it('saves a Cloze card with an empty optional Extra and core back', async () => {
    seedCard({
      id: 'state-empty-extra',
      ankiCardId: 'anki-empty-extra',
      front: 'stale core',
      back: 'Existing revealed answer',
      text: 'Earth {{c1::orbits}} the Sun.',
      templateId: 'design-redaction',
      extraFields: {
        Header: 'SPACE',
        Text: 'Earth {{c1::orbits}} the Sun.',
        Extra: '',
      },
    });

    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }));
    expect(screen.getByLabelText('背面')).toHaveValue('');
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('update_anki_card', {
      card: expect.objectContaining({
        id: 'anki-empty-extra',
        back: '',
        text: 'Earth {{c1::orbits}} the Sun.',
        extra_fields: expect.objectContaining({ Extra: '' }),
      }),
    }));
  });

  it('keeps Cloze save disabled until the edited Text has a valid deletion', () => {
    seedCard({
      id: 'state-2',
      ankiCardId: 'anki-2',
      front: 'stale core',
      back: 'stale core',
      text: 'Earth {{c1::orbits}} the Sun.',
      templateId: 'design-redaction',
      extraFields: {
        Header: 'SPACE',
        Text: 'Earth {{c1::orbits}} the Sun.',
        Extra: 'Astronomy note',
      },
    });

    render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }));
    const front = screen.getByLabelText('正面');
    const save = screen.getByRole('button', { name: '保存' });
    expect(front).toHaveValue('Earth {{c1::orbits}} the Sun.');

    fireEvent.change(front, { target: { value: 'Earth orbits the Sun.' } });
    expect(save).toBeDisabled();
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.change(front, { target: { value: 'Earth {{c1::orbits}} the Sun.' } });
    expect(save).toBeEnabled();
  });
});
