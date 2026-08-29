import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  markdownPropsSchema,
  MarkdownBlock,
} from '@/features/generative-ui/components/MarkdownBlock';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { buildMarkdownIntent } from '@/features/generative-ui/utils/buildMarkdownIntent';
import {
  GENERATIVE_MARKDOWN_SANITIZE_SCHEMA,
  sanitizeGenerativeMarkdown,
} from '@/features/generative-ui/utils/sanitizeGenerativeMarkdown';

const markdownRendererImpl = vi.hoisted(() =>
  vi.fn(({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown-renderer" data-streaming={isStreaming ? 'true' : undefined}>
      {content}
    </div>
  )),
);

vi.mock('@/features/chat/components/renderers/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content: string; isStreaming?: boolean }) => markdownRendererImpl(props),
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

function healthyRenderer({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  return (
    <div data-testid="markdown-renderer" data-streaming={isStreaming ? 'true' : undefined}>
      {content}
    </div>
  );
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

describe('sanitizeGenerativeMarkdown contract', () => {
  it('reuses Chat rehype-sanitize defaultSchema (script stripped, not allowed)', () => {
    expect(GENERATIVE_MARKDOWN_SANITIZE_SCHEMA.strip).toContain('script');
    expect(GENERATIVE_MARKDOWN_SANITIZE_SCHEMA.tagNames).not.toContain('script');
    expect(GENERATIVE_MARKDOWN_SANITIZE_SCHEMA.tagNames).not.toContain('iframe');

    const rendererSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/features/chat/components/renderers/MarkdownRenderer.tsx'),
      'utf8',
    );
    expect(rendererSrc).toContain('rehypeSanitize');
    expect(rendererSrc).toContain('defaultSchema');
  });

  it('strips <script> and onerror so they cannot execute', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      'Hello <script>alert(1)</script><img src=x onerror="alert(1)">',
    );
    expect(sanitized).not.toMatch(/<script/i);
    expect(sanitized).not.toMatch(/onerror/i);
    expect(sanitized).not.toMatch(/alert\s*\(/i);
    expect(sanitized).toContain('Hello');
  });

  it('strips case-variant SCRIPT / onError and javascript: URLs', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      '<SCRIPT>alert(1)</SCRIPT><a href="javascript:alert(1)">go</a><img SRC=x OnErRoR=alert(1)>',
    );
    expect(sanitized).not.toMatch(/<script/i);
    expect(sanitized).not.toMatch(/onerror/i);
    expect(sanitized).not.toMatch(/javascript:/i);
    expect(sanitized).toContain('go');
  });

  it('preserves fenced code examples that mention script tags', () => {
    const input = '前言\n```html\n<script>alert(1)</script>\n```\n后记';
    const sanitized = sanitizeGenerativeMarkdown(input);
    expect(sanitized).toContain('```html');
    expect(sanitized).toContain('<script>alert(1)</script>');
    expect(sanitized).toContain('后记');
  });

  it('blocks file: and protocol-relative // URLs via shared sanitizer', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      '<a href="file:///etc/passwd">f</a><img src="//evil.test/x.png">',
    );
    expect(sanitized).not.toMatch(/file:/i);
    expect(sanitized).not.toContain('//evil.test');
  });

  it('keeps safe https and data:image URLs', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      '<a href="https://ok.test">ok</a><img src="data:image/png;base64,xx">',
    );
    expect(sanitized).toContain('https://ok.test');
    expect(sanitized).toContain('data:image/png;base64,xx');
  });

  it('rewrites markdown javascript: / file: links without touching fenced code', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      'See [click](javascript:alert(1)) and ![x](file:///etc/passwd)\n```md\n[keep](javascript:alert(1))\n```',
    );
    expect(sanitized).toContain('[click](#)');
    expect(sanitized).toContain('![x](#)');
    expect(sanitized).not.toMatch(/\[click]\(javascript:/);
    expect(sanitized).not.toMatch(/file:/);
    expect(sanitized).toContain('[keep](javascript:alert(1))');
  });

  it('rewrites markdown reference definitions, autolinks, and srcset/poster', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      [
        '[go][evil]',
        '[evil]: javascript:alert(1)',
        'See <javascript:alert(1)> and <https://ok.test>',
        '<img srcset="javascript:alert(1) 1x, https://ok.test/a.png 2x" poster="file:///x">',
      ].join('\n'),
    );
    expect(sanitized).toContain('[evil]: #');
    expect(sanitized).not.toMatch(/javascript:/);
    expect(sanitized).not.toMatch(/file:/);
    expect(sanitized).toContain('<https://ok.test>');
    expect(sanitized).toContain('https://ok.test/a.png');
  });

  it('rewrites ping and background URL attributes', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      '<a href="https://ok.test" ping="javascript:alert(1)">go</a><td background="file:///x">c</td>',
    );
    expect(sanitized).not.toMatch(/javascript:/);
    expect(sanitized).not.toMatch(/file:/);
    expect(sanitized).toContain('https://ok.test');
    expect(sanitized).toContain('go');
  });

  it('strips style and srcdoc attributes before render', () => {
    const sanitized = sanitizeGenerativeMarkdown(
      '<p style="background:url(javascript:alert(1))">hi</p><div srcdoc="<script>alert(1)</script>">x</div>',
    );
    expect(sanitized).not.toMatch(/style=/i);
    expect(sanitized).not.toMatch(/srcdoc=/i);
    expect(sanitized).not.toMatch(/javascript:/i);
    expect(sanitized).toContain('hi');
  });
});

