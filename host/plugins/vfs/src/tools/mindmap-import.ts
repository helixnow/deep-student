/** builtin_resource_executor.rs:2791-2915,3720-3893,3935-4265. */
import * as path from '../../../../platform/util/path.ts';
import type { Context } from '@deepseek-ai/cordis';
import { toRfc3339 } from '../../../../platform/time/index.ts';
import { utf8Decode } from '../../../../platform/crypto/encoding.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { ZipReader, memoryZipSource } from '../../../../platform/zip/core/index.ts';
import { fs } from '../local-runtime.ts';
import type { VfsFile } from '../../../vfs-repos/api.ts';
import { sourceIdForResource } from '../../repository/resource-tools.ts';
import { parseSerdeJson } from '../../repository/json.ts';
import { createdEvent } from '../dstu-types.ts';
import { mindmapToDstuNode } from '../node-converters.ts';
import { emitDstuWatchEvent } from '../locations.ts';
import { fixMindmapContent, recordOf, valueString } from './mindmap-document.ts';
import { detectImportFormat, MAX_IMPORT_BYTES, newImportStats, parseOutline, parseXmindJson, readImportZipEntry,
  validateJsonNode, type ImportNode, type ImportStats } from './mindmap-import-formats.ts';
import { parseMm, parseMmapXml, parseOpml, parseXmindXml, type MindmapXmlParser } from './mindmap-import-xml.ts';
import type { ResourceToolContext } from './resource-executor.ts';
import { toolVfsDatabase, toolVfsRepos } from './tool-services.ts';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
export interface VirtualFilePolicy { isVirtualUri(path: string): boolean }
function stage<T>(prefix: string, work: () => T): T { try { return work(); } catch (error) { throw new Error(`${prefix}: ${detail(error)}`); } }
async function stageAsync<T>(prefix: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new Error(`${prefix}: ${detail(error)}`); }
}
function resolveFile(ctx: Context, raw: string): [VfsFile, string[]] {
  const id = rustTrim(raw), db = toolVfsDatabase(ctx).getConnSafe(); let source: string;
  if (id.startsWith('file_') || id.startsWith('att_')) source = id;
  else if (id.startsWith('res_')) {
    const resource = stage(`Failed to resolve resource '${id}'`, () => toolVfsRepos(ctx).resources.getResource(db, id));
    if (resource === null) throw new Error(`Resource not found: ${id}`);
    if (resource.sourceId?.startsWith('file_') || resource.sourceId?.startsWith('att_')) source = resource.sourceId;
    else { const found = sourceIdForResource(db, 'files', id); if (found === null) throw new Error(`Resource '${id}' does not resolve to a file_/att_ attachment`); source = found; }
  } else throw new Error(`Unsupported resource id '${id}': mindmap_import 仅支持 file_/att_ 附件或映射到文件的 res_ 资源`);
  const file = stage(`Failed to query import file '${source}'`, () => toolVfsRepos(ctx).files.getFile(db, source));
  if (file === null) throw new Error(`Import file not found: ${id}`);
  const ids = new Set([id, file.id]); if (file.resourceId) ids.add(file.resourceId);
  return [file, [...ids]];
}
function readPath(file: string): Uint8Array {
  const info = stage('Failed to read import file metadata', () => fs.statSync(file));
  if (info.size > MAX_IMPORT_BYTES) throw new Error('导入文件超过大小上限（32 MB）');
  return stage('Failed to read import file', () => fs.readFileSync(file));
}
function loadBytes(ctx: Context, file: VfsFile): Uint8Array {
  const database = toolVfsDatabase(ctx), blobs = toolVfsRepos(ctx).blobs;
  for (const hash of [file.blobHash, rustTrim(file.sha256) !== '' ? file.sha256 : undefined]) {
    if (hash === undefined) continue;
    const target = stage(`Failed to resolve import blob '${file.id}'`, () => blobs.getBlobPath(database.getConnSafe(), database.blobsDir(), hash));
    if (target !== null) return readPath(target);
  }
  const original = file.originalPath;
  const policy = ctx.get('virtualFilePolicy') as VirtualFilePolicy;
  if (original !== undefined && !policy.isVirtualUri(original)) {
    const traversal = original.split(path.sep).includes('..');
    let regular = false;
    try { regular = fs.statSync(original).isFile(); } catch { regular = false; }
    if (!traversal && regular) return readPath(original);
  }
  throw new Error(`Import file '${file.id}' has no readable VFS blob or original path`);
}
async function xmind(parser: MindmapXmlParser, bytes: Uint8Array, title: string, stats: ImportStats): Promise<[ImportNode, ImportNode[]]> {
  const archive = await stageAsync('无效的 .xmind 文件（zip 解包失败）', () => ZipReader.open(memoryZipSource(bytes)));
  const json = await readImportZipEntry(archive, 'content.json');
  if (json !== null) return parseXmindJson(json, title, stats);
  const xml = await readImportZipEntry(archive, 'content.xml');
  if (xml !== null) return parseXmindXml(parser, xml, title, stats);
  throw new Error('无效的 .xmind 文件：缺少 content.json 或 content.xml');
}
async function mmap(parser: MindmapXmlParser, bytes: Uint8Array, stats: ImportStats): Promise<ImportNode> {
  const archive = await stageAsync('无效的 .mmap 文件（zip 解包失败）', () => ZipReader.open(memoryZipSource(bytes)));
  const xml = await readImportZipEntry(archive, 'Document.xml');
  if (xml === null) throw new Error('无效的 .mmap 文件：缺少 Document.xml');
  return parseMmapXml(parser, xml, stats);
}
export async function importToolMindmap(ctx: ResourceToolContext, args: Record<string, unknown>, parser: MindmapXmlParser): Promise<Record<string, unknown>> {
  const services = ctx.services;
  if (!services.get('vfsDatabase')) throw new Error('VFS database not available');
  const rawId = rustTrim(valueString(Object.hasOwn(args, 'resourceId') ? args.resourceId : args.resource_id) ?? '');
  if (rawId === '') throw new Error("Missing required parameter 'resourceId'. 请传入当前会话上传的思维导图附件资源 ID（file_/att_/res_）。");
  const customTitle = rustTrim(valueString(args.title) ?? '');
  const rawFolder = valueString(Object.hasOwn(args, 'targetFolderId') ? args.targetFolderId : args.folder_id), folder = rawFolder === '' || rawFolder === 'root' ? null : rawFolder;
  const start = performance.now(), [file, ids] = resolveFile(services, rawId);
  if (ctx.chat_v2_db == null) throw new Error('Chat database not available for import resource ownership check');
  stage('Failed to open chat database', () => ctx.chat_v2_db!.getConnSafe());
  const messages = stage('Failed to load session messages', () => services.chatSession.getSessionMessages(ctx.session_id ?? ''));
  const owned = [...messages].reverse().some(message => message._meta?.contextSnapshot?.userRefs?.some(ref => ids.includes(ref.resourceId)));
  if (!owned) throw new Error(`Resource '${rawId}' is not available in the current chat session. 只能导入当前会话上下文中的附件。`);
  const bytes = loadBytes(services, file), dot = file.fileName.lastIndexOf('.');
  const stem = dot < 0 ? '' : file.fileName.slice(0, dot), fallback = rustTrim(stem) !== '' ? stem : file.fileName;
  const detected = detectImportFormat(file.fileName, bytes), text = () => utf8Decode(bytes);
  let stats = newImportStats(), root: ImportNode, associations: ImportNode[] = [], format = detected;
  switch (detected) {
    case 'xmind': [root, associations] = await xmind(parser, bytes, fallback, stats); break;
    case 'mmap': root = await mmap(parser, bytes, stats); break;
    case 'zip': {
      try { [root, associations] = await xmind(parser, bytes, fallback, stats); format = 'xmind'; }
      catch (error) { stats = newImportStats(); try { root = await mmap(parser, bytes, stats); format = 'mmap'; }
        catch (other) { throw new Error(`无法识别的 zip 导图文件。.xmind 解析: ${detail(error)}；.mmap 解析: ${detail(other)}`); } }
      break;
    }
    case 'opml': root = parseOpml(parser, text(), fallback, stats); break;
    case 'mm': [root, associations] = parseMm(parser, text(), fallback, stats); break;
    case 'json': {
      const parsed = stage('无效的导图 JSON', () => parseSerdeJson(text())), doc = recordOf(parsed);
      if (doc === null || !Object.hasOwn(doc, 'root')) throw new Error('无效的导图 JSON：缺少 root 字段');
      const value = structuredClone(doc.root); validateJsonNode(value, 0, stats, { value: 0 }); root = value as ImportNode;
      associations = Array.isArray(doc.associations) ? structuredClone(doc.associations) as ImportNode[] : []; break;
    }
    default: root = parseOutline(text(), fallback, stats); format = detected === 'text' ? 'text' : 'markdown';
  }
  const title = customTitle || rustTrim(valueString(root.text) ?? '') || fallback;
  const doc = { version: '1.0', root, meta: { createdAt: toRfc3339() }, ...(associations.length === 0 ? {} : { associations }) };
  const content = fixMindmapContent(JSON.stringify(doc), services.logger);
  let associationCount = 0;
  try { const assoc = recordOf(parseSerdeJson(content))?.associations; associationCount = Array.isArray(assoc) ? assoc.length : 0; }
  catch { associationCount = 0; }
  services.logger.info('[BuiltinResourceExecutor] mindmap_import: resource=%s, format=%s, nodes=%d, associations=%d', rawId, format, stats.nodeCount, associationCount);
  const repo = toolVfsRepos(services).mindmaps, db = toolVfsDatabase(services).getConnSafe();
  const mindmap = stage('Failed to create mindmap from import', () => repo.createMindmapInFolder(db, { title, description: null, content, defaultView: 'mindmap', theme: null }, folder));
  const node = mindmapToDstuNode(mindmap);
  emitDstuWatchEvent({ database: toolVfsDatabase(services), log: services.logger, emit: (name, payload) => services.backendEvents.emit(name, payload) }, createdEvent(node.path, node));
  let initial: string | null;
  try { initial = repo.getMindmapContent(db, mindmap.id); } catch { initial = null; }
  let versionId: string | null = null;
  if (initial !== null) {
    try { versionId = repo.createVersion(db, mindmap.id, initial, mindmap.title, null, 'chat_create').versionId; }
    catch (error) { services.logger.warn('[BuiltinResourceExecutor] Failed to create initial version for imported mindmap %s: %s', mindmap.id, detail(error)); }
  }
  const durationMs = Math.floor(performance.now() - start);
  services.logger.info('[BuiltinResourceExecutor] mindmap_import completed: id=%s in %dms', mindmap.id, durationMs);
  return { success: true, mindmap: { id: mindmap.id, title: mindmap.title, description: mindmap.description ?? null, defaultView: mindmap.defaultView,
    theme: mindmap.theme ?? null, createdAt: mindmap.createdAt, updatedAt: mindmap.updatedAt }, importStats: { format, sourceFileName: file.fileName,
    nodeCount: stats.nodeCount, associationCount, droppedImages: stats.droppedImages, droppedSummaries: stats.droppedSummaries,
    droppedBoundaries: stats.droppedBoundaries, droppedHyperlinks: stats.droppedHyperlinks },
    notice: '样式/主题/图片等信息不导入；请根据 importStats 如实向用户汇报被忽略的内容。', durationMs,
    ...(versionId === null ? {} : { versionId, citation: `[思维导图:${versionId}:${title}]`,
      hint: '请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看导图。回答聚焦某个具体节点时，在 ID 后紧跟 #节点文字（如 [思维导图:mv_xxx#AllReduce 同步梯度:标题]），点击后会直接定位并高亮该节点；节点文字中不要出现半角冒号。' }) };
}
