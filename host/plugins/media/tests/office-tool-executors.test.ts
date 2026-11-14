/**
 * Rust `docx_executor.rs` / `pptx_executor.rs` / `xlsx_executor.rs` /
 * `office_fidelity_executor.rs` / `document_processing_executor.rs` executed for
 * real: migrated VFS database, L11 repositories, F7 office engines, and a context
 * that records the start/end/error events and the saved tool block.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { office } from '../../../platform/native/office/extract.ts';
import { officeText } from '../../../platform/native/office/text.ts';
import { createOfficeWriter } from '../../../platform/native/office/writer.ts';
import { APP_EXECUTOR_ROSTER } from '../../../kernel/agent-roster.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { PdfProcessingService, ProcessingStatus } from '../../vfs-index/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储读写 VFS；被测对象是本 lane 的执行器
import { BlobRepo } from '../../vfs-repos/repository/blobs.ts';
// boundary-allow cross-plugin-impl: 同上，files 仓储（含 folder_items 挂载）
import { FileRepo } from '../../vfs-repos/repository/files.ts';
import { DocumentParser } from '../src/document-parser.ts';
import { DocxToolExecutor } from '../src/tools/docx-executor.ts';
import { PptxToolExecutor } from '../src/tools/pptx-executor.ts';
import { XlsxToolExecutor } from '../src/tools/xlsx-executor.ts';
import { OfficeFidelityExecutor } from '../src/tools/office-fidelity-executor.ts';
import { DocumentProcessingExecutor } from '../src/tools/document-processing-executor.ts';
import type { OfficeToolDeps } from '../src/tools/office-common.ts';
import type { MediaToolContext } from '../src/tools/runtime.ts';

const ROSTER_TOOLS = {
  DocxToolExecutor: ['docx_read_structured', 'docx_extract_tables', 'docx_get_metadata',
    'docx_create', 'docx_to_spec', 'docx_replace_text'],
  PptxToolExecutor: ['pptx_read_structured', 'pptx_get_metadata', 'pptx_extract_tables',
    'pptx_create', 'pptx_to_spec', 'pptx_replace_text'],
  XlsxToolExecutor: ['xlsx_read_structured', 'xlsx_extract_tables', 'xlsx_get_metadata',
    'xlsx_create', 'xlsx_to_spec', 'xlsx_edit_cells', 'xlsx_replace_text'],
  OfficeFidelityExecutor: ['office_fidelity_inspect'],
  DocumentProcessingExecutor: ['document_parse', 'document_parse_status'],
} as const;

const SCHEMA_FILES: Record<keyof typeof ROSTER_TOOLS, string> = {
  DocxToolExecutor: 'docx-tools.ts',
  PptxToolExecutor: 'pptx-tools.ts',
  XlsxToolExecutor: 'xlsx-tools.ts',
  OfficeFidelityExecutor: 'office-fidelity-tools.ts',
  DocumentProcessingExecutor: 'document-processing.ts',
};

/** Tool names the model sees: the builtin skill schemas the front end ships. */
function schemaToolNames(file: string): string[] {
  const source = fs.readFileSync(new URL(`../../../../src/features/chat/skills/builtin-tools/${file}`, import.meta.url), 'utf8');
  return [...source.matchAll(/name:\s*'builtin-([a-z_]+)'/g)].map(match => match[1]!);
}

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
const files = new FileRepo();
const blobs = new BlobRepo();
const writer = createOfficeWriter(() => {});
const warnings: string[] = [];
const parser = new DocumentParser({
  office: () => office, officeText: () => officeText, officeWriter: () => writer,
  warn: message => { warnings.push(message); },
});
const log = { debug: () => undefined, warn: (message: string) => { warnings.push(message); }, error: () => undefined };

function officeDeps(overrides: Partial<OfficeToolDeps> = {}): OfficeToolDeps {
  return {
    repos: () => ({ files, blobs }),
    parser: () => parser,
    runtimeRoots: () => null,
    tempRootPath: () => path.join(root, 'temp'),
    workspaceWriter: () => null,
    log,
    ...overrides,
  };
}

interface Recorded {
  context: MediaToolContext;
  events: Array<[string, unknown]>;
  saved: ToolResultInfo[];
}

