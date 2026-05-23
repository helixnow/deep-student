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

    expect(stickyRuleStart).toBeGreaterThan(-1);
    expect(stickyRule).toContain('position: sticky;');
    expect(stickyRule).toContain('top: 0;');

    expect(stuckRuleStart).toBeGreaterThan(-1);
    expect(stuckRule).toContain('border-radius: 0;');

    expect(bodyShellRuleStart).toBeGreaterThan(-1);
    expect(bodyShellRule).toContain('overflow: hidden;');
  });
});
