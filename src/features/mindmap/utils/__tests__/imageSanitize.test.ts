import { describe, expect, it, vi } from 'vitest';
import {
  createImageSanitizeBudget,
  isSafeImageSrc,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_SANITIZED_IMAGE_COUNT,
  sanitizeNodeImages,
} from '../imageSanitize';
import { encodeMindMapClipboard, parseMindMapClipboardPayload } from '../clipboardCodec';
import { importFromJson } from '../importers';
import type { MindMapNode } from '../../types';

// clipboardCodec 静态引用系统剪贴板封装（Tauri 插件），纯函数测试不触达，mock 掉以隔离环境
vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async () => true),
  readTextFromClipboard: vi.fn(async () => ''),
}));

// importers 顶层引 i18next（图片占位文案）；本文件断言不依赖插值结果，给个确定实现
vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('isSafeImageSrc', () => {
  it('accepts whitelisted base64 data URLs and https URLs', () => {
    expect(isSafeImageSrc(PNG_DATA_URL)).toBe(true);
    expect(isSafeImageSrc('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(true);
    expect(isSafeImageSrc('https://example.com/pic.png')).toBe(true);
  });

  it('rejects plaintext http, script schemes and non-image data URLs', () => {
    expect(isSafeImageSrc('http://example.com/pic.png')).toBe(false);
    // eslint-disable-next-line no-script-url
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
    expect(isSafeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    // 非 base64 形态（含逗号后杂质字符）与缺 base64 标记都拒绝
    expect(isSafeImageSrc('data:image/png,rawbytes')).toBe(false);
    expect(isSafeImageSrc('data:image/png;base64,abc def')).toBe(false);
  });

  it('rejects data URLs exceeding the per-image size cap', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS)}`;
    expect(isSafeImageSrc(oversized)).toBe(false);
  });
});

describe('sanitizeNodeImages', () => {
  it('rebuilds entries via whitelist and narrows optional fields', () => {
    const images = sanitizeNodeImages(
      [
        { src: PNG_DATA_URL, name: 'a.png', width: 32, height: '48', extra: 'dropped' },
        { src: 'http://evil.test/x.png', name: 'b.png' },
        'not-an-object',
        { name: 'no-src.png' },
      ],
      createImageSanitizeBudget(),
    );
    expect(images).toEqual([{ src: PNG_DATA_URL, name: 'a.png', width: 32 }]);
  });

  it('returns undefined for non-arrays and fully-invalid lists', () => {
    const budget = createImageSanitizeBudget();
    expect(sanitizeNodeImages(undefined, budget)).toBeUndefined();
    expect(sanitizeNodeImages('data:image/png;base64,AA==', budget)).toBeUndefined();
    expect(sanitizeNodeImages([{ src: 'http://evil.test/x.png' }], budget)).toBeUndefined();
  });

  it('enforces the shared count budget across calls', () => {
    const budget = createImageSanitizeBudget();
    const batch = Array.from({ length: MAX_SANITIZED_IMAGE_COUNT }, () => ({ src: PNG_DATA_URL }));
    expect(sanitizeNodeImages(batch, budget)).toHaveLength(MAX_SANITIZED_IMAGE_COUNT);
    // 预算耗尽后，后续节点（同一份预算）不再保留任何图片
    expect(sanitizeNodeImages([{ src: PNG_DATA_URL }], budget)).toBeUndefined();
  });

  it('enforces the cumulative inline char budget', () => {
    const budget = createImageSanitizeBudget();
    budget.inlineCharsRemaining = PNG_DATA_URL.length;
    const images = sanitizeNodeImages([{ src: PNG_DATA_URL }, { src: PNG_DATA_URL }], budget);
    expect(images).toHaveLength(1);
    // https 引用不占内联预算，仍可保留
    const remote = sanitizeNodeImages([{ src: 'https://example.com/p.png' }], budget);
    expect(remote).toEqual([{ src: 'https://example.com/p.png' }]);
  });
});

describe('clipboardCodec images (M1)', () => {
  const nodeWithImage: MindMapNode = {
    id: 'n1',
    text: 'topic',
    children: [],
    images: [{ src: PNG_DATA_URL, name: 'pic.png', width: 64 }],
  };

  it('keeps node images in the structured payload', () => {
    const encoded = encodeMindMapClipboard([nodeWithImage]);
    expect(encoded).not.toBeNull();
    expect(encoded!.payload.nodes[0].images).toEqual([
      { src: PNG_DATA_URL, name: 'pic.png', width: 64 },
    ]);
    // text/plain 载体不受影响（无图片行，指纹口径不变）
    expect(encoded!.text).toBe('- topic');
  });

  it('strips unsafe image sources from foreign payloads', () => {
    const encoded = encodeMindMapClipboard([nodeWithImage])!;
    const tampered = JSON.parse(JSON.stringify(encoded.payload));
    tampered.nodes[0].images = [
      { src: 'http://evil.test/tracker.png' },
      { src: PNG_DATA_URL },
    ];
    const parsed = parseMindMapClipboardPayload(tampered);
    expect(parsed).not.toBeNull();
    expect(parsed!.nodes[0].images).toEqual([{ src: PNG_DATA_URL }]);
  });
});

describe('importFromJson images (M4)', () => {
  it('sanitizes image sources instead of spreading them through', () => {
    const doc = importFromJson(JSON.stringify({
      version: '1.0',
      root: {
        id: 'root',
        text: 'root',
        images: [
          { src: PNG_DATA_URL, name: 'ok.png' },
          { src: 'http://evil.test/leak.png', name: 'bad.png' },
        ],
        children: [
          { id: 'c1', text: 'child', images: [{ src: 'file:///etc/passwd' }], children: [] },
        ],
      },
    }));
    expect(doc.root.images).toEqual([{ src: PNG_DATA_URL, name: 'ok.png' }]);
    // 全部不合法时字段整体删除，渲染器不会拿到空数组之外的脏值
    expect(doc.root.children[0].images).toBeUndefined();
  });
});
