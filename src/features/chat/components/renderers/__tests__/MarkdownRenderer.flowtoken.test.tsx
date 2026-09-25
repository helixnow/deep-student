import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';
import { StreamingBlockRenderer } from '../StreamingBlockRenderer';
import { FlowTokenMarkdownRenderer, preloadFlowToken } from '../FlowTokenMarkdownRenderer';
import { ThinkingBlock } from '../../../plugins/blocks/thinking';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://mock${path}`,
}));

// flowtoken 现为懒加载（依赖收敛 R4）；预载后所有断言保持同步语义。
beforeAll(async () => {
  await preloadFlowToken();
});

const FLOWTOKEN_ANIMATION_SELECTOR =
  '[style*="animation-name: ft-fadeIn"]';

describe('MarkdownRenderer flowtoken streaming animation', () => {
  it('does not emit flowtoken spans from MarkdownRenderer in streaming mode', () => {
    const { container } = render(<MarkdownRenderer content="流式输出正在变得更自然。" isStreaming />);

    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).toBeNull();
  });

  it('does not add flowtoken animation spans for completed prose', () => {
    const { container } = render(<MarkdownRenderer content="流式输出已经完成。" isStreaming={false} />);

    expect(container.querySelector('[style*="animation-name: ft-fadeIn"]')).toBeNull();
  });

  it('FlowTokenMarkdownRenderer animates streaming prose with flowtoken diff spans', () => {
    const { container } = render(<FlowTokenMarkdownRenderer content="流式输出正在变得更自然。" isStreaming />);

    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).not.toBeNull();
  });

  it('keeps fenced code blocks out of the flowtoken text animation path', () => {
    const { container } = render(
      <MarkdownRenderer content={'```ts\nconst answer = 42;\n```'} isStreaming />
    );

    expect(container.querySelector('pre [style*="animation-name: ft-fadeIn"]')).toBeNull();
  });

  // 流式与完成态使用同一 Markdown 管线；专用 flowtoken 组件单独测试。

  it('uses the main pipeline (no flowtoken) for the active streaming block', () => {
    const { container } = render(
      <StreamingBlockRenderer content="当前聊天流式块正在输出。" isStreaming />
    );

    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).toBeNull();
    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('false');
    // 主管线接管：内容仍完整渲染
    expect(container.textContent).toContain('当前聊天流式块正在输出。');
  });

  it('keeps the block on the main pipeline once streaming ends', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content="当前聊天流式块正在输出。" isStreaming />
    );
    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('false');

    rerender(<StreamingBlockRenderer content="当前聊天流式块正在输出。" isStreaming={false} />);

    expect(container.querySelector('.stream-block .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.stream-block .markdown-content')).not.toBeNull();
  });

  it('renders streaming lists through the main pipeline while streaming', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'- 第一项\n- 第二项'} isStreaming />
    );

    // 流式期间不走 flowtoken（无 ft-custom-li），主管线渲染列表
    expect(container.querySelector('li.ft-custom-li')).toBeNull();
    expect(container.querySelector('li')).not.toBeNull();
  });

  it('does not use flowtoken fade-in for the streaming thinking chain', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'<thinking>先想一想</thinking>\n最终答案'} isStreaming />
    );

    expect(container.querySelector('.chain-of-thought [style*="animation-name: ft-fadeIn"]')).toBeNull();
    // 思维链内容仍由主管线渲染
    expect(container.querySelector('.chain-of-thought .markdown-content')).not.toBeNull();
  });

  it('keeps the thinking chain on the main pipeline after streaming ends', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content={'<thinking>先想一想</thinking>\n最终答案'} isStreaming />
    );
    expect(container.querySelector('.chain-of-thought .flowtoken-markdown')).toBeNull();

    rerender(
      <StreamingBlockRenderer content={'<thinking>先想一想</thinking>\n最终答案'} isStreaming={false} />
    );

    expect(container.querySelector('.chain-of-thought .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.chain-of-thought .markdown-content')).not.toBeNull();
  });

  it('routes streaming main content with thinking tags through the main pipeline', () => {
    const { container } = render(
      <StreamingMarkdownRenderer content={'<thinking>先想一想</thinking>\n最终答案正在输出。'} isStreaming />
    );

    expect(container.querySelector('.main-content .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.main-content .markdown-content')).not.toBeNull();
  });

  it('routes standalone streaming thinking blocks through the main pipeline', () => {
    const { container } = render(
      <ThinkingBlock
        block={{
          id: 'thinking-1',
          type: 'thinking',
          status: 'running',
          messageId: 'message-1',
          content: '先拆解问题，再组织答案。',
        }}
        isStreaming
      />
    );

    expect(container.querySelector('.think-content .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.think-content [style*="animation-name: ft-fadeIn"]')).toBeNull();
    expect(container.textContent).toContain('先拆解问题，再组织答案。');
  });

  it('does not use flowtoken for citation-like streaming blocks while streaming', () => {
    const { container } = render(
      <StreamingBlockRenderer content="参考这个结论 [知识库-1]" isStreaming />
    );

    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('false');
  });

  it('keeps streaming blocks on the main pipeline while content grows', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content="参考这个结论 [知识库-1]" isStreaming />
    );

    rerender(
      <StreamingBlockRenderer content="参考这个结论 [知识库-1]，并继续补充说明。" isStreaming />
    );

    const block = container.querySelector('.stream-block');
    expect(block?.getAttribute('data-flowtoken')).toBe('false');
    expect(block?.getAttribute('data-motion-layer')).toBe('inline');
    expect(container.textContent).toContain('并继续补充说明。');
  });

  it('keeps the stream stable on dangling markdown text in the streaming main pipeline', () => {
    const { container } = render(
      <StreamingBlockRenderer content="看看这个半截链接 [还没补完" isStreaming />
    );

    // 主管线流式预处理（sanitizeDanglingMarkdown）会剥除未闭合的半截链接
    // 标记，渲染保持稳定不崩溃、已闭合的前文完整保留
    expect(container.textContent).toContain('看看这个半截链接');
    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('false');
  });

  it('renders bare LaTeX streaming blocks through the main pipeline', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'score(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}'} isStreaming />
    );

    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('false');
    expect(container.querySelector('.flowtoken-markdown')).toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps bare LaTeX in the streaming thinking chain static', () => {
    const { container } = render(
      <StreamingBlockRenderer
        content={'<thinking>先想一想\nscore(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.chain-of-thought .markdown-content')).not.toBeNull();
    expect(container.querySelector('.chain-of-thought [style*="animation-name: ft-fadeIn"]')).toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps multiline thinking content static while preserving markdown rendering', () => {
    const { container } = render(
      <StreamingBlockRenderer
        content={'<thinking>先想一想\n第二行继续说明</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.chain-of-thought .markdown-content')).not.toBeNull();
    expect(container.querySelector('.chain-of-thought [style*="animation-name: ft-fadeIn"]')).toBeNull();
  });

  it('keeps multiline parsed thinking content static in StreamingMarkdownRenderer', () => {
    const { container } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>先想一想\n第二行继续说明</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.thinking-content .markdown-content')).not.toBeNull();
    expect(container.querySelector('.thinking-content [style*="animation-name: ft-fadeIn"]')).toBeNull();
  });

  it('keeps parsed streaming main content static when markdown fallback is required', () => {
    const { container } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>先想一想</thinking>\\nscore(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}'}
        isStreaming
      />
    );

    expect(container.querySelector('.main-content .markdown-content')).not.toBeNull();
    expect(container.querySelector('.main-content [style*="animation-name: ft-fadeIn"]')).toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps bare LaTeX in the parsed thinking chain static', () => {
    const { container } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>先想一想\nscore(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.thinking-content .markdown-content')).not.toBeNull();
    expect(container.querySelector('.thinking-content [style*="animation-name: ft-fadeIn"]')).toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('preserves the paragraph node while text grows and streaming ends', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content="第一句" isStreaming />
    );
    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).toBeNull();
    const paragraph = container.querySelector('.stream-block p');

    rerender(<StreamingBlockRenderer content="第一句第二句" isStreaming />);
    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).toBeNull();
    expect(container.textContent).toContain('第一句第二句');
    expect(container.querySelector('.stream-block p')).toBe(paragraph);

    rerender(<StreamingBlockRenderer content="第一句第二句" isStreaming={false} />);
    expect(container.querySelector('.stream-block p')).toBe(paragraph);
    expect(container.querySelector('.stream-block .flowtoken-markdown')).toBeNull();
  });

  it('renders flowtoken spans with the slower demo-like timing', () => {
    const { container } = render(
      <FlowTokenMarkdownRenderer content="更顺滑的流式输出。" isStreaming />
    );

    const animatedSpan = container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR);
    expect(animatedSpan).not.toBeNull();
    expect(animatedSpan).toHaveStyle('animation-duration: 0.35s');
    expect(animatedSpan).toHaveStyle('animation-timing-function: ease-out');
  });

  it('renders streaming updates directly without buffering them', () => {
    const { container, rerender } = render(
      <FlowTokenMarkdownRenderer
        content="Alpha"
        isStreaming
      />
    );

    rerender(
      <FlowTokenMarkdownRenderer
        content="Alpha beta gamma delta epsilon zeta eta theta."
        isStreaming
      />
    );

    expect(container.textContent).toContain('Alpha beta gamma delta epsilon zeta eta theta.');
    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).not.toBeNull();
  });
});
