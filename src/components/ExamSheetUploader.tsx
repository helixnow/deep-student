/**
 * ExamSheetUploader - 统一的题目导入组件
 * 
 * 支持两种导入模式：
 * 1. 图片上传 → OCR 识别题目
 * 2. 文档上传 → 文本解析 + LLM 识别题目
 * 
 * 根据文件类型自动选择处理模式，提供一致的用户体验
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  CircleNotch,
  X,
  Image,
  FileText,
  WarningCircle,
  CheckCircle,
  File,
  Info,
  Robot,
  Upload,
  Check,
  CheckSquare,
  Square,
  Funnel,
  Camera,
  ArrowClockwise,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Progress } from '@/components/ui/shad/Progress';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { useExamSheetProgress } from '@/hooks/useExamSheetProgress';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { emitImportDebug } from '@/debug-panel/plugins/QuestionImportDebugPlugin';
import { UnifiedModelSelector, type UnifiedModelInfo } from '@/components/shared/UnifiedModelSelector';
import { UnifiedDragDropZone, type FileTypeDefinition } from '@/components/shared/UnifiedDragDropZone';
import type { ApiConfig } from '@/types';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

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

// ★ 上传文件大小上限：与 UnifiedDragDropZone 的 Tauri 原生拖拽路径保持一致（50MB）。
// 点击选择 / 浏览器 dataTransfer 拖拽路径不经过原生路径校验，必须在此兜底，
// 否则超大文件会被整体 FileReader→base64 读入内存。
const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;

// 处理步骤
type ProcessStep = 'select' | 'preview' | 'processing' | 'summary';

// 导入结果摘要
interface ImportSummary {
  totalQuestions: number;
  pageCount: number;
  questionTypes: Record<string, number>;
  emptyQuestions: number;
  warnings: string[];
}

interface PdfTextInspection {
  valid_char_count: number;
  total_char_count: number;
  preview_text: string;
  recommendation: 'auto_ocr' | 'manual_decision' | 'use_text' | string;
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

/** 智能解析内部阶段（用于处理步骤内的迷你阶段条） */
type ProcessPhase = 'preparing' | 'recognizing' | 'parsing' | 'done';

const PROCESS_PHASE_KEYS: ProcessPhase[] = ['preparing', 'recognizing', 'parsing', 'done'];

