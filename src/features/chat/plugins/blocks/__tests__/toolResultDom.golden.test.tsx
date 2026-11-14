/**
 * FE-B3 evidence: DOM golden of representative tool outputs rendered by the real mcp_tool block
 * (dedicated views, generic view, action buttons, error / running states).
 *
 * Captured on the pre-refactor `mcpTool.tsx` and compared byte for byte afterwards.
 * Capture: W17_CAPTURE_TOOL_RESULTS=1 (write-once).
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';
import { McpToolBlockComponent } from '../mcpTool';

const base = { id: 'tool-block-1', type: 'mcp_tool', messageId: 'msg-1', startedAt: 1_000, endedAt: 3_500 } as const;

const TOOL_RESULT_DOM_CASES: Record<string, Partial<Block>> = {
  'todo-update': {
    status: 'success', toolName: 'builtin-todo_update', toolInput: { task_id: 't1' },
    toolOutput: { result: {
      success: true, todoListId: 'list-1', title: 'Study plan', progress: '1/2', completedCount: 1, totalCount: 2,
      steps: [
        { id: 't1', description: 'Read chapter 1', status: 'completed', createdAt: 1_000 },
        { id: 't2', description: 'Solve set 2', status: 'running', createdAt: 1_000 },
      ],
    } },
  },
  'todo-running': { status: 'running', toolName: 'todo_init', toolInput: { title: 'Plan' }, endedAt: undefined },
  'paper-save': {
    status: 'success', toolName: 'builtin-paper_save', toolInput: { doi: '10.1/abc' },
    toolOutput: { result: { saved: [{ title: 'Paper A', file_name: 'a.pdf', status: 'saved' }] } },
  },
  'attempt-completion': {
    status: 'success', toolName: 'builtin-attempt_completion', toolInput: { result: 'All done' },
    toolOutput: { result: { summary: 'All done', verdict: 'verified_complete' } },
  },
  'attempt-completion-running': { status: 'running', toolName: 'attempt_completion', toolInput: { result: 'All done' }, endedAt: undefined },
  'shell-execute': {
    status: 'success', toolName: 'builtin-local_shell_execute', toolInput: { command: 'ls' },
    toolOutput: { stdout: 'a.txt\nb.txt\n', stderr: '', exit_code: 0 },
  },
  'docx-create': {
    status: 'success', toolName: 'builtin-docx_create', toolInput: { title: 'Report' },
    toolOutput: { file_id: 'file-1', file_name: 'report.docx' },
  },
  'xlsx-edit-cells': {
    status: 'success', toolName: 'xlsx_edit_cells', toolInput: { resource_id: 'res-x' },
    toolOutput: { new_file_id: 'file-2', file_name: 'sheet.xlsx' },
  },
  'pptx-read': {
    status: 'success', toolName: 'builtin-pptx_read_structured', toolInput: { resource_id: 'res-p' },
    toolOutput: { result: { resource_id: 'res-p', metadata: { title: 'Deck' }, slides: 3 } },
  },
  'xlsx-read-input-fallback': {
    status: 'success', toolName: 'xlsx_get_metadata', toolInput: { resource_id: 'res-input' }, toolOutput: { sheets: 2 },
  },
  'note-create': {
    status: 'success', toolName: 'builtin-note_create', toolInput: { title: 'Note' },
    toolOutput: { result: { note_id: 'note-1', title: 'Note' } },
  },
  'note-read-no-id': { status: 'success', toolName: 'note_read', toolInput: {}, toolOutput: { content: 'hello' } },
  'generic-json': {
    status: 'success', toolName: 'builtin-qbank_list_questions', toolInput: { limit: 2 },
    toolOutput: { questions: [{ id: 'q1', stem: 'What is 1+1?' }], total: 1 },
  },
  'generic-string': { status: 'success', toolName: 'builtin-memory_search', toolInput: { query: 'x' }, toolOutput: 'plain text result' },
  'generic-started': { status: 'success', toolName: 'builtin-essay_grade', toolInput: {}, toolOutput: { status: 'started', job_id: 'j1' } },
  'generic-running-stream': { status: 'running', toolName: 'builtin-textbook_pdf_read', toolInput: { page: 1 }, content: 'page 1 text', endedAt: undefined },
  'generic-preparing': { status: 'pending', isPreparing: true, toolName: 'builtin-docx_create', toolInput: {}, content: '{"title":"Re', endedAt: undefined },
  'error-runtime-root': { status: 'error', toolName: 'builtin-docx_create', toolInput: { title: 'x' }, error: 'boom' },
  'error-todo': { status: 'error', toolName: 'builtin-todo_update', toolInput: {}, error: 'todo failed' },
  'unknown-name': { status: 'pending', toolName: undefined, toolInput: {}, endedAt: undefined },
};

afterEach(() => cleanup());

it('keeps the DOM of representative tool outputs', async () => {
  const dom: Record<string, string> = {};
  for (const [name, fixture] of Object.entries(TOOL_RESULT_DOM_CASES)) {
    const view = render(<McpToolBlockComponent block={{ ...base, ...fixture } as Block} />);
    await act(async () => { await Promise.resolve(); });
    // Shimmer animations write time-dependent inline styles.
    dom[name] = view.container.innerHTML.replace(/background-position: [^;"]+/g, 'background-position: <animated>');
    view.unmount();
  }
  const file = 'src/features/chat/plugins/blocks/__golden__/tool-result-dom.json';
  if (process.env.W17_CAPTURE_TOOL_RESULTS === '1') writeFileSync(file, `${JSON.stringify(dom, null, 1)}\n`, { flag: 'wx' });
  expect(dom).toEqual(JSON.parse(readFileSync(file, 'utf8')));
});
