/** builtin_resource_executor.rs:2260-2421,2497-2733. Writes delegate to L11. */
import type { Context } from '@deepseek-ai/cordis';
import type { VfsMindMap, JsonValue } from '../../../vfs-repos/api.ts';
import { charCount, rustTrim, takeChars, utf8ByteLength } from '../../../../platform/util/portable.ts';
import { createdEvent, updatedEvent, deletedEvent } from '../dstu-types.ts';
import { mindmapToDstuNode } from '../node-converters.ts';
import { emitDstuWatchEvent } from '../locations.ts';
import { fixMindmapContent, valueString } from './mindmap-document.ts';
import { toolVfsDatabase, toolVfsRepos } from './tool-services.ts';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const elapsed = (start: number) => Math.floor(performance.now() - start);
const wire = (mindmap: VfsMindMap) => ({ id: mindmap.id, title: mindmap.title, description: mindmap.description ?? null,
  defaultView: mindmap.defaultView, theme: mindmap.theme ?? null, createdAt: mindmap.createdAt, updatedAt: mindmap.updatedAt });
function emit(ctx: Context, event: Parameters<typeof emitDstuWatchEvent>[1]): void {
  emitDstuWatchEvent({ database: toolVfsDatabase(ctx), log: ctx.logger, emit: (name, value) => ctx.backendEvents.emit(name, value) }, event);
}
export function createToolMindmap(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const title = valueString(args.title);
  if (title === null || rustTrim(title) === '') throw new Error("Missing required parameter 'title'. 请提供思维导图标题。");
  const raw = Object.hasOwn(args, 'content') ? typeof args.content === 'string' ? args.content : JSON.stringify(args.content)
    : '{"version":"1.0","root":{"id":"root","text":"根节点","children":[]},"meta":{"createdAt":""}}';
  const content = fixMindmapContent(raw, ctx.logger), folder = valueString(args.folder_id);
  const folderId = folder === '' || folder === 'root' ? null : folder;
  ctx.logger.info('[BuiltinResourceExecutor] mindmap_create: title=%s, folder_id=%s, raw_len=%d, fixed_len=%d', title, folderId, utf8ByteLength(raw), utf8ByteLength(content));
  ctx.logger.debug('[BuiltinResourceExecutor] mindmap_create raw content: %s', charCount(raw) > 500 ? `${takeChars(raw, 500)}...` : raw);
  ctx.logger.debug('[BuiltinResourceExecutor] mindmap_create fixed content: %s', charCount(content) > 500 ? `${takeChars(content, 500)}...` : content);
  const start = performance.now(), repo = toolVfsRepos(ctx).mindmaps, db = toolVfsDatabase(ctx).getConnSafe();
  let mindmap;
  try { mindmap = repo.createMindmapInFolder(db, { title, description: valueString(args.description), content,
    defaultView: valueString(args.default_view) ?? 'mindmap', theme: valueString(args.theme) }, folderId); }
  catch (error) { throw new Error(`Failed to create mindmap: ${detail(error)}`); }
  const durationMs = elapsed(start);
  ctx.logger.info('[BuiltinResourceExecutor] mindmap_create completed: id=%s in %dms', mindmap.id, durationMs);
  const node = mindmapToDstuNode(mindmap); emit(ctx, createdEvent(node.path, node));
  let initial: string | null;
  try { initial = repo.getMindmapContent(db, mindmap.id); }
  catch { initial = null; }
  let versionId: string | null = null;
  if (initial !== null) {
    try { versionId = repo.createVersion(db, mindmap.id, initial, mindmap.title, null, 'chat_create').versionId; }
    catch (error) { ctx.logger.warn('[BuiltinResourceExecutor] Failed to create initial version for mindmap %s: %s', mindmap.id, detail(error)); }
  }
  return { success: true, mindmap: wire(mindmap), durationMs, ...(versionId === null ? {} : { versionId,
    citation: `[思维导图:${versionId}:${title}]`, hint: '请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看导图。回答聚焦某个具体节点时，在 ID 后紧跟 #节点文字（如 [思维导图:mv_xxx#AllReduce 同步梯度:标题]），点击后会直接定位并高亮该节点；节点文字中不要出现半角冒号。' }) };
}
export function updateToolMindmap(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const id = valueString(args.mindmap_id);
  if (id === null) throw new Error('Missing \'mindmap_id\' parameter. 请先调用 resource_list(type="mindmap") 获取可用的知识导图 ID。');
  const title = valueString(args.title), content = Object.hasOwn(args, 'content')
    ? fixMindmapContent(typeof args.content === 'string' ? args.content : JSON.stringify(args.content), ctx.logger) : null;
  ctx.logger.info('[BuiltinResourceExecutor] mindmap_update: id=%s, title=%s', id, title);
  const start = performance.now(), repo = toolVfsRepos(ctx).mindmaps, db = toolVfsDatabase(ctx).getConnSafe();
  let current;
  try { current = repo.getMindmap(db, id); }
  catch (error) { ctx.logger.error('[BuiltinResourceExecutor] OCC pre-check failed for mindmap %s: %s', id, detail(error)); throw new Error(`无法验证导图状态，请重试: ${detail(error)}`); }
  if (current === null) throw new Error(`Mindmap not found: ${id}. 请先调用 resource_list(type="mindmap") 确认导图存在。`);
  let updated;
  try { updated = repo.updateMindmapReturningVersion(db, id, { title, description: valueString(args.description), content,
    defaultView: valueString(args.default_view), theme: valueString(args.theme),
    ...(Object.hasOwn(args, 'settings') ? { settings: args.settings as JsonValue } : {}), expectedUpdatedAt: current.updatedAt, versionSource: 'chat_update' }, true); }
  catch (error) { throw new Error(`Failed to update mindmap: ${detail(error)}`); }
  const [mindmap, version] = updated, durationMs = elapsed(start);
  ctx.logger.info('[BuiltinResourceExecutor] mindmap_update completed: id=%s in %dms', mindmap.id, durationMs);
  const node = mindmapToDstuNode(mindmap); emit(ctx, updatedEvent(node.path, node));
  return { success: true, mindmap: wire(mindmap), durationMs, ...(version === null ? {} : { versionId: version.versionId,
    citation: `[思维导图:${version.versionId}:${mindmap.title}]`, hint: '请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看更新后的导图。' }) };
}
export async function deleteToolMindmap(ctx: Context, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const id = valueString(Object.hasOwn(args, 'mindmap_id') ? args.mindmap_id : args.resource_id);
  if (id === null) throw new Error('Missing \'mindmap_id\' parameter. 请先调用 resource_list(type="mindmap") 获取可用的知识导图 ID。');
  ctx.logger.info('[BuiltinResourceExecutor] mindmap_delete: mindmap_id=%s', id);
  const start = performance.now(), repo = toolVfsRepos(ctx).mindmaps, db = toolVfsDatabase(ctx).getConnSafe();
  let mindmap;
  try { mindmap = repo.getMindmap(db, id); } catch (error) { throw new Error(`Failed to get mindmap: ${detail(error)}`); }
  if (mindmap === null) throw new Error(`Mindmap not found: ${id}`);
  try { repo.deleteMindmap(db, id); } catch (error) { throw new Error(`Failed to delete mindmap: ${detail(error)}`); }
  let remaining;
  try { remaining = repo.countActiveMindmapsByResourceId(db, mindmap.resourceId); } catch (error) { throw new Error(`Failed to count mindmap references: ${detail(error)}`); }
  const warnings: string[] = [];
  if (remaining === 0) {
    const lance = ctx.get('vfsIndex')?.lance;
    if (lance) {
      try { await lance.deleteByResource('text', mindmap.resourceId); }
      catch (error) { ctx.logger.warn('[BuiltinResourceExecutor] Failed to delete lance index for mindmap %s: %s', mindmap.resourceId, detail(error)); warnings.push(`搜索索引清理失败: ${detail(error)}`); }
    }
    try { toolVfsRepos(ctx).indexStates.markDisabledWithReason(db, mindmap.resourceId, 'mindmap deleted'); }
    catch (error) { ctx.logger.warn('[BuiltinResourceExecutor] Failed to mark index disabled for mindmap %s: %s', mindmap.resourceId, detail(error)); warnings.push(`索引状态标记失败: ${detail(error)}`); }
  }
  const durationMs = elapsed(start);
  ctx.logger.info('[BuiltinResourceExecutor] mindmap_delete completed: id=%s in %dms', id, durationMs);
  emit(ctx, deletedEvent(`/mindmaps/${id}`));
  return { success: true, deletedId: id, durationMs, ...(warnings.length === 0 ? {} : { warning: `导图已删除，但部分清理未完成: ${warnings.join('; ')}` }) };
}
