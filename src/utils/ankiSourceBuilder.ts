import { ChatMessage, MistakeItem } from '../types';
// ★ 图谱模块已废弃 - 本地占位类型
type ProblemCard = { 
  id: string; 
  content_problem: string; 
  content_insight?: string;
  status?: string;
  tags?: string[];
  access_count?: number;
  last_accessed_at?: string;
  notes?: string;
  images?: string[];
};
import { t } from './i18n';

const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

const extractTextFromContent = (content: ChatMessage['content']): string => {
  if (!content) return '';
  if (typeof content === 'string') {
    return normalizeNewlines(content);
  }
  if (Array.isArray(content)) {
    return normalizeNewlines(
      content
        .filter((part): part is { type: 'text'; text: string } => part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    );
  }
  return '';
};

const formatTimestamp = (timestamp?: string): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) {
    try {
      return date.toLocaleString();
    } catch {
      return timestamp;
    }
  }
  return timestamp;
};

const formatAttachmentNote = (message: ChatMessage): string | null => {
  const notes: string[] = [];
  const docNames = Array.isArray(message.doc_attachments)
    ? message.doc_attachments
        .map((doc) => doc?.name)
        .filter((name): name is string => Boolean(name && name.trim().length > 0))
    : [];
  if (docNames.length > 0) {
    notes.push(`${t('utils.anki.document_attachment')}(${docNames.join('、')})`);
  } else if (Array.isArray(message.doc_attachments) && message.doc_attachments.length > 0) {
    notes.push(t('utils.anki.document_attachment'));
  }

  const imageCount = [
    Array.isArray((message as any).image_paths) ? (message as any).image_paths.length : 0,
    Array.isArray((message as any).image_base64) ? (message as any).image_base64.length : 0,
    Array.isArray((message as any).question_images) ? (message as any).question_images.length : 0,
  ].reduce((sum, count) => sum + count, 0);

  if (imageCount > 0) {
    notes.push(`图片附件x${imageCount}`);
  }

  if (notes.length === 0) return null;
  return `【附件已清理：${notes.join('、')}】`;
};

const formatChatMessageLine = (message: ChatMessage, index: number): string => {
  const roleLabel = message.role === 'user' ? t('roles.user') : t('roles.assistant');
  const timeLabel = formatTimestamp(message.timestamp);
  const text = extractTextFromContent(message.content);
  const contentText = text.length > 0 ? text : '（无文本内容）';
  const attachmentNote = formatAttachmentNote(message);
  const prefix = `${index + 1}. ${timeLabel ? `[${timeLabel}] ` : ''}${roleLabel}`;
  return attachmentNote
    ? `${prefix}: ${contentText}\n    ${attachmentNote}`
    : `${prefix}: ${contentText}`;
};

const formatChatHistory = (history: ChatMessage[]): string => {
  if (!Array.isArray(history) || history.length === 0) {
    return '（无聊天记录）';
  }

  const lines = history
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message, index) => formatChatMessageLine(message, index));

  return lines.join('\n');
};

export interface BuildChatHistoryOptions {
  maxMessages?: number;
  maxChars?: number;
  maxLength?: number;
  title?: string;
  conversationId?: string | null;
}

export interface BuildChatHistoryResult {
  content: string;
  trimmed: boolean;
  totalMessages: number;
  includedMessages: number;
}

const buildTimestampLabel = () => {
  try {
    return new Date().toLocaleString();
  } catch {
    return new Date().toISOString();
  }
};

export const buildContentFromChatHistory = (
  chatHistory: ChatMessage[] | undefined,
  options?: BuildChatHistoryOptions,
): BuildChatHistoryResult => {
  const sanitized = Array.isArray(chatHistory)
    ? chatHistory.filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    : [];

  const maxMessages = Math.max(1, options?.maxMessages ?? sanitized.length ?? 20);
  const subset = sanitized.slice(-maxMessages);
  const includedMessages = subset.length;
  let trimmed = subset.length < sanitized.length;

  const formattedSubset = subset.map((message, index) => formatChatMessageLine(message, index));
  const maxChars = Math.max(1024, options?.maxChars ?? options?.maxLength ?? 10_000);
  let historyBody = formattedSubset.join('\n');
  if (historyBody.length > maxChars) {
    trimmed = true;
    historyBody = historyBody.slice(historyBody.length - maxChars);
  }
  if (!historyBody.trim()) {
    historyBody = '（无聊天记录）';
  }

  const lines: string[] = [];
  lines.push(`# ${options?.title || t('utils.anki.chat_export')}`);
  lines.push(`- 导出时间: ${buildTimestampLabel()}`);
  if (options?.conversationId) {
    lines.push(`- 会话ID: ${options.conversationId}`);
  }
  lines.push(`- 原始消息数: ${sanitized.length}`);
  lines.push(`- 导出消息数: ${includedMessages}`);
  lines.push('');
  lines.push('## 最近对话');
  lines.push(historyBody);
  lines.push('');
  if (trimmed) {
    lines.push('> … 仅展示最近的对话内容，较早的消息已被截断。');
  }
  lines.push('> 附件提示：所有文档、图片等二进制内容已移除，仅保留文本内容供制卡使用。');

  return {
    content: lines.join('\n'),
    trimmed,
    totalMessages: sanitized.length,
    includedMessages,
  };
};

export const buildContentFromMistake = (mistake: MistakeItem): string => {
  const lines: string[] = [];
  lines.push(`# 分析库错题导出`);
  lines.push(`- 错题ID: ${mistake.id}`);
  lines.push(`- 错题类型: ${mistake.mistake_type || t('utils.anki.not_filled')}`);
  lines.push(`- 标签: ${Array.isArray(mistake.tags) && mistake.tags.length > 0 ? mistake.tags.join('、') : t('utils.anki.none')}`);
  if (mistake.chat_metadata?.title) {
    lines.push(`- 对话标题: ${mistake.chat_metadata.title}`);
  }
  lines.push('');

  if (mistake.ocr_text) {
    lines.push('## OCR识别内容');
    lines.push('```');
    lines.push(normalizeNewlines(mistake.ocr_text));
    lines.push('```');
    lines.push('');
  }

  if (mistake.user_question) {
    lines.push('## 用户原始问题');
    lines.push(normalizeNewlines(mistake.user_question));
    lines.push('');
  }

  if (mistake.mistake_summary) {
    lines.push('## 错题总结');
    lines.push(normalizeNewlines(mistake.mistake_summary));
    lines.push('');
  }

  if (mistake.user_error_analysis) {
    lines.push('## 错误原因分析');
    lines.push(normalizeNewlines(mistake.user_error_analysis));
    lines.push('');
  }

  const chatHistoryText = formatChatHistory(Array.isArray(mistake.chat_history) ? mistake.chat_history : []);
  lines.push('## 历史聊天记录');
  lines.push(chatHistoryText);
  lines.push('');

  const questionImageCount = Array.isArray(mistake.question_images) ? mistake.question_images.length : 0;
  const analysisImageCount = Array.isArray(mistake.analysis_images) ? mistake.analysis_images.length : 0;
  if (questionImageCount + analysisImageCount > 0) {
    lines.push(`（提示：已清理题目/解析图片附件，共计 ${questionImageCount + analysisImageCount} 张）`);
    lines.push('');
  }

  lines.push('> 本文档由系统自动生成，已移除所有文档与图片附件，仅保留文本内容供制卡使用。');

  return lines.join('\n');
};

// ★ 2026-02 清理：buildContentFromIrecCard 已删除（图谱模块废弃）

