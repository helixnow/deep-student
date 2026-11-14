/**
 * pipeline/context_compiler/images.rs — image budgeting and request-local
 * image compilation helpers.
 *
 * Collects runtime images from history + current canonical refs, enforces the
 * image budget deterministically, reuses persisted derived artifacts, and
 * rewrites message payloads for multimodal / text-model request shapes.
 */
import type { CanonicalContentPart } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  imagePart, textPart, type LegacyChatMessage, type MultimodalContentPart,
} from './microcompact.ts';

export const DEFAULT_IMAGE_BUDGET = 8;
export const DEFAULT_HISTORY_IMAGE_BUDGET = 4;

export interface ImageBudgetCandidate {
  messageIndex: number;
  imageIndex: number;
  turnIndex: number;
  isCurrentTurn: boolean;
  pinned: boolean;
  retrievalHit: boolean;
}

/** Stable key for the `(message_index, image_index)` slots Rust keeps in a HashSet. */
export function imageSlotKey(messageIndex: number, imageIndex: number): string {
  return `${messageIndex}:${imageIndex}`;
}

function compareCandidates(a: ImageBudgetCandidate, b: ImageBudgetCandidate): number {
  if (a.isCurrentTurn !== b.isCurrentTurn) return a.isCurrentTurn ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.turnIndex !== b.turnIndex) return b.turnIndex - a.turnIndex;
  if (a.retrievalHit !== b.retrievalHit) return a.retrievalHit ? -1 : 1;
  if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
  return a.imageIndex - b.imageIndex;
}

/**
 * Select images deterministically. Current-turn and pinned images win, followed
 * by recent turns and retrieval hits. History has an independent ceiling so a
 * long conversation cannot crowd out the current turn.
 */
export function selectImagesWithBudget(candidates: readonly ImageBudgetCandidate[],
  totalBudget: number, historyBudget: number): Set<string> {
  const ranked = [...candidates].sort(compareCandidates);
  const selected = new Set<string>();
  let historyCount = 0;
  for (const candidate of ranked) {
    if (selected.size >= totalBudget) break;
    if (!candidate.isCurrentTurn) {
      if (historyCount >= historyBudget) continue;
      historyCount += 1;
    }
    selected.add(imageSlotKey(candidate.messageIndex, candidate.imageIndex));
  }
  return selected;
}

export interface RuntimeImage {
  messageIndex: number;
  imageIndex: number;
  turnIndex: number;
  isCurrentTurn: boolean;
  imageId: string;
  mimeType: string;
  base64: string;
  pinned: boolean;
  retrievalHit: boolean;
}

/** images.rs::ResolvedCanonicalImage — canonical Blob bytes replacing a preview. */
export interface ResolvedCanonicalImage {
  mimeType: string;
  base64: string;
}

/** images.rs::CanonicalVfsImage — a page image reference discovered in VFS metadata. */
export interface CanonicalVfsImage {
  imageId: string;
  name: string | null;
  sourceId: string;
  blobHash: string | null;
  contentHash: string;
  mimeType: string;
}

/**
 * Magic-byte sniffing. `null` means "not a known image format" and the caller
 * must drop the bytes instead of sending them as an image.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const startsWith = (prefix: readonly number[]): boolean =>
    bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'; // GIF87a
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'; // GIF89a
  if (bytes.length >= 12 && startsWith([0x52, 0x49, 0x46, 0x46])
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  if (startsWith([0x42, 0x4d])) return 'image/bmp';
  return null;
}

export interface ReusedArtifactCoverage {
  coveredImages: Set<string>;
  usedVisualObservation: boolean;
  usedOcr: boolean;
}

/**
 * Metadata `canonicalContent` decode. A malformed value is ignored wholesale,
 * mirroring `serde_json::from_value(...).ok()`.
 */
