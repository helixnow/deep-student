import { describe, expect, it } from 'vitest';
import type {
  VfsAttachment,
  VfsEssay,
  VfsExamSheet,
  VfsFile,
  VfsMindMap,
  VfsNote,
  VfsTextbook,
  VfsTranslation,
} from '../api.ts';
import {
  attachmentToDstuNode,
  createTypeFolder,
  essayToDstuNode,
  examToDstuNode,
  fileToDstuNode,
  generateResourceId,
  isOpaqueDocumentId,
  itemTypeToDstuNodeType,
  mindmapToDstuNode,
  noteToDstuNode,
  parseTimestamp,
  previewTypeFromFilename,
  sanitizeTextbookDisplayName,
  sessionToDstuNode,
  textbookToDstuNode,
  translationToDstuNode,
  type VfsEssaySession,
} from '../src/node-converters.ts';

describe('dstu/handler_utils/node_converters.rs', () => {
  it('uses platform chrono parsing for submillisecond fractions, offsets and leap seconds', () => {
    expect(parseTimestamp('2026-01-01T08:00:00.123456789+08:00')).toBe(1767225600123);
    expect(parseTimestamp('2026-01-01 00:00:00.123456789')).toBe(1767225600123);
    expect(parseTimestamp('2016-12-31T23:59:60Z')).toBe(1483228800000);
    expect(parseTimestamp('0099-01-01T00:00:00Z')).toBe(-59042995200000);
    expect(parseTimestamp('\u00852026-01-01T00:00:00Z\u0085')).toBe(1767225600000);
  });
  const iso = '2025-01-15T10:30:00Z';

  it('test_get_textbook_preview_type_pdf', () => {
    expect(previewTypeFromFilename('document.pdf')).toBe('pdf');
    expect(previewTypeFromFilename('DOCUMENT.PDF')).toBe('pdf');
    expect(previewTypeFromFilename('Document.Pdf')).toBe('pdf');
    expect(previewTypeFromFilename('path/to/file.pdf')).toBe('pdf');
  });

  it('test_get_textbook_preview_type_office_word', () => {
    expect(previewTypeFromFilename('report.docx')).toBe('docx');
    expect(previewTypeFromFilename('REPORT.DOCX')).toBe('docx');
  });

  it('test_get_textbook_preview_type_office_excel', () => {
    expect(previewTypeFromFilename('data.xlsx')).toBe('xlsx');
    expect(previewTypeFromFilename('DATA.XLSX')).toBe('xlsx');
    expect(previewTypeFromFilename('data.xls')).toBe('text');
    expect(previewTypeFromFilename('data.ods')).toBe('text');
    expect(previewTypeFromFilename('data.xlsb')).toBe('text');
  });

  it('test_get_textbook_preview_type_office_powerpoint', () => {
    expect(previewTypeFromFilename('slides.pptx')).toBe('pptx');
    expect(previewTypeFromFilename('SLIDES.PPTX')).toBe('pptx');
  });

  it('test_get_textbook_preview_type_text_plain', () => {
    expect(previewTypeFromFilename('readme.txt')).toBe('text');
    expect(previewTypeFromFilename('README.TXT')).toBe('text');
    expect(previewTypeFromFilename('readme.md')).toBe('text');
    expect(previewTypeFromFilename('README.MD')).toBe('text');
  });

  it('test_get_textbook_preview_type_text_html', () => {
    expect(previewTypeFromFilename('page.html')).toBe('text');
    expect(previewTypeFromFilename('page.htm')).toBe('text');
    expect(previewTypeFromFilename('PAGE.HTML')).toBe('text');
  });

  it('test_get_textbook_preview_type_text_structured', () => {
    expect(previewTypeFromFilename('data.csv')).toBe('text');
    expect(previewTypeFromFilename('config.json')).toBe('text');
    expect(previewTypeFromFilename('config.xml')).toBe('text');
    expect(previewTypeFromFilename('DATA.CSV')).toBe('text');
    expect(previewTypeFromFilename('CONFIG.JSON')).toBe('text');
  });

  it('test_get_textbook_preview_type_text_ebook', () => {
    expect(previewTypeFromFilename('book.epub')).toBe('epub');
    expect(previewTypeFromFilename('document.rtf')).toBe('text');
    expect(previewTypeFromFilename('BOOK.EPUB')).toBe('epub');
  });

  it('test_get_textbook_preview_type_unknown', () => {
    expect(previewTypeFromFilename('file.unknown')).toBe('none');
    expect(previewTypeFromFilename('file.xyz')).toBe('none');
    expect(previewTypeFromFilename('noextension')).toBe('none');
    expect(previewTypeFromFilename('')).toBe('none');
    expect(previewTypeFromFilename('.')).toBe('none');
    expect(previewTypeFromFilename('file.')).toBe('none');
  });

  it('test_get_textbook_preview_type_edge_cases', () => {
    expect(previewTypeFromFilename('file.tar.gz')).toBe('none');
    expect(previewTypeFromFilename('file.backup.pdf')).toBe('pdf');
    expect(previewTypeFromFilename('.gitignore')).toBe('none');
    expect(previewTypeFromFilename('文档.pdf')).toBe('pdf');
    expect(previewTypeFromFilename('file name with spaces.docx')).toBe('docx');
  });

  it('test_parse_timestamp_valid', () => {
    const timestamp = parseTimestamp('2024-01-15T10:30:00Z');
    expect(timestamp).toBeGreaterThan(0);
    expect(timestamp).toBeGreaterThan(1700000000000);
    expect(timestamp).toBeLessThan(2000000000000);
  });

  it('test_parse_timestamp_invalid', () => {
    const timestamp = parseTimestamp('invalid');
    expect(timestamp).toBeGreaterThan(0);
    expect(Math.abs(timestamp - Date.now())).toBeLessThan(1000);
  });

  it('test_item_type_to_dstu_node_type', () => {
    expect(itemTypeToDstuNodeType('note')).toBe('note');
    expect(itemTypeToDstuNodeType('textbook')).toBe('textbook');
    expect(itemTypeToDstuNodeType('exam')).toBe('exam');
    expect(itemTypeToDstuNodeType('translation')).toBe('translation');
    expect(itemTypeToDstuNodeType('essay')).toBe('essay');
    expect(itemTypeToDstuNodeType('image')).toBe('image');
    expect(itemTypeToDstuNodeType('file')).toBe('file');
    expect(itemTypeToDstuNodeType('folder')).toBe('folder');
    expect(itemTypeToDstuNodeType('mindmap')).toBe('mindmap');
    expect(itemTypeToDstuNodeType('unknown')).toBeUndefined();
    expect(itemTypeToDstuNodeType('')).toBeUndefined();
  });

  it('test_create_type_folder', () => {
    const note = createTypeFolder('note');
    expect(note.id).toBe('type_notes');
    expect(note.path).toBe('/notes');
    expect(note.name).toBe('笔记');

    const textbook = createTypeFolder('textbook');
    expect(textbook.id).toBe('type_textbooks');
    expect(textbook.path).toBe('/textbooks');
    expect(textbook.name).toBe('教材');

    const mindmap = createTypeFolder('mindmap');
    expect(mindmap.id).toBe('type_mindmaps');
    expect(mindmap.path).toBe('/mindmaps');
    expect(mindmap.name).toBe('知识导图');
  });

  it('test_generate_resource_id', () => {
    const note = generateResourceId('note');
    expect(note.startsWith('note_')).toBe(true);
    expect(note).toHaveLength(15);

    const textbook = generateResourceId('textbook');
    expect(textbook.startsWith('tb_')).toBe(true);
    expect(textbook).toHaveLength(13);

    const mindmap = generateResourceId('mindmap');
    expect(mindmap.startsWith('mm_')).toBe(true);
    expect(mindmap).toHaveLength(13);

    expect(generateResourceId('note')).not.toBe(generateResourceId('note'));
  });

  it('test_note_to_dstu_node_normalizes_absent_props_to_object', () => {
    const note: VfsNote = {
      id: 'note_props',
      resourceId: 'res_props',
      title: 'Props',
      tags: [],
      isFavorite: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      deletedAt: null,
      props: null,
    };

    const node = noteToDstuNode(note);
    expect((node.metadata as Record<string, unknown>).props).toEqual({});
  });

  it('test_sanitize_keeps_normal_filenames', () => {
    expect(sanitizeTextbookDisplayName('线代笔记.pdf', iso)).toBe('线代笔记.pdf');
    expect(sanitizeTextbookDisplayName('chapter1.docx', iso)).toBe('chapter1.docx');
  });

  it('test_sanitize_replaces_pure_numeric_id', () => {
    const result = sanitizeTextbookDisplayName('446.pdf', iso);
    expect(result.startsWith('导入文档_')).toBe(true);
    expect(result.endsWith('.pdf')).toBe(true);
    expect(result).toBe('导入文档_20250115_103000.pdf');
  });

  it('test_sanitize_replaces_document_colon_id', () => {
    const result = sanitizeTextbookDisplayName('document:1000019790.pdf', '2025-06-01T00:00:00Z');
    expect(result.startsWith('导入文档_')).toBe(true);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('test_sanitize_replaces_generic_placeholder', () => {
    const result = sanitizeTextbookDisplayName('文件.pdf', iso);
    expect(result.startsWith('导入文档_')).toBe(true);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('test_sanitize_handles_no_extension', () => {
    const result = sanitizeTextbookDisplayName('446', iso);
    expect(result.startsWith('导入文档_')).toBe(true);
    expect(result).not.toContain('.');
  });

  // Extra coverage for the conversion bodies that Rust only exercised indirectly.
  it('maps every VFS record to a DSTU node with Rust metadata shapes', () => {
    const textbook: VfsTextbook = {
      id: 'tb_1', resourceId: null, sha256: 'sha_tb', fileName: 'book.PDF', size: 10,
      tags: [], isFavorite: true, bookmarks: [{ page: 2 }], highlights: [], status: 'active',
      createdAt: iso, updatedAt: iso,
    };
    const textbookNode = textbookToDstuNode(textbook);
    expect(textbookNode).toMatchObject({
      id: 'tb_1', path: '/tb_1', name: 'book.PDF', type: 'textbook', resourceId: 'res_tb_1',
      size: 10, previewType: 'pdf', createdAt: Date.parse(iso), updatedAt: Date.parse(iso),
      metadata: {
        filePath: null, isFavorite: true, pageCount: null, readingProgress: null,
        bookmarks: [{ page: 2 }], highlights: [], annotationRevision: iso,
      },
    });

    const translation: VfsTranslation = {
      id: 'tr_1', resourceId: 'res_tr', srcLang: 'en', tgtLang: 'zh', isFavorite: false,
      createdAt: iso, updatedAt: '2025-01-16T00:00:00Z', sourceText: 'hello', translatedText: '你好',
    };
    expect(translationToDstuNode(translation)).toMatchObject({
      id: 'tr_1', name: 'tr_1', type: 'translation', resourceId: 'res_tr',
      createdAt: Date.parse(iso), updatedAt: Date.parse('2025-01-16T00:00:00Z'),
      metadata: {
        srcLang: 'en', tgtLang: 'zh', engine: null, model: null, isFavorite: false,
        qualityRating: null, title: null, sourceText: 'hello', translatedText: '你好',
      },
    });

    const exam: VfsExamSheet = {
      id: 'exam_1', examName: null, status: 'completed', tempId: 'temp', metadataJson: {},
      previewJson: {}, isFavorite: false, createdAt: iso, updatedAt: iso,
    };
    expect(examToDstuNode(exam)).toMatchObject({
      id: 'exam_1', name: 'exam_1', type: 'exam', resourceId: 'res_exam_1',
      metadata: { status: 'completed', tempId: 'temp', linkedMistakeIds: null, isFavorite: false },
    });

    const essay: VfsEssay = {
      id: 'essay_1', resourceId: 'res_essay', roundNumber: 1, isFavorite: true,
      createdAt: iso, updatedAt: iso,
    };
    expect(essayToDstuNode(essay)).toMatchObject({
      name: '未命名作文', type: 'essay',
      metadata: { essayType: null, score: null, gradingResult: null, isFavorite: true },
    });

    const session: VfsEssaySession = {
      id: 'essay_session_1', title: '会话', totalRounds: 2, latestScore: 88, isFavorite: false,
      createdAt: iso, updatedAt: iso,
    };
    expect(sessionToDstuNode(session)).toMatchObject({
      id: 'essay_session_1', name: '会话', type: 'essay', resourceId: 'essay_session_1',
      metadata: { essayType: null, gradeLevel: null, totalRounds: 2, latestScore: 88, isFavorite: false },
    });

    const attachment: VfsAttachment = {
      id: 'att_1', type: 'image', name: 'pic.png', mimeType: 'image/png', size: 5,
      contentHash: 'hash_att', isFavorite: false, createdAt: iso, updatedAt: iso,
    };
    expect(attachmentToDstuNode(attachment)).toMatchObject({
      id: 'att_1', name: 'pic.png', type: 'image', resourceId: 'hash_att',
      metadata: { mimeType: 'image/png', size: 5, contentHash: 'hash_att', isFavorite: false },
    });

    const mindmap: VfsMindMap = {
      id: 'mm_1', resourceId: 'res_mm', title: '导图', isFavorite: true, defaultView: 'mindmap',
      createdAt: iso, updatedAt: iso, contentUpdatedAt: iso,
    };
    expect(mindmapToDstuNode(mindmap)).toMatchObject({
      id: 'mm_1', name: '导图', type: 'mindmap', resourceId: 'res_mm',
      metadata: { description: null, isFavorite: true, defaultView: 'mindmap', theme: null },
    });

    const file: VfsFile = {
      id: 'file_1', sha256: 'sha_file', fileName: 'notes.txt', size: 7, fileType: 'document',
      tags: [], isFavorite: false, bookmarks: [], status: 'active', createdAt: iso, updatedAt: iso,
    };
    expect(fileToDstuNode(file)).toMatchObject({
      id: 'file_1', name: 'notes.txt', type: 'file', resourceId: 'sha_file', size: 7, previewType: 'text',
      metadata: {
        filePath: null, mimeType: null, size: 7, fileType: 'document', sha256: 'sha_file',
        contentHash: 'sha_file', isFavorite: false, pageCount: null, readingProgress: null, bookmarks: [],
      },
    });

    expect(fileToDstuNode({ ...file, mimeType: 'application/pdf' })).toMatchObject({ type: 'textbook', previewType: 'text' });
    expect(fileToDstuNode({ ...file, fileType: 'image' })).toMatchObject({ type: 'image' });
  });

  it('parses SQLite and numeric timestamp forms and rejects opaque IDs precisely', () => {
    expect(parseTimestamp(' 2024-01-15 10:30:00 ')).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
    expect(parseTimestamp('2024-01-15 10:30:00.500')).toBe(Date.UTC(2024, 0, 15, 10, 30, 0, 500));
    expect(parseTimestamp('1700000000')).toBe(1_700_000_000_000);
    expect(parseTimestamp('1700000000000')).toBe(1_700_000_000_000);
    expect(isOpaqueDocumentId('446')).toBe(true);
    expect(isOpaqueDocumentId('document:1000019790')).toBe(true);
    expect(isOpaqueDocumentId('document:abc')).toBe(false);
    expect(isOpaqueDocumentId('文件')).toBe(false);
  });
});
