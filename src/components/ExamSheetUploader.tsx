/**
 * ExamSheetUploader - 题目集「识别导入」
 *
 * 图片（试卷照片）与文档（PDF / Word / Excel / 文本）统一走后端
 * `import_question_bank_stream`：后端按格式选择 VLM 直提或文本 + LLM 结构化，
 * 通过 `question_import_progress` 事件流式回报进度与逐题结果。
 *
 * 界面按「一屏只表达一次同一信息」组织（2026-10 精简）：
 * - 选择：拖放区 → 选中后收成一行「添加 / 更换」条，下方是已选文件 + 解析模型 + 操作；
 * - 解析中：一行状态（文字 + 进度条 + 取消）+ 实时题目列表；
 * - 完成：一行结果标题 + 题型分布 + 可勾选的「本次新增」题目列表 + 操作。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  CircleNotch,
  X,
  FileText,
  WarningCircle,
  CheckCircle,
  Info,
  UploadSimple,
  Plus,
  Camera,
  ArrowClockwise,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Progress } from '@/components/ui/shad/Progress';
import { CustomScrollArea } from './custom-scroll-area';
import { LatexText } from './LatexText';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { emitImportDebug } from '@/debug-panel/plugins/QuestionImportDebugPlugin';
import { UnifiedModelSelector, type UnifiedModelInfo } from '@/components/shared/UnifiedModelSelector';
import { UnifiedDragDropZone, DEFAULT_MAX_UPLOAD_FILE_SIZE, type FileTypeDefinition } from '@/components/shared/UnifiedDragDropZone';
import type { ApiConfig } from '@/types';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { describeHeicConversionError, isHeicFile, prepareHeicFiles } from '@/utils/heicConversion';

// ★ 试卷上传专用文件类型（支持 HEIC，与统一组件的 IMAGE 略有不同）
// 导出给题目集启动台的拖放区域复用，保证两处接受的文件类型一致
export const EXAM_IMAGE_TYPE: FileTypeDefinition = {
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'],
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
  description: 'Image',
};
export const EXAM_DOCUMENT_TYPE: FileTypeDefinition = {
  extensions: ['docx', 'xlsx', 'xls', 'txt', 'md', 'pdf'],
  mimeTypes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/plain',
    'text/markdown',
    'application/pdf',
  ],
  description: 'Document',
};

export interface ExamSheetUploaderProps {
  /** 现有会话 ID（如果是追加上传） */
  sessionId?: string;
  /** 会话名称 */
  sessionName?: string;
  /** 上传成功回调 */
  onUploadSuccess?: (detail: ExamSheetSessionDetail) => void;
  /** 返回按钮回调 */
  onBack?: () => void;
  /** 「没有文件？手动新建一道题」回调（缺省回退到 onBack） */
  onManualCreate?: () => void;
  /** 从题目集启动台拖入的初始文件（传入后自动带入选择流程） */
  initialFiles?: File[] | null;
  /** initialFiles 消费完成回调（父组件应清空对应状态） */
  onInitialFilesConsumed?: () => void;
  /** 自定义类名 */
  className?: string;
}

// 文件类型分类
type FileCategory = 'image' | 'document';

interface FileInfo {
  file: File;
  category: FileCategory;
  previewUrl?: string;
}

// 支持的格式
const IMAGE_FORMATS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic'];
const DOCUMENT_EXTENSIONS = ['.docx', '.xlsx', '.xls', '.txt', '.md', '.pdf'];

// ★ 上传文件大小上限：引用 UnifiedDragDropZone 的统一默认上限（#62/ATT-09，
// 与 Tauri 原生拖拽路径保持一致，不再各自硬编码 50MB）。
// 点击选择 / 浏览器 dataTransfer 拖拽路径不经过原生路径校验，必须在此兜底，
// 否则超大文件会被整体 FileReader→base64 读入内存。
const MAX_UPLOAD_FILE_SIZE = DEFAULT_MAX_UPLOAD_FILE_SIZE;

// 处理步骤
type ProcessStep = 'select' | 'processing' | 'summary';

type ExamSheetCard = NonNullable<ExamSheetSessionDetail['preview']['pages'][number]['cards']>[number];

/** 导入结果摘要（只统计本次导入新增的题目） */
export interface ImportSummary {
  /** 本次新增的题目（追加到已有题目集时不含原有题目） */
  cards: ExamSheetCard[];
  questionTypes: Record<string, number>;
  emptyQuestions: number;
}

/**
 * 从导入后的会话详情中挑出「本次新增」的题目并统计。
 *
 * 追加导入时会话里还有原有题目：摘要与筛选列表若混入它们，用户「取消勾选」
 * 会把原有题目一并删掉（2026-10 修复）。baseline 为导入前的题目 ID 集合；
 * 为 null（导入前快照失败）时退回统计全部题目。
 */
export function buildImportSummary(
  detail: ExamSheetSessionDetail,
  baseline: ReadonlySet<string> | null,
): ImportSummary {
  const pages = detail.preview?.pages || [];
  const allCards = pages.flatMap(p => p.cards || []);
  const cards = baseline ? allCards.filter(card => !baseline.has(card.card_id)) : allCards;
  const questionTypes: Record<string, number> = {};
  let emptyQuestions = 0;
  for (const card of cards) {
    const qType = card.question_type || 'other';
    questionTypes[qType] = (questionTypes[qType] || 0) + 1;
    if (!card.ocr_text?.trim()) emptyQuestions++;
  }
  return { cards, questionTypes, emptyQuestions };
}

interface ImportAttempt {
  id: string;
  generation: number;
  backendStarted: boolean;
  /**
   * 断点续导：resume_question_import 发出的进度事件不携带 import_id，
   * 只能按 session_id 过滤。设置该字段后事件过滤切换为 session 维度。
   */
  resumeSessionId?: string;
  /** 本次流式导入创建的 session（SessionCreated 事件回填），失败时用于断点续导 */
  createdSessionId?: string;
}

interface ParsedQuestionPreview {
  content: string;
  question_type?: string;
  answer?: string;
  options?: Array<{ key: string; content: string }>;
}