export function parseCanonicalContent(value: unknown): CanonicalContentPart[] | null {
  if (!Array.isArray(value)) return null;
  const parts: CanonicalContentPart[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const fields = entry as Record<string, unknown>;
    // types.rs:1333–1384. Option<String> accepts absent/null; wrong typed optional fields
    // invalidate the whole Vec, just like serde_json::from_value(...).ok().
    const optional = (keys: string[]): Record<string, string> | null => {
      const result: Record<string, string> = {};
      for (const key of keys) {
        const field = fields[key];
        if (field == null) continue;
        if (typeof field !== 'string') return null;
        result[key] = field;
      }
      return result;
    };
    switch (fields.type) {
      case 'text':
        if (typeof fields.text !== 'string') return null;
        parts.push({ type: 'text', text: fields.text }); break;
      case 'image_ref': {
        if (typeof fields.image_id !== 'string' || typeof fields.mime_type !== 'string') return null;
        if (fields.pinned !== undefined && typeof fields.pinned !== 'boolean') return null;
        if (fields.retrieval_hit !== undefined && typeof fields.retrieval_hit !== 'boolean') return null;
        const fieldsOptional = optional(['name', 'resource_id', 'source_id', 'blob_hash', 'content_hash']);
        if (fieldsOptional === null) return null;
        parts.push({ type: 'image_ref', image_id: fields.image_id, mime_type: fields.mime_type,
          pinned: typeof fields.pinned === 'boolean' ? fields.pinned : false,
          retrieval_hit: typeof fields.retrieval_hit === 'boolean' ? fields.retrieval_hit : false, ...fieldsOptional }); break;
      }
      case 'file_ref': {
        if (typeof fields.file_id !== 'string' || typeof fields.mime_type !== 'string') return null;
        const fieldsOptional = optional(['name', 'resource_id', 'blob_hash', 'content_hash', 'deepseek_file_id', 'deepseek_config_id']);
        if (fieldsOptional === null) return null;
        parts.push({ type: 'file_ref', file_id: fields.file_id, mime_type: fields.mime_type, ...fieldsOptional }); break;
      }
      case 'citation_ref': {
        if (typeof fields.citation_id !== 'string') return null;
        const fieldsOptional = optional(['resource_id', 'label']);
        if (fieldsOptional === null) return null;
        parts.push({ type: 'citation_ref', citation_id: fields.citation_id, ...fieldsOptional }); break;
      }
      case 'derived_artifact_ref': {
        if (typeof fields.artifact_id !== 'string' || typeof fields.artifact_type !== 'string'
          || typeof fields.content !== 'string' || !Array.isArray(fields.source_image_ids)
          || !fields.source_image_ids.every((id): id is string => typeof id === 'string')
          || typeof fields.created_at !== 'number' || !Number.isSafeInteger(fields.created_at)) return null;
        const fieldsOptional = optional(['producer_model_id']);
        if (fieldsOptional === null) return null;
        parts.push({ type: 'derived_artifact_ref', artifact_id: fields.artifact_id, artifact_type: fields.artifact_type,
          content: fields.content, source_image_ids: [...fields.source_image_ids], created_at: fields.created_at, ...fieldsOptional }); break;
      }
      default: return null;
    }
  }
  return parts;
}

export function canonicalContentFromMessageMetadata(
  message: LegacyChatMessage): CanonicalContentPart[] | null {
  const metadata = message.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return parseCanonicalContent((metadata as Record<string, unknown>).canonicalContent);
}

/** Page previews embedded in resource metadata, deduped by blob hash. */
export function appendPreviewImages(images: CanonicalVfsImage[], seen: Set<string>,
  containerResourceId: string, sourceId: string, sourceName: string,
  fallbackContentHash: string, previewJson: string | null | undefined): void {
  if (previewJson === undefined || previewJson === null || rustTrim(previewJson) === '') return;
  let preview: unknown;
  try {
    preview = JSON.parse(previewJson);
  } catch {
    return;
  }
  if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) return;
  const pages = (preview as Record<string, unknown>).pages;
  if (!Array.isArray(pages)) return;

  pages.forEach((page, fallbackPageIndex) => {
    if (page === null || typeof page !== 'object' || Array.isArray(page)) return;
    const record = page as Record<string, unknown>;
    const rawBlobHash = record.blobHash ?? record.blob_hash;
    if (typeof rawBlobHash !== 'string' || rawBlobHash === '') return;
    if (seen.has(rawBlobHash)) return;
    seen.add(rawBlobHash);

    const rawPageIndex = record.pageIndex ?? record.page_index;
    const pageIndex = typeof rawPageIndex === 'number' && Number.isInteger(rawPageIndex)
      && rawPageIndex >= 0 ? rawPageIndex : fallbackPageIndex;
    const rawMime = record.mimeType ?? record.mime_type;
    const mimeType = typeof rawMime === 'string' ? rawMime : 'image/png';
    images.push({
      imageId: `${containerResourceId}:${sourceId}:page:${pageIndex}`,
      sourceId,
      name: `${sourceName} (page ${pageIndex + 1})`,
      blobHash: rawBlobHash,
      contentHash: rawBlobHash === '' ? fallbackContentHash : rawBlobHash,
      mimeType,
    });
  });
}

interface ImageDescriptor {
  imageId: string;
  mimeType: string;
  pinned: boolean;
  retrievalHit: boolean;
}

