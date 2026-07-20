/**
 * Anki API适配器
 * 提供批量操作和断点续传功能的后端API适配
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { AnkiCard, AnkiGenerationOptions } from '../types';

type SaveAnkiCardsParams = {
  cards: AnkiCard[];
  documentId?: string | null;
  businessSessionId?: string | null;
  messageStableId?: string | null;
  blockId?: string | null;
  templateId?: string | null;
  options?: AnkiGenerationOptions;
};

export type SaveAnkiCardFailure = {
  id: string;
  error: string;
};

export type SaveAnkiCardIdMapping = {
  inputIndex: number;
  inputId?: string | null;
  persistedId: string;
};

/** 后端 save_anki_cards 诚实语义响应（serde camelCase；新字段带默认兼容旧前端） */
export type SaveAnkiCardsResponse = {
  savedIds: string[];
  taskId: string;
  cardIdMappings?: SaveAnkiCardIdMapping[];
  skippedIds?: string[];
  duplicatedIds?: string[];
  failed?: SaveAnkiCardFailure[];
};

/** 批量导出选项（允许调用方附加后端可识别的扩展键，如 includeTags） */
export type BatchExportOptions = {
  deckName?: string;
  noteType?: string;
  templateId?: string | null;
  [key: string]: unknown;
};

// 批量操作API适配器
export const ankiApiAdapter = {
  /**
   * 批量导出卡片
   */
  async batchExportCards(params: {
    cards: AnkiCard[];
    format: string;
    options: BatchExportOptions;
  }): Promise<string> {
    // [AnkiApiAdapter] 直接使用原始卡片数据，后端已支持 serde(default) 处理缺失字段
    // 参考 AnkiCardGeneration.tsx 的 handleExportByLevel 实现
    const cardsForExport = params.cards.map(card => ({
      // 保留原始 front/back，如果没有则从 fields 中获取
      front: card.front ?? card.fields?.Front ?? '',
      back: card.back ?? card.fields?.Back ?? '',
      tags: card.tags ?? [],
      images: card.images ?? [],
      id: card.id ?? '',
      task_id: card.task_id ?? '',
      is_error_card: card.is_error_card ?? false,
      error_content: card.error_content ?? null,
      created_at: card.created_at ?? new Date().toISOString(),
      updated_at: card.updated_at ?? new Date().toISOString(),
      // [AnkiApiAdapter] 关键：将 fields 映射到 extra_fields，后端会从中提取模板字段
      extra_fields: card.extra_fields ?? card.fields ?? {},
      template_id: card.template_id ?? params.options.templateId ?? null,
      text: card.text ?? null,
    }));

    try {
      // 批量导出API（新版）
      const notes = params.cards.map(card => ({
        fields: card.fields && Object.keys(card.fields).length > 0
          ? card.fields
          : { Front: card.front, Back: card.back },
        tags: card.tags ?? [],
        images: card.images ?? []
      }));
      return await invoke('batch_export_cards', { notes, format: params.format, options: params.options });
    } catch (error: unknown) {
      // 降级：使用旧接口
      if (params.format === 'apkg') {
        return await invoke('export_cards_as_apkg_with_template', {
          // 双写兼容：后端 snake_case，部分旧前端/桥接可能校验 camelCase
          selected_cards: cardsForExport,
          selectedCards: cardsForExport,
          deck_name: params.options.deckName || 'Default',
          deckName: params.options.deckName || 'Default',
          note_type: params.options.noteType || 'Basic',
          noteType: params.options.noteType || 'Basic',
          template_id: params.options.templateId || null,
          templateId: params.options.templateId || null
        });
      }
      throw new Error(i18next.t('anki:api_adapter.unsupported_export_format', { format: params.format }));
    }
  },

  /**
   * 保存卡片到本地库
   */
  async saveAnkiCards(params: SaveAnkiCardsParams): Promise<SaveAnkiCardsResponse> {
    try {
      // [AnkiApiAdapter] 后端期望 snake_case 参数名，并且需要包装在 request 对象中
      // 同时确保卡片数据包含 fields 字段
      const cardsPayload = params.cards.map(card => ({
        id: card.id ?? null,
        front: card.front ?? card.fields?.Front ?? '',
        back: card.back ?? card.fields?.Back ?? '',
        text: card.text ?? null,
        tags: card.tags ?? [],
        images: card.images ?? [],
        // [AnkiApiAdapter] 关键：将 fields 传递给后端
        fields: card.fields ?? card.extra_fields ?? {},
        template_id: card.template_id ?? params.templateId ?? null,
      }));

      return await invoke<SaveAnkiCardsResponse>('save_anki_cards', {
        request: {
          document_id: params.documentId ?? null,
          business_session_id: params.businessSessionId ?? null,
          message_stable_id: params.messageStableId ?? null,
          block_id: params.blockId ?? null,
          template_id: params.templateId ?? null,
          cards: cardsPayload,
          options: params.options ?? null,
        }
      });
    } catch (error: unknown) {
      // 降级方案：缓存到 localStorage 以防数据丢失，但不伪装为成功
      try {
        const existing = localStorage.getItem('anki_cards_cache');
        const cache = existing ? JSON.parse(existing) : { cards: [] };
        cache.cards = params.cards;
        cache.lastUpdated = new Date().toISOString();
        localStorage.setItem('anki_cards_cache', JSON.stringify(cache));
        console.warn('[ankiApiAdapter] saveAnkiCards: backed up to localStorage after backend failure');
      } catch (cacheErr) {
        console.error('[ankiApiAdapter] saveAnkiCards: localStorage backup also failed:', cacheErr);
      }
      // 向上层抛出原始错误，让调用方知道保存失败
      throw error;
    }
  },

  /**
   * 删除卡片
   */
  async deleteAnkiCards(params: { cardIds: string[] }): Promise<void> {
    // 后端仅有 delete_anki_card（单数），需逐个调用
    // Tauri v2 默认 camelCase → snake_case 自动映射
    const errors: string[] = [];
    for (const id of params.cardIds) {
      try {
        await invoke('delete_anki_card', { cardId: id });
      } catch (err) {
        errors.push(`${id}: ${err}`);
      }
    }
    if (errors.length > 0) {
      console.error('[ankiApiAdapter] deleteAnkiCards partial failures:', errors);
      if (errors.length === params.cardIds.length) {
        throw new Error(`Failed to delete all ${errors.length} cards`);
      }
    }
  },

  // ★ 2026-07 死代码清理：generateAnkiCardsForSegment（@deprecated，断点续传
  //   分段生成 + 流式降级）已删除。Grep 确认仓库内无任何调用方；其降级路径
  //   依赖的临时会话清理逻辑由 ankiCompletionNotifier 的注释引用，仅为历史说明。
};

// 通知系统适配器
export const notificationAdapter = {
  show(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') {
    // 发送自定义事件
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('app-notification', {
        detail: { message, type }
      }));
    }
    
    // 同时使用console日志作为备份
    const logMethod = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log';
    console[logMethod](`[${type.toUpperCase()}]`, message);
    
    // toast 通知已通过 app-notification 事件分发，由 UI 层统一处理
  }
};
