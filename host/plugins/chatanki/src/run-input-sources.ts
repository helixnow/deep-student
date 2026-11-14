// Host wiring of the `chatanki_run` VfsRef reads: L04 `chatSession` history, L02 `llmRawPrompt`
// (+ optional `llmAnkiRouting`) for the planner and VLM, and the L11 VFS read set — `vfsDatabase`
// connection and blobs dir, `vfsRepo`, agent-workspace `agentVfsResolver`, media `docs`, and L15's
// media transcript anchoring (`prepare_media_text_for_generation`).
import type { ContextRef, VfsResourceRef } from '../api.ts';
import type { LlmAnkiRouting, LlmRawPrompt } from '../../llm/api.ts';
import { prepareMediaTextForGeneration } from '../../review/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import {
  extractLatestUserContent, refTextFromVfs, resolveContextRefFromAnyId, resolveTargetContextRefs,
  type ChatAnkiSessionHistorySource, type ChatAnkiVfsReadSource,
} from './ref-resolver.ts';
import { createChatAnkiRoutePlanner } from './route-planner.ts';
import type { ChatAnkiRunInputSources, ChatAnkiRunVfsSource } from './run-vfs-input.ts';
import type { ChatAnkiRefBlock } from './run-vfs-text.ts';
import { createChatAnkiVlmExtractor } from './vlm-extract.ts';

export interface ChatAnkiRunInputHost {
  chatSession: ChatAnkiSessionHistorySource | undefined;
  rawPrompt: Pick<LlmRawPrompt, 'callAnkiRoutedRawPrompt' | 'callModel2RawPrompt'> | undefined;
  routing: Pick<LlmAnkiRouting, 'resolveAnkiRoleDecision'> | undefined;
  vfsDatabase: { getConnSafe(): SqlExecutor; blobsDir(): string } | undefined;
  vfsRepo: VfsReposService | undefined;
  vfsResolver: { resolveVfsRefToBlocks(ref: VfsResourceRef, multimodal: boolean): Promise<ChatAnkiRefBlock[]> } | undefined;
  docs: { extractTextFromBase64(fileName: string, base64Content: string): Promise<string> } | undefined;
  warn: (message: string) => void;
}

function createRunVfsSource(
  database: NonNullable<ChatAnkiRunInputHost['vfsDatabase']>, repos: VfsReposService,
  resolver: NonNullable<ChatAnkiRunInputHost['vfsResolver']>, docs: NonNullable<ChatAnkiRunInputHost['docs']>,
): ChatAnkiRunVfsSource {
  const read: ChatAnkiVfsReadSource = { repos, conn: () => database.getConnSafe() };
  return {
    resolveContextRefFromAnyId: (id): ContextRef | null => resolveContextRefFromAnyId(read, id),
    resourceData: (hash, resourceId) => {
      const conn = database.getConnSafe();
      let resource = null;
      try { resource = repos.resources.getByHash(conn, hash); }
      catch { resource = null; }
      if (resource === null) {
        try { resource = repos.resources.getResource(conn, resourceId); }
        catch { resource = null; }
      }
      return resource?.data ?? null;
    },
    refText: (ref, maxChars) => refTextFromVfs(read, ref, maxChars),
    fileExtractedText: (sourceId) => {
      const conn = database.getConnSafe();
      try { return repos.files.getFile(conn, sourceId)?.extractedText ?? null; }
      catch { return null; }
    },
    fileContentBase64: (sourceId) => {
      const conn = database.getConnSafe();
      try { return repos.files.getContent(conn, database.blobsDir(), sourceId); }
      catch { return null; }
    },
    extractTextFromBase64: (fileName, base64) => docs.extractTextFromBase64(fileName, base64),
    prepareMediaText: (sourceId, text) => prepareMediaTextForGeneration(database.getConnSafe(), sourceId, text),
    resolveRefBlocks: (ref, multimodal) => resolver.resolveVfsRefToBlocks(ref, multimodal),
  };
}

/**
 * Null while chat history or the L02 raw prompt is missing, or while the VFS database is published
 * without its resolver/repo/docs: `chatanki_run` stays unclaimed instead of degrading silently.
 * An absent VFS database is Rust's `vfs_db = None` (content-only runs still work).
 */
export function createChatAnkiRunInputSources(host: ChatAnkiRunInputHost): ChatAnkiRunInputSources | null {
  const { chatSession, rawPrompt } = host;
  if (chatSession === undefined || rawPrompt === undefined) return null;
  let vfs: ChatAnkiRunVfsSource | null = null;
  if (host.vfsDatabase !== undefined) {
    if (host.vfsRepo === undefined || host.vfsResolver === undefined || host.docs === undefined) return null;
    vfs = createRunVfsSource(host.vfsDatabase, host.vfsRepo, host.vfsResolver, host.docs);
  }
  return {
    latestUserContent: (sessionId) => extractLatestUserContent(chatSession, sessionId),
    resolveTargetRefs: (sessionId, preferredIds) => resolveTargetContextRefs(chatSession, sessionId, preferredIds),
    vfs,
    planner: createChatAnkiRoutePlanner(host.routing ?? null, rawPrompt, host.warn),
    vlm: createChatAnkiVlmExtractor(host.routing ?? null, rawPrompt, host.warn),
  };
}
