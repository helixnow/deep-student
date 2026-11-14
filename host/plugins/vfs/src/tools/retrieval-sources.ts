/** builtin_retrieval_executor.rs:941-1121,1254-1475,2044-2063. */
import type { SourceInfo } from '../../../chat/api.ts';
import type { CitationLedger } from '../../../chat-pipeline/api.ts';
import type { QueryModality } from '../../../vfs-index/api.ts';
import { charCount, takeChars } from '../../../../platform/util/portable.ts';

export const objectOf = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const stringOf = (value: unknown): string | null => typeof value === 'string' ? value : null;
export function applyScoreThresholds(sources: SourceInfo[], minScore: number | null, relativeThreshold: number): SourceInfo[] {
  if (sources.length <= 1) return sources;
  const max = sources.reduce((max, source) => source.score == null ? max : Math.max(max, Math.fround(source.score)), -3.4028234663852886e38);
  if (!Number.isFinite(max) || max <= 0) return sources;
  const relativeMin = Math.fround(max * Math.fround(relativeThreshold));
  const filtered = sources.filter(source => source.score == null || (Math.fround(source.score) >= relativeMin && (minScore === null || Math.fround(source.score) >= Math.fround(minScore))));
  return filtered.length === 0 ? sources.slice(0, 1) : filtered;
}
export function truncateSnippetChars(text: string, maxChars: number): [string, number] {
  const count = charCount(text);
  if (count <= maxChars) return [text, count];
  if (maxChars === 0) return ['', 0];
  return [`${takeChars(text, maxChars - 1)}…`, maxChars];
}
export function citationPrefix(type: string): string {
  if (type.includes('multimodal')) return '图片';
  if (type === 'memory') return '记忆';
  if (type === 'insight') return '灵感';
  return type === 'academic_search' || type === 'web_search' ? '搜索' : '知识库';
}
export function citationGroup(type: string): string {
  if (type.includes('multimodal')) return 'multimodal';
  if (type === 'memory' || type === 'insight') return type;
  return type === 'academic_search' || type === 'web_search' ? 'web' : 'rag';
}
function citationIdentity(source: SourceInfo, group: string): string {
  const meta = objectOf(source.metadata), str = (key: string) => stringOf(meta[key]);
  const key = (name: string) => meta[name] == null ? '' : JSON.stringify(meta[name]);
  if (group === 'memory') {
    const note = str('noteId'); if (note !== null) return `note:${note}`;
  } else if (group === 'multimodal') {
    const resource = str('resourceId'), blob = str('blobHash'), page = key('pageIndex');
    if (resource) return `res:${resource}|p:${page}`;
    if (blob) return `blob:${blob}|p:${page}`;
  } else {
    const resource = str('resourceId'), id = str('sourceId');
    if (resource) return `res:${resource}|c:${key('chunkIndex')}`;
    if (id) return `src:${id}|c:${key('chunkIndex')}`;
  }
  if (source.url) return `url:${source.url}`;
  if (source.title) return `title:${source.title}`;
  return `snippet:${source.snippet ?? ''}`;
}
const DIRECT_PREFIXES = ['note_', 'tb_', 'file_', 'att_', 'exam_', 'essay_', 'essay_session_', 'es_', 'tr_', 'mm_'];
export function preferredReadResourceId(resourceId: string | null, sourceId: string | null): string | null {
  if (sourceId !== null && DIRECT_PREFIXES.some(prefix => sourceId.startsWith(prefix))) return sourceId;
  if (resourceId !== null && [...DIRECT_PREFIXES, 'res_'].some(prefix => resourceId.startsWith(prefix))) return resourceId;
  return sourceId ?? resourceId;
}
export function buildNumberedSources(sources: readonly SourceInfo[], ledger: Pick<CitationLedger, 'assign'>): Record<string, unknown>[] {
  let budget = 6000;
  return sources.map((source, index) => {
    const meta = objectOf(source.metadata), sourceType = stringOf(meta.sourceType) ?? 'text_search', group = citationGroup(sourceType);
    const citationIndex = ledger.assign(group, citationIdentity(source, group)).type_index;
    let snippet: string | null = null;
    if (source.snippet != null) {
      const [text, used] = truncateSnippetChars(source.snippet, Math.min(1500, budget));
      snippet = text; budget = Math.max(0, budget - used);
    }
    const resourceId = stringOf(meta.resourceId), sourceId = stringOf(meta.sourceId), noteId = meta.noteId ?? null;
    const result: Record<string, unknown> = {
      index: index + 1, citationTag: `[${citationPrefix(sourceType)}-${citationIndex}]`, typeIndex: citationIndex,
      title: source.title ?? null, url: source.url ?? null, snippet, score: source.score ?? null,
      imageUrl: meta.imageUrl ?? null, imageCitation: meta.imageCitation ?? null, pageIndex: meta.pageIndex ?? null,
      chunkIndex: meta.chunkIndex ?? null, resourceId, resourceType: meta.resourceType ?? null, sourceId,
      readResourceId: preferredReadResourceId(resourceId, sourceId), source_type: sourceType,
      blob_hash: meta.blobHash ?? null, retrievalProvenance: meta.retrievalProvenance ?? null,
      noteId, note_id: noteId, sourceNoteIds: meta.sourceNoteIds ?? null, folder_path: meta.folderPath ?? null,
    };
    if (Object.hasOwn(meta, 'timeRange')) { result.timeRange = meta.timeRange; result.mediaCitation = meta.mediaCitation ?? null; }
    return result;
  });
}
export function dedupKbAgainstMemory(kb: SourceInfo[], memory: readonly SourceInfo[], log: { debug(message: string, ...args: unknown[]): void }): SourceInfo[] {
  const ids = new Set<string>(), titles = new Set<string>();
  for (const source of memory) {
    const meta = objectOf(source.metadata), note = stringOf(meta.noteId);
    if (note !== null) ids.add(note);
    if (Array.isArray(meta.sourceNoteIds)) for (const id of meta.sourceNoteIds) if (typeof id === 'string') ids.add(id);
    if (source.title != null) titles.add(source.title);
  }
  const filtered = kb.filter(source => {
    const meta = objectOf(source.metadata);
    if (meta.resourceType !== 'note') return true;
    const id = stringOf(meta.sourceId) ?? '';
    if (id !== '' && ids.has(id)) return false;
    return source.title == null || !titles.has(source.title);
  });
  if (filtered.length < kb.length) log.debug('[BuiltinRetrievalExecutor] Deduped %d memory notes from KB results (noteId+title match)', kb.length - filtered.length);
  return filtered;
}
export function shouldRouteToUnifiedSearch(name: string): boolean { return ['rag_search', 'multimodal_search', 'unified_search'].includes(name); }
export function plannedSearchScope(name: string): 'multimodal_only' | 'unified' { return name === 'multimodal_search' ? 'multimodal_only' : 'unified'; }
export function selectRerankerKind(mode: QueryModality, candidates: readonly SourceInfo[]): 'text' | 'multimodal' {
  return mode !== 'text' || candidates.some(source => {
    const meta = objectOf(source.metadata); return meta.blobHash != null || meta.sourceType === 'multimodal_search';
  }) ? 'multimodal' : 'text';
}
export function scopeFolderIds(scope: readonly string[], modelIds: string[] | null): string[] | null {
  if (scope.length === 0) return modelIds;
  if (modelIds !== null && modelIds.length > 0) {
    const allowed = new Set(scope), narrowed = modelIds.filter(id => allowed.has(id));
    if (narrowed.length > 0) return narrowed;
  }
  return [...scope];
}
