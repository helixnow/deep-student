import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 契约意图：附件预览必须有明确的桌面/移动双路径。
 * 2026-07 改造后旧的 desktopAttachmentPreviewFullScreen 分支被
 * 桌面次级面板（desktopSecondaryPanelMode === 'attachment'）取代；
 * 移动端右滑面板仍走全屏渲染（fullScreen: true）。
 */
describe('chat attachment preview contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'),
    'utf-8'
  );

  it('routes desktop attachment previews through the secondary panel', () => {
    expect(source).toContain('attachmentPreviewOpen && openApp');
    expect(source).toContain("? 'attachment'");
    expect(source).toContain("if (panelMode === 'attachment' && panelOpenApp) {");
    expect(source).toContain('return renderOpenAppPanel({ openAppOverride: panelOpenApp });');
  });

  it('renders mobile attachment previews through a fullscreen branch', () => {
    expect(source).toContain('fullScreen: true,');
  });
});
