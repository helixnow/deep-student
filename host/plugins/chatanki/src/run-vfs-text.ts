// Rust chatanki_executor.rs: looks_like_material_text :9053, effective_max_images :526,
// strip_vlm_chunk_markers :9791, MAX_REF_TEXT_BYTES / push_with_budget :9882–9909,
// text_truncated_warning :9913, merge_optional_texts :9927, collect_image_payloads :9976,
// extract_text_from_refs :10029.
import type { VfsContextRefData, VfsResourceRef } from '../api.ts';
import { charCount, rustTrim, rustTrimStart } from '../../../platform/util/text.ts';
import { truncateUtf8, utf8ByteLength } from '../../../platform/util/utf8.ts';

export const MAX_REF_TEXT_BYTES = 10_000_000;
export const MAX_VLM_IMAGES = 12;

/** `resolve_vfs_ref_to_blocks` output (agent-workspace `ContentBlock`). */
export type ChatAnkiRefBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string };

/** The reads `extract_text_from_refs` / `collect_image_payloads` make on the VFS connection. */
export interface ChatAnkiRefContentSource {
  /** `SELECT extracted_text FROM files WHERE id = ?1`; a failed read is `null` (Rust `.ok().flatten()`). */
  fileExtractedText(sourceId: string): string | null;
  /** `VfsFileRepo::get_content_with_conn`: base64 file content, `null` for `Ok(None)` or `Err`. */
  fileContentBase64(sourceId: string): string | null;
  /** `DocumentParser::extract_text_from_base64`. */
  extractTextFromBase64(fileName: string, base64: string): Promise<string>;
  /** `study_loop::media_source::prepare_media_text_for_generation`. */
  prepareMediaText(sourceId: string, text: string): string;
  /** `vfs_resolver::resolve_vfs_ref_to_blocks(conn, blobs_dir, ref, is_multimodal)`. */
  resolveRefBlocks(ref: VfsResourceRef, multimodal: boolean): Promise<ChatAnkiRefBlock[]>;
}

export interface ExtractTextResult {
  text: string;
  truncated: boolean;
  includedFiles: string[];
  droppedFiles: string[];
}

export interface ImagePayload { mime: string; base64: string }

export interface ImagePayloadBatch {
  payloads: ImagePayload[];
  totalImages: number;
  truncated: boolean;
}

/** Short commands ("继续/开始/好了吗") are not study material. */
export function looksLikeMaterialText(text: string): boolean {
  const trimmed = rustTrim(text);
  if (trimmed.length === 0) return false;
  const length = charCount(trimmed);
  if (length >= 120) return true;
  return trimmed.includes('\n') && length >= 60;
}

/** `ChatAnkiGenerationTuning::effective_max_images`: user override clamped to 1..=MAX_VLM_IMAGES. */
export function effectiveMaxImages(maxImages: number | null, routeDefault: number): number {
  if (maxImages === null) return routeDefault;
  return Math.min(Math.max(maxImages, 1), MAX_VLM_IMAGES);
}

/** `str::lines`: `\n` / `\r\n` terminators; a bare `\r` on the unterminated last line stays. */
function rustLines(text: string): string[] {
  const parts = text.split('\n');
  const last = parts.pop()!;
  const lines = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (last.length > 0) lines.push(last);
  return lines;
}

/**
 * `[CHUNK_ID]` / `[SUMMARY]` lines are dropped, `[CHUNK_END]` becomes a paragraph break,
 * runs of 3+ newlines collapse; output without any marker is returned unchanged.
 */
export function stripVlmChunkMarkers(markdown: string): string {
  const lines = rustLines(markdown);
  const isMarker = (line: string): boolean => {
    const trimmed = rustTrimStart(line);
    return trimmed.startsWith('[CHUNK_ID]') || trimmed.startsWith('[SUMMARY]') || trimmed.startsWith('[CHUNK_END]');
  };
  if (!lines.some(isMarker)) return markdown;

  const out: string[] = [];
  for (const line of lines) {
    const trimmed = rustTrimStart(line);
    if (trimmed.startsWith('[CHUNK_ID]') || trimmed.startsWith('[SUMMARY]')) continue;
    if (trimmed.startsWith('[CHUNK_END]')) {
      const last = out.at(-1);
      if (last !== undefined && rustTrim(last).length > 0) out.push('');
      continue;
    }
    out.push(line);
  }
  let result = '';
  let newlineRun = 0;
  for (const char of out.join('\n')) {
    if (char === '\n') {
      newlineRun += 1;
      if (newlineRun > 2) continue;
    } else {
      newlineRun = 0;
    }
    result += char;
  }
  return rustTrim(result);
}

interface TextBudget { out: string; remaining: number }

