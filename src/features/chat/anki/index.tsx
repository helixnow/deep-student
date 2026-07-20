/**
 * Chat V2 - Anki 模块
 *
 * 提供 Anki 卡片管理相关的功能和组件
 * 已集成 CardForge 2.0 真实 API
 *
 * 当前生产工具链由 ChatAnki skill 与 builtin-chatanki_* 工具统一提供。
 * 本模块仅保留卡片管理与预览组件，不负责向 LLM 注册工具。
 */

import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { save as dialogSave } from '@tauri-apps/plugin-dialog';
import type { AnkiCard, AnkiGenerationOptions, CustomAnkiTemplate } from '@/types';
import {
  ankiApiAdapter,
  type SaveAnkiCardIdMapping,
} from '@/services/ankiApiAdapter';
import { Card3DPreview } from '@/components/Card3DPreview';

// ============================================================================
// 类型定义
// ============================================================================

export type AnkiCardStackPreviewStatus =
  | 'idle'
  | 'saving'
  | 'exporting'
  | 'syncing'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'stored'
  | 'parsing'
  | 'ready';

// ============================================================================
// Anki 卡片操作函数
// ============================================================================

interface AnkiActionContext {
  documentId?: string;
  templateId?: string;
  messageStableId?: string;
  blockId?: string;
  businessSessionId?: string;
  options?: AnkiGenerationOptions;
}

interface AnkiActionParams {
  cards: AnkiCard[];
  context?: AnkiActionContext;
}

type AnkiSyncWarning =
  | {
      code: 'anki_sync_partial';
      details: {
        total: number;
        added: number;
        failed: number;
        duplicates?: number;
      };
    }
  | {
      code: 'anki_sync_all_duplicates';
      details: {
        total: number;
        duplicates: number;
      };
    };

/** 后端 add_cards_to_anki_connect 返回的同步明细报告（serde camelCase） */
interface AnkiSyncReport {
  noteIds: Array<number | null>;
  added: number;
  duplicates: number;
  failed: number;
  createdModels: string[];
}

type AnkiSaveWarning =
  | {
      code: 'anki_save_partial';
      details: {
        saved: number;
        duplicated: number;
        skipped: number;
        failed: number;
      };
    }
  | {
      code: 'anki_save_all_skipped';
      details: {
        skipped: number;
        duplicated: number;
      };
    };

/**
 * 保存卡片到本地库
 *
 * 使用诚实语义响应：区分新插入 / 已存在更新 / 跳过 / 失败。
 */
export async function saveCardsToLibrary(
  params: AnkiActionParams
): Promise<{
  success: boolean;
  savedCount: number;
  savedIds?: string[];
  cardIdMappings?: SaveAnkiCardIdMapping[];
  duplicatedIds?: string[];
  skippedIds?: string[];
  failed?: Array<{ id: string; error: string }>;
  taskId?: string;
  warning?: AnkiSaveWarning;
  error?: string;
  skippedErrorCards?: number;
}> {
  const { cards, context } = params;

  if (cards.length === 0) {
    return { success: true, savedCount: 0, cardIdMappings: [] };
  }

  const errorCardCount = cards.filter((card) => {
    const row = card as { is_error_card?: unknown; isErrorCard?: unknown };
    return row.is_error_card === true || row.isErrorCard === true;
  }).length;
  const savableCards = cards.filter((card) => {
    const row = card as { is_error_card?: unknown; isErrorCard?: unknown };
    return row.is_error_card !== true && row.isErrorCard !== true;
  });
  if (errorCardCount > 0) {
    console.warn(`[anki] saveCardsToLibrary: ${errorCardCount} error cards skipped`);
  }
  if (savableCards.length === 0) {
    return {
      success: false,
      savedCount: 0,
      skippedErrorCards: errorCardCount,
      error: 'all cards are diagnostic error cards',
    };
  }

  try {
    const result = await ankiApiAdapter.saveAnkiCards({
      cards: savableCards,
      documentId: context?.documentId ?? null,
      businessSessionId: context?.businessSessionId ?? null,
      messageStableId: context?.messageStableId ?? null,
      blockId: context?.blockId ?? null,
      templateId: context?.templateId ?? null,
      options: context?.options,
    });

    const savedIds = result.savedIds ?? [];
    const cardIdMappings = result.cardIdMappings ?? [];
    const duplicatedIds = result.duplicatedIds ?? [];
    const skippedIds = result.skippedIds ?? [];
    const failed = result.failed ?? [];
    const savedCount = savedIds.length;
    const hasProgress =
      savedCount > 0 || duplicatedIds.length > 0 || (skippedIds.length > 0 && failed.length === 0);

    if (!hasProgress) {
      const failDetail = failed
        .map((f) => `${f.id}: ${f.error}`)
        .join('; ');
      console.error('[anki] saveCardsToLibrary error: no cards saved', { failed });
      return {
        success: false,
        savedCount: 0,
        savedIds,
        cardIdMappings,
        duplicatedIds,
        skippedIds,
        failed,
        taskId: result.taskId,
        error: failDetail || 'savedIds empty',
      };
    }

    let warning: AnkiSaveWarning | undefined;
    if (failed.length > 0 || (skippedIds.length > 0 && savedCount > 0)) {
      warning = {
        code: 'anki_save_partial',
        details: {
          saved: savedCount,
          duplicated: duplicatedIds.length,
          skipped: skippedIds.length,
          failed: failed.length,
        },
      };
    } else if (savedCount === 0 && (skippedIds.length > 0 || duplicatedIds.length > 0)) {
      warning = {
        code: 'anki_save_all_skipped',
        details: {
          skipped: skippedIds.length,
          duplicated: duplicatedIds.length,
        },
      };
    }

    console.log('[anki] saveCardsToLibrary success:', {
      saved: savedCount,
      duplicated: duplicatedIds.length,
      skipped: skippedIds.length,
      failed: failed.length,
      skippedErrorCards: errorCardCount,
    });

    return {
      success: true,
      savedCount,
      savedIds,
      cardIdMappings,
      duplicatedIds,
      skippedIds,
      failed,
      taskId: result.taskId,
      warning,
      ...(errorCardCount > 0 ? { skippedErrorCards: errorCardCount } : {}),
    };
  } catch (error: unknown) {
    console.error('[anki] saveCardsToLibrary error:', error);
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return {
      success: false,
      savedCount: 0,
      error: message,
      ...(errorCardCount > 0 ? { skippedErrorCards: errorCardCount } : {}),
    };
  }
}

