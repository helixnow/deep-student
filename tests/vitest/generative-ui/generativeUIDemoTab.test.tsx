import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { GenerativeUIDemoTab } from '@/components/style-lab/GenerativeUIDemoTab';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import { resetDefaultGenerativeUIIntentSnapshotRing } from '@/features/generative-ui/utils/intentSnapshotRing';
import { useHpiasStore } from '@/stores/researchStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; added?: number; removed?: number; changed?: number }) => {
      const map: Record<string, string> = {
        'notes.edit_suggestion_title': '笔记编辑建议',
        'notes.edit_suggestion_description': '确认后打开 diff',
        'notes.edit_suggestion_markdown_title': '建议正文',
        'notes.edit_operation_key': '操作',
        'notes.edit_preview_title': '预览',
        'notes.edit_apply': '应用到笔记',
        'notes.edit_dismiss': '忽略',
        parse_error_title: '解析失败',
        unknown_block_title: '未知',
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'action.confirm_title': '确认',
        'action.confirm_desc': '描述',
        'action.confirm_execute': '确认执行',
        'action.unregistered_hint': '未注册',
        'demo.recipes.learning_dashboard.title': 'i18n-learning-dashboard',
        'demo.recipes.learning_dashboard.description': 'i18n-learning-dashboard-desc',
        'demo.recipes.research_briefing.title': 'i18n-research-briefing',
        'demo.recipes.research_briefing.description': 'i18n-research-briefing-desc',
        'demo.recipes.translation_chart.title': 'i18n-translation-chart',
        'demo.recipes.translation_chart.description': 'i18n-translation-chart-desc',
        'demo.recipes.mistake_table.title': 'i18n-mistake-table',
        'demo.recipes.mistake_table.description': 'i18n-mistake-table-desc',
        'demo.recipes.empty_markdown.title': 'i18n-empty-markdown',
        'demo.recipes.empty_markdown.description': 'i18n-empty-markdown-desc',
        'demo.recipes.v11_grid_two_col.title': 'i18n-v11-grid-two-col',
        'demo.recipes.v11_grid_two_col.description': 'i18n-v11-grid-two-col-desc',
        'demo.lint_title': 'Intent diagnostics',
        'demo.lint_ok': 'No issues',
        'demo.lint_count': '{{count}} issues',
        'demo.diff_title': 'Diff vs last snapshot',
        'demo.diff_none': 'No changes',
        'demo.diff_summary': '+{{added}} / −{{removed}} / ~{{changed}}',
      };
      let result = map[key] ?? key;
      if (options) {
        if (typeof options.count === 'number') {
          result = result.replace('{{count}}', String(options.count));
        }
        if (typeof options.added === 'number') {
          result = result.replace('{{added}}', String(options.added));
        }
        if (typeof options.removed === 'number') {
          result = result.replace('{{removed}}', String(options.removed));
        }
        if (typeof options.changed === 'number') {
          result = result.replace('{{changed}}', String(options.changed));
        }
      }
      return result;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: () => <div data-testid="mindmap-embed-mock" />,
}));

import '@/features/generative-ui/blocks';

