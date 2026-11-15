import { nanoid } from 'nanoid';
import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { mobileLocalRuntime } from '../../../platform/files/mobile-local-runtime.ts';
import { webPdf } from '../../../platform/native/pdfium/web.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { DocsService } from '../api.ts';
import type { PortableMediaDeps } from './register-media-portable.ts';
import { extensionOf, toTextbook } from './textbook-record.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const STAGED_ID = /^dstu-staged:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

export function registerMobileTextbooks(ctx: Context, deps: Pick<PortableMediaDeps, 'vfsDatabase' | 'vfsRepo'>,
  docs: Pick<DocsService, 'checkPdfEncryptionBytes' | 'extractTextFromBytes' | 'extractPagedTextFromBytes'>): void {
  const log = ctx.logger('media.textbooks');
  const validation = (message: string) => new CommandError(AppError.validation(message));
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const readSelected = (source: string): { name: string; bytes: Uint8Array } => {
    const id = STAGED_ID.exec(source)?.[1];
    if (!id) throw validation('请选择本地文件后上传');
    const staged = mobileLocalRuntime(ctx).vfs.takeStagedUpload(id);
    try {
      const name = staged.name();
      if (!name || /[\/\\\x00-\x1f\x7f]/.test(name) || name.length > 255) throw validation('文件名无效');
      if (staged.size() > MAX_BYTES) throw validation('教材文件不能超过 50 MB');
      return { name, bytes: staged.readBounded(MAX_BYTES) };
    } finally { staged.dispose(); }
  };
  const watch = (id: string, type: 'created' | 'updated' | 'restored') => {
    const payload = { type, path: `/${id}` };
    for (const channel of [`dstu:change:/${id}`, 'dstu:change']) {
      try { ctx.backendEvents.emit(channel, payload); }
      catch (error) { log.warn('教材已保存，但更新事件发送失败: %s', describe(error)); }
    }
  };
  const progress = (name: string, stage: string, percent: number, error: string | null = null) => {
    try {
      ctx.backendEvents.emit('textbook-import-progress', {
        file_name: name, stage, current_page: null, total_pages: null, progress: percent, error,
      });
    } catch (issue) { log.warn('教材导入进度发送失败: %s', describe(issue)); }
  };
  const inspect = async (name: string, bytes: Uint8Array, extension: string) => {
    if (extension === 'pdf') {
      const header = [0x25, 0x50, 0x44, 0x46, 0x2d];
      if (!header.every((value, i) => bytes[i] === value)) throw validation('所选文件不是有效的 PDF');
      docs.checkPdfEncryptionBytes(bytes, name);
      const pdf = await webPdf.open(bytes);
      try {
        // Text extraction and rasterization run in the existing pipeline; reading needs the original PDF.
        return { pageCount: pdf.pageCount, text: null, pages: null };
      } finally { await pdf.close(); }
    }
    const pages = await docs.extractPagedTextFromBytes(name, bytes);
    return {
      pageCount: pages?.length || 1,
      text: pages?.length ? pages.join('\n\n').trim() : await docs.extractTextFromBytes(name, bytes),
      pages: pages?.length ? JSON.stringify(pages) : null,
    };
  };
  const persist = async (name: string, bytes: Uint8Array, sha256: string, extension: string | null) => {
    const database = deps.vfsDatabase();
    const path = await deps.vfsRepo().blobs.persistBlob(database.getConnSafe(), database.blobsDir(), bytes, extension, sha256);
    if (!path) throw new CommandError(AppError.configuration(`无法保存移动端教材：${name}`));
    return path;
  };

  ctx.commands.register<Commands['textbooks_add']['args'], Commands['textbooks_add']['result']>('textbooks_add',
    async ({ sources, folderId }) => {
      const database = deps.vfsDatabase();
      const repo = deps.vfsRepo();
      const out: Commands['textbooks_add']['result'] = [];
      const failures: string[] = [];
      if (folderId && !repo.folders.folderExists(database.getConnSafe(), folderId)) throw validation('目标文件夹不存在');
      for (const source of sources) {
        let name = '';
        try {
          const file = readSelected(source);
          name = file.name;
          const extension = extensionOf(name);
          if (!extension) throw validation('无法识别文件格式');
          progress(name, 'hashing', 5);
          const sha256 = await ctx.crypto.sha256Hex(file.bytes);
          const existing = repo.textbooks.getBySha256(database.getConnSafe(), sha256);
          progress(name, 'parsing', 15);
          const detail = existing ? null : await inspect(name, file.bytes, extension);
          progress(name, 'saving', 90);
          const path = await persist(name, file.bytes, sha256, extensionOf(existing?.fileName ?? name));
          const { textbook, type } = database.getConnSafe().transaction((conn) => {
            const current = repo.textbooks.getBySha256(conn, sha256);
            let textbook;
            let type: 'created' | 'updated' | 'restored';
            if (current) {
              textbook = repo.textbooks.relinkPersistedBlob(conn, database.blobsDir(), current.id, sha256,
                file.bytes, extensionOf(current.fileName), path);
              type = current.status === 'active' ? 'updated' : 'restored';
              if (type === 'restored') {
                repo.textbooks.restoreTextbook(conn, textbook.id);
                textbook = repo.textbooks.getTextbook(conn, textbook.id) ?? textbook;
              }
            } else {
              if (!detail) throw validation('教材已删除，请重新选择文件');
              const blob = repo.blobs.storeBlob(conn, database.blobsDir(), file.bytes, null, extension, path);
              textbook = repo.textbooks.createTextbookWithPreview(conn, sha256, name, file.bytes.length,
                blob.hash, null, null, detail.text, detail.pageCount);
              if (detail.pages !== null) repo.textbooks.updateTextbookOcrPagesJson(conn, textbook.id, detail.pages);
              type = 'created';
            }
            if (folderId && repo.textbooks.getTextbookLocation(conn, textbook.id)?.folderId !== folderId) {
              repo.folders.addItemToFolder(conn, {
                id: `fi_${nanoid(10)}`, folderId, itemType: 'file', itemId: textbook.id, sortOrder: 0, createdAt: Date.now(),
              });
            }
            return { textbook, type };
          }, { behavior: 'immediate' });
          watch(textbook.id, type);
          out.push(toTextbook(textbook));
          progress(name, 'done', 100);
          const index = ctx.get('vfsIndex') as VfsIndexService | undefined;
          if (type === 'created' && index) {
            const task = extension === 'pdf' ? index.pdf.startPipeline(textbook.id)
              : textbook.resourceId ? index.indexing.indexResource(textbook.resourceId) : null;
            void task?.catch(error => log.warn('教材已导入，但索引启动失败: %s', describe(error)));
          }
        } catch (error) {
          const message = describe(error);
          progress(name, 'error', 0, message);
          failures.push(name ? `${name}: ${message}` : message);
        }
      }
      if (out.length === 0 && failures.length) throw validation(failures.join('; '));
      return out;
    });

  ctx.commands.register<Commands['textbooks_relink']['args'], Commands['textbooks_relink']['result']>('textbooks_relink',
    async ({ id, newPath }) => {
      const database = deps.vfsDatabase();
      const { textbooks } = deps.vfsRepo();
      const textbook = textbooks.getTextbook(database.getConnSafe(), id);
      if (!textbook) throw new CommandError(AppError.not_found(`教材不存在: ${id}`));
      try {
        const { bytes } = readSelected(newPath);
        const sha256 = await ctx.crypto.sha256Hex(bytes);
        if (sha256 !== textbook.sha256) throw validation('所选文件与原文件内容不一致，请选择同一个文件');
        const extension = extensionOf(textbook.fileName);
        const path = await persist(textbook.fileName, bytes, sha256, extension);
        const updated = database.getConnSafe().transaction(conn => textbooks.relinkPersistedBlob(
          conn, database.blobsDir(), id, sha256, bytes, extension, path), { behavior: 'immediate' });
        watch(id, 'updated');
        return toTextbook(updated);
      } catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(AppError.file_system(describe(error)));
      }
    });
}
