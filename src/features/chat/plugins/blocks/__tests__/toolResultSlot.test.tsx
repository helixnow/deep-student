import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { ChatToolResultContribution, ChatToolResultProps } from '@/ui-kernel/contracts/chat';
import { McpToolBlockComponent } from '../mcpTool';
import { findToolResult, qualifiedToolBaseName, resolveToolResult } from '../toolResultSlot';
import { officialToolResultEntries } from '../toolResults';

afterEach(() => cleanup());

const success = (toolName: string, toolOutput: unknown = { score: 92 }): Block => ({
  id: 'b1', type: 'mcp_tool', status: 'success', messageId: 'm1', toolName, toolInput: {}, toolOutput, startedAt: 1, endedAt: 2,
} as Block);

const EssayScoreCard: React.FC<ChatToolResultProps> = ({ toolOutput }) => (
  <div data-testid="essay-card">score {(toolOutput as { score: number }).score}</div>
);

describe('chat.toolResults example: a new tool result card is one contribution', () => {
  it('renders the contributed card for the tool (with or without builtin-) and falls back after unload', async () => {
    const kernel = new UiKernel();
    // The whole integration a W03 executor needs on the front end:
    await kernel.install(defineUiPlugin({
      meta: { id: 'example.essay-card' },
      apply(ctx) {
        ctx.ui.contribute('chat.toolResults', {
          id: 'essay-score',
          key: 'essay_grade',
          value: { placement: 'block', component: EssayScoreCard },
        });
      },
    }));

    const view = render(
      <UiKernelProvider kernel={kernel}>
        <McpToolBlockComponent block={success('builtin-essay_grade')} />
      </UiKernelProvider>,
    );
    expect(screen.getByTestId('essay-card').textContent).toBe('score 92');
    view.rerender(
      <UiKernelProvider kernel={kernel}>
        <McpToolBlockComponent block={success('essay_grade')} />
      </UiKernelProvider>,
    );
    expect(screen.getByTestId('essay-card')).toBeTruthy();

    await act(async () => { await kernel.unload('example.essay-card'); });
    expect(screen.queryByTestId('essay-card')).toBeNull();
    expect(view.container.querySelector('.mcp-tool-block')).not.toBeNull();
    await kernel.dispose();
  });

  it('places output and action views inside the generic card', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({
      meta: { id: 'example.qbank' },
      apply(ctx) {
        ctx.ui.contribute('chat.toolResults', { id: 'out', key: 'qbank_list_questions', value: { placement: 'output', component: () => <div data-testid="qbank-output" /> } });
        ctx.ui.contribute('chat.toolResults', { id: 'act', key: 'qbank_create_question', value: { placement: 'actions', component: () => <button data-testid="qbank-open">open</button> } });
      },
    }));
    const renderTool = (name: string) => render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={success(name)} /></UiKernelProvider>);

    const output = renderTool('builtin-qbank_list_questions');
    expect(output.getByTestId('qbank-output')).toBeTruthy();
    expect(output.container.querySelector('.mcp-tool-block')).not.toBeNull();
    output.unmount();

    const actions = renderTool('builtin-qbank_create_question');
    expect(actions.getByTestId('qbank-open')).toBeTruthy();
    expect(actions.container.textContent).toContain('92');
    await kernel.dispose();
  });

  it('accepts a v1 bare component through ctx.ui.chat.registerToolResult', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({
      meta: { id: 'example.v1' },
      apply(ctx) {
        ctx.ui.chat.registerToolResult('media_ocr', EssayScoreCard);
      },
    }));
    expect(kernel.slots.get('chat.toolResults', 'media_ocr')?.value.placement).toBe('block');
    render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={success('builtin-media_ocr')} /></UiKernelProvider>);
    expect(screen.getByTestId('essay-card')).toBeTruthy();
    await kernel.dispose();
  });

  it('kernel contributions win over the built-in table', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({
      meta: { id: 'example.override' },
      apply(ctx) {
        ctx.ui.contribute('chat.toolResults', { id: 'todo', key: 'todo_update', value: { placement: 'block', component: () => <div data-testid="custom-todo" /> } });
      },
    }));
    render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={success('builtin-todo_update')} /></UiKernelProvider>);
    expect(screen.getByTestId('custom-todo')).toBeTruthy();
    await kernel.dispose();
  });
});

describe('tool name matching', () => {
  const view = (match?: 'exact' | 'qualified'): ChatToolResultContribution => ({ placement: 'block', component: () => null, match });
  const entries = [
    { id: 'a', key: 'note_create', value: view() },
    { id: 'b', key: 'paper_save', value: view('qualified') },
  ];

  it('exact keys accept the bare name and the builtin- prefix only', () => {
    expect(findToolResult(entries, 'note_create')).toBe(entries[0]!.value);
    expect(findToolResult(entries, 'builtin-note_create')).toBe(entries[0]!.value);
    for (const name of ['builtin:note_create', 'mcp_note_create', 'mcp.tools.note_create', 'server.note_create']) {
      expect(findToolResult(entries, name)).toBeUndefined();
    }
  });

  it('qualified keys also strip builtin:, mcp_, mcp.tools. and namespaces', () => {
    for (const name of ['paper_save', 'builtin-paper_save', 'builtin:paper_save', 'mcp_paper_save', 'mcp.tools.paper_save', 'server.paper_save']) {
      expect(findToolResult(entries, name)).toBe(entries[1]!.value);
      expect(qualifiedToolBaseName(name)).toBe('paper_save');
    }
  });

  it('when() false falls back to the generic view; unknown names resolve to nothing', () => {
    const props = { block: success('attempt_completion'), toolName: 'attempt_completion', toolInput: {}, toolOutput: undefined };
    expect(resolveToolResult([undefined, officialToolResultEntries], props)).toBeUndefined();
    expect(resolveToolResult([undefined, officialToolResultEntries], { ...props, toolOutput: { result: 'ok' } })?.placement).toBe('block');
    expect(resolveToolResult([[], officialToolResultEntries], { ...props, toolName: 'builtin-unknown_tool' })).toBeUndefined();
  });

  it('the built-in table has one entry per base tool name', () => {
    const keys = officialToolResultEntries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key && !key.startsWith('builtin'))).toBe(true);
  });
});