/**
 * 导出卡片为 APKG 文件
 *
 * 使用 ChatV2AnkiAdapter 导出
 */
export async function exportCardsAsApkg(
  params: AnkiActionParams & { deckName?: string; noteType?: string }
): Promise<{ success: boolean; filePath?: string; cancelled?: boolean; skippedErrorCards?: number }> {
  const { cards, context } = params;
  const deckName =
    typeof params.deckName === 'string' && params.deckName.trim()
      ? params.deckName
      : context?.options?.deck_name || 'Default';

  if (cards.length === 0) {
    return { success: false };
  }

  try {
    // 多模板导出：直接调用后端 export_cards_as_apkg_with_template
    // 每张卡片保留自己的 template_id，后端会按卡片分组加载对应模板
    const errorCardCount = cards.filter((card) => {
      const row = card as { is_error_card?: unknown; isErrorCard?: unknown };
      return row.is_error_card === true || row.isErrorCard === true;
    }).length;
    const cardsForExport = cards
      .filter((card) => {
        const row = card as { is_error_card?: unknown; isErrorCard?: unknown };
        return row.is_error_card !== true && row.isErrorCard !== true;
      })
      .map(card => ({
        front: card.front ?? card.fields?.Front ?? '',
        back: card.back ?? card.fields?.Back ?? '',
        text: card.text ?? null,
        tags: card.tags ?? [],
        images: card.images ?? [],
        id: card.id ?? '',
        task_id: card.task_id ?? '',
        is_error_card: false,
        error_content: null,
        created_at: card.created_at ?? new Date().toISOString(),
        updated_at: card.updated_at ?? new Date().toISOString(),
        extra_fields: card.extra_fields ?? card.fields ?? {},
        template_id: card.template_id ?? context?.templateId ?? null,
      }));

    if (errorCardCount > 0) {
      console.warn(`[anki] exportCardsAsApkg: ${errorCardCount} error cards skipped`);
    }

    if (cardsForExport.length === 0) {
      return { success: false, skippedErrorCards: errorCardCount };
    }

    const sanitizedDeckName = deckName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'anki-export';
    const selectedPath = await dialogSave({
      defaultPath: `${sanitizedDeckName}.apkg`,
      filters: [{ name: 'APKG', extensions: ['apkg'] }],
    });

    if (!selectedPath) {
      return { success: false, cancelled: true };
    }

    // 直接调用后端多模板导出命令
    // 后端按每张卡片的 template_id 分组，创建独立 Anki model，
    // 每个 model 有各自的字段列表、HTML/CSS card template
    const filePath: string = await invoke('export_multi_template_apkg', {
      cards: cardsForExport,
      deckName,
      outputPath: selectedPath,
    });

    if (filePath) {
      console.log('[anki] exportCardsAsApkg success:', filePath);
      return { success: true, filePath, skippedErrorCards: errorCardCount };
    } else {
      console.error('[anki] exportCardsAsApkg: no file path returned');
      return { success: false };
    }
  } catch (error: unknown) {
    console.error('[anki] exportCardsAsApkg error:', error);
    return { success: false };
  }
}

