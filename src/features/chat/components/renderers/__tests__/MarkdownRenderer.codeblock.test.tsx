import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://mock${path}`,
}));

describe('MarkdownRenderer code block fidelity', () => {
  it('preserves consecutive blank lines inside fenced code blocks', () => {
    const code = 'def a():\n    pass\n\n\n\ndef b():\n    pass';
    const { container } = render(
      <MarkdownRenderer content={`\`\`\`python\n${code}\n\`\`\``} />
    );

    const codeEl = container.querySelector('pre code');
    expect(codeEl?.textContent).toBe(`${code}\n`);
  });

  it('preserves bare numbered lines inside fenced code blocks', () => {
    const code = 'items = [\n1.\n2.\n]';
    const { container } = render(
      <MarkdownRenderer content={`\`\`\`text\n${code}\n\`\`\``} />
    );

    const codeEl = container.querySelector('pre code');
    expect(codeEl?.textContent).toBe(`${code}\n`);
  });

  it('preserves latex environments inside fenced code blocks verbatim', () => {
    const code = '\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}';
    const { container } = render(
      <MarkdownRenderer content={`\`\`\`latex-src\n${code}\n\`\`\``} />
    );

    const codeEl = container.querySelector('pre code');
    expect(codeEl?.textContent).toBe(`${code}\n`);
  });

  it('still collapses excessive blank lines outside code blocks', () => {
    const { container } = render(
      <MarkdownRenderer content={'第一段\n\n\n\n\n第二段'} />
    );

    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(2);
  });

  it('does not leak the hast node object onto DOM elements', () => {
    const { container } = render(
      <MarkdownRenderer content={'# 标题\n\n段落 **加粗** [链接](https://example.com)\n\n- 项目'} />
    );

    expect(container.querySelector('[node]')).toBeNull();
  });
});
