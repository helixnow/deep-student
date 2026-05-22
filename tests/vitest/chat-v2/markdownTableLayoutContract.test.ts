import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 markdown table layout contract', () => {
  const markdownCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/markdown.css'),
    'utf-8'
  );
  const chatCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat.css'),
    'utf-8'
  );

  it('keeps markdown tables full width instead of collapsing them to content width', () => {
    const tableSelectionRuleStart = chatCssSource.indexOf('.chat-v2 .message-selectable-area .markdown-content table,');
    const tableSelectionRuleEnd = chatCssSource.indexOf('}', tableSelectionRuleStart);
    const tableSelectionRule = chatCssSource.slice(tableSelectionRuleStart, tableSelectionRuleEnd);

    expect(tableSelectionRuleStart).toBeGreaterThan(-1);
    expect(tableSelectionRuleEnd).toBeGreaterThan(tableSelectionRuleStart);
    expect(tableSelectionRule).not.toContain('width: auto;');
    expect(tableSelectionRule).toContain('max-width: 100%;');

    const tableWrapperRuleStart = markdownCssSource.indexOf('.chat-v2 .table-wrapper {');
    const tableWrapperRuleEnd = markdownCssSource.indexOf('}', tableWrapperRuleStart);
    const tableWrapperRule = markdownCssSource.slice(tableWrapperRuleStart, tableWrapperRuleEnd);

    expect(tableWrapperRuleStart).toBeGreaterThan(-1);
    expect(tableWrapperRuleEnd).toBeGreaterThan(tableWrapperRuleStart);
    expect(tableWrapperRule).toContain('width: 100%;');
    expect(tableWrapperRule).toContain('overflow-x: auto;');
  });
});
