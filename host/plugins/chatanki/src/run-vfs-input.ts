// Rust chatanki_executor.rs:7511–8046: the `PipelineInput::VfsRef` branch of run_chatanki_pipeline_background
// (latest-message fallback, session/VFS ref resolution, resource data merge, route planning, text/VLM import).
import type {
  ChatAnkiRoutePlanner, ChatAnkiVlmExtractor, ContextRef, VfsContextRefData, VfsResourceRef,
} from '../api.ts';
import { planChatAnkiRoute, sampleRefTextForRouting } from './chatanki-executor.ts';
import { buildSingleRefDataFromContextRef, decodeVfsContextRefData } from './context-refs.ts';
import { appendVlmFullOcclusionDraft } from './occlusion-draft.ts';
import { buildImportPrompt, buildVlmLightPrompt } from './prompts.ts';
import { resolveRouteDecision, routePlanToDebugJson, type ChatAnkiRoute, type RoutePlan } from './routing.ts';
import {
  collectImagePayloads, effectiveMaxImages, extractTextFromRefs, looksLikeMaterialText, mergeOptionalTexts,
  stripVlmChunkMarkers, textTruncatedWarning, type ChatAnkiRefContentSource, type ImagePayloadBatch,
} from './run-vfs-text.ts';
import { rustTrim } from '../../../platform/util/text.ts';

/** The VFS reads of the VfsRef branch (`vfs_db` + its connection and blobs dir). */
export interface ChatAnkiRunVfsSource extends ChatAnkiRefContentSource {
  /** `resolve_context_ref_from_any_id`; unsupported or unmappable ids throw (Rust `Err`). */
  resolveContextRefFromAnyId(id: string): ContextRef | null;
  /** `VfsResourceRepo::get_by_hash_with_conn(hash)` else `get_resource_with_conn(id)`, each `.ok().flatten()`. */
  resourceData(hash: string, resourceId: string): string | null;
  /** File extracted text / snippet sample for `sample_ref_text_for_routing`. */
  refText(ref: VfsResourceRef, maxChars: number): string | null;
}

export interface ChatAnkiRunInputSources {
  /** `extract_latest_user_content`; read failures count as no material (Rust `_ => None`). */
  latestUserContent(sessionId: string): string | null;
  /** `resolve_target_context_refs`; `Err(message)` throws `Error(message)`. */
  resolveTargetRefs(sessionId: string, preferredIds: readonly string[] | null): ContextRef[];
  /** `params.vfs_db`; null when the VFS database is unavailable. */
  vfs: ChatAnkiRunVfsSource | null;
  planner: ChatAnkiRoutePlanner;
  vlm: ChatAnkiVlmExtractor;
}

export interface ChatAnkiVfsRefInputParams {
  sources: ChatAnkiRunInputSources;
  sessionId: string;
  ankiBlockId: string;
  goal: string;
  extraContent: string | null;
  preferredResourceIds: string[] | null;
  forcedRoute: ChatAnkiRoute | null;
  visualHint: string | null;
  maxImages: number | null;
  initialWarnings: Record<string, unknown>[];
  emitChunk: (blockId: string, update: Record<string, unknown>) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
}

export interface ChatAnkiPipelineContent {
  route: ChatAnkiRoute;
  content: string;
  debugRef: Record<string, unknown> | null;
  warnings: Record<string, unknown>[];
  contentErrorKey: string | null;
  llmGlossaryHint: boolean | null;
}

function importingChunk(params: ChatAnkiVfsRefInputParams, route: ChatAnkiRoute, messageKey: string): void {
  params.emitChunk(params.ankiBlockId, {
    progress: { stage: 'importing', route, messageKey: `blocks.ankiCards.progress.messages.${messageKey}` },
  });
}

function withInjectModes(data: VfsContextRefData, contextRef: ContextRef): VfsContextRefData {
  const modes = contextRef.injectModes;
  if (modes === undefined || modes === null) return data;
  return { ...data, refs: data.refs.map((ref) => ({ ...ref, injectModes: structuredClone(modes) })) };
}

function imageTruncatedWarning(batch: ImagePayloadBatch, limit: number): Record<string, unknown> {
  return {
    code: 'image_truncated',
    messageKey: 'blocks.ankiCards.warnings.imageTruncated',
    messageParams: { shown: batch.payloads.length, total: batch.totalImages, limit },
  };
}

