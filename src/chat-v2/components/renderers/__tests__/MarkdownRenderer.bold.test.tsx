import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://mock${path}`,
}));

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

  it('does not show a streaming cursor before visible content exists', () => {
    const { container } = render(<StreamingMarkdownRenderer content="" isStreaming />);

    expect(container.querySelector('.streaming-cursor')).toBeNull();
  });

  it('shows the streaming cursor only after visible content exists', () => {
    const { container } = render(<StreamingMarkdownRenderer content="正在输出" isStreaming />);

    expect(container.querySelector('.streaming-cursor')).toBeInTheDocument();
  });

  it('renders strong in table first cell with CJK text and citation-like suffix', () => {
    const md = `| 事件 | 简述 | 适用话题 | 论证角度 |
|------|------|----------|----------|
| **“文科生指挥AI军队”项目引爆GitHub榜** [搜索-1] | 简述 | 话题 | 普通文本 |`;
    const { container } = render(<MarkdownRenderer content={md} />);
    const strong = container.querySelector('tbody tr td strong');
    expect(strong?.textContent).toContain('文科生指挥AI军队');
  });

  it('keeps table-cell bold parsing stable when another cell also has CJK bold', () => {
    const md = `| 事件 | 简述 | 适用话题 | 论证角度 |
|------|------|----------|----------|
| **“文科生指挥AI军队”项目引爆GitHub榜** [搜索-1] | 简述 | 话题 | 1. **跨界融合**：说明学科边界正在模糊。 |`;
    const { container } = render(<MarkdownRenderer content={md} />);
    const firstCellStrong = container.querySelector('tbody tr td strong');
    expect(firstCellStrong?.textContent).toContain('文科生指挥AI军队');
  });

  it('keeps app-root image URLs unchanged', () => {
    const { container } = render(<MarkdownRenderer content="![DeepSeek](/icons/providers/deepseek.svg)" />);
    const image = container.querySelector('img');

    expect(image?.getAttribute('src')).toBe('/icons/providers/deepseek.svg');
  });
});