/**
 * 通过 AnkiConnect 同步卡片到本机 Anki
 *
 * 直接调用后端 add_cards_to_anki_connect 命令
 */
export async function importCardsViaAnkiConnect(
  params: AnkiActionParams & { deckName?: string; noteType?: string }
): Promise<{ success: boolean; importedCount: number; warning?: AnkiSyncWarning }> {
  const { cards, context } = params;
  const deckName =
    typeof params.deckName === 'string' && params.deckName.trim()
      ? params.deckName
      : context?.options?.deck_name || 'Default';
  const noteType =
    typeof params.noteType === 'string' && params.noteType.trim()
      ? params.noteType
      : context?.options?.note_type || 'Basic';

  if (cards.length === 0) {
    return { success: true, importedCount: 0 };
  }

  try {
    const validCards = cards
      .filter((c) => {
        const row = c as { is_error_card?: unknown; isErrorCard?: unknown };
        return row.is_error_card !== true && row.isErrorCard !== true;
      })
      .map(card => ({
        front: card.front ?? card.fields?.Front ?? '',
        back: card.back ?? card.fields?.Back ?? '',
        text: card.text ?? null,
        tags: card.tags ?? [],
        images: card.images ?? [],
        id: card.id ?? '',
        task_id: card.task_id ?? '',
        is_error_card: false,
        error_content: null,
        created_at: card.created_at ?? new Date().toISOString(),
        updated_at: card.updated_at ?? new Date().toISOString(),
        extra_fields: card.extra_fields ?? card.fields ?? {},
        template_id: card.template_id ?? null,
      }));

    // 后端签名：add_cards_to_anki_connect(selected_cards, deck_name, note_type)
    // Tauri v2 默认期望 camelCase JS 参数，自动映射到 snake_case Rust 参数
    const report = await invoke<AnkiSyncReport>('add_cards_to_anki_connect', {
      selectedCards: validCards,
      deckName,
      noteType,
    });

    const importedCount = report.added;
    let warning: AnkiSyncWarning | undefined;
    if (report.failed > 0 && report.added > 0) {
      warning = {
        code: 'anki_sync_partial',
        details: {
          total: validCards.length,
          added: report.added,
          failed: report.failed,
          duplicates: report.duplicates,
        },
      };
    } else if (report.added === 0 && report.failed === 0 && report.duplicates > 0) {
      // 全部已存在：幂等成功，不算失败
      warning = {
        code: 'anki_sync_all_duplicates',
        details: { total: validCards.length, duplicates: report.duplicates },
      };
    }

    const success = report.added > 0 || (report.failed === 0 && report.duplicates > 0);
    return { success, importedCount, warning };
  } catch (error: unknown) {
    console.error('[anki] importCardsViaAnkiConnect error:', error);
    return { success: false, importedCount: 0 };
  }
}

/**
 * 记录 Anki 操作日志
 */
export function logChatAnkiEvent(event: string, data?: unknown, _context?: AnkiActionContext): void {
  console.log('[anki]', event, data);
  // 可以在这里添加更多的日志记录逻辑，如发送到后端分析
}

// ============================================================================
// 聊天卡片容器
// ============================================================================

export const FullWidthCardWrapper: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div className={className}>{children}</div>
);

// ============================================================================
// 组件
// ============================================================================

interface AnkiCardStackPreviewProps {
  cards: AnkiCard[];
  status?: AnkiCardStackPreviewStatus;
  templateId?: string;
  /** 已加载的模板对象（向后兼容，单模板 fallback） */
  template?: CustomAnkiTemplate | null;
  /** 多模板映射：templateId → 模板对象（优先使用） */
  templateMap?: Map<string, CustomAnkiTemplate>;
  lastUpdatedAt?: number;
  errorMessage?: string;
  stableId?: string;
  debugContext?: {
    blockId?: string;
    documentId?: string;
  };
  disabled?: boolean;
  onClick?: () => void;
  onCardClick?: (card: AnkiCard, index: number) => void;
  className?: string;
}

/**
 * Anki 卡片叠放预览组件
 *
 * 当 template 可用时，使用 RenderedAnkiCard（ShadowDOM）渲染模板 HTML/CSS；
 * 否则回退到纯文本展示。
 */
