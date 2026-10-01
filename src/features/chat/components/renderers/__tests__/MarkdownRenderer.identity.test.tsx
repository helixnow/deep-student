import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPdfPageCache, MarkdownRenderer } from '../MarkdownRenderer';

const runtime = vi.hoisted(() => ({
  capabilities: {
    chemicalStructures: true,
    charts: false,
    graphviz: false,
    music: false,
    timing: false,
    chemicalFiles: false,
    molecular3d: false,
    geojson: false,
  },
  fetchPage: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('../rendererCapabilities', () => ({
  useRendererCapabilities: () => runtime.capabilities,
}));

vi.mock('../CodeBlock', () => ({
  CodeBlock: ({ children, isStreaming, rendererCapabilities }: any) => {
    const [clicks, setClicks] = React.useState(0);
    return (
      <div data-testid="code-block" data-streaming={isStreaming} data-charts={rendererCapabilities.charts}>
        <button onClick={() => setClicks((value) => value + 1)}>code state {clicks}</button>
        <pre><code>{children}</code></pre>
      </div>
    );
  },
}));

vi.mock('@/features/chat/plugins/blocks/components/CitationPopover', () => ({
  CitationBadgeWithPopover: ({ citationIndex, onNavigate }: any) => (
    <button onClick={onNavigate}>citation {citationIndex}</button>
  ),
}));

vi.mock('@/features/chat/components/MindmapCitationCard', () => ({
  MindmapCitationCard: () => <div>mindmap</div>,
}));

vi.mock('../InlineSmiles', () => ({
  InlineSmiles: ({ smiles }: { smiles: string }) => <span className="inline-smiles">{smiles}</span>,
}));

vi.mock('@/api/vfsRagApi', () => ({ getPdfPageImageDataUrl: runtime.fetchPage }));
vi.mock('@/utils/urlOpener', () => ({ openUrl: runtime.openUrl }));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('../lazyKatex', () => ({
  getLoadedKatex: () => null,
  ensureKatexLoaded: vi.fn(),
  scheduleKatexIdlePrefetch: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  clearPdfPageCache();
  runtime.capabilities = { ...runtime.capabilities, charts: false, chemicalStructures: true };
});

describe('MarkdownRenderer component identity', () => {
  it('keeps existing DOM and code state while updating content, streaming state and capabilities', () => {
    const content = '开头\n\n```ts\nconst answer = 41;\n```\n\n| 项目 |\n| --- |\n| 内容 |\n\n\\smiles{CCO}';
    const { container, getByRole, getByTestId, rerender } = render(
      <MarkdownRenderer content={content} isStreaming />,
    );
    const paragraph = container.querySelector('p');
    const table = container.querySelector('table');
    const codeBlock = getByTestId('code-block');
    const stateButton = getByRole('button', { name: 'code state 0' });
    fireEvent.click(stateButton);

    runtime.capabilities = { ...runtime.capabilities, charts: true, chemicalStructures: false };
    rerender(<MarkdownRenderer content={`${content.replace('41', '42')}\n\n继续输出`} isStreaming={false} />);

    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('table')).toBe(table);
    expect(getByTestId('code-block')).toBe(codeBlock);
    expect(getByRole('button', { name: 'code state 1' })).toBe(stateButton);
    expect(codeBlock).toHaveAttribute('data-streaming', 'false');
    expect(codeBlock).toHaveAttribute('data-charts', 'true');
    expect(codeBlock).toHaveTextContent('const answer = 42;');
    expect(container.querySelector('.inline-smiles')).toBeNull();
    expect(container.textContent).toContain('\\smiles{CCO}');
  });

  it('preserves image error state through a streaming append and retries only when its URL changes', () => {
    const { container, rerender } = render(<MarkdownRenderer content="![figure](/figure.png)" isStreaming />);
    fireEvent.error(container.querySelector('img')!);
    const fallback = container.querySelector('.markdown-img-fallback');
    expect(fallback).not.toBeNull();

    rerender(<MarkdownRenderer content={'![figure](/figure.png)\n\n后续文字'} isStreaming />);
    expect(container.querySelector('.markdown-img-fallback')).toBe(fallback);
    expect(container.querySelector('img')).toBeNull();

    rerender(<MarkdownRenderer content={'![figure](/replacement.png)\n\n后续文字'} isStreaming />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/replacement.png');
    expect(container.querySelector('.markdown-img-fallback')).toBeNull();
  });

  it('uses current callbacks without remounting links or sharing handlers between renderer instances', () => {
    const oldLink = vi.fn();
    const nextLink = vi.fn();
    const oldCitation = vi.fn();
    const nextCitation = vi.fn();
    const otherLink = vi.fn();
    const content = '[first](https://example.com/first) [知识库-1]';
    const tree = (onLinkClick: typeof oldLink, onCitationClick: typeof oldCitation) => (
      <>
        <MarkdownRenderer content={content} onLinkClick={onLinkClick} onCitationClick={onCitationClick} />
        <MarkdownRenderer content="[other](https://example.com/other)" onLinkClick={otherLink} />
      </>
    );
    const { getByRole, rerender } = render(tree(oldLink, oldCitation));
    const link = getByRole('link', { name: 'first' });
    const citation = getByRole('button', { name: 'citation 1' });

    rerender(tree(nextLink, nextCitation));
    expect(getByRole('link', { name: 'first' })).toBe(link);
    expect(getByRole('button', { name: 'citation 1' })).toBe(citation);
    fireEvent.click(link);
    fireEvent.click(citation);
    fireEvent.click(getByRole('link', { name: 'other' }));
    expect(oldLink).not.toHaveBeenCalled();
    expect(oldCitation).not.toHaveBeenCalled();
    expect(nextLink).toHaveBeenCalledWith('https://example.com/first');
    expect(nextCitation).toHaveBeenCalledWith('rag', 1);
    expect(otherLink).toHaveBeenCalledWith('https://example.com/other');
  });

  it('keeps a pending PDF image request and accepts a replacement direct URL without stale loading state', async () => {
    let resolvePage!: (value: string) => void;
    runtime.fetchPage.mockReturnValueOnce(new Promise<string>((resolve) => { resolvePage = resolve; }));
    const resolvePdf = () => ({ resourceId: 'file_identity_pdf', pageIndex: 0 });
    const { container, rerender } = render(
      <MarkdownRenderer content="[知识库-1:图片]" resolveCitationImage={resolvePdf} isStreaming />,
    );
    const loading = container.querySelector('.citation-inline-image-loading');
    expect(loading).not.toBeNull();
    expect(runtime.fetchPage).toHaveBeenCalledTimes(1);

    rerender(<MarkdownRenderer content={'[知识库-1:图片]\n\n补充'} resolveCitationImage={resolvePdf} isStreaming />);
    expect(container.querySelector('.citation-inline-image-loading')).toBe(loading);
    expect(runtime.fetchPage).toHaveBeenCalledTimes(1);

    rerender(
      <MarkdownRenderer
        content={'[知识库-1:图片]\n\n补充'}
        resolveCitationImage={() => ({ url: 'https://example.com/direct.png', title: 'direct' })}
        isStreaming={false}
      />,
    );
    expect(container.querySelector('.citation-inline-image-loading')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/direct.png');
    await act(async () => { resolvePage('data:image/png;base64,old'); });
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/direct.png');
  });
});