function imageRefs(canonical: readonly CanonicalContentPart[]): ImageDescriptor[] {
  const refs: ImageDescriptor[] = [];
  for (const part of canonical) {
    if (part.type === 'image_ref') {
      refs.push({
        imageId: part.image_id,
        mimeType: part.mime_type,
        pinned: part.pinned,
        retrievalHit: part.retrieval_hit,
      });
    }
  }
  return refs;
}

function historicalCanonical(message: LegacyChatMessage): CanonicalContentPart[] {
  return canonicalContentFromMessageMetadata(message) ?? [];
}

export function collectRuntimeImages(messages: readonly LegacyChatMessage[],
  currentIndex: number, currentCanonical: readonly CanonicalContentPart[]): RuntimeImage[] {
  const currentRefs = imageRefs(currentCanonical);
  const result: RuntimeImage[] = [];

  messages.forEach((message, messageIndex) => {
    const refs = messageIndex === currentIndex ? currentRefs : imageRefs(historicalCanonical(message));
    let imageIndex = 0;
    const fallback = (mediaType: string): ImageDescriptor => ({
      imageId: messageIndex === currentIndex
        ? `current:image:${imageIndex}`
        : `history:${messageIndex}:image:${imageIndex}`,
      mimeType: mediaType,
      pinned: false,
      retrievalHit: false,
    });

    if (message.multimodal_content !== undefined && message.multimodal_content !== null) {
      for (const part of message.multimodal_content) {
        if (part.type !== 'image_url') continue;
        const descriptor = refs[imageIndex] ?? fallback(part.mediaType);
        result.push({
          messageIndex,
          imageIndex,
          turnIndex: messageIndex,
          isCurrentTurn: messageIndex === currentIndex,
          imageId: descriptor.imageId,
          mimeType: descriptor.mimeType,
          base64: part.base64,
          pinned: descriptor.pinned,
          retrievalHit: descriptor.retrievalHit,
        });
        imageIndex += 1;
      }
    } else if (message.image_base64 !== undefined && message.image_base64 !== null) {
      for (const base64 of message.image_base64) {
        const descriptor = refs[imageIndex] ?? fallback('image/jpeg');
        result.push({
          messageIndex,
          imageIndex,
          turnIndex: messageIndex,
          isCurrentTurn: messageIndex === currentIndex,
          imageId: descriptor.imageId,
          mimeType: descriptor.mimeType,
          base64,
          pinned: descriptor.pinned,
          retrievalHit: descriptor.retrievalHit,
        });
        imageIndex += 1;
      }
    }
  });
  return result;
}

/**
 * Appends persisted derived observations for images not already covered in this
 * request. `imageId` is stable per Blob and may repeat across turns, so the
 * lookup is scoped to the owning message.
 */
export function applyExistingDerivedArtifacts(messages: LegacyChatMessage[],
  images: readonly RuntimeImage[]): ReusedArtifactCoverage {
  const result: ReusedArtifactCoverage = {
    coveredImages: new Set(), usedVisualObservation: false, usedOcr: false,
  };
  const imageIndexesByMessageAndId = new Map<string, number>();
  for (const image of images) {
    imageIndexesByMessageAndId.set(`${image.messageIndex}\u0000${image.imageId}`, image.imageIndex);
  }

  messages.forEach((message, messageIndex) => {
    const canonical = historicalCanonical(message);
    const observations: string[] = [];
    const appendedArtifactIds = new Set<string>();
    for (let index = canonical.length - 1; index >= 0; index--) {
      const part = canonical[index]!;
      if (part.type !== 'derived_artifact_ref') continue;
      if (rustTrim(part.content) === '' || appendedArtifactIds.has(part.artifact_id)) continue;

      const newlyCovered: string[] = [];
      for (const imageId of part.source_image_ids) {
        const imageIndex = imageIndexesByMessageAndId.get(`${messageIndex}\u0000${imageId}`);
        if (imageIndex === undefined) continue;
        const key = imageSlotKey(messageIndex, imageIndex);
        if (result.coveredImages.has(key)) continue;
        newlyCovered.push(key);
      }
      if (newlyCovered.length === 0) continue;

      for (const key of newlyCovered) result.coveredImages.add(key);
      if (part.artifact_type === 'ocr_text') {
        result.usedOcr = true;
      } else {
        result.usedVisualObservation = true;
      }
      observations.push(part.content);
    }
    for (let index = observations.length - 1; index >= 0; index--) {
      appendObservation(message, observations[index]!);
    }
  });
  return result;
}

