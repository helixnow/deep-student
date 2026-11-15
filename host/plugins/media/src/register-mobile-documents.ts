import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { fromBase64, toBase64 } from '../../../platform/crypto/encoding.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { webImage } from '../../../platform/native/image/web.ts';
import { officeText } from '../../../platform/native/office/text.ts';
import { webPdf } from '../../../platform/native/pdfium/web.ts';
import { PdfOcrService, sanitizePdfFileName, type PdfOcrModelsPort, type PdfOcrSession } from './pdf-ocr-service.ts';
import type { BoolWatch } from './pdf-ocr-sync.ts';
import { posix } from '../../../platform/util/path.ts';
import { ZipReader, memoryZipSource } from '../../../platform/zip/core/index.ts';
import type { LlmOcrPages } from '../../llm/api.ts';
import { parseDocumentFromBase64, parseDocumentFromPath } from './document-commands.ts';
import { htmlToText, xmlTokens } from './document-xml.ts';
import { testOcrEngine } from './ocr-engine-test.ts';
import { registerHandoutCommands } from './register-handout.ts';
import { isPlainTextCodeExtension } from './document-extensions.ts';
import { checkPdfEncryption } from './pdf-encryption.ts';
import { epubFindRootFile, epubParseOpf } from './epub-structure.ts';
import { resolveFile, sanitizeId } from './document-processing.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { DocsService } from '../api.ts';
import { recentDocumentTasks } from './document-tasks.ts';
import { compressImage } from './compress-image.ts';

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 16 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function checkSize(bytes: Uint8Array) {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('文件超过移动端 50 MB 解析上限');
}

async function openDocumentZip(bytes: Uint8Array) {
  checkSize(bytes);
  return ZipReader.open(memoryZipSource(bytes), {
    maxEntries: 10_000, maxCentralDirectoryBytes: 4 * 1024 * 1024,
  });
}

async function extractEpub(bytes: Uint8Array): Promise<string[]> {
  const zip = await openDocumentZip(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let remaining = MAX_DOCUMENT_BYTES;
  const read = async (name: string) => {
    const entry = zip.find(name);
    if (!entry) return null;
    if (entry.size > MAX_DOCUMENT_XML_BYTES || entry.size > remaining) {
      throw new Error('EPUB 正文超过移动端解析上限');
    }
    remaining -= entry.size;
    return decoder.decode(await zip.readEntry(entry));
  };
  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('EPUB 缺少 container.xml');
  const opfPath = epubFindRootFile(container);
  const opf = await read(opfPath);
  if (!opf) throw new Error('EPUB 缺少内容清单');
  const { metadata, spineHrefs } = epubParseOpf(opf);
  const pages: string[] = [];
  const title = metadata.get('title');
  const creator = metadata.get('creator');
  const header = [title ? `# ${title}` : '', creator ? `作者: ${creator}` : ''].filter(Boolean).join('\n\n');
  if (header) pages.push(header);
  for (const href of spineHrefs) {
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch { /* keep the original href */ }
    const path = decoded.startsWith('/')
      ? posix.normalize(decoded).slice(1)
      : posix.join(posix.dirname(opfPath), decoded);
    const xml = await read(path);
    const plainText = xml && htmlToText(xml).trim();
    if (plainText) pages.push(plainText);
  }
  return pages;
}

async function extractText(fileName: string, bytes: Uint8Array): Promise<string> {
  checkSize(bytes);
  const ext = posix.extname(fileName).toLowerCase();
  if (isPlainTextCodeExtension(ext.slice(1))) return officeText.extractPlainText(bytes);
  switch (ext) {
    case '.txt': case '.md': case '.markdown': return officeText.extractPlainText(bytes);
    case '.csv': return officeText.extractCsv(bytes);
    case '.html': case '.htm': return htmlToText(officeText.extractPlainText(bytes));
    case '.json': case '.xml': return officeText.extractPlainText(bytes);
    case '.pdf':
      checkPdfEncryption(bytes, fileName);
      return webPdf.extractText(bytes);
    case '.epub': return (await extractEpub(bytes)).join('\n\n');
    case '.docx': {
      if (bytes.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b)) {
        throw new Error(`文件 '${fileName}' 是加密的 Office 文档，请先解除密码保护后再上传`);
      }
      const zip = await openDocumentZip(bytes);
      const doc = zip.find('word/document.xml');
      if (!doc || doc.size > MAX_DOCUMENT_XML_BYTES) throw new Error('DOCX 缺少正文或正文过大');
      let inText = false;
      const text: string[] = [];
      for (const token of xmlTokens(new TextDecoder().decode(await zip.readEntry(doc)))) {
        if (token.kind === 'text') {
          if (inText) text.push(token.text);
        } else if (token.local === 't') inText = token.kind === 'start';
        else if (token.kind === 'start' && token.local === 'tab') text.push('\t');
        else if ((token.kind === 'end' && token.local === 'p') ||
          (token.kind === 'start' && (token.local === 'br' || token.local === 'cr'))) text.push('\n');
      }
      return text.join('').trim();
    }
    default: throw new Error(`移动端不支持解析此文件类型：${posix.extname(fileName)}`);
  }
}

