import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { saveTextFile, saveBinaryFile, copyText, saveSvgAsPngMock, openUrlMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(),
  saveTextFile: vi.fn(),
  saveBinaryFile: vi.fn(),
  copyText: vi.fn(),
  saveSvgAsPngMock: vi.fn(),
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: { saveTextFile, saveBinaryFile },
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: copyText,
}));

vi.mock('@/utils/urlOpener', () => ({
  openUrl: openUrlMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../codeBlockExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codeBlockExport')>()),
  saveSvgAsPng: saveSvgAsPngMock,
}));

import { CodeBlock } from '../CodeBlock';
import { SVG_STREAM_INTERVAL_MS } from '../useProgressiveSvg';
import { HTML_PREVIEW_STREAM_INTERVAL_MS } from '@/components/previews/ChatHtmlPreview';

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">';
const RECT_A = '<rect x="0" y="0" width="10" height="10"/>';
const RECT_B = '<rect x="20" y="0" width="10" height="10"/>';

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /更多操作|More actions/ }));
const menuItem = (name: RegExp) => screen.getByRole('menuitem', { name });

beforeEach(() => {
  saveTextFile.mockReset().mockResolvedValue({ canceled: false, path: '/tmp/x' });
  saveBinaryFile.mockReset().mockResolvedValue({ canceled: false, path: '/tmp/x.png' });
  copyText.mockReset().mockResolvedValue(undefined);
  saveSvgAsPngMock.mockReset().mockResolvedValue({ canceled: false, path: '/tmp/x.png' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CodeBlock SVG live preview', () => {
  it('renders progressively while streaming and finalizes without remounting the preview', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CodeBlock className="language-svg" isStreaming>{`${SVG_HEAD}${RECT_A}<rect x="2`}</CodeBlock>,
    );
    const preview = container.querySelector('.mermaid-preview');
    expect(preview).not.toBeNull();
    expect(container.querySelectorAll('.mermaid-content svg rect')).toHaveLength(1);
    // 源码视图未出现
    expect(container.querySelector('pre.code-block')).toBeNull();

    rerender(<CodeBlock className="language-svg" isStreaming>{`${SVG_HEAD}${RECT_A}${RECT_B}`}</CodeBlock>);
    // 节流窗口内保持上一帧
    expect(container.querySelectorAll('.mermaid-content svg rect')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(SVG_STREAM_INTERVAL_MS + 5); });
    expect(container.querySelectorAll('.mermaid-content svg rect')).toHaveLength(2);

    rerender(
      <CodeBlock className="language-svg" isStreaming={false}>{`${SVG_HEAD}${RECT_A}${RECT_B}<circle r="3"/></svg>`}</CodeBlock>,
    );
    expect(container.querySelector('.mermaid-preview')).toBe(preview);
    expect(container.querySelector('.mermaid-content svg circle')).not.toBeNull();
  });

  it('shows a pending placeholder until the root tag is complete', () => {
    const { container } = render(<CodeBlock className="language-svg" isStreaming>{'<svg viewBox="0 0'}</CodeBlock>);
    expect(container.querySelector('.code-block-preview-pending')).not.toBeNull();
    expect(container.querySelector('.mermaid-content')).toBeNull();
  });

  it('falls back to source when a finished block has no renderable svg', () => {
    const { container } = render(<CodeBlock className="language-svg">{'not an svg'}</CodeBlock>);
    expect(container.querySelector('.mermaid-preview')).toBeNull();
    expect(container.querySelector('pre.code-block')?.textContent).toContain('not an svg');
  });

  it('strips active content from rendered svg', () => {
    const { container } = render(
      <CodeBlock className="language-svg">{`${SVG_HEAD}<script>alert(1)</script><rect onclick="x()"/></svg>`}</CodeBlock>,
    );
    expect(container.querySelector('.mermaid-content script')).toBeNull();
    expect(container.querySelector('.mermaid-content rect')?.getAttribute('onclick')).toBeNull();
  });

  it('replaces copy/source buttons with a more menu offering download, image, copy and view code', async () => {
    const source = `<svg viewBox="0 0 10 10">${RECT_A}</svg>`;
    const { container } = render(<CodeBlock className="language-svg">{source}</CodeBlock>);
    expect(screen.queryByRole('button', { name: /^复制$|^Copy$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /放大|Zoom in/i })).toBeInTheDocument();

    openMenu();
    await act(async () => { fireEvent.click(menuItem(/复制代码|Copy code/)); });
    expect(copyText).toHaveBeenCalledWith(source);

    openMenu();
    await act(async () => { fireEvent.click(menuItem(/^下载$|^Download$/)); });
    expect(saveTextFile).toHaveBeenCalledTimes(1);
    const textArgs = saveTextFile.mock.calls[0][0];
    expect(textArgs.content).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(textArgs.filters[0].extensions).toEqual(['svg']);

    openMenu();
    await act(async () => { fireEvent.click(menuItem(/保存为图片|Save as image/)); });
    expect(saveSvgAsPngMock).toHaveBeenCalledWith(source);

    openMenu();
    fireEvent.click(menuItem(/查看代码|View code/));
    expect(container.querySelector('.mermaid-preview')).toBeNull();
    expect(container.querySelector('pre.code-block')?.textContent).toContain('<rect');
    openMenu();
    fireEvent.click(menuItem(/查看预览|View preview/));
    expect(container.querySelector('.mermaid-preview')).not.toBeNull();
  });

  it('disables download and image export while streaming', () => {
    render(<CodeBlock className="language-svg" isStreaming>{`${SVG_HEAD}${RECT_A}`}</CodeBlock>);
    openMenu();
    expect(menuItem(/^下载$|^Download$/)).toBeDisabled();
    expect(menuItem(/保存为图片|Save as image/)).toBeDisabled();
    expect(menuItem(/复制代码|Copy code/)).not.toBeDisabled();
  });
});

