import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import type { ChatExecutionContext } from '../../chat/api.ts';
import { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs, tempRoot } from '../../agent-workspace/api.ts';
import { DEFAULT_PDF_PREVIEW_CONFIG } from '../../vfs-repos/api.ts';
import { DstuToolExecutor } from '../src/tools/dstu-executor.ts';

interface UploadResult {
  sourceId: string; isNew: boolean;
  file: { id: string; updatedAt: string; pageCount?: number; extractedText?: string };
}
interface AuditRow { file_name: string; old_row: string; new_row: string }

async function epub(title: string, chapters: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  const manifest = chapters.map((_, i) => `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">wp109</dc:identifier>${title === '' ? '' : `<dc:title>${title}</dc:title>`}</metadata>
  <manifest>${manifest}</manifest><spine>${spine}</spine>
</package>`);
  chapters.forEach((body, i) => zip.file(`OEBPS/ch${i}.xhtml`,
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${body}</p></body></html>`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

it('vfs_upload_file writes only ocr_pages_json on the upload conn and renders PDF previews with the L11 default config (handlers.rs:2302,2523-2538)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l13-upload-ocr-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  try {
    new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
      store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
    const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
    expect(loaded.degraded).toEqual([]);
    const files = host.ctx.vfsRepo.files;
    const createSpy = vi.spyOn(files, 'createFileWithDocDataInFolderOutcome');
    const ocrSpy = vi.spyOn(files, 'setUploadOcrPagesWithConn');
    const legacySpy = vi.spyOn(files, 'updatePdfOcrPages');
    const warn = vi.spyOn(host.ctx.logger, 'warn');

    const conn = host.ctx.vfsDatabase.getConnSafe();
    const columns = conn.all<{ name: string }>('PRAGMA table_info(files)').map(column => column.name);
    const snapshot = (alias: string) => `json_object(${columns.map(name => `'${name}', ${alias}."${name}"`).join(', ')})`;
    conn.exec(`CREATE TABLE wp109_files_audit (file_name TEXT, old_row TEXT, new_row TEXT)`);
    conn.exec(`CREATE TRIGGER wp109_files_audit_t AFTER UPDATE ON files BEGIN
      INSERT INTO wp109_files_audit VALUES (NEW.file_name, ${snapshot('OLD')}, ${snapshot('NEW')}); END`);
    conn.exec(`CREATE TRIGGER wp109_files_fail_t BEFORE UPDATE OF ocr_pages_json ON files
      WHEN NEW.file_name = 'fail.epub' BEGIN SELECT RAISE(ABORT, 'wp109 ocr write refused'); END`);
    const audit = () => conn.all<AuditRow>('SELECT file_name, old_row, new_row FROM wp109_files_audit ORDER BY rowid');
    const changed = (row: AuditRow) => {
      const before = JSON.parse(row.old_row) as Record<string, unknown>;
      const after = JSON.parse(row.new_row) as Record<string, unknown>;
      return Object.fromEntries(columns.filter(name => before[name] !== after[name]).map(name => [name, [before[name], after[name]]]));
    };
    const stored = (id: string) => conn.get<{ ocr_pages_json: string | null; updated_at: string; page_count: number | null; extracted_text: string | null }>(
      'SELECT ocr_pages_json, updated_at, page_count, extracted_text FROM files WHERE id = ?1', [id]);
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const ipc = (name: string, mimeType: string, bytes: Buffer, folderId?: string) =>
      host.invoke<UploadResult>('vfs_upload_file', { params: { name, mimeType, base64Content: bytes.toString('base64'), ...(folderId === undefined ? {} : { folderId }) } });

    // 1. IPC epub: paged text goes to ocr_pages_json through the same conn the savepoint used; nothing else changes.
    const book = await epub('WP109 书', ['第一章 极限', '第二章 导数']);
    const first = await ipc('book.epub', 'application/epub+zip', book);
    expect(first.isNew).toBe(true);
    const pages = ['# WP109 书', '第一章 极限', '第二章 导数'];
    expect(first.file).toMatchObject({ pageCount: 3, extractedText: pages.join('\n\n') });
    expect(ocrSpy).toHaveBeenCalledExactlyOnceWith(createSpy.mock.calls[0]?.[0], first.sourceId, JSON.stringify(pages));
    expect(legacySpy).not.toHaveBeenCalled();
    const firstRows = audit();
    expect(firstRows.map(row => row.file_name)).toEqual(['book.epub']);
    expect(changed(firstRows[0] as AuditRow)).toEqual({ ocr_pages_json: [null, JSON.stringify(pages)] });
    expect(stored(first.sourceId)).toEqual({ ocr_pages_json: JSON.stringify(pages), updated_at: first.file.updatedAt,
      page_count: 3, extracted_text: pages.join('\n\n') });

    // 2. sha256 reuse returns early (handlers.rs:2197-2252): no second write.
    const again = await ipc('book.epub', 'application/epub+zip', book);
    expect(again).toMatchObject({ isNew: false, sourceId: first.sourceId });
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(audit()).toHaveLength(1);

    // 3. Empty paged result (`Ok(Some(pages)) if !pages.is_empty()` fails) and parse failure: no ocr_pages_json write.
    const empty = await ipc('empty.epub', 'application/epub+zip', await epub('', []));
    expect(empty.isNew).toBe(true);
    expect(stored(empty.sourceId)).toMatchObject({ ocr_pages_json: null, page_count: null, extracted_text: null });
    const broken = await ipc('broken.epub', 'application/epub+zip', Buffer.from('not a zip archive'));
    expect(broken.isNew).toBe(true);
    expect(stored(broken.sourceId)).toMatchObject({ ocr_pages_json: null, page_count: null, extracted_text: null });
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(audit()).toHaveLength(1);

    // 4. Write failure: Rust only warns with the raw SQLite error and the upload still succeeds.
    warn.mockClear();
    const failing = await ipc('fail.epub', 'application/epub+zip', await epub('Fail', ['失败页']));
    expect(failing.isNew).toBe(true);
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[VFS::handlers] Failed to write ocr_pages_json for %s: %s', failing.sourceId, 'wp109 ocr write refused');
    expect(stored(failing.sourceId)).toMatchObject({ ocr_pages_json: null, updated_at: failing.file.updatedAt, page_count: 2 });
    expect(audit()).toHaveLength(1);

    // 5. Savepoint failure rolls back before the page write (handlers.rs:2457-2481).
    const orphan = await epub('Orphan', ['孤儿页']);
    await expect(ipc('orphan.epub', 'application/epub+zip', orphan, 'fld_missing0000')).rejects.toContain('fld_missing0000');
    expect(conn.all('SELECT id FROM files WHERE sha256 = ?1', [sha(orphan)])).toEqual([]);
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    expect(audit()).toHaveLength(1);

    // 6. The registered DstuToolExecutor reaches the same implementation through dstuUpload.
    const executor = host.ctx.agentTools.toolExecutors().find(item => item.name() === 'DstuToolExecutor');
    if (!(executor instanceof DstuToolExecutor)) throw new Error('expected the production DstuToolExecutor');
    const chat = host.ctx.chatSession;
    const registry = chat.createExecutorRegistry([executor], { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs });
    const stamp = '2026-11-06T00:00:00Z';
    chat.createSession({ id: 'sess_wp109', mode: 'chat', titleLocked: false, persistStatus: 'active', createdAt: stamp, updatedAt: stamp });
    const temp = tempRoot(host.app.dataDir, 'sess_wp109', true).path;
    host.window({ window: 'main', webview: 'main' }, 'created');
    const context: ChatExecutionContext = chat.createExecutionContext({ sessionId: 'sess_wp109', messageId: 'msg_wp109', blockId: 'blk_wp109',
      emitter: ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_wp109', false),
      services: host.ctx, window: { window: 'main', webview: 'main' }, toolRegistry: host.ctx.mcp.registry });
    context.chat_v2_db = chat.database;
    const toolBook = await epub('Tool', ['工具页']);
    fs.writeFileSync(path.join(temp, 'tool.epub'), toolBook);
    const viaTool = await registry.execute({ id: 'call_wp109', name: 'builtin-dstu_upload_file', arguments: { root_id: 'temp', relative_path: 'tool.epub' } }, context);
    expect(viaTool.success, viaTool.error ?? '').toBe(true);
    const toolId = (viaTool.output as { source_id: string }).source_id;
    const toolPages = JSON.stringify(['# Tool', '工具页']);
    expect(ocrSpy).toHaveBeenCalledTimes(3);
    expect(ocrSpy.mock.calls[2]).toEqual([createSpy.mock.calls.at(-1)?.[0], toolId, toolPages]);
    const toolRows = audit();
    expect(toolRows.map(row => row.file_name)).toEqual(['book.epub', 'tool.epub']);
    expect(changed(toolRows[1] as AuditRow)).toEqual({ ocr_pages_json: [null, toolPages] });
    expect(legacySpy).not.toHaveBeenCalled();

    // 7. PDF preview: the L11 DEFAULT_PDF_PREVIEW_CONFIG object, rendered before the files row exists.
    const processing = host.ctx.vfsRepo.attachmentProcessing;
    if (processing === undefined || processing === null) throw new Error('vfsRepo.attachmentProcessing is not provided');
    const pdf = Buffer.from('%PDF-1.4\n% wp109 preview config probe\n%%EOF\n');
    const rowsAtRender: unknown[][] = [];
    const original = processing.renderPdf.bind(processing);
    const renderSpy = vi.spyOn(processing, 'renderPdf').mockImplementation(async (...args) => {
      rowsAtRender.push(conn.all('SELECT id FROM files WHERE sha256 = ?1', [sha(pdf)]));
      return original(...args);
    });
    const uploaded = await ipc('probe.pdf', 'application/pdf', pdf);
    expect(uploaded.isNew).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0]?.[3]).toBe(DEFAULT_PDF_PREVIEW_CONFIG);
    expect(DEFAULT_PDF_PREVIEW_CONFIG).toEqual({ renderDpi: 150, maxPages: 50, targetWidth: 1200, maxHeight: 1600, jpegQuality: 75, compressionEnabled: true });
    expect(rowsAtRender).toEqual([[]]);
  } finally {
    await host.dispose();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  }
}, 180_000);
