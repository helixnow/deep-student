import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 semantic token contract', () => {
  const tokenSource = readFileSync(
    resolve(process.cwd(), 'src/styles/shadcn-variables.css'),
    'utf-8'
  );
  const markdownCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/markdown.css'),
    'utf-8'
  );
  const codeBlockShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/CodeBlockShell.tsx'),
    'utf-8'
  );
  const tableBlockShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/TableBlockShell.tsx'),
    'utf-8'
  );
  const threadEmptyStateShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/ThreadEmptyStateShell.tsx'),
    'utf-8'
  );

  it('defines semantic tokens for chat block surfaces', () => {
    expect(tokenSource).toContain('--chat-block-radius: 12px;');
    expect(tokenSource).toContain('--chat-block-surface:');
    expect(tokenSource).toContain('--chat-block-surface-muted:');
    expect(tokenSource).toContain('--chat-code-inline-bg:');
    expect(tokenSource).toContain('--chat-code-block-surface:');
    expect(tokenSource).toContain('--chat-block-border:');
    expect(tokenSource).toContain('--chat-table-header-surface:');
  });

  it('uses semantic tokens in markdown block surfaces', () => {
    expect(markdownCssSource).toContain('var(--chat-code-inline-bg)');
    expect(markdownCssSource).toContain('var(--chat-block-border)');
    expect(markdownCssSource).toContain('var(--chat-block-radius)');
    expect(markdownCssSource).toContain('var(--chat-block-surface)');
    expect(markdownCssSource).toContain('var(--chat-block-surface-muted)');
    expect(markdownCssSource).toContain('var(--chat-code-block-surface)');
    expect(markdownCssSource).toContain('var(--chat-table-header-surface)');
  });

  it('promotes block shells to dedicated UI components while preserving style hooks', () => {
    expect(codeBlockShellSource).toContain("'code-block-wrapper'");
    expect(tableBlockShellSource).toContain("'table-wrapper'");
    expect(tableBlockShellSource).toContain("'markdown-table'");
    expect(threadEmptyStateShellSource).toContain('data-slot="thread-empty-state"');
    expect(threadEmptyStateShellSource).toContain('ThreadContentShell');
  });
});
