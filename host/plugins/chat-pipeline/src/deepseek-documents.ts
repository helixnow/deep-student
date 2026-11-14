import type { Context } from '@deepseek-ai/cordis';
import { deepseekDocumentPurpose, isOfficialDeepseekFlashResponses, uploadDeepseekDocument } from '../../llm/api.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import { ChatV2Error, type ChatMessage } from '../../chat/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import { parseContextRefData } from './history-vfs-context.ts';

/** Resolve raw bytes through the VFS owner, never through paths supplied in a request. */
export async function prepareDeepseekDocuments(ctx: Context, turn: PipelineContext,
  loadUserMessage: () => ChatMessage | null): Promise<void> {
  if (ctx.settings.get('deepseek.chat.files') !== 'true' || turn.executionSnapshot === null
    || (turn.options.parallelModelIds?.length ?? 0) >= 2) return;
  const refs = turn.userContextRefs.filter(ref => ref.typeId === 'file'
    && !turn.options.groupPinnedResourceIds?.includes(ref.resourceId));
  if (!turn.options.skipUserMessageSave && !refs.length) return;
  const llm = ctx.get('llm');
  const config = (await llm?.getApiConfigs())?.find(value => value.id === turn.executionSnapshot?.resolvedModelId);
  if (!llm || !config || !isOfficialDeepseekFlashResponses(config)) return;
  if (turn.options.skipUserMessageSave) {
    const saved = loadUserMessage();
    if (saved?.sessionId !== turn.sessionId || saved.role !== 'user') return;
    for (const part of saved._meta?.canonicalContent ?? []) {
      if (part.type !== 'file_ref' || !part.deepseek_file_id || part.deepseek_config_id !== config.id) continue;
      if (!turn.canonicalContent.some(current => current.type === 'file_ref' && current.deepseek_file_id === part.deepseek_file_id)) {
        turn.canonicalContent.push(part);
      }
    }
    return;
  }
  const http = ctx.get('llmHttp');
  const vfs = ctx.get('vfs')?.database;
  const repos = ctx.get('vfsRepo');
  if (!http || !vfs || !repos) throw new ChatV2Error('Llm', 'DeepSeek Files requires access to the attached file');
  const { attachments, resources } = repos;
  const key = await llm.decryptApiKey(config.apiKey);
  if (!key || /^\*+$/.test(key)) throw new ChatV2Error('Llm', 'The DeepSeek provider has no API key');
  const signal = turn.cancellationToken();
  const conn = vfs.getConnSafe();
  const ids = new Map<string, string>();
  for (const ref of refs) {
    const resource = resources.getResource(conn, ref.resourceId);
    const data = resource?.data && parseContextRefData(resource.data);
    if (!data) continue;
    for (const file of data.refs) {
      if (file.type === 'file' && Object.hasOwn(turn.contextSnapshot.pathMap, `__staged_attachment__:${ref.resourceId}:${file.sourceId}`)) {
        ids.set(file.sourceId, ref.resourceId);
      }
    }
  }
  const files = [...ids].flatMap(([id, resourceId]) => {
    const file = attachments.getById(conn, id);
    const purpose = file && deepseekDocumentPurpose(file.name);
    return file && purpose ? [{ file, purpose, resourceId }] : [];
  });
  if (files.length > 20) throw new ChatV2Error('Validation', 'DeepSeek supports at most 20 files per request');
  for (const { file, purpose, resourceId } of files) {
    if (signal?.aborted) throw new ChatV2Error('Cancelled');
    if (turn.canonicalContent.some(part => part.type === 'file_ref' && part.file_id === file.id
      && part.deepseek_file_id && part.deepseek_config_id === config.id)) continue;
    const maxBytes = (purpose === 'user_data' ? 32 : 100) * 1024 * 1024;
    const content = attachments.getContentBounded(conn, vfs.blobsDir(), file.id, maxBytes);
    if (!content) throw new ChatV2Error('Llm', `Could not read the attachment ${file.name}`);
    try {
      const bytes = fromBase64(content.replace(/^data:[^,]+,/, ''));
      const id = await uploadDeepseekDocument(http.fetch, key, file.name, bytes, purpose, signal);
      turn.canonicalContent.push({ type: 'file_ref', file_id: file.id, resource_id: resourceId,
        mime_type: file.mimeType, name: file.name, deepseek_file_id: id, deepseek_config_id: config.id });
    } catch (error) {
      if (signal?.aborted) throw new ChatV2Error('Cancelled');
      throw error;
    }
  }
}