export function registerMobileDocuments(ctx: Context) {
  const files = (): FilesService => {
    const service = ctx.reflect.get('files', false) as FilesService | undefined;
    if (!service) throw new CommandError(AppError.configuration('移动文件存储服务不可用'));
    return service;
  };
  const log = ctx.logger('media.documents');
  const docs = {
    version: 1,
    isPlainTextCodeExtension,
    checkPdfEncryptionBytes: checkPdfEncryption,
    extractTextFromBytes: extractText,
    async extractTextFromBase64(name: string, content: string) {
      if (content.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) throw new Error('文件超过移动端 50 MB 解析上限');
      return extractText(name, fromBase64(content));
    },
    async extractTextFromPath(path: string) {
      return extractText(posix.basename(path), await files().readBytes(path, { maxBytes: MAX_DOCUMENT_BYTES }));
    },
    extractEpubPagesFromBytes: extractEpub,
    async extractPagedTextFromBytes(name: string, bytes: Uint8Array) {
      return posix.extname(name).toLowerCase() === '.epub' ? extractEpub(bytes) : null;
    },
    async generateDocxFromSpec(spec: unknown) {
      const { generateDocx } = await import('../../../platform/native/office/docx.ts');
      return generateDocx(spec, webImage);
    },
    sanitizeDocumentId: sanitizeId,
    resolveFile(id: string) {
      const database = ctx.get('vfsDatabase') as VfsDatabase | undefined;
      if (!database) throw new Error('VFS database not configured');
      return resolveFile(database, id);
    },
  } satisfies Partial<DocsService>;
  ctx.reflect.provide('docs', docs);
  const readNoteImage = async (src: string) => {
    // Only note assets, never an arbitrary file encoded into the exported document.
    if (!src.startsWith('notes_assets/')) throw new Error('Expected a note asset path');
    const relative = src.slice('notes_assets/'.length);
    const mime = IMAGE_MIME[posix.extname(relative).toLowerCase()];
    if (!mime) throw new Error('Unsupported note image format');
    const scope = files().scope(posix.join(ctx.storage.locations.activeDir, 'notes_assets'));
    return `data:${mime};base64,${toBase64(await scope.readBytes(relative, { maxBytes: 16 * 1024 * 1024 }))}`;
  };
  ctx.commands.register<Commands['get_image_as_base64']['args'], string>('get_image_as_base64',
    async ({ relativePath }) => {
      try {
        const raw = decodeURIComponent(relativePath.replace(/^(?:asset|tauri|file):\/\/(?:localhost)?/, ''));
        const active = ctx.storage.locations.activeDir;
        const path = posix.isAbsolute(raw) ? posix.normalize(raw) : posix.join(active, raw);
        const local = posix.relative(active, path);
        const [root, ...parts] = local.split('/');
        const mime = IMAGE_MIME[posix.extname(path).toLowerCase()];
        if (!root || !['notes_assets', 'images'].includes(root) || parts.length === 0 || !mime) {
          throw new Error('只能读取应用内的图片资源');
        }
        return `data:${mime};base64,${toBase64(await files().scope(posix.join(active, root))
          .readBytes(parts.join('/'), { maxBytes: MAX_DOCUMENT_BYTES }))}`;
      } catch (error) {
        throw new CommandError(AppError.file_system(error instanceof Error ? error.message : String(error)));
      }
    });
  ctx.commands.register<Commands['compress_image']['args'], Commands['compress_image']['result']>('compress_image',
    async args => {
      try {
        if (args.bytesBase64 && args.bytesBase64.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) {
          throw new Error('图片超过移动端 50 MB 上限');
        }
        return await compressImage(() => webImage, args, {
          read: path => files().readBytes(path, { maxBytes: MAX_DOCUMENT_BYTES }),
          write: (path, bytes) => files().writeBytes(path, bytes, { createParents: true, exclusive: true }),
          tempDir: () => posix.join(ctx.paths.appDataDir, 'tmp'),
        });
      } catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
    });
  ctx.commands.register<Commands['get_recent_document_tasks']['args'], Commands['get_recent_document_tasks']['result']>(
    'get_recent_document_tasks', ({ limit }) => {
      try { return recentDocumentTasks(ctx.storage.database('mistakes'), limit ?? 20); }
      catch (error) { throw new CommandError(AppError.database(error instanceof Error ? error.message : String(error))); }
    });
  registerHandoutCommands(ctx, readNoteImage, () => ({ generateDocx: docs.generateDocxFromSpec }));

  ctx.commands.register<Commands['parse_document_from_base64']['args'], string>('parse_document_from_base64',
    ({ fileName, base64Content }) => parseDocumentFromBase64(docs, fileName, base64Content, log));
  ctx.commands.register<Commands['parse_document_from_path']['args'], string>('parse_document_from_path',
    ({ filePath }) => parseDocumentFromPath(docs, filePath, log));

  const uploads = new Map<string, PdfOcrSession>();
  const sessions = new Map<string, { cancelTx: BoolWatch; pauseTx: BoolWatch }>();
  const ocr = new PdfOcrService({
    files,
    async canonicalize(path) { await files().stat(path); return posix.normalize(path); },
    appDataDir: () => ctx.paths.appDataDir,
    imagesDir: () => posix.join(ctx.paths.appDataDir, 'images'),
    ocrModels: () => ctx.get('llmOcrModels') as PdfOcrModelsPort | undefined,
    ocrPages: () => ctx.get('llmOcrPages') as LlmOcrPages | undefined,
    pdfium: () => webPdf,
    image: () => webImage,
    emit(payload) {
      if (payload.type === 'Completed' && typeof payload.session_id === 'string') {
        uploads.delete(payload.session_id);
        sessions.delete(payload.session_id);
      }
      ctx.backendEvents.emit('pdf_ocr_progress', payload);
    },
    log: ctx.logger('media.pdf_ocr'),
  });
  const limitBase64 = (data: string) => {
    if (data.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 256) {
      throw new CommandError(AppError.validation('文件超过移动端 50 MB 解析上限'));
    }
  };
  const temp = () => posix.join(ctx.paths.appDataDir, 'tmp', 'pdf_ocr_temp');
  ctx.commands.register('get_pdf_ocr_temp_dir', async () => {
    await files().mkdir(temp(), { recursive: true });
    return temp();
  });
  ctx.commands.register<Commands['save_pdf_to_temp']['args'], string>('save_pdf_to_temp',
    async ({ pdfBase64, fileName }) => {
      limitBase64(pdfBase64);
      const path = posix.join(temp(), `${globalThis.crypto.randomUUID()}_${sanitizePdfFileName(fileName)}`);
      try {
        const content = pdfBase64.startsWith('data:') ? pdfBase64.slice(pdfBase64.indexOf(',') + 1) : pdfBase64;
        await files().writeBytes(path, fromBase64(content), { createParents: true, exclusive: true });
        return path;
      } catch (error) {
        throw new CommandError(AppError.file_system(error instanceof Error ? error.message : String(error)));
      }
    });
  ctx.commands.register<Commands['init_pdf_ocr_session']['args'], string>('init_pdf_ocr_session',
    async ({ pdfBase64, pdfName, totalPages }) => {
      limitBase64(pdfBase64);
      const [id, session] = await ocr.startSession(pdfBase64, pdfName ?? null, totalPages);
      uploads.set(id, session);
      sessions.set(id, session);
      return id;
    });
  ctx.commands.register<Commands['upload_pdf_ocr_page']['args'], null>('upload_pdf_ocr_page',
    async ({ sessionId, page }) => {
      limitBase64(page.image_base64);
      const session = uploads.get(sessionId);
      if (!session) throw new CommandError(AppError.new('NotFound', `Session ${sessionId} not found`));
      await ocr.addPage(session.pageTx, sessionId, page);
      return null;
    });
  ctx.commands.register<Commands['start_pdf_ocr_backend']['args'], string>('start_pdf_ocr_backend',
    async ({ pdfPath, pdfName, renderDpi }) => {
      const stat = await files().stat(pdfPath);
      if (stat.kind !== 'file' || stat.size > MAX_DOCUMENT_BYTES) throw new CommandError(AppError.validation('PDF 文件超过移动端 50 MB 上限'));
      const [id, cancelTx, pauseTx] = await ocr.startBackendSession(pdfPath, pdfName ?? null, renderDpi ?? null);
      sessions.set(id, { cancelTx, pauseTx });
      return id;
    });
  ctx.commands.register<Commands['process_pdf_ocr']['args'], Commands['process_pdf_ocr']['result']>('process_pdf_ocr',
    ({ request }) => ocr.processPdf(request));
  ctx.commands.register<Commands['cancel_pdf_ocr_session']['args'], boolean>('cancel_pdf_ocr_session',
    ({ sessionId }) => {
      const controller = sessions.get(sessionId);
      if (!controller) return false;
      controller.cancelTx.send(true);
      controller.pauseTx.send(false);
      uploads.get(sessionId)?.pageTx.close();
      return true;
    });
  for (const [name, pause] of [['pause_pdf_ocr_session', true], ['resume_pdf_ocr_session', false]] as const) {
    ctx.commands.register<Commands[typeof name]['args'], boolean>(name, ({ sessionId }) => {
      const controller = sessions.get(sessionId);
      if (!controller) return false;
      controller.pauseTx.send(pause);
      return true;
    });
  }

  ctx.commands.register('test_pdfium_status', () => webPdf.diagnostics!());
  ctx.commands.register<Commands['test_ocr_engine']['args'], Commands['test_ocr_engine']['result']>('test_ocr_engine',
    ({ request }) => testOcrEngine({
      settings: ctx.settings,
      appDataDir: () => ctx.paths.appDataDir,
      ocrPages: () => ctx.get('llmOcrPages') as LlmOcrPages | undefined,
      platform: ctx.app.platform,
      async systemOcr() { throw new Error('Android 未提供系统 OCR，请选用已配置的 OCR 模型'); },
      writeTemp: (path, bytes) => files().writeBytes(path, bytes, { createParents: true, exclusive: true }),
      removeTemp: path => files().rm(path, { force: true }),
    }, request));

  return docs;
}
