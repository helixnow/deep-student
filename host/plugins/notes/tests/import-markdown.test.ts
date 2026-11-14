import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import {
  cleanupMaterializedImportFiles, decodeMarkdownBytes, deriveMarkdownNoteTitle,
  extractFirstHeading, isGenericNoteTitle, splitLeadingHeading,
} from '../src/import-markdown.ts';
import { setNotesLocalRuntime } from '../src/local-runtime.ts';
import { nodeNotesLocalRuntime } from '../src/local-runtime.node.ts';

// The cleanup test drives the module directly instead of installing the plugin.
beforeAll(() => { setNotesLocalRuntime(nodeNotesLocalRuntime); });
afterAll(() => { setNotesLocalRuntime(null); });

describe('cmd/notes.rs::tests', () => {
  it('decode_markdown_bytes_strips_utf8_bom', () => {
    expect(decodeMarkdownBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 35, 32, 72, 105]))).toEqual(['# Hi', 'UTF-8 BOM']);
  });
  it('decode_markdown_bytes_supports_utf16le', () => {
    expect(decodeMarkdownBytes(Uint8Array.from([0xff, 0xfe, 0x23, 0, 0x20, 0, 0x48, 0, 0x69, 0]))).toEqual(['# Hi', 'UTF-16LE']);
  });
  it('derive_markdown_note_title_uses_file_stem', () => {
    expect(deriveMarkdownNoteTitle('/tmp/线代笔记.md')).toBe('线代笔记');
  });
  it('extract_first_heading_finds_h1', () => {
    expect(extractFirstHeading('# 线性代数笔记\n\n内容...')).toBe('线性代数笔记');
  });
  it('split_leading_heading_moves_h1_into_title', () => {
    expect(splitLeadingHeading('\ufeff\n# 线性代数 知识框架 #\n\n> 复习用\n\n- 行列式\n'))
      .toEqual(['线性代数 知识框架', '> 复习用\n\n- 行列式\n']);
    expect(splitLeadingHeading('# 只有标题')).toEqual(['只有标题', '']);
  });
  it('split_leading_heading_requires_leading_h1', () => {
    for (const text of ['前言\n# 标题\n', '## 二级\n正文', '#标签 不是标题', '#   \n正文']) {
      expect(splitLeadingHeading(text)).toBeNull();
    }
  });
  it('extract_first_heading_skips_h2', () => {
    expect(extractFirstHeading('## 二级标题\n\n内容')).toBeNull();
  });
  it('extract_first_heading_returns_none_for_no_heading', () => {
    expect(extractFirstHeading('普通文本\n没有标题')).toBeNull();
  });
  it('extract_first_heading_trims_whitespace', () => {
    expect(extractFirstHeading('#   带空格的标题  \n')).toBe('带空格的标题');
  });
  it('is_generic_note_title_detects_placeholder', () => {
    for (const title of ['文件', '  文件  ', '', '   ']) expect(isGenericNoteTitle(title)).toBe(true);
  });
  it('is_generic_note_title_detects_opaque_document_ids', () => {
    for (const title of ['446', '1000019790', 'document:1000019790', 'msf:62', 'image:12345']) {
      expect(isGenericNoteTitle(title)).toBe(true);
    }
  });
  it('is_generic_note_title_allows_real_names', () => {
    for (const title of ['线代笔记', 'notes', 'file:with_colon_text', 'chapter1']) expect(isGenericNoteTitle(title)).toBe(false);
  });
  it('cleanup_materialized_import_files_removes_existing_files', async () => {
    const host = await createTestHost();
    try {
      const first = path.join(host.app.dataDir, 'md_import_cleanup_1.md');
      const second = path.join(host.app.dataDir, 'md_import_cleanup_2.md');
      fs.writeFileSync(first, 'a');
      fs.writeFileSync(second, 'b');
      cleanupMaterializedImportFiles('notes_import_markdown_batch', [first, second]);
      expect(fs.existsSync(first)).toBe(false);
      expect(fs.existsSync(second)).toBe(false);
    } finally {
      await host.dispose();
    }
  });
});
