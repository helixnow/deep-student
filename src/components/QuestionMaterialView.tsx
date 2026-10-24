/**
 * 共享材料视图 / 编辑器（issue 491）
 *
 * 一篇阅读文章、一组共用条件或共用图片只存一份材料。材料必须在题目之前
 * 独立展示：单题随机练习、题组连续练习、浏览和列表都复用本组件。
 *
 * - 展示：默认展开（材料是解题必要条件，不默认隐藏），可折叠。
 * - 编辑：独立版本号 OCC；冲突时不覆盖，提示重新载入。
 * - 不使用「卡片套卡片」：材料区块用左侧强调线 + 轻背景区分。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { LatexText } from '@/components/LatexText';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import {
  BookOpen,
  CaretDown,
  CaretRight,
  Check,
  CircleNotch,
  FloppyDisk,
  Image as ImageIcon,
  PencilSimple,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  updateQuestionMaterial,
  type Question,
  type QuestionMaterial,
} from '@/api/questionBankApi';
import {
  loadQuestionImageUrls,
  QUESTION_IMAGE_LOAD_ERROR,
} from '@/components/questionImageLoader';

export interface QuestionMaterialViewProps {
  materials: QuestionMaterial[];
  /** edit：显示材料编辑入口（题目集可写时） */
  mode?: 'view' | 'edit';
  /** 材料更新成功（version 已递增）；宿主据此刷新受影响题目 */
  onUpdated?: (material: QuestionMaterial) => void | Promise<void>;
  /** 列表内嵌时使用更紧凑的间距 */
  compact?: boolean;
  className?: string;
}

/**
 * 列表分组：连续同组题目只在第一题前渲染一次材料。
 *
 * 独立题（groupId 为空）各自展示自己的材料；同一 groupId 的连续题目共用
 * 一次材料区块。返回 true 表示当前题应渲染材料头部。
 */
export function shouldRenderMaterialHeader(
  current: Pick<Question, 'id' | 'groupId' | 'materials'>,
  previous: Pick<Question, 'id' | 'groupId' | 'materials'> | null | undefined,
): boolean {
  if (!current.materials || current.materials.length === 0) return false;
  if (!current.groupId) return true;
  return previous?.groupId !== current.groupId;
}

/** 列表展示分组：连续同组题目合并，独立题各自成组（groupId=null） */
export interface QuestionDisplayGroup {
  /** 稳定键：真实 groupId，或独立题的 question id */
  key: string;
  groupId: string | null;
  label: string | null;
  materials: QuestionMaterial[];
  questionIds: string[];
  /** 该组第一题在传入数组中的下标 */
  startIndex: number;
}

/**
 * 按展示顺序把题目折叠为连续分组。
 *
 * 只做确定性合并：相同且非空的 groupId 必须相邻才合并；独立题不猜组。
 * 材料按 id 去重，取组内首个题目携带的完整材料定义。
 */
export function buildDisplayGroups(
  questions: Array<Pick<Question, 'id' | 'groupId' | 'groupLabel' | 'materials'>>,
): QuestionDisplayGroup[] {
  const groups: QuestionDisplayGroup[] = [];
  const materialIds = new Map<string, Set<string>>();

  questions.forEach((question, index) => {
    const groupId = question.groupId ?? null;
    const last = groups[groups.length - 1];
    const canAppend = groupId !== null && last?.groupId === groupId;

    if (canAppend) {
      last.questionIds.push(question.id);
      const seen = materialIds.get(last.key)!;
      for (const material of question.materials ?? []) {
        if (material?.id && !seen.has(material.id)) {
          seen.add(material.id);
          last.materials.push(material);
        }
      }
      return;
    }

    const key = groupId ?? `question:${question.id}`;
    const seen = new Set<string>();
    const materials: QuestionMaterial[] = [];
    for (const material of question.materials ?? []) {
      if (material?.id && !seen.has(material.id)) {
        seen.add(material.id);
        materials.push(material);
      }
    }
    materialIds.set(key, seen);
    groups.push({
      key,
      groupId,
      label: question.groupLabel ?? null,
      materials,
      questionIds: [question.id],
      startIndex: index,
    });
  });

  return groups;
}

interface MaterialImageGridProps {
  images: QuestionMaterial['images'];
  urls: Record<string, string>;
}

