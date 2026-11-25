/**
 * Chat V2 - Anki 内联可编辑卡片项子组件
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Quotes, Trash } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { PulseDot } from '@/components/ui/PulseDot';
import { cn } from '@/utils/cn';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { parseOcclusionSpec } from '@/components/anki/utils/imageOcclusion';
import { RenderedAnkiCard } from './RenderedAnkiCard';
import { ClozeText, hasClozeMarkers } from './AnkiClozeText';
import { parseCardQaFlags } from './ankiQaFlags';
import { AnkiQaFlagBadge } from './AnkiQaFlagBadge';
import type { AnkiCardEditDraft } from './ankiCardsBlockState';
import {
  resolveEditableFields,
  setCaseInsensitiveValue,
  toStringRecord,
} from './ankiCardsBlockFields';
import { AnkiOcclusionCardPreview } from './AnkiOcclusionCardPreview';

export interface InlineCardItemProps {
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

export const InlineCardItem: React.FC<InlineCardItemProps> = ({
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
              className="lg:h-10 lg:w-10 text-destructive hover:text-destructive"
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
            >
              {savePending ? (
                <PulseDot className="h-1.5 w-1.5 text-current" />
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
        <div data-wb-blur-surface className="absolute top-2 left-2 z-10 h-5 min-w-5 px-1 rounded-md bg-background/80 backdrop-blur flex items-center justify-center text-2xs font-medium text-muted-foreground border tabular-nums">
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
                  'bg-background/80 backdrop-blur border hover:bg-[var(--interactive-hover)]',
                  isTouchPrimary
                    ? 'opacity-100'
                    : 'lg:h-10 lg:w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
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
                'bg-background/80 backdrop-blur border hover:bg-[var(--interactive-hover)]',
                isTouchPrimary
                  ? 'opacity-100'
                  : 'lg:h-10 lg:w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
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
                'bg-background/80 backdrop-blur border hover:bg-destructive/10',
                isTouchPrimary
                  ? 'opacity-100'
                  : 'lg:h-10 lg:w-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
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
              <span key={i} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
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
        <span className="flex-shrink-0 h-6 min-w-6 px-1 rounded-md bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground tabular-nums mt-0.5">
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
                <span key={i} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
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