describe('MarkdownBlock', () => {
  beforeEach(() => {
    registerMarkdownBlock();
    markdownRendererImpl.mockImplementation(healthyRenderer);
  });

  afterEach(() => {
    markdownRendererImpl.mockReset();
    markdownRendererImpl.mockImplementation(healthyRenderer);
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
    expect(card).toHaveAttribute('role', 'region');
    expect(card).toHaveAttribute('data-variant', 'default');
    expect(card).toHaveTextContent('学习笔记');
    expect(screen.getByRole('heading', { name: '学习笔记' })).toBeInTheDocument();
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

  it('does not pass executable script/onerror HTML to MarkdownRenderer', () => {
    render(
      <MarkdownBlock body={'Hello <script>alert(1)</script><img src=x onerror="alert(1)">'} />,
    );

    const renderer = screen.getByTestId('markdown-renderer');
    const handed = renderer.textContent ?? '';
    expect(handed).not.toMatch(/<script/i);
    expect(handed).not.toMatch(/onerror/i);
    expect(handed).not.toMatch(/alert\s*\(/i);
    expect(handed).toContain('Hello');
    expect(markdownRendererImpl).toHaveBeenCalled();
    const firstArg = markdownRendererImpl.mock.calls[0]?.[0] as { content: string };
    expect(firstArg.content).not.toMatch(/<script/i);
    expect(firstArg.content).not.toMatch(/onerror/i);
  });

  it('shows empty fallback when the body is only a stripped script', () => {
    render(<MarkdownBlock body="<script>alert(1)</script>" />);
    expect(screen.getByTestId('markdown-block-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-renderer')).toBeNull();
  });

  it('contains a renderer throw inside the error boundary without crashing the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    markdownRendererImpl.mockImplementation(() => {
      throw new Error('renderer boom');
    });

    render(
      <>
        <div data-testid="page-alive">still here</div>
        <MarkdownBlock title="笔记" body="hello" />
      </>,
    );

    expect(screen.getByTestId('page-alive')).toHaveTextContent('still here');
    expect(screen.getByTestId('generative-ui-error-boundary')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-markdown]')).toBeTruthy();
    expect(screen.getByText('笔记')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-renderer')).toBeNull();
  });
});
