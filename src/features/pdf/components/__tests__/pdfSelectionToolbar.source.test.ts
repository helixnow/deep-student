/**
 * PDF 阅读划词接入的源码契约。
 *
 * EnhancedPdfViewer 是 3500+ 行、依赖 pdf.js worker 的重组件，jsdom 下渲染不现实，
 * 因此这里用源码契约锁住「工具条确实挂上了、且走的是既有链路」这几条：
 *
 * 1. 阅读器根节点挂了 PdfSelectionActions（文本层开启时生效）
 * 2. PdfSelectionActions 用的是共享层 SelectionToolbar / useTextSelection，不是本地复制品
 * 3. 解释 / 翻译 / 制卡 / 保存为笔记 复用既有实现，没有平行新链路
 * 4. 移动端避让：底部 inset 参与定位、结果面板不是 Dialog、Android 返回键先关面板
 * 5. 懒加载契约（0824 Wave2-B 第 1 轮）：PdfSelectionActions 及其聊天弹层 / 制卡
 *    链路必须走 lazy / 动态 import——静态导入会把翻译链路与 cardforge 重新打进
 *    PDF chunk，抵消整套拆包设计（见 docs/dev/wave2-B-r1-anchor-pdf.md）
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const viewerSource = read('src/features/pdf/components/EnhancedPdfViewer.tsx');
const actionsSource = read('src/features/pdf/components/PdfSelectionActions.tsx');
const pdfCss = read('src/features/pdf/styles/enhanced-pdf.css');

describe('EnhancedPdfViewer mounts the shared selection toolbar', () => {
  it('renders PdfSelectionActions inside the viewer root, loaded lazily', () => {
    expect(viewerSource).toContain("React.lazy(() => import('./PdfSelectionActions'))");
    expect(viewerSource).toContain('<PdfSelectionActions');
    // 不允许退回静态导入——会把 shared/selection + 聊天弹层拉回 PDF chunk
    expect(viewerSource).not.toContain("import { PdfSelectionActions } from");
  });

  it('positions the toolbar against the viewer root and gates it on the text layer', () => {
    const mount = viewerSource.slice(viewerSource.indexOf('<PdfSelectionActions'));
    expect(mount).toContain('containerRef={containerRef}');
    expect(mount).toContain('enabled={resolvedEnableTextSelection}');
    expect(mount).toContain('isMobileLike={isMobileLike}');
  });

  it('keeps the highlight colour bar as a separate surface', () => {
    // 划词工具条不能顶掉既有高亮能力
    expect(viewerSource).toContain('ds-pdf__highlight-bar');
    expect(viewerSource).toContain('ds-highlight-menu');
  });
});

describe('PdfSelectionActions reuses existing capabilities', () => {
  it('uses the shared selection layer rather than a local copy', () => {
    expect(actionsSource).toContain("from '@/shared/selection'");
    expect(actionsSource).toContain('<SelectionToolbar');
    expect(actionsSource).toContain('useTextSelection(containerRef)');
  });

  it('wires explain / translate / save-as-note / make-cards / add-to-chat', () => {
    expect(actionsSource).toContain('onExplain={handleExplain}');
    expect(actionsSource).toContain('onTranslate={handleTranslate}');
    expect(actionsSource).toContain('onSaveAsNote={handleSaveAsNote}');
    expect(actionsSource).toContain('onMakeCards={handleMakeCards}');
    expect(actionsSource).toContain('onAddToChat={handleAddToChat}');
  });

  it('does not fake capabilities it has not wired', () => {
    expect(actionsSource).toContain('hideUnavailableActions');
  });

  it('routes cards through the existing selectionCardGeneration pipeline, imported on demand', () => {
    expect(actionsSource).toContain("import('@/features/chat/services/selectionCardGeneration')");
    // 不允许退回静态导入——selectionCardGeneration 顶层依赖 cardforge 的 cardAgent，
    // 静态导入会把 cardforge 打进 PDF 侧 chunk
    expect(actionsSource).not.toContain('import { generateCardsFromSelection } from');
    // 不允许另起一条制卡链路
    expect(actionsSource).not.toContain('ChatV2AnkiAdapter');
    expect(actionsSource).not.toContain('saveAnkiCards');
  });

  it('routes notes through the shared save-as-note flow (folder picker + open note)', () => {
    expect(actionsSource).toContain("from '@/shared/notes'");
    expect(actionsSource).toContain('useSaveAsNoteFlow');
    expect(actionsSource).toContain('<SaveAsNoteFolderPicker');
    // 不允许绕过目录选择直接写根目录
    expect(actionsSource).not.toContain('notesDstuAdapter');
  });

  it('reuses chat explain / translate popovers via React.lazy, not static imports', () => {
    expect(actionsSource).toContain('React.lazy');
    expect(actionsSource).toContain("import('@/features/chat/components/ExplainPopover')");
    expect(actionsSource).toContain("import('@/features/chat/components/TranslationPopover')");
    // 不允许退回静态导入——翻译链路会被重新打进 PDF 侧 chunk
    expect(actionsSource).not.toContain("from '@/features/chat/components/ExplainPopover'");
    expect(actionsSource).not.toContain("from '@/features/chat/components/TranslationPopover'");
  });
});

describe('add-to-chat channel contract (0824 Wave2-B r6)', () => {
  it('forwards fileName as documentTitle — not the DSTU resourcePath tail (resource ID)', () => {
    const mount = viewerSource.slice(viewerSource.indexOf('<PdfSelectionActions'));
    expect(mount).toContain('documentTitle={fileName}');
    expect(viewerSource).not.toContain('documentTitle={resourcePath');
  });

  it('forwards the onQuoteToChat locator callback through the viewer', () => {
    const mount = viewerSource.slice(viewerSource.indexOf('<PdfSelectionActions'));
    expect(mount).toContain('onQuoteToChat={onQuoteToChat}');
  });

  it('routes the chat fallback through the PREFILL wrapper, never a raw CHAT_V2_SET_INPUT dispatch', () => {
    expect(actionsSource).toContain('sendSelectionToChatInput');
    // 裸通道假定聊天视图已在前台；从阅读器出发必须走会切视图的 PREFILL 包装
    expect(actionsSource).not.toContain('APP_EVENTS.CHAT_V2_SET_INPUT');
  });
});

describe('mobile behaviour', () => {
  it('prefers the area below the selection so the toolbar clears the colour menu', () => {
    expect(actionsSource).toContain('placement="below"');
  });

  it('avoids the bottom chrome / home indicator on touch', () => {
    expect(actionsSource).toContain('viewportBottomInset={isMobileLike ? MOBILE_BOTTOM_INSET_PX : 0}');
  });

  it('shows results in an inline panel, not a modal dialog', () => {
    expect(actionsSource).toContain('ds-pdf__selection-panel');
    expect(actionsSource).not.toContain('DsDialog');
    expect(pdfCss).toContain('.ds-pdf__selection-panel');
    // 面板底部避让底栏 + 进度细线 + safe-area（与高亮条同一套派生变量）
    const panelBlock = pdfCss.slice(pdfCss.indexOf('.ds-pdf__selection-panel {'));
    expect(panelBlock).toContain('var(--ds-pdf-safe-bottom)');
  });

  it('lets the Android back button close the result panel first, with a visibility guard', () => {
    // Wave2-C R5（台账 03 V1）：从「handler 存在」升级为「守卫存在」——
    // 必须走共享的可见性守卫注册（宿主 containerRef 不可见时让行），
    // 保活隐藏的 PDF 实例不得吞掉活跃页面的返回键。
    expect(actionsSource).toContain(
      "import { registerVisibilityGuardedBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator'",
    );
    expect(actionsSource).toContain('registerVisibilityGuardedBackHandler(containerRef,');
    expect(actionsSource).toContain('BACK_PRIORITY.overlay');
    // 不允许退回无守卫的裸注册
    expect(actionsSource).not.toMatch(/(?<!Guarded)registerBackHandler\(/);
  });

  it('the viewer overlay chain shares the same guarded registration', () => {
    // EnhancedPdfViewer 的浮层关闭链改用同一共享守卫，不再手抄三重检查
    expect(viewerSource).toContain('registerVisibilityGuardedBackHandler(containerRef,');
    expect(viewerSource).not.toMatch(/(?<!Guarded)registerBackHandler\(/);
  });
});
