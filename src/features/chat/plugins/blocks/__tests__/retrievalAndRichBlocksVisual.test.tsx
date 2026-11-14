import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Block } from '../../../core/types/block';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@/components/ShadowDomPreview', () => ({
  ShadowDomPreview: ({ htmlContent }: { htmlContent?: string }) => (
    <div data-testid="mock-shadow-dom">{htmlContent}</div>
  ),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const { RagBlock } = await import('../rag');
const { MemoryBlock } = await import('../memory');
const { WebSearchBlock } = await import('../webSearch');
const { AcademicSearchBlock } = await import('../academicSearch');
const { MultimodalRagBlock } = await import('../multimodalRag');
const { InsightRecallBlock } = await import('../insightRecall');
const { SourceCard } = await import('../components/SourceCard');
const { ToolInputView } = await import('../components/ToolInputView');
const { ImageGenBlockComponent } = await import('../imageGen');
const { PaperSaveBlock } = await import('../paperSave');
const { TodoListBlock, TodoListPanel } = await import('../todoList');
const { TemplatePreviewBlock } = await import('../templatePreview');
const { TemplateToolOutput } = await import('../components/TemplateToolOutput');
const { ChatAnkiProgressCompact } = await import('../components/ChatAnkiProgressCompact');
const { QbankQuestionsBlock } = await import('../qbankQuestionsBlock');
const { AnkiCardsBlock } = await import('../ankiCardsBlock');
const { NoteToolPreview } = await import(
  '../../../components/ActivityTimeline/NoteToolPreview'
);
const { ShellCommandTimelineView } = await import(
  '../../../components/ActivityTimeline/ShellCommandTimelineView'
);

