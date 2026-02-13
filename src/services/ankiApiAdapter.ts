/**
 * Anki API适配器
 * 提供批量操作和断点续传功能的后端API适配
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { AnkiCard, AnkiGenerationOptions } from '../types';

type SaveAnkiCardsParams = {
  cards: AnkiCard[];
  businessSessionId?: string | null;
  templateId?: string | null;
  options?: AnkiGenerationOptions;
};

type SaveAnkiCardsResponse = {
  savedIds: string[];
  taskId: string;
};

// 批量操作API适配器
export const ankiApiAdapter = {
  /**
   * 批量导出卡片
   */
  async batchExportCards(params: {
    cards: AnkiCard[];
    format: string;
    options: any;
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
          business_session_id: params.businessSessionId ?? null,
          template_id: params.templateId ?? null,
          cards: cardsPayload,
          options: params.options ?? null,
        }
      });
    } catch (error: unknown) {
      // 降级方案：保存到localStorage
      const existing = localStorage.getItem('anki_cards_cache');
      const cache = existing ? JSON.parse(existing) : { cards: [] };
      cache.cards = params.cards;
      cache.lastUpdated = new Date().toISOString();
      localStorage.setItem('anki_cards_cache', JSON.stringify(cache));
      return {
        savedIds: params.cards.map((card) => card.id || card.front),
        taskId: 'local-cache',
      };
    }
  },

  /**
   * 删除卡片
   */
  async deleteAnkiCards(params: { cardIds: string[] }): Promise<void> {
    try {
      await invoke('delete_anki_cards', params);
    } catch (error: unknown) {
      // 降级方案：从localStorage删除
      const existing = localStorage.getItem('anki_cards_cache');
      if (existing) {
        const cache = JSON.parse(existing);
        cache.cards = cache.cards.filter((card: AnkiCard) => 
          !params.cardIds.includes(card.id || card.front)
        );
        localStorage.setItem('anki_cards_cache', JSON.stringify(cache));
      }
    }
  },

  /**
   * 为分段生成Anki卡片（断点续传）
   *
   * @deprecated 当前未使用。如果启用，调用方必须确保 params.options 包含 field_extraction_rules，
   * 否则后端会报错："字段提取规则缺失"
   */
  async generateAnkiCardsForSegment(params: {
    content: string;
    options: any; // 必须包含 field_extraction_rules
    segmentIndex: number;
    totalSegments: number;
  }): Promise<AnkiCard[]> {
    // [AnkiApiAdapter] 警告：options 必须包含 field_extraction_rules 字段
    if (!params.options?.field_extraction_rules || Object.keys(params.options.field_extraction_rules).length === 0) {
      console.error('[ankiApiAdapter] generateAnkiCardsForSegment: options.field_extraction_rules is missing or empty');
      throw new Error(i18next.t('anki:api_adapter.missing_field_extraction_rules'));
    }

    try {
      // 尝试使用分段生成API
      return await invoke('generate_anki_cards_for_segment', params);
    } catch (error: unknown) {
      notificationAdapter.show(i18next.t('anki:api_adapter.segment_fallback_warning'), 'warning');
      // 降级方案：使用现有的流式生成API，但只处理单个片段
      const cards: AnkiCard[] = [];

      // 创建临时的事件监听器来收集卡片
      const { guardedListen } = await import('../utils/guardedListen');
      let resolveListener: (() => void) | null = null;
      const donePromise = new Promise<void>((resolve) => {
        resolveListener = resolve;
      });

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let documentIdRef: string | null = null;
      let unlisten: (() => void | Promise<void>) | null = null;

      try {
        unlisten = await new Promise<() => void | Promise<void>>((resolve) => {
          guardedListen('anki_generation_event', (event: any) => {
            const payload = event?.payload?.payload ?? event?.payload ?? event;
            if (!payload) return;
            const normalized = payload.type
              ? { type: payload.type, data: payload.data }
              : (() => {
                  const keys = Object.keys(payload);
                  if (keys.length === 0) return null;
                  const eventType = keys[0];
                  return { type: eventType, data: payload[eventType] };
                })();
            if (!normalized) return;

            const eventDocumentId =
              normalized?.data?.document_id ||
              payload?.document_id ||
              normalized?.data?.documentId;
            if (documentIdRef && eventDocumentId && eventDocumentId !== documentIdRef) {
              return;
            }

            if (normalized.type === 'NewCard' && normalized.data) {
              const cardData = normalized.data?.card ?? normalized.data;
              cards.push(cardData);
            }

            if (
              normalized.type === 'TaskCompleted' ||
              normalized.type === 'DocumentProcessingCompleted' ||
              normalized.type === 'TaskFailed' ||
              normalized.type === 'DocumentProcessingFailed' ||
              normalized.type === 'DocumentProcessingCancelled'
            ) {
              resolveListener?.();
            }
          }).then(resolve);
        });

        timeoutId = setTimeout(() => {
          notificationAdapter.show(i18next.t('anki:api_adapter.segment_timeout_warning'), 'warning');
          resolveListener?.();
        }, 12000);

        // 启动生成
        documentIdRef = await invoke('start_enhanced_document_processing', {
          // 双写兼容：后端为 snake_case
          document_content: params.content,
          documentContent: params.content,
          original_document_name: `segment_${params.segmentIndex}`,
          originalDocumentName: `segment_${params.segmentIndex}`,
          options: {
            ...params.options,
            max_cards_per_mistake: 10, // 限制每个分段的卡片数量
          }
        });

        await donePromise;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (unlisten) {
          try {
            await Promise.resolve(unlisten());
          } catch (unlistenErr: unknown) {
            console.warn('[ankiApiAdapter] Failed to cleanup anki_generation_event listener', unlistenErr);
          }
        }
        if (documentIdRef) {
          try {
            await invoke('delete_document_session', {
              documentId: documentIdRef,
              document_id: documentIdRef,
            });
          } catch (cleanupErr: unknown) {
            console.warn('[ankiApiAdapter] Failed to delete temporary document session', cleanupErr);
          }
        }
      }

      return cards;
    }
  }
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
