/**
 * 技能管理学习优先分层（学习精选 / 全部技能 / 系统与扩展）单元测试
 */
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSkillsStore = vi.hoisted(() => ({
  items: [] as Array<{
    id: string;
    name: string;
    description: string;
    location: 'builtin' | 'global' | 'project';
    isBuiltin: boolean;
    priority?: number;
  }>,
}));

const mockTranslate = vi.hoisted(() =>
  vi.fn((key: string, opts?: Record<string, unknown>) => {
    if (opts && 'count' in opts) return `${key}:${String(opts.count)}`;
    return key;
  }),
);

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mockTranslate }),
}));

vi.mock('@/features/chat', () => ({
  skillRegistry: {
    get: (id: string) => mockSkillsStore.items.find((item) => item.id === id),
    getAll: () => mockSkillsStore.items,
  },
  useSkillList: () => ({
    skills: mockSkillsStore.items,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/components/skills-management', () => ({
  SkillsList: ({ skills }: { skills: Array<{ id: string; name: string }> }) => (
    <div className="grid" data-testid="mock-base-skills-list">
      {skills.map((s) => (
        <div key={s.id} data-agent-entity={`skills:${s.id}`}>
          {s.name}
        </div>
      ))}
    </div>
  ),
  SkillsManagementPage: () => {
    const [query, setQuery] = useState('');
    const filtered = mockSkillsStore.items.filter(
      (s) =>
        !query ||
        s.id.toLowerCase().includes(query.toLowerCase()) ||
        s.name.toLowerCase().includes(query.toLowerCase()),
    );
    return (
      <div className="study-shell-page">
        <div className="study-shell-toolbar">
          <input
            aria-label="search-skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="px-5 pt-5">
          <div className="grid">
            {filtered.map((s) => (
              <div key={s.id} data-agent-entity={`skills:${s.id}`}>
                {s.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  },
  SkillsSidebar: () => null,
  SkillEditorModal: () => null,
  SkillDeleteConfirm: () => null,
}));

import {
  SkillsList,
  SkillsManagementPage,
  classifySkillAudience,
  sortSkillsForLearner,
} from '@/features/skills-management';
import type { SkillDefinition } from '@/features/chat';

function makeSkill(
  id: string,
  name: string,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    id,
    name,
    description: `${name} description`,
    content: '# Skill',
    filePath: `/builtin/${id}/SKILL.md`,
    location: 'builtin',
    isBuiltin: true,
    priority: 5,
    ...overrides,
  } as SkillDefinition;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSkillsStore.items = [
    makeSkill('ptc-run', 'Scripted Tool Composition', { priority: 1 }),
    makeSkill('role-packs', 'Featured Role Experts', { priority: 1 }),
    makeSkill('chatanki', 'ChatAnki', { priority: 4 }),
    makeSkill('tutor-mode', 'Tutor Mode', { priority: 3 }),
    makeSkill('exam-analysis', 'Exam Analysis', { priority: 5 }),
    makeSkill('docx-tools', 'Word Document Tools', { priority: 2 }),
  ];
});

describe('skillCategories 学习优先分类与排序', () => {
  it('准确区分学生主场景学习技能与系统/办公/职场扩展技能', () => {
    expect(classifySkillAudience({ id: 'tutor-mode' })).toBe('learning');
    expect(classifySkillAudience({ id: 'chatanki' })).toBe('learning');
    expect(classifySkillAudience({ id: 'qbank-tools' })).toBe('learning');
    expect(classifySkillAudience({ id: 'literature-review' })).toBe('learning');
    expect(classifySkillAudience({ id: 'review-planning' })).toBe('learning');

    expect(classifySkillAudience({ id: 'ptc-run' })).toBe('system');
    expect(classifySkillAudience({ id: 'role-packs' })).toBe('system');
    expect(classifySkillAudience({ id: 'docx-tools' })).toBe('system');
    expect(classifySkillAudience({ id: 'connector-tools' })).toBe('system');

    // 用户自建学科技能默认归入学习精选；自建财务/运维工作流归入系统扩展
    expect(
      classifySkillAudience({
        id: 'organic-chemistry-helper',
        name: '有机化学机理推导',
        location: 'global',
        isBuiltin: false,
      }),
    ).toBe('learning');
    expect(
      classifySkillAudience({
        id: 'corp-finance-audit',
        name: '企业财务审计台账',
        location: 'global',
        isBuiltin: false,
      }),
    ).toBe('system');
  });

  it('sortSkillsForLearner 将学习技能排在系统扩展之前，不受底层工具高 priority 抢占', () => {
    const sorted = sortSkillsForLearner(mockSkillsStore.items);
    const ids = sorted.map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(['tutor-mode', 'exam-analysis', 'chatanki']);
    expect(ids.slice(3)).toEqual(
      expect.arrayContaining(['ptc-run', 'role-packs', 'docx-tools']),
    );
  });

  it('SkillsList 支持按 audienceCategory 过滤并保持学习优先排序', () => {
    const noop = vi.fn();
    const { rerender } = render(
      <SkillsList
        skills={mockSkillsStore.items as unknown as SkillDefinition[]}
        defaultSkillIds={[]}
        onEdit={noop}
        onDelete={noop}
        onToggleDefault={noop}
        audienceCategory="learning"
      />,
    );

    const learningList = screen.getByTestId('mock-base-skills-list');
    expect(within(learningList).getByText('Tutor Mode')).toBeInTheDocument();
    expect(within(learningList).getByText('ChatAnki')).toBeInTheDocument();
    expect(
      within(learningList).queryByText('Scripted Tool Composition'),
    ).not.toBeInTheDocument();

    rerender(
      <SkillsList
        skills={mockSkillsStore.items as unknown as SkillDefinition[]}
        defaultSkillIds={[]}
        onEdit={noop}
        onDelete={noop}
        onToggleDefault={noop}
        audienceCategory="system"
      />,
    );
    expect(
      within(learningList).getByText('Scripted Tool Composition'),
    ).toBeInTheDocument();
    expect(within(learningList).queryByText('Tutor Mode')).not.toBeInTheDocument();
  });
});

describe('SkillsManagementPage 分类筛选交互', () => {
  it('默认激活「学习精选」隐藏底层/职场技能，可切换至「系统与扩展」和「全部技能」', async () => {
    const user = userEvent.setup();
    const { container } = render(<SkillsManagementPage />);

    await waitFor(() => {
      expect(screen.getByTestId('skills-audience-filter-bar')).toBeInTheDocument();
    });

    // 计数徽标：3 个学习技能、3 个系统扩展、共 6 个
    expect(screen.getByTestId('skills-count-learning')).toHaveTextContent('3');
    expect(screen.getByTestId('skills-count-all')).toHaveTextContent('6');
    expect(screen.getByTestId('skills-count-system')).toHaveTextContent('3');

    const tutorCard = container.querySelector<HTMLElement>(
      '[data-agent-entity="skills:tutor-mode"]',
    )!;
    const ptcCard = container.querySelector<HTMLElement>(
      '[data-agent-entity="skills:ptc-run"]',
    )!;
    const rolePacksCard = container.querySelector<HTMLElement>(
      '[data-agent-entity="skills:role-packs"]',
    )!;

    // 默认「学习精选」：学习卡片可见，ptc-run 与 role-packs 隐藏
    expect(tutorCard.hidden).toBe(false);
    expect(ptcCard.hidden).toBe(true);
    expect(rolePacksCard.hidden).toBe(true);

    // 切换到「系统与扩展」
    await user.click(screen.getByText('skills:management.categories.system'));
    expect(tutorCard.hidden).toBe(true);
    expect(ptcCard.hidden).toBe(false);
    expect(rolePacksCard.hidden).toBe(false);

    // 切换到「全部技能」：全部可见，且学习卡片 CSS order 小于系统工具卡片
    await user.click(screen.getByText('skills:management.categories.all'));
    expect(tutorCard.hidden).toBe(false);
    expect(ptcCard.hidden).toBe(false);
    expect(Number(tutorCard.style.order)).toBeLessThan(Number(ptcCard.style.order));
  });

  it('在「学习精选」下搜索系统工具时展示跨分类提示，支持一键切换查看全部匹配项', async () => {
    const user = userEvent.setup();
    const { container } = render(<SkillsManagementPage />);

    await waitFor(() => {
      expect(screen.getByTestId('skills-audience-filter-bar')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('search-skills'), 'ptc-run');

    await waitFor(() => {
      expect(screen.getByTestId('skills-hidden-in-other-category')).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole('button', {
        name: 'skills:management.categories.switch_to_all',
      }),
    );

    const ptcCard = container.querySelector<HTMLElement>(
      '[data-agent-entity="skills:ptc-run"]',
    )!;
    expect(ptcCard.hidden).toBe(false);
  });
});