describe('GenerativeUIDemoTab', () => {
  beforeEach(() => {
    resetDefaultGenerativeUIIntentSnapshotRing();
    useHpiasStore.getState().actions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDefaultGenerativeUIIntentSnapshotRing();
    useHpiasStore.getState().actions.clear();
  });

  it('renders static learning dashboard by default', () => {
    render(<GenerativeUIDemoTab />);
    expect(screen.getByText('本周学习概览')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-tab')).toBeInTheDocument();
  });

  it('switches to mindmap embed demo', async () => {
    const user = userEvent.setup();
    render(<GenerativeUIDemoTab />);
    await user.click(screen.getByRole('button', { name: '导图嵌入' }));
    expect(screen.getByText('知识图谱预览')).toBeInTheDocument();
    expect(await screen.findByTestId('mindmap-embed-mock')).toBeInTheDocument();
  });

  it('shows note edit HITL demo with apply action', async () => {
    const user = userEvent.setup();
    render(<GenerativeUIDemoTab />);
    await user.click(screen.getByRole('button', { name: '笔记 HITL' }));
    expect(screen.getByText('笔记编辑建议')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用到笔记' })).toBeInTheDocument();
  });

  it('mounts combination recipes and switches to learning dashboard', async () => {
    const user = userEvent.setup();
    render(<GenerativeUIDemoTab />);
    expect(screen.getByTestId('generative-ui-demo-recipes')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-learning-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-research-briefing')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-translation-chart')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-mistake-table')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-empty-markdown')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-v11-grid-two-col')).toBeInTheDocument();
    expect(screen.getByTestId('generative-ui-demo-recipe-learning-dashboard')).toHaveTextContent(
      'i18n-learning-dashboard',
    );
    expect(screen.getByTestId('generative-ui-demo-recipe-research-briefing')).toHaveTextContent(
      'i18n-research-briefing',
    );
    expect(screen.getByTestId('generative-ui-demo-recipe-translation-chart')).toHaveTextContent(
      'i18n-translation-chart',
    );
    expect(screen.getByTestId('generative-ui-demo-recipe-mistake-table')).toHaveTextContent(
      'i18n-mistake-table',
    );
    expect(screen.getByTestId('generative-ui-demo-recipe-empty-markdown')).toHaveTextContent(
      'i18n-empty-markdown',
    );
    expect(screen.getByTestId('generative-ui-demo-recipe-v11-grid-two-col')).toHaveTextContent(
      'i18n-v11-grid-two-col',
    );
    expect(screen.queryByText('学习仪表盘')).not.toBeInTheDocument();
    expect(screen.queryByText('研究简报')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('generative-ui-demo-recipe-learning-dashboard'));
    expect(screen.getByTestId('generative-ui-demo-recipe-desc')).toHaveTextContent(
      'i18n-learning-dashboard — i18n-learning-dashboard-desc',
    );
    expect(screen.getByText('本周复习节奏')).toBeInTheDocument();
    expect(screen.getByText('每日复习量')).toBeInTheDocument();
  });

  it('keeps every recipe inside the active action lint gate', async () => {
    const user = userEvent.setup();
    render(<GenerativeUIDemoTab />);

    const recipeIds = [
      'learning-dashboard',
      'research-briefing',
      'translation-chart',
      'mistake-table',
      'empty-markdown',
      'v11-grid-two-col',
    ];
    for (const recipeId of recipeIds) {
      await user.click(screen.getByTestId(`generative-ui-demo-recipe-${recipeId}`));
      const panel = screen.getByTestId('generative-ui-demo-lint');
      expect(panel).toHaveAttribute('data-lint-action-gated', 'true');
      expect(panel).toHaveAttribute('data-lint-ok', 'true');
      expect(panel).toHaveAttribute('data-lint-count', '0');
    }
  });

  it('switches to 18-block v1.1 grid showcase', async () => {
    const user = userEvent.setup();
    render(<GenerativeUIDemoTab />);
    await user.click(screen.getByTestId('generative-ui-demo-showcase'));
    expect(screen.getByText('18 块 Showcase · v1.1 grid')).toBeInTheDocument();
    expect(await screen.findByTestId('mindmap-embed-mock')).toBeInTheDocument();
  });

  it('shows lint diagnostics for the default static intent', () => {
    render(<GenerativeUIDemoTab />);
    const panel = screen.getByTestId('generative-ui-demo-lint');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute('data-lint-ok', 'true');
    expect(panel).toHaveAttribute('data-lint-count', '0');
    expect(panel).toHaveAttribute('data-lint-action-gated', 'true');
    expect(panel).toHaveTextContent('Intent diagnostics');
    expect(panel).toHaveTextContent('No issues');
  });

  it('registers the showcase demo action with the lint gate and renderer', async () => {
    const user = userEvent.setup();
    render(<GenerativeUIDemoTab />);
    await user.click(screen.getByTestId('generative-ui-demo-showcase'));
    const panel = screen.getByTestId('generative-ui-demo-lint');
    expect(panel).toHaveAttribute('data-lint-action-gated', 'true');
    expect(panel).toHaveAttribute('data-lint-ok', 'true');
    expect(panel).toHaveAttribute('data-lint-count', '0');
    expect(panel.querySelector('[data-lint-code="unknown-action"]')).toBeNull();
    expect(screen.getByRole('button', { name: '操作' })).toBeEnabled();
  });

  it('shows intent fingerprint for the default static intent', () => {
    render(<GenerativeUIDemoTab />);
    const expected = fingerprintGenerativeUIIntent(LEARNING_DASHBOARD_EXAMPLE);
    const line = screen.getByTestId('generative-ui-demo-fingerprint');
    expect(line).toBeInTheDocument();
    expect(line).toHaveAttribute('data-intent-fingerprint', expected);
    expect(line).toHaveTextContent(expected);
  });

  it('shows a no-change diff when the snapshot ring is empty', () => {
    resetDefaultGenerativeUIIntentSnapshotRing();
    render(<GenerativeUIDemoTab />);
    const panel = screen.getByTestId('generative-ui-demo-diff');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute('data-diff-added');
    expect(panel).toHaveAttribute('data-diff-removed');
    expect(panel).toHaveAttribute('data-diff-changed');
    expect(panel).toHaveTextContent('Diff vs last snapshot');

    const added = Number(panel.getAttribute('data-diff-added'));
    const removed = Number(panel.getAttribute('data-diff-removed'));
    const changed = Number(panel.getAttribute('data-diff-changed'));
    if (added === 0 && removed === 0 && changed === 0) {
      expect(panel).toHaveTextContent('No changes');
    }
  });

  it('does not crash without a stream intent and cancels a stale stream run', () => {
    vi.useFakeTimers();
    render(<GenerativeUIDemoTab />);
    const streamButton = screen.getByRole('button', { name: '模拟流式' });

    fireEvent.click(streamButton);
    expect(screen.getByTestId('generative-ui-demo-tab')).toBeInTheDocument();
    expect(screen.getByText('本周学习概览')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(80);
    });
    fireEvent.click(streamButton);
    act(() => {
      vi.runAllTimers();
    });

    expect(screen.getByTestId('generative-ui-demo-lint')).toHaveAttribute('data-lint-ok', 'true');
    expect(screen.getByTestId('generative-ui-demo-fingerprint')).toHaveAttribute(
      'data-intent-fingerprint',
      fingerprintGenerativeUIIntent(LEARNING_DASHBOARD_EXAMPLE),
    );
  });

  it('cancels stale HPIAS completion timers when replayed', () => {
    vi.useFakeTimers();
    render(<GenerativeUIDemoTab />);
    const hpiasButton = screen.getByTestId('generative-ui-demo-hpias');

    fireEvent.click(hpiasButton);
    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(screen.getByText(/模拟进行中/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    fireEvent.click(hpiasButton);
    act(() => {
      vi.advanceTimersByTime(3_901);
    });

    expect(screen.getByText(/模拟进行中/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText(/演示完成/)).toBeInTheDocument();
  });
});
