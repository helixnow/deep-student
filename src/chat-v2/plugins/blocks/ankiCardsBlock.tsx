/**
 * Chat V2 - Anki 卡片块渲染插件
 *
 * 架构设计：
 * - 折叠态：显示前 3 张卡片预览（紧凑模式）
 * - 展开态：内联展示所有卡片，点击单张卡片可展开编辑
 * - 复用 chatAnkiActions 实现保存/导出/同步操作
 *
 * 自执行注册：import 即注册
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  Loader2,
  Save,
  Download,
  Send,
  Edit3,
  Check,
  X,
  ChevronUp,
  Trash2,
} from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 复用 Chat V2 本地 Anki 管线
// ============================================================================
import {
  saveCardsToLibrary,
  exportCardsAsApkg,
  importCardsViaAnkiConnect,
  logChatAnkiEvent,
  AnkiCardStackPreview,
  FullWidthCardWrapper,
  type AnkiCardStackPreviewStatus,
} from '../../anki';
import type { AnkiCard, AnkiGenerationOptions, CustomAnkiTemplate } from '@/types';
import { ChatAnkiProgressCompact } from './components/ChatAnkiProgressCompact';
import { RenderedAnkiCard } from './components/RenderedAnkiCard';
import { useTemplateLoader } from '../../hooks/useTemplateLoader';
import { useMultiTemplateLoader } from '../../hooks/useMultiTemplateLoader';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Anki 卡片块数据（从后端事件传递）
 */
export interface AnkiCardsWarning {
  code: string;
  messageKey?: string;
  messageParams?: Record<string, unknown>;
  message?: string;
}

export interface AnkiCardsBlockData {
  /** 卡片列表 */
  cards: AnkiCard[];
  /** 后端 documentId（用于 status 查询/调试） */
  documentId?: string;
  /** 生成进度（后台流水线 patch 更新） */
  progress?: {
    stage?: string;
    message?: string;
    messageKey?: string;
    messageParams?: Record<string, unknown>;
    cardsGenerated?: number;
    completedRatio?: number;
    counts?: unknown;
    lastUpdatedAt?: string;
    route?: string;
  };
  /** AnkiConnect 可用性（后台流水线 patch 更新） */
  ankiConnect?: {
    available?: boolean | null;
    error?: string | null;
    checkedAt?: string;
  };
  /** 同步状态 */
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error';
  /** 同步错误 */
  syncError?: string;
  /** 模板 ID */
  templateId?: string;
  /** 多模板模式下模板 ID 列表 */
  templateIds?: string[];
  /** 模板选择模式：single / multiple / all */
  templateMode?: string;
  /** 生成选项 */
  options?: AnkiGenerationOptions;
  /** 关联的消息稳定 ID */
  messageStableId?: string;
  /** 业务会话 ID */
  businessSessionId?: string;
  /** 后端最终状态（用于 UI 显示） */
  finalStatus?: string;
  /** 后端错误信息（用于 UI 显示） */
  finalError?: string;
  /** 后端警告信息（用于 UI 显示） */
  warnings?: AnkiCardsWarning[];
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isTemplateCompatibleWithCard(
  card: AnkiCard,
  template: CustomAnkiTemplate | null | undefined,
): boolean {
  if (!template) return false;
  const requiredKeys = Object.entries(template.field_extraction_rules ?? {})
    .filter(([, rule]) => Boolean(rule?.is_required))
    .map(([key]) => key.toLowerCase());
  if (requiredKeys.length === 0) return true;

  const fields = (card.fields ?? {}) as Record<string, unknown>;
  const extraFields = (card.extra_fields ?? {}) as Record<string, unknown>;
  const values = new Map<string, unknown>();

  const pushEntries = (source: Record<string, unknown>) => {
    Object.entries(source).forEach(([key, value]) => {
      values.set(key.toLowerCase(), value);
    });
  };

  pushEntries(fields);
  pushEntries(extraFields);

  if (!values.has('front')) values.set('front', card.front);
  if (!values.has('back')) values.set('back', card.back);
  if (!values.has('text')) values.set('text', card.text);

  return requiredKeys.every((key) => hasValue(values.get(key)));
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, val]) => {
    if (typeof val === 'string') {
      acc[key] = val;
      return acc;
    }
    if (val === null || val === undefined) {
      acc[key] = '';
      return acc;
    }
    acc[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return acc;
  }, {});
}

