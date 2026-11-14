/** VFS 解引用入口。L03/L04 注入 vfs、vfsRepo 和 docs 后消费此工厂。 */
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import type { VfsService } from '../../../vfs/api.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { resolveFile, resolveImage, type VfsResolverServices } from './assets.ts';
import { resolveExam } from './exam.ts';
import { resolveTextbook } from './pdf.ts';
import { resolveEssay, resolveInsightCard, resolveMindmap, resolveNote, resolveTranslation } from './resources.ts';
import { blocksToContent, ResolvedContent, textBlock, type ContentBlock,
  type VfsContextRefData, type VfsResolverLogger, type VfsResourceRef } from './model.ts';

export * from './model.ts';
export * from './pdf.ts';
export * from './exam.ts';
export * from './resources.ts';
export * from './assets.ts';

export function resolveRetrieval(ref: VfsResourceRef): ContentBlock[] {
  const text = ref.snippet ?? (rustTrim(ref.name) !== '' ? ref.name : '[检索结果]');
  return [textBlock(`<retrieval source="${ref.sourceId}">${text}</retrieval>`)];
}

export async function resolveVfsRefToBlocks(db: SqlExecutor, blobsDir: string, ref: VfsResourceRef,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): Promise<ContentBlock[]> {
  switch (ref.type) {
    case 'image': return resolveImage(db, blobsDir, ref, isMultimodal, logger, services);
    case 'file': return resolveFile(db, blobsDir, ref, isMultimodal, logger, services);
    case 'note': return resolveNote(db, ref, logger);
    case 'essay': return resolveEssay(db, ref, logger);
    case 'translation': return resolveTranslation(db, ref, logger);
    case 'textbook': return resolveTextbook(db, blobsDir, ref, isMultimodal, logger);
    case 'exam': return resolveExam(db, blobsDir, ref, logger);
    case 'retrieval': return resolveRetrieval(ref);
    case 'mindmap': return resolveMindmap(db, ref, logger);
    case 'insightcard': return resolveInsightCard(db, ref, logger);
  }
}

export async function resolveVfsRefToContent(db: SqlExecutor, blobsDir: string, ref: VfsResourceRef,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): Promise<ResolvedContent> {
  return blocksToContent(await resolveVfsRefToBlocks(db, blobsDir, ref, isMultimodal, logger, services), ref.name);
}

export async function resolveContextRefDataToBlocks(db: SqlExecutor, blobsDir: string, data: VfsContextRefData,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const ref of data.refs) blocks.push(...await resolveVfsRefToBlocks(db, blobsDir, ref, isMultimodal, logger, services));
  return blocks;
}

export async function resolveContextRefDataToContent(db: SqlExecutor, blobsDir: string, data: VfsContextRefData,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): Promise<ResolvedContent> {
  const result = new ResolvedContent();
  for (const ref of data.refs) result.merge(await resolveVfsRefToContent(db, blobsDir, ref, isMultimodal, logger, services));
  return result;
}

export function createVfsResolver(vfs: VfsService, services: VfsResolverServices, logger: VfsResolverLogger) {
  return {
    resolveVfsRefToBlocks: (ref: VfsResourceRef, multimodal: boolean) =>
      resolveVfsRefToBlocks(vfs.database.getConnSafe(), vfs.database.blobsDir(), ref, multimodal, logger, services),
    resolveVfsRefToContent: (ref: VfsResourceRef, multimodal: boolean) =>
      resolveVfsRefToContent(vfs.database.getConnSafe(), vfs.database.blobsDir(), ref, multimodal, logger, services),
    resolveContextRefDataToBlocks: (data: VfsContextRefData, multimodal: boolean) =>
      resolveContextRefDataToBlocks(vfs.database.getConnSafe(), vfs.database.blobsDir(), data, multimodal, logger, services),
    resolveContextRefDataToContent: (data: VfsContextRefData, multimodal: boolean) =>
      resolveContextRefDataToContent(vfs.database.getConnSafe(), vfs.database.blobsDir(), data, multimodal, logger, services),
  };
}
