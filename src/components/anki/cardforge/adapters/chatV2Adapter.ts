/**
 * CardForge 2.0 - Chat V2 适配器
 *
 * 为 Chat V2 的 ankiCardsBlock 提供与 CardForge 的集成桥接。
 * 这个适配器允许 Chat V2 使用新的 CardForge API，同时保持向后兼容。
 */

import { cardAgent, taskController } from '../index';
import type {
  AnkiCardResult,
  GenerateCardsInput,
  ExportCardsInput,
  ControlTaskInput,
} from '../types';

// ============================================================================
// 类型转换
// ============================================================================

/**
 * Chat V2 AnkiCard 类型（旧格式）
 */
export interface ChatV2AnkiCard {
  id?: string;
  front: string;
  back: string;
  text?: string;
  tags?: string[];
  images?: string[];
  fields?: Record<string, string>;
  template_id?: string;
  is_error_card?: boolean;
  error_content?: string;
}

/**
 * 将 ChatV2 卡片转换为 CardForge 格式
 */
export function chatV2CardToCardForgeCard(card: ChatV2AnkiCard): AnkiCardResult {
  return {
    id: card.id || `card_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    taskId: '',
    templateId: card.template_id || '',
    front: card.front,
    back: card.back,
    text: card.text,
    tags: card.tags || [],
    fields: card.fields || {},
    images: card.images || [],
    isErrorCard: card.is_error_card || false,
    errorContent: card.error_content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 将 CardForge 卡片转换为 ChatV2 格式
 */
export function cardForgeCardToChatV2Card(card: AnkiCardResult): ChatV2AnkiCard {
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    text: card.text,
    tags: card.tags,
    images: card.images,
    fields: card.fields,
    template_id: card.templateId,
    is_error_card: card.isErrorCard,
    error_content: card.errorContent,
  };
}

// ============================================================================
// Chat V2 操作接口
// ============================================================================

/**
 * Chat V2 Anki 操作接口
 *
 * 为 Chat V2 提供简化的 CardForge 操作封装
 */
export const ChatV2AnkiAdapter = {
  /**
   * 生成卡片
   *
   * @param content 学习内容
   * @param options 生成选项
   */
  async generateCards(
    content: string,
    options?: {
      deckName?: string;
      templateId?: string;
      maxCards?: number;
      customRequirements?: string;
    }
  ) {
    const input: GenerateCardsInput = {
      content,
      templates: options?.templateId ? [options.templateId] : undefined,
      maxCards: options?.maxCards,
      options: {
        deckName: options?.deckName,
        customRequirements: options?.customRequirements,
      },
    };

    const result = await cardAgent.generateCards(input);

    return {
      ok: result.ok,
      documentId: result.documentId,
      cards: result.cards?.map(cardForgeCardToChatV2Card) || [],
      stats: result.stats,
      error: result.error,
    };
  },

  /**
   * 暂停生成
   */
  async pause(documentId: string) {
    return taskController.pause(documentId);
  },

  /**
   * 恢复生成
   */
  async resume(documentId: string) {
    return taskController.resume(documentId);
  },

  /**
   * 取消生成
   */
  async cancel(documentId: string) {
    return taskController.cancel(documentId);
  },

  /**
   * 导出卡片
   */
  async exportCards(
    cards: ChatV2AnkiCard[],
    options: {
      format: 'apkg' | 'anki_connect' | 'json';
      deckName: string;
      noteType?: string;
    }
  ) {
    const input: ExportCardsInput = {
      cards: cards.map(chatV2CardToCardForgeCard),
      format: options.format,
      deckName: options.deckName,
      noteType: options.noteType,
    };

    return cardAgent.exportCards(input);
  },

  /**
   * 获取模板列表
   */
  async listTemplates(category?: string) {
    return cardAgent.listTemplates({ category, activeOnly: true });
  },

  /**
   * 分析内容
   */
  async analyzeContent(content: string) {
    return cardAgent.analyzeContent({ content });
  },

  /**
   * 订阅卡片生成事件
   *
   * @param callback 卡片生成回调
   * @returns 取消订阅函数
   */
  onCardGenerated(callback: (card: ChatV2AnkiCard) => void): () => void {
    return cardAgent.on<{ card: AnkiCardResult }>('card:generated', (event) => {
      callback(cardForgeCardToChatV2Card(event.payload.card));
    });
  },

  /**
   * 订阅生成完成事件
   *
   * @param callback 完成回调
   * @returns 取消订阅函数
   */
  onComplete(callback: (documentId: string) => void): () => void {
    // 使用 event.documentId 而非 payload.documentId
    // 因为 CardForgeEvent 的 documentId 在事件顶层，不在 payload 中
    return cardAgent.on('document:complete', (event) => {
      callback(event.documentId);
    });
  },

  /**
   * 订阅错误事件
   *
   * @param callback 错误回调
   * @returns 取消订阅函数
   */
  onError(callback: (error: string) => void): () => void {
    return cardAgent.on<{ error: string }>('task:error', (event) => {
      callback(event.payload.error);
    });
  },
};

// ============================================================================
// React Hook for Chat V2
// ============================================================================

/**
 * useChatV2Anki - Chat V2 专用 Anki Hook
 *
 * 提供与 ankiCardsBlock 兼容的接口
 */
export function useChatV2Anki() {
  // 直接导出适配器方法
  return {
    generateCards: ChatV2AnkiAdapter.generateCards,
    pause: ChatV2AnkiAdapter.pause,
    resume: ChatV2AnkiAdapter.resume,
    cancel: ChatV2AnkiAdapter.cancel,
    exportCards: ChatV2AnkiAdapter.exportCards,
    listTemplates: ChatV2AnkiAdapter.listTemplates,
    analyzeContent: ChatV2AnkiAdapter.analyzeContent,
    onCardGenerated: ChatV2AnkiAdapter.onCardGenerated,
    onComplete: ChatV2AnkiAdapter.onComplete,
    onError: ChatV2AnkiAdapter.onError,
  };
}

// ============================================================================
// 导出
// ============================================================================

export default ChatV2AnkiAdapter;
