/**
 * 题目内联编辑器
 * 
 * Accordion 风格：在题目卡片下方展开编辑表单，保存/取消后收起。
 * 从 QuestionEditDrawer 提取编辑逻辑，去掉 Sheet 容器。
 *
 * 2026-02 新增
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from './custom-scroll-area';
import { AppSelect } from '@/components/ui/app-menu';
import {
  FloppyDisk,
  X,
  Check,
  CircleNotch,
  Plus,
  Trash,
  WarningCircle,
  Image,
  Image as ImageIcon,
  Eye,
  CaretDown,
  CaretRight,
} from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { LatexText } from '@/components/LatexText';
import type { Question, QuestionType, Difficulty, QuestionImage, QuestionStructuredData } from '@/api/questionBankApi';
import {
  type ExtendedQuestionType,
  type FillBlankSpec,
  getQuestionStructuredData,
  parseMatchingData,
  parseOrderingData,
  parseNumericData,
  parseFillBlankData,
  MatchingEditor,
  type MatchingEditorValue,
  OrderingEditor,
  type OrderingEditorValue,
  NumericEditor,
  type NumericEditorValue,
  BlanksEditor,
} from '@/components/question-types';

export interface QuestionInlineEditorProps {
  question: Question | null;
  onSave?: (question: Question) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  mode?: 'edit' | 'create';
  examId?: string;
  onCreate?: (question: Question) => Promise<void>;
  className?: string;
}

/** 结构化题型编辑草稿（一并纳入 editData，dirty 判定与重置自然生效） */
interface StructuredDraft {
  matching: MatchingEditorValue;
  ordering: OrderingEditorValue;
  numeric: NumericEditorValue;
  blanks: FillBlankSpec[];
}

interface EditableQuestion {
  content: string;
  questionType: ExtendedQuestionType;
  options: { key: string; content: string }[];
  answer: string;
  explanation: string;
  difficulty: Difficulty | '';
  tags: string[];
  userNote: string;
  images: QuestionImage[];
  structured: StructuredDraft;
}

/** 各结构化题型的初始草稿 */
function createStructuredDraft(question?: Question | null): StructuredDraft {
  const draft: StructuredDraft = {
    matching: {
      left: [
        { key: 'L1', content: '' },
        { key: 'L2', content: '' },
      ],
      right: [
        { key: 'R1', content: '' },
        { key: 'R2', content: '' },
      ],
      pairs: [],
    },
    ordering: {
      items: [
        { key: 'A', content: '' },
        { key: 'B', content: '' },
        { key: 'C', content: '' },
      ],
      correctOrder: ['A', 'B', 'C'],
    },
    numeric: { answerValue: '', tolerance: '', unit: '', toleranceMode: 'absolute' },
    blanks: [{ answers: [], case_sensitive: false, trim: true }],
  };
  if (!question) return draft;

  const raw = getQuestionStructuredData(question);
  if (raw == null) return draft;

  const qType = question.questionType as ExtendedQuestionType;
  if (qType === 'matching') {
    const parsed = parseMatchingData(raw);
    if (parsed) draft.matching = { left: parsed.left, right: parsed.right, pairs: parsed.pairs };
  } else if (qType === 'ordering') {
    const parsed = parseOrderingData(raw);
    if (parsed) {
      const keys = parsed.items.map((item) => item.key);
      const validOrder = parsed.correct_order.filter((key) => keys.includes(key));
      const missing = keys.filter((key) => !validOrder.includes(key));
      draft.ordering = { items: parsed.items, correctOrder: [...validOrder, ...missing] };
    }
  } else if (qType === 'numeric') {
    const parsed = parseNumericData(raw);
    if (parsed) {
      draft.numeric = {
        answerValue: String(parsed.answer_value),
        tolerance: parsed.tolerance != null ? String(parsed.tolerance) : '',
        unit: parsed.unit ?? '',
        toleranceMode: parsed.tolerance_mode ?? 'absolute',
      };
    }
  } else if (qType === 'fill_blank') {
    const parsed = parseFillBlankData(raw);
    if (parsed) draft.blanks = parsed.blanks;
  }
  return draft;
}

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB - 与后端 vfs_upload_attachment 的 MAX_IMAGE_BYTES 保持一致
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const MAX_OPTIONS = 26; // A-Z

const questionTypeKeys: { value: ExtendedQuestionType; labelKey: string }[] = [
  { value: 'single_choice', labelKey: 'exam_sheet:questionBank.edit.questionTypes.single_choice' },
  { value: 'multiple_choice', labelKey: 'exam_sheet:questionBank.edit.questionTypes.multiple_choice' },
  { value: 'indefinite_choice', labelKey: 'exam_sheet:questionBank.edit.questionTypes.indefinite_choice' },
  { value: 'true_false', labelKey: 'practice:editor.questionType.trueFalse' },
  { value: 'fill_blank', labelKey: 'exam_sheet:questionBank.edit.questionTypes.fill_blank' },
  { value: 'matching', labelKey: 'practice:editor.questionType.matching' },
  { value: 'ordering', labelKey: 'practice:editor.questionType.ordering' },
  { value: 'numeric', labelKey: 'practice:editor.questionType.numeric' },
  { value: 'short_answer', labelKey: 'exam_sheet:questionBank.edit.questionTypes.short_answer' },
  { value: 'essay', labelKey: 'exam_sheet:questionBank.edit.questionTypes.essay' },
  { value: 'calculation', labelKey: 'exam_sheet:questionBank.edit.questionTypes.calculation' },
  { value: 'proof', labelKey: 'exam_sheet:questionBank.edit.questionTypes.proof' },
  { value: 'other', labelKey: 'exam_sheet:questionBank.edit.questionTypes.other' },
];

