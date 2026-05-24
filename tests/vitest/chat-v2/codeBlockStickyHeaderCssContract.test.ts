import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CodeBlock sticky header CSS contract', () => {
  const markdownCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/markdown.css'),
    'utf-8'
  );

  it('keeps the sticky code block header outside of the overflow-clipped body shell', () => {
    const wrapperRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-wrapper {');
    const wrapperRuleEnd = markdownCssSource.indexOf('}', wrapperRuleStart);
    const wrapperRule = markdownCssSource.slice(wrapperRuleStart, wrapperRuleEnd);

    const stuckWrapperRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-wrapper:has(.code-block-sticky-header--stuck) {');
    const stuckWrapperRuleEnd = markdownCssSource.indexOf('}', stuckWrapperRuleStart);
    const stuckWrapperRule = markdownCssSource.slice(stuckWrapperRuleStart, stuckWrapperRuleEnd);

    const stickyRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-sticky-header {');
    const stickyRuleEnd = markdownCssSource.indexOf('}', stickyRuleStart);
    const stickyRule = markdownCssSource.slice(stickyRuleStart, stickyRuleEnd);

    const stuckRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-sticky-header--stuck .code-block-header {');
    const stuckRuleEnd = markdownCssSource.indexOf('}', stuckRuleStart);
    const stuckRule = markdownCssSource.slice(stuckRuleStart, stuckRuleEnd);

    const bodyShellRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-body-shell {');
    const bodyShellRuleEnd = markdownCssSource.indexOf('}', bodyShellRuleStart);
    const bodyShellRule = markdownCssSource.slice(bodyShellRuleStart, bodyShellRuleEnd);

    expect(wrapperRuleStart).toBeGreaterThan(-1);
    expect(wrapperRule).toContain('overflow: visible;');

    expect(stuckWrapperRuleStart).toBeGreaterThan(-1);
    expect(stuckWrapperRule).toContain('border-radius: 0;');

    const exitingWrapperRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-wrapper:has(.code-block-sticky-header--exiting) {');
    const exitingWrapperRuleEnd = markdownCssSource.indexOf('}', exitingWrapperRuleStart);
    const exitingWrapperRule = markdownCssSource.slice(exitingWrapperRuleStart, exitingWrapperRuleEnd);

    expect(exitingWrapperRuleStart).toBeGreaterThan(-1);
    expect(exitingWrapperRule).toContain('border-radius: 0 0 var(--chat-block-radius) var(--chat-block-radius);');

    expect(stickyRuleStart).toBeGreaterThan(-1);
    expect(stickyRule).toContain('position: sticky;');
    expect(stickyRule).toContain('top: 0;');

    expect(stuckRuleStart).toBeGreaterThan(-1);
    expect(stuckRule).toContain('border-radius: 0;');

    const exitingRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-sticky-header--exiting .code-block-header {');
    const exitingRuleEnd = markdownCssSource.indexOf('}', exitingRuleStart);
    const exitingRule = markdownCssSource.slice(exitingRuleStart, exitingRuleEnd);

    expect(exitingRuleStart).toBeGreaterThan(-1);
    expect(exitingRule).toContain('border-radius: 0 0 var(--chat-block-radius) var(--chat-block-radius);');

    expect(bodyShellRuleStart).toBeGreaterThan(-1);
    expect(bodyShellRule).toContain('overflow: hidden;');

    const headerRuleStart = markdownCssSource.indexOf('.chat-v2 .markdown-content .code-block-header {');
    const headerRuleEnd = markdownCssSource.indexOf('}', headerRuleStart);
    const headerRule = markdownCssSource.slice(headerRuleStart, headerRuleEnd);

    expect(headerRuleStart).toBeGreaterThan(-1);
    expect(headerRule).toContain('background: var(--chat-table-header-surface);');
    expect(headerRule).not.toContain('--chat-block-surface-muted');
  });
});
