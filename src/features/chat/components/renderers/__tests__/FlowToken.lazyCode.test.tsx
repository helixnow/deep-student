import React from 'react';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { FlowTokenMarkdownRenderer, preloadFlowToken } from '../FlowTokenMarkdownRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';

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

  it('loads highlighting and preserves copying for fenced code in the full main-content path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container, getByRole } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>检查代码</thinking>\n正文\n\n```js\nconst answer = 42;\n```'}
        isStreaming
      />,
    );

    // A native code fallback remains visible while its separate chunk loads.
    expect(container.querySelector('.main-content')?.textContent).toContain('const answer = 42;');
    await waitFor(() => expect(container.querySelector('.main-content .ft-code-container')).not.toBeNull());
    expect(container.querySelector('.ft-code-language')).toHaveTextContent('js');
    expect(container.querySelector('.ft-code-content .token')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const answer = 42;\n');
    expect(getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
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
