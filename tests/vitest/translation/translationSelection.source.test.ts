/**
 * 翻译工作台划词 — source 守卫
 *
 * 全局默认禁选文字，翻译的译文区与逐段对照此前不在白名单里：外刊精读时一个词都选不了，
 * 更没有 PDF / EPUB / Office 预览那套划词（解释 / 制卡 / 存为笔记 / 引用到聊天）。
 * 约定：译文渲染区与逐段对照显式放开选中，翻译视图挂共享划词能力，引用到聊天的来源类型为 translation。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

describe('translation workbench text selection', () => {
  it('makes the rendered translation and the bilingual comparison selectable', () => {
    expect(read('src/translation/TranslationStreamRenderer.tsx')).toMatch(/data-selectable="true"[^>]*whitespace-pre-wrap/);
    expect(read('src/components/translation/ComparisonView.tsx')).toMatch(/ref=\{setContainerRef\} data-selectable="true"/);
  });

  it('mounts the shared selection actions over the translation workbench as a translation source', () => {
    const view = read('src/features/learning-hub/apps/views/TranslationContentView.tsx');
    expect(view).toContain("import('@/features/pdf/components/PdfSelectionActions')");
    expect(view).toMatch(/<SelectionActions[\s\S]*?containerRef=\{workbenchAreaRef\}[\s\S]*?selectionSourceId=\{node\.id\}[\s\S]*?selectionKind="translation"/);
    expect(read('src/features/chat/context/selectionRef.ts')).toMatch(/SelectionSourceKind = [^;]*'translation'/);
  });
});
