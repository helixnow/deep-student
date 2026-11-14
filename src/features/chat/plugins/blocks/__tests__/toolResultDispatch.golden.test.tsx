/**
 * FE-B3 evidence: the full "tool name → render branch" table of the mcp_tool block.
 *
 * Captured on the pre-refactor `mcpTool.tsx` (hard-coded TODO_TOOLS / DOC_*_TOOLS / NOTE_TOOLS dispatch) and
 * compared field by field afterwards. Dedicated views are replaced by markers so the table records which
 * branch ran and with which data; the DOM of the views themselves is covered by toolResultDom.golden.test.tsx.
 *
 * Capture: W17_CAPTURE_TOOL_RESULTS=1 (write-once).
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';
import { McpToolBlockComponent } from '../mcpTool';
import toolNames from './__fixtures__/builtin-tool-names.json';

vi.mock('../todoList', () => ({
  TodoListBlock: ({ block, isStreaming }: { block: Block; isStreaming?: boolean }) => (
    <div data-branch="todo" data-type={block.type} data-streaming={String(!!isStreaming)} data-output={JSON.stringify(block.toolOutput ?? null)} />
  ),
}));
vi.mock('../paperSave', () => ({
  PaperSaveBlock: ({ block, isStreaming }: { block: Block; isStreaming?: boolean }) => (
    <div data-branch="paper_save" data-type={block.type} data-streaming={String(!!isStreaming)} />
  ),
}));
vi.mock('../../../components/CompletionCard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CompletionCard: ({ data }: { data: unknown }) => <div data-branch="completion" data-output={JSON.stringify(data)} />,
}));
vi.mock('../components', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ToolOutputView: () => <div data-branch="output" />,
  ShellOutputView: () => <div data-branch="shell" />,
}));

/** Names the pre-refactor dispatch special-cases (some are not in the front-end schemas). */
const DISPATCH_NAMES = [
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'note_create', 'note_read', 'note_append', 'note_replace', 'note_set', 'note_list', 'note_search',
  'docx_create', 'docx_replace_text', 'pptx_create', 'pptx_replace_text', 'xlsx_create', 'xlsx_replace_text', 'xlsx_edit_cells',
  'docx_read_structured', 'docx_extract_tables', 'docx_get_metadata', 'docx_to_spec',
  'pptx_read_structured', 'pptx_get_metadata', 'pptx_extract_tables', 'pptx_to_spec',
  'xlsx_read_structured', 'xlsx_extract_tables', 'xlsx_get_metadata', 'xlsx_to_spec',
  'paper_save', 'attempt_completion', 'local_shell_execute',
];
const VARIANTS: readonly [string, (base: string) => string][] = [
  ['bare', (b) => b],
  ['builtin-', (b) => `builtin-${b}`],
  ['builtin:', (b) => `builtin:${b}`],
  ['mcp_', (b) => `mcp_${b}`],
  ['mcp.tools.', (b) => `mcp.tools.${b}`],
  ['server.', (b) => `server.${b}`],
];
const STATUSES = ['pending', 'running', 'error', 'success-empty', 'success'] as const;

const OUTPUT = {
  file_id: 'file-1',
  file_name: 'fixture.docx',
  resource_id: 'res-1',
  note_id: 'note-1',
  summary: 'done',
  result: { status: 'ok', note_id: 'note-nested', metadata: { title: 'Nested title' }, items: [{ id: 't1', title: 'Task', status: 'pending' }] },
};

function block(toolName: string, status: (typeof STATUSES)[number]): Block {
  return {
    id: 'tool-block-1',
    type: 'mcp_tool',
    messageId: 'msg-1',
    status: status === 'success-empty' ? 'success' : status,
    toolName,
    toolInput: { resource_id: 'input-res', note_id: 'input-note' },
    toolOutput: status === 'success' ? OUTPUT : undefined,
    error: status === 'error' ? 'boom' : undefined,
    startedAt: 1_000,
    endedAt: status === 'success' || status === 'error' || status === 'success-empty' ? 3_500 : undefined,
  } as Block;
}

function iconSignature(button: Element): string[] {
  return Array.from(button.querySelectorAll('svg')).map((svg) => (svg.querySelector('path')?.getAttribute('d') ?? '').slice(0, 24));
}

function classify(container: HTMLElement) {
  const markers = Array.from(container.querySelectorAll('[data-branch]')).map((el) => {
    const out: Record<string, string> = { branch: el.getAttribute('data-branch')! };
    for (const attr of ['data-type', 'data-streaming', 'data-output']) {
      const value = el.getAttribute(attr);
      if (value !== null) out[attr.slice(5)] = value;
    }
    return out;
  });
  const card = container.querySelector('.mcp-tool-block');
  const outputArea = card?.querySelector('[data-branch="output"], [data-branch="shell"]')?.parentElement;
  const actions = outputArea
    ? Array.from(outputArea.querySelectorAll('button')).map((button) => ({ text: button.textContent, icons: iconSignature(button) }))
    : [];
  return { card: !!card, markers, actions };
}

afterEach(() => cleanup());

it('records the tool name → render branch table', () => {
  const schemaNames = Object.values(toolNames.bySchema).flat();
  const bases = [...new Set([...schemaNames.map((n) => n.replace(/^builtin-/, '')), ...DISPATCH_NAMES])].sort();
  const dispatch = new Set(DISPATCH_NAMES);
  const rows: Record<string, unknown>[] = [];
  for (const base of bases) {
    for (const [variant, name] of VARIANTS) {
      const statuses = dispatch.has(base) ? STATUSES : (['success'] as const);
      for (const status of statuses) {
        const view = render(<McpToolBlockComponent block={block(name(base), status)} />);
        rows.push({ base, variant, status, ...classify(view.container) });
        view.unmount();
      }
    }
  }
  const file = 'src/features/chat/plugins/blocks/__golden__/tool-result-branches.json';
  if (process.env.W17_CAPTURE_TOOL_RESULTS === '1') writeFileSync(file, `${JSON.stringify(rows, null, 1)}\n`, { flag: 'wx' });
  expect(rows).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}, 120_000);
