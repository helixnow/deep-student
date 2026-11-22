import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/shad/Tooltip';
import { CanvasShortcutHintPill } from '../CanvasShortcutHintPill';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

describe('CanvasShortcutHintPill', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('编辑态展示 Tab/Enter/F2 快捷键提示，支持收起并持久化偏好，使用容器类替代视口断点和无效 blur', () => {
    const onOpenShortcuts = vi.fn();
    render(
      <TooltipProvider>
        <CanvasShortcutHintPill reciteMode={false} onOpenShortcuts={onOpenShortcuts} />
      </TooltipProvider>,
    );

    const pill = screen.getByTestId('mm-shortcut-hint-pill');
    expect(pill.textContent).toContain('Tab');
    expect(pill.textContent).toContain('Enter');
    expect(pill.textContent).toContain('F2');
    expect(pill.textContent).toContain('canvasV2.hintChild');
    expect(pill.className).toContain('mm-shortcut-hint-pill');
    expect(pill.className).not.toContain('lg:inline-flex');
    expect(pill.className).not.toContain('backdrop-blur-md');

    fireEvent.click(screen.getByTestId('mm-shortcut-hint-more'));
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('mm-shortcut-hint-collapse'));
    expect(screen.queryByTestId('mm-shortcut-hint-pill')).toBeNull();
    const expandBtn = screen.getByTestId('mm-shortcut-hint-expand');
    expect(expandBtn).toBeTruthy();
    expect(expandBtn.className).not.toContain('backdrop-blur-md');
    expect(expandBtn.parentElement?.className).toContain('mm-shortcut-hint-pill');
    expect(expandBtn.parentElement?.className).not.toContain('lg:inline-flex');

    fireEvent.click(expandBtn);
    expect(screen.getByTestId('mm-shortcut-hint-pill')).toBeTruthy();
  });

  it('背诵（挖空复习）态自动切换为导航/揭示/退出提示', () => {
    render(
      <TooltipProvider>
        <CanvasShortcutHintPill reciteMode={true} />
      </TooltipProvider>,
    );

    const pill = screen.getByTestId('mm-shortcut-hint-pill');
    expect(pill.textContent).toContain('canvasV2.hintReciteNav');
    expect(pill.textContent).toContain('canvasV2.hintReciteReveal');
    expect(pill.textContent).toContain('canvasV2.hintReciteExit');
  });
});
