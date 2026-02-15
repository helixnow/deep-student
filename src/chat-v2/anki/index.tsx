/**
 * Chat V2 - Anki 模块
 *
 * 提供 Anki 卡片管理相关的功能和组件
 * 已集成 CardForge 2.0 真实 API
 *
 * ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器
 * 工具定义见 src/mcp/builtinMcpServer.ts（builtin-anki_* 格式）
 */

import React, { useRef, useLayoutEffect, useState, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { save as dialogSave } from '@tauri-apps/plugin-dialog';
import type { AnkiCard, AnkiGenerationOptions, CustomAnkiTemplate } from '@/types';
import { ankiApiAdapter } from '@/services/ankiApiAdapter';
import { RenderedAnkiCard } from '../plugins/blocks/components/RenderedAnkiCard';
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

interface AnkiSyncWarning {
  code: 'anki_sync_partial';
  details: {
    total: number;
    added: number;
    failed: number;
  };
}

/**
 * 保存卡片到本地库
 *
 * 使用 ChatV2AnkiAdapter 导出为 JSON 格式
 */
export async function saveCardsToLibrary(
  params: AnkiActionParams
): Promise<{ success: boolean; savedCount: number; savedIds?: string[]; taskId?: string }> {
  const { cards, context } = params;

  if (cards.length === 0) {
    return { success: true, savedCount: 0 };
  }

  try {
    const result = await ankiApiAdapter.saveAnkiCards({
      cards,
      businessSessionId: context?.businessSessionId ?? null,
      templateId: context?.templateId ?? null,
      options: context?.options,
    });

    if (result.savedIds?.length) {
      console.log('[anki] saveCardsToLibrary success:', result.savedIds.length, 'cards saved');
      return {
        success: true,
        savedCount: result.savedIds.length,
        savedIds: result.savedIds,
        taskId: result.taskId,
      };
    } else {
      console.error('[anki] saveCardsToLibrary error: savedIds empty');
      return { success: false, savedCount: 0, taskId: result.taskId };
    }
  } catch (error: unknown) {
    console.error('[anki] saveCardsToLibrary error:', error);
    return { success: false, savedCount: 0 };
  }
}

/**
 * 导出卡片为 APKG 文件
 *
 * 使用 ChatV2AnkiAdapter 导出
 */
export async function exportCardsAsApkg(
  params: AnkiActionParams & { deckName?: string; noteType?: string }
): Promise<{ success: boolean; filePath?: string }> {
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
    const cardsForExport = cards
      .filter(card => !card.is_error_card)
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

    if (cardsForExport.length === 0) {
      return { success: false };
    }

    const sanitizedDeckName = deckName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'anki-export';
    const selectedPath = await dialogSave({
      defaultPath: `${sanitizedDeckName}.apkg`,
      filters: [{ name: 'APKG', extensions: ['apkg'] }],
    });

    if (!selectedPath) {
      return { success: false };
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
      return { success: true, filePath };
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
      .filter(c => !c.is_error_card)
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
    const results = await invoke<Array<number | null>>('add_cards_to_anki_connect', {
      selectedCards: validCards,
      deckName,
      noteType,
    });

    const importedCount = Array.isArray(results) ? results.filter(r => r !== null).length : 0;
    const failed = validCards.length - importedCount;
    const warning =
      importedCount > 0 && failed > 0
        ? {
            code: 'anki_sync_partial' as const,
            details: { total: validCards.length, added: importedCount, failed },
          }
        : undefined;

    return { success: importedCount > 0, importedCount, warning };
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
// 事件派发
// ============================================================================

interface OpenAnkiPanelParams {
  blockId?: string;
  messageId?: string;
  businessSessionId?: string;
  cards?: AnkiCard[];
}

/**
 * 派发打开 Anki 面板的事件
 */
export function dispatchOpenAnkiPanelEvent(params: OpenAnkiPanelParams): void {
  const event = new CustomEvent('open-anki-panel', { detail: params });
  window.dispatchEvent(event);
}

// ============================================================================
// 全宽包裹器：精确计算偏移实现真正的视口全宽
// ============================================================================

/**
 * 全宽卡片包裹器
 *
 * 使用 getBoundingClientRect 动态计算元素距视口左侧的精确偏移，
 * 通过负 margin 突破所有父容器（含头像、padding、max-width）限制，
 * 实现真正的 100vw 全宽。解决 `calc(-50vw + 50%)` 在非居中父容器下
 * 偏移不准的问题。
 */
/**
 * 移动端全宽精确包裹器
 *
 * 桌面端（>768px）：不做任何处理，直接渲染 children + className，
 * 保持原有 CSS 布局（如 calc(-50vw + 50%) 等）。
 *
 * 移动端（≤768px）：使用 getBoundingClientRect 精确计算元素距视口
 * 左侧的偏移，通过 inline style 突破所有父容器限制实现真正全宽。
 * 解决移动端头像/padding 导致 CSS calc 偏移不准的问题。
 */
const MOBILE_BREAKPOINT = 768;

export const FullWidthCardWrapper: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [mobileStyle, setMobileStyle] = useState<React.CSSProperties | undefined>(undefined);

  const recalculate = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;

    // 桌面端：清除所有 inline 定位，完全交给 CSS
    if (window.innerWidth > MOBILE_BREAKPOINT) {
      if (el.style.width || el.style.marginLeft) {
        el.style.width = '';
        el.style.marginLeft = '';
        setMobileStyle(undefined);
      }
      return;
    }

    // 移动端：精确计算偏移
    // 临时清除 inline 定位，回到自然位置以获得真实偏移
    el.style.width = '';
    el.style.marginLeft = '';

    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const newLeft = rect.left;

    el.style.width = `${viewportWidth}px`;
    el.style.marginLeft = `-${newLeft}px`;

    setMobileStyle({
      width: `${viewportWidth}px`,
      marginLeft: `-${newLeft}px`,
      position: 'relative',
    });
  }, []);

  useLayoutEffect(() => {
    recalculate();
    window.addEventListener('resize', recalculate);
    return () => window.removeEventListener('resize', recalculate);
  }, [recalculate]);

  // 监听父容器尺寸变化（侧边栏展开/收起等）
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el?.parentElement) return;
    const ro = new ResizeObserver(() => recalculate());
    ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [recalculate]);

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={mobileStyle}
    >
      {children}
    </div>
  );
};

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

  // 是否使用模板渲染：有 templateMap（多模板）或有单模板且有 front_template
  const hasMultiTemplate = templateMap && templateMap.size > 0;
  const useTemplateRender = hasMultiTemplate || !!(template && template.front_template);

  if (status === 'parsing') {
    return (
      <div className={containerClassName} onClick={disabled ? undefined : onClick}>
        <div className="text-muted-foreground text-sm animate-pulse">{t('chatV2.generating')}</div>
      </div>
    );
  }

  if (cards.length === 0) {
    // 区分"生成完成但没产出卡片"和"还没开始"
    const isReadyButEmpty = status === 'ready' && !isError && !isCancelled;
    return (
      <div className={containerClassName} onClick={disabled ? undefined : onClick}>
        <div
          className={
            isError
              ? 'text-destructive text-sm'
              : isCancelled
                ? 'text-amber-600 text-sm'
                : isReadyButEmpty
                  ? 'text-amber-600 text-sm'
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
              : 'text-amber-700 text-sm mb-2 rounded-md border border-amber-400/40 bg-amber-100/60 px-2 py-1'
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
            template={template as any}
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
                disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent/50',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={(e) => {
                if (disabled) return;
                e.stopPropagation();
                onCardClick?.(card, index);
              }}
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
        <div className="text-[10px] sm:text-[11px] text-muted-foreground/50 truncate min-w-0">
          {cards.length > 0 && t('chatV2.totalCards', { count: cards.length })}
          {status === 'stored' && (
            <span className="text-green-600 ml-1 sm:ml-2">{t('chatV2.saved')}</span>
          )}
        </div>
        {cards.length > 0 && !disabled && (
          <NotionButton variant="ghost" size="sm" onClick={onClick} className="!h-auto !p-0 text-[10px] sm:text-[11px] text-muted-foreground/50 hover:text-muted-foreground">
            {t('chatV2.clickToEdit')} →
          </NotionButton>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Chat V2 面板桥接组件（CardForge 2.0 集成）
// ============================================================================

export { useAnkiPanelV2Bridge } from '../hooks/useAnkiPanelV2Bridge';
export { AnkiPanelHost } from '../components/AnkiPanelHost';
export type { OpenAnkiPanelParams, AnkiPanelState } from '../hooks/useAnkiPanelV2Bridge';
