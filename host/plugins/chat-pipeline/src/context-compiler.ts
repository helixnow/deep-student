/** context_compiler.rs:495–608/674–830; prompt.rs:448–520. */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error, type CanonicalContentPart, type GenerationRoute } from '../../chat/api.ts';
import type { ImagePayload } from '../../llm/api.ts';
import { runtimeAvailable } from '../../vfs-index/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { buildInjectedContextBlocks, buildUserQueryBlock, combineUserContent } from './context.ts';
import { imagePart, textPart, type LegacyChatMessage } from './microcompact.ts';
import type { PipelineContext } from './pipeline-context.ts';
import { applyExistingDerivedArtifacts, appendObservation, canonicalContentFromMessageMetadata,
  collectRuntimeImages, imageSlotKey, overrideMessageImagesWithCanonical, retainSelectedImagesForMultimodal,
  selectImagesWithBudget, stripAllImages, type ResolvedCanonicalImage, type ReusedArtifactCoverage,
  type RuntimeImage } from './images.ts';
import { AUXILIARY_MM_STAGE_TIMEOUT_MS, OCR_STAGE_TIMEOUT_MS, VISUAL_PREPROCESS_TURN_BUDGET_MS,
  contextImageCompileStrategy, finalizeVisualObservation, runPreprocessStage } from './preprocess.ts';

/** Owner boundaries only. All message construction, image selection, fallbacks and state writes are L03.
 * The auxiliary method is L02's raw-image prompt operation, not unified stream/singleShot substitution.
 */
export interface ContextCompilationPorts {
  prepareDeepseekDocuments?(ctx: PipelineContext): Promise<void>;
  resolveCanonicalImages(parts: readonly CanonicalContentPart[]): Promise<(ResolvedCanonicalImage | null)[]>;
  observeImages(configId: string, prompt: string, images: ImagePayload[], cancellation: AbortSignal): Promise<string>;
  /** Must settle on abort after releasing caller-owned temporary resources. */
  ocrImage(image: RuntimeImage, cancellation: AbortSignal): Promise<string>;
}
type Log = Pick<Context['logger'], 'info' | 'debug' | 'warn'>;
const errorText = (error: unknown) => error instanceof Error ? error.message
  : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);

function buildCurrentUserMessage(ctx: PipelineContext, log: Log): LegacyChatMessage {
  // Use this request's frozen runtime facts; never recompute the clock/platform between rounds.
  const combined = combineUserContent(ctx.userContent, ctx.runtimeFacts, ctx.userContextRefs, ctx.turnVolatileContext);
  log.debug(`[ChatV2::pipeline] Combined user content: context_refs=${ctx.userContextRefs.length}, context_images=${combined.images.length}, total_len=${utf8ByteLength(combined.text)}`);
  let multimodal: LegacyChatMessage['multimodal_content'] = null;
  const hasImages = ctx.userContextRefs.some(ref => ref.formattedBlocks.some(block => block.type === 'image'));
  if (hasImages) {
    const blocks = buildInjectedContextBlocks(ctx.runtimeFacts, ctx.userContextRefs, ctx.turnVolatileContext);
    const query = buildUserQueryBlock(ctx.userContent);
    multimodal = [
      ...(query === null ? [] : [textPart(query)]),
      ...(blocks.length === 0 ? [] : [textPart('<injected_context>'), ...blocks.map(block => block.type === 'text'
        ? textPart(block.text) : imagePart(block.mediaType, block.base64)), textPart('</injected_context>')]),
    ];
    log.debug(`[ChatV2::pipeline] get_content_blocks_ordered: total_blocks=${multimodal.length}`);
    log.info(`[ChatV2::pipeline] build_current_user_message: Using multimodal mode with ${multimodal.length} parts from context refs`);
  }
  return { role: 'user', content: combined.text, timestamp: new Date().toISOString(),
    thinking_content: null, thought_signature: null, rag_sources: null, memory_sources: null,
    graph_sources: null, web_search_sources: null, image_paths: null,
    image_base64: hasImages || combined.images.length === 0 ? null : combined.images,
    doc_attachments: null, multimodal_content: multimodal, tool_call: null, tool_result: null,
    overrides: null, relations: null, persistent_stable_id: null, metadata: null };
}

