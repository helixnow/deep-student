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

  it('uses a lightweight document-style table surface instead of a chat card shell', () => {
    const tableWrapperRuleStart = markdownCssSource.indexOf('.chat-v2 .table-wrapper {');
    const tableWrapperRuleEnd = markdownCssSource.indexOf('}', tableWrapperRuleStart);
    const tableWrapperRule = markdownCssSource.slice(tableWrapperRuleStart, tableWrapperRuleEnd);

    const tableRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-table {');
    const tableRuleEnd = markdownCssSource.indexOf('}', tableRuleStart);
    const tableRule = markdownCssSource.slice(tableRuleStart, tableRuleEnd);

    const tableHeaderRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-table th {');
    const tableHeaderRuleEnd = markdownCssSource.indexOf('}', tableHeaderRuleStart);
    const tableHeaderRule = markdownCssSource.slice(tableHeaderRuleStart, tableHeaderRuleEnd);

    const tableCellRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-table td {');
    const tableCellRuleEnd = markdownCssSource.indexOf('}', tableCellRuleStart);
    const tableCellRule = markdownCssSource.slice(tableCellRuleStart, tableCellRuleEnd);

    const sharedCellRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-table th,');
    const sharedCellRuleEnd = markdownCssSource.indexOf('}', sharedCellRuleStart);
    const sharedCellRule = markdownCssSource.slice(sharedCellRuleStart, sharedCellRuleEnd);

    const hoverRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-table tr:hover {');

    expect(tableWrapperRuleStart).toBeGreaterThan(-1);
    expect(tableWrapperRule).not.toContain('border-radius:');
    expect(tableWrapperRule).not.toContain('border: 1px solid');
    expect(tableWrapperRule).not.toContain('background:');

    expect(tableRuleStart).toBeGreaterThan(-1);
    expect(tableRule).toContain('border-top: 2px solid');
    expect(tableRule).toContain('border-bottom: 2px solid');
    expect(tableRule).not.toContain('border-radius:');

    expect(tableHeaderRuleStart).toBeGreaterThan(-1);
    expect(tableHeaderRule).not.toContain('background:');
    expect(tableHeaderRule).toContain('border-bottom: 1px solid');
    expect(tableHeaderRule).toContain('font-weight: 600;');

    expect(tableCellRuleStart).toBeGreaterThan(-1);
    expect(tableCellRule).not.toContain('border-bottom:');

    expect(sharedCellRuleStart).toBeGreaterThan(-1);
    expect(sharedCellRule).toContain('padding: 0.7em 0.85em;');

    expect(hoverRuleStart).toBe(-1);
  });
});