function makeBlock(
  type: Block['type'],
  patch: Partial<Block> = {},
): Block {
  return {
    id: `blk-${type}`,
    type,
    status: 'success',
    messageId: 'msg-1',
    startedAt: 1000,
    endedAt: 3500,
    ...patch,
  } as Block;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Retrieval blocks family modern shell alignment', () => {
  it.each([
    ['rag', RagBlock, { query: 'test query', sources: [{ title: 'Doc 1', snippet: 'Body' }] }],
    ['memory', MemoryBlock, { query: 'mem query', sources: [{ title: 'Mem 1', snippet: 'Note' }] }],
    ['web_search', WebSearchBlock, { query: 'web query', searchEngine: 'Tavily', sources: [{ title: 'Web 1', url: 'https://example.com' }] }],
    ['academic_search', AcademicSearchBlock, { source: 'arxiv', sources: [{ title: 'Paper 1', url: 'https://arxiv.org/abs/1' }] }],
    ['multimodal_rag', MultimodalRagBlock, { query: 'img query', sources: [{ title: 'Slide 1', snippet: 'Diagram' }] }],
    ['insight_recall', InsightRecallBlock, { sources: [{ title: 'Insight 1', snippet: 'Summary' }] }],
  ] as const)(
    '%s uses modern neutral running header without animate-spin and supports collapsing',
    (blockType, Component, toolOutput) => {
      const running = render(
        <Component
          block={makeBlock(blockType, {
            status: 'running',
            toolInput: { query: 'running query' },
            toolOutput: undefined,
            endedAt: undefined,
          })}
          isStreaming
        />,
      );
      const runningCard = running.container.firstElementChild as HTMLElement;
      expect(runningCard.className).toContain('bg-card');
      expect(runningCard.className).toContain('border-border/50');
      expect(running.container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
      expect(running.container.querySelector('.animate-spin')).toBeNull();
      expect(running.container.innerHTML).not.toContain('amber-500');
      expect(running.container.innerHTML).not.toContain('py-6');
      cleanup();

      const completed = render(
        <Component
          block={makeBlock(blockType, {
            status: 'success',
            toolInput: { query: 'done query' },
            toolOutput,
          })}
        />,
      );
      const toggleBtn = completed.container.querySelector('button[aria-expanded]') as HTMLButtonElement | null;
      expect(toggleBtn).not.toBeNull();
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');
      if (toggleBtn) {
        fireEvent.click(toggleBtn);
        expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
      }
      cleanup();

      const errored = render(
        <Component
          block={makeBlock(blockType, {
            status: 'error',
            error: 'Search failed',
            toolOutput: undefined,
          })}
        />,
      );
      const errorCard = errored.container.firstElementChild as HTMLElement;
      expect(errorCard.className).toContain('border-destructive/30');
    },
  );

  it('SourceCard uses rounded-lg and coordinated text-xs snippet', () => {
    const { container } = render(
      <SourceCard
        source={{
          id: 'src-1',
          type: 'web_search',
          title: 'Source Title',
          snippet: 'Concise snippet text',
          url: 'https://example.com',
        }}
      />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('rounded-lg');
    expect(card.className).not.toContain('rounded-xl');
    const snippet = screen.getByText('Concise snippet text');
    expect(snippet.className).toContain('text-xs');
  });
});

describe('ToolInputView semantic color tokens', () => {
  it('renders semantic colors without hardcoded purple/blue/green/amber classes', () => {
    const { container } = render(
      <ToolInputView
        input={{
          flag: true,
          count: 42,
          label: 'hello',
        }}
        collapsed={false}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain('text-info');
    expect(html).toContain('text-primary');
    expect(html).toContain('text-success');
    expect(html).toContain('text-warning');
    expect(html).not.toMatch(/text-(purple|blue|green|amber)-/);
  });
});

describe('ImageGen, PaperSave, TodoList, TemplatePreview & Rich Blocks alignment', () => {
  it('ImageGenBlockComponent replaces giant spinner with compact ToolActivitySweep skeleton and collapsible prompt', () => {
    const running = render(
      <ImageGenBlockComponent
        block={makeBlock('image_gen', {
          status: 'running',
          toolInput: { prompt: 'A quiet study desk' },
          endedAt: undefined,
        })}
        isStreaming
      />,
    );
    const htmlRunning = running.container.innerHTML;
    expect(htmlRunning).not.toContain('min-h-[200px]');
    expect(htmlRunning).not.toContain('animate-ping');
    expect(htmlRunning).not.toContain('animate-bounce');
    expect(running.container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    cleanup();

    const success = render(
      <ImageGenBlockComponent
        block={makeBlock('image_gen', {
          status: 'success',
          toolOutput: {
            prompt: 'A quiet study desk',
            imageUrl: 'https://example.com/img.png',
            width: 1024,
            height: 768,
            model: 'flux-pro',
            params: { steps: 20 },
          },
        })}
      />,
    );
    expect(success.container.innerHTML).toContain('tabular-nums');
    const promptToggle = success.container.querySelectorAll('button[aria-expanded]')[1] as HTMLButtonElement;
    expect(promptToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(promptToggle);
    expect(promptToggle.getAttribute('aria-expanded')).toBe('true');
    expect(success.getByText(/steps:/)).toBeInTheDocument();
  });

  it('PaperSaveBlock wraps preparing state in standard card shell without animate-spin', () => {
    const { container } = render(
      <PaperSaveBlock
        block={makeBlock('paper_save', {
          status: 'running',
          content: '',
          toolOutput: undefined,
          endedAt: undefined,
        })}
      />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('border-border/50');
    expect(container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('TodoListPanel & TodoListBlock remove legacy CSS vars, show tabular progress, and collapse completed/long lists', () => {
    const { container: panelContainer } = render(
      <TodoListPanel
        title="Study Plan"
        steps={[
          { id: '1', description: 'Step 1', status: 'completed', createdAt: 1 },
          { id: '2', description: 'Step 2', status: 'running', createdAt: 2 },
        ]}
        defaultExpanded
      />,
    );
    expect(panelContainer.innerHTML).not.toContain('--text-primary');
    expect(panelContainer.innerHTML).not.toContain('--text-muted');
    expect(panelContainer.innerHTML).not.toContain('--border-soft');
    expect(panelContainer.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByText('1/2')).toHaveClass('tabular-nums');
    cleanup();

    const longCompleted = render(
      <TodoListBlock
        block={makeBlock('todo_list', {
          toolOutput: {
            success: true,
            isAllDone: true,
            steps: [
              { id: '1', description: 'Done task', status: 'completed', createdAt: 1 },
            ],
          },
        })}
      />,
    );
    const headerBtn = longCompleted.container.querySelector('button[aria-expanded]');
    expect(headerBtn?.getAttribute('aria-expanded')).toBe('false');
  });

  it('TemplatePreviewBlock uses collapsible ToolHeader and TemplateToolOutput drops dark:bg-zinc-900', () => {
    const preview = render(
      <TemplatePreviewBlock
        block={makeBlock('template_preview', {
          status: 'running',
          endedAt: undefined,
        })}
        isStreaming
      />,
    );
    expect(preview.container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(preview.container.querySelector('.animate-spin')).toBeNull();
    cleanup();

    const output = render(
      <TemplateToolOutput
        output={{
          _templateVisual: true,
          name: 'Basic Card',
          frontTemplate: '{{Front}}',
          backTemplate: '{{Back}}',
        }}
      />,
    );
    expect(output.container.innerHTML).not.toContain('dark:bg-zinc-900');
    expect(output.container.innerHTML).toContain('bg-background');
  });

  it('ChatAnkiProgressCompact uses text-success-foreground, PulseDot, and rounded-md badges', () => {
    const { container } = render(
      <ChatAnkiProgressCompact
        progress={{
          stage: 'generating',
          percent: 50,
          route: 'direct',
        }}
        ankiConnect={{ available: true }}
        cardsCount={2}
        blockStatus="running"
      />,
    );
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.innerHTML).not.toContain('text-white');
    expect(container.innerHTML).toContain('text-success-foreground');
    const ankiConnectBadge = screen.getByTestId('chatanki-progress-anki-connect');
    expect(ankiConnectBadge.className).toContain('rounded-md');
  });

  it('QbankQuestionsBlock uses collapsible card, Radix Checkbox, and coarse pointer hit targets', () => {
    const { container } = render(
      <QbankQuestionsBlock
        block={makeBlock('qbank_questions', {
          status: 'success',
          toolOutput: {
            examId: 'exam-1',
            status: 'completed',
            drafts: [
              {
                local_id: 'q1',
                question_type: 'single_choice',
                content: 'What is 2+2?',
                options: [{ key: 'A', content: '4' }],
                answer: 'A',
                tags: ['math'],
              },
            ],
          },
        })}
      />,
    );
    const rootCard = container.firstElementChild as HTMLElement;
    expect(rootCard.className).toContain('bg-card');
    expect(rootCard.className).toContain('border-border/50');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector('[role="checkbox"]')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.innerHTML).toContain('[@media(pointer:coarse)]:!min-h-11');
  });

  it('AnkiCardsBlock aligns expanded header scale to text-xs and removes spin icons', () => {
    const { container } = render(
      <AnkiCardsBlock
        block={makeBlock('anki_cards', {
          status: 'success',
          toolOutput: {
            cards: [
              { id: 'c1', front: 'Front', back: 'Back', tags: ['tag1'] },
            ],
          },
        })}
      />,
    );
    expect(container.querySelector('.animate-spin')).toBeNull();
    const expandTrigger = container.querySelector('[role="button"], button') as HTMLElement | null;
    expect(expandTrigger).not.toBeNull();
    if (expandTrigger) {
      fireEvent.click(expandTrigger);
    }
    const headerTitle = container.querySelector('span.text-xs.font-medium.text-muted-foreground');
    expect(headerTitle).not.toBeNull();
  });

  it('NoteToolPreview preserves rounded bottom corners when collapsed and ShellCommandTimelineView removes animate-spin', () => {
    const note = render(
      <NoteToolPreview
        toolName="note_append"
        status="success"
        durationMs={1200}
        output={{ success: true, afterPreview: 'Updated line' }}
      />,
    );
    const headerBtn = note.container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(headerBtn.getAttribute('aria-expanded')).toBe('false');
    expect(headerBtn.className).toContain('!rounded-lg');
    expect(headerBtn.className).not.toContain('!rounded-b-none');
    expect(note.container.querySelector('.animate-spin')).toBeNull();
    cleanup();

    const shell = render(
      <ShellCommandTimelineView
        toolName="shell_execute"
        toolStatus="running"
        isRunning
        toolInput={{ command: 'echo hi' }}
      />,
    );
    expect(shell.container.querySelector('.animate-spin')).toBeNull();
  });
});
