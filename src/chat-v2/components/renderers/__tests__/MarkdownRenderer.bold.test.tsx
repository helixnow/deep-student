import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';

describe('MarkdownRenderer bold compatibility', () => {
  it('renders standard bold syntax in MarkdownRenderer', () => {
    render(<MarkdownRenderer content={'这是 **加粗** 内容'} />);
    const strong = screen.getByText('加粗');
    expect(strong.tagName.toLowerCase()).toBe('strong');
  });

  it('renders bold when wrapped by CJK text without surrounding spaces', () => {
    render(<MarkdownRenderer content={'这是一篇关于**智谱 AI（Z.ai）Startup Program（创业扶持计划）**的微信公众号文章截图。'} />);
    const strong = screen.getByText('智谱 AI（Z.ai）Startup Program（创业扶持计划）');
    expect(strong.tagName.toLowerCase()).toBe('strong');
  });

  it('applies the same fix in StreamingMarkdownRenderer path', () => {
    render(<StreamingMarkdownRenderer content={'这是一篇关于**智谱 AI**的介绍。'} isStreaming={false} />);
    const strong = screen.getByText('智谱 AI');
    expect(strong.tagName.toLowerCase()).toBe('strong');
  });
});
