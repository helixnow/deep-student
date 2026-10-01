import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { StreamingBlockRenderer } from '../StreamingBlockRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://mock${path}`,
}));

describe('streaming completion preserves rendered content', () => {
  it('retains the existing paragraph when a block closes and streaming ends', () => {
    const { container, rerender } = render(
      <StreamingBlockRenderer content="First paragraph." isStreaming />,
    );
    const firstParagraph = container.querySelector('.stream-block p');
    expect(firstParagraph).not.toBeNull();

    rerender(<StreamingBlockRenderer content={'First paragraph.\n\nSecond paragraph.'} isStreaming />);
    expect(container.querySelector('.stream-block p')).toBe(firstParagraph);

    rerender(<StreamingBlockRenderer content={'First paragraph.\n\nSecond paragraph.'} isStreaming={false} />);
    expect(container.querySelector('.stream-block p')).toBe(firstParagraph);
    expect(container.querySelector('.flowtoken-markdown')).toBeNull();
  });

  it('preserves citation interactions when streaming ends', () => {
    const onCitationClick = vi.fn();
    const { container, rerender } = render(
      <StreamingBlockRenderer content="See [知识库-1]" isStreaming onCitationClick={onCitationClick} />,
    );
    expect(container.querySelector('[data-citation-anchor] button')).not.toBeNull();

    rerender(
      <StreamingBlockRenderer content="See [知识库-1]" isStreaming={false} onCitationClick={onCitationClick} />,
    );
    const citation = container.querySelector('[data-citation-anchor] button') as HTMLElement | null;
    expect(citation).not.toBeNull();
    citation!.click();
    expect(onCitationClick).toHaveBeenCalledWith('rag', 1);
  });

  it.each([StreamingBlockRenderer, StreamingMarkdownRenderer])(
    'does not replay animations when loading completed thinking and content', (Renderer) => {
      const { container } = render(
        <Renderer content={'<thinking>Reasoning.</thinking>\nAnswer.'} isStreaming={false} />,
      );
      expect(container.textContent).toContain('Reasoning.');
      expect(container.textContent).toContain('Answer.');
      expect(container.querySelector('.flowtoken-markdown')).toBeNull();
    },
  );

  it('keeps completed parsed-main blocks cached while the last block grows', () => {
    const parsed = vi.fn();
    const extraRemarkPlugins = [() => (tree: any) => {
      for (const child of tree.children ?? []) {
        parsed(child.children?.map((node: any) => node.value ?? '').join(''));
      }
    }];
    const { rerender } = render(
      <StreamingMarkdownRenderer
        content={'<thinking>Reasoning.</thinking>\nFirst paragraph.\n\nSecond'}
        isStreaming
        extraRemarkPlugins={extraRemarkPlugins}
      />,
    );
    const firstParagraphParses = parsed.mock.calls.filter(([text]) => text === 'First paragraph.').length;
    expect(firstParagraphParses).toBeGreaterThan(0);

    rerender(
      <StreamingMarkdownRenderer
        content={'<thinking>Reasoning.</thinking>\nFirst paragraph.\n\nSecond paragraph grows.'}
        isStreaming
        extraRemarkPlugins={extraRemarkPlugins}
      />,
    );
    expect(parsed.mock.calls.filter(([text]) => text === 'First paragraph.')).toHaveLength(firstParagraphParses);
  });
});