const createQuestionImportId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `question-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const UPLOAD_STEP_KEYS = ['select', 'processing', 'summary'] as const;

/** 导入步骤指示器：选择文件 → 智能解析 → 确认录入 */
const UploadStepIndicator: React.FC<{ step: ProcessStep }> = ({ step }) => {
  const { t } = useTranslation(['exam_sheet']);
  const currentIndex = step === 'summary' ? 2 : step === 'processing' ? 1 : 0;
  return (
    <ol className="flex items-center justify-center">
      {UPLOAD_STEP_KEYS.map((key, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <li key={key} className="flex items-center">
            {index > 0 && (
              <div className={cn('mx-2 h-px w-8 sm:w-12', index <= currentIndex ? 'bg-primary/50' : 'bg-border')} />
            )}
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium',
                  isCurrent && 'bg-primary text-primary-foreground',
                  isDone && 'bg-primary/15 text-primary',
                  !isDone && !isCurrent && 'bg-muted text-muted-foreground'
                )}
              >
                {isDone ? <Check size={11} /> : index + 1}
              </span>
              <span className={cn('text-xs', isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {t(`exam_sheet:uploader.steps.${key}`)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

/** 智能解析内部阶段条：准备 → 识别 → 解析 → 完成 */
const ProcessPhaseBar: React.FC<{ phase: ProcessPhase }> = ({ phase }) => {
  const { t } = useTranslation(['exam_sheet']);
  const currentIndex = PROCESS_PHASE_KEYS.indexOf(phase);
  return (
    <ol className="flex flex-wrap items-center justify-center gap-y-1 text-[11px]">
      {PROCESS_PHASE_KEYS.map((key, index) => {
        const isDone = index < currentIndex || (index === currentIndex && key === 'done');
        const isCurrent = index === currentIndex;
        return (
          <li key={key} className="flex items-center">
            {index > 0 && (
              <span className={cn('mx-1.5 h-px w-4 sm:w-6', index <= currentIndex ? 'bg-primary/50' : 'bg-border')} />
            )}
            <span
              className={cn(
                'flex items-center gap-1 rounded-full px-2 py-0.5 ui-state-colors',
                isCurrent && key !== 'done' && 'bg-primary/10 font-medium text-primary',
                isDone && 'text-success',
                !isDone && !isCurrent && 'text-muted-foreground/60'
              )}
            >
              {isDone ? (
                <Check size={10} weight="bold" className="ui-zoom-fade-in" />
              ) : isCurrent ? (
                <CircleNotch size={10} className="animate-spin" />
              ) : null}
              {t(`exam_sheet:uploader.phases.${key}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

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
  
  // 文件状态
  const [selectedFiles, setSelectedFiles] = useState<FileInfo[]>([]);
  // 拖拽悬停高亮（来自 UnifiedDragDropZone 的拖拽状态回调）
  const [isDragActive, setIsDragActive] = useState(false);
  
  // 文档导入状态
  const [step, setStep] = useState<ProcessStep>('select');
  const [qbankName, setQbankName] = useState('');
  const [isLLMProcessing, setIsLLMProcessing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  // 取消导入的内联二次确认（不使用模态框）
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [llmProgress, setLlmProgress] = useState({ percent: 0, message: '', parsedCount: 0 });
  // 智能解析内部阶段（准备 → 识别 → 解析 → 完成）
  const [processPhase, setProcessPhase] = useState<ProcessPhase>('preparing');
  // 逐页识别状态（image_index → 是否完成）；length 为 0 时不渲染逐页视图
  const [ocrPageDone, setOcrPageDone] = useState<boolean[]>([]);
  // 断点续导：流式导入失败但已有 checkpoint 时提供"从断点恢复"入口
  const [resumableSession, setResumableSession] = useState<{ sessionId: string; parsedCount: number } | null>(null);
  const [isResumeRun, setIsResumeRun] = useState(false);
  // 已解析题目数（ref 供异步 catch 分支读取，避免闭包读到过期 state）
  const parsedCountRef = useRef(0);
  // 流式题目列表容器：新题到达时自动滚动到底部
  const parsedListRef = useRef<HTMLDivElement>(null);
  
  // 实时解析的题目列表（流式显示）
  const [parsedQuestions, setParsedQuestions] = useState<Array<{
    content: string;
    question_type?: string;
    answer?: string;
    options?: Array<{ key: string; content: string }>;
  }>>([]);
  
  // 模型选择
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<UnifiedModelInfo[]>([]);
  
  // 错误和成功
  const [error, setError] = useState<string | null>(null);
  
  // 导入结果摘要
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [pendingDetail, setPendingDetail] = useState<ExamSheetSessionDetail | null>(null);
  
  // 题目筛选状态：summary 步骤中用户可取消勾选不需要录入的题目
  const [excludedCardIds, setExcludedCardIds] = useState<Set<string>>(new Set());
  const [showQuestionFilter, setShowQuestionFilter] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  // Visual-First: PDF 不再需要文本质量检测，保留变量避免下游引用报错
  const [pendingPdfImport, setPendingPdfImport] = useState<{
    base64Content: string;
    format: string;
    inspection: PdfTextInspection;
  } | null>(null);

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
    setLlmProgress({ percent: 0, message: t('exam_sheet:uploader.reading_document'), parsedCount: 0 });
    setProcessPhase('preparing');
    setOcrPageDone([]);
    setResumableSession(null);
    setIsResumeRun(false);
    parsedCountRef.current = 0;
    setParsedQuestions([]);
    setError(null);
    setPendingPdfImport(null);
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
        
        switch (payload.type) {
          case 'Preprocessing': {
            const pct = payload.percent || 0;
            const msg = payload.message || t('exam_sheet:uploader.preprocessing', {  });
            setProcessPhase(prev => (prev === 'preparing' ? prev : 'preparing'));
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, pct),
              message: msg,
            }));
            break;
          }
          case 'RenderingPages': {
            const done = payload.current || 0;
            const total = payload.total || 1;
            const pct = total > 0 ? Math.min(Math.round((done / total) * 15) + 2, 17) : 2;
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, pct),
              message: t('exam_sheet:uploader.rendering_pages', {
                current: done,
                total,
              }),
            }));
            break;
          }
          case 'OcrImageCompleted': {
            // OCR/VLM 阶段占进度条 20~40%（DOCX 预处理已占到 20%）
            const doneIndex = payload.image_index || 0;
            const done = doneIndex + 1;
            const total = payload.total_images || 1;
            const ocrPct = Math.min(20 + Math.round((done / total) * 20), 40);
            setProcessPhase('recognizing');
            // 逐页识别状态：乱序事件安全（按 index 置位，不依赖到达顺序）
            setOcrPageDone(prev => {
              const next = prev.length >= total ? [...prev] : [
                ...prev,
                ...Array.from({ length: total - prev.length }, () => false),
              ];
              if (doneIndex >= 0 && doneIndex < next.length) next[doneIndex] = true;
              return next;
            });
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, ocrPct),
              message: t('exam_sheet:uploader.ocr_image_progress', {
                current: done,
                total,
              }),
            }));
            break;
          }
          case 'OcrPhaseCompleted':
            setProcessPhase('parsing');
            setOcrPageDone(prev => prev.map(() => true));
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, 40),
              message: t('exam_sheet:uploader.ocr_phase_done', {
                total: payload.total_images,
                chars: payload.total_chars,
              }),
            }));
            break;
          case 'ExtractingFigures': {
            const done = payload.current || 0;
            const total = payload.total || 1;
            const pct = total > 0 ? Math.min(40 + Math.round((done / total) * 5), 45) : 42;
            setProcessPhase('parsing');
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, pct),
              message: t('exam_sheet:uploader.extracting_figures', {
                current: done,
                total,
              }),
            }));
            break;
          }
          case 'StructuringQuestion': {
            const done = payload.current || 0;
            const total = payload.total || 1;
            setProcessPhase('parsing');
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, 45),
              message: t('exam_sheet:uploader.structuring_questions', {
                current: done,
                total,
              }),
            }));
            break;
          }
          case 'SessionCreated':
            // 回填本次导入创建的 session，失败时用于断点续导
            if (payload.session_id) {
              activeAttempt.createdSessionId = payload.session_id;
            }
            setProcessPhase('parsing');
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.max(prev.percent, 42),
              message: t('exam_sheet:uploader.parsing_started', { chunks: payload.total_chunks }),
            }));
            break;
          case 'ChunkStart':
            setProcessPhase('parsing');
            setLlmProgress(prev => ({
              ...prev,
              // LLM 解析阶段占 42~90%（Math.max 防乱序事件把进度打回去）
              percent: Math.max(
                prev.percent,
                Math.min(42 + ((payload.chunk_index || 0) / (payload.total_chunks || 1)) * 48, 90)
              ),
              message: t('exam_sheet:uploader.parsing_chunk', { current: (payload.chunk_index || 0) + 1, total: payload.total_chunks }),
            }));
            break;
          case 'QuestionParsed':
            // 存储已解析的题目用于实时显示
            if (payload.question) {
              const q = payload.question as {
                content?: string;
                question_type?: string;
                answer?: string;
                options?: Array<{ key: string; content: string }>;
              };
              setParsedQuestions(prev => [...prev, {
                content: q.content || '',
                question_type: q.question_type,
                answer: q.answer,
                options: q.options,
              }]);
            }
            parsedCountRef.current = payload.total_parsed || 0;
            setProcessPhase('parsing');
            setLlmProgress(prev => ({
              ...prev,
              parsedCount: payload.total_parsed || 0,
              message: t('exam_sheet:uploader.parsed_count', { count: payload.total_parsed }),
            }));
            break;
          case 'ChunkCompleted':
            parsedCountRef.current = payload.total_parsed || 0;
            setLlmProgress(prev => ({
              ...prev,
              // Math.max：防迟到的 ChunkCompleted 让进度条回退
              percent: Math.max(
                prev.percent,
                Math.min(42 + (((payload.chunk_index || 0) + 1) / (payload.total_chunks || 1)) * 48, 90)
              ),
              parsedCount: payload.total_parsed || 0,
              message: t('exam_sheet:uploader.chunk_completed', { current: (payload.chunk_index || 0) + 1, total: payload.total_chunks, count: payload.total_parsed }),
            }));
            break;
          case 'Completed':
            // ★ #6(round2): VLM 中途失败但已存部分题时 partial=true，显式提示"可能缺题"（非阻塞，不触发失败态）
            parsedCountRef.current = payload.total_questions || 0;
            setProcessPhase('done');
            setLlmProgress({
              percent: 100,
              message: payload.partial
                ? t('exam_sheet:uploader.import_done_partial', { count: payload.total_questions })
                : t('exam_sheet:uploader.import_done', { count: payload.total_questions }),
              parsedCount: payload.total_questions || 0,
            });
            break;
          case 'Failed': {
            setError(t('exam_sheet:uploader.import_failed_prefix', { error: payload.error }));
            if ((payload.total_parsed || 0) > 0) {
              setLlmProgress(prev => ({
                ...prev,
                message: t('exam_sheet:uploader.import_interrupted', { count: payload.total_parsed }),
              }));
            }
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

  // 使用统一的 OCR 进度 Hook（仅用于图片处理）
  const {
    isProcessing: isOCRProcessing,
    stage: ocrStage,
    progress: ocrProgress,
    ocrProgress: ocrPhaseProgress,
    parseProgress: parsePhaseProgress,
    pageStatuses: ocrHookPageStatuses,
    error: ocrError,
    reset: resetOCRProgress,
  } = useExamSheetProgress({
    sessionId: sessionId ?? null,
    onSessionUpdate: async (detail) => {
      // 生成摘要并显示
      const summary = generateImportSummary(detail);
      setImportSummary(summary);
      setPendingDetail(detail);
      setExcludedCardIds(new Set());
      setShowQuestionFilter(false);
      setStep('summary');
    },
  });

  // 生成导入结果摘要
  const generateImportSummary = useCallback((detail: ExamSheetSessionDetail): ImportSummary => {
    const pages = detail.preview?.pages || [];
    const allCards = pages.flatMap(p => p.cards || []);
    
    // 统计题型
    const questionTypes: Record<string, number> = {};
    let emptyQuestions = 0;
    const warnings: string[] = [];
    
    for (const card of allCards) {
      const qType = card.question_type || 'other';
      questionTypes[qType] = (questionTypes[qType] || 0) + 1;
      
      // 检查空题目
      if (!card.ocr_text?.trim()) {
        emptyQuestions++;
      }
    }
    
    // 生成警告
    if (emptyQuestions > 0) {
      warnings.push(t('exam_sheet:uploader.empty_warning', { count: emptyQuestions }));
    }
    if (allCards.length === 0) {
      warnings.push(t('exam_sheet:uploader.no_questions_warning'));
    }
    
    return {
      totalQuestions: allCards.length,
      pageCount: pages.length,
      questionTypes,
      emptyQuestions,
      warnings,
    };
  }, [t]);

  const executeDocumentImport = useCallback(async (
    base64Content: string,
    format: string,
    pdfPreferOcr?: boolean,
    existingAttempt?: ImportAttempt,
  ) => {
    const attempt = existingAttempt ?? beginImportAttempt();
    const file = selectedFiles[0]?.file;
    if (!file) {
      if (isCurrentImportAttempt(attempt)) {
        setError(t('exam_sheet:uploader.select_first_error'));
        setStep('select');
        setIsLLMProcessing(false);
        activeImportAttemptRef.current = null;
      }
      return;
    }

    if (!isCurrentImportAttempt(attempt)) return;

    try {
      setLlmProgress({ percent: 5, message: t('exam_sheet:uploader.parsing_document'), parsedCount: 0 });

      const importName = qbankName || file.name.replace(/\.[^/.]+$/, '');
      emitImportDebug('info', 'frontend:invoke-start',
        `发起导入: format=${format} name=${importName} size=${(base64Content.length / 1024).toFixed(0)}KB`,
        { detail: { format, name: importName, contentSizeKB: Math.round(base64Content.length / 1024), modelId: selectedModelId || 'default' } },
      );

      const invokeStartAt = Date.now();
      attempt.backendStarted = true;
      const response = await invoke<ExamSheetSessionDetail>('import_question_bank_stream', {
        request: {
          content: base64Content,
          format,
          name: importName,
          folder_id: undefined,
          session_id: sessionId || undefined,
          model_config_id: selectedModelId || undefined,
          pdf_prefer_ocr: pdfPreferOcr,
          import_id: attempt.id,
        },
      });

      if (!isCurrentImportAttempt(attempt)) return;

      emitImportDebug('success', 'frontend:invoke-end',
        `导入 invoke 返回成功 | 耗时 ${Date.now() - invokeStartAt}ms`,
        { durationMs: Date.now() - invokeStartAt, sessionId: response?.summary?.id },
      );

      const summary = generateImportSummary(response);
      setImportSummary(summary);
      setPendingDetail(response);
      setExcludedCardIds(new Set());
      setShowQuestionFilter(false);
      setStep('summary');
    } catch (err: unknown) {
      const errorMessage = err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null && 'message' in err)
          ? (err as { message: string }).message
          : String(err);
      emitImportDebug('error', 'frontend:invoke-end',
        `导入 invoke 失败: ${errorMessage}`,
        { detail: { error: errorMessage } },
      );
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
  }, [selectedFiles, qbankName, sessionId, selectedModelId, generateImportSummary, t, beginImportAttempt, isCurrentImportAttempt]);

  // 确认导入摘要（删除被排除的题目后再确认）
  const handleConfirmSummary = useCallback(async () => {
    if (!pendingDetail || isConfirming) return;
    setIsConfirming(true);

    try {
      // 如果有排除的题目，先通过 API 删除
      if (excludedCardIds.size > 0) {
        try {
          const updatedDetail = await TauriAPI.updateExamSheetCards({
            session_id: pendingDetail.summary.id,
            delete_card_ids: Array.from(excludedCardIds),
          });
          const keptCount = Math.max(0, (importSummary?.totalQuestions || 0) - excludedCardIds.size);
          showGlobalNotification('success', t('exam_sheet:uploader.import_success_notification', { count: keptCount }));
          onUploadSuccess?.(updatedDetail);
        } catch (err: unknown) {
          debugLog.error('[ExamSheetUploader] Failed to delete excluded cards:', err);
          showGlobalNotification('error', t('exam_sheet:uploader.filter_delete_failed'));
          // 即使删除失败也让用户继续
          onUploadSuccess?.(pendingDetail);
        }
      } else {
        showGlobalNotification('success', t('exam_sheet:uploader.import_success_notification', { count: importSummary?.totalQuestions || 0 }));
        onUploadSuccess?.(pendingDetail);
      }
      setExcludedCardIds(new Set());
      setShowQuestionFilter(false);
    } finally {
      setIsConfirming(false);
    }
  }, [pendingDetail, importSummary, onUploadSuccess, excludedCardIds, isConfirming, t]);

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

  // 处理文件选择
  const handleFileSelect = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
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
        setError(t('drag_drop:errors.file_too_large', { size: sizeMB,}));
        debugLog.warn(`文件过大被拒绝: ${file.name} (${file.size} bytes)`);
        return;
      }
      
      // 如果已经有文件，只接受同类型的
      if (currentCategory && category !== currentCategory) {
        setError(t('exam_sheet:uploader.select_same_type_error', { type: currentCategory === 'image' ? t('exam_sheet:uploader.file_type_image') : t('exam_sheet:uploader.file_type_document') }));
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
    setPendingPdfImport(null);
    
    // 文档只接受一个文件
    if (validFiles[0].category === 'document') {
      setSelectedFiles([validFiles[0]]);
      setQbankName(validFiles[0].file.name.replace(/\.[^/.]+$/, ''));
    } else {
      setSelectedFiles(prev => [...prev, ...validFiles]);
    }
  }, [categorizeFile, currentCategory, t]);

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
      if (file.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      const newFiles = prev.filter((_, i) => i !== index);
      setPendingPdfImport(null);
      if (newFiles.length === 0) {
        setStep('select');
      }
      return newFiles;
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

  // 图片 OCR 处理（★ 统一走 import_question_bank_stream：OCR→文本→LLM解析）
  const handleImageOCR = useCallback(async () => {
    const attempt = beginImportAttempt();

    try {
      // 将所有图片转为 base64 数组
      const base64Images = await Promise.all(
        selectedFiles.map(f => new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1] || dataUrl;
            resolve(base64);
          };
          reader.onerror = () => reject(new Error('File read failed'));
          reader.readAsDataURL(f.file);
        }))
      );

      if (!isCurrentImportAttempt(attempt)) return;

      debugLog.info('[ExamSheetUploader] 开始图片导入:', base64Images.length, '张图片');
      setLlmProgress({ percent: 5, message: t('exam_sheet:uploader.parsing_document'), parsedCount: 0 });

      // ★ 统一调用 import_question_bank_stream，format='image'，content 为 JSON 数组
      attempt.backendStarted = true;
      const response = await invoke<ExamSheetSessionDetail>('import_question_bank_stream', {
        request: {
          content: JSON.stringify(base64Images),
          format: 'image',
          name: resolvedSessionName || selectedFiles[0]?.file.name.replace(/\.[^/.]+$/, '') || t('exam_sheet:uploader.image_import_name'),
          folder_id: undefined,
          session_id: sessionId || undefined,
          model_config_id: selectedModelId || undefined,
          import_id: attempt.id,
        },
      });

      if (!isCurrentImportAttempt(attempt)) return;

      const summary = generateImportSummary(response);
      setImportSummary(summary);
      setPendingDetail(response);
      setExcludedCardIds(new Set());
      setShowQuestionFilter(false);
      setStep('summary');
      showGlobalNotification('success', t('exam_sheet:recognition_complete_notification', {  }));
    } catch (err: unknown) {
      debugLog.error('[ExamSheetUploader] 图片导入失败:', err);
      const errorMessage = err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null && 'message' in err)
          ? (err as { message: string }).message
          : String(err);
      if (!isCurrentImportAttempt(attempt)) return;
      setError(t('exam_sheet:uploader.import_failed_prefix', { error: errorMessage }));
      setStep('select');
      showGlobalNotification('error', errorMessage);
    } finally {
      if (isCurrentImportAttempt(attempt)) {
        activeImportAttemptRef.current = null;
        setIsLLMProcessing(false);
        setIsCancelling(false);
      }
    }
  }, [selectedFiles, sessionId, resolvedSessionName, selectedModelId, generateImportSummary, t, beginImportAttempt, isCurrentImportAttempt]);

  // 文档直接导入（使用流式版本，支持实时进度）
  const handleDocumentImport = useCallback(async () => {
    const file = selectedFiles[0].file;
    const attempt = beginImportAttempt();

    try {
      const base64Content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',')[1] || dataUrl;
          resolve(base64);
        };
        reader.onerror = () => reject(new Error('File read failed'));
        reader.readAsDataURL(file);
      });

      if (!isCurrentImportAttempt(attempt)) return;

      const format = file.name.split('.').pop()?.toLowerCase() || 'txt';

      // Visual-First: 所有格式统一走 VLM 管线，不再做 PDF 文本质量检测
      await executeDocumentImport(base64Content, format, undefined, attempt);

    } catch (err: unknown) {
      const errorMessage = err instanceof Error 
        ? err.message 
        : (typeof err === 'object' && err !== null && 'message' in err)
          ? (err as { message: string }).message
          : String(err);
      if (!isCurrentImportAttempt(attempt)) return;
      setError(t('exam_sheet:uploader.import_failed_prefix', { error: errorMessage }));
      setStep('select');
      activeImportAttemptRef.current = null;
      setIsLLMProcessing(false);
      setIsCancelling(false);
    }
  }, [selectedFiles, executeDocumentImport, t, beginImportAttempt, isCurrentImportAttempt]);

  // 开始处理 - 根据文件类型分流
  const handleStartProcess = useCallback(async () => {
    if (selectedFiles.length === 0) {
      setError(t('exam_sheet:uploader.select_first_error'));
      return;
    }

    const category = selectedFiles[0].category;
    
    if (category === 'image') {
      // 图片 → OCR 处理
      await handleImageOCR();
    } else {
      // 文档 → 直接调用后端导入（后端处理解析+LLM）
      await handleDocumentImport();
    }
  }, [selectedFiles, handleImageOCR, handleDocumentImport, t]);

  // 处理 UnifiedDragDropZone 的文件拖拽
  const handleFilesDropped = useCallback((files: File[]) => {
    handleFileSelect(files);
  }, [handleFileSelect]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFileSelect(e.target.files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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
    setLlmProgress({ percent: 0, message: '', parsedCount: 0 });
    setProcessPhase('preparing');
    setOcrPageDone([]);
    setResumableSession(null);
    setIsResumeRun(false);
    parsedCountRef.current = 0;
    setImportSummary(null);
    setPendingDetail(null);
    setExcludedCardIds(new Set());
    setShowQuestionFilter(false);
    setPendingPdfImport(null);
    setIsLLMProcessing(false);
    setIsCancelling(false);
    setShowCancelConfirm(false);
    resetOCRProgress();
  }, [selectedFiles, resetOCRProgress]);

  const handleCancelImport = useCallback(async () => {
    const attempt = activeImportAttemptRef.current;
    if (!attempt || isCancelling) return;

    setIsCancelling(true);
    try {
      const accepted = await invoke<boolean>('cancel_question_bank_import', {
        importId: attempt.id,
      });

      if (!isCurrentImportAttempt(attempt)) return;

      if (!accepted) {
        if (!attempt.backendStarted) {
          activeImportAttemptRef.current = null;
          setIsLLMProcessing(false);
          setIsCancelling(false);
          setShowCancelConfirm(false);
          setStep('select');
          setParsedQuestions([]);
          setLlmProgress({ percent: 0, message: '', parsedCount: 0 });
          setError(null);
          showGlobalNotification(
            'info',
            t('exam_sheet:uploader.import_cancelled'),
          );
          return;
        }

        setIsCancelling(false);
        setShowCancelConfirm(false);
        showGlobalNotification(
          'warning',
          t('exam_sheet:uploader.cancel_unavailable'),
        );
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
      setLlmProgress({ percent: 0, message: '', parsedCount: 0 });
      setError(null);
      showGlobalNotification(
        'info',
        t('exam_sheet:uploader.import_cancelled'),
      );
    } catch (error: unknown) {
      if (!isCurrentImportAttempt(attempt)) return;
      debugLog.error('[ExamSheetUploader] 请求取消导入失败:', error);
      setIsCancelling(false);
      showGlobalNotification(
        'error',
        t('exam_sheet:uploader.cancel_failed'),
      );
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
    setLlmProgress({
      percent: 42,
      message: t('exam_sheet:uploader.resuming'),
      parsedCount: resume.parsedCount,
    });
    setProcessPhase('parsing');

    try {
      const response = await invoke<ExamSheetSessionDetail>('resume_question_import', {
        sessionId: resume.sessionId,
      });

      if (!isCurrentImportAttempt(attempt)) return;

      const summary = generateImportSummary(response);
      setImportSummary(summary);
      setPendingDetail(response);
      setExcludedCardIds(new Set());
      setShowQuestionFilter(false);
      setStep('summary');
      showGlobalNotification('success', t('exam_sheet:uploader.resume_success'));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null && 'message' in err)
          ? (err as { message: string }).message
          : String(err);
      debugLog.error('[ExamSheetUploader] 断点续导失败:', err);
      if (!isCurrentImportAttempt(attempt)) return;
      setError(t('exam_sheet:uploader.resume_failed', { error: errorMessage }));
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
  }, [resumableSession, isLLMProcessing, beginImportAttempt, isCurrentImportAttempt, generateImportSummary, t]);

  // 是否正在处理
  const isProcessing = isOCRProcessing || isLLMProcessing;

  // OCR 进度（两阶段合并进度）
  const ocrProgressPercent = ocrProgress.total > 0 
    ? Math.round((ocrProgress.current / ocrProgress.total) * 100) 
    : 0;

  const ocrStageText = (() => {
    switch (ocrStage) {
      case 'ocr':
        return ocrPhaseProgress.total > 0
          ? t('exam_sheet:uploader.ocr_phase', {
              current: ocrPhaseProgress.current,
              total: ocrPhaseProgress.total
            })
          : t('exam_sheet:uploader.ocr_encoding');
      case 'parsing':
        return parsePhaseProgress.total > 0
          ? t('exam_sheet:uploader.parse_phase', {
              current: parsePhaseProgress.current,
              total: parsePhaseProgress.total
            })
          : t('exam_sheet:uploader.ocr_recognizing', { current: 0, total: 0 });
      case 'completed':
        return t('exam_sheet:uploader.ocr_completed');
      default:
        return t('exam_sheet:uploader.ocr_idle');
    }
  })();

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col">
        {/* min-h-full 列：内容矮时撑满高度让 dropzone 弹性扩展；内容高时自然向下滚动 */}
        <div className="w-full max-w-2xl mx-auto flex min-h-full flex-col gap-6">
          
          {/* 头部：标题 + 步骤指示 */}
          <div className="flex-shrink-0 space-y-4 pt-2">
            <div className="space-y-1.5 text-center">
              <h2 className="text-lg font-semibold">{t('exam_sheet:uploader.header_title')}</h2>
              <p className="text-sm text-muted-foreground">{t('exam_sheet:uploader.header_desc')}</p>
            </div>
            <UploadStepIndicator step={step} />
          </div>
          
          {/* 文件选择步骤：dropzone flex-1 弹性填充，高窗撑开 / 矮窗压缩（min-h 保底） */}
          {step === 'select' && (
            <div className="flex flex-1 min-h-0 flex-col gap-4 ui-rise-in">
              {/* 拖放区域 - 使用统一的 UnifiedDragDropZone */}
              <UnifiedDragDropZone
                zoneId="exam-sheet-uploader"
                onFilesDropped={handleFilesDropped}
                onDragStateChange={setIsDragActive}
                acceptedFileTypes={[EXAM_IMAGE_TYPE, EXAM_DOCUMENT_TYPE]}
                maxFiles={currentCategory === 'document' ? 1 : 20}
                maxFileSize={50 * 1024 * 1024}
                showOverlay={true}
                enabled={!isProcessing}
                className={cn(
                  'flex min-h-[160px] flex-1 flex-col rounded-md',
                  isProcessing && 'pointer-events-none opacity-60'
                )}
              >
                <div
                  onClick={!isProcessing ? handleClick : undefined}
                  className={cn(
                    'relative flex flex-1 flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-8 transition-all',
                    !isProcessing && 'cursor-pointer hover:border-primary/50 hover:bg-primary/5',
                    isDragActive
                      ? 'border-primary bg-primary/10 ring-2 ring-primary/20'
                      : 'border-border/60 bg-card/30'
                  )}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple={currentCategory !== 'document'}
                    accept="image/*,.docx,.xlsx,.xls,.txt,.md,.pdf,.heic,.heif"
                    onChange={handleInputChange}
                    className="hidden"
                    disabled={isProcessing}
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
                    disabled={isProcessing}
/>

                  <div className="flex flex-col items-center gap-4 text-center">
                    <div className="flex items-center gap-3">
                      <div className={cn('flex h-12 w-12 items-center justify-center rounded-lg transition-colors', isDragActive ? 'bg-primary/15' : 'bg-muted')}>
                        <Image size={22} className={cn('transition-colors', isDragActive ? 'text-primary' : 'text-muted-foreground')} />
                      </div>
                      <div className="text-lg font-light text-muted-foreground/30">/</div>
                      <div className={cn('flex h-12 w-12 items-center justify-center rounded-lg transition-colors', isDragActive ? 'bg-primary/15' : 'bg-muted')}>
                        <FileText size={22} className={cn('transition-colors', isDragActive ? 'text-primary' : 'text-muted-foreground')} />
                      </div>
                    </div>
                    
                    <div className="space-y-1">
                      <p className={cn('text-base font-medium transition-colors', isDragActive && 'text-primary')}>
                        {isDragActive
                          ? t('exam_sheet:uploader.drop_active')
                          : t('exam_sheet:uploader.drop_or_click')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('exam_sheet:uploader.supported_formats_all')}
                      </p>
                    </div>

                    {/* 移动端：拍照导入入口 */}
                    <NotionButton
                      variant="secondary"
                      size="sm"
                      className="sm:hidden gap-1.5"
                      disabled={isProcessing}
                      onClick={(e) => {
                        e.stopPropagation();
                        cameraInputRef.current?.click();
                      }}
                    >
                      <Camera size={16} />
                      {t('exam_sheet:uploader.take_photo')}
                    </NotionButton>
                  </div>
                </div>
              </UnifiedDragDropZone>

              {/* 识别方式说明（未选文件时显示，选了文件就让位给文件列表） */}
              {selectedFiles.length === 0 && !isProcessing && (
                <p className="flex-shrink-0 text-center text-xs text-muted-foreground">
                  {t('exam_sheet:uploader.tips_combined')}
                </p>
              )}

              {/* 已选图片列表 */}
              {currentCategory === 'image' && selectedFiles.length > 0 && !isProcessing && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {t('exam_sheet:uploader.selected_images', { count: selectedFiles.length })}
                    </span>
                    <NotionButton variant="ghost" size="sm" onClick={handleReset} className="text-muted-foreground">
                      {t('exam_sheet:uploader.clear')}
                    </NotionButton>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {selectedFiles.map((fileInfo, index) => (
                      <div
                        key={`${fileInfo.file.name}-${index}`}
                        className="relative aspect-square rounded-lg overflow-hidden bg-muted group"
                      >
                        <img
                          src={fileInfo.previewUrl || ''}
                          alt={fileInfo.file.name}
                          className="w-full h-full object-cover"
/>
                        <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleRemoveFile(index); }} className="absolute top-1 right-1 !w-6 !h-6 !rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100" aria-label="remove">
                          <X size={12} />
                        </NotionButton>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pendingPdfImport && currentCategory === 'document' && selectedFiles.length > 0 && (
                <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
                  <div className="text-sm font-medium text-warning">
                    {t('exam_sheet:uploader.pdf_quality_title', { count: pendingPdfImport.inspection.valid_char_count })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('exam_sheet:uploader.pdf_quality_description')}
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded bg-background/70 p-2 text-xs whitespace-pre-wrap border border-border/40">
                    {pendingPdfImport.inspection.preview_text || t('exam_sheet:uploader.pdf_quality_empty_preview')}
                  </div>
                  <div className="flex gap-2">
                    <NotionButton
                      variant="ghost"
                      className="flex-1"
                      disabled={selectedFiles.length === 0 || isProcessing}
                      onClick={() => {
                        void executeDocumentImport(
                          pendingPdfImport.base64Content,
                          pendingPdfImport.format,
                          false,
                        );
                      }}
                    >
                        {t('exam_sheet:uploader.pdf_use_extracted_text')}
                    </NotionButton>
                    <NotionButton
                      className="flex-1"
                      disabled={selectedFiles.length === 0 || isProcessing}
                      onClick={() => {
                        void executeDocumentImport(
                          pendingPdfImport.base64Content,
                          pendingPdfImport.format,
                          true,
                        );
                      }}
                    >
                        {t('exam_sheet:uploader.pdf_enable_ocr')}
                    </NotionButton>
                  </div>
                </div>
              )}

              {/* 已选文档信息 */}
              {currentCategory === 'document' && selectedFiles.length > 0 && !isProcessing && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <File size={20} className="text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{selectedFiles[0].file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {(selectedFiles[0].file.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <NotionButton variant="ghost" size="sm" onClick={handleReset}>
                      <X size={16} className="mr-1" />
                      {t('exam_sheet:uploader.remove')}
                    </NotionButton>
                  </div>
                  
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30">
                    <Robot size={16} className="text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-muted-foreground flex-shrink-0">{t('exam_sheet:uploader.parse_model')}</span>
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
                </div>
              )}

              {/* OCR 进度 */}
              {isOCRProcessing && (
                <div className="space-y-4 rounded-md border border-border/50 bg-card p-4 ui-rise-in">
                  <div className="flex items-center gap-3">
                    {ocrStage === 'completed' ? (
                      <CheckCircle size={20} className="text-success ui-zoom-fade-in" />
                    ) : (
                      <CircleNotch size={20} className="animate-spin text-primary" />
                    )}
                    <span className="text-sm font-medium">{ocrStageText}</span>
                  </div>
                  {ocrProgress.total > 0 && (
                    <div className="space-y-2">
                      <Progress value={ocrProgressPercent} className="h-2" />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {ocrStage === 'parsing'
                            ? `${parsePhaseProgress.current} / ${parsePhaseProgress.total}`
                            : `${ocrPhaseProgress.current} / ${ocrPhaseProgress.total}`}
                        </span>
                        <span>{ocrProgressPercent}%</span>
                      </div>
                    </div>
                  )}
                  {/* 逐页识别状态 */}
                  {ocrHookPageStatuses.length > 1 && (
                    <div className="space-y-1.5">
                      <div className="text-xs text-muted-foreground">{t('exam_sheet:uploader.page_status_label')}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {ocrHookPageStatuses.map((status, idx) => (
                          <span
                            key={idx}
                            title={t('exam_sheet:uploader.page_n', { page: idx + 1 })}
                            className={cn(
                              'flex h-6 min-w-6 items-center justify-center rounded px-1 text-[10px] font-medium ui-state-colors',
                              status === 'parsed' && 'bg-success/15 text-success',
                              status === 'ocr_done' && 'bg-primary/15 text-primary',
                              status === 'pending' && 'bg-muted text-muted-foreground/60'
                            )}
                          >
                            {status === 'parsed' ? <Check size={11} /> : idx + 1}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 提取中提示已移除：后端统一处理，无需单独的前端提取步骤 */}
            </div>
          )}

          {/* 文档预览步骤已移除：后端统一处理文档解析，无需前端预览 */}

          {/* LLM 处理步骤 - 实时显示已解析题目 */}
          {step === 'processing' && (
            <div className="flex flex-col flex-1 min-h-0 gap-3 ui-slide-fade-in [--ui-enter-x:24px]">
              {/* 阶段步骤条：准备 → 识别 → 解析 → 完成 */}
              <div className="flex-shrink-0">
                <ProcessPhaseBar phase={processPhase} />
              </div>

              {/* 进度头部 */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 flex-shrink-0">
                {llmProgress.percent === 100 ? (
                  <CheckCircle size={20} className="text-success flex-shrink-0 ui-zoom-fade-in" />
                ) : (
                  <CircleNotch size={20} className="text-primary animate-spin flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{llmProgress.message}</div>
                  <Progress value={llmProgress.percent} className="h-1.5 mt-1" />
                </div>
                <div className="text-sm font-bold text-primary">
                  {parsedQuestions.length || llmProgress.parsedCount || 0}
                </div>
                {isLLMProcessing && !isResumeRun && !showCancelConfirm && (
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowCancelConfirm(true)}
                    disabled={isCancelling}
                    className="shrink-0"
                  >
                    <X size={14} className="mr-1" />
                    {isCancelling
                      ? t('exam_sheet:uploader.cancelling_import')
                      : t('exam_sheet:uploader.cancel_import')}
                  </NotionButton>
                )}
              </div>

              {/* 取消导入的内联确认条 */}
              {showCancelConfirm && isLLMProcessing && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 flex-shrink-0 ui-drop-in">
                  <WarningCircle size={16} className="text-warning flex-shrink-0" />
                  <span className="flex-1 min-w-[12rem] text-xs text-warning">
                    {t('exam_sheet:uploader.cancel_confirm_hint')}
                  </span>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    className="!h-7 text-xs"
                    onClick={() => setShowCancelConfirm(false)}
                    disabled={isCancelling}
                  >
                    {t('exam_sheet:uploader.cancel_confirm_no')}
                  </NotionButton>
                  <NotionButton
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
                  </NotionButton>
                </div>
              )}

              {/* 逐页识别状态（图片/页面级 OCR 进度） */}
              {ocrPageDone.length > 1 && (
                <div className="space-y-1.5 rounded-md border border-border/40 bg-card/50 px-3 py-2 flex-shrink-0">
                  <div className="text-xs text-muted-foreground">{t('exam_sheet:uploader.page_status_label')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ocrPageDone.map((done, idx) => (
                      <span
                        key={idx}
                        title={t('exam_sheet:uploader.page_n', { page: idx + 1 })}
                        className={cn(
                          'flex h-6 min-w-6 items-center justify-center rounded px-1 text-[10px] font-medium ui-state-colors',
                          done ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground/60'
                        )}
                      >
                        {done ? <Check size={11} /> : idx + 1}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 实时解析的题目列表 */}
              {parsedQuestions.length > 0 && (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="text-xs text-muted-foreground px-1 mb-2 flex-shrink-0">{t('exam_sheet:uploader.parsed_questions_label')}</div>
                  <div ref={parsedListRef} className="flex-1 min-h-0 overflow-y-auto space-y-2">
                    {parsedQuestions.map((q, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-lg bg-card border border-border/50 ui-rise-in"
                      >
                        <div className="flex items-start gap-2">
                          <span className="w-6 h-6 flex-shrink-0 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                            {idx + 1}
                          </span>
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="text-sm line-clamp-2">{q.content || t('exam_sheet:uploader.no_content')}</div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {q.question_type && (
                                <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary">
                                  {t(`exam_sheet:questionTypes.${q.question_type}`, q.question_type)}
                                </span>
                              )}
                              {q.options && q.options.length > 0 && (
                                <span className="text-[10px] text-muted-foreground">
                                  {t('exam_sheet:uploader.options_count', { count: q.options.length })}
                                </span>
                              )}
                              {q.answer && (
                                <span className="text-[10px] text-success">
                                  {t('exam_sheet:uploader.answer_prefix', { answer: q.answer })}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 空状态 */}
              {parsedQuestions.length === 0 && llmProgress.percent > 5 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <CircleNotch size={32} className="mx-auto mb-2 opacity-50 animate-spin" />
                  {t('exam_sheet:uploader.waiting_ai')}
                </div>
              )}
            </div>
          )}

          {/* 导入结果摘要 */}
          {step === 'summary' && importSummary && (() => {
            const allCards = pendingDetail?.preview?.pages?.flatMap(p => p.cards || []) || [];
            const keptCount = Math.max(0, importSummary.totalQuestions - excludedCardIds.size);
            return (
              <div className="space-y-3 ui-slide-fade-in [--ui-enter-x:24px]">
              <div className="space-y-2 text-center">
                <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-md bg-success/10 ui-zoom-fade-in">
                  <CheckCircle size={20} weight="fill" className="text-success" />
                </div>
                <h3 className="text-base font-semibold">{t('exam_sheet:uploader.import_complete_title')}</h3>
              </div>
              
              {/* 统计数据 */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md bg-muted/50 p-3 text-center">
                  <div className="text-lg font-semibold text-primary">
                    {excludedCardIds.size > 0 ? (
                      <>{keptCount}<span className="text-base font-normal text-muted-foreground"> / {importSummary.totalQuestions}</span></>
                    ) : importSummary.totalQuestions}
                  </div>
                  <div className="text-sm text-muted-foreground">{t('exam_sheet:uploader.total_questions')}</div>
                </div>
                <div className="rounded-md bg-muted/50 p-3 text-center">
                  <div className="text-lg font-semibold">{importSummary.pageCount}</div>
                  <div className="text-sm text-muted-foreground">{t('exam_sheet:uploader.page_count')}</div>
                </div>
              </div>
              
              {/* 题型分布 */}
              {Object.keys(importSummary.questionTypes).length > 0 && (
                <div className="space-y-2 rounded-md bg-muted/30 p-3">
                  <div className="text-sm font-medium">{t('exam_sheet:uploader.question_type_dist')}</div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(importSummary.questionTypes).map(([type, count]) => (
                      <span key={type} className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary">
                        {t(`exam_sheet:questionTypes.${type}`, type)} {count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 题目筛选区域 */}
              {allCards.length > 0 && (
                <div className="overflow-hidden rounded-md border border-border/50">
                  {/* 筛选头部 */}
                  <div
                    className="flex items-center justify-between px-4 py-2.5 bg-muted/30 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
                    onClick={() => setShowQuestionFilter(prev => !prev)}
                  >
                    <div className="flex items-center gap-2">
                      <Funnel size={16} className="text-muted-foreground" />
                      <span className="text-sm font-medium">
                        {t('exam_sheet:uploader.filter_questions')}
                      </span>
                      {excludedCardIds.size > 0 && (
                        <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                          {t('exam_sheet:uploader.filter_excluded_count', { count: excludedCardIds.size })}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {showQuestionFilter ? '▲' : '▼'}
                    </span>
                  </div>

                  {/* 筛选提示 */}
                  {!showQuestionFilter && excludedCardIds.size === 0 && (
                    <div className="px-4 py-2 text-xs text-muted-foreground bg-muted/10">
                      {t('exam_sheet:uploader.filter_hint')}
                    </div>
                  )}

                  {/* 题目列表 */}
                  {showQuestionFilter && (
                    <div className="border-t border-border/30">
                      {/* 全选/取消全选 */}
                      <div className="flex items-center justify-between px-4 py-2 bg-muted/15 border-b border-border/20">
                        <NotionButton
                          variant="ghost"
                          size="sm"
                          className="!h-7 text-xs"
                          onClick={() => setExcludedCardIds(new Set())}
                        >
                          <CheckSquare size={14} className="mr-1" />
                          {t('common:select_all')}
                        </NotionButton>
                        <NotionButton
                          variant="ghost"
                          size="sm"
                          className="!h-7 text-xs"
                          onClick={() => setExcludedCardIds(new Set(allCards.map(c => c.card_id)))}
                        >
                          <Square size={14} className="mr-1" />
                          {t('common:deselect_all')}
                        </NotionButton>
                      </div>
                      {/* 滚动列表 */}
                      <div className="max-h-[280px] overflow-y-auto divide-y divide-border/20">
                        {allCards.map((card, idx) => {
                          const isExcluded = excludedCardIds.has(card.card_id);
                          return (
                            <div
                              key={card.card_id}
                              className={cn(
                                'flex items-start gap-2.5 px-4 py-2.5 cursor-pointer transition-colors',
                                isExcluded ? 'bg-muted/20 opacity-60' : 'hover:bg-[var(--interactive-hover)]'
                              )}
                              onClick={() => {
                                setExcludedCardIds(prev => {
                                  const next = new Set(prev);
                                  if (next.has(card.card_id)) {
                                    next.delete(card.card_id);
                                  } else {
                                    next.add(card.card_id);
                                  }
                                  return next;
                                });
                              }}
                            >
                              {/* 勾选框 */}
                              <div className="flex-shrink-0 mt-0.5">
                                {isExcluded ? (
                                  <Square size={16} className="text-muted-foreground" />
                                ) : (
                                  <CheckSquare size={16} className="text-primary" />
                                )}
                              </div>
                              {/* 序号 */}
                              <span className="w-5 h-5 flex-shrink-0 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center mt-0.5">
                                {idx + 1}
                              </span>
                              {/* 内容 */}
                              <div className="flex-1 min-w-0 space-y-0.5">
                                <div className={cn('text-sm line-clamp-2', isExcluded && 'line-through')}>
                                  {card.ocr_text?.trim() || card.question_label || t('exam_sheet:uploader.no_content')}
                                </div>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {card.question_type && (
                                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary">
                                      {t(`exam_sheet:questionTypes.${card.question_type}`, card.question_type)}
                                    </span>
                                  )}
                                  {card.answer && (
                                    <span className="text-[10px] text-success">
                                      {t('exam_sheet:uploader.answer_prefix', { answer: card.answer })}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              
              {/* 警告信息 */}
              {importSummary.warnings.length > 0 && (
                <div className="space-y-2 rounded-md bg-warning/10 p-3">
                  <div className="flex items-center gap-2 text-warning">
                    <Info size={16} />
                    <span className="text-sm font-medium">{t('exam_sheet:uploader.notes_title')}</span>
                  </div>
                  <ul className="space-y-1 text-sm text-warning/80">
                    {importSummary.warnings.map((warning, idx) => (
                      <li key={idx}>• {warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* 操作按钮 */}
              <div className="flex gap-3 pt-2">
                <NotionButton variant="ghost" onClick={handleReset} className="flex-1">
                  {t('exam_sheet:uploader.continue_import')}
                </NotionButton>
                <NotionButton onClick={() => void handleConfirmSummary()} className="flex-1" disabled={keptCount === 0 || isConfirming}>
                  {isConfirming && <CircleNotch size={16} className="mr-1 animate-spin" />}
                  {excludedCardIds.size > 0
                    ? t('exam_sheet:uploader.view_questions_filtered', { count: keptCount })
                    : t('exam_sheet:uploader.view_questions')
                  }
                </NotionButton>
              </div>
            </div>
            );
          })()}

          {/* 错误显示 */}
          {(error || ocrError) && (
            <div className="space-y-2 ui-drop-in">
              <div className="flex items-start gap-3 rounded-md bg-destructive/10 p-3 text-destructive">
                <WarningCircle size={20} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm">{error || ocrError}</div>
                {step === 'select' && selectedFiles.length > 0 && !isProcessing && (
                  <NotionButton
                    variant="outline"
                    size="sm"
                    onClick={() => void handleStartProcess()}
                    className="shrink-0"
                  >
                    <ArrowClockwise size={16} className="mr-1" />
                    {t('common:retry')}
                  </NotionButton>
                )}
              </div>
              {/* 断点续导：失败前已解析部分题目时，可跳过已完成分块继续导入 */}
              {resumableSession && step === 'select' && !isProcessing && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                  <Info size={16} className="text-warning flex-shrink-0" />
                  <span className="flex-1 min-w-[12rem] text-xs text-warning">
                    {t('exam_sheet:uploader.import_interrupted', { count: resumableSession.parsedCount })}
                  </span>
                  <NotionButton
                    variant="warning"
                    size="sm"
                    className="!h-7 text-xs"
                    onClick={() => void handleResumeImport()}
                  >
                    <ArrowClockwise size={14} className="mr-1" />
                    {t('exam_sheet:uploader.resume_import')}
                  </NotionButton>
                </div>
              )}
            </div>
          )}

          {/* 操作按钮：选了文件（或处理中）才出现，避免空态下的 disabled 主按钮 */}
          {step === 'select' && (selectedFiles.length > 0 || isProcessing) && (
            <div className="flex gap-3">
              {onBack && (
                <NotionButton variant="ghost" onClick={onBack} disabled={isProcessing} className="flex-1">
                  {t('common:actions.back')}
                </NotionButton>
              )}
              <NotionButton
                onClick={handleStartProcess}
                disabled={selectedFiles.length === 0 || isProcessing}
                className="flex-1 gap-2"
              >
                {isProcessing ? (
                  <>
                    <CircleNotch size={16} className="animate-spin" />
                    {t('exam_sheet:uploader.processing')}
                  </>
                ) : currentCategory === 'image' ? (
                  <>
                    <Upload size={16} />
                    {t('exam_sheet:uploader.start_recognize')}
                  </>
                ) : (
                  <>
                    <FileText size={16} />
                    {t('exam_sheet:uploader.parse_document')}
                  </>
                )}
              </NotionButton>
            </div>
          )}

          {/* preview 步骤已移除：后端统一处理文档解析和 LLM，无需前端预览 */}

          {/* 没有文件可导入？回启动台手动新建（优先走专用回调，直接打开创建编辑器） */}
          {step === 'select' && !isProcessing && (onManualCreate || onBack) && (
            <div className="text-center">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={onManualCreate ?? onBack}
                className="!h-auto !px-2 !py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {t('exam_sheet:uploader.manual_create_link')}
              </NotionButton>
            </div>
          )}

          {step === 'processing' && !isLLMProcessing && (
            <div className="flex justify-center">
              <NotionButton variant="ghost" onClick={onBack}>
                {t('exam_sheet:uploader.done')}
              </NotionButton>
            </div>
          )}

          {/* 提示信息已合并到拖放区下方（tips_combined），未选文件时显示 */}
        </div>
      </div>
    </div>
  );
};

export default ExamSheetUploader;