const createQuestionImportId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `question-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const errorMessageOf = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
};

const readFileAsBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    resolve(dataUrl.split(',')[1] || dataUrl);
  };
  reader.onerror = () => reject(new Error('File read failed'));
  reader.readAsDataURL(file);
});

export const ExamSheetUploader: React.FC<ExamSheetUploaderProps> = ({
  sessionId,
  sessionName,
  onUploadSuccess,
  onBack,
  onManualCreate,
  initialFiles,
  onInitialFilesConsumed,
  className,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'settings']);
  const resolvedSessionName = sessionName ?? t('exam_sheet:uploader.session_name_default');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // ★ 标签页：ref 持有 sessionId，供 question_import_progress 空 deps 监听器过滤事件
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Each stream import has a unique id and a local generation. Both async
  // results and global Tauri events must match this attempt before they can
  // update the uploader, so a cancelled/failed run cannot overwrite a retry.
  const importGenerationRef = useRef(0);
  const activeImportAttemptRef = useRef<ImportAttempt | null>(null);
  const mountedRef = useRef(true);
  // 导入前已有题目 ID：摘要只展示本次新增题目（见 buildImportSummary）
  const baselineCardIdsRef = useRef<Set<string> | null>(null);

  // 文件状态
  const [selectedFiles, setSelectedFiles] = useState<FileInfo[]>([]);
  // 拖拽悬停高亮（来自 UnifiedDragDropZone 的拖拽状态回调）
  const [isDragActive, setIsDragActive] = useState(false);

  const [step, setStep] = useState<ProcessStep>('select');
  const [qbankName, setQbankName] = useState('');
  const [isLLMProcessing, setIsLLMProcessing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  // 取消导入的内联二次确认（不使用模态框）
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [llmProgress, setLlmProgress] = useState({ percent: 0, message: '' });
  // 后端 Completed 事件标记的「可能缺题」（VLM 中途失败 / 部分写库失败），在完成页提示
  const [importIncomplete, setImportIncomplete] = useState(false);
  // 断点续导：流式导入失败但已有 checkpoint 时提供"从断点恢复"入口
  const [resumableSession, setResumableSession] = useState<{ sessionId: string; parsedCount: number } | null>(null);
  const [isResumeRun, setIsResumeRun] = useState(false);
  // 已解析题目数（ref 供异步 catch 分支读取，避免闭包读到过期 state）
  const parsedCountRef = useRef(0);
  // 流式题目列表容器：新题到达时自动滚动到底部
  const parsedListRef = useRef<HTMLDivElement>(null);

  // 实时解析的题目列表（流式显示）
  const [parsedQuestions, setParsedQuestions] = useState<ParsedQuestionPreview[]>([]);

  // 模型选择
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<UnifiedModelInfo[]>([]);

  const [error, setError] = useState<string | null>(null);

  // 导入结果摘要
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [pendingDetail, setPendingDetail] = useState<ExamSheetSessionDetail | null>(null);

  // 完成页：用户取消勾选不需要录入的题目
  const [excludedCardIds, setExcludedCardIds] = useState<Set<string>>(new Set());
  const [isConfirming, setIsConfirming] = useState(false);

  const isCurrentImportAttempt = useCallback((attempt: ImportAttempt): boolean => {
    const activeAttempt = activeImportAttemptRef.current;
    return mountedRef.current
      && activeAttempt?.id === attempt.id
      && activeAttempt.generation === attempt.generation;
  }, []);

  const beginImportAttempt = useCallback((): ImportAttempt => {
    const attempt: ImportAttempt = {
      id: createQuestionImportId(),
      generation: importGenerationRef.current + 1,
      backendStarted: false,
    };
    importGenerationRef.current = attempt.generation;
    activeImportAttemptRef.current = attempt;
    setStep('processing');
    setIsLLMProcessing(true);
    setIsCancelling(false);
    setShowCancelConfirm(false);
    setLlmProgress({ percent: 0, message: t('exam_sheet:uploader.reading_document') });
    setImportIncomplete(false);
    setResumableSession(null);
    setIsResumeRun(false);
    parsedCountRef.current = 0;
    setParsedQuestions([]);
    setError(null);
    return attempt;
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attempt = activeImportAttemptRef.current;
      activeImportAttemptRef.current = null;
      if (attempt) {
        void invoke<boolean>('cancel_question_bank_import', { importId: attempt.id })
          .catch(() => undefined);
      }
    };
  }, []);

  // 加载可用模型列表（与 Chat V2 MultiSelectModelPanel 相同方式）
  const loadModels = useCallback(async () => {
    try {
      const configs = await TauriAPI.getApiConfigurations();
      const chatModels = (configs || []).filter((cfg: ApiConfig) => {
        const isEmbedding = cfg.isEmbedding === true || (cfg as any).is_embedding === true;
        const isReranker = cfg.isReranker === true || (cfg as any).is_reranker === true;
        const isEnabled = cfg.enabled !== false;
        return !isEmbedding && !isReranker && isEnabled;
      });
      setAvailableModels(
        chatModels.map((cfg: ApiConfig) => ({
          id: cfg.id,
          name: cfg.name,
          model: cfg.model,
          isMultimodal: cfg.isMultimodal,
          isReasoning: cfg.isReasoning,
        }))
      );
    } catch (error: unknown) {
      debugLog.error('[ExamSheetUploader] Failed to load models:', error);
      setAvailableModels([]);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    const reload = () => { void loadModels(); };
    try {
      window.addEventListener('api_configurations_changed', reload as EventListener);
    } catch {}
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', reload as EventListener);
      } catch {}
    };
  }, [loadModels]);

  // 流式导入事件监听
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    const setupListener = async () => {
      const nextUnlisten = await listen<{
        type: string;
        import_id?: string;
        session_id?: string;
        name?: string;
        total_chunks?: number;
        chunk_index?: number;
        question?: unknown;
        question_index?: number;
        total_parsed?: number;
        questions_in_chunk?: number;
        total_questions?: number;
        partial?: boolean;
        failed_count?: number;
        total_images?: number;
        total_chars?: number;
        image_index?: number;
        error?: string;
        stage?: string;
        message?: string;
        percent?: number;
        current?: number;
        total?: number;
      }>('question_import_progress', (event) => {
        const payload = event.payload;

        // The backend tags every new stream attempt. Ignore everything except
        // the active attempt so late events from a cancelled/failed import
        // cannot mutate the progress or summary of a retry.
        const activeAttempt = activeImportAttemptRef.current;
        if (!activeAttempt) {
          return;
        }
        if (activeAttempt.resumeSessionId) {
          // 断点续导：resume_question_import 事件不带 import_id，按 session 过滤
          if (payload.import_id) return;
          if (payload.session_id && payload.session_id !== activeAttempt.resumeSessionId) return;
        } else if (payload.import_id !== activeAttempt.id) {
          return;
        }

        // ★ 标签页：过滤非当前 session 的事件，防止多 tab 上传时交叉污染
        if (sessionIdRef.current && payload.session_id && payload.session_id !== sessionIdRef.current) {
          return;
        }

        // 进度只增不减：Math.max 防乱序 / 迟到事件把进度条打回去
        const advance = (percent: number, message: string) => {
          setLlmProgress(prev => ({ percent: Math.max(prev.percent, percent), message }));
        };

        switch (payload.type) {
          case 'Preprocessing':
            advance(payload.percent || 0, payload.message || t('exam_sheet:uploader.preprocessing'));
            break;
          case 'RenderingPages': {
            const done = payload.current || 0;
            const total = payload.total || 1;
            advance(
              Math.min(Math.round((done / total) * 15) + 2, 17),
              t('exam_sheet:uploader.rendering_pages', { current: done, total }),
            );
            break;
          }
          case 'OcrImageCompleted': {
            // OCR/VLM 阶段占进度条 20~40%（DOCX 预处理已占到 20%）
            const done = (payload.image_index || 0) + 1;
            const total = payload.total_images || 1;
            advance(
              Math.min(20 + Math.round((done / total) * 20), 40),
              t('exam_sheet:uploader.ocr_image_progress', { current: done, total }),
            );
            break;
          }
          case 'OcrPhaseCompleted':
            advance(40, t('exam_sheet:uploader.ocr_phase_done', { total: payload.total_images }));
            break;
          case 'ExtractingFigures': {
            const done = payload.current || 0;
            const total = payload.total || 1;
            advance(
              Math.min(40 + Math.round((done / total) * 5), 45),
              t('exam_sheet:uploader.extracting_figures', { current: done, total }),
            );
            break;
          }
          case 'StructuringQuestion':
            advance(45, t('exam_sheet:uploader.structuring_questions', {
              current: payload.current || 0,
              total: payload.total || 1,
            }));
            break;
          case 'SessionCreated':
            // 回填本次导入创建的 session，失败时用于断点续导
            if (payload.session_id) {
              activeAttempt.createdSessionId = payload.session_id;
            }
            advance(42, t('exam_sheet:uploader.parsing_started'));
            break;
          case 'ChunkStart':
            // LLM 解析阶段占 42~90%
            advance(
              Math.min(42 + ((payload.chunk_index || 0) / (payload.total_chunks || 1)) * 48, 90),
              parsedCountRef.current > 0
                ? t('exam_sheet:uploader.parsed_count', { count: parsedCountRef.current })
                : t('exam_sheet:uploader.parsing_started'),
            );
            break;
          case 'QuestionParsed':
            if (payload.question) {
              const q = payload.question as Partial<ParsedQuestionPreview>;
              setParsedQuestions(prev => [...prev, {
                content: q.content || '',
                question_type: q.question_type,
                answer: q.answer,
                options: q.options,
              }]);
            }
            parsedCountRef.current = payload.total_parsed || 0;
            setLlmProgress(prev => ({
              ...prev,
              message: t('exam_sheet:uploader.parsed_count', { count: payload.total_parsed }),
            }));
            break;
          case 'ChunkCompleted':
            parsedCountRef.current = payload.total_parsed || 0;
            advance(
              Math.min(42 + (((payload.chunk_index || 0) + 1) / (payload.total_chunks || 1)) * 48, 90),
              t('exam_sheet:uploader.parsed_count', { count: payload.total_parsed || 0 }),
            );
            break;
          case 'Completed':
            // ★ #6(round2): VLM 中途失败但已存部分题时 partial=true；写库失败 failed_count>0。
            // 两者都意味着「可能缺题」，在完成页提示（非阻塞，不触发失败态）
            parsedCountRef.current = payload.total_questions || 0;
            setImportIncomplete(Boolean(payload.partial) || (payload.failed_count || 0) > 0);
            setLlmProgress({
              percent: 100,
              message: t('exam_sheet:uploader.import_done', { count: payload.total_questions }),
            });
            break;
          case 'Failed': {
            setError(t('exam_sheet:uploader.import_failed_prefix', { error: payload.error }));
            // 已解析部分题目且后端留有 checkpoint → 提供断点续导入口
            const failedSessionId = payload.session_id || activeAttempt.createdSessionId;
            if (failedSessionId && (payload.total_parsed || 0) > 0) {
              setResumableSession({
                sessionId: failedSessionId,
                parsedCount: payload.total_parsed || 0,
              });
            }
            // 流式错误可能先于 invoke reject 到达。必须结束 processing 状态并回到
            // 文件选择页，保留选中的文件让用户可以直接重试。
            setIsLLMProcessing(false);
            setIsCancelling(false);
            setShowCancelConfirm(false);
            setStep('select');
            break;
          }
        }
      });
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // 流式出题预览：新题目到达时自动滚动到列表底部
  useEffect(() => {
    if (step !== 'processing') return;
    const el = parsedListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [parsedQuestions.length, step]);

  const showSummary = useCallback((detail: ExamSheetSessionDetail) => {
    setImportSummary(buildImportSummary(detail, baselineCardIdsRef.current));
    setPendingDetail(detail);
    setExcludedCardIds(new Set());
    setStep('summary');
  }, []);

  // 导入前快照已有题目 ID（追加导入时用于区分本次新增）；失败返回 null（退回统计全部）
  const snapshotBaselineCardIds = useCallback(async (): Promise<Set<string> | null> => {
    if (!sessionId) return new Set();
    try {
      const detail = await TauriAPI.getExamSheetSessionDetail(sessionId);
      return new Set(
        (detail.preview?.pages || []).flatMap(p => p.cards || []).map(card => card.card_id),
      );
    } catch (err: unknown) {
      debugLog.warn('[ExamSheetUploader] 导入前题目快照失败，完成页将统计全部题目:', err);
      return null;
    }
  }, [sessionId]);

  /** 发起一次流式导入（图片：content 为 base64 JSON 数组，format='image'） */
  const runStreamImport = useCallback(async (
    attempt: ImportAttempt,
    content: string,
    format: string,
    name: string,
  ) => {
    emitImportDebug('info', 'frontend:invoke-start',
      `发起导入: format=${format} name=${name} size=${(content.length / 1024).toFixed(0)}KB`,
      { detail: { format, name, contentSizeKB: Math.round(content.length / 1024), modelId: selectedModelId || 'default' } },
    );
    const invokeStartAt = Date.now();
    attempt.backendStarted = true;
    const response = await invoke<ExamSheetSessionDetail>('import_question_bank_stream', {
      request: {
        content,
        format,
        name,
        folder_id: undefined,
        session_id: sessionId || undefined,
        model_config_id: selectedModelId || undefined,
        import_id: attempt.id,
      },
    });
    emitImportDebug('success', 'frontend:invoke-end',
      `导入 invoke 返回成功 | 耗时 ${Date.now() - invokeStartAt}ms`,
      { durationMs: Date.now() - invokeStartAt, sessionId: response?.summary?.id },
    );
    return response;
  }, [sessionId, selectedModelId]);

  // 开始处理：图片与文档统一走流式导入，差别只在 content / format / 默认名称
  const handleStartProcess = useCallback(async () => {
    if (selectedFiles.length === 0) {
      setError(t('exam_sheet:uploader.select_first_error'));
      return;
    }
    const category = selectedFiles[0].category;
    const attempt = beginImportAttempt();

    try {
      baselineCardIdsRef.current = await snapshotBaselineCardIds();
      if (!isCurrentImportAttempt(attempt)) return;

      let content: string;
      let format: string;
      let name: string;
      if (category === 'image') {
        content = JSON.stringify(await Promise.all(selectedFiles.map(f => readFileAsBase64(f.file))));
        format = 'image';
        name = resolvedSessionName
          || selectedFiles[0]?.file.name.replace(/\.[^/.]+$/, '')
          || t('exam_sheet:uploader.image_import_name');
      } else {
        const file = selectedFiles[0].file;
        content = await readFileAsBase64(file);
        format = file.name.split('.').pop()?.toLowerCase() || 'txt';
        name = qbankName || file.name.replace(/\.[^/.]+$/, '');
      }
      if (!isCurrentImportAttempt(attempt)) return;

      setLlmProgress({ percent: 5, message: t('exam_sheet:uploader.parsing_document') });
      const response = await runStreamImport(attempt, content, format, name);
      if (!isCurrentImportAttempt(attempt)) return;
      showSummary(response);
    } catch (err: unknown) {
      const errorMessage = errorMessageOf(err);
      debugLog.error('[ExamSheetUploader] 导入失败:', err);
      emitImportDebug('error', 'frontend:invoke-end', `导入 invoke 失败: ${errorMessage}`, { detail: { error: errorMessage } });
      if (!isCurrentImportAttempt(attempt)) return;
      setError(t('exam_sheet:uploader.import_failed_prefix', { error: errorMessage }));
      // invoke reject 可能先于 Failed 事件到达（或事件缺失）：同样提供断点续导入口
      if (attempt.createdSessionId && parsedCountRef.current > 0) {
        setResumableSession({
          sessionId: attempt.createdSessionId,
          parsedCount: parsedCountRef.current,
        });
      }
      setStep('select');
    } finally {
      if (isCurrentImportAttempt(attempt)) {
        activeImportAttemptRef.current = null;
        setIsLLMProcessing(false);
        setIsCancelling(false);
      }
    }
  }, [selectedFiles, qbankName, resolvedSessionName, t, beginImportAttempt, isCurrentImportAttempt, snapshotBaselineCardIds, runStreamImport, showSummary]);

  // 完成：删除被取消勾选的题目后交给父组件
  const handleConfirmSummary = useCallback(async () => {
    if (!pendingDetail || isConfirming) return;
    setIsConfirming(true);

    try {
      if (excludedCardIds.size > 0) {
        try {
          const updatedDetail = await TauriAPI.updateExamSheetCards({
            session_id: pendingDetail.summary.id,
            delete_card_ids: Array.from(excludedCardIds),
          });
          onUploadSuccess?.(updatedDetail);
        } catch (err: unknown) {
          debugLog.error('[ExamSheetUploader] Failed to delete excluded cards:', err);
          showGlobalNotification('error', t('exam_sheet:uploader.filter_delete_failed'));
          // 即使删除失败也让用户继续
          onUploadSuccess?.(pendingDetail);
        }
      } else {
        onUploadSuccess?.(pendingDetail);
      }
      setExcludedCardIds(new Set());
    } finally {
      setIsConfirming(false);
    }
  }, [pendingDetail, onUploadSuccess, excludedCardIds, isConfirming, t]);

  // 判断文件类型
  const categorizeFile = useCallback((file: File): FileCategory | null => {
    if (IMAGE_FORMATS.includes(file.type)) {
      return 'image';
    }
    const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '');
    if (DOCUMENT_EXTENSIONS.includes(ext)) {
      return 'document';
    }
    return null;
  }, []);

  // 获取当前选择的文件类型
  const currentCategory = selectedFiles.length > 0 ? selectedFiles[0].category : null;

  // 处理文件选择（入参已完成 HEIC→JPEG 预处理）
  const applySelectedFiles = useCallback((fileArray: File[]) => {
    const validFiles: FileInfo[] = [];

    for (const file of fileArray) {
      const category = categorizeFile(file);
      if (!category) {
        debugLog.warn(`不支持的文件格式: ${file.name} (${file.type})`);
        continue;
      }

      // ★ 大小校验兜底（点击选择/浏览器拖拽路径不走 UnifiedDragDropZone 的原生路径校验）
      if (file.size > MAX_UPLOAD_FILE_SIZE) {
        const sizeMB = (MAX_UPLOAD_FILE_SIZE / (1024 * 1024)).toFixed(0);
        setError(t('drag_drop:errors.file_too_large', { size: sizeMB }));
        debugLog.warn(`文件过大被拒绝: ${file.name} (${file.size} bytes)`);
        return;
      }

      // 已选图片时只接受图片；已选文档时新文档直接替换（文档只导入一个）
      if (currentCategory === 'image' && category !== 'image') {
        setError(t('exam_sheet:uploader.select_same_type_error', { type: t('exam_sheet:uploader.file_type_image') }));
        return;
      }

      const fileInfo: FileInfo = { file, category };
      if (category === 'image') {
        fileInfo.previewUrl = URL.createObjectURL(file);
      }
      validFiles.push(fileInfo);
    }

    if (validFiles.length === 0) {
      setError(t('exam_sheet:uploader.select_valid_file_error'));
      return;
    }

    setError(null);

    // 文档只接受一个文件
    if (validFiles[0].category === 'document') {
      validFiles.slice(1).forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
      setSelectedFiles(prev => {
        prev.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
        return [validFiles[0]];
      });
      setQbankName(validFiles[0].file.name.replace(/\.[^/.]+$/, ''));
    } else {
      // 一次拖入图片 + 文档混合时只取图片；已选文档时改选图片 = 替换
      const images = validFiles.filter(f => f.category === 'image');
      setSelectedFiles(prev => (prev[0]?.category === 'document' ? images : [...prev, ...images]));
    }
  }, [categorizeFile, currentCategory, t]);

  // iPhone 照片多为 HEIC：先经平台原生解码转 JPEG（WebView / Android ImageDecoder），
  // 无法转换的明确提示并剔除，不再把 OCR/视觉模型不认的 HEIC 原样送下游。
  const handleFileSelect = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (!fileArray.some(isHeicFile)) {
      applySelectedFiles(fileArray);
      return;
    }
    void prepareHeicFiles(fileArray).then(({ files: prepared, failures }) => {
      for (const failure of failures) {
        showGlobalNotification(
          'error',
          describeHeicConversionError(failure, t),
          t('common:utils.notifications.heic_compat_title'),
        );
      }
      if (prepared.length) applySelectedFiles(prepared);
    });
  }, [applySelectedFiles, t]);

  // 接收从题目集启动台拖入的初始文件：自动带入选择流程，消费后通知父组件清空。
  // 以引用记录已消费的数组：StrictMode（dev）双调用 effect 时不会把图片重复添加
  const consumedInitialFilesRef = useRef<File[] | null>(null);
  useEffect(() => {
    if (!initialFiles || initialFiles.length === 0) return;
    if (consumedInitialFilesRef.current === initialFiles) return;
    consumedInitialFilesRef.current = initialFiles;
    handleFileSelect(initialFiles);
    onInitialFilesConsumed?.();
  }, [initialFiles, handleFileSelect, onInitialFilesConsumed]);

  // 移除已选文件
  const handleRemoveFile = useCallback((index: number) => {
    setSelectedFiles(prev => {
      const file = prev[index];
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // 清理预览 URL
  // ★ Bug 修复：原实现以 selectedFiles 为依赖，每次追加文件都会把上一批列表里
  //   仍在展示的 previewUrl 全部 revoke，导致缩略图变空白。改为仅在卸载时
  //   统一释放（单个移除/清空路径已各自 revoke）。
  const selectedFilesRef = useRef(selectedFiles);
  selectedFilesRef.current = selectedFiles;
  useEffect(() => {
    return () => {
      selectedFilesRef.current.forEach(f => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
    };
  }, []);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFileSelect(e.target.files);
    }
    e.target.value = '';
  }, [handleFileSelect]);

  // 重置状态
  const handleReset = useCallback(() => {
    const activeAttempt = activeImportAttemptRef.current;
    activeImportAttemptRef.current = null;
    if (activeAttempt) {
      void invoke<boolean>('cancel_question_bank_import', { importId: activeAttempt.id })
        .catch(() => undefined);
    }
    selectedFiles.forEach(f => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    setSelectedFiles([]);
    setStep('select');
    setQbankName('');
    setError(null);
    setParsedQuestions([]);
    setLlmProgress({ percent: 0, message: '' });
    setImportIncomplete(false);
    setResumableSession(null);
    setIsResumeRun(false);
    parsedCountRef.current = 0;
    baselineCardIdsRef.current = null;
    setImportSummary(null);
    setPendingDetail(null);
    setExcludedCardIds(new Set());
    setIsLLMProcessing(false);
    setIsCancelling(false);
    setShowCancelConfirm(false);
  }, [selectedFiles]);

  const handleCancelImport = useCallback(async () => {
    const attempt = activeImportAttemptRef.current;
    if (!attempt || isCancelling) return;

    setIsCancelling(true);
    try {
      const accepted = await invoke<boolean>('cancel_question_bank_import', {
        importId: attempt.id,
      });

      if (!isCurrentImportAttempt(attempt)) return;

      if (!accepted && attempt.backendStarted) {
        setIsCancelling(false);
        setShowCancelConfirm(false);
        showGlobalNotification('warning', t('exam_sheet:uploader.cancel_unavailable'));
        return;
      }

      // Invalidate first. The rejected invoke and any buffered progress from
      // this attempt are intentionally ignored after this point.
      activeImportAttemptRef.current = null;
      setIsLLMProcessing(false);
      setIsCancelling(false);
      setShowCancelConfirm(false);
      setStep('select');
      setParsedQuestions([]);
      setLlmProgress({ percent: 0, message: '' });
      setError(null);
      showGlobalNotification('info', t('exam_sheet:uploader.import_cancelled'));
    } catch (error: unknown) {
      if (!isCurrentImportAttempt(attempt)) return;
      debugLog.error('[ExamSheetUploader] 请求取消导入失败:', error);
      setIsCancelling(false);
      showGlobalNotification('error', t('exam_sheet:uploader.cancel_failed'));
    }
  }, [isCancelling, isCurrentImportAttempt, t]);

  // 断点续导：从后端 checkpoint 恢复中断的导入（跳过已完成的分块）
  const handleResumeImport = useCallback(async () => {
    const resume = resumableSession;
    if (!resume || isLLMProcessing) return;

    const attempt = beginImportAttempt();
    attempt.resumeSessionId = resume.sessionId;
    attempt.createdSessionId = resume.sessionId;
    // resume 命令没有 import_id 注册，无法被 cancel_question_bank_import 取消
    attempt.backendStarted = true;
    setIsResumeRun(true);
    parsedCountRef.current = resume.parsedCount;
    setLlmProgress({ percent: 42, message: t('exam_sheet:uploader.resuming') });

    try {
      const response = await invoke<ExamSheetSessionDetail>('resume_question_import', {
        sessionId: resume.sessionId,
      });

      if (!isCurrentImportAttempt(attempt)) return;
      showSummary(response);
    } catch (err: unknown) {
      debugLog.error('[ExamSheetUploader] 断点续导失败:', err);
      if (!isCurrentImportAttempt(attempt)) return;
      setError(t('exam_sheet:uploader.resume_failed', { error: errorMessageOf(err) }));
      // 失败后保留续导入口，允许再次尝试
      setResumableSession(resume);
      setStep('select');
    } finally {
      if (isCurrentImportAttempt(attempt)) {
        activeImportAttemptRef.current = null;
        setIsLLMProcessing(false);
        setIsCancelling(false);
        setIsResumeRun(false);
      }
    }
  }, [resumableSession, isLLMProcessing, beginImportAttempt, isCurrentImportAttempt, showSummary, t]);

  const hasFiles = selectedFiles.length > 0;
  const fileInputs = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple={currentCategory !== 'document'}
        // MIME 在前 + 显式 text/markdown：wry Android 会丢弃 MimeTypeMap 不认识的扩展名（如旧系统的 .md）
        accept="image/*,application/pdf,text/plain,text/markdown,.docx,.xlsx,.xls,.txt,.md,.pdf,.heic,.heif"
        onChange={handleInputChange}
        className="hidden"
        data-testid="exam-uploader-file-input"
      />
      {/* 移动端拍照上传（capture 调起后置相机） */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple={false}
        onChange={handleInputChange}
        className="hidden"
      />
    </>
  );

  // 自定义可点行（非 DsButton）在触屏上也要 ≥44px 命中
  const touchRow = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';

  const renderQuestionMeta = (q: { question_type?: string | null; answer?: string | null; optionCount?: number }) => (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
      {q.question_type && <span>{t(`exam_sheet:questionTypes.${q.question_type}`, q.question_type)}</span>}
      {!!q.optionCount && <span>{t('exam_sheet:uploader.options_count', { count: q.optionCount })}</span>}
      {q.answer && <span className="min-w-0 truncate text-success">{t('exam_sheet:uploader.answer_prefix', { answer: q.answer })}</span>}
    </div>
  );

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      <CustomScrollArea className="min-h-0 flex-1" viewportClassName="flex flex-col p-4">
        {/* min-h-full 列：内容矮时撑满高度让 dropzone 弹性扩展；内容高时自然向下滚动 */}
        <div className="w-full max-w-2xl mx-auto flex min-h-full flex-col gap-4">
          <h2 className="flex-shrink-0 pt-2 text-center text-lg font-semibold">
            {t('exam_sheet:uploader.header_title')}
          </h2>

          {step === 'select' && (
            <div className={cn('flex flex-col gap-4 ui-rise-in', !hasFiles && 'flex-1')}>
              {/* 拖放区：未选文件时弹性撑满；选中后收成一行「添加 / 更换」条 */}
              <UnifiedDragDropZone
                zoneId="exam-sheet-uploader"
                onFilesDropped={handleFileSelect}
                onDragStateChange={setIsDragActive}
                acceptedFileTypes={[EXAM_IMAGE_TYPE, EXAM_DOCUMENT_TYPE]}
                maxFiles={currentCategory === 'document' ? 1 : 20}
                maxFileSize={MAX_UPLOAD_FILE_SIZE}
                showOverlay={true}
                className={cn('flex flex-col rounded-md', hasFiles ? 'flex-shrink-0' : 'min-h-[180px] flex-1')}
              >
                {fileInputs}
                {hasFiles ? (
                  <DsButton
                    variant="ghost"
                    onClick={handleClick}
                    data-testid="exam-uploader-add-more"
                    className={cn(
                      'w-full gap-1.5 border border-dashed text-muted-foreground',
                      'hover:border-primary/50 hover:bg-primary/5 hover:text-foreground',
                      isDragActive ? 'border-primary bg-primary/10 text-primary' : 'border-border/60',
                    )}
                  >
                    <Plus size={14} />
                    {currentCategory === 'image'
                      ? t('exam_sheet:uploader.add_more_images')
                      : t('exam_sheet:uploader.replace_file')}
                  </DsButton>
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={handleClick}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleClick();
                      }
                    }}
                    data-testid="exam-uploader-dropzone"
                    className={cn(
                      'flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed px-6 py-8 text-center transition-colors',
                      'hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isDragActive ? 'border-primary bg-primary/10' : 'border-border/60',
                    )}
                  >
                    <UploadSimple size={28} className={cn('transition-colors', isDragActive ? 'text-primary' : 'text-muted-foreground')} />
                    <div className="space-y-1">
                      <p className={cn('text-base font-medium transition-colors', isDragActive && 'text-primary')}>
                        {isDragActive
                          ? t('exam_sheet:uploader.drop_active')
                          : t('exam_sheet:uploader.drop_or_click')}
                      </p>
                      <p className="text-balance text-sm text-muted-foreground">
                        {t('exam_sheet:uploader.supported_formats_all')}
                      </p>
                    </div>
                    {/* 移动端：拍照导入入口 */}
                    <DsButton
                      variant="secondary"
                      size="sm"
                      className="md:hidden gap-1.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        cameraInputRef.current?.click();
                      }}
                    >
                      <Camera size={16} />
                      {t('exam_sheet:uploader.take_photo')}
                    </DsButton>
                  </div>
                )}
              </UnifiedDragDropZone>

              {/* 已选图片 */}
              {currentCategory === 'image' && (
                <div className="space-y-2" data-testid="exam-uploader-selected-images">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {t('exam_sheet:uploader.selected_images', { count: selectedFiles.length })}
                    </span>
                    <DsButton variant="ghost" size="sm" onClick={handleReset} className="text-muted-foreground">
                      {t('exam_sheet:uploader.clear')}
                    </DsButton>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {selectedFiles.map((fileInfo, index) => (
                      <div
                        key={`${fileInfo.file.name}-${index}`}
                        className="relative aspect-square rounded-lg overflow-hidden bg-muted group"
                      >
                        {/* 试卷照片多为竖版：顶端对齐，缩略图露出题目开头而不是纸面中部空白 */}
                        <img
                          src={fileInfo.previewUrl || ''}
                          alt={fileInfo.file.name}
                          className="w-full h-full object-cover object-top"
                        />
                        <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleRemoveFile(index); }} className="absolute top-1 right-1 !w-6 !h-6 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 !rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100" aria-label={t('common:remove', { defaultValue: 'Remove' })}>
                          <X size={12} />
                        </DsButton>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 已选文档 */}
              {currentCategory === 'document' && (
                <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5" data-testid="exam-uploader-selected-document">
                  <FileText size={20} className="flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{selectedFiles[0].file.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {(selectedFiles[0].file.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={handleReset}
                                        aria-label={t('exam_sheet:uploader.remove')}
                    title={t('exam_sheet:uploader.remove')}
                  >
                    <X size={16} />
                  </DsButton>
                </div>
              )}

              {/* 解析模型：图片与文档都经同一条模型管线；没有可选模型时不展示空下拉 */}
              {hasFiles && availableModels.length > 0 && (
                <div className="flex items-center gap-2 text-sm" data-testid="exam-uploader-model">
                  <span className="flex-shrink-0 text-muted-foreground">{t('exam_sheet:uploader.parse_model')}</span>
                  <UnifiedModelSelector
                    models={availableModels}
                    value={selectedModelId}
                    onChange={setSelectedModelId}
                    variant="compact"
                    allowEmpty
                    emptyLabel={t('settings:placeholders.use_default_model')}
                    placeholder={t('settings:placeholders.use_default_model')}
                    className="flex-1"
                  />
                </div>
              )}
            </div>
          )}

          {step === 'processing' && (
            <div className="flex flex-col flex-1 min-h-0 gap-3 ui-slide-fade-in [--ui-enter-x:24px]">
              {/* 唯一的进度表达：一行状态文字 + 一条进度条 + 取消 */}
              <div className="flex-shrink-0 space-y-2 rounded-lg bg-muted/30 p-3" data-testid="exam-uploader-progress">
                <div className="flex items-center gap-2">
                  <CircleNotch size={16} className="flex-shrink-0 animate-spin text-primary" />
                  <span className="min-w-0 flex-1 text-sm font-medium" aria-live="polite">{llmProgress.message}</span>
                  {isLLMProcessing && !isResumeRun && !showCancelConfirm && (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowCancelConfirm(true)}
                      disabled={isCancelling}
                      className="shrink-0"
                    >
                      {isCancelling
                        ? t('exam_sheet:uploader.cancelling_import')
                        : t('exam_sheet:uploader.cancel_import')}
                    </DsButton>
                  )}
                </div>
                <Progress value={llmProgress.percent} className="h-1.5" />
              </div>

              {/* 取消导入的内联确认条 */}
              {showCancelConfirm && isLLMProcessing && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 flex-shrink-0 ui-drop-in">
                  <span className="flex-1 min-w-[12rem] text-xs text-warning">
                    {t('exam_sheet:uploader.cancel_confirm_hint')}
                  </span>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="!h-7 text-xs"
                    onClick={() => setShowCancelConfirm(false)}
                    disabled={isCancelling}
                  >
                    {t('exam_sheet:uploader.cancel_confirm_no')}
                  </DsButton>
                  <DsButton
                    variant="danger"
                    size="sm"
                    className="!h-7 text-xs"
                    onClick={() => void handleCancelImport()}
                    disabled={isCancelling}
                  >
                    {isCancelling && <CircleNotch size={12} className="mr-1 animate-spin" />}
                    {isCancelling
                      ? t('exam_sheet:uploader.cancelling_import')
                      : t('exam_sheet:uploader.cancel_confirm_yes')}
                  </DsButton>
                </div>
              )}

              {/* 实时解析的题目 */}
              {parsedQuestions.length > 0 && (
                <CustomScrollArea
                  className="min-h-0 flex-1"
                  viewportClassName="divide-y divide-border/40"
                  viewportRef={parsedListRef}
                >
                  {parsedQuestions.map((q, idx) => (
                    <div
                      key={idx}
                      data-testid="exam-uploader-parsed-question"
                      className="flex gap-2 px-1 py-2 ui-rise-in [content-visibility:auto] [contain-intrinsic-size:auto_56px]"
                    >
                      <span className="w-5 flex-shrink-0 pt-px text-right text-xs tabular-nums text-muted-foreground">{idx + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-sm">
                          {q.content ? <LatexText content={q.content} /> : t('exam_sheet:uploader.no_content')}
                        </div>
                        {renderQuestionMeta({ question_type: q.question_type, answer: q.answer, optionCount: q.options?.length })}
                      </div>
                    </div>
                  ))}
                </CustomScrollArea>
              )}
            </div>
          )}

          {step === 'summary' && importSummary && (() => {
            const cards = importSummary.cards;
            const total = cards.length;
            const keptCount = Math.max(0, total - excludedCardIds.size);
            const allExcluded = total > 0 && excludedCardIds.size >= total;
            const notes: string[] = [];
            if (total === 0) notes.push(t('exam_sheet:uploader.no_questions_warning'));
            if (importSummary.emptyQuestions > 0) notes.push(t('exam_sheet:uploader.empty_warning', { count: importSummary.emptyQuestions }));
            if (importIncomplete) notes.push(t('exam_sheet:uploader.incomplete_warning'));
            return (
              <div className="flex flex-1 min-h-0 flex-col gap-3 ui-slide-fade-in [--ui-enter-x:24px]" data-testid="exam-uploader-summary">
                <div className="flex-shrink-0 space-y-1 text-center">
                  <h3 className="flex items-center justify-center gap-1.5 text-base font-semibold">
                    <CheckCircle size={18} weight="fill" className="text-success ui-zoom-fade-in" />
                    {t('exam_sheet:uploader.import_done', { count: total })}
                  </h3>
                  {total > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {Object.entries(importSummary.questionTypes)
                        .map(([type, count]) => `${t(`exam_sheet:questionTypes.${type}`, type)} ${count}`)
                        .join(' · ')}
                    </p>
                  )}
                </div>

                {notes.length > 0 && (
                  <div className="flex flex-shrink-0 items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
                    <Info size={16} className="mt-0.5 flex-shrink-0" />
                    <ul className="space-y-0.5">
                      {notes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                  </div>
                )}

                {/* 本次新增的题目：默认全部保留，取消勾选即不录入 */}
                {total > 0 && (
                  <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border/50">
                    <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
                      <span className="text-xs text-muted-foreground">{t('exam_sheet:uploader.filter_hint')}</span>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="!h-7 shrink-0 text-xs"
                        onClick={() => setExcludedCardIds(allExcluded ? new Set() : new Set(cards.map(c => c.card_id)))}
                      >
                        {allExcluded ? t('common:select_all') : t('common:deselect_all')}
                      </DsButton>
                    </div>
                    <CustomScrollArea className="min-h-[120px] flex-1" viewportClassName="divide-y divide-border/30">
                      {cards.map((card) => {
                        const isExcluded = excludedCardIds.has(card.card_id);
                        const text = card.ocr_text?.trim() || card.question_label || '';
                        return (
                          <label
                            key={card.card_id}
                            data-testid="exam-uploader-summary-question"
                            className={cn(
                              'flex cursor-pointer items-start gap-2.5 px-3 py-2 transition-colors',
                              isExcluded ? 'opacity-50' : 'hover:bg-[var(--interactive-hover)]',
                              touchRow,
                            )}
                          >
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 flex-shrink-0 accent-primary"
                              checked={!isExcluded}
                              onChange={() => {
                                setExcludedCardIds(prev => {
                                  const next = new Set(prev);
                                  if (next.has(card.card_id)) next.delete(card.card_id);
                                  else next.add(card.card_id);
                                  return next;
                                });
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className={cn('line-clamp-2 text-sm', isExcluded && 'line-through')}>
                                {text ? <LatexText content={text} /> : t('exam_sheet:uploader.no_content')}
                              </div>
                              {renderQuestionMeta({ question_type: card.question_type, answer: card.answer })}
                            </div>
                          </label>
                        );
                      })}
                    </CustomScrollArea>
                  </div>
                )}

                <div className="flex flex-shrink-0 gap-3 pt-1">
                  <DsButton variant="ghost" onClick={handleReset} className="flex-1">
                    {t('exam_sheet:uploader.import_another')}
                  </DsButton>
                  <DsButton onClick={() => void handleConfirmSummary()} className="flex-1" disabled={(total > 0 && keptCount === 0) || isConfirming}>
                    {isConfirming && <CircleNotch size={16} className="mr-1 animate-spin" />}
                    {excludedCardIds.size > 0
                      ? t('exam_sheet:uploader.view_questions_filtered', { count: keptCount })
                      : t('exam_sheet:uploader.view_questions')}
                  </DsButton>
                </div>
              </div>
            );
          })()}

          {/* 错误：重试即下方主按钮，不再在错误条里重复一个「重试」 */}
          {error && (
            <div className="flex-shrink-0 space-y-2 ui-drop-in" role="alert">
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <WarningCircle size={18} className="mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1 break-words">{error}</div>
              </div>
              {/* 断点续导：失败前已解析部分题目时，可跳过已完成分块继续导入 */}
              {resumableSession && step === 'select' && !isLLMProcessing && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                  <span className="flex-1 min-w-[12rem] text-xs text-warning">
                    {t('exam_sheet:uploader.import_interrupted', { count: resumableSession.parsedCount })}
                  </span>
                  <DsButton
                    variant="warning"
                    size="sm"
                    className="!h-7 text-xs"
                    onClick={() => void handleResumeImport()}
                  >
                    <ArrowClockwise size={14} className="mr-1" />
                    {t('exam_sheet:uploader.resume_import')}
                  </DsButton>
                </div>
              )}
            </div>
          )}

          {/* 操作按钮：选了文件才出现，避免空态下的 disabled 主按钮 */}
          {step === 'select' && hasFiles && (
            <div className="flex flex-shrink-0 gap-3">
              {onBack && (
                <DsButton variant="ghost" onClick={onBack} className="flex-1">
                  {t('common:actions.back')}
                </DsButton>
              )}
              <DsButton
                onClick={() => void handleStartProcess()}
                className="flex-1 gap-2"
                data-testid="exam-uploader-start"
              >
                {error ? <ArrowClockwise size={16} /> : <UploadSimple size={16} />}
                {error ? t('common:retry') : t('exam_sheet:uploader.start_recognize')}
              </DsButton>
            </div>
          )}

          {/* 没有文件可导入？回启动台手动新建（优先走专用回调，直接打开创建编辑器）；选了文件后让位 */}
          {step === 'select' && !hasFiles && (onManualCreate || onBack) && (
            <div className="flex-shrink-0 text-center">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onManualCreate ?? onBack}
                className="!h-auto !px-2 !py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {t('exam_sheet:uploader.manual_create_link')}
              </DsButton>
            </div>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default ExamSheetUploader;
