import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  const source = readFileSync(resolve(process.cwd(), 'src/components/legal/PrivacyPolicyDialog.tsx'), 'utf-8');

  it('renders dialog content and scroll area', () => {
    render(<PrivacyPolicyDialog open onOpenChange={() => {}} />);

    const dialogContent = screen.getByTestId('privacy-dialog-content');
    const dialogBody = screen.getByTestId('privacy-dialog-body');

    expect(dialogContent).toBeDefined();
    expect(dialogBody).toBeDefined();
  });

  it('uses Phosphor icons for privacy policy section markers', () => {
    expect(source).toContain("} from '@phosphor-icons/react';");
    expect(source).toContain('PaperPlaneTilt');
    expect(source).toContain('UserMinus');
    expect(source).toContain('ArrowsClockwise');
    expect(source).toContain('weight="regular"');
    expect(source).not.toContain("from 'lucide-react'");
  });
});
