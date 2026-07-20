import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const imageUploadPath = path.join(repoRoot, 'src/components/crepe/features/imageUpload.ts');
const crepeCssPath = path.join(repoRoot, 'src/components/crepe/CrepeEditor.css');
const zhNotesPath = path.join(repoRoot, 'src/locales/zh-CN/notes.json');
const enNotesPath = path.join(repoRoot, 'src/locales/en-US/notes.json');

function readSource(absolutePath: string) {
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

describe('notes editor mobile copy & touch-target source guards', () => {
  it('image block config localizes the upload button and uses tap copy on touch surfaces', () => {
    const source = readSource(imageUploadPath);

    // 触屏判定口径与 NotesCrepeEditor 一致：<768 或 pointer: coarse
    expect(source).toContain("window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768");

    // 触屏走「点击上传」文案；桌面保留「点击或拖拽」文案
    expect(source).toContain("'notes:editor.image_upload.placeholder_touch'");
    expect(source).toContain("'notes:editor.image_upload.placeholder'");

    // 上传按钮不再是 Crepe 默认英文 "Upload file"
    expect(source).toContain("blockUploadButton: i18next.t('notes:editor.image_upload.upload_button')");
    expect(source).toContain("inlineUploadButton: i18next.t('notes:editor.image_upload.upload_button_inline')");
  });

  it('locales define the new image upload copy keys', () => {
    const zh = JSON.parse(readSource(zhNotesPath));
    const en = JSON.parse(readSource(enNotesPath));

    for (const bundle of [zh, en]) {
      const imageUpload = bundle?.editor?.image_upload ?? {};
      expect(typeof imageUpload.placeholder_touch).toBe('string');
      expect(typeof imageUpload.upload_button).toBe('string');
      expect(typeof imageUpload.upload_button_inline).toBe('string');
    }

    // 移动端文案不应包含拖拽话术
    expect(zh.editor.image_upload.placeholder_touch).not.toContain('拖拽');
  });

  it('notes pane chrome-row actions get >=44px touch targets on touch/narrow surfaces', () => {
    const css = readSource(crepeCssPath);
    const touchRule = css.match(
      /@media \(max-width: 767\.98px\), \(pointer: coarse\) \{[^{}]*\.notes-crepe-shell \.notes-editor-chrome-row button \{([^}]*)\}/,
    );
    expect(touchRule, 'chrome-row touch-target rule should exist').toBeTruthy();
    expect(touchRule?.[1]).toContain('min-width: 44px');
    expect(touchRule?.[1]).toContain('min-height: 44px');
  });

  it('image upload block and body placeholder adapt to narrow viewports', () => {
    const css = readSource(crepeCssPath);

    // 上传块：窄屏收紧内边距、自适应高度
    expect(css).toMatch(
      /@media \(max-width: 767\.98px\) \{\s*\.crepe-editor-wrapper \.milkdown \.milkdown-image-block \.image-edit \{[^}]*height: auto;/,
    );

    // 正文占位符：窄屏单行省略号，避免溢出裁切
    const placeholderRule = css.match(
      /\.crepe-editor-wrapper \.milkdown \.crepe-placeholder::before \{([^}]*text-overflow: ellipsis;[^}]*)\}/,
    );
    expect(placeholderRule, 'narrow-viewport placeholder rule should exist').toBeTruthy();
    expect(placeholderRule?.[1]).toContain('max-width: 100%');
  });
});