export const AnkiCardStackPreview: React.FC<AnkiCardStackPreviewProps> = ({
  cards,
  status = 'idle',
  template,
  templateMap,
  onClick,
  onCardClick,
  className,
  errorMessage,
  debugContext,
  disabled,
}) => {
  const { t } = useTranslation('anki');
  const isError = status === 'error';
  const isCancelled = status === 'cancelled';
  const bannerMessage = isError
    ? errorMessage || t('chatV2.generateFailed')
    : isCancelled
      ? errorMessage || t('chatV2.generateCancelled')
      : null;
  const containerClassName = [
    className,
    disabled ? 'opacity-70 cursor-not-allowed' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const activate = (event: React.KeyboardEvent | React.MouseEvent) => {
    if (disabled || !onClick) return;
    if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
    if ('key' in event) event.preventDefault();
    onClick();
  };

  // 是否使用模板渲染：有 templateMap（多模板）或有单模板且有 front_template
  const hasMultiTemplate = templateMap && templateMap.size > 0;
  const useTemplateRender = hasMultiTemplate || !!(template && template.front_template);

  if (status === 'parsing') {
    return (
      <div
        className={containerClassName}
        onClick={activate}
        onKeyDown={activate}
        role={!disabled && onClick ? 'button' : undefined}
        tabIndex={!disabled && onClick ? 0 : undefined}
      >
        <div className="text-muted-foreground text-sm animate-pulse">{t('chatV2.generating')}</div>
      </div>
    );
  }

  if (cards.length === 0) {
    // 区分"生成完成但没产出卡片"和"还没开始"
    const isReadyButEmpty = status === 'ready' && !isError && !isCancelled;
    return (
      <div
        className={containerClassName}
        onClick={activate}
        onKeyDown={activate}
        role={!disabled && onClick ? 'button' : undefined}
        tabIndex={!disabled && onClick ? 0 : undefined}
      >
        <div
          className={
            isError
              ? 'text-destructive text-sm'
              : isCancelled || isReadyButEmpty
                ? 'text-amber-600 dark:text-amber-400 text-sm'
                : 'text-muted-foreground text-sm'
          }
        >
          {isError
            ? errorMessage || t('chatV2.generateFailed')
            : isCancelled
              ? errorMessage || t('chatV2.generateCancelled')
              : isReadyButEmpty
                ? t('chatV2.empty')
                : t('chatV2.noCards')}
        </div>
      </div>
    );
  }

  return (
    <div className={containerClassName}>
      {bannerMessage && (
        <div
          className={
            isError
              ? 'text-destructive text-sm mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1'
              : 'text-amber-700 dark:text-amber-300 text-sm mb-2 rounded-md border border-amber-400/40 bg-amber-100/60 dark:bg-amber-500/10 px-2 py-1'
          }
        >
          {bannerMessage}
        </div>
      )}
      {/* 3D 卡片预览器 — 聊天内紧凑适配，精确全宽 */}
      {useTemplateRender ? (
        <FullWidthCardWrapper className="chat-card3d-compact">
          <Card3DPreview
            cards={cards}
            template={template ?? undefined}
            templateMap={templateMap}
            debugContext={debugContext}
            onCardClick={onCardClick}
          />
        </FullWidthCardWrapper>
      ) : (
        /* 无模板时的纯文本回退 */
        <div className="space-y-2">
          {cards.slice(0, 5).map((card, index) => (
            <div
              key={card.id || index}
              className={[
                'p-3 border rounded-lg bg-card transition-colors',
                disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--interactive-hover)]',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={(e) => {
                if (disabled) return;
                e.stopPropagation();
                if (onCardClick) onCardClick(card, index);
                else onClick?.();
              }}
              onKeyDown={(e) => {
                if (disabled || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                e.stopPropagation();
                if (onCardClick) onCardClick(card, index);
                else onClick?.();
              }}
              role={!disabled && (onCardClick || onClick) ? 'button' : undefined}
              tabIndex={!disabled && (onCardClick || onClick) ? 0 : undefined}
            >
              <div className="text-sm font-medium truncate">{card.front || t('chatV2.frontContent')}</div>
              <div className="text-xs text-muted-foreground truncate mt-1">{card.back || t('chatV2.backContent')}</div>
            </div>
          ))}
          {cards.length > 5 && (
            <div className="text-xs text-muted-foreground text-center">
              {t('chatV2.moreCards', { count: cards.length - 5 })}
            </div>
          )}
        </div>
      )}
      {/* 底部：总数 + 编辑入口 */}
      <div className="flex items-center justify-between mt-2 gap-2 min-w-0">
        <div className="text-xs text-muted-foreground truncate min-w-0">
          {cards.length > 0 && t('chatV2.totalCards', { count: cards.length })}
          {status === 'stored' && (
            <span className="text-green-600 dark:text-green-400 ml-1 sm:ml-2">{t('chatV2.saved')}</span>
          )}
        </div>
        {cards.length > 0 && !disabled && (
          // 视觉不变（负 margin 抵消 padding），实际命中区扩大满足触控目标
          <NotionButton variant="ghost" size="sm" onClick={onClick} className="!min-h-10 !px-2 text-xs text-muted-foreground hover:text-foreground">
            {t('chatV2.clickToEdit')} →
          </NotionButton>
        )}
      </div>
    </div>
  );
};
