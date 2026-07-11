import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CrepeEditorApi } from '@/components/crepe/types';
import { NotesEditorToolbar } from '../NotesEditorToolbar';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key.split('.').at(-1) ?? key,
  }),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('NotesEditorToolbar', () => {
  it('keeps primary commands keyboard reachable and moves secondary commands into overflow', () => {
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
    const bold = screen.getByRole('button', { name: 'bold' });
    expect(toolbar).toContainElement(bold);
    expect(bold).not.toHaveAttribute('tabindex', '-1');

    fireEvent.click(bold);
    expect(editor.toggleBold).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'strikethrough' })).toBeInTheDocument();
  });
});
