import type { TFunction } from 'i18next';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { humanizeCitationMarkers } from '@/components/anki/utils/cardCitations';
import { isOcclusionCard, parseOcclusionSpec } from '@/components/anki/utils/imageOcclusion';

const FIELD_LIMIT = 1500;
const SUMMARY_CARD_LIMIT = 8;

export interface AskAiCardInput {
  front: string;
  back: string;
  text?: string;
  tags?: string[];
  extraFields?: Record<string, string>;
}

function plainField(value: string | null | undefined): string {
  const text = (value ?? '')
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return humanizeCitationMarkers(text).trim().slice(0, FIELD_LIMIT);
}

function extraFieldLookup(
  extraFields: Record<string, string> | undefined,
  candidates: readonly string[],
): string {
  if (!extraFields) return '';
  const lowered = new Map(
    Object.entries(extraFields).map(([k, v]) => [k.trim().toLowerCase(), v] as const),
  );
  for (const name of candidates) {
    const value = lowered.get(name.toLowerCase());
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function formatCardForAiPrompt(card: AskAiCardInput, t: TFunction): string {
  const occlusion = isOcclusionCard(card.tags, card.extraFields);
  const occlusionSpec = occlusion ? parseOcclusionSpec(card.extraFields) : null;

  const clozeText = plainField(card.text) || plainField(extraFieldLookup(card.extraFields, ['Text']));
  const extraBack = plainField(
    extraFieldLookup(card.extraFields, ['Extra', 'Back', 'Answer', 'Explanation']),
  );
  const rawFront = plainField(card.front) || plainField(extraFieldLookup(card.extraFields, ['Front', 'Question']));
  const rawBack = plainField(card.back);

  const front = clozeText || rawFront;
  let back = clozeText ? (extraBack || rawBack) : (rawBack || extraBack);

  if (back && back === front) {
    back = '';
  }

  const lines: string[] = [];
  if (occlusion) {
    const occlusionTag = t('session.askAiOcclusionHint', {
      defaultValue: '[Image Occlusion Card]',
    });
    const labels = (occlusionSpec?.boxes ?? [])
      .map((box) => `#${box.clozeIndex} ${box.label}`.trim())
      .filter(Boolean);
    const frontSummary = [occlusionTag, front].filter(Boolean).join(' ');
    lines.push(`${t('session.front')}: ${frontSummary}`);
    if (labels.length > 0) {
      lines.push(
        t('session.askAiOcclusionRegions', {
          regions: labels.join(', '),
          defaultValue: 'Masked regions: {{regions}}',
        }),
      );
    }
    if (back) {
      lines.push(`${t('session.back')}: ${back}`);
    }
    return lines.join('\n');
  }

  lines.push(`${t('session.front')}: ${front}`);
  if (back) lines.push(`${t('session.back')}: ${back}`);
  return lines.join('\n');
}

/** 复习时没记住 → 新开对话让 AI 讲这张卡（预填不自动发送，学习者可以补充自己卡在哪）。 */
export function askAiAboutCard(card: AskAiCardInput, t: TFunction): void {
  const formatted = formatCardForAiPrompt(card, t);
  dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
    content: t('session.askAiPrompt', {
      card: formatted,
      defaultValue: "I couldn't recall this flashcard during review. Please explain it: what it is testing and why this is the answer, then give me a way to remember it, and finally one short question to check me.\n\n{{card}}",
    }),
    autoSend: false,
    newSession: true,
  });
}

/** 会话结束后 → 新开对话让 AI 梳理本轮标记「重来」的遗忘卡难点。 */
export function askAiAboutCards(cards: readonly AskAiCardInput[], t: TFunction): void {
  if (cards.length === 0) return;
  const shown = cards.slice(0, SUMMARY_CARD_LIMIT);
  const body = shown
    .map((card, index) => `${index + 1}.\n${formatCardForAiPrompt(card, t)}`)
    .join('\n\n');
  dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
    content: t('review.askAiSummaryPrompt', {
      count: cards.length,
      cards: body,
      defaultValue: 'I just finished a flashcard review session and marked {{count}} card(s) as Again. Please help me review common gaps, confusing points, and memory hooks, then give me 2 short practice questions:\n\n{{cards}}',
    }),
    autoSend: false,
    newSession: true,
  });
}