function recordingContext(vfs: VfsDatabase | null = database): Recorded {
  const events: Array<[string, unknown]> = [];
  const saved: ToolResultInfo[] = [];
  const context: MediaToolContext = {
    session_id: 'sess_w04', block_id: 'blk_w04', vfs_db: vfs, skill_package_roots: null, cancellation_token: null,
    emitToolCallStart: (toolName, input, toolCallId) => { events.push(['start', { toolName, input, toolCallId }]); },
    emitToolCallEnd: result => { events.push(['end', result]); },
    emitToolCallError: error => { events.push(['error', error]); },
    saveToolBlock: result => { saved.push(result); },
  };
  return { context, events, saved };
}

let callSeq = 0;
function call(name: string, args: unknown) {
  callSeq += 1;
  return { id: `call_${callSeq}`, name: `builtin-${name}`, arguments: args };
}

async function run(
  executor: { execute(call: { id: string; name: string; arguments: unknown }, context: MediaToolContext): Promise<ToolResultInfo> },
  name: string, args: unknown, recorded = recordingContext(),
): Promise<ToolResultInfo & { output: Record<string, unknown> }> {
  const result = await executor.execute(call(name, args), recorded.context);
  expect(recorded.saved).toEqual([result]);
  expect(recorded.events[0]?.[0]).toBe('start');
  expect(recorded.events[1]?.[0]).toBe(result.success ? 'end' : 'error');
  return result as ToolResultInfo & { output: Record<string, unknown> };
}

function storeFile(bytes: Uint8Array, fileName: string, mimeType: string, fileType = 'document'): string {
  const blob = blobs.storeBlob(conn, database.blobsDir(), bytes, mimeType, path.extname(fileName).slice(1));
  return files.createFile(conn, blob.hash, fileName, bytes.length, fileType, mimeType, blob.hash, null).id;
}

function vfsBytes(fileId: string): Buffer {
  const file = files.getFile(conn, fileId);
  expect(file).not.toBeNull();
  return fs.readFileSync(blobs.getBlobPath(conn, database.blobsDir(), file!.blobHash!)!);
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-office-tools-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-office-tools-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = { getConnSafe: () => conn, blobsDir: () => path.join(root, 'vfs_blobs') } as unknown as VfsDatabase;
  warnings.length = 0;
});
afterEach(() => {
  storage.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tool definitions match Rust and the shipped schemas', () => {
  const executors = {
    DocxToolExecutor: new DocxToolExecutor(officeDeps()),
    PptxToolExecutor: new PptxToolExecutor(officeDeps()),
    XlsxToolExecutor: new XlsxToolExecutor(officeDeps()),
    OfficeFidelityExecutor: new OfficeFidelityExecutor({ repos: () => ({ files, blobs }), runtimeRoots: () => null, log }),
    DocumentProcessingExecutor: new DocumentProcessingExecutor({ pdf: () => null, log }),
  };

  it.each(Object.keys(ROSTER_TOOLS) as Array<keyof typeof ROSTER_TOOLS>)('%s', name => {
    const executor = executors[name];
    expect(executor.name()).toBe(name);
    expect(APP_EXECUTOR_ROSTER as readonly string[]).toContain(name);
    expect([...schemaToolNames(SCHEMA_FILES[name])].sort()).toEqual([...ROSTER_TOOLS[name]].sort());
    for (const tool of ROSTER_TOOLS[name]) {
      expect(executor.canHandle(tool)).toBe(true);
      expect(executor.canHandle(`builtin-${tool}`)).toBe(true);
    }
    expect(executor.canHandle('builtin-rag_search')).toBe(false);
    expect(executor.canHandle('builtin-attachment_read')).toBe(false);
  });

  it('sensitivity and concurrency follow the Rust executors', () => {
    const docx = executors.DocxToolExecutor;
    expect(docx.sensitivityLevel('builtin-docx_create')).toBe('medium');
    expect(docx.sensitivityLevel('builtin-docx_replace_text')).toBe('medium');
    expect(docx.sensitivityLevel('builtin-docx_to_spec')).toBe('low');
    expect(docx.concurrencyClass('builtin-docx_get_metadata')).toBe('read_only');
    expect(docx.concurrencyClass('builtin-docx_to_spec')).toBe('serial');
    const xlsx = executors.XlsxToolExecutor;
    expect(xlsx.sensitivityLevel('builtin-xlsx_edit_cells')).toBe('medium');
    expect(xlsx.concurrencyClass('builtin-xlsx_extract_tables')).toBe('read_only');
    expect(xlsx.concurrencyClass('builtin-xlsx_edit_cells')).toBe('serial');
    const pptx = executors.PptxToolExecutor;
    expect(pptx.sensitivityLevel('builtin-pptx_create')).toBe('medium');
    expect(pptx.concurrencyClass('builtin-pptx_read_structured')).toBe('read_only');
    expect(executors.OfficeFidelityExecutor.concurrencyClass('office_fidelity_inspect')).toBe('read_only');
    expect(executors.DocumentProcessingExecutor.sensitivityLevel('builtin-document_parse')).toBe('medium');
    expect(executors.DocumentProcessingExecutor.sensitivityLevel('builtin-document_parse_status')).toBe('low');
  });
});

