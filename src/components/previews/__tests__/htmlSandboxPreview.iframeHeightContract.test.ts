import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 复习卡面的滚动契约（WebKit 专用回归）。
 *
 * 卡面 iframe 的高度就是「测量到的内容高度」，超长卡片由外层 `.wb-fc-card` 的
 * 统一 viewport 滚动（见 ReviewCardSurface 的舞台注释）。这条链路在 WebKit
 * （Tauri Linux 运行时）上有两个必须保住的约束：
 *
 * 1. iframe 不能被 flex 宿主压缩。复习舞台是高度受限的 flex 容器，WebKit 会按
 *    默认 `flex-shrink: 1` 把 iframe 压回容器高度（Chromium 不压）。一旦被压，
 *    宿主没有任何可滚内容，OverlayScrollbars 把滚动条判为 unusable 而不显示，
 *    内容被挤进 iframe 自身文档——长模板卡完全没有滚动条。
 * 2. 交互式卡面（含 details / 音频 / 链接 / 脚本）的 iframe 会接管指针事件，
 *    WebKit 不会把 iframe 里的滚轮链回宿主，宿主统一 viewport 收不到滚轮。
 *    卡面辅助脚本因此把「文档自己滚不动」的滚轮转发成 `sdp-wheel`，由卡面
 *    落到统一 viewport 上。
 *
 * jsdom 没有布局引擎，无法用渲染断言覆盖，因此这里锁住源码里的这两条约束。
 */
describe('HtmlSandboxPreview iframe 高度契约', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/previews/HtmlSandboxPreview.tsx'),
    'utf-8',
  );

  it('iframe 不被 flex 宿主压缩（否则 WebKit 下复习卡面无滚动条也滚不动）', () => {
    expect(source).toContain('flexShrink: 0');
  });

  it('iframe 高度跟随内容测量值，宿主负责滚动', () => {
    expect(source).toContain('Math.max(iframeHeight, minHeight ?? 0)');
    expect(source).toContain("overflow: 'auto'");
  });

  it('转发 iframe 内滚不动的滚轮（sdp-wheel）', () => {
    expect(source).toContain("data.type === 'sdp-wheel'");
    expect(source).toContain('onFrameWheel');
  });
});

describe('卡面滚轮转发链路', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');

  it('沙箱辅助脚本在文档滚不动时发出 sdp-wheel', () => {
    const media = read('src/components/anki/utils/cardMedia.ts');
    expect(media).toContain("type: 'sdp-wheel'");
    // 只在文档自身滚不动时转发，避免与原生滚动双重滚动
    expect(media).toContain('canScroll(document.body, dy)');
  });

  it('交互式卡面才把 onFrameWheel 传进 iframe', () => {
    const face = read('src/components/anki/AnkiTemplateCardFace.tsx');
    expect(face).toContain('onFrameWheel={frameInteractive ? onFrameWheel : undefined}');
  });

  it('复习卡面把转发来的滚轮落到统一 viewport', () => {
    const surface = read('src/features/flashcards/review/ReviewCardSurface.tsx');
    expect(surface).toContain('onFrameWheel={handleFrameWheel}');
    expect(surface).toContain('scrollElement.scrollBy(0, deltaY * factor)');
  });
});