function combineVisual(text: string, visualMd: string): string {
  if (rustTrim(text).length === 0) return visualMd;
  if (rustTrim(visualMd).length === 0) return text;
  return `${text}\n\n# 视觉补充\n\n${visualMd}`;
}

/** Resolves the run input into the text the generator receives (the `'vfs_block` labelled block). */
export async function resolveVfsRefInput(params: ChatAnkiVfsRefInputParams): Promise<ChatAnkiPipelineContent> {
  const { sources } = params;
  const warnings: Record<string, unknown>[] = structuredClone(params.initialWarnings);
  const extraContent = params.extraContent !== null && rustTrim(params.extraContent).length > 0 ? params.extraContent : null;

  let fallbackText: string | null = null;
  if (extraContent === null && (params.preferredResourceIds ?? []).length === 0 && params.forcedRoute === null) {
    let latest: string | null = null;
    try { latest = sources.latestUserContent(params.sessionId); }
    catch { latest = null; }
    if (latest !== null && looksLikeMaterialText(latest)) fallbackText = latest;
  }
  const hasFallback = fallbackText !== null;
  const mergedExtra = extraContent ?? fallbackText;
  const inputSource = hasFallback ? 'latest_user_message' : mergedExtra !== null ? 'tool_content' : null;
  const simpleText = (text: string, debugRef: Record<string, unknown> | null): ChatAnkiPipelineContent => {
    importingChunk(params, 'simple_text', 'simpleTextDetected');
    return { route: 'simple_text', content: text, debugRef, warnings, contentErrorKey: null, llmGlossaryHint: null };
  };
  const inputDebug = (): Record<string, unknown> | null => (inputSource === null ? null : { inputSource });

  const vfs = sources.vfs;
  if (vfs === null) {
    if (mergedExtra !== null) return simpleText(mergedExtra, inputDebug());
    throw new Error('VFS database not available (no file input + no content)');
  }

  let contextRefs: ContextRef[];
  try {
    contextRefs = sources.resolveTargetRefs(params.sessionId, params.preferredResourceIds);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (params.preferredResourceIds === null) throw new Error(message);
    const resolved: ContextRef[] = [];
    for (const preferred of params.preferredResourceIds) {
      const contextRef = vfs.resolveContextRefFromAnyId(preferred);
      if (contextRef === null) throw new Error(message);
      resolved.push(contextRef);
    }
    if (resolved.length === 0) throw new Error(message);
    contextRefs = resolved;
  }

  if (params.preferredResourceIds !== null) {
    const missing = params.preferredResourceIds.filter((id) => !contextRefs.some((ref) => ref.resourceId === id))
      .filter((id, index, list) => index === 0 || list[index - 1] !== id);
    const unresolved: string[] = [];
    for (const id of missing) {
      const contextRef = vfs.resolveContextRefFromAnyId(id);
      if (contextRef === null) unresolved.push(id);
      else contextRefs.push(contextRef);
    }
    if (unresolved.length > 0) {
      throw new Error(`Preferred resource not found in current session context or VFS: ${unresolved.join(',')}`);
    }
  }

  if (contextRefs.length > 1) {
    const seen = new Set<string>();
    contextRefs = contextRefs.filter((ref) => {
      if (seen.has(ref.resourceId)) return false;
      seen.add(ref.resourceId);
      return true;
    });
  }

  if (contextRefs.length === 0) {
    if (mergedExtra !== null) return simpleText(mergedExtra, inputDebug());
    return {
      route: 'simple_text', content: '', debugRef: inputDebug(), warnings,
      contentErrorKey: 'blocks.ankiCards.errors.noContent', llmGlossaryHint: null,
    };
  }

  const merged: VfsContextRefData = { refs: [], truncated: false, totalCount: 0 };
  const invalidRefs: string[] = [];
  const selectedRefsDebug: Record<string, unknown>[] = [];
  for (const contextRef of contextRefs) {
    selectedRefsDebug.push({ resourceId: contextRef.resourceId, hash: contextRef.hash, typeId: contextRef.typeId });
    const data = vfs.resourceData(contextRef.hash, contextRef.resourceId);
    const parsed = data !== null && rustTrim(data).length > 0 ? decodeVfsContextRefData(data) : null;
    if (parsed !== null) {
      const refData = withInjectModes(parsed, contextRef);
      merged.truncated = merged.truncated || refData.truncated;
      merged.totalCount += refData.totalCount > 0 ? refData.totalCount : refData.refs.length;
      merged.refs.push(...refData.refs);
      continue;
    }
    const single = buildSingleRefDataFromContextRef(contextRef);
    if (single === null) {
      invalidRefs.push(contextRef.resourceId);
      continue;
    }
    const refData = withInjectModes(single, contextRef);
    merged.totalCount += refData.refs.length;
    merged.refs.push(...refData.refs);
  }
  if (invalidRefs.length > 0) {
    warnings.push({
      code: 'context_ref_invalid',
      messageKey: 'blocks.ankiCards.warnings.contextRefInvalid',
      messageParams: { count: invalidRefs.length },
    });
  }

  let debugRef: Record<string, unknown> | null = {};
  if (inputSource !== null) debugRef.inputSource = inputSource;
  if (selectedRefsDebug.length > 0) debugRef.selectedContextRefs = selectedRefsDebug;
  if (Object.keys(debugRef).length === 0) debugRef = null;

  if (merged.refs.length === 0) {
    if (mergedExtra !== null) return simpleText(mergedExtra, debugRef);
    return {
      route: 'simple_text', content: '', debugRef, warnings,
      contentErrorKey: invalidRefs.length > 0 ? 'blocks.ankiCards.errors.contextRefInvalid' : 'blocks.ankiCards.errors.noContent',
      llmGlossaryHint: null,
    };
  }

  let routePlan: RoutePlan | null = null;
  if (params.forcedRoute === null) {
    const sample = sampleRefTextForRouting(mergedExtra ?? '', merged, (ref, maxChars) => vfs.refText(ref, maxChars));
    routePlan = await planChatAnkiRoute(sources.planner, params.goal, merged, sample, params.warn, params.info);
  }
  const decision = resolveRouteDecision(params.forcedRoute, routePlan, merged);
  const routeDebug: Record<string, unknown> = { routeSource: decision.source };
  if (routePlan !== null) routeDebug.routePlan = routePlanToDebugJson(routePlan);
  debugRef = debugRef === null ? routeDebug : { ...debugRef, ...routeDebug };

  let route = decision.route;
  const finish = (content: string): ChatAnkiPipelineContent => ({
    route, content, debugRef, warnings, contentErrorKey: null, llmGlossaryHint: decision.glossaryModeHint,
  });
  const extractText = async (): Promise<string> => {
    const result = await extractTextFromRefs(vfs, merged, params.warn);
    if (result.truncated) warnings.push(textTruncatedWarning(result));
    return mergeOptionalTexts(result.text, mergedExtra);
  };
  const images = async (routeDefault: number): Promise<ImagePayloadBatch> => {
    const limit = effectiveMaxImages(params.maxImages, routeDefault);
    const batch = await collectImagePayloads(vfs, merged.refs, limit);
    if (batch.truncated) warnings.push(imageTruncatedWarning(batch, limit));
    return batch;
  };

  if (route === 'simple_text') {
    const mergedText = await extractText();
    if (rustTrim(mergedText).length === 0) {
      const batch = await images(12);
      if (batch.payloads.length > 0) {
        route = 'vlm_full';
        importingChunk(params, route, 'vlmExtracting');
        const output = await sources.vlm.callVlmExtract(
          'chatanki.vlm_full_image_fallback', buildImportPrompt(params.goal, params.visualHint), batch.payloads,
        );
        const visualMd = appendVlmFullOcclusionDraft(stripVlmChunkMarkers(output), merged);
        return finish(mergeOptionalTexts(visualMd, mergedExtra));
      }
    }
    importingChunk(params, route, 'importing');
    return finish(mergedText);
  }

  const text = await extractText();
  const batch = await images(route === 'vlm_light' ? 6 : 12);
  if (batch.payloads.length === 0) {
    route = 'simple_text';
    importingChunk(params, route, 'importing');
    return finish(text);
  }
  importingChunk(params, route, 'vlmExtracting');
  if (route === 'vlm_light') {
    const visualMd = await sources.vlm.callVlmExtract(
      'chatanki.vlm_light_extract', buildVlmLightPrompt(params.goal, params.visualHint), batch.payloads,
    );
    return finish(combineVisual(text, visualMd));
  }
  const output = await sources.vlm.callVlmExtract(
    'chatanki.vlm_full_extract', buildImportPrompt(params.goal, params.visualHint), batch.payloads,
  );
  return finish(combineVisual(text, appendVlmFullOcclusionDraft(stripVlmChunkMarkers(output), merged)));
}