const PAGE_HEAD = '<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body>';

describe('CodeBlock HTML live preview', () => {
  it('previews full documents in a script-free sandbox and flags ignored scripts', () => {
    const { container } = render(
      <CodeBlock className="language-html">{`${PAGE_HEAD}<p class="a">hi</p><script>x()</script></body></html>`}</CodeBlock>,
    );
    const frame = container.querySelector('iframe.chat-html-preview-frame');
    expect(frame).not.toBeNull();
    // 同源（父页面测量/拦截链接）但绝不允许脚本
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame?.getAttribute('sandbox')).not.toMatch(/allow-scripts/);
    expect(frame?.getAttribute('srcdoc')).toContain('<p class="a">hi</p>');
    expect(frame?.getAttribute('srcdoc')).not.toContain('x()');
    expect(screen.getByText(/脚本未运行|Scripts not run/)).toBeInTheDocument();
  });

  it('updates progressively behind the visible frame and swaps on load', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CodeBlock className="language-html" isStreaming>{`${PAGE_HEAD}<p>one</p><p cl`}</CodeBlock>,
    );
    const front = container.querySelector('iframe[data-state="front"]')!;
    expect(front.getAttribute('srcdoc')).toContain('<p>one</p>');
    expect(front.getAttribute('srcdoc')).not.toContain('<p cl');

    rerender(<CodeBlock className="language-html" isStreaming>{`${PAGE_HEAD}<p>one</p><p>two</p>`}</CodeBlock>);
    act(() => { vi.advanceTimersByTime(HTML_PREVIEW_STREAM_INTERVAL_MS + 5); });
    const loading = container.querySelector('iframe[data-state="loading"]');
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('srcdoc')).toContain('<p>two</p>');
    // 前台帧没有被替换或改写
    expect(container.querySelector('iframe[data-state="front"]')).toBe(front);
    expect(front.getAttribute('srcdoc')).not.toContain('<p>two</p>');

    act(() => { fireEvent.load(loading!); });
    const frames = container.querySelectorAll('iframe.chat-html-preview-frame');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(loading);
    expect(frames[0].getAttribute('data-state')).toBe('front');
  });

  it('keeps plain fragments in source view until preview is requested from the menu', async () => {
    const { container } = render(<CodeBlock className="language-html">{'<ul><li>item</li></ul>'}</CodeBlock>);
    expect(container.querySelector('iframe')).toBeNull();
    openMenu();
    fireEvent.click(menuItem(/查看预览|View preview/));
    expect(container.querySelector('iframe.chat-html-preview-frame')?.getAttribute('srcdoc')).toContain('<li>item</li>');

    openMenu();
    await act(async () => { fireEvent.click(menuItem(/^下载$|^Download$/)); });
    expect(saveTextFile.mock.calls[0][0]).toMatchObject({
      content: '<ul><li>item</li></ul>',
      defaultFileName: 'page.html',
    });
  });

  it('routes link clicks inside the preview to openUrl and sizes the stage to the content', () => {
    openUrlMock.mockReset();
    const { container } = render(
      <CodeBlock className="language-html">{`${PAGE_HEAD}<a id="go" href="https://example.com/doc">doc</a></body></html>`}</CodeBlock>,
    );
    const frame = container.querySelector('iframe.chat-html-preview-frame') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    // jsdom 不加载 srcdoc：手动写入帧文档，模拟加载完成
    doc.body.innerHTML = '<a id="go" href="https://example.com/doc">doc</a>';
    Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 2000 });
    act(() => { fireEvent.load(frame); });

    const stage = container.querySelector('.chat-html-preview-stage') as HTMLElement;
    expect(parseInt(stage.style.height, 10)).toBeLessThan(2000);
    const expand = screen.getByRole('button', { name: /展开预览|Expand preview/ });
    fireEvent.click(expand);
    expect(stage.style.height).toBe('2000px');

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    doc.getElementById('go')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/doc');
  });

  it('keeps the background buffer frame out of focus and the accessibility tree', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CodeBlock className="language-html" isStreaming>{`${PAGE_HEAD}<p>one</p>`}</CodeBlock>,
    );
    rerender(<CodeBlock className="language-html" isStreaming>{`${PAGE_HEAD}<p>one</p><p>two</p>`}</CodeBlock>);
    act(() => { vi.advanceTimersByTime(HTML_PREVIEW_STREAM_INTERVAL_MS + 5); });
    const loading = container.querySelector('iframe[data-state="loading"]')!;
    expect(loading.getAttribute('tabindex')).toBe('-1');
    expect(loading.getAttribute('aria-hidden')).toBe('true');
    expect(loading.hasAttribute('inert')).toBe(true);
    const front = container.querySelector('iframe[data-state="front"]')!;
    expect(front.hasAttribute('inert')).toBe(false);
    expect(front.getAttribute('tabindex')).toBeNull();
  });
});