async function compileTextImages(ctx: PipelineContext, messages: LegacyChatMessage[], images: RuntimeImage[],
  selected: ReadonlySet<string>, reused: ReusedArtifactCoverage, ports: ContextCompilationPorts,
  log: Log): Promise<GenerationRoute> {
  const snapshot = structuredClone(ctx.executionSnapshot!);
  const auxiliaryId = snapshot.generationPlan.auxiliaryMultimodalConfigId;
  const ocrAvailable = runtimeAvailable(snapshot.capabilitySnapshot.ocr);
  let usedAuxiliary = reused.usedVisualObservation, usedOcr = reused.usedOcr;
  let unavailable = images.length > 0 && selected.size === 0;
  const signal = ctx.cancellationToken();
  const turnDeadline = performance.now() + VISUAL_PREPROCESS_TURN_BUDGET_MS;
  const byMessage = new Map<number, RuntimeImage[]>();
  for (const image of images) {
    if (!selected.has(imageSlotKey(image.messageIndex, image.imageIndex))) continue;
    const list = byMessage.get(image.messageIndex) ?? [];
    list.push(image); byMessage.set(image.messageIndex, list);
  }
  for (const index of [...byMessage.keys()].sort((a, b) => b - a)) {
    const selectedImages = byMessage.get(index)!;
    let observation: string | null = null, producerId: string | null = null;
    let artifactType = 'visual_observation';
    if (auxiliaryId != null) {
      const result = await runPreprocessStage(signal, turnDeadline, AUXILIARY_MM_STAGE_TIMEOUT_MS,
        stage => ports.observeImages(auxiliaryId,
          '请直接观察图片并给出忠实、紧凑的视觉描述，包含与对话相关的文字、结构、对象和关系。不要臆测。',
          selectedImages.map(image => ({ mime: image.mimeType, base64: image.base64 })), stage));
      if (result.ok === true) {
        if (rustTrim(result.value) !== '') {
          observation = result.value; producerId = auxiliaryId; usedAuxiliary = true;
        } else log.warn('[ChatV2::ContextCompiler] auxiliary MM returned an empty observation');
      } else if (result.error.kind === 'cancelled') throw new ChatV2Error('Cancelled');
      else if (result.error.kind === 'timedOut') log.warn('[ChatV2::ContextCompiler] auxiliary MM timed out, falling back to OCR');
      else log.warn(`[ChatV2::ContextCompiler] auxiliary MM failed, falling back to OCR: ${errorText(result.error.error)}`);
    }
    if (observation === null && ocrAvailable) {
      const texts: string[] = [];
      for (const image of selectedImages) {
        let pending: Promise<string> | undefined;
        const result = await runPreprocessStage(signal, turnDeadline, OCR_STAGE_TIMEOUT_MS,
          stage => (pending = ports.ocrImage(image, stage)));
        // Rust drops NamedTempFile before returning from the selected cancellation/timeout.
        // The bound OCR port races cancellation itself; joining it waits only for async file cleanup.
        if (result.ok === false && (result.error.kind === 'cancelled' || result.error.kind === 'timedOut')) {
          await pending?.then(() => undefined, () => undefined);
        }
        if (result.ok === true) {
          if (rustTrim(result.value) !== '') texts.push(result.value);
        } else if (result.error.kind === 'cancelled') throw new ChatV2Error('Cancelled');
        else if (result.error.kind === 'timedOut') log.warn(`[ChatV2::ContextCompiler] OCR fallback timed out for ${image.imageId}`);
        else log.warn(`[ChatV2::ContextCompiler] OCR fallback failed for ${image.imageId}: ${errorText(result.error.error)}`);
      }
      if (texts.length > 0) { observation = texts.join('\n\n'); artifactType = 'ocr_text'; usedOcr = true; }
    }
    const [text, reusable] = finalizeVisualObservation(observation);
    if (!reusable) unavailable = true;
    appendObservation(messages[index]!, text);
    if (reusable && index === messages.length - 1) {
      ctx.canonicalContent.push({ type: 'derived_artifact_ref', artifact_id: `artifact_${globalThis.crypto.randomUUID()}`,
        artifact_type: artifactType, source_image_ids: selectedImages.map(image => image.imageId),
        producer_model_id: producerId, content: text, created_at: Date.now() });
    }
  }
  stripAllImages(messages, new Set([...selected, ...reused.coveredImages]), true);
  return unavailable ? 'text_model_without_image' : usedOcr ? 'ocr_then_text_model'
    : usedAuxiliary ? 'multimodal_observation_then_text_model' : 'text_model_direct';
}

export async function compileFrozenContext(ctx: PipelineContext, ports: ContextCompilationPorts, log: Log): Promise<void> {
  const snapshot = structuredClone(ctx.executionSnapshot);
  if (snapshot === null) throw new ChatV2Error('Other', 'model execution snapshot was not frozen');
  await ports.prepareDeepseekDocuments?.(ctx);
  const messages = structuredClone(ctx.chatHistory);
  const current = buildCurrentUserMessage(ctx, log);
  if (ctx.canonicalContent.length > 0) current.metadata = { canonicalContent: structuredClone(ctx.canonicalContent) };
  messages.push(current);
  const currentIndex = messages.length - 1;
  for (const [index, message] of messages.entries()) {
    const canonical = index === currentIndex ? ctx.canonicalContent : canonicalContentFromMessageMetadata(message);
    if (canonical === null) continue;
    const payloads = await ports.resolveCanonicalImages(canonical);
    overrideMessageImagesWithCanonical(message, payloads);
  }
  const allImages = collectRuntimeImages(messages, currentIndex, ctx.canonicalContent);
  const reused = snapshot.resolvedModelIsMultimodal
    ? { coveredImages: new Set<string>(), usedOcr: false, usedVisualObservation: false }
    : applyExistingDerivedArtifacts(messages, allImages);
  const images = allImages.filter(image => !reused.coveredImages.has(imageSlotKey(image.messageIndex, image.imageIndex)));
  const selected = selectImagesWithBudget(images, snapshot.generationPlan.imageBudget, snapshot.generationPlan.historyImageBudget);
  let route: GenerationRoute;
  switch (contextImageCompileStrategy(snapshot.resolvedModelIsMultimodal, allImages.length > 0)) {
    case 'noImages':
      stripAllImages(messages, selected, false); route = snapshot.generationPlan.planner.route; break;
    case 'multimodalDirect':
      retainSelectedImagesForMultimodal(messages, selected); route = 'multimodal_model_direct'; break;
    case 'textModelPreprocess':
      route = await compileTextImages(ctx, messages, images, selected, reused, ports, log); break;
  }
  ctx.compiledCurrentUserMessage = messages.pop()!;
  ctx.chatHistory = messages;
  if (ctx.executionSnapshot !== null) ctx.executionSnapshot.executionRoute = route;
}
