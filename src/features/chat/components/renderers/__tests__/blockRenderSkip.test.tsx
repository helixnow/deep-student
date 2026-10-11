/**
 * 块级渲染跳过开关与 WebKit 前台恢复兜底测试（#470）
 *
 * 契约：
 * 1. 虚拟行内（BlockRenderSkipContext=false）不挂 content-visibility，行高测量不被占位值污染；
 * 2. 前台恢复兜底只在 WebKit 内核安装（WebView2/Chromium 不装），且只翻转视口内的块，
 *    同一帧内的 visibilitychange + focus 合并为一次。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { StreamingBlockRenderer } from '../StreamingBlockRenderer';
import {
  BlockRenderSkipContext,
  collectBlocksInViewport,
  installContentVisibilityRefresh,
  isWebKitEngine,
} from '../blockRenderSkip';

const UA_WEBVIEW2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const UA_CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const UA_WKWEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const UA_WEBKITGTK = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function makeBlock(top: number, height = 100): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stream-block';
  el.style.contentVisibility = 'auto';
  el.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}),
  });
  return el;
}

describe('isWebKitEngine', () => {
  it('区分 WebKit 内核与 Chromium 系', () => {
    expect(isWebKitEngine(UA_WKWEBVIEW)).toBe(true);
    expect(isWebKitEngine(UA_WEBKITGTK)).toBe(true);
    expect(isWebKitEngine(UA_WEBVIEW2)).toBe(false);
    expect(isWebKitEngine(UA_CHROME_MAC)).toBe(false);
  });
});

describe('collectBlocksInViewport', () => {
  it('只返回视口（含余量）内的块', () => {
    const root = document.createElement('div');
    const above = makeBlock(-500);
    const visible = makeBlock(100);
    const nearBelow = makeBlock(850);
    const farBelow = makeBlock(3000);
    root.append(above, visible, nearBelow, farBelow);
    expect(collectBlocksInViewport(root, 800)).toEqual([visible]);
    expect(collectBlocksInViewport(root, 800, 400)).toEqual([above, visible, nearBelow]);
  });
});

describe('installContentVisibilityRefresh', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn());
    document.body.innerHTML = '';
  });

  function fakeWindow(userAgent: string) {
    const frames: FrameRequestCallback[] = [];
    const win = Object.assign(new EventTarget(), {
      document,
      navigator: { userAgent },
      innerHeight: 800,
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => { frames.push(cb); return frames.length; }),
    });
    const flushFrame = () => frames.splice(0).forEach((cb) => cb(0));
    return { win: win as unknown as Window, flushFrame, raf: win.requestAnimationFrame };
  }

  it('Chromium / WebView2 不安装（最小化恢复不再全量翻转）', () => {
    const { win } = fakeWindow(UA_WEBVIEW2);
    expect(installContentVisibilityRefresh(win)).toBeNull();
  });

  it('WebKit：只翻转视口内的块，focus + visibilitychange 合并为一次', () => {
    const { win, flushFrame, raf } = fakeWindow(UA_WKWEBVIEW);
    const visible = makeBlock(100);
    const offscreen = makeBlock(5000);
    document.body.append(visible, offscreen);

    const cleanup = installContentVisibilityRefresh(win);
    expect(cleanup).not.toBeNull();
    cleanups.push(cleanup!);

    win.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(raf).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(visible.style.contentVisibility).toBe('visible');
    expect(offscreen.style.contentVisibility).toBe('auto');

    flushFrame();
    expect(visible.style.contentVisibility).toBe('auto');
  });
});

describe('BlockRenderSkipContext', () => {
  it('虚拟行内（context=false）已完成块不挂 content-visibility', () => {
    const content = '# 标题\n\n第一段内容。\n\n收尾段落。';
    const { container } = render(
      <BlockRenderSkipContext.Provider value={false}>
        <StreamingBlockRenderer content={content} isStreaming={false} />
      </BlockRenderSkipContext.Provider>,
    );
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.stream-block'));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block.getAttribute('style') ?? '').not.toContain('content-visibility');
    }
  });
});
