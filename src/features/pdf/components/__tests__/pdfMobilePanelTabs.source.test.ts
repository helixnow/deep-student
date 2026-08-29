/**
 * 打开资源 / 预览 PDF：书签等移动面板 tab 的 44px 触控契约（源码契约）。
 *
 * 依据 0824 合流决议（docs/dev/0824-g-landing.md）：EnhancedPdfViewer 的
 * 四个移动 tab（目录/缩略图/书签/批注）均保留 coarse-pointer `!min-h-11`。
 *
 * 为什么用源码契约：基础 CSS 用双类名选择器
 * `.ds-pdf__mobile-panel-tabs .ds-pdf__mobile-panel-tab { min-height: 34px }`
 * 压过 DsButton 的 coarse 44px 规则，44px 完全靠 TSX 上的 Tailwind 任意变体
 * `[@media(pointer:coarse)]:!min-h-11` 扛住——类名一丢触控目标就静默缩回 34px，
 * jsdom 渲染测不出媒体查询，所以钉住源码。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const viewerSource = read('src/features/pdf/components/EnhancedPdfViewer.tsx');
const textbookViewerSource = read('src/features/pdf/components/TextbookPdfViewer.tsx');

describe('EnhancedPdfViewer mobile panel tabs keep 44px coarse-pointer targets', () => {
  it('renders exactly the four segmented tabs (outline/thumbnails/bookmarks/highlights)', () => {
    // 排除容器类 ds-pdf__mobile-panel-tabs（结尾带 s）
    const tabOccurrences = viewerSource.match(/ds-pdf__mobile-panel-tab(?!s)/g) ?? [];
    expect(tabOccurrences).toHaveLength(4);
  });

  it('every mobile panel tab carries the coarse-pointer !min-h-11 (44px) utility', () => {
    const guarded =
      viewerSource.match(
        /ds-pdf__mobile-panel-tab \[@media\(pointer:coarse\)\]:!min-h-11/g,
      ) ?? [];
    // 四个 tab 一个都不能少：书签 tab 缩水就是本契约要拦的回归
    expect(guarded).toHaveLength(4);
  });

  it('keeps the bookmarks tab wired in both the mobile panel and the desktop sidebar', () => {
    // 移动面板书签分段
    expect(viewerSource).toContain("t('pdf:bookmark.tabLabel')");
    // 桌面侧栏书签 tab（目录/缩略图/书签/批注同域互斥）
    expect(viewerSource).toContain("aria-selected={sidebarMode === 'bookmarks'}");
  });
});

describe('resource open / preview surfaces reach this viewer', () => {
  it('TextbookPdfViewer (used by FileContentView / TextbookContentView) wraps EnhancedPdfViewer with bookmarks', () => {
    expect(textbookViewerSource).toContain(
      "import { EnhancedPdfViewer, type Bookmark } from './EnhancedPdfViewer'",
    );
    expect(textbookViewerSource).toContain('bookmarks');
  });
});
