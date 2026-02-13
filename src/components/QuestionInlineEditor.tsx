/**
 * 题目内联编辑器
 * 
 * Accordion 风格：在题目卡片下方展开编辑表单，保存/取消后收起。
 * 从 QuestionEditDrawer 提取编辑逻辑，去掉 Sheet 容器。
 *
 * 2026-02 新增
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Badge } from '@/components/ui/shad/Badge';
import { AppSelect } from '@/components/ui/app-menu';
import {
  Save,
  X,
  Loader2,
  Plus,
  Trash2,
  AlertCircle,
  ImagePlus,
  Image as ImageIcon,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { Question, QuestionType, Difficulty, QuestionImage } from '@/api/questionBankApi';

export interface QuestionInlineEditorProps {
  question: Question | null;
  onSave?: (question: Question) => Promise<void>;
  onCancel: () => void;
  mode?: 'edit' | 'create';
  examId?: string;
  onCreate?: (question: Question) => Promise<void>;
  className?: string;
}

interface EditableQuestion {
  content: string;
  questionType: QuestionType;
  options: { key: string; content: string }[];
  answer: string;
  explanation: string;
  difficulty: Difficulty | '';
  tags: string[];
  userNote: string;
  images: QuestionImage[];
}

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const questionTypeKeys: { value: QuestionType; labelKey: string }[] = [
  { value: 'single_choice', labelKey: 'exam_sheet:questionBank.edit.questionTypes.single_choice' },
  { value: 'multiple_choice', labelKey: 'exam_sheet:questionBank.edit.questionTypes.multiple_choice' },
  { value: 'fill_blank', labelKey: 'exam_sheet:questionBank.edit.questionTypes.fill_blank' },
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
  mode = 'edit',
  examId,
  onCreate,
  className,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);

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
  });
  const [tagInput, setTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<Record<string, string>>({});
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 初始化编辑数据
  useEffect(() => {
    if (mode === 'create') {
      setEditData({
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
      });
      setError(null);
      setTagInput('');
      setImagePreviewUrls({});
    } else if (question) {
      setEditData({
        content: question.content || '',
        questionType: question.questionType || 'other',
        options: question.options || [],
        answer: question.answer || '',
        explanation: question.explanation || '',
        difficulty: question.difficulty || '',
        tags: question.tags || [],
        userNote: question.userNote || '',
        images: question.images || [],
      });
      loadImagePreviews(question.images || []);
    }
  }, [question, mode]);

  // 展开后自动滚动到可见
  useEffect(() => {
    const timer = setTimeout(() => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // 加载图片预览
  const loadImagePreviews = useCallback(async (images: QuestionImage[]) => {
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
          showGlobalNotification('warning', `${file.name}: ${t('exam_sheet:image.max_size', { size: '10MB' })}`);
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
    const nextKey = String.fromCharCode(65 + editData.options.length);
    setEditData(prev => ({
      ...prev,
      options: [...prev.options, { key: nextKey, content: '' }],
    }));
  }, [editData.options.length]);

  const handleRemoveOption = useCallback((index: number) => {
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

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);

    try {
      if (mode === 'create') {
        if (!examId) {
          setError(t('exam_sheet:questionBank.create.missingExamId'));
          return;
        }
        if (!editData.content.trim()) {
          setError(t('exam_sheet:questionBank.create.contentRequired'));
          return;
        }
        const params = {
          exam_id: examId,
          content: editData.content,
          question_type: editData.questionType || null,
          options: editData.options.length > 0 ? editData.options : null,
          answer: editData.answer || null,
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
          id: raw.id as string,
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
            content: editData.content || undefined,
            question_type: editData.questionType || undefined,
            options: editData.options.length > 0 ? editData.options : undefined,
            answer: editData.answer || undefined,
            explanation: editData.explanation || undefined,
            difficulty: editData.difficulty || undefined,
            tags: editData.tags.length > 0 ? editData.tags : undefined,
            user_note: editData.userNote || undefined,
            images: editData.images.length > 0
              ? editData.images
              : (question?.images?.length ? [] : undefined),
          },
          record_history: true,
        },
      });

      const updatedQuestion: Question = {
        ...question,
        content: editData.content,
        questionType: editData.questionType,
        options: editData.options,
        answer: editData.answer,
        explanation: editData.explanation,
        difficulty: editData.difficulty || undefined,
        tags: editData.tags,
        userNote: editData.userNote,
        images: editData.images,
      };

      await onSave?.(updatedQuestion);
      onCancel();
    } catch (err: unknown) {
      console.error('[QuestionInlineEditor] Save failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [question, editData, onSave, onCancel, mode, examId, onCreate, t]);

  const isChoiceType = editData.questionType === 'single_choice' || editData.questionType === 'multiple_choice';

  return (
    <div
      ref={containerRef}
      className={cn(
        'mt-1.5 border border-border/60 rounded-lg bg-card/80 overflow-hidden',
        'animate-in slide-in-from-top-2 fade-in duration-200',
        className
      )}
    >
      <div className="p-4 space-y-4">
        {/* 错误提示 */}
        {error && (
          <div className="flex items-center gap-2 p-2.5 rounded-md bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* 题目内容 */}
        <div className="space-y-1.5">
          <Label htmlFor="inline-edit-content" className="text-xs">
            {t('exam_sheet:questionBank.edit.content')}
          </Label>
          <Textarea
            id="inline-edit-content"
            value={editData.content}
            onChange={(e) => handleFieldChange('content', e.target.value)}
            rows={3}
            placeholder={t('exam_sheet:questionBank.edit.contentPlaceholder')}
            className="text-sm"
            autoFocus
          />
        </div>

        {/* 题型 + 难度 横排 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('exam_sheet:questionBank.edit.type')}</Label>
            <AppSelect
              value={editData.questionType}
              onValueChange={(v) => handleFieldChange('questionType', v as QuestionType)}
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

        {/* 选项（选择题）— 紧凑双列 */}
        {isChoiceType && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('exam_sheet:questionBank.edit.options')}</Label>
              <NotionButton variant="ghost" size="sm" onClick={handleAddOption} className="h-5 text-[10px] px-1.5">
                <Plus className="w-2.5 h-2.5 mr-0.5" />
                {t('common:actions.add')}
              </NotionButton>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {editData.options.map((opt, index) => (
                <div key={index} className="group flex items-center gap-1 rounded-md border border-border/40 bg-muted/10 px-2 h-7">
                  <span className="text-xs font-medium text-muted-foreground w-4 flex-shrink-0">{opt.key}</span>
                  <input
                    value={opt.content}
                    onChange={(e) => handleOptionChange(index, 'content', e.target.value)}
                    className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                    placeholder={`${opt.key} ...`}
                  />
                  <button
                    onClick={() => handleRemoveOption(index)}
                    className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 答案 + 解析 */}
        <div className="grid grid-cols-1 gap-3">
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
              className="text-sm"
            />
          </div>
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
              className="text-sm"
            />
          </div>
        </div>

        {/* 标签 */}
        <div className="space-y-1.5">
          <Label className="text-xs">{t('exam_sheet:questionBank.edit.tags')}</Label>
          <div className="flex items-center gap-1.5">
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTag())}
              placeholder={t('exam_sheet:questionBank.edit.tagPlaceholder')}
              className="flex-1 text-sm h-8"
            />
            <NotionButton variant="ghost" size="sm" onClick={handleAddTag} className="h-8 w-8" iconOnly>
              <Plus className="w-3.5 h-3.5" />
            </NotionButton>
          </div>
          {editData.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {editData.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="cursor-pointer hover:bg-destructive/20 text-xs h-5"
                  onClick={() => handleRemoveTag(tag)}
                >
                  {tag}
                  <X className="w-2.5 h-2.5 ml-0.5" />
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* 题目图片 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1 text-xs">
              <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
              {t('exam_sheet:questionBank.edit.images', '题目图片')}
              {editData.images.length > 0 && (
                <span className="text-[10px] text-muted-foreground">({editData.images.length}/{MAX_IMAGES})</span>
              )}
            </Label>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={editData.images.length >= MAX_IMAGES || isUploadingImage}
              className="h-6 text-xs"
            >
              {isUploadingImage ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <ImagePlus className="w-3 h-3 mr-1" />
              )}
              {t('exam_sheet:questionBank.edit.addImage', '添加')}
            </NotionButton>
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
          </div>

          {editData.images.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5">
              {editData.images.map((img) => (
                <div
                  key={img.id}
                  className="group relative rounded-md overflow-hidden border border-border/40 bg-muted/20 aspect-square"
                >
                  {imagePreviewUrls[img.id] && imagePreviewUrls[img.id] !== 'error' ? (
                    <img src={imagePreviewUrls[img.id]} alt={img.name} className="w-full h-full object-cover" />
                  ) : imagePreviewUrls[img.id] === 'error' ? (
                    <div className="w-full h-full flex items-center justify-center">
                      <AlertCircle className="w-4 h-4 text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      iconOnly
                      onClick={() => handleRemoveImage(img.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-white hover:text-white hover:bg-white/20 h-6 w-6"
                    >
                      <Trash2 className="w-3 h-3" />
                    </NotionButton>
                  </div>
                </div>
              ))}
            </div>
          )}

          {editData.images.length === 0 && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full p-4 rounded-md border border-dashed border-border/50 hover:border-border bg-muted/10 hover:bg-muted/20 transition-colors flex items-center justify-center gap-2 cursor-pointer"
              disabled={isUploadingImage}
            >
              <ImagePlus className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t('exam_sheet:questionBank.edit.imagePlaceholder', '点击添加题目图片')}
              </span>
            </button>
          )}
        </div>

        {/* 笔记 */}
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
            className="text-sm"
          />
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/40 bg-muted/20">
        <NotionButton variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          {t('common:actions.cancel')}
        </NotionButton>
        <NotionButton size="sm" onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5 mr-1.5" />
          )}
          {mode === 'create'
            ? t('exam_sheet:questionBank.create.submit')
            : t('common:actions.save')}
        </NotionButton>
      </div>
    </div>
  );
};

export default QuestionInlineEditor;