/** `push_with_budget`: appends whole when it fits, else the longest char-boundary prefix and exhausts the budget. */
function pushWithBudget(budget: TextBudget, text: string): boolean {
  if (budget.remaining === 0) return false;
  const bytes = utf8ByteLength(text);
  if (bytes <= budget.remaining) {
    budget.out += text;
    budget.remaining -= bytes;
    return true;
  }
  budget.out += truncateUtf8(text, budget.remaining);
  budget.remaining = 0;
  return false;
}

export function textTruncatedWarning(result: ExtractTextResult): Record<string, unknown> {
  return {
    code: 'text_truncated',
    messageKey: 'blocks.ankiCards.warnings.textTruncated',
    messageParams: {
      limitMB: Math.floor(MAX_REF_TEXT_BYTES / 1_000_000),
      droppedCount: result.droppedFiles.length,
      droppedFiles: [...result.droppedFiles],
    },
    includedFiles: [...result.includedFiles],
    droppedFiles: [...result.droppedFiles],
  };
}

export function mergeOptionalTexts(base: string, extra: string | null): string {
  const baseTrimmed = rustTrim(base);
  const extraTrimmed = rustTrim(extra ?? '');
  if (baseTrimmed.length === 0) return extraTrimmed;
  if (extraTrimmed.length === 0) return baseTrimmed;
  return `${baseTrimmed}\n\n${extraTrimmed}`;
}

export async function collectImagePayloads(
  source: ChatAnkiRefContentSource, refs: readonly VfsResourceRef[], maxImages: number,
): Promise<ImagePayloadBatch> {
  const payloads: ImagePayload[] = [];
  let totalImages = 0;
  let truncated = false;
  for (const ref of refs) {
    for (const block of await source.resolveRefBlocks(ref, true)) {
      if (block.type !== 'image') continue;
      totalImages += 1;
      if (payloads.length < maxImages) payloads.push({ mime: block.mediaType, base64: block.base64 });
      else truncated = true;
    }
  }
  if (totalImages > maxImages) truncated = true;
  return { payloads, totalImages, truncated };
}

async function fileRefText(source: ChatAnkiRefContentSource, ref: VfsResourceRef): Promise<string> {
  const extracted = source.fileExtractedText(ref.sourceId);
  let text: string;
  if (extracted !== null && rustTrim(extracted).length > 0) {
    text = extracted;
  } else {
    const base64 = source.fileContentBase64(ref.sourceId);
    if (base64 === null) {
      text = '';
    } else {
      try { text = await source.extractTextFromBase64(ref.name, base64); }
      catch { text = ''; }
    }
  }
  return source.prepareMediaText(ref.sourceId, text);
}

/**
 * Files prefer `files.extracted_text`, else the parsed blob (media transcripts get anchors); other refs use
 * the resolver's text blocks. 10 MB UTF-8 budget; every ref the budget cut off is listed as dropped.
 */
export async function extractTextFromRefs(
  source: ChatAnkiRefContentSource, refData: VfsContextRefData, warn: (message: string) => void,
): Promise<ExtractTextResult> {
  const budget: TextBudget = { out: '', remaining: MAX_REF_TEXT_BYTES };
  let truncated = false;
  const includedFiles: string[] = [];
  const droppedFiles: string[] = [];
  let index = 0;
  for (; index < refData.refs.length; index += 1) {
    const ref = refData.refs[index]!;
    if (budget.remaining === 0) {
      truncated = true;
      droppedFiles.push(ref.name);
      break;
    }
    if (ref.type === 'file') {
      const text = await fileRefText(source, ref);
      if (rustTrim(text).length > 0) {
        if (!pushWithBudget(budget, `\n\n# ${ref.name}\n\n`)) {
          truncated = true;
          droppedFiles.push(ref.name);
          break;
        }
        if (!pushWithBudget(budget, text)) {
          truncated = true;
          includedFiles.push(ref.name);
          droppedFiles.push(ref.name);
          break;
        }
        includedFiles.push(ref.name);
      }
      continue;
    }
    let pushedAny = false;
    for (const block of await source.resolveRefBlocks(ref, false)) {
      if (block.type !== 'text' || rustTrim(block.text).length === 0) continue;
      if (!pushWithBudget(budget, '\n\n')) {
        truncated = true;
        break;
      }
      if (!pushWithBudget(budget, block.text)) {
        truncated = true;
        pushedAny = true;
        break;
      }
      pushedAny = true;
    }
    if (pushedAny) includedFiles.push(ref.name);
    if (truncated) {
      droppedFiles.push(ref.name);
      break;
    }
  }
  if (truncated) {
    for (const ref of refData.refs.slice(index + 1)) droppedFiles.push(ref.name);
    warn(`[ChatAnki] Truncated context refs text at ${MAX_REF_TEXT_BYTES} bytes; dropped file(s): ${droppedFiles.join(', ')}`);
  }
  return { text: rustTrim(budget.out), truncated, includedFiles, droppedFiles };
}