const difficultyKeys: { value: Difficulty; labelKey: string }[] = [
  { value: 'easy', labelKey: 'exam_sheet:questionBank.difficulty.easy' },
  { value: 'medium', labelKey: 'exam_sheet:questionBank.difficulty.medium' },
  { value: 'hard', labelKey: 'exam_sheet:questionBank.difficulty.hard' },
  { value: 'very_hard', labelKey: 'exam_sheet:questionBank.difficulty.very_hard' },
];

export const QuestionInlineEditor: React.FC<QuestionInlineEditorProps> = ({
  question,
  onSave,
  onCancel,
  onDirtyChange,
  mode = 'edit',
  examId,
  onCreate,
  className,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub', 'practice']);

  const [editData, setEditData] = useState<EditableQuestion>({
    content: '',
    questionType: 'other',
    options: [],
    answer: '',
    explanation: '',
    difficulty: '',
    tags: [],
    userNote: '',
    images: [],
    structured: createStructuredDraft(),
  });
  const [tagInput, setTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<Record<string, string>>({});
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  // 内联放弃确认条（替代原 DsAlertDialog 模态确认）
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [contentTouched, setContentTouched] = useState(false);
  // 仅对新增的选项行播放入场动效，避免整列表在编辑器展开时重复动画
  const [lastAddedOptionIndex, setLastAddedOptionIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialDataRef = useRef<EditableQuestion | null>(null);

  // 初始化编辑数据
  useEffect(() => {
    if (mode === 'create') {
      const initialData: EditableQuestion = {
        content: '',
        questionType: 'single_choice',
        options: [
          { key: 'A', content: '' },
          { key: 'B', content: '' },
          { key: 'C', content: '' },
          { key: 'D', content: '' },
        ],
        answer: '',
        explanation: '',
        difficulty: '',
        tags: [],
        userNote: '',
        images: [],
        structured: createStructuredDraft(),
      };
      initialDataRef.current = initialData;
      setEditData(initialData);
      setError(null);
      setTagInput('');
      setImagePreviewUrls({});
      setShowDiscardConfirm(false);
      setContentTouched(false);
      setLastAddedOptionIndex(null);
      // 创建模式：解析/笔记默认折叠，保持表单紧凑
      setShowOptional(false);
    } else if (question) {
      const initialData: EditableQuestion = {
        content: question.content || '',
        questionType: question.questionType || 'other',
        options: (question.options || []).map((option) => ({ ...option })),
        answer: question.answer || '',
        explanation: question.explanation || '',
        difficulty: question.difficulty || '',
        tags: [...(question.tags || [])],
        userNote: question.userNote || '',
        images: [...(question.images || [])],
        structured: createStructuredDraft(question),
      };
      initialDataRef.current = initialData;
      setEditData(initialData);
      loadImagePreviews(question.images || []);
      setShowDiscardConfirm(false);
      setContentTouched(false);
      setLastAddedOptionIndex(null);
      // 编辑模式：已有解析/笔记内容时自动展开选填区
      setShowOptional(Boolean(initialData.explanation || initialData.userNote));
    }
  }, [question, mode]);

  const isDirty = initialDataRef.current !== null
    && JSON.stringify(editData) !== JSON.stringify(initialDataRef.current);

  // 内容改回原状后（不再脏）自动收起放弃确认条
  useEffect(() => {
    if (!isDirty) setShowDiscardConfirm(false);
  }, [isDirty]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // 展开后自动滚动到可见
  useEffect(() => {
    const timer = setTimeout(() => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // 加载图片预览（token 竞态保护：题目快速切换时丢弃过期批次，避免旧题图片覆盖新题）
  const previewLoadTokenRef = useRef(0);
  const loadImagePreviews = useCallback(async (images: QuestionImage[]) => {
    const token = ++previewLoadTokenRef.current;
    const urls: Record<string, string> = {};
    for (const img of images) {
      try {
        const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
          attachmentId: img.id,
        });
        if (result.found && result.content) {
          urls[img.id] = `data:${img.mime};base64,${result.content}`;
        } else {
          urls[img.id] = 'error';
        }
      } catch {
        urls[img.id] = 'error';
      }
    }
    if (token !== previewLoadTokenRef.current) return;
    setImagePreviewUrls(urls);
  }, []);

  // 处理图片上传
  const handleImageUpload = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (editData.images.length + fileArray.length > MAX_IMAGES) {
      showGlobalNotification('warning', t('exam_sheet:image.max_count', { count: MAX_IMAGES }));
      return;
    }

    setIsUploadingImage(true);
    try {
      for (const file of fileArray) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
          showGlobalNotification('warning', `${file.name}: ${t('exam_sheet:image.upload_failed')}`);
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          showGlobalNotification('warning', `${file.name}: ${t('exam_sheet:image.max_size', { size: '50MB' })}`);
          continue;
        }

        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const base64Data = result.split(',')[1] || result;
            resolve(base64Data);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const result = await invoke<{ sourceId: string; resourceHash: string }>('vfs_upload_attachment', {
          params: {
            name: file.name,
            mimeType: file.type,
            base64Content: base64,
          },
        });

        const newImage: QuestionImage = {
          id: result.sourceId,
          name: file.name,
          mime: file.type,
          hash: result.resourceHash,
        };

        setEditData(prev => ({
          ...prev,
          images: [...prev.images, newImage],
        }));

        setImagePreviewUrls(prev => ({
          ...prev,
          [result.sourceId]: `data:${file.type};base64,${base64}`,
        }));
      }
    } catch (err: unknown) {
      console.error('[QuestionInlineEditor] Image upload failed:', err);
      showGlobalNotification('error', t('exam_sheet:image.upload_failed'));
    } finally {
      setIsUploadingImage(false);
    }
  }, [editData.images.length, t]);

  const handleRemoveImage = useCallback((imageId: string) => {
    setEditData(prev => ({
      ...prev,
      images: prev.images.filter(img => img.id !== imageId),
    }));
    setImagePreviewUrls(prev => {
      const next = { ...prev };
      delete next[imageId];
      return next;
    });
  }, []);

  const handleFieldChange = useCallback(<K extends keyof EditableQuestion>(
    field: K,
    value: EditableQuestion[K]
  ) => {
    setEditData(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleOptionChange = useCallback((index: number, key: 'key' | 'content', value: string) => {
    setEditData(prev => {
      const options = [...prev.options];
      options[index] = { ...options[index], [key]: value };
      return { ...prev, options };
    });
  }, []);

  const handleAddOption = useCallback(() => {
    if (editData.options.length >= MAX_OPTIONS) return;
    const nextKey = String.fromCharCode(65 + editData.options.length);
    setLastAddedOptionIndex(editData.options.length);
    setEditData(prev => ({
      ...prev,
      options: [...prev.options, { key: nextKey, content: '' }],
    }));
  }, [editData.options.length]);

  const handleRemoveOption = useCallback((index: number) => {
    setLastAddedOptionIndex(null);
    setEditData(prev => ({
      ...prev,
      options: prev.options.filter((_, i) => i !== index),
    }));
  }, []);

  const handleAddTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !editData.tags.includes(tag)) {
      setEditData(prev => ({
        ...prev,
        tags: [...prev.tags, tag],
      }));
      setTagInput('');
    }
  }, [tagInput, editData.tags]);

  const handleRemoveTag = useCallback((tag: string) => {
    setEditData(prev => ({
      ...prev,
      tags: prev.tags.filter(t => t !== tag),
    }));
  }, []);

  const handleStructuredChange = useCallback(<K extends keyof StructuredDraft>(
    field: K,
    value: StructuredDraft[K]
  ) => {
    setEditData(prev => ({ ...prev, structured: { ...prev.structured, [field]: value } }));
  }, []);

  const qTypeExt = editData.questionType;
  const isStructuredType = qTypeExt === 'true_false' || qTypeExt === 'matching'
    || qTypeExt === 'ordering' || qTypeExt === 'numeric';
  // 填空题：配置了多空或任一可接受答案后，blanks 成为答案来源（answer 字段自动派生）
  const blanksActive = qTypeExt === 'fill_blank'
    && (editData.structured.blanks.length > 1
      || editData.structured.blanks.some((b) => b.answers.length > 0));

  /** 结构化题型保存前校验：返回错误文案或 null */
  const validateStructured = useCallback((): string | null => {
    const s = editData.structured;
    if (qTypeExt === 'true_false') {
      if (editData.answer !== 'true' && editData.answer !== 'false') {
        return t('practice:editor.structEdit.trueFalseAnswerRequired');
      }
      return null;
    }
    if (qTypeExt === 'matching') {
      const left = s.matching.left.filter((i) => i.content.trim());
      const right = s.matching.right.filter((i) => i.content.trim());
      if (left.length === 0 || right.length === 0) {
        return t('practice:editor.structEdit.matchingNeedsItems');
      }
      // 与 buildStructuredPayload 同口径：空内容条目会连同其配对一起被过滤，
      // 必须校验过滤后的有效配对，否则可能落库 pairs=[]（判分退化为手动批改）
      const leftKeys = new Set(left.map((i) => i.key));
      const rightKeys = new Set(right.map((i) => i.key));
      const effectivePairs = s.matching.pairs.filter(
        (p) => leftKeys.has(p.left) && rightKeys.has(p.right)
      );
      if (effectivePairs.length === 0) {
        return t('practice:editor.structEdit.matchingNeedsPairs');
      }
      return null;
    }
    if (qTypeExt === 'ordering') {
      if (s.ordering.items.filter((i) => i.content.trim()).length < 2) {
        return t('practice:editor.structEdit.orderingNeedsItems');
      }
      return null;
    }
    if (qTypeExt === 'numeric') {
      const value = s.numeric.answerValue.trim();
      if (!value || !Number.isFinite(Number(value))) {
        return t('practice:editor.structEdit.numericValueRequired');
      }
      const tolerance = s.numeric.tolerance.trim();
      if (tolerance && (!Number.isFinite(Number(tolerance)) || Number(tolerance) < 0)) {
        return t('practice:editor.structEdit.numericToleranceInvalid');
      }
      return null;
    }
    if (qTypeExt === 'fill_blank' && blanksActive) {
      if (s.blanks.some((b) => b.answers.length === 0)) {
        return t('practice:editor.structEdit.blankNeedsAnswer');
      }
      return null;
    }
    return null;
  }, [editData.structured, editData.answer, qTypeExt, blanksActive, t]);

  /** structured_data 保存负载（null = 不适用/清空） */
  const buildStructuredPayload = useCallback((): Record<string, unknown> | null => {
    const s = editData.structured;
    if (qTypeExt === 'matching') {
      const left = s.matching.left.filter((i) => i.content.trim());
      const right = s.matching.right.filter((i) => i.content.trim());
      const leftKeys = new Set(left.map((i) => i.key));
      const rightKeys = new Set(right.map((i) => i.key));
      return {
        left,
        right,
        pairs: s.matching.pairs.filter((p) => leftKeys.has(p.left) && rightKeys.has(p.right)),
      };
    }
    if (qTypeExt === 'ordering') {
      const items = s.ordering.items.filter((i) => i.content.trim());
      const keys = new Set(items.map((i) => i.key));
      return { items, correct_order: s.ordering.correctOrder.filter((k) => keys.has(k)) };
    }
    if (qTypeExt === 'numeric') {
      const tolerance = s.numeric.tolerance.trim();
      return {
        answer_value: Number(s.numeric.answerValue.trim()),
        tolerance: tolerance ? Number(tolerance) : 0,
        unit: s.numeric.unit.trim() || null,
        tolerance_mode: s.numeric.toleranceMode,
      };
    }
    if (qTypeExt === 'fill_blank' && blanksActive) {
      return {
        blanks: s.blanks.map((b) => ({
          answers: b.answers,
          case_sensitive: b.case_sensitive === true,
          trim: b.trim !== false,
        })),
      };
    }
    return null;
  }, [editData.structured, qTypeExt, blanksActive]);

  /** answer 字段派生：结构化题型自动生成（与 user_answer 序列化契约同构） */
  const buildAnswerPayload = useCallback((): string | null => {
    const s = editData.structured;
    if (qTypeExt === 'true_false') return editData.answer || null;
    if (qTypeExt === 'numeric') return s.numeric.answerValue.trim() || null;
    if (qTypeExt === 'matching') {
      // 与 buildStructuredPayload 同口径：只序列化引用有效条目的配对
      const leftKeys = new Set(s.matching.left.filter((i) => i.content.trim()).map((i) => i.key));
      const rightKeys = new Set(s.matching.right.filter((i) => i.content.trim()).map((i) => i.key));
      const pairs = s.matching.pairs.filter((p) => leftKeys.has(p.left) && rightKeys.has(p.right));
      return pairs.length > 0 ? JSON.stringify({ pairs }) : null;
    }
    if (qTypeExt === 'ordering') {
      return s.ordering.correctOrder.length > 0 ? JSON.stringify(s.ordering.correctOrder) : null;
    }
    if (qTypeExt === 'fill_blank' && blanksActive) {
      const firsts = s.blanks.map((b) => b.answers[0] ?? '');
      return firsts.length <= 1 ? (firsts[0] || null) : JSON.stringify(firsts);
    }
    return editData.answer || null;
  }, [editData.structured, editData.answer, qTypeExt, blanksActive]);

  const handleSave = useCallback(async () => {
    // 结构化题型先做表单校验，避免落库半成品标准答案
    const structuredError = validateStructured();
    if (structuredError) {
      setError(structuredError);
      return;
    }

    setIsSaving(true);
    setError(null);

    const structuredPayload = buildStructuredPayload();
    const answerPayload = buildAnswerPayload();

    try {
      if (mode === 'create') {
        if (!examId) {
          setError(t('exam_sheet:questionBank.create.missingExamId'));
          return;
        }
        if (!editData.content.trim()) {
          setContentTouched(true);
          setError(t('exam_sheet:questionBank.create.contentRequired'));
          return;
        }
        const params = {
          exam_id: examId,
          content: editData.content,
          question_type: editData.questionType || null,
          options: editData.options.length > 0 ? editData.options : null,
          answer: answerPayload,
          structured_data: structuredPayload,
          explanation: editData.explanation || null,
          difficulty: editData.difficulty || null,
          tags: editData.tags.length > 0 ? editData.tags : null,
          question_label: null,
          card_id: null,
          source_type: 'manual',
          source_ref: null,
          images: editData.images.length > 0 ? editData.images : null,
          parent_id: null,
        };
        const raw = await invoke<Record<string, unknown>>('qbank_create_question', { params });
        const newQuestion: Question = {
          id: (raw.id ?? raw.question_id ?? '') as string,
          cardId: (raw.card_id as string) || undefined,
          questionLabel: (raw.question_label as string) || '',
          content: (raw.content as string) || '',
          questionType: (raw.question_type as QuestionType) || 'other',
          options: raw.options as Question['options'],
          answer: raw.answer as string | undefined,
          explanation: raw.explanation as string | undefined,
          difficulty: raw.difficulty as Difficulty | undefined,
          tags: (raw.tags as string[]) || [],
          status: (raw.status as Question['status']) || 'new',
          userNote: raw.user_note as string | undefined,
          attemptCount: (raw.attempt_count as number) || 0,
          correctCount: (raw.correct_count as number) || 0,
          isFavorite: (raw.is_favorite as boolean) || false,
          images: (raw.images as QuestionImage[]) || [],
          lastAttemptAt: raw.last_attempt_at as string | undefined,
          ocrText: raw.ocr_text as string | undefined,
          structured_data: (raw.structured_data ?? structuredPayload) as QuestionStructuredData | null,
          ai_feedback: raw.ai_feedback as string | undefined,
          ai_score: raw.ai_score as number | undefined,
          ai_graded_at: raw.ai_graded_at as string | undefined,
        };
        await onCreate?.(newQuestion);
        onCancel();
        return;
      }

      if (!question) return;

      await invoke('qbank_update_question', {
        request: {
          question_id: question.id,
          params: {
            content: editData.content,
            question_type: editData.questionType || null,
            options: editData.options.length > 0 ? editData.options : null,
            answer: answerPayload,
            structured_data: structuredPayload,
            explanation: editData.explanation || null,
            difficulty: editData.difficulty || null,
            tags: editData.tags.length > 0 ? editData.tags : null,
            user_note: editData.userNote || null,
            images: editData.images.length > 0
              ? editData.images
              : (question?.images?.length ? [] : null),
          },
          record_history: true,
        },
      });

      const updatedQuestion: Question = {
        ...question,
        content: editData.content,
        questionType: editData.questionType as QuestionType,
        options: editData.options,
        answer: answerPayload ?? undefined,
        explanation: editData.explanation || undefined,
        difficulty: editData.difficulty || undefined,
        tags: editData.tags,
        userNote: editData.userNote || undefined,
        images: editData.images,
        structured_data: structuredPayload as unknown as QuestionStructuredData | null,
      };

      await onSave?.(updatedQuestion);
      onCancel();
    } catch (err: unknown) {
      console.error('[QuestionInlineEditor] Save failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [question, editData, onSave, onCancel, mode, examId, onCreate, t, validateStructured, buildStructuredPayload, buildAnswerPayload]);

  const handleCancelRequest = useCallback(() => {
    if (!isDirty || isSaving) {
      onCancel();
      return;
    }
    setShowDiscardConfirm(true);
  }, [isDirty, isSaving, onCancel]);

  const contentMissing = !editData.content.trim();
  // 即时必填反馈：离开题干输入框或尝试保存后，空题干立刻标红提示
  const showContentRequired = contentMissing && contentTouched;

  const isChoiceType = editData.questionType === 'single_choice' || editData.questionType === 'multiple_choice' || editData.questionType === 'indefinite_choice';

  // 选择题：答案即被选中的选项字母集合（点选字母设为答案）。
  // 存储为排序后用逗号连接的字母串（如 "A" / "B,D"），与判分端的标准化比较兼容
  const selectedAnswerKeys = useMemo(() => {
    if (!isChoiceType) return new Set<string>();
    const letters = editData.answer.toUpperCase().replace(/[^A-Z]/g, '').split('');
    return new Set(letters.filter((letter) => editData.options.some((option) => option.key === letter)));
  }, [editData.answer, editData.options, isChoiceType]);

  const toggleAnswerKey = useCallback((key: string) => {
    if (editData.questionType === 'single_choice') {
      // 单选：点其他字母直接切换，再点当前字母取消选择
      handleFieldChange('answer', selectedAnswerKeys.has(key) ? '' : key);
      return;
    }
    const next = new Set(selectedAnswerKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    const ordered = editData.options.map((option) => option.key).filter((optionKey) => next.has(optionKey));
    handleFieldChange('answer', ordered.join(','));
  }, [editData.questionType, editData.options, selectedAnswerKeys, handleFieldChange]);

  return (
    <div
      ref={containerRef}
      data-question-inline-editor
      className={cn(
        'mt-1.5 border border-border/60 rounded-lg bg-card/80 overflow-hidden',
        'ui-drop-in flex max-h-full flex-col',
        className
      )}
    >
      {/* 内容区内部滚动 + 页脚钉底：矮窗口下保存按钮不再被截断 */}
      <CustomScrollArea className="min-h-0 flex-1" viewportClassName="space-y-4 p-4">
        {/* 错误提示 */}
        {error && (
          <div className="flex items-center gap-2 p-2.5 rounded-md bg-destructive/10 text-destructive text-sm">
            <WarningCircle size={16} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* 题目内容（必填，失焦后即时校验） */}
        <div className="space-y-1.5">
          <Label htmlFor="inline-edit-content" className="text-xs">
            {t('exam_sheet:questionBank.edit.content')}
            <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
          </Label>
          <Textarea
            id="inline-edit-content"
            value={editData.content}
            onChange={(e) => handleFieldChange('content', e.target.value)}
            onBlur={() => setContentTouched(true)}
            rows={3}
            placeholder={t('exam_sheet:questionBank.edit.contentPlaceholder')}
            aria-invalid={showContentRequired}
            aria-describedby={showContentRequired ? 'inline-edit-content-error' : undefined}
            className={cn(
              'text-sm transition-colors [@media(pointer:coarse)]:text-[16px]',
              showContentRequired && 'border-destructive/60 focus-visible:ring-destructive/30'
            )}
            autoFocus
/>
          {showContentRequired && (
            <p
              id="inline-edit-content-error"
              className="ui-fade-in flex items-center gap-1 text-xs text-destructive"
            >
              <WarningCircle size={12} className="flex-shrink-0" />
              {t('exam_sheet:questionBank.create.contentRequired')}
            </p>
          )}
        </div>

        {/* 题型 + 难度 横排 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('exam_sheet:questionBank.edit.type')}</Label>
            <AppSelect
              value={editData.questionType}
              onValueChange={(v) => handleFieldChange('questionType', v as ExtendedQuestionType)}
              options={questionTypeKeys.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
              variant="outline"
/>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('exam_sheet:questionBank.edit.difficulty')}</Label>
            <AppSelect
              value={editData.difficulty || 'none'}
              onValueChange={(v) => handleFieldChange('difficulty', v === 'none' ? '' : v as Difficulty)}
              placeholder={t('exam_sheet:questionBank.edit.selectDifficulty')}
              options={[
                { value: 'none', label: t('common:unset') },
                ...difficultyKeys.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
              ]}
              variant="outline"
/>
          </div>
        </div>

        {/* 选项（选择题）— 字母点选即答案，与选项区合并 */}
        {isChoiceType && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="flex items-center text-xs">
                {t('exam_sheet:questionBank.edit.options')}
                {selectedAnswerKeys.size > 0 ? (
                  <span className="ui-fade-in ml-1.5 inline-flex items-center rounded bg-primary/10 px-1.5 py-px font-medium text-[10px] text-primary">
                    {editData.options
                      .map((option) => option.key)
                      .filter((key) => selectedAnswerKeys.has(key))
                      .join(', ')}
                  </span>
                ) : (
                  <span className="ml-1.5 font-normal text-muted-foreground/70">
                    {t('exam_sheet:questionBank.edit.optionsAnswerHint')}
                  </span>
                )}
              </Label>
              <DsButton variant="ghost" size="sm" onClick={handleAddOption} disabled={editData.options.length >= MAX_OPTIONS} className="ui-press h-5 text-[10px] px-1.5 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-3 [@media(pointer:coarse)]:text-xs">
                <Plus size={10} className="mr-0.5" />
                {t('common:actions.add')}
              </DsButton>
            </div>
            {/* 窄屏单列，避免双列输入框在小屏过度拥挤 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {editData.options.map((opt, index) => {
                const isAnswerKey = selectedAnswerKeys.has(opt.key);
                return (
                  <div
                    key={index}
                    className={cn(
                      'group flex items-center gap-1.5 rounded-md border px-1.5 min-h-8 transition-colors',
                      index === lastAddedOptionIndex && 'ui-drop-in',
                      isAnswerKey
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-border/40 bg-muted/10 hover:border-border/70'
                    )}
                  >
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      onClick={() => toggleAnswerKey(opt.key)}
                      title={t('exam_sheet:questionBank.edit.optionsAnswerHint')}
                      aria-label={`${t('exam_sheet:questionBank.edit.answer')} ${opt.key}`}
                      aria-pressed={isAnswerKey}
                      className={cn(
                        // 触屏放大命中区（桌面保持紧凑视觉）
                        'flex-shrink-0 !w-5 !h-5 !p-0 rounded text-[11px] font-semibold',
                        '[@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:-m-0.5',
                        isAnswerKey
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                          : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
                      )}
                    >
                      {opt.key}
                    </DsButton>
                    <Input
                      value={opt.content}
                      onChange={(e) => handleOptionChange(index, 'content', e.target.value)}
                      className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50 [@media(pointer:coarse)]:text-[16px]"
                      placeholder={`${opt.key} ...`}
/>
                    <DsButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveOption(index)} className="flex-shrink-0 !w-4 !h-4 !p-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-70 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:-m-0.5 text-muted-foreground hover:text-destructive" aria-label={t('common:remove', { defaultValue: 'Remove' })}>
                      <X size={10} />
                    </DsButton>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 判断题：答案双按钮点选 */}
        {editData.questionType === 'true_false' && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('exam_sheet:questionBank.edit.answer')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
            </Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {(['true', 'false'] as const).map((value) => {
                const isSelected = editData.answer === value;
                const isTrue = value === 'true';
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => handleFieldChange('answer', isSelected ? '' : value)}
                    className={cn(
                      'ui-press flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border text-sm font-medium transition-colors',
                      isSelected
                        ? isTrue
                          ? 'border-success/60 bg-success/[0.08] text-success'
                          : 'border-destructive/50 bg-destructive/[0.07] text-destructive'
                        : 'border-border/50 bg-muted/10 text-muted-foreground hover:bg-[var(--interactive-hover)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
                    )}
                  >
                    {isTrue ? <Check size={15} weight="bold" /> : <X size={15} />}
                    {isTrue
                      ? t('practice:editor.trueFalse.true')
                      : t('practice:editor.trueFalse.false')}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 匹配题：左右列 + 标准配对编辑 */}
        {editData.questionType === 'matching' && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('exam_sheet:questionBank.edit.answer')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
            </Label>
            <MatchingEditor
              value={editData.structured.matching}
              onChange={(v) => handleStructuredChange('matching', v)}
            />
          </div>
        )}

        {/* 排序题：条目 + 正确顺序编辑 */}
        {editData.questionType === 'ordering' && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('exam_sheet:questionBank.edit.answer')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
            </Label>
            <OrderingEditor
              value={editData.structured.ordering}
              onChange={(v) => handleStructuredChange('ordering', v)}
            />
          </div>
        )}

        {/* 数值题：答案值/容差/单位 */}
        {editData.questionType === 'numeric' && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('exam_sheet:questionBank.edit.answer')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
            </Label>
            <NumericEditor
              value={editData.structured.numeric}
              onChange={(v) => handleStructuredChange('numeric', v)}
              showValidation={!!error}
            />
          </div>
        )}

        {/* 填空题：多空多答案编辑（未配置 blanks 时保留兼容的纯文本答案框） */}
        {editData.questionType === 'fill_blank' && (
          <div className="space-y-2">
            {!blanksActive && (
              <div className="space-y-1.5">
                <Label htmlFor="inline-edit-answer" className="text-xs">
                  {t('exam_sheet:questionBank.edit.answer')}
                </Label>
                <Textarea
                  id="inline-edit-answer"
                  value={editData.answer}
                  onChange={(e) => handleFieldChange('answer', e.target.value)}
                  rows={2}
                  placeholder={t('exam_sheet:questionBank.edit.answerPlaceholder')}
                  className="text-sm [@media(pointer:coarse)]:text-[16px]"
                />
              </div>
            )}
            <BlanksEditor
              blanks={editData.structured.blanks}
              onChange={(v) => handleStructuredChange('blanks', v)}
            />
            {blanksActive && (
              <p className="text-[11px] text-muted-foreground/70">
                {t('practice:editor.structEdit.blanksAutoAnswerHint')}
              </p>
            )}
          </div>
        )}

        {/* 答案（其余非选择题型） */}
        {!isChoiceType && !isStructuredType && editData.questionType !== 'fill_blank' && (
          <div className="space-y-1.5">
            <Label htmlFor="inline-edit-answer" className="text-xs">
              {t('exam_sheet:questionBank.edit.answer')}
            </Label>
            <Textarea
              id="inline-edit-answer"
              value={editData.answer}
              onChange={(e) => handleFieldChange('answer', e.target.value)}
              rows={2}
              placeholder={t('exam_sheet:questionBank.edit.answerPlaceholder')}
              className="text-sm [@media(pointer:coarse)]:text-[16px]"
/>
          </div>
        )}

        {/* 标签 */}
        <div className="space-y-1.5">
          <Label className="text-xs">{t('exam_sheet:questionBank.edit.tags')}</Label>
          <div className="flex items-center gap-1.5">
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTag())}
              placeholder={t('exam_sheet:questionBank.edit.tagPlaceholder')}
              className="flex-1 text-sm h-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]"
/>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleAddTag}
              disabled={!tagInput.trim()}
              aria-label={t('common:actions.add')}
              className="w-8 h-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 ui-press"
              iconOnly
            >
              <Plus size={14} />
            </DsButton>
          </div>
          {editData.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {editData.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  // 触屏视觉保持小巧，用 after 伪元素把命中区扩到 ≥44px（28 + 8×2）
                  className="cursor-pointer hover:bg-destructive/20 text-xs h-5 relative [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:px-2 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']"
                  onClick={() => handleRemoveTag(tag)}
                >
                  {tag}
                  <X size={10} className="ml-0.5" />
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* 题目图片 — 紧凑缩略图条 */}
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1 text-xs">
            <ImageIcon size={14} className="text-muted-foreground" />
            {t('exam_sheet:questionBank.edit.images')}
            {editData.images.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({editData.images.length}/{MAX_IMAGES})</span>
            )}
          </Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleImageUpload(e.target.files);
                e.target.value = '';
              }
            }}
/>
          {editData.images.length === 0 ? (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingImage}
              className="w-full !h-9 [@media(pointer:coarse)]:!h-11 !rounded-md border border-dashed border-border/50 hover:border-border bg-muted/10 hover:bg-[var(--interactive-hover)] gap-1.5"
            >
              {isUploadingImage ? (
                <CircleNotch size={14} className="animate-spin text-muted-foreground" />
              ) : (
                <Image size={14} className="text-muted-foreground" />
              )}
              <span className="text-xs text-muted-foreground">
                {t('exam_sheet:questionBank.edit.imagePlaceholder')}
              </span>
            </DsButton>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {editData.images.map((img) => (
                <div
                  key={img.id}
                  className="group relative h-14 w-14 rounded-md overflow-hidden border border-border/40 bg-muted/20"
                >
                  {imagePreviewUrls[img.id] && imagePreviewUrls[img.id] !== 'error' ? (
                    <img src={imagePreviewUrls[img.id]} alt={img.name} className="w-full h-full object-cover" />
                  ) : imagePreviewUrls[img.id] === 'error' ? (
                    <div className="w-full h-full flex items-center justify-center">
                      <WarningCircle size={16} className="text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <CircleNotch size={16} className="animate-spin text-muted-foreground" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <DsButton
                      variant="ghost"
                      size="sm"
                      iconOnly
                      onClick={() => handleRemoveImage(img.id)}
 className="w-6 h-6 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity text-white hover:text-white hover:bg-[var(--overlay-control-hover)]"
                    >
                      <Trash size={12} />
                    </DsButton>
                  </div>
                </div>
              ))}
              {editData.images.length < MAX_IMAGES && (
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingImage}
                  aria-label={t('exam_sheet:questionBank.edit.addImage')}
                  className="!h-14 !w-14 !rounded-md border border-dashed border-border/50 hover:border-border bg-muted/10 hover:bg-[var(--interactive-hover)] text-muted-foreground"
                >
                  {isUploadingImage ? (
                    <CircleNotch size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                </DsButton>
              )}
            </div>
          )}
        </div>

        {/* 解析 + 笔记（选填折叠区，默认收起保持表单紧凑） */}
        <div className="space-y-1.5">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setShowOptional((v) => !v)}
            className="h-6 px-1 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
            aria-expanded={showOptional}
          >
            {showOptional ? (
              <CaretDown size={12} className="mr-1" />
            ) : (
              <CaretRight size={12} className="mr-1" />
            )}
            {t('exam_sheet:questionBank.edit.moreOptional')}
            {!showOptional && (editData.explanation.trim() || editData.userNote.trim()) && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
          </DsButton>
          {showOptional && (
            <div className="grid grid-cols-1 gap-3 pt-1">
              <div className="space-y-1.5">
                <Label htmlFor="inline-edit-explanation" className="text-xs">
                  {t('exam_sheet:questionBank.edit.explanation')}
                </Label>
                <Textarea
                  id="inline-edit-explanation"
                  value={editData.explanation}
                  onChange={(e) => handleFieldChange('explanation', e.target.value)}
                  rows={2}
                  placeholder={t('exam_sheet:questionBank.edit.explanationPlaceholder')}
                  className="text-sm [@media(pointer:coarse)]:text-[16px]"
/>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inline-edit-note" className="text-xs">
                  {t('exam_sheet:questionBank.edit.note')}
                </Label>
                <Textarea
                  id="inline-edit-note"
                  value={editData.userNote}
                  onChange={(e) => handleFieldChange('userNote', e.target.value)}
                  rows={2}
                  placeholder={t('exam_sheet:questionBank.edit.notePlaceholder')}
                  className="text-sm [@media(pointer:coarse)]:text-[16px]"
/>
              </div>
            </div>
          )}
        </div>

        {/* 实时预览（页脚切换；复用 LatexText 渲染公式，单题编辑无虚拟列表性能顾虑） */}
        {showPreview && (
          <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2 text-sm">
            {editData.content.trim() ? (
              <LatexText content={editData.content} />
            ) : (
              <span className="text-muted-foreground">
                {t('exam_sheet:questionBank.edit.contentPlaceholder')}
              </span>
            )}
            {isChoiceType && editData.options.some((o) => o.content.trim()) && (
              <div className="space-y-1 pt-1">
                {editData.options.map((opt, index) =>
                  opt.content.trim() ? (
                    <div key={index} className="flex items-start gap-1.5">
                      <span className="flex-shrink-0 font-medium text-muted-foreground">{opt.key}.</span>
                      <LatexText content={opt.content} />
                    </div>
                  ) : null
                )}
              </div>
            )}
            {editData.answer.trim() && (
              <div className="flex items-start gap-1.5 border-t border-border/30 pt-1">
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {t('exam_sheet:questionBank.edit.answer')}:
                </span>
                <LatexText content={editData.answer} />
              </div>
            )}
            {editData.explanation.trim() && (
              <div className="flex items-start gap-1.5">
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {t('exam_sheet:questionBank.edit.explanation')}:
                </span>
                <LatexText content={editData.explanation} />
              </div>
            )}
          </div>
        )}
      </CustomScrollArea>

      {/* 未保存改动的内联放弃确认条（钉底，替代原模态确认框） */}
      {showDiscardConfirm && (
        <div
          role="alert"
          className="ui-drop-in flex-shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-t border-warning/30 bg-warning/10"
        >
          <WarningCircle size={15} className="flex-shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-xs text-foreground">
            {t('common:confirmMessages.unsaved_changes')}
          </span>
          <div className="flex items-center gap-1.5">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setShowDiscardConfirm(false)}
              className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-11 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
            >
              {t('learningHub:exam.library.keepEditing')}
            </DsButton>
            <DsButton
              variant="danger"
              size="sm"
              onClick={onCancel}
              className="!h-auto !px-2 !py-1 [@media(pointer:coarse)]:!min-h-11 text-xs"
            >
              {t('common:actions.discard')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 底部操作栏：左侧预览切换，右侧取消/保存（钉底，不随内容滚动） */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border/40 bg-muted/20">
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => setShowPreview((v) => !v)}
          className={cn('h-6 text-xs [@media(pointer:coarse)]:!min-h-11', showPreview ? 'text-primary' : 'text-muted-foreground')}
          aria-expanded={showPreview}
        >
          <Eye size={14} className="mr-1" />
          {t('common:actions.preview')}
        </DsButton>
        <div className="flex items-center gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleCancelRequest}
            disabled={isSaving}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton
            size="sm"
            onClick={handleSave}
            disabled={isSaving}
            className="ui-press [@media(pointer:coarse)]:!min-h-11"
          >
            {isSaving ? (
              <CircleNotch size={14} className="mr-1.5 animate-spin" />
            ) : (
              <FloppyDisk size={14} className="mr-1.5" />
            )}
            {mode === 'create'
              ? t('exam_sheet:questionBank.create.submit')
              : t('common:actions.save')}
          </DsButton>
        </div>
      </div>
    </div>
  );
};

export default QuestionInlineEditor;
