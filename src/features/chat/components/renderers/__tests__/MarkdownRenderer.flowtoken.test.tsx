import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';
import { StreamingBlockRenderer } from '../StreamingBlockRenderer';
import { FlowTokenMarkdownRenderer } from '../FlowTokenMarkdownRenderer';
import { ThinkingBlock } from '../../../plugins/blocks/thinking';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://mock${path}`,
}));

const FLOWTOKEN_ANIMATION_SELECTOR =
  '[style*="animation-name: ft-fadeIn"]';

describe('MarkdownRenderer flowtoken streaming animation', () => {
  it('does not emit flowtoken spans from MarkdownRenderer (AnimatedMarkdown handles animation)', () => {
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

  it('uses the same flowtoken animation path in streaming block mode', () => {
    const { container } = render(
      <StreamingBlockRenderer content="当前聊天流式块正在输出。" isStreaming />
    );

    expect(container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR)).not.toBeNull();
  });

  it('uses flowtoken markdown list styling for supported streaming blocks', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'- 第一项\n- 第二项'} isStreaming />
    );

    expect(container.querySelector('li.ft-custom-li')).not.toBeNull();
  });

  it('uses flowtoken fade-in for the streaming thinking chain', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'<thinking>先想一想</thinking>\n最终答案'} isStreaming />
    );

    expect(container.querySelector('.chain-of-thought [style*="animation-name: ft-fadeIn"]')).not.toBeNull();
  });

  it('routes streaming main content with thinking tags through the full flowtoken renderer', () => {
    const { container } = render(
      <StreamingMarkdownRenderer content={'<thinking>先想一想</thinking>\n最终答案正在输出。'} isStreaming />
    );

    expect(container.querySelector('.main-content .flowtoken-markdown')).not.toBeNull();
  });

  it('routes standalone streaming thinking blocks through the full flowtoken renderer', () => {
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

    expect(container.querySelector('.think-content .flowtoken-markdown')).not.toBeNull();
    expect(container.querySelector('.think-content [style*="animation-name: ft-fadeIn"]')).not.toBeNull();
  });

  it('uses flowtoken for citation-like streaming blocks (content gate removed)', () => {
    const { container } = render(
      <StreamingBlockRenderer content="参考这个结论 [知识库-1]" isStreaming />
    );

    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('true');
  });

  it('keeps streaming blocks on flowtoken while content grows (content gate removed)', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content="参考这个结论 [知识库-1]" isStreaming />
    );

    rerender(
      <StreamingBlockRenderer content="参考这个结论 [知识库-1]，并继续补充说明。" isStreaming />
    );

    const block = container.querySelector('.stream-block');
    expect(block?.getAttribute('data-flowtoken')).toBe('true');
    expect(block?.getAttribute('data-motion-layer')).toBe('inline');
  });

  it('keeps dangling markdown text visible in the flowtoken streaming path', () => {
    const { container } = render(
      <StreamingBlockRenderer content="看看这个半截链接 [还没补完" isStreaming />
    );

    expect(container.textContent).toContain('[还没补完');
    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('true');
  });

  it('uses flowtoken for bare LaTeX streaming blocks (content gate removed)', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'score(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}'} isStreaming />
    );

    expect(container.querySelector('.stream-block')?.getAttribute('data-flowtoken')).toBe('true');
    expect(container.querySelector('.flowtoken-markdown')).not.toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps bare LaTeX out of the streaming thinking-chain flowtoken path', () => {
    const { container } = render(
      <StreamingBlockRenderer
        content={'<thinking>先想一想\nscore(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.chain-of-thought .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.chain-of-thought .markdown-content')).not.toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps multiline thinking content on the markdown renderer even when it is plain text', () => {
    const { container } = render(
      <StreamingBlockRenderer
        content={'<thinking>先想一想\n第二行继续说明</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.chain-of-thought .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.chain-of-thought .markdown-content')).not.toBeNull();
  });

  it('keeps multiline parsed thinking content on the markdown renderer in StreamingMarkdownRenderer', () => {
    const { container } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>先想一想\n第二行继续说明</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.thinking-content .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.thinking-content .markdown-content')).not.toBeNull();
  });

  it('does not route parsed streaming main content with bare LaTeX through full flowtoken', () => {
    const { container } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>先想一想</thinking>\\nscore(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}'}
        isStreaming
      />
    );

    expect(container.querySelector('.main-content .flowtoken-markdown')).toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps bare LaTeX out of the parsed thinking-chain flowtoken path', () => {
    const { container } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>先想一想\nscore(Q, K) = \\\\frac{QK^T}{\\\\sqrt{d_k}}</thinking>\n最终答案'}
        isStreaming
      />
    );

    expect(container.querySelector('.thinking-content .flowtoken-markdown')).toBeNull();
    expect(container.querySelector('.thinking-content .markdown-content')).not.toBeNull();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('keeps the existing animated span node stable while append-only text grows', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content="第一句" isStreaming />
    );

    const firstAnimatedSpan = container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR);
    expect(firstAnimatedSpan).not.toBeNull();

    rerender(<StreamingBlockRenderer content="第一句第二句" isStreaming />);

    const nextAnimatedSpan = container.querySelector(FLOWTOKEN_ANIMATION_SELECTOR);
    expect(nextAnimatedSpan).toBe(firstAnimatedSpan);
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

  it('buffers high-frequency streaming updates before committing them to flowtoken', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'requestAnimationFrame',
      ((callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16)) as typeof requestAnimationFrame,
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof cancelAnimationFrame,
    );

    try {
      const initial = 'Alpha ';
      const target = 'Alpha beta gamma delta epsilon zeta eta theta.';
      const { container, rerender } = render(
        <FlowTokenMarkdownRenderer
          content={initial}
          isStreaming
          streamSmoothingPreset="balanced"
        />
      );

      rerender(
        <FlowTokenMarkdownRenderer
          content={target}
          isStreaming
          streamSmoothingPreset="balanced"
        />
      );

      expect(container.textContent).toContain(initial);
      expect(container.textContent).not.toContain(target);

      vi.advanceTimersByTime(16);
      expect(container.textContent).not.toContain(target);

      vi.advanceTimersByTime(48);
      const partialText = container.textContent ?? '';
      expect(partialText.length).toBeGreaterThan(initial.length);
      expect(partialText.length).toBeLessThan(target.length);

      vi.advanceTimersByTime(2000);
      expect(container.textContent).toContain(target);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
