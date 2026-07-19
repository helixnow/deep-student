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
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { cn } from '@/utils/cn';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  CircleNotch,
  FloppyDisk,
  DownloadSimple,
  PaperPlaneRight,
  Pencil,
  Check,
  X,
  CaretUp,
  Trash,
  Pause,
  Play,
  Stop,
  Stack,
  ArrowClockwise,
  DotsThree,
} from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { controlDocumentTask } from '@/features/anki/taskControl';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

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
import type { SaveAnkiCardIdMapping } from '@/services/ankiApiAdapter';
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

export interface AnkiCardsIssue {
  scope: string;
  code: string;
  severity: 'warning' | 'error';
  retryable: boolean;
  recovered: boolean;
  detail?: string;
}

export interface AnkiCardsBlockData {
  schemaVersion?: number;
  stateRevision?: number;
  /** 卡片列表 */
  cards: AnkiCard[];
  /** Agent 删除墓碑：阻止迟到/重放的生成结果复活已删除卡片。 */
  deletedCardIds?: string[];
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
  workflowStatus?: 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';
  generationStatus?: 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
  deliveryStatus?: 'empty' | 'incomplete' | 'ready';
  recoveryStatus?: 'none' | 'manual' | 'existing_cards' | 'retry';
  availableCards?: number;
  recoveredCards?: number;
  issues?: AnkiCardsIssue[];
  /** 后端警告信息（用于 UI 显示） */
  warnings?: AnkiCardsWarning[];
}

interface DocumentTaskSummary {
  id?: unknown;
  status?: unknown;
}

