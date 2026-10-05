import type { TFunction } from 'i18next';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { humanizeCitationMarkers } from '@/components/anki/utils/cardCitations';

const FIELD_LIMIT = 1500;

function plainField(value: string | null | undefined): string {
  const text = (value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return humanizeCitationMarkers(text).trim().slice(0, FIELD_LIMIT);
}

/** 复习时没记住 → 新开对话让 AI 讲这张卡（预填不自动发送，学习者可以补充自己卡在哪）。 */
export function askAiAboutCard(card: { front: string; back: string; text?: string }, t: TFunction): void {
  const front = plainField(card.text) || plainField(card.front);
  const back = card.text ? '' : plainField(card.back);
  const lines = [`${t('session.front')}：${front}`];
  if (back) lines.push(`${t('session.back')}：${back}`);
  dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
    content: t('session.askAiPrompt', {
      card: lines.join('\n'),
      defaultValue: '我复习闪卡时没记住这张卡，请帮我讲明白：先说清楚它考的是什么、为什么是这个答案，再给一个好记的办法，最后出 1 道小题检验我。\n\n{{card}}',
    }),
    autoSend: false,
    newSession: true,
  });
}
