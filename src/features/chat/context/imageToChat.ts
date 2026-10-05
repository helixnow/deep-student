/**
 * 把一张图片（如 PDF 框选截图）交给当前会话的输入框当附件，与粘贴图片同一条上传流程。
 * 会话选择与「引用到对话」一致：当前会话；没有就用聊天页的隐藏草稿（进聊天页即可看到）。
 */
import { t } from '@/utils/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { ensureActiveChatSession } from '@/features/chat/pages/ensureActiveChatSession';
import { queueChatInputFiles } from './chatInputInbox';
import { notifyAddedToChat } from './selectionRef';

export async function sendImageToChat(file: File, description: string): Promise<boolean> {
  const sessionId = await ensureActiveChatSession();
  if (!sessionId || !sessionManager.has(sessionId)) {
    showGlobalNotification('warning', t('selectionRef.noSession', { defaultValue: '没有可用的会话' }, 'chatV2'));
    return false;
  }
  queueChatInputFiles(sessionId, [file]);
  notifyAddedToChat(sessionId, description);
  return true;
}
