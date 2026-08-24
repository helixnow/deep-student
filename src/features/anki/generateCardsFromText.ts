/**
 * 从任意学习材料启动制卡任务的共享入口。
 *
 * 直接复用 CardForge 的统一 cardAgent API，只把文案交给调用方，让错题本 /
 * 作文批改 / 笔记这类非聊天表面也能复用，而不依赖聊天适配器或 chatV2
 * 命名空间的 selectionToolbar.* 文案。
 */
import { cardAgent } from '@/components/anki/cardforge';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { getErrorMessage } from '@/utils/errorUtils';

/** 内容短于该长度时制卡质量不可控，直接拒绝而不是发一个必然失败的任务 */
export const MIN_CONTENT_LENGTH_FOR_CARDS = 10;

export interface GenerateCardsFromTextInput {
  content: string;
  deckName: string;
  /** 传给模型的额外要求（题型偏好、覆盖重点等） */
  requirements?: string;
  maxCards?: number;
  messages: {
    tooShort: string;
    started: string;
    failed: string;
    openTaskDashboard: string;
  };
}

export type GenerateCardsFromTextResult =
  | { ok: true; documentId?: string }
  | { ok: false; reason: 'too_short' | 'generate_failed'; error?: string };

function navigateToTaskDashboard(): void {
  dispatchAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, { view: 'task-dashboard' });
}

export async function generateCardsFromText(
  input: GenerateCardsFromTextInput,
): Promise<GenerateCardsFromTextResult> {
  const content = input.content.trim();
  if (content.length < MIN_CONTENT_LENGTH_FOR_CARDS) {
    showGlobalNotification('warning', input.messages.tooShort);
    return { ok: false, reason: 'too_short' };
  }

  try {
    const result = await cardAgent.generateCards({
      content,
      maxCards: input.maxCards,
      options: {
        deckName: input.deckName,
        customRequirements: input.requirements,
      },
    });

    if (!result.ok) {
      const error = result.error || input.messages.failed;
      showGlobalNotification('error', error);
      return { ok: false, reason: 'generate_failed', error };
    }

    showGlobalNotification('success', input.messages.started, undefined, {
      action: {
        label: input.messages.openTaskDashboard,
        onClick: navigateToTaskDashboard,
      },
      borderTone: 'neutral',
    });
    return { ok: true, documentId: result.documentId };
  } catch (error: unknown) {
    const message = getErrorMessage(error) || input.messages.failed;
    showGlobalNotification('error', message);
    return { ok: false, reason: 'generate_failed', error: message };
  }
}