describe('DocxToolExecutor', () => {
  const docx = () => new DocxToolExecutor(officeDeps());
  const spec = {
    title: '期末复习',
    blocks: [
      { type: 'heading', level: 1, text: '第一章 力学' },
      { type: 'paragraph', text: '牛顿第二定律：力等于质量乘以加速度。' },
      { type: 'table', rows: [['公式', '含义'], ['F=ma', '牛顿第二定律']] },
    ],
  };

  it('docx_create stores a VFS document and every read tool reads it back', async () => {
    const created = await run(docx(), 'docx_create', { spec, file_name: '复习.docx' });
    expect(created.success).toBe(true);
    const output = created.output;
    const fileId = output.file_id as string;
    expect(output).toMatchObject({
      success: true, output_target: 'vfs', file_name: '复习.docx', format: 'docx',
      message: `已生成 DOCX 文件「复习.docx」(${Math.trunc((output.file_size as number) / 1024)}KB)`,
    });
    const stored = vfsBytes(fileId);
    expect(stored.length).toBe(output.file_size);
    expect(output.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(files.getFile(conn, fileId)).toMatchObject({
      fileName: '复习.docx', fileType: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(output.object_handle).toMatchObject({
      schemaVersion: 2, handleId: `vfs-file:${fileId}`, kind: 'file', displayName: '复习.docx',
      providerRef: { provider: 'deep-student-vfs', externalId: fileId, etag: output.sha256 },
      capabilities: { readable: true, writable: true, deletable: true, materializable: false },
      provenance: { source: 'deep-student-office', tool: 'docx_create' },
    });
    expect((output.object_handle as Record<string, unknown>).locator).toBeUndefined();
    expect(output.fidelity_manifest).toMatchObject({ format: 'docx', operation: 'create' });

    const read = await run(docx(), 'docx_read_structured', { resource_id: fileId });
    expect(read.output).toMatchObject({ success: true, resource_id: fileId, format: 'markdown' });
    expect(read.output.content).toContain('第一章 力学');
    expect(read.output.contentLength).toBe(Buffer.byteLength(read.output.content as string, 'utf8'));

    const tables = await run(docx(), 'docx_extract_tables', { resource_id: fileId });
    expect(tables.output).toMatchObject({ table_count: 1, tables: [[['公式', '含义'], ['F=ma', '牛顿第二定律']]] });

    const metadata = await run(docx(), 'docx_get_metadata', { resource_id: fileId });
    expect(metadata.output).toMatchObject({ success: true, resource_id: fileId });
    expect(Object.keys(metadata.output.metadata as object).sort())
      .toEqual(['created', 'creator', 'description', 'lastModifiedBy', 'modified', 'subject', 'title']);

    const toSpec = await run(docx(), 'docx_to_spec', { resource_id: fileId });
    expect(toSpec.output.message).toBe('已将 DOCX 转换为 JSON spec。你可以修改 spec 后使用 docx_create 生成新文件。');
    expect(JSON.stringify(toSpec.output.spec)).toContain('牛顿第二定律');
  });

  it('docx_replace_text counts every occurrence, delivers a new file with lineage, and reports no-op', async () => {
    const created = await run(docx(), 'docx_create', { spec });
    const source = created.output.file_id as string;
    const replaced = await run(docx(), 'docx_replace_text', {
      resource_id: source, file_name: '替换.docx',
      replacements: [{ find: '牛顿第二定律', replace: 'Newton II' }, { find: '', replace: 'ignored' }],
    });
    expect(replaced.success, replaced.error ?? '').toBe(true);
    expect(replaced.output).toMatchObject({
      replacements_made: 2, source_resource_id: source, file_name: '替换.docx',
      message: '已完成 2 处替换，保存为「替换.docx」',
    });
    const newId = replaced.output.new_file_id as string;
    expect(newId).not.toBe(source);
    expect(replaced.output.file_id).toBeUndefined();
    expect((replaced.output.object_handle as { provenance: unknown }).provenance).toMatchObject({
      sourceUri: `vfs://${source}`,
      derivedFrom: [{ sourceHandleId: `vfs:${source}`, transformId: 'docx.replace_text' }],
    });
    const reread = await run(docx(), 'docx_extract_tables', { resource_id: newId });
    expect(reread.output.tables).toEqual([[['公式', '含义'], ['F=ma', 'Newton II']]]);

    const none = await run(docx(), 'docx_replace_text', {
      resource_id: source, replacements: [{ find: '不存在的文本', replace: 'x' }],
    });
    expect(none.output).toEqual({
      success: true, resource_id: source, replacements_made: 0, message: '未找到任何匹配项，文档未修改。',
    });
  });

  it('reports Rust error strings as failed tool results', async () => {
    const missing = await run(docx(), 'docx_read_structured', {});
    expect(missing).toMatchObject({ success: false, output: null, error: "Missing 'resource_id' parameter" });

    const notFound = await run(docx(), 'docx_get_metadata', { resource_id: 'file_missing' });
    expect(notFound.error).toBe('文件不存在: file_missing');

    const noVfs = await run(docx(), 'docx_to_spec', { resource_id: 'file_x' }, recordingContext(null));
    expect(noVfs.error).toBe('VFS database not available');

    const noSpec = await run(docx(), 'docx_create', { file_name: 'a.docx' });
    expect(noSpec.error).toBe("Missing 'spec' parameter");

    const badReplacements = await run(docx(), 'docx_replace_text', { resource_id: 'file_x', replacements: [{ find: 'a' }] });
    expect(badReplacements.error).toBe("Each replacement must have a 'replace' field");

    const notDocx = storeFile(Buffer.from('plain text'), 'note.docx', 'application/octet-stream');
    const parseFailure = await run(docx(), 'docx_read_structured', { resource_id: notDocx });
    expect(parseFailure.error).toMatch(/^DOCX 结构化提取失败: /);

    const unknown = await run(docx(), 'docx_frobnicate', {});
    expect(unknown.error).toBe('Unknown docx tool: docx_frobnicate');
  });

  it('workspace output validates options and fails explicitly without a published change-set writer', async () => {
    const folderMix = await run(docx(), 'docx_create', { spec, output_target: 'workspace', folder_id: 'fld_1' });
    expect(folderMix.error).toBe('folder_id is only valid for VFS output');
    const vfsMix = await run(docx(), 'docx_create', { spec, relative_path: 'a.docx' });
    expect(vfsMix.error).toBe('root_id, relative_path, and expected_sha256 are only valid for workspace output');
    const noRoots = await run(docx(), 'docx_create', { spec, output_target: 'workspace', relative_path: 'out/a.docx' });
    expect(noRoots.error).toBe('Runtime root service is not available for Office workspace output');
    const withRoots = new DocxToolExecutor(officeDeps({
      runtimeRoots: () => ({ rootById: () => { throw new Error('unreachable'); }, revalidate: () => root }),
    }));
    const noWriter = await run(withRoots, 'docx_create', { spec, output_target: 'workspace', relative_path: 'out/a.docx' });
    expect(noWriter.error).toBe('Office workspace output is unavailable: the workspace change-set writer is not published');
  });

  it('workspace output writes through the change-set writer into a read-write workspace root', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'media-office-workspace-'));
    const writes: unknown[][] = [];
    const executor = new DocxToolExecutor(officeDeps({
      runtimeRoots: () => ({
        rootById: rootId => ({
          id: rootId, kind: 'workspace', path: workspace, access: 'read_write', label: 'W', description: '',
          session_scoped: false, configured: true,
        }),
        revalidate: () => workspace,
      }),
      workspaceWriter: () => ({
        writeBytes: (rootPath, checkpoint, rootId, relative, content, expected) => {
          writes.push([rootPath, checkpoint, rootId, relative, content.length, expected]);
          fs.mkdirSync(path.dirname(path.join(rootPath, relative)), { recursive: true });
          fs.writeFileSync(path.join(rootPath, relative), content);
          return {
            change_id: 'change-1', root_id: rootId, op: 'created', relative_path: relative,
            after_hash: createHash('sha256').update(content).digest('hex'), bytes: content.length,
          };
        },
      }),
    }));
    try {
      const wrongSuffix = await run(executor, 'docx_create', { spec, output_target: 'workspace', relative_path: 'out/a.txt' });
      expect(wrongSuffix.error).toBe("workspace Office output path must end with '.docx'");
      const result = await run(executor, 'docx_create', { spec, output_target: 'workspace', relative_path: 'out/A.DOCX' });
      expect(result.success).toBe(true);
      expect(writes).toEqual([[workspace, path.join(root, 'temp'), 'workspace', 'out/A.DOCX', result.output.file_size, null]]);
      expect(result.output).toMatchObject({
        output_target: 'workspace', root_id: 'workspace', relative_path: 'out/A.DOCX', overwrite_policy: 'fail',
        change_set: { id: 'change-1' },
        file_change_summary: { created: 1, modified: 0, deleted: 0, bytes_written: result.output.file_size },
        object_handle: { locator: { rootId: 'workspace', relativePath: 'out/A.DOCX' }, capabilities: { materializable: true } },
      });
      expect(fs.existsSync(path.join(workspace, 'out/A.DOCX'))).toBe(true);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });
});

describe('PptxToolExecutor', () => {
  const pptx = () => new PptxToolExecutor(officeDeps());
  const spec = {
    title: '物理课件',
    slides: [
      { type: 'title', title: '物理课件', subtitle: '第一讲 力学' },
      { type: 'content', title: '要点', bullets: ['惯性定律', '加速度定律'] },
      { type: 'table', title: '公式表', headers: ['公式', '含义'], rows: [['F=ma', '加速度定律']] },
    ],
  };

  it('creates, reads, extracts tables and round-trips replacements per changed field', async () => {
    const created = await run(pptx(), 'pptx_create', { spec, file_name: '课件.pptx' });
    expect(created.success, created.error ?? '').toBe(true);
    const fileId = created.output.file_id as string;
    expect(created.output).toMatchObject({ format: 'pptx', file_name: '课件.pptx' });

    const read = await run(pptx(), 'pptx_read_structured', { resource_id: fileId });
    expect(read.output.content).toContain('惯性定律');
    const metadata = await run(pptx(), 'pptx_get_metadata', { resource_id: fileId });
    expect(metadata.output.metadata).toMatchObject({ slide_count: 3, format: 'pptx' });

    const toSpec = await run(pptx(), 'pptx_to_spec', { resource_id: fileId });
    const slides = (toSpec.output.spec as { slides: Array<Record<string, unknown>> }).slides;
    expect(slides.map(slide => slide.type)).toContain('table');
    expect(JSON.stringify(slides)).toContain('惯性定律');

    const tables = await run(pptx(), 'pptx_extract_tables', { resource_id: fileId });
    expect(tables.output.table_count).toBe(1);
    expect((tables.output.tables as Array<Record<string, unknown>>)[0]).toMatchObject({
      headers: ['公式', '含义'], rows: [['F=ma', '加速度定律']], row_count: 1, col_count: 2,
    });

    const replaced = await run(pptx(), 'pptx_replace_text', {
      resource_id: fileId, replacements: [{ find: '加速度定律', replace: '第二定律' }],
    });
    expect(replaced.success, replaced.error ?? '').toBe(true);
    expect(replaced.output).toMatchObject({ replacements_made: 2, source_resource_id: fileId });
    const after = await run(pptx(), 'pptx_read_structured', { resource_id: replaced.output.new_file_id });
    expect(after.output.content).toContain('第二定律');
    expect(after.output.content).not.toContain('加速度定律');

    const none = await run(pptx(), 'pptx_replace_text', { resource_id: fileId, replacements: [] });
    expect(none.output).toEqual({
      success: true, resource_id: fileId, replacements_made: 0, message: '未找到任何匹配项，演示文稿未修改。',
    });
  });

  it('reports missing parameters and unknown tools', async () => {
    expect((await run(pptx(), 'pptx_to_spec', {})).error).toBe("Missing 'resource_id' parameter");
    expect((await run(pptx(), 'pptx_replace_text', { resource_id: 'x' })).error)
      .toBe("Missing 'replacements' parameter (array of {find, replace})");
    expect((await run(pptx(), 'pptx_other', {})).error).toBe('Unknown pptx tool: pptx_other');
  });
});

describe('XlsxToolExecutor', () => {
  const xlsx = () => new XlsxToolExecutor(officeDeps());
  const spec = { sheets: [{ name: '成绩', headers: ['姓名', '分数'], rows: [['张三', '90'], ['李四', '85']] }] };

  it('creates and reads the workbook through every read tool', async () => {
    const created = await run(xlsx(), 'xlsx_create', { spec, file_name: '成绩.xlsx' });
    expect(created.success, created.error ?? '').toBe(true);
    const fileId = created.output.file_id as string;
    const read = await run(xlsx(), 'xlsx_read_structured', { resource_id: fileId });
    expect(read.output).toMatchObject({ format: 'text' });
    expect(read.output.content).toContain('张三');
    const tables = await run(xlsx(), 'xlsx_extract_tables', { resource_id: fileId });
    expect(tables.output).toMatchObject({
      sheet_count: 1,
      tables: [{ sheet_name: '成绩', row_count: 3, col_count: 2, rows: [['姓名', '分数'], ['张三', '90'], ['李四', '85']] }],
    });
    const metadata = await run(xlsx(), 'xlsx_get_metadata', { resource_id: fileId });
    expect(metadata.output.metadata).toMatchObject({ sheet_count: 1, total_rows: 3, total_cols: 2, format: 'xlsx' });
    const toSpec = await run(xlsx(), 'xlsx_to_spec', { resource_id: fileId });
    expect(toSpec.output.spec).toEqual({ sheets: [{ name: '成绩', headers: ['姓名', '分数'], rows: [['张三', '90'], ['李四', '85']] }] });
  });

  it('xlsx_edit_cells edits through the native writer, skips unknown sheets and delivers a derived file', async () => {
    const created = await run(xlsx(), 'xlsx_create', { spec });
    const source = created.output.file_id as string;
    const edited = await run(xlsx(), 'xlsx_edit_cells', {
      resource_id: source, file_name: '改分.xlsx',
      edits: [{ sheet: '成绩', cell: 'B2', value: '95' }, { sheet: '不存在', cell: 'A1', value: 'x' }],
    });
    expect(edited.success, edited.error ?? '').toBe(true);
    expect(edited.output).toMatchObject({
      edits_made: 1, source_resource_id: source, message: '已编辑 1 个单元格，保存为「改分.xlsx」',
      fidelity_manifest: { operation: 'edit_cells' },
    });
    expect(edited.output.overwritten_formula_cells).toBeUndefined();
    expect(warnings.some(message => message.includes("'不存在'"))).toBe(false);
    const after = await run(xlsx(), 'xlsx_extract_tables', { resource_id: edited.output.new_file_id });
    expect((after.output.tables as Array<{ rows: string[][] }>)[0]!.rows[1]).toEqual(['张三', '95']);

    const nothing = await run(xlsx(), 'xlsx_edit_cells', {
      resource_id: source, edits: [{ sheet: '不存在', cell: 'A1', value: 'x' }],
    });
    expect(nothing.output).toEqual({ success: true, resource_id: source, edits_made: 0, message: '未执行任何编辑操作。' });

    const noCell = await run(xlsx(), 'xlsx_edit_cells', { resource_id: source, edits: [{ value: '1' }] });
    expect(noCell.error).toBe("Each edit must have a 'cell' field (e.g. 'A1')");
    const noEdits = await run(xlsx(), 'xlsx_edit_cells', { resource_id: source });
    expect(noEdits.error).toBe("Missing 'edits' parameter (array of {sheet, cell, value})");
  });

  it('xlsx_edit_cells lists overwritten formula cells and attaches a fidelity warning', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Sheet1');
    sheet.getCell('A1').value = 1;
    sheet.getCell('A2').value = { formula: 'A1*2', result: 2 };
    const bytes = new Uint8Array(await book.xlsx.writeBuffer());
    const source = storeFile(bytes, 'formula.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const edited = await run(xlsx(), 'xlsx_edit_cells', { resource_id: source, edits: [{ cell: 'A2', value: '7' }] });
    expect(edited.success, edited.error ?? '').toBe(true);
    expect(edited.output.overwritten_formula_cells).toEqual(['Sheet1!A2']);
    expect(edited.output.fidelity_warning).toMatchObject({
      overwritten_formula_cells: ['Sheet1!A2'], post_edit_comparison: 'not_performed',
    });
  });

  it('xlsx_replace_text counts changed cells and rejects empty find terms before reading', async () => {
    const created = await run(xlsx(), 'xlsx_create', { spec });
    const source = created.output.file_id as string;
    const replaced = await run(xlsx(), 'xlsx_replace_text', {
      resource_id: source, replacements: [{ find: '张', replace: '章' }],
    });
    expect(replaced.output).toMatchObject({ replacements_made: 1, message: '已完成 1 个单元格替换，保存为「edited.xlsx」' });
    const empty = await run(xlsx(), 'xlsx_replace_text', { resource_id: source, replacements: [{ find: '', replace: 'x' }] });
    expect(empty.error).toBe('XLSX 替换失败: Excel解析错误: XLSX 替换查找文本不能为空');
  });
});

describe('OfficeFidelityExecutor', () => {
  const inspector = () => new OfficeFidelityExecutor({ repos: () => ({ files, blobs }), runtimeRoots: () => null, log });

  it('inspects an Office file addressed by the VFS object handle and checks its declared sha256', async () => {
    const created = await run(new DocxToolExecutor(officeDeps()), 'docx_create', {
      spec: { blocks: [{ type: 'paragraph', text: 'fidelity' }] }, file_name: 'f.docx',
    });
    const handle = created.output.object_handle as Record<string, unknown>;
    const inspected = await run(inspector(), 'office_fidelity_inspect', { source: { object_handle: handle } });
    expect(inspected.success, inspected.error ?? '').toBe(true);
    expect(inspected.output).toMatchObject({
      ok: true, format: 'docx', sourceHandleId: handle.handleId, sourceDisplayName: 'f.docx',
    });
    const direct = await run(inspector(), 'office_fidelity_inspect', handle);
    expect(direct.output.sourceHandleId).toBe(handle.handleId);

    const tampered = await run(inspector(), 'office_fidelity_inspect', { source: { ...handle, sha256: 'a'.repeat(64) } });
    expect(tampered.error).toBe('OFFICE_FIDELITY_SOURCE_CHANGED: TaskObjectHandle SHA-256 mismatch');
  });

  it('rejects malformed, unreadable and unauthorized sources', async () => {
    const invalid = await run(inspector(), 'office_fidelity_inspect', { source: { handleId: 'x' } });
    expect(invalid.error).toMatch(/^OFFICE_FIDELITY_INVALID_SOURCE: /);
    const base = {
      schemaVersion: 2, handleId: 'h', kind: 'file', displayName: 'd',
      capabilities: { readable: true, materializable: false, writable: false, shareable: false, sendable: false, deletable: false },
      provenance: { source: 'test', observedAt: '2026-11-07T00:00:00Z' },
    };
    const unreadable = await run(inspector(), 'office_fidelity_inspect',
      { ...base, capabilities: { ...base.capabilities, readable: false } });
    expect(unreadable.error).toBe('OFFICE_FIDELITY_UNAUTHORIZED: source is not readable');
    const foreign = await run(inspector(), 'office_fidelity_inspect',
      { ...base, providerRef: { provider: 'gdrive', externalId: 'x' } });
    expect(foreign.error).toBe('OFFICE_FIDELITY_UNSUPPORTED_SOURCE: provider reference is not an authorized Deep Student VFS file');
    const nowhere = await run(inspector(), 'office_fidelity_inspect', base);
    expect(nowhere.error).toBe('OFFICE_FIDELITY_UNSUPPORTED_SOURCE: source needs a managed locator or authorized Deep Student VFS provider reference');
    const missing = await run(inspector(), 'office_fidelity_inspect',
      { ...base, providerRef: { provider: 'deep-student-vfs', externalId: 'file_missing' } });
    expect(missing.error).toBe('OFFICE_FIDELITY_SOURCE_NOT_FOUND: VFS file does not exist');
  });
});

describe('DocumentProcessingExecutor', () => {
  let running: Set<string>;
  let started: Array<[string, unknown]>;
  let statuses: Map<string, ProcessingStatus>;
  const pdf = (): PdfProcessingService => ({
    isRunning: (fileId: string) => running.has(fileId),
    getStatus: (fileId: string) => statuses.get(fileId) ?? null,
    startPipeline: async (fileId: string, stage?: unknown) => { started.push([fileId, stage ?? null]); running.add(fileId); },
  }) as unknown as PdfProcessingService;
  const executor = () => new DocumentProcessingExecutor({ pdf: () => pdf(), log });

  beforeEach(() => {
    running = new Set();
    started = [];
    statuses = new Map();
  });

  it('document_parse starts the pipeline once and reports an already running file', async () => {
    const fileId = storeFile(Buffer.from('%PDF-1.4 test'), 'paper.pdf', 'application/pdf');
    const first = await run(executor(), 'document_parse', { resource_id: fileId, stage: 'ocr' });
    expect(first.output).toMatchObject({
      status: 'started', file_id: fileId, file_name: 'paper.pdf', mime_type: 'application/pdf', page_count: null,
    });
    expect(started).toEqual([[fileId, 'ocr_processing']]);
    statuses.set(fileId, { fileId, stage: 'ocr_processing', progress: { percent: 10 } } as unknown as ProcessingStatus);
    const again = await run(executor(), 'document_parse', { resource_id: ` "${fileId}" ` });
    expect(again.output).toMatchObject({ status: 'already_running', current_stage: 'ocr_processing' });
    expect(started).toHaveLength(1);
  });

  it('document_parse rejects unsupported media, bad stages and missing services', async () => {
    const docxId = storeFile(Buffer.from('PK'), 'a.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const unsupported = await run(executor(), 'document_parse', { resource_id: docxId });
    expect(unsupported.error).toContain('不支持解析/OCR 管线，仅支持 PDF 与图片');
    const pdfId = storeFile(Buffer.from('%PDF-1.4 b'), 'b.pdf', 'application/pdf');
    const badStage = await run(executor(), 'document_parse', { resource_id: pdfId, stage: 'everything' });
    expect(badStage.error).toBe('无效的 stage 参数: everything（可选: auto / ocr / full）');
    const invalidId = await run(executor(), 'document_parse', { resource_id: 'file abc' });
    expect(invalidId.error).toBe('资源 ID 格式无效: file abc');
    const noService = await run(new DocumentProcessingExecutor({ pdf: () => null, log }), 'document_parse', { resource_id: pdfId });
    expect(noService.error).toBe('PDF processing service not available');
    const noArg = await run(executor(), 'document_parse_status', {});
    expect(noArg.error).toBe("Missing 'resource_id' parameter（file_* 或 res_* 开头的文件类资源 ID）");
  });

  it('document_parse_status reports unknown, running and terminal stages', async () => {
    const fileId = storeFile(Buffer.from('%PDF-1.4 c'), 'c.pdf', 'application/pdf');
    conn.run("UPDATE files SET extracted_text = '公式 F=ma', page_count = 3 WHERE id = ?1", [fileId]);
    const unknown = await run(executor(), 'document_parse_status', { resource_id: fileId });
    expect(unknown.output).toMatchObject({
      file_id: fileId, page_count: 3, is_running: false, extracted_text_chars: 7, stage: 'unknown',
    });
    statuses.set(fileId, {
      fileId, stage: 'completed', progress: { percent: 100 }, error: null, startedAt: 10n, completedAt: 20,
    } as unknown as ProcessingStatus);
    const done = await run(executor(), 'document_parse_status', { resource_id: fileId });
    expect(done.output).toMatchObject({ stage: 'completed', progress: { percent: 100 }, started_at_ms: 10, completed_at_ms: 20 });
    expect(done.output.hint).toMatch(/^解析完成。/);
    expect(done.output.error).toBeUndefined();
    statuses.set(fileId, { fileId, stage: 'error', progress: {}, error: 'boom' } as unknown as ProcessingStatus);
    const failed = await run(executor(), 'document_parse_status', { resource_id: fileId });
    expect(failed.output).toMatchObject({ stage: 'error', error: 'boom' });
    expect(failed.output.hint).toMatch(/^解析失败。/);
  });
});
