/**
 * PDF 框选提问的接线契约（EnhancedPdfViewer 依赖 pdf.js worker，jsdom 下不渲染）：
 *
 * 1. 覆盖层懒加载，定位在阅读器根节点、对齐页面滚动视口，截图命名用人类可读的 fileName
 * 2. 宽屏工具栏与紧凑模式「更多」菜单都有入口，没有页面时不可点
 * 3. 截好的图走聊天侧的 sendImageToChat（动态 import），输入框经收件箱接住、与粘贴同一条附件流程
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const viewerSource = read('src/features/pdf/components/EnhancedPdfViewer.tsx');
const captureSource = read('src/features/pdf/components/PdfRegionCapture.tsx');
const inputBarSource = read('src/features/chat/components/input-bar/InputBarUI.tsx');

describe('EnhancedPdfViewer region capture wiring', () => {
  it('mounts the capture overlay lazily against the viewer root and the page viewport', () => {
    expect(viewerSource).toContain("React.lazy(() => import('./PdfRegionCapture'))");
    const mount = viewerSource.slice(viewerSource.indexOf('<PdfRegionCapture'));
    expect(mount).toContain('containerRef={containerRef}');
    expect(mount).toContain('viewportRef={pageContainerRef}');
    expect(mount).toContain('documentTitle={fileName}');
    expect(viewerSource).toContain('viewportRef={pageContainerRef}\n          orientation="both"');
  });

  it('offers the action in both the wide toolbar and the compact more menu', () => {
    const toggles = viewerSource.match(/setRegionCaptureActive\(prev => !prev\)/g) ?? [];
    expect(toggles).toHaveLength(2);
    expect(viewerSource.match(/t\('pdf:toolbar\.capture_ask'\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(viewerSource).toMatch(/regionCaptureActive \? 'active' : ''\}`\} onClick=\{\(\) => setRegionCaptureActive\(prev => !prev\)\} disabled=\{numPages === 0\}/);
  });

  it('hands the capture to the chat input through the shared attachment pipeline', () => {
    expect(captureSource).toContain("import('@/features/chat/context/imageToChat')");
    expect(captureSource).not.toMatch(/^import .*features\/chat/m);
    expect(inputBarSource).toContain('useChatInputInbox(sessionId, isReady, processFilesToAttachments)');
  });
});
