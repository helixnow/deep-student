import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  markdownPropsSchema,
  MarkdownBlock,
} from '@/features/generative-ui/components/MarkdownBlock';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { buildMarkdownIntent } from '@/features/generative-ui/utils/buildMarkdownIntent';

vi.mock('@/features/chat/components/renderers/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown-renderer" data-streaming={isStreaming ? 'true' : undefined}>
      {content}
    </div>
  ),
}));

function registerMarkdownBlock() {
  generativeUIRegistry.register({
    type: 'markdown',
    component: MarkdownBlock,
    propsSchema: markdownPropsSchema,
    description: 'Markdown 正文：title + body，复用 Chat MarkdownRenderer',
    allowPartialRender: true,
  });
}

describe('markdownPropsSchema', () => {
  it('accepts a valid payload', () => {
    const parsed = markdownPropsSchema.safeParse({
      id: 'md-1',
      title: '说明',
      body: '# Hello',
      variant: 'compact',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing / empty / oversized / invalid fields', () => {
    expect(markdownPropsSchema.safeParse({}).success).toBe(false);
    expect(markdownPropsSchema.safeParse({ body: '' }).success).toBe(false);
    expect(markdownPropsSchema.safeParse({ body: 'ok', title: 'T'.repeat(121) }).success).toBe(false);
    expect(markdownPropsSchema.safeParse({ body: 'B'.repeat(20001) }).success).toBe(false);
    expect(markdownPropsSchema.safeParse({ body: 'ok', variant: 'huge' }).success).toBe(false);
  });
});

describe('MarkdownBlock', () => {
  beforeEach(() => {
    registerMarkdownBlock();
  });

  it('registers allowPartialRender and renders title + body through the renderer', () => {
    expect(generativeUIRegistry.get('markdown')?.allowPartialRender).toBe(true);

    const intent = buildMarkdownIntent({
      title: '学习笔记',
      body: '这是 **正文**',
      variant: 'default',
    });

    render(<GenerativeUIRenderer intent={intent} showChrome={false} />);

    const card = document.querySelector('[data-generative-markdown]');
    expect(card).toBeTruthy();
    expect(card).toHaveAttribute('data-variant', 'default');
    expect(card).toHaveTextContent('学习笔记');
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('这是 **正文**');
  });

  it('shows empty fallback and does not crash on invalid schema props', () => {
    expect(() => {
      render(<MarkdownBlock title={'超长'.repeat(80)} body="" variant={'huge' as 'default'} />);
    }).not.toThrow();

    expect(screen.getByTestId('markdown-block-empty')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-markdown]')).toHaveAttribute('data-empty', 'true');
  });

  it('renders streaming partial body when isStreaming is set', () => {
    render(<MarkdownBlock title="流式" body="正在生成 **" isStreaming />);

    expect(screen.getByText('流式')).toBeInTheDocument();
    const renderer = screen.getByTestId('markdown-renderer');
    expect(renderer).toHaveTextContent('正在生成 **');
    expect(renderer).toHaveAttribute('data-streaming', 'true');
  });
});
