/**
 * Mobile fallback for L05 `agentVfsResolver`.
 *
 * The real provider (`dstu.agent-workspace`) needs the desktop workspace coordinator plus L18 `docs`.
 * Neither is part of the mobile profile, so retry / edit-and-resend / continue were never registered
 * (`chat/src/plugin.ts` injected `agentVfsResolver`). This resolver keeps the same public shape and
 * dereferences what the mobile data plane can actually serve:
 *
 * - images: blob content from `vfsRepo.files.getContent` (base64);
 * - notes / essays / translations / mindmaps / insight cards: the node-free L05 resolvers;
 * - files / textbooks / exams: stored `extracted_text` (mobile has no PDFium / document parser);
 * - retrieval snippets: the same `<retrieval>` block the desktop resolver emits.
 *
 * PDF page rasterisation and document parsing stay desktop-only; when only binary content exists the
 * caller gets an explicit text block instead of a missing command.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentVfsResolver, VfsContextRefData, VfsResourceRef } from '../../agent-workspace/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import {
  blocksToContent, escapeXmlAttr, escapeXmlContent, imageBlock, inferMediaTypeFromName, textBlock,
  resolveEssay, resolveInsightCard, resolveMindmap, resolveNote, resolveTranslation,
  textbookFileRow, type ContentBlock,
} from '../../agent-workspace/portable.ts';

function resolveRetrieval(ref: VfsResourceRef): ContentBlock[] {
  const text = ref.snippet ?? (rustTrim(ref.name) !== '' ? ref.name : '[检索结果]');
  return [textBlock(`<retrieval source="${escapeXmlAttr(ref.sourceId)}">${text}</retrieval>`)];
}

function textFromStoredExtract(ctx: Context, ref: VfsResourceRef): string | null {
  const repo = ctx.get('vfsRepo');
  const vfs = ctx.get('vfs');
  if (repo === undefined || vfs === undefined) return null;
  try {
    const file = repo.files.getFile(vfs.database.getConnSafe(), ref.sourceId);
    const text = file?.extractedText;
    return text !== undefined && text !== null && rustTrim(text) !== '' ? text : null;
  } catch {
    return null;
  }
}

function textbookText(ctx: Context, db: SqlExecutor, ref: VfsResourceRef): string | null {
  try {
    const row = textbookFileRow(db, ref.sourceId);
    return row?.extractedText !== undefined && row.extractedText !== null && rustTrim(row.extractedText) !== ''
      ? row.extractedText : null;
  } catch {
    return textFromStoredExtract(ctx, ref);
  }
}

function resolveRef(ctx: Context, ref: VfsResourceRef): ContentBlock[] {
  const vfs = ctx.get('vfs');
  const repo = ctx.get('vfsRepo');
  if (vfs === undefined || repo === undefined) {
    throw new Error('context dereference requires the vfs and vfsRepo services');
  }
  const db = vfs.database.getConnSafe();
  const blobsDir = vfs.database.blobsDir();
  switch (ref.type) {
    case 'image': {
      const content = repo.files.getContent(db, blobsDir, ref.sourceId);
      if (content === null) return [textBlock(`[图片加载失败: ${ref.name}]`)];
      return [imageBlock(inferMediaTypeFromName(ref.name), content)];
    }
    case 'note': return resolveNote(db, ref);
    case 'essay': return resolveEssay(db, ref);
    case 'translation': return resolveTranslation(db, ref);
    case 'mindmap': return resolveMindmap(db, ref);
    case 'insightcard': return resolveInsightCard(db, ref);
    case 'retrieval': return resolveRetrieval(ref);
    case 'textbook': {
      const text = textbookText(ctx, db, ref);
      return [textBlock(text === null
        ? `<file name="${escapeXmlAttr(ref.name)}">[教材文本在移动端不可注入]</file>`
        : `<file name="${escapeXmlAttr(ref.name)}">${escapeXmlContent(text)}</file>`)];
    }
    case 'exam':
    case 'file': {
      const text = textFromStoredExtract(ctx, ref);
      return [textBlock(text === null
        ? `<file name="${escapeXmlAttr(ref.name)}">[文件文本在移动端不可注入]</file>`
        : `<file name="${escapeXmlAttr(ref.name)}">${escapeXmlContent(text)}</file>`)];
    }
  }
}

function resolveBlocks(ctx: Context, data: VfsContextRefData): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const ref of data.refs) blocks.push(...resolveRef(ctx, ref));
  return blocks;
}

/** `createVfsResolver`-shaped resolver backed only by VFS tables and blobs. */
export function createMobileVfsResolver(ctx: Context): AgentVfsResolver {
  return {
    resolveVfsRefToBlocks: (ref, _multimodal) => Promise.resolve(resolveRef(ctx, ref)),
    resolveVfsRefToContent: (ref, _multimodal) => Promise.resolve(
      blocksToContent(resolveRef(ctx, ref), ref.name)),
    resolveContextRefDataToBlocks: (data, _multimodal) => Promise.resolve(resolveBlocks(ctx, data)),
    resolveContextRefDataToContent: (data, _multimodal) => Promise.resolve(
      resolveContextRefDataToContent(ctx, data)),
  };
}

function resolveContextRefDataToContent(ctx: Context, data: VfsContextRefData) {
  const result = blocksToContent([], '');
  for (const ref of data.refs) result.merge(blocksToContent(resolveRef(ctx, ref), ref.name));
  return result;
}
