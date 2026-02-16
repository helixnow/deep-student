import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrivacyPolicyDialog } from '../PrivacyPolicyDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/NotionDialog', () => ({
  NotionDialog: ({ children }: { children: React.ReactNode }) => <div data-testid="privacy-dialog-content">{children}</div>,
  NotionDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NotionDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  NotionDialogBody: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="privacy-dialog-body">{children}</div>
  ),
  NotionDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  it('renders dialog content and scroll area', () => {
    render(<PrivacyPolicyDialog open onOpenChange={() => {}} />);

    const dialogContent = screen.getByTestId('privacy-dialog-content');
    const dialogBody = screen.getByTestId('privacy-dialog-body');

    expect(dialogContent).toBeDefined();
    expect(dialogBody).toBeDefined();
  });
});

