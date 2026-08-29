/**
 * 图片预览 agent hint i18n 契约（textbook:image_preview）
 *
 * ImageContentView 的 setZoom/rotate agent surface 回调此前硬编码中文 hint；
 * 现改走 textbook:image_preview.* 键（defaultValue 保持主干原文）。
 * 本测试锁定：
 * 1. zh-CN / en-US 的 image_preview 叶子键对齐，zh 文案即主干原文；
 * 2. 源码通过 i18n.t 引用全部四个键，且 defaultValue 与 zh 文案一致
 *    （defaultValue 兜底保证现有测试与未配置 locale 时行为不变）；
 * 3. 源码不再以字面量形式硬编码这批 hint。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhTextbook from '@/locales/zh-CN/textbook.json';
import enTextbook from '@/locales/en-US/textbook.json';

const SOURCE_PATH = 'src/features/learning-hub/apps/views/ImageContentView.tsx';

const ZH_COPY: Record<string, string> = {
  zoom_not_ready: '图片尚未加载完成，无法缩放',
  zoom_out_of_range: "zoom 百分比须在 {{min}}–{{max}} 之间，或传 'fit'",
  rotate_not_ready: '图片尚未加载完成，无法旋转',
  rotate_invalid_degrees: 'rotate 的 degrees 仅支持 90/180/270（顺时针）',
};

function readSource(): string {
  return readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8');
}

describe('ImageContentView agent hint i18n contract (textbook:image_preview)', () => {
  it('keeps zh-CN and en-US image_preview leaf keys aligned', () => {
    const zh = zhTextbook.image_preview as Record<string, string>;
    const en = enTextbook.image_preview as Record<string, string>;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh).sort()).toEqual(Object.keys(ZH_COPY).sort());
  });

  it('keeps zh-CN copy identical to the original main-branch hints', () => {
    const zh = zhTextbook.image_preview as Record<string, string>;
    for (const [key, copy] of Object.entries(ZH_COPY)) {
      expect(zh[key]).toBe(copy);
    }
  });

  it('keeps {{min}}/{{max}} interpolation in both locales for the zoom range hint', () => {
    for (const locale of [zhTextbook, enTextbook]) {
      const copy = (locale.image_preview as Record<string, string>).zoom_out_of_range;
      expect(copy).toContain('{{min}}');
      expect(copy).toContain('{{max}}');
    }
  });

  it('references every image_preview key via i18n.t with the zh copy as defaultValue', () => {
    const source = readSource();
    for (const key of Object.keys(ZH_COPY)) {
      expect(source).toContain(`i18n.t('textbook:image_preview.${key}'`);
    }
    // defaultValue 兜底 = zh 原文（zoom_out_of_range 用双引号包裹以容纳 'fit'）
    expect(source).toContain("defaultValue: '图片尚未加载完成，无法缩放'");
    expect(source).toContain("defaultValue: '图片尚未加载完成，无法旋转'");
    expect(source).toContain(
      'defaultValue: "zoom 百分比须在 {{min}}–{{max}} 之间，或传 \'fit\'"'
    );
    expect(source).toContain("defaultValue: 'rotate 的 degrees 仅支持 90/180/270（顺时针）'");
  });

  it('no longer hardcodes the hints as plain literals', () => {
    const source = readSource();
    expect(source).not.toContain("hint: '图片尚未加载完成，无法缩放'");
    expect(source).not.toContain("hint: '图片尚未加载完成，无法旋转'");
    expect(source).not.toContain('hint: `zoom 百分比须在 ${ZOOM_MIN}–${ZOOM_MAX}');
    expect(source).not.toContain("hint: 'rotate 的 degrees 仅支持 90/180/270（顺时针）'");
  });
});
