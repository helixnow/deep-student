import { humanizeCitationMarkers } from '@/components/anki/utils/cardCitations';
import { soundNames } from '@/components/anki/utils/cardMedia';
import { parseOcclusionSpec } from '@/components/anki/utils/imageOcclusion';
import { hasValidCloze, renderClozeText } from '../cloze';
import { withoutCardMediaSourceRefs } from '../library/cardMediaSource';
import type { ReviewCard } from '../store/fsrsReviewStore';

const AUDIO_FILE_EXT = /\.(?:mp3|wav|ogg|m4a|aac|flac|opus|webm)(?:$|[?#])/i;

function stripToSpeakableText(value: string | null | undefined): string {
  if (!value) return '';
  const cleaned = value
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');
  return humanizeCitationMarkers(cleaned).trim();
}

function extraFieldLookup(
  extraFields: Record<string, string> | undefined,
  candidates: readonly string[],
): string {
  if (!extraFields) return '';
  const lowered = new Map(
    Object.entries(extraFields).map(([k, v]) => [k.trim().toLowerCase(), v] as const),
  );
  for (const key of candidates) {
    const val = lowered.get(key.toLowerCase());
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

/** 提取当前卡面（正面/背面）适合 TTS 朗读的纯文本。 */
export function getReviewCardSpeechText(
  card: ReviewCard | null | undefined,
  flipped: boolean,
): string {
  if (!card) return '';
  const sanitized = withoutCardMediaSourceRefs(card);
  const clozeRaw = hasValidCloze(sanitized.text)
    ? sanitized.text!
    : hasValidCloze(extraFieldLookup(sanitized.extraFields, ['Text']))
      ? extraFieldLookup(sanitized.extraFields, ['Text'])
      : '';

  if (clozeRaw) {
    const rendered = stripToSpeakableText(renderClozeText(clozeRaw, flipped));
    if (!flipped) return rendered;
    const extra = stripToSpeakableText(
      extraFieldLookup(sanitized.extraFields, ['Extra']) || sanitized.back,
    );
    return extra && extra !== rendered ? `${rendered}。${extra}` : rendered;
  }

  if (!flipped) {
    const front = stripToSpeakableText(
      sanitized.front || extraFieldLookup(sanitized.extraFields, ['Front', 'Question', 'Word', 'Term']),
    );
    if (front) return front;
    const spec = parseOcclusionSpec(sanitized.extraFields);
    if (spec && spec.boxes.length > 0) {
      return spec.boxes.map((b) => b.label).filter(Boolean).join('，');
    }
    return '';
  }

  const back = stripToSpeakableText(
    sanitized.back
      || extraFieldLookup(sanitized.extraFields, ['Back', 'Answer', 'Explanation', 'Definition', 'Extra']),
  );
  if (back) return back;
  const spec = parseOcclusionSpec(sanitized.extraFields);
  if (spec && spec.boxes.length > 0) {
    return spec.boxes.map((b) => b.label).filter(Boolean).join('，');
  }
  return '';
}

/** 检测卡片是否包含 APKG 音频（[sound:...] 标记或音频媒体附件）。 */
export function hasReviewCardAudio(card: ReviewCard | null | undefined): boolean {
  if (!card) return false;
  const texts = [
    card.front,
    card.back,
    card.text ?? '',
    ...Object.values(card.extraFields ?? {}),
  ];
  for (const text of texts) {
    if (text && soundNames(text).size > 0) return true;
  }
  if (Array.isArray(card.images) && card.images.some((path) => AUDIO_FILE_EXT.test(path))) {
    return true;
  }
  return false;
}
