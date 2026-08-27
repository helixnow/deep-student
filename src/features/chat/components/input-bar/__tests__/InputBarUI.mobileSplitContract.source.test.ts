import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readInputBarSource = (file: string) => readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/input-bar', file),
  'utf-8'
);

describe('split input bar mobile contract', () => {
  const inputBarSource = readInputBarSource('InputBarUI.tsx');
  const toolbarSource = readInputBarSource('ComposerToolbar.tsx');
  const panelSource = readInputBarSource('AttachmentPanelBody.tsx');
  const plusMenuSource = readInputBarSource('ComposerPlusMenu.tsx');
  const helperSource = readInputBarSource('attachmentModeHelpers.ts');
  const chatContainerSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ChatContainer.tsx'),
    'utf-8'
  );
  const legacyInputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/InputBar.tsx'),
    'utf-8'
  );

  it('keeps split components as the owners of toolbar and attachment rendering', () => {
    expect(inputBarSource).toContain("import { ComposerToolbar } from './ComposerToolbar';");
    expect(inputBarSource).toContain("import { AttachmentPanelBody } from './AttachmentPanelBody';");
    expect(inputBarSource).not.toContain('function ContextWindowUsageRing');
    expect(toolbarSource).toContain('function ContextWindowUsageRing');
  });

  it('keeps the active chat surface on InputBarV2 instead of the legacy InputBar', () => {
    expect(chatContainerSource).toContain('<InputBarV2');
    expect(chatContainerSource).not.toMatch(/<InputBar(?:\s|>)/);
    expect(legacyInputBarSource).toContain('@deprecated Legacy');
  });

  it('keeps coarse-pointer toolbar controls and search at mobile-safe sizes', () => {
    expect(toolbarSource).toContain(
      '[@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!w-[var(--touch-target-size)]'
    );
    // 第一批高频散点已从透明伪元素外扩改为实体 44×44 盒（--touch-target-size），
    // 伪元素命中区会与相邻控件互相重叠，工具栏内不允许再出现
    expect(toolbarSource).toContain(
      '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]'
    );
    expect(toolbarSource).not.toContain('[@media(pointer:coarse)]:after:-inset');
    expect(toolbarSource).toContain(
      'app-menu-search-input ds-search-input [@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!text-base'
    );
  });

  it('keeps attachment and plus-menu actions token-sized on coarse pointers', () => {
    expect(panelSource).toContain('className="!h-11 !min-w-11"');
    expect(
      panelSource.match(/\[@media\(pointer:coarse\)\]:min-h-\[var\(--touch-target-size\)\]/g)?.length
    ).toBeGreaterThanOrEqual(8);
    expect(plusMenuSource).toContain(
      '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]'
    );
  });

  it('keeps compact composer hints tappable without changing desktop density', () => {
    expect(
      inputBarSource.match(/\[@media\(pointer:coarse\)\]:min-h-\[var\(--touch-target-size\)\]/g)?.length
    ).toBeGreaterThanOrEqual(5);
  });

  it('keeps localized OCR stage labels in the extracted helper', () => {
    expect(helperSource).toContain('export function getStageLabel(');
    expect(helperSource).toContain("t('learningHub:processing.ocrRecognizing')");
    expect(panelSource).toContain('getStageLabel(t, mediaProgress, isPdf, isImage)');
  });
});