/** Replaces preview payloads with canonical Blob bytes at matching image slots. */
export function overrideMessageImagesWithCanonical(message: LegacyChatMessage,
  canonical: readonly (ResolvedCanonicalImage | null)[]): number {
  if (canonical.length === 0) return 0;
  let replaced = 0;

  if (message.multimodal_content !== undefined && message.multimodal_content !== null) {
    let imageIndex = 0;
    for (const part of message.multimodal_content) {
      if (part.type !== 'image_url') continue;
      const payload = canonical[imageIndex];
      if (payload !== null && payload !== undefined) {
        part.mediaType = payload.mimeType;
        part.base64 = payload.base64;
        replaced += 1;
      }
      imageIndex += 1;
    }
  } else if (message.image_base64 !== undefined && message.image_base64 !== null) {
    const legacyImages = message.image_base64;
    const parts: MultimodalContentPart[] = [textPart(message.content)];
    legacyImages.forEach((legacyBase64, imageIndex) => {
      const payload = canonical[imageIndex];
      if (payload !== null && payload !== undefined) {
        parts.push(imagePart(payload.mimeType, payload.base64));
        replaced += 1;
      } else {
        parts.push(imagePart('image/jpeg', legacyBase64));
      }
    });
    message.multimodal_content = parts;
    message.image_base64 = null;
  } else {
    const resolved = canonical.filter((payload): payload is ResolvedCanonicalImage =>
      payload !== null && payload !== undefined);
    if (resolved.length > 0) {
      const parts: MultimodalContentPart[] = [textPart(message.content)];
      for (const payload of resolved) {
        parts.push(imagePart(payload.mimeType, payload.base64));
        replaced += 1;
      }
      message.multimodal_content = parts;
    }
  }

  return replaced;
}

/** Keeps only budget-selected images; dropped images leave a placeholder text note. */
export function retainSelectedImagesForMultimodal(messages: LegacyChatMessage[],
  selected: ReadonlySet<string>): void {
  messages.forEach((message, messageIndex) => {
    if (message.multimodal_content !== undefined && message.multimodal_content !== null) {
      const kept: MultimodalContentPart[] = [];
      let imageIndex = 0;
      let dropped = 0;
      for (const part of message.multimodal_content) {
        if (part.type === 'image_url') {
          if (selected.has(imageSlotKey(messageIndex, imageIndex))) kept.push(part);
          else dropped += 1;
          imageIndex += 1;
        } else {
          kept.push(part);
        }
      }
      if (dropped > 0) {
        kept.push(textPart(`[${dropped} 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]`));
      }
      message.multimodal_content = kept;
      message.image_base64 = null;
    } else if (message.image_base64 !== undefined && message.image_base64 !== null) {
      const parts: MultimodalContentPart[] = [textPart(message.content)];
      let dropped = 0;
      message.image_base64.forEach((image, imageIndex) => {
        if (selected.has(imageSlotKey(messageIndex, imageIndex))) {
          parts.push(imagePart('image/jpeg', image));
        } else {
          dropped += 1;
        }
      });
      if (dropped > 0) {
        parts.push(textPart(`[${dropped} 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]`));
      }
      message.multimodal_content = parts;
      message.image_base64 = null;
    }
  });
}

/** Text-model shape: every image byte is removed; text parts are preserved. */
export function stripAllImages(messages: LegacyChatMessage[], selected: ReadonlySet<string>,
  addBudgetPlaceholder: boolean): void {
  messages.forEach((message, messageIndex) => {
    const imageCount = message.multimodal_content !== undefined && message.multimodal_content !== null
      ? message.multimodal_content.filter(part => part.type === 'image_url').length
      : message.image_base64?.length ?? 0;
    let dropped = 0;
    for (let imageIndex = 0; imageIndex < imageCount; imageIndex++) {
      if (!selected.has(imageSlotKey(messageIndex, imageIndex))) dropped += 1;
    }
    message.image_base64 = null;
    if (message.multimodal_content !== undefined && message.multimodal_content !== null) {
      const text = message.multimodal_content
        .filter((part): part is Extract<MultimodalContentPart, { type: 'text' }> =>
          part.type === 'text')
        .map(part => part.text)
        .join('\n');
      if (rustTrim(message.content) === '') message.content = text;
      message.multimodal_content = null;
    }
    if (addBudgetPlaceholder && dropped > 0) {
      message.content += `\n[${dropped} 张较早图片因上下文图片预算未处理；原始引用仍保留。]`;
    }
  });
}

export function appendObservation(message: LegacyChatMessage, observation: string): void {
  message.content += `\n\n<derived_visual_observation>\n${observation}\n</derived_visual_observation>`;
}