function getRetryableTaskIds(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return [];

  const ids = tasks.flatMap((task: DocumentTaskSummary) => {
    const status = typeof task?.status === 'string' ? task.status.trim().toLowerCase() : '';
    const id = typeof task?.id === 'string' ? task.id.trim() : '';
    return id && (status === 'failed' || status === 'truncated') ? [id] : [];
  });

  return Array.from(new Set(ids));
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
  onSave: (index: number, updated: AnkiCard) => void | Promise<void>;
  onDelete: (index: number) => void | Promise<void>;
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
  // 触屏无 hover:模板渲染态的编辑按钮需常显(点卡片本体是翻面,不会进入编辑)
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
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
      <div className="border rounded-lg bg-card overflow-hidden ui-drop-in">
        {/* 编辑头部 */}
        <div className="flex items-center justify-between px-3 py-2 bg-accent/30 border-b">
          <span className="text-xs font-medium text-muted-foreground">
            #{index + 1}
          </span>
          <div className="flex items-center gap-1">
            <NotionButton
              type="button"
              variant="ghost"
              onClick={() => onDelete(index)}
              className="!h-10 !w-10 text-destructive hover:text-destructive"
              size="icon"
              iconOnly
              aria-label={t('chatV2.deleteCard')}
            >
              <Trash size={14} />
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
              <Textarea
                ref={idx === 0 ? firstFieldRef : undefined}
                value={editFieldValues[field] ?? ''}
                onChange={(e) => handleFieldChange(field, e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full min-h-[60px] resize-y"
                placeholder={resolveFieldLabel(field)}
              />
            </div>
          ))}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t('chatV2.tags')}
            </label>
            <Input
              type="text"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full"
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
              <Check size={14} />
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
        {/* 编辑按钮(触屏常显:卡片本体点击是翻面,编辑只能走此按钮) */}
        {!disabled && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={(e) => { e.stopPropagation(); onToggleEdit(index); }}
            className={cn(
              'absolute top-2 right-2 z-10 bg-background/80 backdrop-blur border hover:bg-[var(--interactive-hover)]',
              isTouchPrimary
                ? '!h-10 !w-10 opacity-100'
                : '!h-10 !w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            )}
            aria-label="edit"
          >
            <Pencil size={isTouchPrimary ? 14 : 12} className="text-muted-foreground" />
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
              <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {tag}
              </span>
            ))}
            {card.tags.length > 4 && (
              <span className="text-xs text-muted-foreground">+{card.tags.length - 4}</span>
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
          : 'cursor-pointer hover:bg-[var(--interactive-hover)] hover:border-accent-foreground/20',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={disabled ? undefined : () => onToggleEdit(index)}
      onKeyDown={(event) => {
        if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onToggleEdit(index);
      }}
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? undefined : 0}
      aria-label={disabled ? undefined : t('chatV2.editCard', { index: index + 1 })}
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
                <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {tag}
                </span>
              ))}
              {card.tags.length > 4 && (
                <span className="text-xs text-muted-foreground">+{card.tags.length - 4}</span>
              )}
            </div>
          )}
        </div>
        {/* 编辑提示（触屏无 hover：coarse 指针下常显弱化态，保证可编辑性可发现） */}
        {!disabled && (
          <Pencil size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60 transition-opacity flex-shrink-0 mt-1" />
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
  blockId: string;
  blockStatus: string;
  isStreaming?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  retryableTaskCount: number;
  retryStatus: ActionStatus;
  retryError: string | null;
  onRetryFailedSegments: () => Promise<void>;
  /** 同步成功/失败后回写块 toolOutput.syncStatus（消灭 syncStatus 空转） */
  onSyncStatusChange?: (status: 'synced' | 'error' | 'syncing', error?: string) => void;
  /** 保存成功后用后端返回的真实 ID 更新并持久化当前块。 */
  onCardsPersisted?: (mappings: SaveAnkiCardIdMapping[]) => Promise<void>;
}> = ({
  cards,
  data,
  blockId,
  blockStatus,
  isStreaming,
  isExpanded,
  onToggleExpand,
  retryableTaskCount,
  retryStatus,
  retryError,
  onRetryFailedSegments,
  onSyncStatusChange,
  onCardsPersisted,
}) => {
  const { t } = useTranslation('chatV2');
  const [saveStatus, setSaveStatus] = useState<ActionStatus>('idle');
  const [exportStatus, setExportStatus] = useState<ActionStatus>('idle');
  const [syncStatus, setSyncStatus] = useState<ActionStatus>('idle');
  const [taskControlStatus, setTaskControlStatus] = useState<ActionStatus>('idle');

  // 同步互斥锁：防止同一事件循环 tick 内的快速双击导致重复调用
  const actionLockRef = useRef<Set<string>>(new Set());
  const timeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timeouts = timeoutRefs.current;
    return () => {
      timeouts.forEach((id) => clearTimeout(id));
      timeouts.clear();
    };
  }, []);

  const context = useMemo(
    () => ({
      documentId: data?.documentId ?? null,
      businessSessionId: data?.businessSessionId ?? null,
      messageStableId: data?.messageStableId ?? null,
      blockId,
      templateId: data?.templateId ?? null,
      options: data?.options,
    }),
    [blockId, data]
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

  const documentId = data?.documentId;
  const progressStage = data?.progress?.stage?.toLowerCase();
  const isPaused =
    progressStage === 'paused' || data?.finalStatus?.toLowerCase() === 'paused';
  const isBlockBusy = blockStatus === 'pending' || blockStatus === 'running';
  const showTaskControls = Boolean(documentId) && (isBlockBusy || isPaused);

  const handleTaskControl = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      if (!documentId || taskControlStatus === 'loading' || actionLockRef.current.has('taskControl')) {
        return;
      }
      actionLockRef.current.add('taskControl');
      setTaskControlStatus('loading');
      try {
        await controlDocumentTask({ documentId, action });
        setTaskControlStatus('success');
        const successKey =
          action === 'pause'
            ? 'blocks.ankiCards.action.paused'
            : action === 'resume'
              ? 'blocks.ankiCards.action.resumed'
              : 'blocks.ankiCards.action.cancelled';
        showGlobalNotification('success', t(successKey));
      } catch (error: unknown) {
        const msg = getErrorMessage(error);
        console.error(`[AnkiCardsBlock] Task ${action} failed:`, msg);
        setTaskControlStatus('error');
        const failKey =
          action === 'pause'
            ? 'blocks.ankiCards.action.pauseFailed'
            : action === 'resume'
              ? 'blocks.ankiCards.action.resumeFailed'
              : 'blocks.ankiCards.action.cancelFailed';
        showGlobalNotification('error', t(failKey), msg);
      }
      actionLockRef.current.delete('taskControl');
      resetStatusAfterDelay(setTaskControlStatus);
    },
    [documentId, taskControlStatus, resetStatusAfterDelay, t]
  );

  const handleSave = useCallback(async () => {
    if (cards.length === 0 || saveStatus === 'loading' || actionLockRef.current.has('save')) return;
    actionLockRef.current.add('save');
    setSaveStatus('loading');
    try {
      const result = await saveCardsToLibrary({ cards, context });
      if (!result.success) {
        const failDetail =
          result.error ||
          result.failed?.map((f) => `${f.id}: ${f.error}`).join('; ') ||
          t('blocks.ankiCards.action.saveFailed');
        throw new Error(failDetail);
      }
      await onCardsPersisted?.(result.cardIdMappings ?? []);
      const reviewableSavedCount = result.savedCount;
      logChatAnkiEvent(
        'chat_anki_action_performed',
        {
          action: 'save',
          cardCount: reviewableSavedCount,
          skippedErrorCards: result.skippedErrorCards ?? 0,
        },
        context,
      );
      setSaveStatus('success');
      if (result.warning?.code === 'anki_save_partial') {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.savePartialTitle'),
          t('blocks.ankiCards.action.savePartialDetail', {
            saved: result.warning.details.saved,
            duplicated: result.warning.details.duplicated,
            skipped: result.warning.details.skipped,
            failed: result.warning.details.failed,
          })
        );
      } else if (result.warning?.code === 'anki_save_all_skipped') {
        showGlobalNotification(
          'info',
          t('blocks.ankiCards.action.saveAllSkippedTitle'),
          t('blocks.ankiCards.action.saveAllSkippedDetail', {
            skipped: result.warning.details.skipped,
            duplicated: result.warning.details.duplicated,
          })
        );
      } else if ((result.skippedErrorCards ?? 0) > 0) {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount }),
          t('blocks.ankiCards.action.skippedDiagnosticDetail', {
            count: result.skippedErrorCards,
            defaultValue: 'Skipped {{count}} diagnostic cards',
          }),
        );
      } else {
        showGlobalNotification(
          'success',
          t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount })
        );
      }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Save failed:', msg);
      setSaveStatus('error');
      showGlobalNotification(
        'error',
        t('blocks.ankiCards.action.saveFailedWithHint'),
        t('blocks.ankiCards.action.saveFailedDetail', { detail: msg })
      );
    }
    actionLockRef.current.delete('save');
    resetStatusAfterDelay(setSaveStatus);
  }, [cards, context, saveStatus, resetStatusAfterDelay, t, onCardsPersisted]);

  const handleExport = useCallback(async () => {
    if (cards.length === 0 || exportStatus === 'loading' || actionLockRef.current.has('export')) return;
    actionLockRef.current.add('export');
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
      if (result.cancelled) {
        // 用户取消了文件保存对话框，静默恢复，不显示错误
        setExportStatus('idle');
        actionLockRef.current.delete('export');
        return;
      }
      if (!result.success || !result.filePath) throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'export', cardCount: cards.length }, context);
      setExportStatus('success');
      if (result.skippedErrorCards && result.skippedErrorCards > 0) {
        showGlobalNotification('warning', t('blocks.ankiCards.action.exportSkippedErrors', { exported: cards.length - result.skippedErrorCards, skipped: result.skippedErrorCards }), result.filePath);
      } else {
        showGlobalNotification('success', t('blocks.ankiCards.action.apkgExportedWithHint'), result.filePath);
      }
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
    actionLockRef.current.delete('export');
    resetStatusAfterDelay(setExportStatus);
  }, [cards, context, exportStatus, resetStatusAfterDelay, t]);

  const reviewableCards = useMemo(
    () => cards.filter((card) => {
      const row = card as { is_error_card?: unknown; isErrorCard?: unknown };
      return row.is_error_card !== true && row.isErrorCard !== true;
    }),
    [cards],
  );
  const reviewCardIds = useMemo(
    () => reviewableCards.map((card) => (typeof card.id === 'string' ? card.id.trim() : '')),
    [reviewableCards],
  );
  const reviewTemplateId = useCallback((card: AnkiCard): string | undefined => {
    if (typeof card.template_id === 'string') return card.template_id;
    const legacyTemplateId = Reflect.get(card, 'templateId');
    return typeof legacyTemplateId === 'string' ? legacyTemplateId : undefined;
  }, []);
  const reviewCards = useMemo(
    () =>
      reviewableCards.map((card, index) => {
        const templateId = reviewTemplateId(card);
        return {
          id: reviewCardIds[index],
          ankiCardId: reviewCardIds[index],
          front: card.front || '',
          back: card.back || '',
          ...(typeof card.text === 'string' && card.text.trim()
            ? { text: card.text }
            : {}),
          tags: card.tags,
          ...(Array.isArray(card.images) ? { images: card.images } : {}),
          ...(templateId ? { templateId } : {}),
          ...(card.fields && typeof card.fields === 'object'
            ? { extraFields: card.fields as Record<string, string> }
            : {}),
        };
      }),
    [reviewableCards, reviewCardIds, reviewTemplateId],
  );
  const canReviewBatch =
    reviewCards.length > 0 &&
    reviewCards.every((card) => {
      const id = card.ankiCardId;
      const hasFace =
        card.front.trim().length > 0
        || card.back.trim().length > 0
        || (typeof card.text === 'string' && card.text.trim().length > 0);
      return (
        hasFace &&
        id.length > 0 &&
        !id.startsWith('anki_synthetic_') &&
        !id.startsWith('chat-batch-')
      );
    });

  const handleReviewBatch = useCallback(() => {
    if (!canReviewBatch) return;
    const payload = {
      screen: 'session' as const,
      mode: 'batch' as const,
      cardIds: reviewCardIds,
      cards: reviewCards,
    };
    // R2-04：收编双路径——统一走 onActivation startReview（已开窗 activate；未开窗 fallbackLaunch）
    void workbenchBus.activate({
      typeId: 'flashcards',
      instanceKey: '',
      action: 'startReview',
      payload,
      fallbackLaunch: {
        typeId: 'flashcards',
        reason: 'api',
        payload,
      },
    });
    logChatAnkiEvent('chat_anki_action_performed', { action: 'review_batch', cardCount: cards.length }, context);
  }, [canReviewBatch, cards.length, context, reviewCardIds, reviewCards]);

  const handleSync = useCallback(async () => {
    if (cards.length === 0 || syncStatus === 'loading' || actionLockRef.current.has('sync')) return;
    actionLockRef.current.add('sync');
    setSyncStatus('loading');
    onSyncStatusChange?.('syncing');
    try {
      const result = await importCardsViaAnkiConnect({ cards, context });
      if (!result.success) throw new Error(t('blocks.ankiCards.action.syncFailedDetail'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'import', cardCount: cards.length }, context);
      setSyncStatus('success');
      // M4：写块 syncStatus，避免预览态长期停在 pending
      onSyncStatusChange?.('synced');
      if (result.warning?.code === 'anki_sync_partial') {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.syncPartialTitle'),
          t('blocks.ankiCards.action.syncPartialDetail', {
            added: result.warning.details.added,
            failed: result.warning.details.failed,
          })
        );
      } else if (result.warning?.code === 'anki_sync_all_duplicates') {
        // 全部已存在：幂等成功，提示而非报错
        showGlobalNotification(
          'info',
          t('blocks.ankiCards.action.syncAllDuplicatesTitle'),
          t('blocks.ankiCards.action.syncAllDuplicatesDetail', {
            count: result.warning.details.duplicates,
          })
        );
      } else {
        showGlobalNotification('success', t('blocks.ankiCards.action.syncedCountWithHint', { count: result.importedCount }));
      }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Sync failed:', msg);
      setSyncStatus('error');
      onSyncStatusChange?.('error', msg);
      showGlobalNotification('error', t('blocks.ankiCards.action.syncFailedWithHint'), msg);
    }
    actionLockRef.current.delete('sync');
    resetStatusAfterDelay(setSyncStatus);
  }, [cards, context, syncStatus, resetStatusAfterDelay, onSyncStatusChange, t]);

  const isDisabled = cards.length === 0 || isStreaming || (isBlockBusy && !isPaused);
  const showRetryFailedSegments = retryableTaskCount > 0;
  const isAnkiConnectAvailable = data?.ankiConnect?.available === true;
  const syncDisabledReason = !isAnkiConnectAvailable
    ? t(
        `blocks.ankiCards.progress.ankiConnect.${
          data?.ankiConnect?.available === false ? 'notConnected' : 'checking'
        }` as const
      )
    : undefined;

  const renderIcon = (status: ActionStatus, DefaultIcon: React.ComponentType<{ className?: string; size?: string | number }>) => {
    switch (status) {
      case 'loading':
        return <CircleNotch size={16} className="animate-spin" />;
      case 'success':
        return <Check size={16} className="text-emerald-500" />;
      case 'error':
        return <X size={16} className="text-destructive" />;
      default:
        return <DefaultIcon size={16} />;
    }
  };

  const retryAction = showRetryFailedSegments ? (
    <div className="col-span-2 flex min-w-0 flex-col items-start gap-1 sm:col-span-1">
      <NotionButton
        type="button"
        onClick={() => void onRetryFailedSegments()}
        disabled={retryStatus === 'loading'}
        aria-busy={retryStatus === 'loading'}
        variant={retryStatus === 'error' ? 'danger' : 'default'}
        className="min-h-10 w-full text-xs sm:w-auto sm:text-sm"
      >
        {renderIcon(retryStatus, ArrowClockwise)}
        {t('blocks.ankiCards.retryFailedSegments')}
      </NotionButton>
      {retryStatus === 'error' && retryError && (
        <span
          role="alert"
          className="max-w-full text-xs leading-snug text-destructive"
          data-testid="chatanki-retry-failed-segments-error"
        >
          {retryError}
        </span>
      )}
    </div>
  ) : null;

  if (!showTaskControls && cards.length === 0) {
    return retryAction ? (
      <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border/50">
        {retryAction}
      </div>
    ) : null;
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/50 pt-3 sm:flex sm:flex-wrap">
      {retryAction}

      {/* 运行中：暂停 / 继续 / 取消（有 documentId 时） */}
      {showTaskControls && (
        <>
          {isPaused ? (
            <NotionButton
              type="button"
              onClick={() => void handleTaskControl('resume')}
              disabled={taskControlStatus === 'loading'}
              variant="primary"
              className="min-h-10 text-xs sm:text-sm"
            >
              {taskControlStatus === 'loading' ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              {t('blocks.ankiCards.resume')}
            </NotionButton>
          ) : (
            <NotionButton
              type="button"
              onClick={() => void handleTaskControl('pause')}
              disabled={taskControlStatus === 'loading'}
              variant="default"
              className="min-h-10 text-xs sm:text-sm"
            >
              {taskControlStatus === 'loading' ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Pause size={14} />
              )}
              {t('blocks.ankiCards.pause')}
            </NotionButton>
          )}
          <NotionButton
            type="button"
            onClick={() => void handleTaskControl('cancel')}
            disabled={taskControlStatus === 'loading'}
            variant="danger"
            className="min-h-10 text-xs sm:text-sm"
          >
            {taskControlStatus === 'loading' ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <Stop size={14} />
            )}
            {t('blocks.ankiCards.cancel')}
          </NotionButton>
        </>
      )}

      {cards.length > 0 && (
        <>
          {/* 内联展开/折叠编辑 */}
          <NotionButton
            type="button"
            onClick={onToggleExpand}
            disabled={isDisabled}
            variant={isExpanded ? 'default' : 'primary'}
            className="min-h-10 text-xs sm:text-sm"
          >
            {isExpanded ? <CaretUp size={14} /> : <Pencil size={14} />}
            {isExpanded ? t('blocks.ankiCards.collapse') : t('blocks.ankiCards.edit')}
          </NotionButton>

          {/* 加入本地卡片库 */}
          <NotionButton
            type="button"
            onClick={handleSave}
            disabled={isDisabled || saveStatus === 'loading'}
            variant={saveStatus === 'success' ? 'success' : saveStatus === 'error' ? 'danger' : canReviewBatch ? 'default' : 'primary'}
            className="min-h-10 text-xs sm:text-sm"
          >
            {renderIcon(saveStatus, FloppyDisk)}
            {t(
              saveStatus === 'success'
                ? 'blocks.ankiCards.addedToLibrary'
                : 'blocks.ankiCards.addToLibrary'
            )}
          </NotionButton>

          {/* 复习这批 → workbench 闪卡会话 */}
          <NotionButton
            type="button"
            onClick={handleReviewBatch}
            disabled={isDisabled || !canReviewBatch}
            title={!canReviewBatch ? t('blocks.ankiCards.reviewBatchNeedsRealIds') : undefined}
            variant="primary"
            className="min-h-10 text-xs sm:text-sm"
          >
            <Stack size={16} />
            {t('blocks.ankiCards.reviewBatch')}
          </NotionButton>

          {/* 低频交付动作收进菜单，避免与编辑/复习争夺主层级。 */}
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton
                type="button"
                variant="ghost"
                size="icon"
                iconOnly
                className="!h-10 !w-10 justify-self-end"
                aria-label={t('blocks.ankiCards.moreActions')}
                title={t('blocks.ankiCards.moreActions')}
              >
                <DotsThree size={20} />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={240}>
              <AppMenuGroup>
                <AppMenuItem
                  icon={renderIcon(exportStatus, DownloadSimple)}
                  onClick={() => void handleExport()}
                  disabled={isDisabled || exportStatus === 'loading'}
                >
                  {t('blocks.ankiCards.export')}
                </AppMenuItem>
                <AppMenuItem
                  icon={renderIcon(syncStatus, PaperPlaneRight)}
                  onClick={() => void handleSync()}
                  disabled={isDisabled || syncStatus === 'loading' || !isAnkiConnectAvailable}
                >
                  {t('blocks.ankiCards.sync')}
                  {syncDisabledReason ? ` · ${syncDisabledReason}` : ''}
                </AppMenuItem>
              </AppMenuGroup>
            </AppMenuContent>
          </AppMenu>
        </>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/** Zombie block watchdog 阈值：running 状态超过该时长无更新则做后端核实/标错 */
const ZOMBIE_TIMEOUT_MS = 5 * 60 * 1000;

export type ZombieCompletionState =
  | {
      finalStatus: 'completed' | 'completed_with_errors';
      blockStatus: 'success';
    }
  | {
      finalStatus: 'error' | 'cancelled';
      blockStatus: 'error';
      errorKey:
        | 'blocks.ankiCards.errors.watchdogFailedWithoutCards'
        | 'blocks.ankiCards.errors.watchdogCancelledWithoutCards'
        | 'blocks.ankiCards.errors.watchdogCompletedWithoutCards'
        | 'blocks.ankiCards.errors.watchdogUnknownWithoutCards';
    };

interface ZombieCardLike {
  is_error_card?: unknown;
  isErrorCard?: unknown;
}

export function resolveZombieCompletionState(
  statuses: string[],
  cards: readonly ZombieCardLike[] = [],
): ZombieCompletionState {
  const normalized = statuses.map((status) => status.trim().toLowerCase());
  const hasCompleted = normalized.includes('completed');
  const hasFailures = normalized.some((status) => ['failed', 'truncated'].includes(status));
  const hasCancelled = normalized.some((status) => ['cancelled', 'canceled'].includes(status));
  const hasUnknown = normalized.some((status) => ![
    'completed',
    'failed',
    'truncated',
    'cancelled',
    'canceled',
  ].includes(status));
  const hasUsableCards = cards.some((card) => (
    card.is_error_card !== true && card.isErrorCard !== true
  ));

  if (hasUsableCards) {
    return {
      finalStatus: hasFailures || hasCancelled || hasUnknown
        ? 'completed_with_errors'
        : 'completed',
      blockStatus: 'success',
    };
  }
  if (hasCancelled) {
    return {
      finalStatus: 'cancelled',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCancelledWithoutCards',
    };
  }
  if (hasCompleted && !hasFailures && !hasUnknown) {
    return {
      finalStatus: 'error',
      blockStatus: 'error',
      errorKey: 'blocks.ankiCards.errors.watchdogCompletedWithoutCards',
    };
  }
  return {
    finalStatus: 'error',
    blockStatus: 'error',
    errorKey: hasFailures
      ? 'blocks.ankiCards.errors.watchdogFailedWithoutCards'
      : 'blocks.ankiCards.errors.watchdogUnknownWithoutCards',
  };
}

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
  // useMemo 固定空数组引用：`data?.cards || []` 每次渲染都会生成新数组，
  // 导致依赖 cards 的 effect/memo（调试上报、模板 id 提取等）在流式期间每帧重跑
  const cards = useMemo(() => data?.cards ?? [], [data?.cards]);
  const isBlockBusy = block.status === 'pending' || block.status === 'running';
  const isActionDisabled = isBlockBusy || Boolean(isStreaming);
  const documentId = typeof data?.documentId === 'string' ? data.documentId.trim() : '';
  const [retryableTaskIds, setRetryableTaskIds] = useState<string[]>([]);
  const [retryStatus, setRetryStatus] = useState<ActionStatus>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryActionLockRef = useRef(false);
  const retryScopeRef = useRef(0);
  const retryableCountHint = useMemo((): { failed: number; truncated: number } => {
    const counts = data?.progress?.counts;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
      return { failed: 0, truncated: 0 };
    }
    const record = counts as Record<string, unknown>;
    return {
      failed: typeof record.failed === 'number' ? record.failed : 0,
      truncated: typeof record.truncated === 'number' ? record.truncated : 0,
    };
  }, [data?.progress?.counts]);
  const retryInspectionKey = useMemo(() => {
    const progressStage = data?.progress?.stage?.trim().toLowerCase() ?? '';
    const finalStatus = data?.finalStatus?.trim().toLowerCase() ?? '';
    const terminalStatuses = new Set([
      'completed',
      'completed_with_errors',
      'success',
      'error',
      'failed',
      'cancelled',
      'canceled',
    ]);
    const blockIsTerminal = block.status === 'success' || block.status === 'error';
    const statusIsTerminal = terminalStatuses.has(finalStatus) || terminalStatuses.has(progressStage);
    const hasFailureCount = retryableCountHint.failed > 0 || retryableCountHint.truncated > 0;
    return blockIsTerminal || statusIsTerminal || hasFailureCount
      ? `${block.status}:${finalStatus}:${progressStage}:${retryableCountHint.failed}:${retryableCountHint.truncated}`
      : '';
  }, [
    block.status,
    data?.finalStatus,
    data?.progress?.stage,
    retryableCountHint.failed,
    retryableCountHint.truncated,
  ]);
  const generationRetryBlocked = useMemo(() => {
    const generationIssues = data?.issues?.filter((issue) => issue.scope === 'generation') ?? [];
    return generationIssues.length > 0 && generationIssues.every((issue) => !issue.retryable);
  }, [data?.issues]);

  useEffect(() => {
    retryScopeRef.current += 1;
    retryActionLockRef.current = false;
    setRetryableTaskIds([]);
    setRetryStatus('idle');
    setRetryError(null);
  }, [documentId]);

  useEffect(() => {
    if (!documentId || !retryInspectionKey || generationRetryBlocked) {
      setRetryableTaskIds([]);
      return;
    }

    let cancelled = false;
    void invoke<DocumentTaskSummary[]>('get_document_tasks', { documentId })
      .then((tasks) => {
        if (!cancelled) {
          setRetryableTaskIds(getRetryableTaskIds(tasks));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRetryableTaskIds([]);
          console.warn('[AnkiCardsBlock] Failed to inspect retryable document tasks:', error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [documentId, retryInspectionKey, generationRetryBlocked]);

  const handleRetryFailedSegments = useCallback(async () => {
    if (!documentId || retryableTaskIds.length === 0 || retryActionLockRef.current) return;

    const attemptedTaskIds = [...retryableTaskIds];
    const attemptedTaskIdSet = new Set(attemptedTaskIds);
    const scope = retryScopeRef.current;
    retryActionLockRef.current = true;
    setRetryStatus('loading');
    setRetryError(null);

    try {
      const results = await Promise.allSettled(
        attemptedTaskIds.map((taskId) => controlDocumentTask({ action: 'retry', taskId })),
      );
      if (scope !== retryScopeRef.current) return;

      const failedTaskIds = results.flatMap((result, index) =>
        result.status === 'rejected' ? [attemptedTaskIds[index]] : [],
      );
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      setRetryableTaskIds((current) => {
        const unattempted = current.filter((taskId) => !attemptedTaskIdSet.has(taskId));
        return Array.from(new Set([...unattempted, ...failedTaskIds]));
      });

      if (failedTaskIds.length === 0) {
        setRetryStatus('success');
        showGlobalNotification(
          'success',
          t('blocks.ankiCards.action.retrySegmentsStarted', { count: attemptedTaskIds.length }),
        );
        return;
      }

      const messageKey =
        failedTaskIds.length === attemptedTaskIds.length
          ? 'blocks.ankiCards.action.retrySegmentsFailed'
          : 'blocks.ankiCards.action.retrySegmentsPartial';
      const summary = t(messageKey, {
        failed: failedTaskIds.length,
        total: attemptedTaskIds.length,
      });
      const detail = firstFailure ? getErrorMessage(firstFailure.reason) : '';
      const errorMessage = detail ? `${summary}: ${detail}` : summary;
      setRetryStatus('error');
      setRetryError(errorMessage);
      showGlobalNotification(
        failedTaskIds.length === attemptedTaskIds.length ? 'error' : 'warning',
        summary,
        detail || undefined,
      );
    } finally {
      if (scope === retryScopeRef.current) {
        retryActionLockRef.current = false;
      }
    }
  }, [documentId, retryableTaskIds, t]);

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
  // 分页：限制同时渲染的卡片数量，防止大量 iframe 导致浏览器卡顿/崩溃
  const CARDS_PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(CARDS_PAGE_SIZE);
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

  // 刷新 AnkiConnect 状态：调用后端重新检测，更新 block 数据
  // 注意：从 store 读取最新 block 数据，避免 stale closure 导致覆盖并发更新
  const handleRefreshAnkiConnect = useCallback(async () => {
    if (!store) return;
    try {
      const available = await invoke<boolean>('check_anki_connect_status');
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const newData = {
        ...latestData,
        ankiConnect: {
          ...latestData.ankiConnect,
          available,
          checkedAt: new Date().toISOString(),
          error: available ? undefined : latestData.ankiConnect?.error,
        },
      };
      store.getState().updateBlock(block.id, { toolOutput: newData });
    } catch (err) {
      console.warn('[AnkiCardsBlock] Failed to refresh AnkiConnect status:', err);
    }
  }, [store, block.id]);

  // Zombie block watchdog: 如果 block 持续处于 running 状态超过 5 分钟无更新，自动标记为 error
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    // 每次 cards/progress 变化都重置活跃时间戳
    lastActivityRef.current = Date.now();
  }, [cards.length, data?.progress?.stage, data?.progress?.cardsGenerated]);
  useEffect(() => {
    if (block.status !== 'running') return;
    const timer = setInterval(() => {
      if (block.status !== 'running' || Date.now() - lastActivityRef.current <= ZOMBIE_TIMEOUT_MS) return;

      const currentDocumentId = (store?.getState().blocks.get(block.id)?.toolOutput as AnkiCardsBlockData | undefined)?.documentId;
      if (!currentDocumentId) {
        console.warn('[AnkiCardsBlock] Zombie block detected without documentId, forcing error state:', block.id);
        store?.getState().setBlockError(block.id, t('blocks.ankiCards.errors.pipelineTimeout'));
        clearInterval(timer);
        return;
      }

      void (async () => {
        try {
          const tasks = await invoke<Array<{ status?: string }>>('get_document_tasks', { documentId: currentDocumentId });
          const latestBlock = store?.getState().blocks.get(block.id);
          if (!latestBlock || latestBlock.status !== 'running') return;

          const statuses = tasks.map((task) => String(task.status ?? '').toLowerCase());
          const hasInFlight = statuses.some((status) => ['pending', 'processing', 'streaming', 'paused'].includes(status));
          if (hasInFlight) {
            lastActivityRef.current = Date.now();
            return;
          }

          if (tasks.length > 0) {
            const cards = await invoke<Array<Record<string, unknown>>>('get_document_cards', { documentId: currentDocumentId });
            const latestData = latestBlock.toolOutput as AnkiCardsBlockData | undefined;
            const finalCards = cards.length > 0 ? cards : (latestData?.cards ?? []);
            const completion = resolveZombieCompletionState(statuses, finalCards);
            store?.getState().updateBlock(block.id, {
              toolOutput: {
                ...latestData,
                cards: finalCards as AnkiCard[],
                finalStatus: completion.finalStatus,
                progress: {
                  ...latestData?.progress,
                  stage: completion.finalStatus,
                  cardsGenerated: finalCards.length,
                  lastUpdatedAt: new Date().toISOString(),
                },
              } as AnkiCardsBlockData,
              status: completion.blockStatus,
              error: completion.blockStatus === 'error' ? t(completion.errorKey) : undefined,
            });
            clearInterval(timer);
            return;
          }

          console.warn('[AnkiCardsBlock] Zombie block detected, forcing error state after backend check:', block.id);
          store?.getState().setBlockError(block.id, t('blocks.ankiCards.errors.pipelineTimeout'));
          clearInterval(timer);
        } catch (err) {
          console.warn('[AnkiCardsBlock] Zombie block backend verification failed, forcing error state:', err);
          store?.getState().setBlockError(block.id, t('blocks.ankiCards.errors.pipelineTimeout'));
          clearInterval(timer);
        }
      })();
    }, 30_000); // check every 30s
    return () => clearInterval(timer);
  }, [block.status, block.id, store, t]);

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
    setVisibleCount(CARDS_PAGE_SIZE);
  }, [CARDS_PAGE_SIZE]);

  // 切换卡片编辑模式
  const handleToggleEdit = useCallback((index: number) => {
    setEditingIndex((prev) => (prev === index ? -1 : index));
  }, []);

  // 🔧 场景8修复：将编辑后的 toolOutput 持久化到数据库
  // 防止后续 pipeline 重保存消息时丢失用户编辑
  const persistToolOutput = useCallback(
    async (newData: AnkiCardsBlockData, propagateError = false) => {
      try {
        await invoke('chat_v2_update_block_tool_output', {
          blockId: block.id,
          toolOutputJson: JSON.stringify(newData),
        });
      } catch (err) {
        console.warn('[AnkiCardsBlock] Failed to persist tool_output:', err);
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.persistFailed'),
        );
        if (propagateError) throw err;
      }
    },
    [block.id, t]
  );

  const handleCardsPersisted = useCallback(
    async (mappings: SaveAnkiCardIdMapping[]) => {
      if (!store || mappings.length === 0) return;
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = (latestBlock?.toolOutput as AnkiCardsBlockData | undefined) ?? data;
      if (!latestData) return;

      const nextCards = [...(latestData.cards ?? [])];
      let changed = false;
      for (const mapping of mappings) {
        const persistedId = mapping.persistedId?.trim();
        if (
          !persistedId ||
          persistedId.startsWith('anki_synthetic_') ||
          persistedId.startsWith('chat-batch-') ||
          !Number.isInteger(mapping.inputIndex) ||
          mapping.inputIndex < 0
        ) {
          continue;
        }

        const expectedInputId = mapping.inputId ?? undefined;
        let targetIndex = mapping.inputIndex;
        const indexedCard = nextCards[targetIndex];
        if (
          expectedInputId !== undefined &&
          indexedCard?.id !== expectedInputId &&
          indexedCard?.id !== persistedId
        ) {
          targetIndex = nextCards.findIndex((card) => card.id === expectedInputId);
        }
        const target = nextCards[targetIndex];
        if (!target || target.id === persistedId) continue;
        if (expectedInputId !== undefined && target.id !== expectedInputId) continue;

        nextCards[targetIndex] = { ...target, id: persistedId };
        changed = true;
      }

      if (!changed) return;
      const newData: AnkiCardsBlockData = { ...latestData, cards: nextCards };
      await persistToolOutput(newData, true);
      store.getState().updateBlock(block.id, { toolOutput: newData });
    },
    [store, block.id, data, persistToolOutput]
  );

  // M4：Sync 成功后写块 syncStatus（store + DB tool_output）
  const handleSyncStatusChange = useCallback(
    (status: 'synced' | 'error' | 'syncing', error?: string) => {
      if (!store) return;
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = (latestBlock?.toolOutput as AnkiCardsBlockData | undefined) ?? data;
      if (!latestData) return;
      const newData: AnkiCardsBlockData = {
        ...latestData,
        syncStatus: status,
        syncError: status === 'error' ? error : undefined,
      };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      // syncing 为瞬时态，不必落库；synced/error 持久化以免刷新后空转
      if (status === 'synced' || status === 'error') {
        void persistToolOutput(newData);
      }
    },
    [store, block.id, data, persistToolOutput]
  );

  // E2 修复：块内编辑/删除同时回写 anki_cards 表（消灭双数据源）。
  // AI 的 chatanki_export / chatanki_sync 读取的是 DB，
  // 不回写会导致"用户在块里删过/改过的卡在 AI 导出时复活"。
  // 成功后再更新投影；失败 toast 且不覆写 store（避免与流式更新竞态丢卡）。
  const syncCardUpdateToDb = useCallback(async (card: AnkiCard) => {
    if (!card.id) return;
    // 空 text 归一化为 null，避免把 DB 中的 NULL 覆盖为空字符串
    const payload = { ...card, text: card.text?.trim() ? card.text : null };
    try {
      await invoke('update_anki_card', { card: payload });
    } catch (err) {
      console.warn('[AnkiCardsBlock] Failed to sync card edit to anki DB:', err);
      showGlobalNotification(
        'warning',
        t('blocks.ankiCards.action.dbSyncFailed'),
      );
      throw err;
    }
  }, [t]);

  const syncCardDeleteToDb = useCallback(async (card: AnkiCard | undefined) => {
    if (!card?.id) return;
    try {
      await invoke('delete_anki_card', { cardId: card.id });
    } catch (err) {
      console.warn('[AnkiCardsBlock] Failed to sync card delete to anki DB:', err);
      showGlobalNotification(
        'warning',
        t('blocks.ankiCards.action.dbSyncFailed'),
      );
      throw err;
    }
  }, [t]);

  // 保存卡片编辑：从 store 读最新 toolOutput 再合并，避免闭包 cards 整表覆写冲掉流式新卡
  const handleSaveCard = useCallback(
    async (index: number, updated: AnkiCard) => {
      if (!store) return;
      try {
        await syncCardUpdateToDb(updated);
      } catch {
        return;
      }
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const latestCards = latestData.cards ?? [];
      const newCards = [...latestCards];
      const byId = updated.id
        ? newCards.findIndex((card) => card.id === updated.id)
        : -1;
      const targetIndex = byId >= 0 ? byId : index;
      if (targetIndex < 0 || targetIndex >= newCards.length) return;
      newCards[targetIndex] = updated;
      const newData = { ...latestData, cards: newCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      void persistToolOutput(newData);
      setEditingIndex(-1);
      logChatAnkiEvent('chat_anki_card_edited', { index: targetIndex, blockId: block.id });
    },
    [store, block.id, persistToolOutput, syncCardUpdateToDb]
  );

  // 删除卡片：同样基于最新 store 合并，避免 stale closure 整表覆写
  // 🔧 修复：删除非编辑中的卡片时，正确调整 editingIndex 避免偏移到错误卡片
  const handleDeleteCard = useCallback(
    async (index: number) => {
      if (!store) return;
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const latestCards = latestData.cards ?? [];
      if (index < 0 || index >= latestCards.length) return;
      const removed = latestCards[index];
      try {
        await syncCardDeleteToDb(removed);
      } catch {
        return;
      }
      // DB 成功后再读一次，避免 await 期间流式更新被丢弃
      const afterBlock = store.getState().blocks.get(block.id);
      const afterData = afterBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!afterData) return;
      const afterCards = afterData.cards ?? [];
      const removeIndex = removed?.id
        ? afterCards.findIndex((card) => card.id === removed.id)
        : index;
      if (removeIndex < 0) return;
      const newCards = afterCards.filter((_, i) => i !== removeIndex);
      const newData = { ...afterData, cards: newCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      void persistToolOutput(newData);
      setEditingIndex((prev) => {
        if (prev === removeIndex) return -1;
        if (prev > removeIndex) return prev - 1;
        return prev;
      });
      logChatAnkiEvent('chat_anki_card_deleted', { index: removeIndex, blockId: block.id });
    },
    [store, block.id, persistToolOutput, syncCardDeleteToDb]
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

  const deliveryRecovered = data?.deliveryStatus === 'ready' && cards.length > 0;
  const errorMessage = useMemo(() => {
    const generationError = deliveryRecovered ? undefined : block.error || data?.finalError;
    return resolveChatAnkiError(generationError || data?.syncError);
  }, [block.error, data?.syncError, data?.finalError, deliveryRecovered, resolveChatAnkiError]);

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
          errorMessage={shouldShowChatAnkiProgress ? undefined : errorMessage}
          stableId={data?.messageStableId || block.messageId}
          disabled={isActionDisabled}
          onClick={cards.length > 0 && !isActionDisabled ? handleToggleExpand : undefined}
        />
      )}

      {/* 展开态：内联卡片编辑列表 */}
      {isExpanded && cards.length > 0 && (
        <div className="ui-drop-in">
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
              className="min-h-10 px-2"
            >
              <CaretUp size={14} />
              {t('blocks.ankiCards.collapse')}
            </NotionButton>
          </div>

          {/* 卡片列表（分页渲染，防止大量 iframe 崩溃） */}
          <div className="space-y-2">
            {cards.slice(0, visibleCount).map((card, index) => (
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
            {/* 加载更多按钮 */}
            {visibleCount < cards.length && (
              <div className="flex items-center justify-center gap-2 py-2">
                <NotionButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setVisibleCount((prev) => prev + CARDS_PAGE_SIZE)}
                  className="min-h-10 text-xs"
                >
                  {t('blocks.ankiCards.showMore', { remaining: cards.length - visibleCount })}
                </NotionButton>
                <NotionButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setVisibleCount(cards.length)}
                  className="min-h-10 text-xs text-muted-foreground"
                >
                  {t('blocks.ankiCards.showAll', { total: cards.length })}
                </NotionButton>
              </div>
            )}
            {/* 滚动锚点：新卡片到来时自动滚动到此处 */}
            <div ref={cardsEndRef} className="scroll-mb-48" />
          </div>

          {/* 错误/状态信息 */}
          {errorMessage && !shouldShowChatAnkiProgress && (
            <div role="alert" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-sm text-destructive">
              {errorMessage}
            </div>
          )}
        </div>
      )}

      {/* 底部操作区：移动端全宽，桌面端保持原布局 */}
      {(shouldShowChatAnkiProgress ||
        cards.length > 0 ||
        retryableTaskIds.length > 0 ||
        (Boolean(data?.documentId) &&
          (isBlockBusy ||
            data?.progress?.stage?.toLowerCase() === 'paused' ||
            data?.finalStatus?.toLowerCase() === 'paused'))) && (
        <FullWidthCardWrapper className="chatanki-bottom-actions">
          {shouldShowChatAnkiProgress && (
            <ChatAnkiProgressCompact
              progress={data?.progress}
              ankiConnect={data?.ankiConnect}
              warnings={data?.warnings}
              cardsCount={cards.length}
              blockStatus={block.status}
              finalStatus={data?.finalStatus}
              errorMessage={errorMessage}
              onRefreshAnkiConnect={handleRefreshAnkiConnect}
            />
          )}

          {/* 操作按钮组：有卡片，或运行中/暂停且有 documentId（暂停/继续/取消） */}
          {(cards.length > 0 ||
            retryableTaskIds.length > 0 ||
            (Boolean(data?.documentId) &&
              (isBlockBusy ||
                data?.progress?.stage?.toLowerCase() === 'paused' ||
                data?.finalStatus?.toLowerCase() === 'paused'))) && (
            <ActionButtons
              cards={cards}
              data={data}
              blockId={block.id}
              blockStatus={block.status}
              isStreaming={isStreaming}
              isExpanded={isExpanded}
              onToggleExpand={handleToggleExpand}
              retryableTaskCount={retryableTaskIds.length}
              retryStatus={retryStatus}
              retryError={retryError}
              onRetryFailedSegments={handleRetryFailedSegments}
              onSyncStatusChange={handleSyncStatusChange}
              onCardsPersisted={handleCardsPersisted}
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
