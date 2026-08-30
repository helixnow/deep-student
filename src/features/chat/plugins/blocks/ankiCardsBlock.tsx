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
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { cn } from '@/utils/cn';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { isMobilePlatform } from '@/utils/platform';
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
  Rows,
  SquaresFour,
  Quotes,
  Cards,
} from '@phosphor-icons/react';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
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
import { ClozeText, hasClozeMarkers } from './components/AnkiClozeText';
import {
  AnkiCardSkeleton,
  AnkiCompletionSummary,
  AnkiInlineUndoBar,
} from './components/ChatAnkiCardExtras';
import { parseAnkiSegmentCounts } from './components/ankiSegmentCounts';
import {
  isInternalAnkiField,
  parseCardQaFlags,
  summarizeQaFlags,
} from './components/ankiQaFlags';
import { AnkiQaFlagBadge, AnkiQaFlagsSummaryChip } from './components/AnkiQaFlagBadge';
import { AnkiCriticSummaryBanner } from './components/AnkiCriticSummaryBanner';
import { parseAnkiMediaReport } from './components/ankiMediaReport';
import { ImageOcclusionOverlay } from '@/components/anki/ImageOcclusionOverlay';
import {
  parseOcclusionSpec,
  type OcclusionSpec,
} from '@/components/anki/utils/imageOcclusion';
import { buildImageDataUrl } from '@/features/chat/context/imagePayload';
import {
  getAnkiBlockUiState,
  patchAnkiBlockUiState,
  getLastDeckNameInput,
  setLastDeckNameInput,
  type AnkiCardEditDraft,
  type AnkiCriticSummary,
  type AnkiGenerationStats,
} from './components/ankiCardsBlockState';
import { useMultiTemplateLoader } from '../../hooks/useMultiTemplateLoader';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import './components/chat-anki-cards.css';

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
  /** 生成失败时是否建议自动重试（onError 兜底写入） */
  shouldRetry?: boolean;
  availableCards?: number;
  recoveredCards?: number;
  issues?: AnkiCardsIssue[];
  /** 后端警告信息（用于 UI 显示） */
  warnings?: AnkiCardsWarning[];
  /**
   * APKG 媒体导入报告（`{declared, imported, skipped, skips: [{reason, count, filenames}], mediaDir}`）。
   * 弱类型透传自 tool_output，渲染前经 parseAnkiMediaReport 收紧。
   */
  mediaReport?: unknown;
  /**
   * 任务级 critic 摘要（anki_generation_event 的 CriticSummary 标签，
   * 适配器归一化后 patch 写入；仅 critic opt-in 且收尾成功时存在）。
   */
  criticSummary?: AnkiCriticSummary;
  /**
   * 流式生成质量统计（anki_generation_event 的 GenerationStats 标签，
   * 适配器归一化后 patch 写入）。
   */
  generationStats?: AnkiGenerationStats;
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

/**
 * 卡片是否已带真实持久化 ID（DB 已有行，后端 CAS 可保护并发编辑）。
 * anki_synthetic_* / chat-batch-* 为前端/批次生成的临时 ID。
 */
