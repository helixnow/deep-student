/** pipeline/history.rs:578–712. Resource resolution belongs to L05. */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatMessage } from '../../chat/api.ts';
import type { AgentVfsResolver, VfsContextRefData, VfsResourceRef } from '../../agent-workspace/api.ts';
import type { ResourceRepository } from '../../vfs-repos/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

type Logger = Pick<Context['logger'], 'debug' | 'info' | 'warn'>;
const resourceTypes = ['note', 'textbook', 'exam', 'translation', 'essay', 'image',
  'file', 'retrieval', 'mindmap', 'insightcard'] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unitEnum<T extends string>(value: unknown, variants: readonly T[]): T | null {
  if (record(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || value[keys[0]!] !== null) return null;
    value = keys[0];
  }
  return typeof value === 'string' && variants.includes(value as T) ? value as T : null;
}

/** The serde_json::from_str call at history.rs:642; invalid data takes the inline branch. */
export function parseContextRefData(text: string): VfsContextRefData | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!record(data) || !Array.isArray(data.refs)) return null;
  if (data.truncated !== undefined && typeof data.truncated !== 'boolean') return null;
  if (data.totalCount !== undefined && (typeof data.totalCount !== 'number'
    || !Number.isInteger(data.totalCount) || data.totalCount < 0 || data.totalCount >= 18_446_744_073_709_551_616)) return null;
  const refs: VfsResourceRef[] = [];
  for (const raw of data.refs) {
    if (!record(raw) || typeof raw.sourceId !== 'string' || typeof raw.resourceHash !== 'string'
      || typeof raw.name !== 'string') return null;
    const type = unitEnum(raw.type, resourceTypes);
    if (type === null) return null;
    if ([raw.resourceId, raw.snippet].some(value => value != null && typeof value !== 'string')) return null;
    const ref: VfsResourceRef = { sourceId: raw.sourceId, resourceHash: raw.resourceHash, type, name: raw.name };
    if (raw.resourceId !== undefined) ref.resourceId = raw.resourceId as string | null;
    if (raw.snippet !== undefined) ref.snippet = raw.snippet as string | null;
    if (raw.injectModes != null) {
      if (!record(raw.injectModes)) return null;
      const modes: NonNullable<VfsResourceRef['injectModes']> = {};
      for (const key of ['image', 'pdf'] as const) {
        const input = raw.injectModes[key];
        if (input == null) { if (input === null) modes[key] = null; continue; }
        if (!Array.isArray(input)) return null;
        if (key === 'image') {
          const parsed = input.map(value => unitEnum(value, ['image', 'ocr'] as const));
          if (parsed.some(value => value === null)) return null;
          modes.image = parsed as ('image' | 'ocr')[];
        } else {
          const parsed = input.map(value => unitEnum(value, ['text', 'ocr', 'image'] as const));
          if (parsed.some(value => value === null)) return null;
          modes.pdf = parsed as ('text' | 'ocr' | 'image')[];
        }
      }
      ref.injectModes = modes;
    } else if (raw.injectModes === null) ref.injectModes = null;
    refs.push(ref);
  }
  return { refs, truncated: (data.truncated as boolean | undefined) ?? false,
    totalCount: (data.totalCount as number | undefined) ?? 0 };
}

export async function resolveHistoryContextSnapshot(originalContent: string, message: ChatMessage,
  conn: SqlExecutor, resources: ResourceRepository, resolver: AgentVfsResolver,
  logger: Logger): Promise<[string, string[]]> {
  const refs = message._meta?.contextSnapshot?.userRefs;
  if (refs == null || refs.length === 0) return [originalContent, []];
  logger.debug(`[ChatV2::pipeline] resolve_history_context_snapshot_v2 for message ${message.id}: ${refs.length} user_refs`);
  const texts: string[] = [];
  const images: string[] = [];
  for (const ref of refs) {
    let resource: ReturnType<ResourceRepository['getResource']>;
    try { resource = resources.getResource(conn, ref.resourceId); }
    catch (error) {
      logger.warn(`[ChatV2::pipeline] Failed to get resource ${ref.resourceId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (resource === null) {
      logger.warn(`[ChatV2::pipeline] Resource not found: ${ref.resourceId}`);
      continue;
    }
    if (resource.data == null) {
      logger.debug(`[ChatV2::pipeline] Resource ${ref.resourceId} has no data`);
      continue;
    }
    const data = parseContextRefData(resource.data);
    if (data !== null) {
      for (const vfsRef of data.refs) {
        if (vfsRef.type === 'image') vfsRef.injectModes = { image: ['image'], pdf: null };
        else if (vfsRef.type === 'file' || vfsRef.type === 'textbook') {
          vfsRef.injectModes = { image: null, pdf: ['text', 'image'] };
        }
      }
      const content = await resolver.resolveContextRefDataToContent(data, true);
      texts.push(...content.textContents);
      images.push(...content.imageBase64List);
    } else if (ref.typeId === 'note' || ref.typeId === 'translation' || ref.typeId === 'essay') {
      if (resource.data !== '') {
        texts.push(`<injected_context>\n[${resource.metadata?.title ?? ref.typeId}]\n${resource.data}\n</injected_context>`);
      }
    } else {
      logger.debug(`[ChatV2::pipeline] Unknown type_id for resource ${ref.resourceId}: ${ref.typeId}`);
    }
  }
  if (texts.length !== 0 || images.length !== 0) {
    logger.info(`[ChatV2::pipeline] Resolved ${texts.length} context items and ${images.length} images for message ${message.id}`);
  }
  return [texts.length === 0 ? originalContent : `${texts.join('\n\n')}\n\n---\n\n${originalContent}`, images];
}