function tryParseFrontAsFields(front: string | undefined): Record<string, string> {
  if (!front) return {};
  const trimmed = front.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value === null || value === undefined) {
        acc[key] = '';
      } else if (typeof value === 'string') {
        acc[key] = value;
      } else {
        acc[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function getCaseInsensitiveValue(record: Record<string, string>, key: string): string | undefined {
  if (key in record) return record[key];
  const lower = key.toLowerCase();
  const matchedKey = Object.keys(record).find((item) => item.toLowerCase() === lower);
  if (!matchedKey) return undefined;
  return record[matchedKey];
}

function setCaseInsensitiveValue(record: Record<string, string>, key: string, value: string): void {
  if (key in record) {
    record[key] = value;
    return;
  }
  const lower = key.toLowerCase();
  const matchedKey = Object.keys(record).find((item) => item.toLowerCase() === lower);
  if (matchedKey) {
    record[matchedKey] = value;
    return;
  }
  record[key] = value;
}

function resolveSpecialFieldFallback(card: AnkiCard, key: string): string {
  const lower = key.toLowerCase();
  if (lower === 'front' || lower === '正面') return card.front ?? '';
  if (lower === 'back' || lower === '背面') return card.back ?? '';
  if (lower === 'text') return card.text ?? '';
  return '';
}

function resolveEditableFields(
  card: AnkiCard,
  template: CustomAnkiTemplate | null | undefined,
): { fieldOrder: string[]; values: Record<string, string> } {
  const fieldRecord = toStringRecord(card.fields);
  const extraFieldRecord = toStringRecord(card.extra_fields);
  const parsedFrontRecord = tryParseFrontAsFields(card.front);

  const templateFields = (template?.fields ?? []).filter(Boolean);
  const fallbackFieldOrder = ['Front', 'Back'];
  const candidates = [
    ...templateFields,
    ...Object.keys(fieldRecord),
    ...Object.keys(extraFieldRecord),
    ...Object.keys(parsedFrontRecord),
  ];
  const ordered = (candidates.length > 0 ? candidates : fallbackFieldOrder).filter((field, index, arr) => {
    if (!field) return false;
    const lower = field.toLowerCase();
    return arr.findIndex((item) => item.toLowerCase() === lower) === index;
  });

  const values = ordered.reduce<Record<string, string>>((acc, key) => {
    const fromFields = getCaseInsensitiveValue(fieldRecord, key);
    if (fromFields !== undefined) {
      acc[key] = fromFields;
      return acc;
    }
    const fromExtraFields = getCaseInsensitiveValue(extraFieldRecord, key);
    if (fromExtraFields !== undefined) {
      acc[key] = fromExtraFields;
      return acc;
    }
    const fromParsedFront = getCaseInsensitiveValue(parsedFrontRecord, key);
    if (fromParsedFront !== undefined) {
      acc[key] = fromParsedFront;
      return acc;
    }
    acc[key] = resolveSpecialFieldFallback(card, key);
    return acc;
  }, {});

  return { fieldOrder: ordered, values };
}

// ============================================================================
// 状态映射函数
// ============================================================================

function mapBlockStatusToPreviewStatus(
  blockStatus: string,
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error',
  hasCards?: boolean,
  finalStatus?: string
): AnkiCardStackPreviewStatus {
  const normalizedFinalStatus =
    typeof finalStatus === 'string' ? finalStatus.toLowerCase() : undefined;
  const isCancelled =
    normalizedFinalStatus === 'cancelled' ||
    normalizedFinalStatus === 'canceled';
  const isFailed =
    normalizedFinalStatus === 'error' || normalizedFinalStatus === 'failed';

  if (isCancelled) return 'cancelled';
  if (isFailed) return 'error';
  if (syncStatus === 'synced') return 'stored';

  switch (blockStatus) {
    case 'pending':
      return 'parsing';
    case 'running':
      return hasCards ? 'ready' : 'parsing';
    case 'success':
      return syncStatus === 'error' ? 'error' : 'ready';
    case 'error':
      return 'error';
    default:
      return 'ready';
  }
}

// ============================================================================
// 子组件：内联可编辑卡片项
// ============================================================================

interface InlineCardItemProps {
  card: AnkiCard;
  index: number;
  isEditing: boolean;
  /** 已加载的模板（向后兼容 fallback） */
  template?: CustomAnkiTemplate | null;
  /** 多模板映射（优先根据 card.template_id 解析） */
  templateMap?: Map<string, CustomAnkiTemplate>;
  onToggleEdit: (index: number) => void;
  onSave: (index: number, updated: AnkiCard) => void;
  onDelete: (index: number) => void;
  disabled?: boolean;
}

const InlineCardItem: React.FC<InlineCardItemProps> = ({
  card,
  index,
  isEditing,
  template,
  templateMap,
  onToggleEdit,
  onSave,
  onDelete,
  disabled,
}) => {
  const { t } = useTranslation('anki');
  // 多模板解析：优先从 templateMap 中按卡片的 template_id 查找
  const resolvedTemplate = useMemo(() => {
    if (templateMap && card.template_id) {
      const found = templateMap.get(card.template_id);
      if (found) return found;
    }
    return template ?? null;
  }, [templateMap, card.template_id, template]);
  const useTemplateRender = !!(resolvedTemplate && resolvedTemplate.front_template);

  const [editFieldOrder, setEditFieldOrder] = useState<string[]>([]);
  const [editFieldValues, setEditFieldValues] = useState<Record<string, string>>({});
  const [editTags, setEditTags] = useState((card.tags ?? []).join(', '));
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);

  // 当进入编辑模式时重置编辑值并聚焦
  useEffect(() => {
    if (isEditing) {
      const editableFields = resolveEditableFields(card, resolvedTemplate);
      setEditFieldOrder(editableFields.fieldOrder);
      setEditFieldValues(editableFields.values);
      setEditTags((card.tags ?? []).join(', '));
      // 延迟聚焦，等待 DOM 渲染完成
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [isEditing, card, resolvedTemplate]);

  const handleSave = useCallback(() => {
    const tags = editTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const nextFields = toStringRecord(card.fields);
    const nextExtraFields = toStringRecord(card.extra_fields);
    let nextFront = card.front ?? '';
    let nextBack = card.back ?? '';
    let nextText = card.text ?? '';

    editFieldOrder.forEach((field) => {
      const value = editFieldValues[field] ?? '';
      const normalized = field.toLowerCase();
      if (normalized === 'front' || normalized === '正面') nextFront = value;
      if (normalized === 'back' || normalized === '背面') nextBack = value;
      if (normalized === 'text') nextText = value;
      setCaseInsensitiveValue(nextFields, field, value);
      setCaseInsensitiveValue(nextExtraFields, field, value);
    });

    onSave(index, {
      ...card,
      front: nextFront,
      back: nextBack,
      text: nextText,
      fields: nextFields,
      extra_fields: nextExtraFields,
      tags,
    });
  }, [card, editFieldOrder, editFieldValues, editTags, index, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onToggleEdit(index);
      }
    },
    [handleSave, index, onToggleEdit]
  );

  const handleFieldChange = useCallback((field: string, value: string) => {
    setEditFieldValues((prev) => ({
      ...prev,
      [field]: value,
    }));
  }, []);

  const resolveFieldLabel = useCallback((field: string) => {
    const normalized = field.toLowerCase();
    if (normalized === 'front' || normalized === '正面') return t('chatV2.front');
    if (normalized === 'back' || normalized === '背面') return t('chatV2.back');
    if (normalized === 'text') return field;
    return field;
  }, [t]);

  const front = card.front ?? card.fields?.Front ?? '';
  const back = card.back ?? card.fields?.Back ?? '';

  if (isEditing) {
    return (
      <div className="border rounded-lg bg-card overflow-hidden animate-in fade-in-0 slide-in-from-top-1 duration-200">
        {/* 编辑头部 */}
        <div className="flex items-center justify-between px-3 py-2 bg-accent/30 border-b">
          <span className="text-xs font-medium text-muted-foreground">
            #{index + 1}
          </span>
          <div className="flex items-center gap-1">
            <NotionButton
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onDelete(index)}
              className="text-destructive hover:text-destructive h-7 px-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </NotionButton>
          </div>
        </div>
        {/* 编辑内容 */}
        <div className="p-3 space-y-3">
          {editFieldOrder.map((field, idx) => (
            <div key={field}>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {resolveFieldLabel(field)}
              </label>
              <textarea
                ref={idx === 0 ? firstFieldRef : undefined}
                value={editFieldValues[field] ?? ''}
                onChange={(e) => handleFieldChange(field, e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full min-h-[60px] p-2 text-sm rounded-md border bg-background resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={resolveFieldLabel(field)}
              />
            </div>
          ))}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t('chatV2.tags')}
            </label>
            <input
              type="text"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full p-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t('enter_tags_comma_separated')}
            />
          </div>
          {/* 操作按钮 */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="text-xs text-muted-foreground mr-auto">
              ⌘+Enter {t('chatV2.saveEdit')} · Esc {t('chatV2.cancelEdit')}
            </span>
            <NotionButton
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onToggleEdit(index)}
            >
              {t('chatV2.cancelEdit')}
            </NotionButton>
            <NotionButton
              type="button"
              size="sm"
              variant="primary"
              onClick={handleSave}
            >
              <Check className="w-3.5 h-3.5" />
              {t('chatV2.saveEdit')}
            </NotionButton>
          </div>
        </div>
      </div>
    );
  }

  // 折叠态：卡片预览（可点击展开编辑）
  // 有模板时使用 ShadowDOM 渲染模板 HTML/CSS；否则纯文本
  if (useTemplateRender) {
    return (
      <div
        className={[
          'group relative transition-all duration-150',
          disabled
            ? 'opacity-70 cursor-not-allowed'
            : 'cursor-pointer',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* 序号标签 */}
        <div className="absolute top-2 left-2 z-10 w-5 h-5 rounded-full bg-background/80 backdrop-blur flex items-center justify-center text-[10px] font-medium text-muted-foreground border">
          {index + 1}
        </div>
        {/* 编辑按钮 */}
        {!disabled && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onToggleEdit(index); }} className="absolute top-2 right-2 z-10 !w-6 !h-6 bg-background/80 backdrop-blur opacity-0 group-hover:opacity-100 focus-visible:opacity-100 border hover:bg-accent" aria-label="edit">
            <Edit3 className="w-3 h-3 text-muted-foreground" />
          </NotionButton>
        )}
        {/* 模板渲染预览 */}
        <RenderedAnkiCard
          card={card}
          template={resolvedTemplate!}
          flippable={!disabled}
          compact
        />
        {/* 标签 */}
        {card.tags && card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 px-3 pb-2 -mt-1">
            {card.tags.slice(0, 4).map((tag, i) => (
              <span key={i} className="px-1.5 py-0.5 text-[10px] bg-muted rounded">
                {tag}
              </span>
            ))}
            {card.tags.length > 4 && (
              <span className="text-[10px] text-muted-foreground">+{card.tags.length - 4}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  // 纯文本回退
  return (
    <div
      className={[
        'group border rounded-lg bg-card transition-all duration-150',
        disabled
          ? 'opacity-70 cursor-not-allowed'
          : 'cursor-pointer hover:bg-accent/40 hover:border-accent-foreground/20',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={disabled ? undefined : () => onToggleEdit(index)}
    >
      <div className="flex items-start gap-3 p-3">
        {/* 序号 */}
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground mt-0.5">
          {index + 1}
        </span>
        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {front || <span className="text-muted-foreground italic">{t('chatV2.noContent')}</span>}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {back || <span className="italic">{t('chatV2.noContent')}</span>}
          </div>
          {card.tags && card.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {card.tags.slice(0, 4).map((tag, i) => (
                <span key={i} className="px-1.5 py-0.5 text-[10px] bg-muted rounded">
                  {tag}
                </span>
              ))}
              {card.tags.length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{card.tags.length - 4}</span>
              )}
            </div>
          )}
        </div>
        {/* 编辑提示 */}
        {!disabled && (
          <Edit3 className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1" />
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 子组件：操作按钮组
// ============================================================================

/** 操作状态类型 */
type ActionStatus = 'idle' | 'loading' | 'success' | 'error';

const ActionButtons: React.FC<{
  cards: AnkiCard[];
  data: AnkiCardsBlockData | undefined;
  blockStatus: string;
  isStreaming?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
}> = ({ cards, data, blockStatus, isStreaming, isExpanded, onToggleExpand }) => {
  const { t } = useTranslation('chatV2');
  const [saveStatus, setSaveStatus] = useState<ActionStatus>('idle');
  const [exportStatus, setExportStatus] = useState<ActionStatus>('idle');
  const [syncStatus, setSyncStatus] = useState<ActionStatus>('idle');

  const timeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach((id) => clearTimeout(id));
      timeoutRefs.current.clear();
    };
  }, []);

  const context = useMemo(
    () => ({
      businessSessionId: data?.businessSessionId ?? null,
      templateId: data?.templateId ?? null,
      options: data?.options,
    }),
    [data]
  );

  const resetStatusAfterDelay = useCallback(
    (setter: React.Dispatch<React.SetStateAction<ActionStatus>>) => {
      const timeoutId = setTimeout(() => {
        setter('idle');
        timeoutRefs.current.delete(timeoutId);
      }, 2000);
      timeoutRefs.current.add(timeoutId);
    },
    []
  );

  const handleSave = useCallback(async () => {
    if (cards.length === 0 || saveStatus === 'loading') return;
    setSaveStatus('loading');
    try {
      const result = await saveCardsToLibrary({ cards, context });
      if (!result.success) throw new Error(t('blocks.ankiCards.action.saveFailed'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'save', cardCount: cards.length }, context);
      setSaveStatus('success');
      showGlobalNotification('success', t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount }));
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Save failed:', msg);
      setSaveStatus('error');
      showGlobalNotification('error', t('blocks.ankiCards.action.saveFailedWithHint'), msg);
    }
    resetStatusAfterDelay(setSaveStatus);
  }, [cards, context, saveStatus, resetStatusAfterDelay, t]);

  const handleExport = useCallback(async () => {
    if (cards.length === 0 || exportStatus === 'loading') return;
    setExportStatus('loading');
    // 统计多模板信息
    const templateIds = [...new Set(cards.map(c => c.template_id).filter(Boolean))];
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'info', phase: 'export:apkg',
        summary: `Export started | ${cards.length} cards | ${templateIds.length} templates: ${templateIds.join(', ') || 'null'}`,
        detail: { cardsCount: cards.length, templateIds },
      }}));
    } catch { /* */ }
    try {
      const result = await exportCardsAsApkg({ cards, context });
      if (!result.success || !result.filePath) throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'export', cardCount: cards.length }, context);
      setExportStatus('success');
      showGlobalNotification('success', t('blocks.ankiCards.action.apkgExportedWithHint'), result.filePath);
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'info', phase: 'export:apkg',
          summary: `Export success → ${result.filePath}`,
          detail: { filePath: result.filePath },
        }}));
      } catch { /* */ }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Export failed:', msg);
      setExportStatus('error');
      showGlobalNotification('error', t('blocks.ankiCards.action.exportFailedWithHint'), msg);
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'error', phase: 'export:apkg',
          summary: `Export FAILED: ${msg}`,
          detail: { error: msg },
        }}));
      } catch { /* */ }
    }
    resetStatusAfterDelay(setExportStatus);
  }, [cards, context, exportStatus, resetStatusAfterDelay, t]);

  const handleSync = useCallback(async () => {
    if (cards.length === 0 || syncStatus === 'loading') return;
    setSyncStatus('loading');
    try {
      const result = await importCardsViaAnkiConnect({ cards, context });
      if (!result.success) throw new Error(t('blocks.ankiCards.action.syncFailedDetail'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'import', cardCount: cards.length }, context);
      setSyncStatus('success');
      if (result.warning?.code === 'anki_sync_partial') {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.syncPartialTitle'),
          t('blocks.ankiCards.action.syncPartialDetail', {
            added: result.warning.details.added,
            failed: result.warning.details.failed,
          })
        );
      } else {
        showGlobalNotification('success', t('blocks.ankiCards.action.syncedCountWithHint', { count: result.importedCount }));
      }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Sync failed:', msg);
      setSyncStatus('error');
      showGlobalNotification('error', t('blocks.ankiCards.action.syncFailedWithHint'), msg);
    }
    resetStatusAfterDelay(setSyncStatus);
  }, [cards, context, syncStatus, resetStatusAfterDelay, t]);

  const isBlockBusy = blockStatus === 'pending' || blockStatus === 'running';
  const isDisabled = cards.length === 0 || isStreaming || isBlockBusy;
  const isAnkiConnectAvailable = data?.ankiConnect?.available === true;
  const syncDisabledReason = !isAnkiConnectAvailable
    ? t(
        `blocks.ankiCards.progress.ankiConnect.${
          data?.ankiConnect?.available === false ? 'notConnected' : 'checking'
        }` as const
      )
    : undefined;

  const renderIcon = (status: ActionStatus, DefaultIcon: React.ComponentType<{ className?: string }>) => {
    switch (status) {
      case 'loading':
        return <Loader2 className="w-4 h-4 animate-spin" />;
      case 'success':
        return <Check className="w-4 h-4 text-emerald-500" />;
      case 'error':
        return <X className="w-4 h-4 text-destructive" />;
      default:
        return <DefaultIcon className="w-4 h-4" />;
    }
  };

  return (
    <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 mt-3 pt-3 border-t border-border/50">
      {/* 内联展开/折叠编辑 */}
      <NotionButton
        type="button"
        onClick={onToggleExpand}
        disabled={isDisabled}
        variant={isExpanded ? 'default' : 'primary'}
        className="text-xs sm:text-sm"
      >
        {isExpanded ? <ChevronUp className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Edit3 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
        {isExpanded ? t('blocks.ankiCards.collapse') : t('blocks.ankiCards.edit')}
      </NotionButton>

      {/* 保存到库 */}
      <NotionButton
        type="button"
        onClick={handleSave}
        disabled={isDisabled || saveStatus === 'loading'}
        variant={saveStatus === 'success' ? 'success' : saveStatus === 'error' ? 'danger' : 'default'}
        className="text-xs sm:text-sm"
      >
        {renderIcon(saveStatus, Save)}
        {t('blocks.ankiCards.save')}
      </NotionButton>

      {/* 导出 APKG */}
      <NotionButton
        type="button"
        onClick={handleExport}
        disabled={isDisabled || exportStatus === 'loading'}
        variant={exportStatus === 'success' ? 'success' : exportStatus === 'error' ? 'danger' : 'default'}
        className="text-xs sm:text-sm"
      >
        {renderIcon(exportStatus, Download)}
        {t('blocks.ankiCards.export')}
      </NotionButton>

      {/* 同步到 Anki */}
      <NotionButton
        type="button"
        onClick={handleSync}
        disabled={isDisabled || syncStatus === 'loading' || !isAnkiConnectAvailable}
        title={syncDisabledReason}
        variant={syncStatus === 'success' ? 'success' : syncStatus === 'error' ? 'danger' : 'default'}
        className="text-xs sm:text-sm"
      >
        {renderIcon(syncStatus, Send)}
        {t('blocks.ankiCards.sync')}
      </NotionButton>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * Anki 卡片块组件
 *
 * 支持两种模式：
 * 1. 折叠态：预览前 3 张卡片
 * 2. 展开态：内联展示所有卡片，点击可编辑
 */
const AnkiCardsBlock: React.FC<BlockComponentProps> = React.memo(({
  block,
  isStreaming,
  store,
}) => {
  const { t } = useTranslation('chatV2');
  const data = block.toolOutput as AnkiCardsBlockData | undefined;
  const cards = data?.cards || [];
  const isBlockBusy = block.status === 'pending' || block.status === 'running';
  const isActionDisabled = isBlockBusy || Boolean(isStreaming);

  // ChatAnki Workflow Debug: 记录 block 状态变化
  const prevStatusRef = useRef(block.status);
  const prevCardsLenRef = useRef(cards.length);
  useEffect(() => {
    const statusChanged = prevStatusRef.current !== block.status;
    const cardsChanged = prevCardsLenRef.current !== cards.length;
    if (statusChanged || cardsChanged) {
      const fingerprints = cards.map((card) =>
        `${card.front ?? card.fields?.Front ?? ''}||${card.back ?? card.fields?.Back ?? ''}`.trim(),
      );
      let adjacentDuplicatePairs = 0;
      for (let i = 1; i < fingerprints.length; i += 1) {
        if (fingerprints[i] && fingerprints[i] === fingerprints[i - 1]) {
          adjacentDuplicatePairs += 1;
        }
      }
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
          detail: {
            level: statusChanged && block.status === 'error' ? 'error' : 'info',
            phase: 'block:state',
            summary: `status=${block.status} cards=${cards.length} docId=${data?.documentId ?? 'null'} dupAdjacent=${adjacentDuplicatePairs}`,
            detail: {
              blockId: block.id,
              status: block.status,
              prevStatus: prevStatusRef.current,
              cardsCount: cards.length,
              prevCardsCount: prevCardsLenRef.current,
              documentId: data?.documentId,
              templateId: data?.templateId,
              templateIds: data?.templateIds,
              templateMode: data?.templateMode,
              adjacentDuplicatePairs,
              progress: data?.progress,
            },
            documentId: data?.documentId,
            blockId: block.id,
          },
        }));
      } catch { /* debug plugin not available */ }
      prevStatusRef.current = block.status;
      prevCardsLenRef.current = cards.length;
    }
  }, [block.status, cards, cards.length, block.id, data?.documentId, data?.templateId, data?.templateIds, data?.templateMode, data?.progress]);

  // 多模板支持：从卡片数组中提取所有唯一的 template_id，批量加载
  const allTemplateIds = useMemo(() => {
    const ids = new Set<string>();
    if (data?.templateId) ids.add(data.templateId);
    (data?.templateIds ?? []).forEach((id) => {
      if (id) ids.add(id);
    });
    cards.forEach((c) => { if (c.template_id) ids.add(c.template_id); });
    return [...ids];
  }, [cards, data?.templateId, data?.templateIds]);

  const { templateMap } = useMultiTemplateLoader(allTemplateIds);
  useEffect(() => {
    if (cards.length === 0) return;
    const unresolvedTemplateCards = cards.filter(
      (card) => Boolean(card.template_id) && !templateMap.has(card.template_id as string),
    ).length;
    const incompatibleTemplateCards = cards.filter((card) => {
      const resolvedTemplate = (() => {
        if (card.template_id && templateMap.has(card.template_id)) {
          return templateMap.get(card.template_id) ?? null;
        }
        if (data?.templateId && templateMap.has(data.templateId)) {
          return templateMap.get(data.templateId) ?? null;
        }
        if (templateMap.size === 1) {
          return [...templateMap.values()][0];
        }
        return null;
      })();
      return Boolean(resolvedTemplate) && !isTemplateCompatibleWithCard(card, resolvedTemplate);
    }).length;
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
        detail: {
          level: unresolvedTemplateCards > 0 || incompatibleTemplateCards > 0 ? 'warn' : 'debug',
          phase: 'render:stack',
          summary: `renderer templates resolved=${templateMap.size}/${allTemplateIds.length} unresolvedCards=${unresolvedTemplateCards} incompatibleCards=${incompatibleTemplateCards}`,
          detail: {
            blockId: block.id,
            documentId: data?.documentId,
            cards: cards.length,
            allTemplateIds,
            unresolvedTemplateCards,
            incompatibleTemplateCards,
          },
          documentId: data?.documentId,
          blockId: block.id,
        },
      }));
    } catch { /* debug plugin not available */ }
  }, [templateMap, allTemplateIds, cards, block.id, data?.documentId, data?.templateId]);

  // 向后兼容：提取单模板 fallback（用于 InlineCardItem 等还需要单 template 的场景）
  const template = useMemo(() => {
    if (data?.templateId && templateMap.has(data.templateId)) {
      return templateMap.get(data.templateId) ?? null;
    }
    // 如果只有一个模板，直接用它
    if (templateMap.size === 1) {
      return [...templateMap.values()][0];
    }
    return null;
  }, [templateMap, data?.templateId]);

  // 展开/折叠状态
  const [isExpanded, setIsExpanded] = useState(false);
  // 当前正在编辑的卡片索引（-1 表示无）
  const [editingIndex, setEditingIndex] = useState(-1);
  // 展开态卡片列表末尾的 ref（用于自动滚动到新卡片）
  const cardsEndRef = useRef<HTMLDivElement>(null);
  // 记录上次卡片数量，仅在增长时滚动
  const prevCardsCountRef = useRef(0);

  const hasProgress = useMemo(() => {
    if (!data?.progress) return false;
    if (typeof data.progress.completedRatio === 'number') return true;
    if (typeof data.progress.stage === 'string' && data.progress.stage.trim()) return true;
    if (typeof data.progress.message === 'string' && data.progress.message.trim()) return true;
    if (typeof data.progress.messageKey === 'string' && data.progress.messageKey.trim()) return true;
    if (typeof data.progress.cardsGenerated === 'number') return true;
    if (typeof data.progress.route === 'string' && data.progress.route.trim()) return true;
    if (data.progress.counts && typeof data.progress.counts === 'object') return true;
    return false;
  }, [data?.progress]);

  const hasAnkiConnect = useMemo(() => {
    if (!data?.ankiConnect) return false;
    if (typeof data.ankiConnect.available === 'boolean') return true;
    if (typeof data.ankiConnect.error === 'string' && data.ankiConnect.error.trim()) return true;
    if (typeof data.ankiConnect.checkedAt === 'string') return true;
    return false;
  }, [data?.ankiConnect]);

  const shouldShowChatAnkiProgress = hasProgress || hasAnkiConnect;

  // 展开态：新卡片到来时自动滚动到底部（仅在卡片数量增长时触发）
  useEffect(() => {
    if (isExpanded && cards.length > prevCardsCountRef.current && editingIndex < 0) {
      cardsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    prevCardsCountRef.current = cards.length;
  }, [isExpanded, cards.length, editingIndex]);

  // 切换展开/折叠
  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
    setEditingIndex(-1);
  }, []);

  // 切换卡片编辑模式
  const handleToggleEdit = useCallback((index: number) => {
    setEditingIndex((prev) => (prev === index ? -1 : index));
  }, []);

  // 🔧 场景8修复：将编辑后的 toolOutput 持久化到数据库
  // 防止后续 pipeline 重保存消息时丢失用户编辑
  const persistToolOutput = useCallback(
    (newData: AnkiCardsBlockData) => {
      invoke('chat_v2_update_block_tool_output', {
        blockId: block.id,
        toolOutputJson: JSON.stringify(newData),
      }).catch((err) => {
        console.warn('[AnkiCardsBlock] Failed to persist tool_output:', err);
      });
    },
    [block.id]
  );

  // 保存卡片编辑
  const handleSaveCard = useCallback(
    (index: number, updated: AnkiCard) => {
      if (!data || !store) return;
      const newCards = [...cards];
      newCards[index] = updated;
      const newData = { ...data, cards: newCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      persistToolOutput(newData);
      setEditingIndex(-1);
      logChatAnkiEvent('chat_anki_card_edited', { index, blockId: block.id });
    },
    [cards, data, store, block.id, persistToolOutput]
  );

  // 删除卡片
  // 🔧 修复：删除非编辑中的卡片时，正确调整 editingIndex 避免偏移到错误卡片
  const handleDeleteCard = useCallback(
    (index: number) => {
      if (!data || !store) return;
      const newCards = cards.filter((_, i) => i !== index);
      const newData = { ...data, cards: newCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      persistToolOutput(newData);
      setEditingIndex((prev) => {
        if (prev === index) return -1;
        if (prev > index) return prev - 1;
        return prev;
      });
      logChatAnkiEvent('chat_anki_card_deleted', { index, blockId: block.id });
    },
    [cards, data, store, block.id, persistToolOutput]
  );

  // 计算预览状态
  const previewStatus = useMemo(() => {
    return mapBlockStatusToPreviewStatus(
      block.status,
      data?.syncStatus,
      cards.length > 0,
      data?.finalStatus
    );
  }, [block.status, data?.syncStatus, data?.finalStatus, cards.length]);

  const resolveChatAnkiError = useCallback(
    (error?: string | null) => {
      if (!error) return undefined;
      const translated = t(error, { defaultValue: '' });
      return translated || error;
    },
    [t]
  );

  const errorMessage = useMemo(
    () => resolveChatAnkiError(block.error || data?.syncError || data?.finalError),
    [block.error, data?.syncError, data?.finalError, resolveChatAnkiError]
  );

  return (
    <div className="chat-v2-anki-cards-block">
      {/* 折叠态：卡片预览 */}
      {!isExpanded && (
        <AnkiCardStackPreview
          status={previewStatus}
          cards={cards}
          templateId={data?.templateId}
          template={template}
          templateMap={templateMap}
          debugContext={{
            blockId: block.id,
            documentId: data?.documentId,
          }}
          lastUpdatedAt={block.endedAt || block.startedAt}
          errorMessage={errorMessage}
          stableId={data?.messageStableId || block.messageId}
          disabled={isActionDisabled}
          onClick={cards.length > 0 && !isActionDisabled ? handleToggleExpand : undefined}
        />
      )}

      {/* 展开态：内联卡片编辑列表 */}
      {isExpanded && cards.length > 0 && (
        <div className="animate-in fade-in-0 slide-in-from-top-2 duration-300">
          {/* 头部统计 */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-foreground">
              {t('blocks.ankiCards.title')} · {cards.length} {t('blocks.ankiCards.cards')}
            </span>
            <NotionButton
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleToggleExpand}
              className="h-7 px-2"
            >
              <ChevronUp className="w-3.5 h-3.5" />
              {t('blocks.ankiCards.collapse')}
            </NotionButton>
          </div>

          {/* 卡片列表 */}
          <div className="space-y-2">
            {cards.map((card, index) => (
              <InlineCardItem
                key={card.id || `card-${index}`}
                card={card}
                index={index}
                isEditing={editingIndex === index}
                template={template}
                templateMap={templateMap}
                onToggleEdit={handleToggleEdit}
                onSave={handleSaveCard}
                onDelete={handleDeleteCard}
                disabled={isActionDisabled}
              />
            ))}
            {/* 滚动锚点：新卡片到来时自动滚动到此处 */}
            <div ref={cardsEndRef} />
          </div>

          {/* 错误/状态信息 */}
          {errorMessage && (
            <div className="mt-2 text-sm text-destructive rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1">
              {errorMessage}
            </div>
          )}
        </div>
      )}

      {/* 底部操作区：移动端全宽，桌面端保持原布局 */}
      {(shouldShowChatAnkiProgress || cards.length > 0) && (
        <FullWidthCardWrapper className="chatanki-bottom-actions">
          {shouldShowChatAnkiProgress && (
            <ChatAnkiProgressCompact
              progress={data?.progress}
              ankiConnect={data?.ankiConnect}
              warnings={data?.warnings}
              cardsCount={cards.length}
              blockStatus={block.status}
              finalStatus={data?.finalStatus}
            />
          )}

          {/* 操作按钮组（仅在有卡片时显示） */}
          {cards.length > 0 && (
            <ActionButtons
              cards={cards}
              data={data}
              blockStatus={block.status}
              isStreaming={isStreaming}
              isExpanded={isExpanded}
              onToggleExpand={handleToggleExpand}
            />
          )}
        </FullWidthCardWrapper>
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('anki_cards', {
  type: 'anki_cards',
  component: AnkiCardsBlock,
  onAbort: 'keep-content', // 中断时保留已生成的卡片
});

// 导出组件（供测试和其他模块使用）
export { AnkiCardsBlock };
