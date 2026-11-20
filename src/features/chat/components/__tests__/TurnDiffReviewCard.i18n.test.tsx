import path from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import zhChat from '@/locales/zh-CN/chatV2.json';
import enChat from '@/locales/en-US/chatV2.json';
import type { TurnFileDiffEntry } from '../TurnDiffReviewCard';

const { language } = await vi.hoisted(async () => ({
  language: (await import('i18next')).createInstance(),
}));

vi.mock('react-i18next', () =>
  vi.importActual<typeof import('react-i18next')>(
    path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
  ),
);

const { TurnDiffReviewCard } = await import('../TurnDiffReviewCard');

const SAMPLE_ENTRIES: TurnFileDiffEntry[] = [
  {
    id: 'e1',
    path: 'notes/linear-algebra.md',
    kind: 'modified',
    beforeContent: 'rank = 2',
    afterContent: 'rank = 3',
    additions: 1,
    deletions: 1,
  },
];

describe('TurnDiffReviewCard bilingual i18n', () => {
  beforeAll(async () => {
    await language.init({
      lng: 'zh-CN',
      fallbackLng: false,
      defaultNS: 'chatV2',
      ns: ['chatV2'],
      resources: {
        'zh-CN': { chatV2: zhChat },
        'en-US': { chatV2: enChat },
      },
      interpolation: { escapeValue: false },
    });
  });

  afterEach(() => cleanup());

  it('renders localized zh-CN and en-US labels for TurnDiffReviewCard', async () => {
    await language.changeLanguage('en-US');
    const { rerender } = render(
      <I18nextProvider i18n={language}>
        <TurnDiffReviewCard entries={SAMPLE_ENTRIES} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('region', { name: 'Turn Changes Review' })).toBeInTheDocument();
    expect(screen.getByTestId('turn-diff-file-count')).toHaveTextContent('1 file');
    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByTestId('turn-diff-revert-all')).toHaveTextContent('Revert All Changes');

    fireEvent.click(screen.getByTestId('turn-diff-revert-file-e1'));
    expect(screen.getByTestId('turn-diff-reverted-status-e1')).toHaveTextContent('Reverted');
    expect(screen.getByTestId('turn-diff-redo-file-e1')).toHaveTextContent('Redo');

    await language.changeLanguage('zh-CN');
    rerender(
      <I18nextProvider i18n={language}>
        <TurnDiffReviewCard entries={SAMPLE_ENTRIES} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('region', { name: '本轮修改审阅' })).toBeInTheDocument();
  });
});