function hasRealCardId(card: Pick<AnkiCard, 'id'>): boolean {
  const id = typeof card.id === 'string' ? card.id.trim() : '';
  return id.length > 0 && !id.startsWith('anki_synthetic_') && !id.startsWith('chat-batch-');
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
    // 内部协议字段（如 _qa_flags）不进入编辑列表，也不拼进任何可见文本
    if (isInternalAnkiField(field)) return false;
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
    typeof finalStatus === 'string' ? finalStatus.trim().toLowerCase() : undefined;
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
// 子组件：Image Occlusion 预览
// ============================================================================

type OcclusionImageState = {
  imageRef: string;
  src: string | null;
  status: 'loading' | 'ready' | 'unavailable';
};

interface ResolvedOcclusionImage {
  found?: boolean;
  content?: string | null;
  metadata?: Record<string, unknown>;
}

const DIRECT_OCCLUSION_IMAGE_URL = /^(?:data:image\/|blob:|https?:|asset:)/i;
const VFS_OCCLUSION_SOURCE_ID = /^(?:att|file|img|image|res)_[a-z0-9_.-]+$/i;

function getVfsOcclusionSourceId(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  if (/^vfs:\/\//i.test(trimmed)) {
    const sourceId = trimmed.replace(/^vfs:\/\//i, '').replace(/^\/+/, '');
    return sourceId || null;
  }
  return VFS_OCCLUSION_SOURCE_ID.test(trimmed) ? trimmed : null;
}

function resolveImmediateOcclusionImageSrc(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  if (!trimmed) return null;
  if (DIRECT_OCCLUSION_IMAGE_URL.test(trimmed)) return trimmed;
  if (getVfsOcclusionSourceId(trimmed)) return null;
  // 拒绝未知 URL scheme；普通绝对/相对文件路径才交给 Tauri asset protocol。
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) {
    return null;
  }
  try {
    return convertFileSrc(trimmed);
  } catch {
    return null;
  }
}

function useOcclusionImage(imageRef: string): Pick<OcclusionImageState, 'src' | 'status'> {
  const vfsSourceId = useMemo(() => getVfsOcclusionSourceId(imageRef), [imageRef]);
  const immediateSrc = useMemo(
    () => resolveImmediateOcclusionImageSrc(imageRef),
    [imageRef],
  );
  const [resolved, setResolved] = useState<OcclusionImageState>(() => ({
    imageRef,
    src: immediateSrc,
    status: immediateSrc ? 'ready' : vfsSourceId ? 'loading' : 'unavailable',
  }));

  useEffect(() => {
    if (immediateSrc) {
      setResolved({ imageRef, src: immediateSrc, status: 'ready' });
      return;
    }
    if (!vfsSourceId) {
      setResolved({ imageRef, src: null, status: 'unavailable' });
      return;
    }

    let cancelled = false;
    setResolved({ imageRef, src: null, status: 'loading' });
    void invoke<ResolvedOcclusionImage[]>('vfs_resolve_resource_refs', {
      refs: [{
        sourceId: vfsSourceId,
        resourceId: vfsSourceId.startsWith('res_') ? vfsSourceId : undefined,
        resourceHash: '',
        type: 'image',
        name: vfsSourceId,
        injectModes: { image: ['image'] },
      }],
    })
      .then((resources) => {
        if (cancelled) return;
        const resource = resources[0];
        const mimeType =
          typeof resource?.metadata?.mimeType === 'string'
            ? resource.metadata.mimeType
            : 'image/png';
        const src =
          resource?.found && typeof resource.content === 'string'
            ? buildImageDataUrl(resource.content, mimeType)
            : null;
        setResolved({
          imageRef,
          src,
          status: src ? 'ready' : 'unavailable',
        });
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ imageRef, src: null, status: 'unavailable' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [imageRef, immediateSrc, vfsSourceId]);

  if (resolved.imageRef !== imageRef) {
    return {
      src: immediateSrc,
      status: immediateSrc ? 'ready' : vfsSourceId ? 'loading' : 'unavailable',
    };
  }
  return { src: resolved.src, status: resolved.status };
}

const AnkiOcclusionCardPreview: React.FC<{
  spec: OcclusionSpec;
  cardIndex: number;
}> = ({ spec, cardIndex }) => {
  const { t } = useTranslation('anki');
  const image = useOcclusionImage(spec.imageRef);
  return (
    <div
      data-testid="anki-occlusion-card-preview"
      data-card-index={cardIndex}
      className="rounded-lg border border-border/60 bg-muted/20 p-2"
    >
      <div className="flex justify-center">
        <div
          className={cn(
            'relative max-w-full overflow-hidden rounded-md bg-muted',
            image.src ? 'w-fit' : 'aspect-[4/3] w-80',
          )}
        >
          {image.src ? (
            <img
              src={image.src}
              alt={t('agent.occlusion.imageAlt')}
              loading="lazy"
              draggable={false}
              data-testid="anki-occlusion-image"
              className="block max-h-80 max-w-full object-contain"
            />
          ) : (
            <div
              aria-hidden="true"
              data-testid="anki-occlusion-image-placeholder"
              data-state={image.status}
              className="h-full min-h-32 w-full bg-muted"
            />
          )}
          <ImageOcclusionOverlay spec={spec} />
        </div>
      </div>
    </div>
  );
};

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
  /** 引用到聊天输入框（无干净入口时不传，按钮不显示） */
  onQuote?: (index: number) => void;
  disabled?: boolean;
  /** 虚拟滚动卸载时保留的未保存编辑草稿（进入编辑态时恢复） */
  initialDraft?: AnkiCardEditDraft | null;
  /** 草稿变化回写（null 表示编辑正常结束、清空草稿） */
  onDraftChange?: (draft: AnkiCardEditDraft | null) => void;
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
  onQuote,
  disabled,
  initialDraft,
  onDraftChange,
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
  // 质检标记（extra_fields._qa_flags）：结构化摘要展示，不拼进 back
  const qaFlags = useMemo(() => parseCardQaFlags(card), [card]);
  // 图像遮挡（extra_fields._occlusion）：坏 JSON / 坏结构收敛为 null，不影响普通卡。
  const occlusionSpec = useMemo(
    () => parseOcclusionSpec(card.extra_fields),
    [card.extra_fields],
  );

  const [editFieldOrder, setEditFieldOrder] = useState<string[]>([]);
  const [editFieldValues, setEditFieldValues] = useState<Record<string, string>>({});
  const [editTags, setEditTags] = useState((card.tags ?? []).join(', '));
  const [savePending, setSavePending] = useState(false);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  // 草稿保留：虚拟滚动卸载时把未保存的编辑内容写回模块级状态
  const draftRef = useRef<AnkiCardEditDraft | null>(null);
  const wasEditingRef = useRef(false);
  // 挂载时恢复的草稿只消费一次：取消编辑后再次进入不应复活旧草稿
  const initialDraftRef = useRef<AnkiCardEditDraft | null>(initialDraft ?? null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 编辑中被卸载（虚拟滚动）：保留草稿，回来时恢复
      if (wasEditingRef.current && draftRef.current) {
        onDraftChangeRef.current?.(draftRef.current);
      }
    };
  }, []);

  const syncDraftRef = useCallback(
    (fieldOrder: string[], values: Record<string, string>, tags: string) => {
      draftRef.current = { cardId: card.id, index, fieldOrder, values, tags };
    },
    [card.id, index]
  );

  // 当进入编辑模式时重置编辑值并聚焦；有匹配草稿时优先恢复草稿
  useEffect(() => {
    if (!isEditing) {
      // 编辑正常结束（保存/取消）：清空草稿
      if (wasEditingRef.current) {
        draftRef.current = null;
        onDraftChangeRef.current?.(null);
      }
      wasEditingRef.current = false;
      return;
    }
    const enteringEdit = !wasEditingRef.current;
    wasEditingRef.current = true;
    const restorable = initialDraftRef.current;
    initialDraftRef.current = null;
    const draft =
      draftRef.current ??
      (enteringEdit &&
      restorable &&
      (restorable.cardId ? restorable.cardId === card.id : restorable.index === index)
        ? restorable
        : null);
    if (draft) {
      setEditFieldOrder(draft.fieldOrder);
      setEditFieldValues(draft.values);
      setEditTags(draft.tags);
      syncDraftRef(draft.fieldOrder, draft.values, draft.tags);
    } else {
      const editableFields = resolveEditableFields(card, resolvedTemplate);
      setEditFieldOrder(editableFields.fieldOrder);
      setEditFieldValues(editableFields.values);
      const tags = (card.tags ?? []).join(', ');
      setEditTags(tags);
      syncDraftRef(editableFields.fieldOrder, editableFields.values, tags);
    }
    if (enteringEdit) {
      // 延迟聚焦，等待 DOM 渲染完成
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [isEditing, card, resolvedTemplate, index, syncDraftRef]);

  const handleSave = useCallback(() => {
    if (savePending) return;
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

    const result = onSave(index, {
      ...card,
      front: nextFront,
      back: nextBack,
      text: nextText,
      fields: nextFields,
      extra_fields: nextExtraFields,
      tags,
    });
    // 异步保存（DB 回写）期间给出即时 pending 反馈
    if (result instanceof Promise) {
      setSavePending(true);
      void result.finally(() => {
        if (mountedRef.current) setSavePending(false);
      });
    }
  }, [card, editFieldOrder, editFieldValues, editTags, index, onSave, savePending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Enter 保存（Shift+Enter 换行）；输入法组合中不触发。
      // 触屏软键盘没有 Shift+Enter，Enter 保持默认换行行为，保存只走按钮。
      const isComposing = (e.nativeEvent as KeyboardEvent).isComposing;
      if (e.key === 'Enter' && !e.shiftKey && !isComposing && !isTouchPrimary) {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onToggleEdit(index);
      }
    },
    [handleSave, index, isTouchPrimary, onToggleEdit]
  );

  const handleFieldChange = useCallback((field: string, value: string) => {
    setEditFieldValues((prev) => {
      const next = { ...prev, [field]: value };
      if (draftRef.current) {
        draftRef.current = { ...draftRef.current, values: next };
      }
      return next;
    });
  }, []);

  const handleTagsChange = useCallback((value: string) => {
    setEditTags(value);
    if (draftRef.current) {
      draftRef.current = { ...draftRef.current, tags: value };
    }
  }, []);

  const resolveFieldLabel = useCallback((field: string) => {
    const normalized = field.toLowerCase();
    if (normalized === 'front' || normalized === '正面') return t('chatV2.front');
    if (normalized === 'back' || normalized === '背面') return t('chatV2.back');
    if (normalized === 'text') return field;
    return field;
  }, [t]);

  const rawFront = card.front ?? card.fields?.Front ?? '';
  // 纯 cloze 卡（正面为空但 text 含挖空标记）回退展示 text，避免"无内容"
  const front = rawFront || (hasClozeMarkers(card.text) ? card.text ?? '' : '');
  const back = card.back ?? card.fields?.Back ?? '';

  if (isEditing) {
    return (
      <div className="border rounded-lg bg-card overflow-hidden ui-drop-in">
        {/* 编辑头部 */}
        <div className="flex items-center justify-between px-3 py-2 bg-accent/30 border-b">
          <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
            #{index + 1}
            {qaFlags.length > 0 && <AnkiQaFlagBadge flags={qaFlags} cardIndex={index} />}
          </span>
          <div className="flex items-center gap-1">
            <DsButton
              type="button"
              variant="ghost"
              onClick={() => onDelete(index)}
              className="!h-10 !w-10 text-destructive hover:text-destructive [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
              size="icon"
              iconOnly
              aria-label={t('chatV2.deleteCard')}
            >
              <Trash size={14} />
            </DsButton>
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
              onChange={(e) => handleTagsChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full"
              placeholder={t('enter_tags_comma_separated')}
            />
          </div>
          {/* 操作按钮 */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="text-xs text-muted-foreground mr-auto">
              {t('chatBlock.editHint')}
            </span>
            <DsButton
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onToggleEdit(index)}
              disabled={savePending}
              className="[@media(pointer:coarse)]:!min-h-11"
            >
              {t('chatV2.cancelEdit')}
            </DsButton>
            <DsButton
              type="button"
              size="sm"
              variant="primary"
              onClick={handleSave}
              disabled={savePending}
              aria-busy={savePending}
              className="[@media(pointer:coarse)]:!min-h-11"
            >
              {savePending ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              {t('chatV2.saveEdit')}
            </DsButton>
          </div>
        </div>
      </div>
    );
  }

  // 折叠态：卡片预览（可点击展开编辑）
  // 有模板时使用 ShadowDOM 渲染模板 HTML/CSS；否则纯文本
  // disabled（生成中且无真实 ID）只锁编辑/删除，翻面浏览始终可用
  if (useTemplateRender) {
    return (
      <div className="group relative transition-all duration-150 cursor-pointer">
        {/* 序号标签 */}
        <div data-wb-blur-surface className="absolute top-2 left-2 z-10 w-5 h-5 rounded-full bg-background/80 backdrop-blur flex items-center justify-center text-2xs font-medium text-muted-foreground border">
          {index + 1}
        </div>
        {/* 编辑/删除/引用按钮(触屏常显:卡片本体点击是翻面,编辑只能走此按钮) */}
        {!disabled && (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
            {onQuote && card.id && (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={(e) => { e.stopPropagation(); onQuote(index); }}
                data-wb-blur-surface
                className={cn(
                  'bg-background/80 backdrop-blur border hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
                  isTouchPrimary
                    ? '!h-11 !w-11 opacity-100'
                    : '!h-10 !w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                )}
                aria-label={t('chatBlock.quoteToInput')}
                title={t('chatBlock.quoteToInput')}
              >
                <Quotes size={isTouchPrimary ? 14 : 12} className="text-muted-foreground" />
              </DsButton>
            )}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={(e) => { e.stopPropagation(); onToggleEdit(index); }}
              data-wb-blur-surface
              className={cn(
                'bg-background/80 backdrop-blur border hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
                isTouchPrimary
                  ? '!h-11 !w-11 opacity-100'
                  : '!h-10 !w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
              )}
              aria-label={t('chatV2.editCard', { index: index + 1 })}
              title={t('chatV2.editInline')}
            >
              <Pencil size={isTouchPrimary ? 14 : 12} className="text-muted-foreground" />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={(e) => { e.stopPropagation(); onDelete(index); }}
              data-wb-blur-surface
              className={cn(
                'bg-background/80 backdrop-blur border hover:bg-destructive/10 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11',
                isTouchPrimary
                  ? '!h-11 !w-11 opacity-100'
                  : '!h-10 !w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
              )}
              aria-label={t('chatV2.deleteCard')}
              title={t('chatV2.deleteCard')}
            >
              <Trash size={isTouchPrimary ? 14 : 12} className="text-destructive/80" />
            </DsButton>
          </div>
        )}
        {/* 模板渲染预览（翻面浏览不受编辑锁影响） */}
        {occlusionSpec && (
          <div className="px-3 pt-3">
            <AnkiOcclusionCardPreview spec={occlusionSpec} cardIndex={index} />
          </div>
        )}
        <RenderedAnkiCard
          card={card}
          template={resolvedTemplate!}
          flippable
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
        {/* 质检标记摘要（模板渲染下方，结构化展示，不进 back） */}
        {qaFlags.length > 0 && (
          <div className="px-3 pb-2" onClick={(e) => e.stopPropagation()}>
            <AnkiQaFlagBadge flags={qaFlags} cardIndex={index} />
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
      {occlusionSpec && (
        <div className="px-3 pt-3">
          <AnkiOcclusionCardPreview spec={occlusionSpec} cardIndex={index} />
        </div>
      )}
      <div className="flex items-start gap-3 p-3">
        {/* 序号 */}
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground mt-0.5">
          {index + 1}
        </span>
        {/* 内容（cloze 挖空高亮：正面隐藏、背面显示答案） */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {front
              ? <ClozeText text={front} revealed={false} />
              : <span className="text-muted-foreground italic">{t('chatV2.noContent')}</span>}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {back
              ? <ClozeText text={back} revealed />
              : <span className="italic">{t('chatV2.noContent')}</span>}
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
          {/* 质检标记摘要（结构化展示，不拼进 back 文本） */}
          {qaFlags.length > 0 && (
            <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
              <AnkiQaFlagBadge flags={qaFlags} cardIndex={index} />
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
  /** 保存/导出/同步共用的牌组名（用户可在牌组选择器中修改） */
  deckName: string;
  onDeckNameChange: (deckName: string) => void;
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
  deckName,
  onDeckNameChange,
  onSyncStatusChange,
  onCardsPersisted,
}) => {
  const { t } = useTranslation('chatV2');
  const [saveStatus, setSaveStatus] = useState<ActionStatus>('idle');
  const [exportStatus, setExportStatus] = useState<ActionStatus>('idle');
  const [syncStatus, setSyncStatus] = useState<ActionStatus>('idle');
  const [taskControlStatus, setTaskControlStatus] = useState<ActionStatus>('idle');
  /** 记录当前点击的是哪个任务控制按钮，pending/结果反馈只落在该按钮上 */
  const [pendingTaskAction, setPendingTaskAction] = useState<'pause' | 'resume' | 'cancel' | null>(null);

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
      // 用户选择的牌组名优先于生成期 options 中的 deck_name
      options: {
        ...(data?.options ?? {}),
        deck_name: deckName,
      } as AnkiGenerationOptions,
    }),
    [blockId, data, deckName]
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
      setPendingTaskAction(action);
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
      const result = await exportCardsAsApkg({ cards, context, deckName });
      if (result.cancelled) {
        // 用户取消了文件保存对话框，静默恢复，不显示错误
        setExportStatus('idle');
        actionLockRef.current.delete('export');
        return;
      }
      if (!result.success || !result.filePath) throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'export', cardCount: cards.length }, context);
      setExportStatus('success');
      const exportNote = t('blocks.ankiCards.action.exportNewCardsNote');
      if (result.skippedErrorCards && result.skippedErrorCards > 0) {
        showGlobalNotification('warning', t('blocks.ankiCards.action.exportSkippedErrorsWithNote', {
          exported: cards.length - result.skippedErrorCards,
          skipped: result.skippedErrorCards,
          note: exportNote,
        }), result.filePath);
      } else {
        showGlobalNotification('success', t('blocks.ankiCards.action.apkgExportedWithNote', {
          note: exportNote,
        }), result.filePath);
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
  }, [cards, context, deckName, exportStatus, resetStatusAfterDelay, t]);

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
      const result = await importCardsViaAnkiConnect({ cards, context, deckName });
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
  }, [cards, context, deckName, syncStatus, resetStatusAfterDelay, onSyncStatusChange, t]);

  // 整批交付动作（加入卡片库/导出/同步/复习这批）仍等终态；
  // 展开浏览按动作粒度解锁，生成中即可用（见下方 expand 按钮）。
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
        return <Check size={16} className="text-success" />;
      case 'error':
        return <X size={16} className="text-destructive" />;
      default:
        return <DefaultIcon size={16} />;
    }
  };

  const retryAction = showRetryFailedSegments ? (
    <div className="col-span-2 flex min-w-0 flex-col items-start gap-1 sm:col-span-1">
      <DsButton
        type="button"
        onClick={() => void onRetryFailedSegments()}
        disabled={retryStatus === 'loading'}
        aria-busy={retryStatus === 'loading'}
        variant={retryStatus === 'error' ? 'danger' : 'default'}
        className="min-h-10 [@media(pointer:coarse)]:!min-h-11 w-full text-xs sm:w-auto sm:text-sm"
      >
        {renderIcon(retryStatus, ArrowClockwise)}
        {t('blocks.ankiCards.retryFailedSegments')}
      </DsButton>
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

      {/* 运行中：暂停 / 继续 / 取消（有 documentId 时）。
          pending/成功/失败反馈只落在被点击的按钮上，其余按钮仅禁用。 */}
      {showTaskControls && (
        <>
          {isPaused ? (
            <DsButton
              type="button"
              onClick={() => void handleTaskControl('resume')}
              disabled={taskControlStatus === 'loading'}
              aria-busy={taskControlStatus === 'loading' && pendingTaskAction === 'resume'}
              variant="primary"
              className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs sm:text-sm"
            >
              {taskControlStatus !== 'idle' && pendingTaskAction === 'resume'
                ? renderIcon(taskControlStatus, Play)
                : <Play size={14} />}
              {t('blocks.ankiCards.resume')}
            </DsButton>
          ) : (
            <DsButton
              type="button"
              onClick={() => void handleTaskControl('pause')}
              disabled={taskControlStatus === 'loading'}
              aria-busy={taskControlStatus === 'loading' && pendingTaskAction === 'pause'}
              variant="default"
              className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs sm:text-sm"
            >
              {taskControlStatus !== 'idle' && pendingTaskAction === 'pause'
                ? renderIcon(taskControlStatus, Pause)
                : <Pause size={14} />}
              {t('blocks.ankiCards.pause')}
            </DsButton>
          )}
          <DsButton
            type="button"
            onClick={() => void handleTaskControl('cancel')}
            disabled={taskControlStatus === 'loading'}
            aria-busy={taskControlStatus === 'loading' && pendingTaskAction === 'cancel'}
            variant="danger"
            className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs sm:text-sm"
          >
            {taskControlStatus !== 'idle' && pendingTaskAction === 'cancel'
              ? renderIcon(taskControlStatus, Stop)
              : <Stop size={14} />}
            {t('blocks.ankiCards.cancel')}
          </DsButton>
        </>
      )}

      {cards.length > 0 && (
        <>
          {/* 内联展开/折叠编辑：生成中也允许展开浏览 */}
          <DsButton
            type="button"
            onClick={onToggleExpand}
            variant={isExpanded ? 'default' : 'primary'}
            className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs sm:text-sm"
          >
            {isExpanded ? <CaretUp size={14} /> : <Pencil size={14} />}
            {isExpanded ? t('blocks.ankiCards.collapse') : t('blocks.ankiCards.edit')}
          </DsButton>

          {/* 加入本地卡片库 */}
          <DsButton
            type="button"
            onClick={handleSave}
            disabled={isDisabled || saveStatus === 'loading'}
            variant={saveStatus === 'success' ? 'success' : saveStatus === 'error' ? 'danger' : canReviewBatch ? 'default' : 'primary'}
            className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs sm:text-sm"
          >
            {renderIcon(saveStatus, FloppyDisk)}
            {t(
              saveStatus === 'success'
                ? 'blocks.ankiCards.addedToLibrary'
                : 'blocks.ankiCards.addToLibrary'
            )}
          </DsButton>

          {/* 复习这批 → workbench 闪卡会话（OS 模式专属；移动端隐藏避免死路动作） */}
          {!isMobilePlatform() && (
          <DsButton
            type="button"
            onClick={handleReviewBatch}
            disabled={isDisabled || !canReviewBatch}
            title={!canReviewBatch ? t('blocks.ankiCards.reviewBatchNeedsRealIds') : undefined}
            variant="primary"
            className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs sm:text-sm"
          >
            <Stack size={16} />
            {t('blocks.ankiCards.reviewBatch')}
          </DsButton>
          )}

          {/* 牌组名选择：保存/导出/同步共用（默认取生成 options，会话内记住上次输入） */}
          <Popover>
            <PopoverTrigger asChild>
              <DsButton
                type="button"
                variant="ghost"
                className="min-h-10 [@media(pointer:coarse)]:!min-h-11 max-w-[180px] text-xs text-muted-foreground sm:text-sm"
                title={t('blocks.ankiCards.deckName')}
                aria-label={t('blocks.ankiCards.deckName')}
              >
                <Cards size={14} />
                <span className="truncate">{deckName}</span>
              </DsButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 rounded-lg border bg-popover p-3 shadow-md">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('blocks.ankiCards.deckName')}
              </label>
              <Input
                type="text"
                value={deckName}
                onChange={(e) => onDeckNameChange(e.target.value)}
                placeholder={t('blocks.ankiCards.deckNamePlaceholder')}
                className="w-full"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('blocks.ankiCards.deckNameHint')}
              </p>
            </PopoverContent>
          </Popover>

          {/* 低频交付动作收进菜单，避免与编辑/复习争夺主层级。 */}
          <AppMenu>
            <AppMenuTrigger asChild>
              <DsButton
                type="button"
                variant="ghost"
                size="icon"
                iconOnly
                className="!h-10 !w-10 justify-self-end [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
                aria-label={t('blocks.ankiCards.moreActions')}
                title={t('blocks.ankiCards.moreActions')}
              >
                <DotsThree size={20} />
              </DsButton>
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

/** 单卡删除的撤销窗口：窗口结束才真正提交 DB 删除 */
const UNDO_DELETE_WINDOW_MS = 6000;

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
  const { t: tAnki } = useTranslation('anki');
  const data = block.toolOutput as AnkiCardsBlockData | undefined;
  // useMemo 固定空数组引用：`data?.cards || []` 每次渲染都会生成新数组，
  // 导致依赖 cards 的 effect/memo（调试上报、模板 id 提取等）在流式期间每帧重跑
  const cards = useMemo(() => data?.cards ?? [], [data?.cards]);
  const isBlockBusy = block.status === 'pending' || block.status === 'running';
  // 按动作粒度解锁：生成中允许展开浏览；已带真实 ID 的卡允许单卡编辑/删除
  //（DB 已有行，后端 CAS 保护并发）；整批操作仍由 ActionButtons 内部门控。
  const isGenerating = isBlockBusy || Boolean(isStreaming);
  const documentId = typeof data?.documentId === 'string' ? data.documentId.trim() : '';
  const [retryableTaskIds, setRetryableTaskIds] = useState<string[]>([]);
  const [retryStatus, setRetryStatus] = useState<ActionStatus>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryActionLockRef = useRef(false);
  const retryScopeRef = useRef(0);
  const retryableCountHint = useMemo((): { failed: number; truncated: number } => {
    const counts = parseAnkiSegmentCounts(data?.progress?.counts);
    return {
      failed: counts?.failed ?? 0,
      truncated: counts?.truncated ?? 0,
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

  // 展开/编辑/分页/多选等 UI 状态：初始值从模块级 Map 恢复（虚拟滚动卸载不丢），
  // 变化时写回 Map（见下方持久化 effect）。
  const [isExpanded, setIsExpanded] = useState(() => getAnkiBlockUiState(block.id).isExpanded);
  // 展开态布局：紧凑列表 / 双列网格
  const [layout, setLayout] = useState<'list' | 'grid'>(() => getAnkiBlockUiState(block.id).layout);
  // 当前正在编辑的卡片索引（-1 表示无）
  const [editingIndex, setEditingIndex] = useState(() => getAnkiBlockUiState(block.id).editingIndex);
  // 分页：限制同时渲染的卡片数量，防止大量 iframe 导致浏览器卡顿/崩溃
  const CARDS_PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.max(getAnkiBlockUiState(block.id).visibleCount, CARDS_PAGE_SIZE)
  );
  // 多选集合（卡片 id）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(getAnkiBlockUiState(block.id).selectedIds)
  );
  // 挂载时恢复的未保存编辑草稿（只消费一次，由 InlineCardItem 判定归属）
  const [restoredDraft] = useState<AnkiCardEditDraft | null>(
    () => getAnkiBlockUiState(block.id).editDraft
  );
  // 保存/导出/同步共用的牌组名：块级记忆 > 会话内上次输入 > 生成 options > Default
  const [deckName, setDeckName] = useState(() =>
    getAnkiBlockUiState(block.id).deckName ??
    getLastDeckNameInput() ??
    ((block.toolOutput as AnkiCardsBlockData | undefined)?.options?.deck_name || 'Default')
  );

  // UI 状态写回模块级 Map（虚拟滚动卸载后重挂可恢复）
  useEffect(() => {
    patchAnkiBlockUiState(block.id, {
      isExpanded,
      layout,
      editingIndex,
      visibleCount,
      selectedIds: [...selectedIds],
      deckName,
    });
  }, [block.id, isExpanded, layout, editingIndex, visibleCount, selectedIds, deckName]);

  const handleDeckNameChange = useCallback((value: string) => {
    setDeckName(value);
    setLastDeckNameInput(value);
  }, []);

  const handleDraftChange = useCallback(
    (draft: AnkiCardEditDraft | null) => {
      patchAnkiBlockUiState(block.id, { editDraft: draft });
    },
    [block.id]
  );

  // 展开态卡片列表末尾的 ref（用于自动滚动到新卡片）
  const cardsEndRef = useRef<HTMLDivElement>(null);
  // 记录上次卡片数量，仅在增长时滚动。
  // 初始化为当前数量：isExpanded 从模块级状态恢复后，虚拟滚动重挂不应触发自动滚动。
  const prevCardsCountRef = useRef(cards.length);

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

  // APKG 媒体导入报告（tool_output.mediaReport）：解析失败/缺失时为 null
  const mediaReport = useMemo(() => parseAnkiMediaReport(data?.mediaReport), [data?.mediaReport]);

  // 质检标记块级摘要：N 张卡片带 _qa_flags（用于完成态复查提示）
  const qaFlagsSummary = useMemo(() => summarizeQaFlags(cards), [cards]);

  // 折叠预览最多与既有纯文本栈一致展示前 5 张卡；只收录可安全解析的遮挡卡。
  const occlusionPreviewCards = useMemo(
    () => cards
      .map((card, index) => ({
        card,
        index,
        spec: parseOcclusionSpec(card.extra_fields),
      }))
      .filter(
        (entry): entry is { card: AnkiCard; index: number; spec: OcclusionSpec } =>
          entry.spec !== null,
      )
      .slice(0, 5),
    [cards],
  );

  const shouldShowChatAnkiProgress = hasProgress || hasAnkiConnect || mediaReport !== null;

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

  // ==========================================================================
  // 删除 + 撤销（支持批量）：乐观更新（先移除 UI 投影），
  // 撤销窗口结束后才提交 DB 删除；一个撤销窗口覆盖整个选择集。
  // 提交失败自动回滚（恢复卡片投影），窗口内可一键撤销。
  // ==========================================================================
  type PendingDeleteEntry = { card: AnkiCard; index: number };
  const [pendingDelete, setPendingDelete] = useState<{ entries: PendingDeleteEntry[] } | null>(null);
  const pendingDeleteRef = useRef<{ entries: PendingDeleteEntry[] } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 删除退出动画：先标记 exiting，动画结束后才真正从投影移除
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tAnkiRef = useRef(tAnki);
  tAnkiRef.current = tAnki;

  // 把卡片恢复到 store 投影（撤销 / DB 删除失败回滚共用）
  const restoreDeletedCards = useCallback(
    (entries: PendingDeleteEntry[]) => {
      if (!store || entries.length === 0) return;
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const nextCards = [...(latestData.cards ?? [])];
      let changed = false;
      // 按原索引升序插回，尽量还原原相对位置
      [...entries]
        .sort((a, b) => a.index - b.index)
        .forEach((entry) => {
          // 流式更新可能已重新带回同 id 卡片，避免重复插入
          if (entry.card.id && nextCards.some((card) => card.id === entry.card.id)) return;
          const insertAt = Math.min(Math.max(entry.index, 0), nextCards.length);
          nextCards.splice(insertAt, 0, entry.card);
          changed = true;
        });
      if (!changed) return;
      const newData: AnkiCardsBlockData = { ...latestData, cards: nextCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      void persistToolOutput(newData);
    },
    [store, block.id, persistToolOutput]
  );

  // 提交待删除卡片的 DB 删除（撤销窗口结束 / 新删除到来时触发）
  const flushPendingDelete = useCallback(() => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    pendingDeleteRef.current = null;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPendingDelete(null);
    pending.entries.forEach((entry) => {
      // 无持久 ID 的卡片不存在 DB 行，无需提交
      if (!entry.card.id) return;
      void invoke('delete_anki_card', { cardId: entry.card.id }).catch((err: unknown) => {
        // DB 删除失败：回滚投影并明确告知
        console.warn('[AnkiCardsBlock] Failed to commit card delete to anki DB:', err);
        restoreDeletedCards([entry]);
        showGlobalNotification('warning', tAnki('chatBlock.deleteCommitFailed'));
      });
    });
  }, [restoreDeletedCards, tAnki]);

  // 组件卸载（虚拟滚动等）时若还有未提交的删除：直接提交（不再可撤销），
  // 避免投影与 DB 漂移，并用全局 toast 告知用户撤销窗口已结束。
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      const pending = pendingDeleteRef.current;
      pendingDeleteRef.current = null;
      if (!pending) return;
      pending.entries.forEach((entry) => {
        if (!entry.card.id) return;
        void invoke('delete_anki_card', { cardId: entry.card.id }).catch(() => undefined);
      });
      showGlobalNotification(
        'info',
        tAnkiRef.current('chatBlock.deleteCommittedOnLeave', { count: pending.entries.length })
      );
    };
  }, []);

  // 立即执行删除（乐观移除投影 + 打开撤销窗口）。targets 支持按 id（优先）或索引解析。
  const commitDeleteCards = useCallback(
    (targets: Array<{ id?: string; index: number }>) => {
      if (!store || targets.length === 0) return;
      // 同一时刻只保留一个撤销窗口：先提交上一个
      flushPendingDelete();
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const latestCards = latestData.cards ?? [];
      // 以最新 store 解析目标（流式期间索引可能漂移，优先按 id 匹配）
      const removeIndices = new Set<number>();
      targets.forEach((target) => {
        if (target.id) {
          const byId = latestCards.findIndex((card) => card.id === target.id);
          if (byId >= 0) removeIndices.add(byId);
          return;
        }
        if (target.index >= 0 && target.index < latestCards.length) {
          removeIndices.add(target.index);
        }
      });
      if (removeIndices.size === 0) return;
      const entries: PendingDeleteEntry[] = [...removeIndices]
        .sort((a, b) => a - b)
        .map((index) => ({ card: latestCards[index], index }));
      const newCards = latestCards.filter((_, i) => !removeIndices.has(i));
      const newData: AnkiCardsBlockData = { ...latestData, cards: newCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      void persistToolOutput(newData);
      // 🔧 删除非编辑中的卡片时，正确调整 editingIndex 避免偏移到错误卡片
      setEditingIndex((prev) => {
        if (prev < 0) return prev;
        if (removeIndices.has(prev)) return -1;
        const shift = [...removeIndices].filter((i) => i < prev).length;
        return prev - shift;
      });
      // 从多选集合中清掉已删除的卡片
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        entries.forEach((entry) => {
          if (entry.card.id) next.delete(entry.card.id);
        });
        return next;
      });
      setExitingIds(new Set());
      const pending = { entries };
      pendingDeleteRef.current = pending;
      setPendingDelete(pending);
      undoTimerRef.current = setTimeout(() => {
        flushPendingDelete();
      }, UNDO_DELETE_WINDOW_MS);
      logChatAnkiEvent('chat_anki_card_deleted', {
        indices: entries.map((entry) => entry.index),
        count: entries.length,
        blockId: block.id,
      });
    },
    [store, block.id, persistToolOutput, flushPendingDelete]
  );

  // 请求删除：先播放退出动画（高度塌缩+淡出），动画结束后真正提交。
  // prefers-reduced-motion 下直接删除，遵守既有降级模式。
  const requestDeleteCards = useCallback(
    (targets: Array<{ id?: string; index: number }>) => {
      if (targets.length === 0) return;
      const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animatableIds = targets
        .map((target) => target.id)
        .filter((id): id is string => Boolean(id));
      if (reduceMotion || animatableIds.length === 0 || exitTimerRef.current) {
        commitDeleteCards(targets);
        return;
      }
      setExitingIds(new Set(animatableIds));
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        commitDeleteCards(targets);
      }, 220);
    },
    [commitDeleteCards]
  );

  // 单卡删除入口（InlineCardItem onDelete）
  const handleDeleteCard = useCallback(
    (index: number) => {
      const card = cards[index];
      requestDeleteCards([{ id: card?.id, index }]);
    },
    [cards, requestDeleteCards]
  );

  // 撤销删除：取消提交定时器并恢复投影（覆盖整个选择集）
  const handleUndoDelete = useCallback(() => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    restoreDeletedCards(pending.entries);
    logChatAnkiEvent('chat_anki_card_delete_undone', {
      indices: pending.entries.map((entry) => entry.index),
      count: pending.entries.length,
      blockId: block.id,
    });
  }, [restoreDeletedCards, block.id]);

  // ==========================================================================
  // 多选与批量操作：checkbox 选择集 + 批量删除/保存所选/导出所选
  // ==========================================================================
  const selectableIds = useMemo(
    () => cards.map((card) => card.id).filter((id): id is string => Boolean(id)),
    [cards]
  );
  // 只统计仍存在于当前卡片列表的选中项（流式/删除后自动收敛）
  const selectedCards = useMemo(
    () => cards.filter((card) => card.id && selectedIds.has(card.id)),
    [cards, selectedIds]
  );
  const selectedCount = selectedCards.length;
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;

  const handleToggleSelect = useCallback((cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const hasAll = selectableIds.length > 0 && selectableIds.every((id) => prev.has(id));
      return hasAll ? new Set<string>() : new Set(selectableIds);
    });
  }, [selectableIds]);

  const handleInvertSelection = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      selectableIds.forEach((id) => {
        if (!prev.has(id)) next.add(id);
      });
      return next;
    });
  }, [selectableIds]);

  // 批量删除：一个撤销窗口覆盖整个选择集
  const handleDeleteSelected = useCallback(() => {
    if (selectedCards.length === 0) return;
    requestDeleteCards(
      selectedCards.map((card) => ({ id: card.id, index: cards.indexOf(card) }))
    );
  }, [selectedCards, cards, requestDeleteCards]);

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

  // ==========================================================================
  // 完成态小结条：N 张卡 · 用时 · 任务中心 / 导出内联入口
  // ==========================================================================
  const showCompletionSummary =
    block.status === 'success' &&
    cards.length > 0 &&
    (previewStatus === 'ready' || previewStatus === 'stored');

  const durationText = useMemo(() => {
    if (!block.startedAt || !block.endedAt) return null;
    const elapsedMs = block.endedAt - block.startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
    const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
    const duration =
      totalSeconds < 60
        ? tAnki('chatBlock.durationSeconds', { count: totalSeconds })
        : tAnki('chatBlock.durationMinutes', {
            minutes: Math.floor(totalSeconds / 60),
            seconds: totalSeconds % 60,
          });
    return tAnki('chatBlock.summaryDuration', { duration });
  }, [block.startedAt, block.endedAt, tAnki]);

  const summaryContext = useMemo(
    () => ({
      documentId: data?.documentId ?? null,
      businessSessionId: data?.businessSessionId ?? null,
      messageStableId: data?.messageStableId ?? null,
      blockId: block.id,
      templateId: data?.templateId ?? null,
      options: {
        ...(data?.options ?? {}),
        deck_name: deckName,
      } as AnkiGenerationOptions,
    }),
    [data, block.id, deckName]
  );

  const [summaryExportPending, setSummaryExportPending] = useState(false);
  const handleSummaryExport = useCallback(async () => {
    if (cards.length === 0 || summaryExportPending) return;
    setSummaryExportPending(true);
    try {
      const result = await exportCardsAsApkg({ cards, context: summaryContext, deckName });
      if (result.cancelled) return;
      if (!result.success || !result.filePath) {
        throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      }
      logChatAnkiEvent(
        'chat_anki_action_performed',
        { action: 'export', cardCount: cards.length, entry: 'completion_summary' },
        summaryContext,
      );
      showGlobalNotification(
        'success',
        t('blocks.ankiCards.action.apkgExportedWithNote', {
          note: t('blocks.ankiCards.action.exportNewCardsNote'),
        }),
        result.filePath,
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Summary export failed:', msg);
      showGlobalNotification('error', t('blocks.ankiCards.action.exportFailedWithHint'), msg);
    } finally {
      setSummaryExportPending(false);
    }
  }, [cards, summaryContext, summaryExportPending, deckName, t]);

  // ==========================================================================
  // 批量操作条：保存所选 / 导出所选（复用 chatAnkiActions，传选择子集）
  // ==========================================================================
  const [batchAction, setBatchAction] = useState<'save' | 'export' | null>(null);

  const handleSaveSelected = useCallback(async () => {
    if (selectedCards.length === 0 || batchAction) return;
    setBatchAction('save');
    try {
      const result = await saveCardsToLibrary({ cards: selectedCards, context: summaryContext });
      if (!result.success) {
        throw new Error(result.error || t('blocks.ankiCards.action.saveFailed'));
      }
      await handleCardsPersisted(result.cardIdMappings ?? []);
      logChatAnkiEvent(
        'chat_anki_action_performed',
        { action: 'save_selected', cardCount: result.savedCount },
        summaryContext,
      );
      showGlobalNotification(
        'success',
        t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount }),
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Save selected failed:', msg);
      showGlobalNotification(
        'error',
        t('blocks.ankiCards.action.saveFailedWithHint'),
        t('blocks.ankiCards.action.saveFailedDetail', { detail: msg }),
      );
    } finally {
      setBatchAction(null);
    }
  }, [selectedCards, batchAction, summaryContext, handleCardsPersisted, t]);

  const handleExportSelected = useCallback(async () => {
    if (selectedCards.length === 0 || batchAction) return;
    setBatchAction('export');
    try {
      const result = await exportCardsAsApkg({ cards: selectedCards, context: summaryContext, deckName });
      if (result.cancelled) return;
      if (!result.success || !result.filePath) {
        throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      }
      logChatAnkiEvent(
        'chat_anki_action_performed',
        { action: 'export_selected', cardCount: selectedCards.length },
        summaryContext,
      );
      showGlobalNotification(
        'success',
        t('blocks.ankiCards.action.apkgExportedWithNote', {
          note: t('blocks.ankiCards.action.exportNewCardsNote'),
        }),
        result.filePath,
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Export selected failed:', msg);
      showGlobalNotification('error', t('blocks.ankiCards.action.exportFailedWithHint'), msg);
    } finally {
      setBatchAction(null);
    }
  }, [selectedCards, batchAction, summaryContext, deckName, t]);

  // "引用到输入框"：向聊天输入框注入 `卡片#N（id: xxx）` 文本
  const handleQuoteCard = useMemo(() => {
    if (!store) return undefined;
    return (index: number) => {
      const latestData = store.getState().blocks.get(block.id)?.toolOutput as
        | AnkiCardsBlockData
        | undefined;
      const card = (latestData?.cards ?? [])[index];
      if (!card?.id) return;
      const quote = t('blocks.ankiCards.quoteText', { index: index + 1, id: card.id });
      const state = store.getState();
      const current = state.inputValue ?? '';
      state.setInputValue(current ? `${current.replace(/\s+$/, '')} ${quote} ` : `${quote} `);
      logChatAnkiEvent('chat_anki_card_quoted', { index, blockId: block.id });
    };
  }, [store, block.id, t]);

  const handleOpenTaskCenter = useCallback(() => {
    workbenchBus.launch({ typeId: 'taskDashboard', reason: 'api' });
    logChatAnkiEvent(
      'chat_anki_action_performed',
      { action: 'open_task_center', cardCount: cards.length },
      summaryContext,
    );
  }, [cards.length, summaryContext]);

  return (
    <div className="chat-v2-anki-cards-block">
      {/* 折叠态：卡片预览 */}
      {!isExpanded && (
        <>
          {occlusionPreviewCards.length > 0 && (
            <div
              data-testid="anki-occlusion-preview-gallery"
              className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {occlusionPreviewCards.map(({ card, index, spec }) => (
                <AnkiOcclusionCardPreview
                  key={card.id || `occlusion-${index}`}
                  spec={spec}
                  cardIndex={index}
                />
              ))}
            </div>
          )}
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
            disabled={false}
            onClick={cards.length > 0 ? handleToggleExpand : undefined}
          />
        </>
      )}

      {/* 展开态：内联卡片编辑列表 */}
      {isExpanded && cards.length > 0 && (
        <div className="ui-drop-in">
          {/* 头部统计 + 全选 + 布局切换 */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              {selectableIds.length > 0 && (
                <Checkbox
                  checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                  onCheckedChange={handleToggleSelectAll}
                  aria-label={t('blocks.ankiCards.selectAll')}
                  title={t('blocks.ankiCards.selectAll')}
                />
              )}
              <span className="truncate">
                {t('blocks.ankiCards.title')} · {cards.length} {t('blocks.ankiCards.cards')}
              </span>
            </span>
            <div className="flex items-center gap-1">
              <DsButton
                type="button"
                variant={layout === 'list' ? 'default' : 'ghost'}
                size="icon"
                iconOnly
                onClick={() => setLayout('list')}
                className="relative !h-8 !w-8 after:absolute after:-inset-1.5 after:content-['']"
                aria-pressed={layout === 'list'}
                aria-label={tAnki('chatBlock.layoutList')}
                title={tAnki('chatBlock.layoutList')}
              >
                <Rows size={14} />
              </DsButton>
              <DsButton
                type="button"
                variant={layout === 'grid' ? 'default' : 'ghost'}
                size="icon"
                iconOnly
                onClick={() => setLayout('grid')}
                className="relative !h-8 !w-8 after:absolute after:-inset-1.5 after:content-['']"
                aria-pressed={layout === 'grid'}
                aria-label={tAnki('chatBlock.layoutGrid')}
                title={tAnki('chatBlock.layoutGrid')}
              >
                <SquaresFour size={14} />
              </DsButton>
              <DsButton
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleToggleExpand}
                className="min-h-10 [@media(pointer:coarse)]:!min-h-11 px-2"
              >
                <CaretUp size={14} />
                {t('blocks.ankiCards.collapse')}
              </DsButton>
            </div>
          </div>

          {/* 批量操作条：已选 N 张 + 反选/删除/保存/导出所选 */}
          {selectedCount > 0 && (
            <div
              className="ui-drop-in mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
              data-testid="chatanki-batch-bar"
            >
              <span className="text-xs font-medium text-foreground">
                {t('blocks.ankiCards.selectedCount', { count: selectedCount })}
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-1">
                <DsButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleInvertSelection}
                  className="min-h-8 [@media(pointer:coarse)]:!min-h-11 text-xs"
                >
                  {t('blocks.ankiCards.invertSelection')}
                </DsButton>
                <DsButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleDeleteSelected}
                  disabled={batchAction !== null}
                  className="min-h-8 [@media(pointer:coarse)]:!min-h-11 text-xs text-destructive hover:text-destructive"
                >
                  <Trash size={13} />
                  {t('blocks.ankiCards.deleteSelected')}
                </DsButton>
                <DsButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleSaveSelected()}
                  disabled={batchAction !== null || isGenerating}
                  aria-busy={batchAction === 'save'}
                  className="min-h-8 [@media(pointer:coarse)]:!min-h-11 text-xs"
                >
                  {batchAction === 'save' ? (
                    <CircleNotch size={13} className="animate-spin" />
                  ) : (
                    <FloppyDisk size={13} />
                  )}
                  {t('blocks.ankiCards.saveSelected')}
                </DsButton>
                <DsButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleExportSelected()}
                  disabled={batchAction !== null || isGenerating}
                  aria-busy={batchAction === 'export'}
                  className="min-h-8 [@media(pointer:coarse)]:!min-h-11 text-xs"
                >
                  {batchAction === 'export' ? (
                    <CircleNotch size={13} className="animate-spin" />
                  ) : (
                    <DownloadSimple size={13} />
                  )}
                  {t('blocks.ankiCards.exportSelected')}
                </DsButton>
              </span>
            </div>
          )}

          {/* 卡片列表（分页渲染，防止大量 iframe 崩溃；逐张 stagger 入场） */}
          <div
            className={cn(
              layout === 'grid'
                ? 'grid grid-cols-1 gap-2 sm:grid-cols-2'
                : 'space-y-2'
            )}
          >
            {cards.slice(0, visibleCount).map((card, index) => (
              <div
                key={card.id || `card-${index}`}
                className={cn(
                  'canki-card-enter flex items-start gap-2',
                  card.id && exitingIds.has(card.id) && 'canki-card-exit',
                  layout === 'grid' && editingIndex === index && 'sm:col-span-2'
                )}
                style={{ '--canki-stagger': `${Math.min(index, 10) * 35}ms` } as React.CSSProperties}
              >
                {card.id && (
                  <Checkbox
                    checked={selectedIds.has(card.id)}
                    onCheckedChange={() => handleToggleSelect(card.id as string)}
                    aria-label={t('blocks.ankiCards.selectCard', { index: index + 1 })}
                    className="mt-3 flex-shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <InlineCardItem
                    card={card}
                    index={index}
                    isEditing={editingIndex === index}
                    template={template}
                    templateMap={templateMap}
                    onToggleEdit={handleToggleEdit}
                    onSave={handleSaveCard}
                    onDelete={handleDeleteCard}
                    onQuote={handleQuoteCard}
                    disabled={isGenerating && !hasRealCardId(card)}
                    initialDraft={editingIndex === index ? restoredDraft : null}
                    onDraftChange={handleDraftChange}
                  />
                </div>
              </div>
            ))}
            {/* 生成仍在进行（如重试失败分段）时的骨架占位 */}
            {isBlockBusy && visibleCount >= cards.length && (
              <AnkiCardSkeleton hint={tAnki('chatBlock.skeletonHint')} />
            )}
            {/* 加载更多按钮 */}
            {visibleCount < cards.length && (
              <div
                className={cn(
                  'flex items-center justify-center gap-2 py-2',
                  layout === 'grid' && 'sm:col-span-2'
                )}
              >
                <DsButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setVisibleCount((prev) => prev + CARDS_PAGE_SIZE)}
                  className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs"
                >
                  {t('blocks.ankiCards.showMore', { remaining: cards.length - visibleCount })}
                </DsButton>
                {/* >50 张时不再一键挂全部 iframe，改为大步长分页（每次 +50） */}
                {cards.length > 50 ? (
                  <DsButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleCount((prev) => prev + 50)}
                    className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs text-muted-foreground"
                  >
                    {t('blocks.ankiCards.showMoreBig', { count: 50 })}
                  </DsButton>
                ) : (
                  <DsButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleCount(cards.length)}
                    className="min-h-10 [@media(pointer:coarse)]:!min-h-11 text-xs text-muted-foreground"
                  >
                    {t('blocks.ankiCards.showAll', { total: cards.length })}
                  </DsButton>
                )}
              </div>
            )}
            {/* 滚动锚点：新卡片到来时自动滚动到此处 */}
            <div
              ref={cardsEndRef}
              className={cn('scroll-mb-48', layout === 'grid' && 'sm:col-span-2')}
            />
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
        Boolean(pendingDelete) ||
        (Boolean(data?.documentId) &&
          (isBlockBusy ||
            data?.progress?.stage?.toLowerCase() === 'paused' ||
            data?.finalStatus?.toLowerCase() === 'paused'))) && (
        <FullWidthCardWrapper className="chatanki-bottom-actions">
          {/* 完成态小结：张数 / 用时 / 任务中心 / 导出 */}
          {showCompletionSummary && (
            <AnkiCompletionSummary
              summaryText={tAnki('chatBlock.summaryCompleted', { count: cards.length })}
              durationText={durationText}
              taskCenterLabel={tAnki('chatBlock.openTaskCenter')}
              onOpenTaskCenter={handleOpenTaskCenter}
              exportLabel={tAnki('chatBlock.exportApkg')}
              onExport={() => void handleSummaryExport()}
              exportPending={summaryExportPending}
            />
          )}

          {shouldShowChatAnkiProgress && (
            <ChatAnkiProgressCompact
              progress={data?.progress}
              ankiConnect={data?.ankiConnect}
              warnings={data?.warnings}
              mediaReport={mediaReport}
              cardsCount={cards.length}
              blockStatus={block.status}
              finalStatus={data?.finalStatus}
              errorMessage={errorMessage}
              onRefreshAnkiConnect={handleRefreshAnkiConnect}
            />
          )}

          {/* AI 质检终审任务级摘要（字段尚未收进 AnkiCardsBlockData，宽松透传；无数据时组件自行不渲染） */}
          <AnkiCriticSummaryBanner criticSummary={(data as { criticSummary?: unknown } | undefined)?.criticSummary} />

          {/* 质检标记块级摘要：折叠/展开态均可见，提示复查后再导出 */}
          {qaFlagsSummary.flaggedCardCount > 0 && (
            <AnkiQaFlagsSummaryChip
              flaggedCardCount={qaFlagsSummary.flaggedCardCount}
              maxSeverity={qaFlagsSummary.maxSeverity}
            />
          )}

          {/* 删除撤销条（6s 窗口，倒计时结束才真正提交 DB 删除；批量共用一个窗口） */}
          {pendingDelete && pendingDelete.entries.length > 0 && (
            <AnkiInlineUndoBar
              message={
                pendingDelete.entries.length === 1
                  ? tAnki('chatBlock.deletedCard', { index: pendingDelete.entries[0].index + 1 })
                  : tAnki('chatBlock.deletedCards', { count: pendingDelete.entries.length })
              }
              undoLabel={tAnki('chatBlock.undo')}
              onUndo={handleUndoDelete}
              durationMs={UNDO_DELETE_WINDOW_MS}
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
              deckName={deckName}
              onDeckNameChange={handleDeckNameChange}
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
