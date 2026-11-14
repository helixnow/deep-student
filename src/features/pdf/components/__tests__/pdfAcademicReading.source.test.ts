/**
 * 学术论文阅读增强能力的源码契约与设置迁移测试：
 * 1. PDF 内部引用超链接激活：`<Document onItemClick={...} externalLinkTarget="_blank">` + 默认开启批注层
 * 2. 跨页跳转返回栈：悬浮胶囊 `.ds-pdf__jump-pill` + `Alt+ArrowLeft/Right`
 * 3. 五色语义高亮 + 批注笔记 + 一键复制学术引文 + 文内图表/文献定位 + AI 论文导读菜单
 * 4. `pdfSettingsStore` v2 -> v3 迁移：未手动修改的旧默认值升级为开启批注层（range=2），自定义值保持不变
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_PDF_SETTINGS, usePdfSettingsStore } from '../../stores/pdfSettingsStore';

const viewerSource = readFileSync(
  resolve(process.cwd(), 'src/features/pdf/components/EnhancedPdfViewer.tsx'),
  'utf8',
);

describe('EnhancedPdfViewer academic paper reading wiring', () => {
  it('activates internal PDF link navigation and safe external link targets on <Document>', () => {
    expect(viewerSource).toContain('onItemClick={handlePdfInternalLinkClick}');
    expect(viewerSource).toContain('externalLinkTarget="_blank"');
    expect(viewerSource).toContain('externalLinkRel="noopener noreferrer"');
    expect(viewerSource).toContain('onClickCapture={handleRootClickCapture}');
    expect(viewerSource).toContain("import { openUrl } from '@/utils/urlOpener'");
  });

  it('wires jump-back history pill, reference locator with cancellation token, citation copy, pin-to-annotation, and paper guide', () => {
    expect(viewerSource).toContain('ds-pdf__jump-pill');
    expect(viewerSource).toContain('handleLocateAcademicRef');
    expect(viewerSource).toContain('locateRefTokenRef');
    expect(viewerSource).toContain('handleCopyCitation');
    expect(viewerSource).toContain('onPinToAnnotation={canPersistAnnotations ? handlePinToAnnotation : undefined}');
    expect(viewerSource).toContain('ds-paper-guide-menu');
    expect(viewerSource).toContain('ds-pdf__highlight-rect--has-comment');
  });

  it('supports single-key selection shortcuts (1-5, N, C, T, E) and Alt+Arrow jump history', () => {
    expect(viewerSource).toContain("e.key === '5'");
    expect(viewerSource).toContain('addHighlight(HIGHLIGHT_COLORS.purple)');
    expect(viewerSource).toContain('addHighlightWithNote()');
    expect(viewerSource).toContain("new CustomEvent('pdf-selection-trigger-action'");
    expect(viewerSource).toContain('handleJumpBack()');
    expect(viewerSource).toContain('handleJumpForward()');
  });

  it('wires Wave-2 inline reference preview, margin trim, column double-click zoom, PiP pinned cards, and progress ticks', () => {
    expect(viewerSource).toContain('goToPageRef.current(pageNumber, { forceJump: true })');
    expect(viewerSource).toContain('handlePreviewAcademicRef');
    expect(viewerSource).toContain('ds-pdf__ref-preview-card');
    expect(viewerSource).toContain('ds-pdf__page-crop-frame');
    expect(viewerSource).toContain('handlePageDoubleClick');
    expect(viewerSource).toContain("React.lazy(() => import('./PdfPinnedRegionsOverlay'))");
    expect(viewerSource).toContain('onPinRegion={handlePinRegion}');
    expect(viewerSource).toContain('ds-pdf__progress-tick');
  });
});

describe('pdfSettingsStore v3 academic annotation layer defaults', () => {
  it('enables annotation layer (range=2) by default so paper citations and figure links work out of the box', () => {
    expect(DEFAULT_PDF_SETTINGS.enableAnnotationLayerByDefault).toBe(true);
    expect(DEFAULT_PDF_SETTINGS.annotationLayerRange).toBe(2);
  });

  it('migrates untouched v2 defaults while preserving explicit user overrides', () => {
    const persistOptions = (
      usePdfSettingsStore as unknown as {
        persist: {
          getOptions: () => {
            version: number;
            migrate: (persisted: unknown, version: number) => { settings: typeof DEFAULT_PDF_SETTINGS };
          };
        };
      }
    ).persist.getOptions();

    expect(persistOptions.version).toBe(3);

    const upgraded = persistOptions.migrate(
      {
        settings: {
          ...DEFAULT_PDF_SETTINGS,
          enableAnnotationLayerByDefault: false,
          annotationLayerRange: 0,
        },
      },
      2,
    );
    expect(upgraded.settings.enableAnnotationLayerByDefault).toBe(true);
    expect(upgraded.settings.annotationLayerRange).toBe(2);

    const customPreserved = persistOptions.migrate(
      {
        settings: {
          ...DEFAULT_PDF_SETTINGS,
          enableAnnotationLayerByDefault: false,
          annotationLayerRange: 4,
        },
      },
      2,
    );
    expect(customPreserved.settings.annotationLayerRange).toBe(4);
  });
});
