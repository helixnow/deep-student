import React from 'react';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { FlowTokenMarkdownRenderer, preloadFlowToken } from '../FlowTokenMarkdownRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';

const { syntaxHighlighterLoaded, writeNativeClipboard } = vi.hoisted(() => ({
  syntaxHighlighterLoaded: vi.fn(),
  writeNativeClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('react-syntax-highlighter/dist/esm/prism', async (importOriginal) => {
  syntaxHighlighterLoaded();
  return importOriginal();
});

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: writeNativeClipboard,
}));

const require = createRequire(import.meta.url);
const defaultCodePath = require.resolve('@nvq/flowtoken/dist/components/DefaultCode.js');

beforeAll(async () => {
  await preloadFlowToken();
});

describe('FlowToken code dependency boundary', () => {
  it('renders prose and animated inline code without evaluating the heavy code renderer', () => {
    const { container } = render(
      <FlowTokenMarkdownRenderer content={'正文中的 `value` 继续输出。'} isStreaming />,
    );

    expect(container.textContent).toBe('正文中的 value 继续输出。');
    expect(container.querySelector('code.ft-inline-code [style*="animation-name: ft-fadeIn"]')).not.toBeNull();
    expect(require.cache[defaultCodePath]).toBeUndefined();
  });

  it('keeps the default main-content prose and inline code outside the highlighter boundary', () => {
    const { container } = render(
      <StreamingMarkdownRenderer content={'<thinking>检查正文</thinking>\n正文中的 `value`。'} isStreaming />,
    );

    expect(container.querySelector('.main-content')?.textContent).toBe('正文中的 value。');
    expect(container.querySelector('.main-content code')).toHaveTextContent('value');
    expect(syntaxHighlighterLoaded).not.toHaveBeenCalled();
    expect(require.cache[defaultCodePath]).toBeUndefined();
  });

  it('loads highlighting and preserves copying for FlowToken fenced code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container, getByRole } = render(
      <FlowTokenMarkdownRenderer
        content={'正文\n\n```js\nconst answer = 42;\n```'}
        isStreaming
      />,
    );

    // A native code fallback remains visible while its separate chunk loads.
    expect(container.textContent).toContain('const answer = 42;');
    await waitFor(() => expect(container.querySelector('.ft-code-container')).not.toBeNull());
    expect(container.querySelector('.ft-code-language')).toHaveTextContent('js');
    expect(container.querySelector('.ft-code-content .token')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const answer = 42;\n');
    expect(getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('highlights and copies default main-content code while preserving its node through streaming', async () => {
    const content = '<thinking>检查代码</thinking>\n正文\n\n```js\nconst answer = 42;';
    const { container, getByRole, rerender } = render(
      <StreamingMarkdownRenderer content={content} isStreaming />,
    );

    const code = container.querySelector('.main-content pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('const answer = 42;\n');
    expect(container.querySelector('[data-stream-mode]')).toHaveAttribute('data-stream-mode', 'blocked');
    expect(container.querySelector('.main-content .code-block-lang')).toHaveTextContent('js');
    await waitFor(() => expect(code?.querySelector('.token.keyword')).toHaveTextContent('const'));
    expect(syntaxHighlighterLoaded).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.main-content pre code')).toBe(code);

    const updated = `${content}\nconsole.log(answer);\n\`\`\``;
    rerender(<StreamingMarkdownRenderer content={updated} isStreaming />);
    expect(container.querySelector('.main-content pre code')).toBe(code);
    expect(code?.textContent).toBe('const answer = 42;\nconsole.log(answer);\n');
    expect(code?.querySelector('.token.function')).toHaveTextContent('log');

    rerender(<StreamingMarkdownRenderer content={updated} isStreaming={false} />);
    expect(container.querySelector('.main-content pre code')).toBe(code);
    expect(code?.querySelector('.token.keyword')).toHaveTextContent('const');
    fireEvent.click(getByRole('button', { name: '复制' }));
    await waitFor(() => expect(getByRole('button', { name: '已复制' })).toBeInTheDocument());
    expect(writeNativeClipboard).toHaveBeenCalledWith('const answer = 42;\nconsole.log(answer);');
  });

  it.each([
    ['list', '- 示例\n\n  ```js\n  console.log(42);\n  ```', 'li'],
    ['blockquote', '> 示例\n>\n> ```js\n> console.log(42);\n> ```', 'blockquote'],
  ])('retains highlighted code nested in a %s', async (_label, content, parent) => {
    const { container } = render(<FlowTokenMarkdownRenderer content={content} isStreaming />);
    await waitFor(() => expect(container.querySelector(`${parent} .ft-code-container`)).not.toBeNull());
    expect(container.querySelector(`${parent} .ft-code-content`)?.textContent).toContain('console.log(42);');
  });
});
