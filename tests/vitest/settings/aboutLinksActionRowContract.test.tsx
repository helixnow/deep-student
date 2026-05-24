import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/hooks/useAppUpdater', () => ({
  getNoRemind: () => false,
  getUpdateChannel: () => 'stable',
  getUpdateFrequency: () => 'never',
  getUpdateFrequencyDays: () => 7,
  setNoRemind: vi.fn(),
  setUpdateChannel: vi.fn(),
  setUpdateFrequency: vi.fn(),
  setUpdateFrequencyDays: vi.fn(),
  useAppUpdater: () => ({
    available: false,
    checking: false,
    checkForUpdate: vi.fn(),
    downloading: false,
    downloadAndInstall: vi.fn(),
    error: null,
    info: null,
    isMobile: false,
    progress: 0,
    upToDate: false,
  }),
}));

vi.mock('@/version', () => ({
  default: {
    FULL_VERSION: '0.0.0-test',
    GIT_HASH: 'test',
  },
}));

vi.mock('@/features/settings/components/OpenSourceAcknowledgementsSection', () => ({
  OpenSourceAcknowledgementsSection: () => <section data-testid="acknowledgements" />,
}));

vi.mock('@/components/legal/PrivacyPolicyDialog', () => ({
  PrivacyPolicyDialog: () => <div data-testid="privacy-dialog" />,
}));

vi.mock('@/components/ui/DeepStudentLogo', () => ({
  DeepStudentLogo: () => <div data-testid="deepstudent-logo" />,
}));

vi.mock('@/components/ui/SiliconFlowLogo', () => ({
  SiliconFlowLogo: () => <div data-testid="siliconflow-logo" />,
}));

import { AboutTab } from '@/features/settings';

const actionRowLabels = ['访问官网', 'GitHub', 'Issue 反馈', '查看隐私政策'] as const;

describe('AboutTab official link action rows', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/features/settings/components/AboutTab.tsx'), 'utf-8');

  it('uses one shared hover/focus contract for external links and the privacy action', () => {
    render(<AboutTab />);

    const rows = actionRowLabels.map((label) => {
      const labelNode = screen.getByText(label);
      const row = labelNode.closest('[data-about-action-row]');
      expect(row, `${label} should render inside a governed action row`).not.toBeNull();
      return row as HTMLElement;
    });

    const [firstRow, ...otherRows] = rows;
    otherRows.forEach((row) => {
      expect(row.className).toBe(firstRow.className);
    });

    expect(firstRow.className).toContain('hover:bg-[color:var(--sidebar-quiet-hover)]');
    expect(firstRow.className).toContain('rounded-[var(--button-radius)]');
    expect(firstRow.className).toContain('focus-visible:ring-[color:var(--ring)]');
    rows.forEach((row) => {
    expect(row.outerHTML).not.toContain('group-hover:text-primary');
    });
  });

  it('keeps the partner thanks card and open source acknowledgements surface visible', () => {
    render(<AboutTab />);

    expect(screen.getByText('技术合作伙伴致谢')).toBeInTheDocument();
    expect(screen.getByText('SiliconFlow')).toBeInTheDocument();
    expect(screen.getByTestId('siliconflow-logo')).toBeInTheDocument();
    expect(screen.getByTestId('acknowledgements')).toBeInTheDocument();
  });

  it('uses the Phosphor shield icon for the privacy policy action', () => {
    expect(source).toContain("import { Shield as PhosphorShield } from '@phosphor-icons/react';");
    expect(source).toContain('icon={PhosphorShield}');
    expect(source).not.toMatch(/import\s*\{[^}]*\bShield\b[^}]*\}\s*from 'lucide-react';/);
  });
});