const MaterialImageGrid: React.FC<MaterialImageGridProps> = ({ images, urls }) => {
  const { t } = useTranslation('exam_sheet');
  if (images.length === 0) return null;
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {images.map((image) => {
        const url = urls[image.id];
        const failed = !url || url === QUESTION_IMAGE_LOAD_ERROR;
        return (
          <div
            key={image.id}
            className="overflow-hidden rounded-md border border-border/40 bg-muted/20"
          >
            {failed ? (
              <div className="flex h-24 items-center justify-center gap-1.5 px-2 text-xs text-muted-foreground">
                <ImageIcon size={14} />
                <span className="truncate">
                  {t('materials.imageUnavailable', { defaultValue: '材料图片暂不可用：{{name}}', name: image.name })}
                </span>
              </div>
            ) : (
              <img
                src={url}
                alt={image.name}
                className="max-h-56 w-full object-contain"
                loading="lazy"
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

interface MaterialEditorProps {
  material: QuestionMaterial;
  onCancel: () => void;
  onSaved: (material: QuestionMaterial) => Promise<void> | void;
}

const MaterialEditor: React.FC<MaterialEditorProps> = ({ material, onCancel, onSaved }) => {
  const { t } = useTranslation('exam_sheet');
  const [draft, setDraft] = useState(material.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncedContentRef = useRef(material.content);
  const materialIdRef = useRef(material.id);

  useEffect(() => {
    // 切换材料：重置草稿
    if (materialIdRef.current !== material.id) {
      materialIdRef.current = material.id;
      syncedContentRef.current = material.content;
      setDraft(material.content);
      setError(null);
      return;
    }
    // 同材料更高版本：仅当草稿仍是上次同步内容（用户未编辑）时跟随更新；
    // 有未保存修改时绝不静默丢弃草稿。
    const previouslySynced = syncedContentRef.current;
    syncedContentRef.current = material.content;
    setDraft((current) => (current === previouslySynced ? material.content : current));
  }, [material.id, material.content, material.version]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const content = draft.trim();
    if (!content) {
      setError(t('materials.emptyContent', { defaultValue: '材料内容不能为空' }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateQuestionMaterial(material.id, content, material.version);
      await onSaved(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const conflict = /version|conflict|stale|concurrent/i.test(message);
      setError(conflict
        ? t('materials.versionConflict', {
            defaultValue: '材料已被其他修改更新，请重新载入后再保存（你的草稿仍在）。',
          })
        : message);
    } finally {
      setSaving(false);
    }
  }, [draft, material.id, material.version, onSaved, saving, t]);

  return (
    <div className="mt-2 space-y-2">
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
        className="min-h-24 text-sm"
        aria-label={t('materials.editLabel', { defaultValue: '编辑共享材料' })}
      />
      {error && (
        <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <WarningCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <DsButton
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {saving ? <CircleNotch size={14} className="mr-1.5 animate-spin" /> : <FloppyDisk size={14} className="mr-1.5" />}
          {t('common:save', { defaultValue: '保存' })}
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(material.content);
            syncedContentRef.current = material.content;
            setError(null);
          }}
          disabled={saving}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          <X size={14} className="mr-1.5" />
          {t('materials.reload', { defaultValue: '重新载入' })}
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {t('common:cancel', { defaultValue: '取消' })}
        </DsButton>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {t('materials.version', { defaultValue: '版本 {{version}}', version: material.version })}
        </span>
      </div>
    </div>
  );
};

const MaterialBlock: React.FC<{
  material: QuestionMaterial;
  mode: 'view' | 'edit';
  compact?: boolean;
  onUpdated?: (material: QuestionMaterial) => void | Promise<void>;
}> = ({ material, mode, compact, onUpdated }) => {
  const { t } = useTranslation('exam_sheet');
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [localMaterial, setLocalMaterial] = useState(material);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const loadTokenRef = useRef(0);

  useEffect(() => {
    setLocalMaterial(material);
  }, [material]);

  useEffect(() => {
    if (!expanded || localMaterial.images.length === 0) return;
    const token = ++loadTokenRef.current;
    void loadQuestionImageUrls(localMaterial.images).then((urls) => {
      if (loadTokenRef.current === token) setImageUrls(urls);
    });
  }, [expanded, localMaterial.images]);

  const handleSaved = useCallback(async (updated: QuestionMaterial) => {
    setLocalMaterial(updated);
    setEditing(false);
    await onUpdated?.(updated);
  }, [onUpdated]);

  return (
    <section
      className={cn(
        'border-l-2 border-primary/50 bg-primary/[0.04] pl-2.5 pr-2 text-sm',
        compact ? 'py-1.5' : 'py-2',
      )}
      aria-label={t('materials.sectionLabel', { defaultValue: '共享材料' })}
      data-question-material-id={localMaterial.id}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-primary ui-state-colors"
          aria-expanded={expanded}
        >
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          <BookOpen size={13} aria-hidden="true" />
          <span className="truncate">{t('materials.title', { defaultValue: '共享材料' })}</span>
        </button>
        {mode === 'edit' && !editing && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            className="ml-auto !h-auto !px-1.5 !py-0.5 [@media(pointer:coarse)]:!min-h-11 text-xs text-muted-foreground hover:text-foreground"
          >
            <PencilSimple size={12} className="mr-1" />
            {t('materials.edit', { defaultValue: '编辑材料' })}
          </DsButton>
        )}
      </div>

      {expanded && (
        <div className={cn('mt-1.5', compact && 'text-[13px]')}>
          {editing ? (
            <MaterialEditor
              material={localMaterial}
              onCancel={() => setEditing(false)}
              onSaved={handleSaved}
            />
          ) : (
            <>
              <LatexText
                content={localMaterial.content}
                className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap leading-relaxed"
              />
              <MaterialImageGrid images={localMaterial.images} urls={imageUrls} />
              {localMaterial.source_refs && localMaterial.source_refs.length > 0 && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t('materials.source', { defaultValue: '来源：' })}
                  {localMaterial.source_refs.map((ref, index) => (
                    <span key={`${ref.source_id}-${ref.page ?? 'x'}-${index}`} className="mr-1.5 tabular-nums">
                      {ref.source_id}
                      {ref.page != null ? ` · p.${ref.page}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
};

/** 渲染一道题/一个题组的共享材料（列表内按分组只渲染一次） */
export const QuestionMaterialView: React.FC<QuestionMaterialViewProps> = ({
  materials,
  mode = 'view',
  onUpdated,
  compact = false,
  className,
}) => {
  const visible = useMemo(
    () => materials.filter((material) => material && material.id),
    [materials],
  );
  if (visible.length === 0) return null;
  return (
    <div className={cn('space-y-1.5', className)} data-question-materials="true">
      {visible.map((material) => (
        <MaterialBlock
          key={material.id}
          material={material}
          mode={mode}
          compact={compact}
          onUpdated={onUpdated}
        />
      ))}
    </div>
  );
};

export default QuestionMaterialView;
