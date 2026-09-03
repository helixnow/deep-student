/**
 * 卡片库单行：hover 浮现操作、状态徽标、行内展开详情 + 原地编辑 + 行内删除确认。
 * 所有交互均内联，无任何弹窗。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  CaretDown,
  Eraser,
  Pause,
  PencilSimple,
  Play,
  PlusCircle,
  Trash,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { AnkiCardPreviewPanel } from '@/components/anki/AnkiCardPreviewPanel';
import { useAnkiTemplateLoader } from '@/hooks/useAnkiTemplateLoader';
import type { AnkiLibraryCard, AnkiLibraryCardPatch } from '@/types';
import { hasValidCloze } from '../cloze';
import {
  getReviewCardEditValues,
  isClozeReviewCard,
  type EditableReviewCard,
  type ReviewEditTemplate,
} from '../reviewCardEditFields';
import {
  formatAbsoluteTime,
  formatCreatedAt,
  formatRelativeDue,
  getCardBack,
  getCardFront,
  getCardStatus,
  parseTagsInput,
  tagsEqual,
} from './libraryView';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const STATUS_LABEL_KEY: Record<string, string> = {
  notEnqueued: 'library.state.notEnqueued',
  suspended: 'library.state.suspended',
  new: 'library.state.new',
  learning: 'library.state.learning',
  review: 'library.state.review',
  relearning: 'library.state.relearning',
  enqueued: 'library.state.enqueued',
};

const RATING_LABEL_KEY: Record<number, string> = {
  1: 'session.again',
  2: 'session.hard',
  3: 'session.good',
  4: 'session.easy',
};

const RESET_DISARM_MS = 4000;

/** 懒加载 workbench chat 入口，避免把整条聊天依赖链拉进库视图。 */
function jumpToChatSession(sessionId: string): void {
  void import('@/features/workbench/apps/chat/newSession')
    .then(({ openChatSession }) => {
      openChatSession(sessionId);
    })
    .catch(() => {
      // 跳转失败静默降级：来源信息本身仍在展开区展示
    });
}

/** 来源类型 → 展示文案 key；未知来源不展示。 */
function sourceLabelKey(sourceType: string | null | undefined): string | null {
  switch (sourceType) {
    case 'chat_message':
    case 'chat_session':
      return 'library.source.chat';
    case 'document':
    case 'task':
      return 'library.source.task';
    case 'apkg_import':
      return 'library.source.apkg';
    default:
      return null;
  }
}

export interface LibraryCardRowProps {
  card: AnkiLibraryCard;
  busy: boolean;
  deleting: boolean;
  selected: boolean;
  expanded: boolean;
  confirmingDelete: boolean;
  onToggleSelect: (cardId: string, shiftKey: boolean) => void;
  onToggleExpand: (cardId: string) => void;
  onStartReview: (card: AnkiLibraryCard) => void;
  onEnqueue: (cardId: string) => void;
  onToggleSuspended: (card: AnkiLibraryCard) => void;
  onRequestDelete: (cardId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onSaveEdit: (
    cardId: string,
    patch: AnkiLibraryCardPatch,
    template?: ReviewEditTemplate | null,
  ) => Promise<boolean>;
  onUndoReview: (cardId: string) => void;
  /** 危险操作：清除该卡全部复习历史并重建 New 状态（行内二次确认后触发）。 */
  onResetProgress: (cardId: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLLIElement>, cardId: string) => void;
  rowRef: (cardId: string, element: HTMLLIElement | null) => void;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest('button, a, input, textarea, select, label, [role="checkbox"]'))
    : false;
}

