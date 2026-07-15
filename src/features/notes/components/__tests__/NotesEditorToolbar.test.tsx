import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CrepeEditorApi } from '@/components/crepe/types';
import { NotesEditorToolbar } from '../NotesEditorToolbar';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) =>
      key === 'notes:toolbar.label' ? '格式化' : defaultValue ?? key.split('.').at(-1) ?? key,
  }),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('NotesEditorToolbar', () => {
  it('keeps every formatting command keyboard reachable in one quiet menu', () => {
    const editor = {
      toggleBold: vi.fn(),
      toggleItalic: vi.fn(),
      toggleInlineCode: vi.fn(),
      setHeading: vi.fn(),
      toggleBulletList: vi.fn(),
      toggleTaskList: vi.fn(),
      insertLink: vi.fn(),
    } as unknown as CrepeEditorApi;

    render(<NotesEditorToolbar editor={editor} />);

    const toolbar = screen.getByRole('toolbar', { name: '格式化' });
    const formatTrigger = screen.getByRole('button', { name: '格式化' });
    expect(toolbar).toContainElement(formatTrigger);
    expect(formatTrigger).not.toHaveAttribute('tabindex', '-1');

    fireEvent.click(formatTrigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const bold = screen.getByRole('menuitem', { name: /bold/ });
    fireEvent.click(bold);
    expect(editor.toggleBold).toHaveBeenCalledTimes(1);

    fireEvent.click(formatTrigger);
    expect(screen.getByRole('menuitem', { name: 'strikethrough' })).toBeInTheDocument();
  });
});
