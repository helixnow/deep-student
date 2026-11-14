/** builtin_resource_executor.rs:4866-5153. */
import type { Context } from '@deepseek-ai/cordis';
import type { VfsMindMapVersion } from '../../../vfs-repos/api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { collectMindmapNodes, parseMindmapDocument, valueString, type MindmapNodeSnapshot } from './mindmap-document.ts';
import { toolVfsDatabase, toolVfsRepos } from './tool-services.ts';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const limitOf = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64 ? Math.min(100, Math.max(1, value)) : 20;
function stage<T>(prefix: string, work: () => T): T { try { return work(); } catch (error) { throw new Error(`${prefix}: ${detail(error)}`); } }
const versionRef = (version: VfsMindMapVersion) => ({ type: 'version', versionId: version.versionId, mindmapId: version.mindmapId,
  title: version.title, createdAt: version.createdAt, citation: `[思维导图:${version.versionId}:${version.title}（${version.createdAt}）]` });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function listToolMindmapVersions(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const id = valueString(args.mindmap_id);
  if (id === null) throw new Error("Missing 'mindmap_id' parameter");
  const versions = stage('Failed to list mindmap versions', () => toolVfsRepos(ctx).mindmaps.getVersions(toolVfsDatabase(ctx).getConnSafe(), id));
  const items = versions.slice(0, limitOf(args.limit)).map(version => ({ versionId: version.versionId, mindmapId: version.mindmapId,
    title: version.title, label: version.label ?? null, source: version.source ?? null, createdAt: version.createdAt,
    citation: `[思维导图:${version.versionId}:${version.title}（${version.createdAt}）]` }));
  return { success: true, mindmapId: id, count: items.length, versions: items };
}
export function diffToolMindmapVersions(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const id = valueString(args.mindmap_id);
  if (id === null) throw new Error("Missing 'mindmap_id' parameter");
  if (!id.startsWith('mm_')) throw new Error(`Invalid mindmap_id: ${id}`);
  const limit = limitOf(args.detail_limit), fromId = rustTrim(valueString(args.from_version_id) ?? ''), toId = rustTrim(valueString(args.to_version_id) ?? '') || 'current';
  const repo = toolVfsRepos(ctx).mindmaps, db = toolVfsDatabase(ctx).getConnSafe();
  const versions = stage('Failed to list mindmap versions', () => repo.getVersions(db, id));
  const from = fromId === '' ? versions[0] : versions.find(v => v.versionId === fromId);
  if (from === undefined) throw new Error(fromId === '' ? `No historical version found for ${id}. 请先进行一次更新再执行 diff。` : `from_version_id not found: ${fromId}`);
  if (from.mindmapId !== id) throw new Error(`Version ${from.versionId} does not belong to mindmap ${id}`);
  const fromContent = stage('Failed to read from version content', () => repo.getVersionContent(db, from.versionId));
  if (fromContent === null) throw new Error(`Version content not found: ${from.versionId}`);
  const fromDoc = parseMindmapDocument(fromContent);
  let toRef: Record<string, unknown>, toContent: string;
  if (toId.replace(/[A-Z]/g, ch => ch.toLowerCase()) === 'current') {
    const current = stage('Failed to read current mindmap metadata', () => repo.getMindmap(db, id));
    if (current === null) throw new Error(`Mindmap not found: ${id}`);
    const content = stage('Failed to read current mindmap content', () => repo.getMindmapContent(db, id));
    if (content === null) throw new Error(`Current mindmap content not found: ${id}`);
    toContent = content; toRef = { type: 'current', mindmapId: id, title: current.title, citation: `[思维导图:${id}:${current.title}]` };
  } else if (toId.startsWith('mv_')) {
    const version = stage('Failed to read target version metadata', () => repo.getVersion(db, toId));
    if (version === null) throw new Error(`to_version_id not found: ${toId}`);
    if (version.mindmapId !== id) throw new Error(`Version ${version.versionId} does not belong to mindmap ${id}`);
    const content = stage('Failed to read target version content', () => repo.getVersionContent(db, toId));
    if (content === null) throw new Error(`Version content not found: ${toId}`);
    toContent = content; toRef = versionRef(version);
  } else throw new Error(`Invalid to_version_id: ${toId}. Use mv_* or current.`);
  const toDoc = parseMindmapDocument(toContent), fromNodes = new Map<string, MindmapNodeSnapshot>(), toNodes = new Map<string, MindmapNodeSnapshot>();
  collectMindmapNodes(fromDoc.root, null, 'root', fromNodes); collectMindmapNodes(toDoc.root, null, 'root', toNodes);
  const added: MindmapNodeSnapshot[] = [], removed: MindmapNodeSnapshot[] = [];
  const modified: Array<{ id: string; before: unknown; after: unknown }> = [];
  const moved: Array<{ id: string; text: string; beforeParentId: string | null; afterParentId: string | null; beforePath: string; afterPath: string }> = [];
  for (const [id, to] of toNodes) {
    const previous = fromNodes.get(id);
    if (previous === undefined) added.push(to);
    else {
      if (previous.signature !== to.signature) modified.push({ id, before: { text: previous.text, path: previous.path }, after: { text: to.text, path: to.path } });
      if (previous.parentId !== to.parentId) moved.push({ id, text: to.text, beforeParentId: previous.parentId, afterParentId: to.parentId, beforePath: previous.path, afterPath: to.path });
    }
  }
  for (const [id, from] of fromNodes) if (!toNodes.has(id)) removed.push(from);
  added.sort((a, b) => compare(a.path, b.path)); removed.sort((a, b) => compare(a.path, b.path));
  modified.sort((a, b) => compare(a.id, b.id)); moved.sort((a, b) => compare(a.id, b.id));
  const show = ({ id, text, parentId, path }: MindmapNodeSnapshot) => ({ id, text, parentId, path });
  return { success: true, mindmapId: id, from: versionRef(from), to: toRef,
    summary: { fromNodeCount: fromNodes.size, toNodeCount: toNodes.size, added: added.length, removed: removed.length, modified: modified.length, moved: moved.length,
      totalChanges: added.length + removed.length + modified.length + moved.length },
    changes: { added: added.slice(0, limit).map(show), removed: removed.slice(0, limit).map(show), modified: modified.slice(0, limit), moved: moved.slice(0, limit) },
    truncated: { added: added.length > limit, removed: removed.length > limit, modified: modified.length > limit, moved: moved.length > limit, detailLimit: limit } };
}