export const LibraryCardRow: React.FC<LibraryCardRowProps> = ({
  card,
  busy,
  deleting,
  selected,
  expanded,
  confirmingDelete,
  onToggleSelect,
  onToggleExpand,
  onStartReview,
  onEnqueue,
  onToggleSuspended,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onSaveEdit,
  onUndoReview,
  onResetProgress,
  onRowKeyDown,
  rowRef,
}) => {
  const { t, i18n } = useTranslation('flashcards');
  const translate = t as Translate;
  const locale = i18n?.language || 'en';

  const [editing, setEditing] = useState(false);
  const [draftFront, setDraftFront] = useState('');
  const [draftBack, setDraftBack] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 重置进度的行内二次确认（超时自动解除武装）
  const [resetArmed, setResetArmed] = useState(false);
  // 展开内容按需挂载：收起时延迟卸载，让高度过渡先播完。
  const [renderBody, setRenderBody] = useState(expanded);

  // 模板懒加载：仅展开且卡片带模板时请求（loader 内部有缓存），
  // 用于展开区的模板化卡面预览（AnkiCardPreviewPanel）。
  const { template } = useAnkiTemplateLoader(renderBody ? card.template_id : null);

  useEffect(() => {
    if (expanded) {
      setRenderBody(true);
      return;
    }
    const timer = window.setTimeout(() => setRenderBody(false), 220);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  // 收起行时同步退出编辑，避免残留脏草稿。
  useEffect(() => {
    if (!expanded) {
      setEditing(false);
      setEditError(null);
      setResetArmed(false);
    }
  }, [expanded]);

  // 重置确认超时自动解除
  useEffect(() => {
    if (!resetArmed) return;
    const timer = window.setTimeout(() => setResetArmed(false), RESET_DISARM_MS);
    return () => window.clearTimeout(timer);
  }, [resetArmed]);

  const status = getCardStatus(card);
  const front = getCardFront(card);
  const back = getCardBack(card);

  // 编辑视图模型：与复习会话共用字段别名映射（Cloze 卡编辑 text/Extra 而非 Front/Back）
  const editable = useMemo<EditableReviewCard>(() => ({
    ankiCardId: card.id,
    front: card.front,
    back: card.back,
    text: card.text,
    tags: card.tags,
    images: card.images,
    templateId: card.template_id ?? null,
    extraFields: { ...(card.fields ?? {}), ...(card.extra_fields ?? {}) },
  }), [card]);
  const isCloze = isClozeReviewCard(editable, template);
  const editValues = useMemo(
    () => getReviewCardEditValues(editable, template),
    [editable, template],
  );

  const sourceKey = sourceLabelKey(card.sourceType);
  // 仅 chat_session 来源有干净的跳转入口（sourceId 即会话 id）
  const sourceSessionId = card.sourceType === 'chat_session'
    && typeof card.sourceId === 'string'
    && card.sourceId.trim().length > 0
    ? card.sourceId.trim()
    : null;
  const relativeDue = card.enqueued && !card.suspended
    ? formatRelativeDue(card.dueMs, locale)
    : null;
  const absoluteDue = formatAbsoluteTime(card.dueMs);
  const createdAt = formatCreatedAt(card);
  const canUndo = Boolean(card.latestReview?.undoable && card.stateId);
  const ratingKey = typeof card.latestReview?.rating === 'number'
    ? RATING_LABEL_KEY[card.latestReview.rating]
    : undefined;

  const beginEdit = useCallback(() => {
    setDraftFront(editValues.front);
    setDraftBack(editValues.back);
    setDraftTags(card.tags.join(', '));
    setEditError(null);
    setEditing(true);
  }, [editValues, card.tags]);

  const handleSave = useCallback(async () => {
    const nextFront = draftFront.trim();
    const nextBack = draftBack.trim();
    // Cloze 卡：back（Extra）允许为空，但正面必须含有效挖空标记
    if (!nextFront || (!isCloze && !nextBack)) {
      setEditError(translate('library.editEmpty'));
      return;
    }
    if (isCloze && !hasValidCloze(nextFront)) {
      setEditError(translate('session.invalidClozeEdit'));
      return;
    }
    const nextTags = parseTagsInput(draftTags);
    const patch: AnkiLibraryCardPatch = {};
    if (nextFront !== editValues.front) patch.front = nextFront;
    if (nextBack !== editValues.back) patch.back = nextBack;
    if (!tagsEqual(nextTags, card.tags)) patch.tags = nextTags;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const ok = await onSaveEdit(card.id, patch, template);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [
    draftFront,
    draftBack,
    draftTags,
    editValues,
    isCloze,
    card.id,
    card.tags,
    onSaveEdit,
    template,
    translate,
  ]);

  const handleMainClick = (event: React.MouseEvent) => {
    if (isInteractiveTarget(event.target)) return;
    onToggleExpand(card.id);
  };

  return (
    <li
      ref={(element) => rowRef(card.id, element)}
      className="wb-fc-row fc-lib-row"
      data-agent-entity={`flashcards:${card.id}`}
      data-selected={selected ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      tabIndex={0}
      onKeyDown={(event) => onRowKeyDown(event, card.id)}
    >
      <div className="fc-lib-row-main" onClick={handleMainClick}>
        <div
          className="fc-lib-row-check"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            // shift 连选时避免拖出文字选区
            if (event.shiftKey) event.preventDefault();
          }}
        >
          <Checkbox
            checked={selected}
            aria-label={translate('library.selectCard')}
            disabled={busy}
            onClick={(event) => onToggleSelect(card.id, event.shiftKey)}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="wb-fc-row-front">
            {front || t('card.untitled')}
          </div>
          <div className="wb-fc-row-back">
            {back || t('card.noBack')}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className="fc-lib-badge"
              data-status={status}
              data-testid={`schedule-state-${card.id}`}
            >
              {translate(STATUS_LABEL_KEY[status])}
            </span>
            {card.isDue && !card.suspended ? (
              <span className="fc-lib-badge" data-status="due">
                {t('library.state.due')}
              </span>
            ) : null}
            {card.enqueued && !card.suspended ? (
              relativeDue ? (
                <span title={absoluteDue ?? t('library.dueTime')}>{relativeDue}</span>
              ) : absoluteDue ? (
                <span title={t('library.dueTime')}>
                  {card.isDue ? t('library.dueNow') : absoluteDue}
                </span>
              ) : null
            ) : null}
            {card.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="wb-fc-tag">{tag}</span>
            ))}
            {card.tags.length > 3 ? (
              <span className="wb-fc-tag">+{card.tags.length - 3}</span>
            ) : null}
          </div>
        </div>

        <div className="fc-lib-row-actions" onClick={(event) => event.stopPropagation()}>
          {card.enqueued ? (
            <DsButton
              type="button"
              variant="default"
              size="sm"
              disabled={busy || card.suspended}
              onClick={() => onStartReview(card)}
              className="text-xs"
            >
              <Play size={14} weight="fill" />
              {t('library.startReview')}
            </DsButton>
          ) : (
            <DsButton
              type="button"
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => onEnqueue(card.id)}
              className="text-xs"
            >
              <PlusCircle size={14} />
              {t('library.enqueue')}
            </DsButton>
          )}

          {card.enqueued ? (
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              disabled={busy}
              onClick={() => onToggleSuspended(card)}
              aria-label={card.suspended ? t('library.resume') : t('library.suspend')}
              title={card.suspended ? t('library.resume') : t('library.suspend')}
            >
              {card.suspended ? <Play size={14} /> : <Pause size={14} />}
            </DsButton>
          ) : null}

          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            disabled={busy}
            onClick={() => onRequestDelete(card.id)}
            aria-label={t('library.delete')}
            title={t('library.delete')}
          >
            <Trash size={14} />
          </DsButton>

          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onToggleExpand(card.id)}
            aria-expanded={expanded}
            aria-label={expanded ? translate('library.collapse') : translate('library.expand')}
            title={expanded ? translate('library.collapse') : translate('library.expand')}
          >
            <CaretDown
              size={14}
              style={{
                transform: expanded ? 'rotate(180deg)' : undefined,
                transition: 'transform 160ms ease-out',
              }}
            />
          </DsButton>
        </div>
      </div>

      {confirmingDelete ? (
        <div
          role="alertdialog"
          aria-label={t('library.delete')}
          className="fc-lib-confirm"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="fc-lib-confirm-text">{t('library.confirmDelete')}</span>
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={onCancelDelete}
            className="text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            {t('common:cancel')}
          </DsButton>
          <DsButton
            type="button"
            variant="danger"
            size="sm"
            disabled={deleting}
            onClick={onConfirmDelete}
            className="text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            <Trash size={13} />
            {t('library.delete')}
          </DsButton>
        </div>
      ) : null}

      <div className="fc-lib-expand">
        <div className="fc-lib-expand-inner" aria-hidden={!expanded}>
          {renderBody ? (
          <div className="fc-lib-expand-body" onClick={(event) => event.stopPropagation()}>
            {editing ? (
              <div className="fc-lib-edit">
                <div>
                  <label className="fc-lib-edit-label" htmlFor={`fc-lib-front-${card.id}`}>
                    {translate('library.editFront')}
                  </label>
                  <Textarea
                    id={`fc-lib-front-${card.id}`}
                    value={draftFront}
                    rows={3}
                    disabled={saving}
                    onChange={(event) => setDraftFront(event.target.value)}
                    className="min-h-[56px] text-sm"
                  />
                </div>
                <div>
                  <label className="fc-lib-edit-label" htmlFor={`fc-lib-back-${card.id}`}>
                    {translate('library.editBack')}
                  </label>
                  <Textarea
                    id={`fc-lib-back-${card.id}`}
                    value={draftBack}
                    rows={3}
                    disabled={saving}
                    onChange={(event) => setDraftBack(event.target.value)}
                    className="min-h-[56px] text-sm"
                  />
                </div>
                <div>
                  <label className="fc-lib-edit-label" htmlFor={`fc-lib-tags-${card.id}`}>
                    {translate('library.editTags')}
                  </label>
                  <Input
                    id={`fc-lib-tags-${card.id}`}
                    value={draftTags}
                    disabled={saving}
                    onChange={(event) => setDraftTags(event.target.value)}
                    className="h-8 text-sm [@media(pointer:coarse)]:!h-11"
                  />
                </div>
                {editError ? (
                  <p role="alert" className="fc-lib-edit-error">{editError}</p>
                ) : null}
                <div className="fc-lib-expand-actions">
                  <DsButton
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={saving || busy}
                    onClick={() => void handleSave()}
                    className="text-xs [@media(pointer:coarse)]:!min-h-11"
                  >
                    {translate('library.save')}
                  </DsButton>
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setEditError(null);
                    }}
                    className="text-xs [@media(pointer:coarse)]:!min-h-11"
                  >
                    {translate('library.cancel')}
                  </DsButton>
                </div>
              </div>
            ) : (
              <>
                {template ? (
                  /* 带模板的卡片：模板化正反面预览（含字段/标签），替代纯文本卡面 */
                  <AnkiCardPreviewPanel card={card} template={template} />
                ) : (
                  <>
                    <div className="fc-lib-face">
                      <span className="fc-lib-face-label">{t('session.front')}</span>
                      {front || t('card.untitled')}
                    </div>
                    <div className="fc-lib-face">
                      <span className="fc-lib-face-label">{t('session.back')}</span>
                      {back || t('card.noBack')}
                    </div>
                  </>
                )}
                <dl className="fc-lib-meta">
                  <div>
                    <dt>{translate('library.meta.status')}</dt>
                    <dd>{translate(STATUS_LABEL_KEY[status])}</dd>
                  </div>
                  {card.enqueued && absoluteDue ? (
                    <div>
                      <dt>{translate('library.meta.due')}</dt>
                      <dd>{relativeDue ? `${relativeDue} · ${absoluteDue}` : absoluteDue}</dd>
                    </div>
                  ) : null}
                  {createdAt ? (
                    <div>
                      <dt>{translate('library.meta.created')}</dt>
                      <dd>{createdAt}</dd>
                    </div>
                  ) : null}
                  {ratingKey ? (
                    <div>
                      <dt>{translate('library.meta.lastReview')}</dt>
                      <dd>{translate(ratingKey)}</dd>
                    </div>
                  ) : null}
                  {sourceKey ? (
                    <div>
                      <dt>{translate('library.meta.source')}</dt>
                      <dd className="flex items-center gap-1.5">
                        {translate(sourceKey)}
                        {sourceSessionId ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-0.5 text-primary hover:underline [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:-mx-3"
                            onClick={() => jumpToChatSession(sourceSessionId)}
                          >
                            <ArrowSquareOut size={11} aria-hidden="true" />
                            {translate('library.viewSource')}
                          </button>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  {/* 模板预览面板内部已展示标签，避免重复 */}
                  {!template && card.tags.length > 0 ? (
                    <div>
                      <dt>{translate('library.meta.tags')}</dt>
                      <dd>{card.tags.join(', ')}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="fc-lib-expand-actions">
                  <DsButton
                    type="button"
                    variant="default"
                    size="sm"
                    disabled={busy}
                    onClick={beginEdit}
                    className="text-xs [@media(pointer:coarse)]:!min-h-11"
                  >
                    <PencilSimple size={13} />
                    {translate('library.edit')}
                  </DsButton>
                  {canUndo ? (
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onUndoReview(card.id)}
                      className="text-xs [@media(pointer:coarse)]:!min-h-11"
                    >
                      <ArrowCounterClockwise size={13} />
                      {translate('library.undoReview')}
                    </DsButton>
                  ) : null}
                  {card.enqueued && card.stateId ? (
                    <DsButton
                      type="button"
                      variant={resetArmed ? 'danger' : 'ghost'}
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (!resetArmed) {
                          setResetArmed(true);
                          return;
                        }
                        setResetArmed(false);
                        onResetProgress(card.id);
                      }}
                      className="text-xs [@media(pointer:coarse)]:!min-h-11"
                    >
                      <Eraser size={13} />
                      {resetArmed
                        ? translate('library.resetProgressConfirm')
                        : translate('library.resetProgress')}
                    </DsButton>
                  ) : null}
                </div>
              </>
            )}
          </div>
          ) : null}
        </div>
      </div>
    </li>
  );
};
