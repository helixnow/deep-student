import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrivacyPolicyDialog } from '../PrivacyPolicyDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/shad/Dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ className, children }: { className?: string; children: React.ReactNode }) => (
    <div data-testid="privacy-dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({
    className,
    viewportClassName,
    children,
  }: {
    className?: string;
    viewportClassName?: string;
    children: React.ReactNode;
  }) => (
    <div
      data-testid="privacy-scroll-area"
      className={className}
      data-viewport-class={viewportClassName}
    >
      {children}
    </div>
  ),
}));

describe('PrivacyPolicyDialog', () => {
  it('uses bounded dialog height and native custom scroll area layout contract', () => {
    render(<PrivacyPolicyDialog open onOpenChange={() => {}} />);

    const dialogContent = screen.getByTestId('privacy-dialog-content');
    const scrollArea = screen.getByTestId('privacy-scroll-area');

    expect(dialogContent.className).toContain('h-[80vh]');
    expect(dialogContent.className).toContain('max-h-[80vh]');
    expect(scrollArea.className).toContain('flex-1');
    expect(scrollArea.className).toContain('min-h-0');
    expect(scrollArea).toHaveAttribute('data-viewport-class', 'px-6 pb-6');
  });
});

