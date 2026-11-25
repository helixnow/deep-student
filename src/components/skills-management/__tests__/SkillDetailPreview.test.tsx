import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@/features/chat/skills/types';

const mockState = vi.hoisted(() => ({
  items: [] as SkillDefinition[],
  reloadSkills: vi.fn(),
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
        if (opts && typeof opts.defaultValue === 'string') {
          if (key.startsWith('skills:builtin')) return opts.defaultValue;
          if (key === 'common:actions.edit') return opts.defaultValue;
          return opts.defaultValue;
        }
        return key;
      },
    }),
  };
});

vi.mock('@/features/chat/skills', () => ({
  skillRegistry: {
    get: (id: string) => mockState.items.find((s) => s.id === id),
    getAll: () => mockState.items,
  },
  subscribeToSkillRegistry: () => () => undefined,
  reloadSkills: (...args: unknown[]) => mockState.reloadSkills(...args),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  serializeSkillToMarkdown: (_meta: unknown, body: string) => body,
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
  setSkillDisabled: vi.fn(),
}));

vi.mock('@/features/chat/skills/skillTrustStorage', () => ({
  SKILL_TRUST_CHANGED_EVENT: 'SKILL_TRUST_CHANGED',
  resolveEffectiveTrustStatus: () => 'trusted',
  setSkillTrustOverride: vi.fn(async () => undefined),
}));

import { SkillsManagementPage } from '../SkillsManagementPage';

describe('S4-06 SkillsManagementPage read-only SkillDetailPreview', () => {
  const sampleSkill: SkillDefinition = {
    id: 'feynman-tutor',
    name: '费曼学习法导师',
    description: '通过简化讲解与追问帮助学生检查知识盲区',
    version: '1.2.0',
    author: 'Deep Student',
    location: 'global',
    packageSource: 'global',
    sourcePath: '/Users/demo/.deep-student/skills/feynman-tutor/SKILL.md',
    packageRoot: '/Users/demo/.deep-student/skills/feynman-tutor',
    isBuiltin: false,
    disableAutoInvoke: false,
    argumentHint: '[topic]',
    allowedTools: ['builtin-note_read', 'builtin-rag_search'],
    dependencies: ['knowledge-retrieval'],
    content: '# 费曼学习法指令\n1. 先请学生用大白话复述概念\n2. 针对模糊点提出反问',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.items = [sampleSkill];
    mockState.reloadSkills.mockResolvedValue({
      total: 1,
      builtin: 0,
      global: 1,
      project: 0,
      errors: 0,
    });
  });

  it('opens a strictly read-only detail preview on card click and enters edit mode only when clicking the explicit Edit button', async () => {
    render(<SkillsManagementPage />);
    await waitFor(() => expect(screen.getByText('费曼学习法导师')).toBeTruthy());

    // Clicking the skill card opens the read-only detail preview (NOT the writable editor)
    fireEvent.click(screen.getByRole('button', { name: '费曼学习法导师' }));

    const preview = await screen.findByTestId('skill-detail-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.queryByTestId('skill-content-textarea')).toBeNull();

    // Strictly read-only: no editable text inputs or textareas inside preview
    expect(preview.querySelectorAll('input, textarea, [contenteditable="true"]')).toHaveLength(0);

    // Displays name, description, trigger, permissions/source, and body instructions
    expect(screen.getByTestId('skill-detail-name')).toHaveTextContent('费曼学习法导师');
    expect(screen.getByTestId('skill-detail-description')).toHaveTextContent(
      '通过简化讲解与追问帮助学生检查知识盲区',
    );
    expect(screen.getByTestId('skill-detail-trigger')).toHaveTextContent('/feynman-tutor [topic]');
    expect(screen.getByTestId('skill-detail-trigger')).toHaveTextContent('knowledge-retrieval');
    expect(screen.getByTestId('skill-detail-permissions')).toHaveTextContent('builtin-note_read');
    expect(screen.getByTestId('skill-detail-body')).toHaveTextContent('先请学生用大白话复述概念');

    // Clicking the explicit "编辑" button transitions cleanly into the writable editor
    const editBtn = screen.getByTestId('skill-detail-edit-button');
    expect(editBtn).toHaveTextContent('编辑');
    fireEvent.click(editBtn);

    expect(screen.queryByTestId('skill-detail-preview')).toBeNull();
    expect(await screen.findByTestId('skill-content-textarea')).toBeInTheDocument();
  });

  it('closes the read-only preview on Escape or Close button click without opening the editor', async () => {
    render(<SkillsManagementPage />);
    await waitFor(() => expect(screen.getByText('费曼学习法导师')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '费曼学习法导师' }));
    expect(await screen.findByTestId('skill-detail-preview')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('skill-detail-preview')).toBeNull();
    expect(screen.queryByTestId('skill-content-textarea')).toBeNull();

    // Re-open and close via close button
    fireEvent.click(screen.getByRole('button', { name: '费曼学习法导师' }));
    expect(await screen.findByTestId('skill-detail-preview')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('skill-detail-close-button'));
    expect(screen.queryByTestId('skill-detail-preview')).toBeNull();
  });

  it('hides the Edit button in SkillDetailPreview for read-only plugin:// declarative skills', async () => {
    mockState.items = [
      {
        ...sampleSkill,
        id: 'dspack-study-rubric',
        name: 'Declarative Pack Skill',
        sourcePath: 'plugin://demo.pack/skills/rubric/SKILL.md',
        packageRoot: 'plugin://demo.pack/skills/rubric',
      },
    ];

    render(<SkillsManagementPage />);
    await waitFor(() => expect(screen.getByText('Declarative Pack Skill')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Declarative Pack Skill' }));
    expect(await screen.findByTestId('skill-detail-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-detail-edit-button')).toBeNull();
  });
});
