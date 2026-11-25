import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@/features/chat/skills/types';

const mockSkills = vi.hoisted(() => ({
  items: [] as SkillDefinition[],
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  reloadSkills: vi.fn(),
  setSkillDisabled: vi.fn(),
  setSkillTrustOverride: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/app/shell/DesktopShellHeaderPortal', () => ({
  useDesktopShellHeaderPortal: () => null,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (key.startsWith('skills:builtin') && opts && typeof opts.defaultValue === 'string') {
          return opts.defaultValue;
        }
        if (opts && typeof opts.name === 'string') return `${key}:${opts.name}`;
        if (opts && 'count' in opts) return `${key}:${String(opts.count)}`;
        return key;
      },
    }),
  };
});

vi.mock('@/features/chat/skills', () => ({
  skillRegistry: {
    get: (id: string) => mockSkills.items.find((s) => s.id === id),
    getAll: () => mockSkills.items,
  },
  subscribeToSkillRegistry: () => () => undefined,
  reloadSkills: (...args: unknown[]) => mockSkills.reloadSkills(...args),
  createSkill: (...args: unknown[]) => mockSkills.createSkill(...args),
  updateSkill: (...args: unknown[]) => mockSkills.updateSkill(...args),
  deleteSkill: (...args: unknown[]) => mockSkills.deleteSkill(...args),
  serializeSkillToMarkdown: (_meta: unknown, body: string) => `---\nname: demo\n---\n${body}`,
  saveBuiltinSkillCustomization: vi.fn(async () => undefined),
  resetBuiltinSkillCustomization: vi.fn(async () => undefined),
  parseSkillFile: vi.fn(),
  useSkillDefaults: () => ({ defaultIds: [], toggleDefault: vi.fn() }),
  extractCustomizationFromSkill: vi.fn(),
  getSkillPackageRoot: (sourcePath: string) => sourcePath.replace(/[\\/]SKILL\.md$/i, ''),
}));

vi.mock('@/features/chat/skills/skillEnableStorage', () => ({
  SKILL_ENABLED_CHANGED_EVENT: 'SKILL_ENABLED_CHANGED',
  isSkillDisabled: () => false,
  setSkillDisabled: (...args: unknown[]) => mockSkills.setSkillDisabled(...args),
}));

vi.mock('@/features/chat/skills/skillTrustStorage', () => ({
  SKILL_TRUST_CHANGED_EVENT: 'SKILL_TRUST_CHANGED',
  resolveEffectiveTrustStatus: () => 'trusted',
  setSkillTrustOverride: (...args: unknown[]) => mockSkills.setSkillTrustOverride(...args),
}));

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { SkillsManagementPage } from '../SkillsManagementPage';

describe('S4-06 SkillsManagementPage save-to-take-effect & editor delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSkills.items = [];
    mockSkills.reloadSkills.mockResolvedValue({ total: 1, builtin: 0, global: 1, project: 0, errors: 0 });
    mockSkills.setSkillTrustOverride.mockResolvedValue({ skill_id: 'my-study-skill', trusted: true, package_sha256: 'abc' });
  });

  it('auto-enables and auto-trusts a newly created custom skill on save with a single success toast', async () => {
    mockSkills.createSkill.mockImplementationOnce(async () => {
      const createdSkill: SkillDefinition = {
        id: 'my-study-skill',
        name: 'My Study Skill',
        description: 'Helps summarize lecture handouts clearly',
        content: '# Instructions',
        location: 'global',
        sourcePath: '/Users/demo/.deep-student/skills/my-study-skill/SKILL.md',
        packageRoot: '/Users/demo/.deep-student/skills/my-study-skill',
        isBuiltin: false,
      };
      mockSkills.items = [createdSkill];
      return { content: '# Instructions', path: createdSkill.sourcePath };
    });

    render(<SkillsManagementPage />);
    await waitFor(() => expect(mockSkills.reloadSkills).toHaveBeenCalled());

    fireEvent.click(screen.getByText('skills:management.create'));

    fireEvent.change(screen.getByPlaceholderText('skills:editor.id_placeholder'), {
      target: { value: 'my-study-skill' },
    });
    fireEvent.change(screen.getByPlaceholderText('skills:editor.name_placeholder'), {
      target: { value: 'My Study Skill' },
    });
    fireEvent.change(screen.getByPlaceholderText('skills:editor.description_placeholder'), {
      target: { value: 'Helps summarize lecture handouts clearly' },
    });
    fireEvent.change(screen.getByTestId('skill-content-textarea'), {
      target: { value: '# Study workflow' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }));

    await waitFor(() => {
      expect(mockSkills.createSkill).toHaveBeenCalledTimes(1);
      expect(mockSkills.setSkillDisabled).toHaveBeenCalledWith('my-study-skill', false);
      expect(mockSkills.setSkillTrustOverride).toHaveBeenCalledWith(
        'my-study-skill',
        'trusted',
        expect.objectContaining({ id: 'my-study-skill' }),
      );
      expect(showGlobalNotification).toHaveBeenCalledTimes(1);
      expect(showGlobalNotification).toHaveBeenCalledWith('success', 'skills:management.create_success');
    });
  });

  it('deletes an existing custom skill from the fullscreen editor after inline confirmation', async () => {
    const existing: SkillDefinition = {
      id: 'custom-to-remove',
      name: 'Custom To Remove',
      description: 'Temporary custom skill',
      content: '# Temp',
      location: 'global',
      sourcePath: '/Users/demo/.deep-student/skills/custom-to-remove/SKILL.md',
      packageRoot: '/Users/demo/.deep-student/skills/custom-to-remove',
      isBuiltin: false,
    };
    mockSkills.items = [existing];
    mockSkills.deleteSkill.mockResolvedValueOnce(undefined);

    render(<SkillsManagementPage />);
    await waitFor(() => expect(screen.getByText('Custom To Remove')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('common:actions.edit'));
    const editorDeleteBtn = await screen.findByTestId('skill-editor-delete');
    fireEvent.click(editorDeleteBtn);

    expect(mockSkills.deleteSkill).not.toHaveBeenCalled();
    expect(screen.getByText('skills:management.delete_confirm:Custom To Remove')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.delete' }));

    await waitFor(() => {
      expect(mockSkills.deleteSkill).toHaveBeenCalledWith('/Users/demo/.deep-student/skills/custom-to-remove');
      expect(showGlobalNotification).toHaveBeenCalledWith('success', 'skills:management.delete_success');
    });
  });
});
