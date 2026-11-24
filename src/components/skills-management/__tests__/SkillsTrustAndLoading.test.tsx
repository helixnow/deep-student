import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setSkillTrustOverrideMock = vi.fn();
const resolveEffectiveTrustStatusMock = vi.fn();
const isSkillDisabledMock = vi.fn();

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && typeof opts.defaultValue === 'string' && key === '__missing__') {
          return opts.defaultValue;
        }
        if (opts && typeof opts.error === 'string') {
          return `${key}:${opts.error}`;
        }
        return key;
      },
    }),
  };
});

vi.mock('@/features/chat/skills/skillTrustStorage', () => ({
  resolveEffectiveTrustStatus: (...args: unknown[]) => resolveEffectiveTrustStatusMock(...args),
  setSkillTrustOverride: (...args: unknown[]) => setSkillTrustOverrideMock(...args),
}));

vi.mock('@/features/chat/skills/skillEnableStorage', () => ({
  SKILL_ENABLED_CHANGED_EVENT: 'skill-enabled-changed',
  isSkillDisabled: (...args: unknown[]) => isSkillDisabledMock(...args),
  isSkillUserEnabled: vi.fn(() => false),
  getSkillEnableState: vi.fn(() => 'default'),
}));

vi.mock('@/features/chat/skills/packageMetadata', () => ({
  getSkillEmbeddedToolLabels: vi.fn(() => []),
  getSkillPermissionSummary: vi.fn(() => ({ labelKey: null, detail: null })),
}));

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { SkillPackageSummary } from '../SkillPackageSummary';
import { SkillsList } from '../SkillsList';
import type { SkillDefinition } from '@/features/chat/skills/types';

function makeCustomSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'custom-demo-skill',
    name: 'Custom Demo Skill',
    description: 'Custom test skill',
    content: '# Demo',
    source: 'user',
    sourcePath: '/Users/demo/.deepstudent/skills/custom-demo-skill/SKILL.md',
    packageRoot: '/Users/demo/.deepstudent/skills/custom-demo-skill',
    trust: 'untrusted',
    ...overrides,
  } as SkillDefinition;
}

describe('S4-06 skills trust status, notifications, and loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEffectiveTrustStatusMock.mockReturnValue('untrusted');
    isSkillDisabledMock.mockReturnValue(false);
  });

  it('shows trust_pending_injection when a skill is enabled but still untrusted', () => {
    render(<SkillPackageSummary skill={makeCustomSkill()} variant="card" />);
    expect(screen.getByText('skills:package.trust_pending_injection')).toBeTruthy();
  });

  it('notifies the user with error toast when trusting a skill fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSkillTrustOverrideMock.mockRejectedValueOnce(new Error('Path traversal detected'));

    render(<SkillPackageSummary skill={makeCustomSkill()} variant="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'skills:package.trust_enable' }));

    await waitFor(() => {
      expect(showGlobalNotification).toHaveBeenCalledWith(
        'error',
        'skills:package.trust_failed:Path traversal detected',
      );
    });
    consoleErrorSpy.mockRestore();
  });

  it('notifies the user with success toast when trusting a skill succeeds', async () => {
    const onTrustChanged = vi.fn();
    setSkillTrustOverrideMock.mockResolvedValueOnce(undefined);

    const skill = makeCustomSkill();
    render(<SkillPackageSummary skill={skill} variant="editor" onTrustChanged={onTrustChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'skills:package.trust_enable' }));

    await waitFor(() => {
      expect(setSkillTrustOverrideMock).toHaveBeenCalledWith('custom-demo-skill', 'trusted', skill);
      expect(onTrustChanged).toHaveBeenCalledTimes(1);
      expect(showGlobalNotification).toHaveBeenCalledWith('success', 'skills:package.trust_success');
    });
  });

  it('renders loading indicator in SkillsList when isLoading is true instead of empty state', () => {
    render(
      <SkillsList
        skills={[]}
        isLoading={true}
        selectedSkillId={null}
        onSelectSkill={vi.fn()}
        defaultSkillIds={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleDefault={vi.fn()}
      />,
    );

    expect(screen.getByTestId('skills-list-loading')).toBeTruthy();
    expect(screen.queryByText('skills:management.empty')).toBeNull();
  });

  it('uses set_default label on top-right default toggle without changing aria-label', () => {
    render(
      <SkillsList
        skills={[makeCustomSkill({ isBuiltin: true, source: 'builtin' })]}
        isLoading={false}
        selectedSkillId={null}
        onSelectSkill={vi.fn()}
        defaultSkillIds={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleDefault={vi.fn()}
      />,
    );

    expect(screen.getByText('skills:management.set_default')).toBeTruthy();
  });

  it('defines non-empty selector.loading keys in both zh-CN and en-US skills locales', async () => {
    const zhSkills = await import('@/locales/zh-CN/skills.json');
    const enSkills = await import('@/locales/en-US/skills.json');
    expect(typeof zhSkills.selector?.loading).toBe('string');
    expect(zhSkills.selector?.loading?.trim().length).toBeGreaterThan(0);
    expect(typeof enSkills.selector?.loading).toBe('string');
    expect(enSkills.selector?.loading?.trim().length).toBeGreaterThan(0);
    expect(zhSkills.selector?.loading).not.toBe('selector.loading');
    expect(enSkills.selector?.loading).not.toBe('selector.loading');
  });
});
