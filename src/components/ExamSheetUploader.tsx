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
  Loader2,
  X,
  ImagePlus,
  FileText,
  AlertCircle,
  CheckCircle2,
  File,
  Info,
  Bot,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Progress } from '@/components/ui/shad/Progress';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { useExamSheetProgress } from '@/hooks/useExamSheetProgress';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { UnifiedModelSelector, type UnifiedModelInfo } from '@/components/shared/UnifiedModelSelector';
import { UnifiedDragDropZone, FILE_TYPES, type FileTypeDefinition } from '@/components/shared/UnifiedDragDropZone';
import type { ApiConfig } from '@/types';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ★ 试卷上传专用文件类型（支持 HEIC，与统一组件的 IMAGE 略有不同）
const EXAM_IMAGE_TYPE: FileTypeDefinition = {
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'],
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
  description: 'Image',
};
const EXAM_DOCUMENT_TYPE: FileTypeDefinition = {
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

export const ExamSheetUploader: React.FC<ExamSheetUploaderProps> = ({
  sessionId,
  sessionName,
  onUploadSuccess,
  onBack,
  className,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'settings']);
  const resolvedSessionName = sessionName ?? t('exam_sheet:uploader.session_name_default');
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 文件状态
  const [selectedFiles, setSelectedFiles] = useState<FileInfo[]>([]);
  
  // 文档导入状态
  const [step, setStep] = useState<ProcessStep>('select');
  const [qbankName, setQbankName] = useState('');
  const [isLLMProcessing, setIsLLMProcessing] = useState(false);
  const [llmProgress, setLlmProgress] = useState({ percent: 0, message: '', parsedCount: 0 });
  
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
    
    const setupListener = async () => {
      unlisten = await listen<{
        type: string;
        session_id?: string;
        name?: string;
        total_chunks?: number;
        chunk_index?: number;
        question?: unknown;
        question_index?: number;
        total_parsed?: number;
        questions_in_chunk?: number;
        total_questions?: number;
        error?: string;
      }>('question_import_progress', (event) => {
        const payload = event.payload;
        
        switch (payload.type) {
          case 'SessionCreated':
            setLlmProgress({
              percent: 5,
              message: t('exam_sheet:uploader.parsing_started', { chunks: payload.total_chunks }),
              parsedCount: 0,
            });
            break;
          case 'ChunkStart':
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.min(10 + ((payload.chunk_index || 0) / (payload.total_chunks || 1)) * 70, 80),
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
            setLlmProgress(prev => ({
              ...prev,
              parsedCount: payload.total_parsed || 0,
              message: t('exam_sheet:uploader.parsed_count', { count: payload.total_parsed }),
            }));
            break;
          case 'ChunkCompleted':
            setLlmProgress(prev => ({
              ...prev,
              percent: Math.min(10 + (((payload.chunk_index || 0) + 1) / (payload.total_chunks || 1)) * 80, 90),
              parsedCount: payload.total_parsed || 0,
              message: t('exam_sheet:uploader.chunk_completed', { current: (payload.chunk_index || 0) + 1, total: payload.total_chunks, count: payload.total_parsed }),
            }));
            break;
          case 'Completed':
            setLlmProgress({
              percent: 100,
              message: t('exam_sheet:uploader.import_done', { count: payload.total_questions }),
              parsedCount: payload.total_questions || 0,
            });
            break;
          case 'Failed':
            setError(t('exam_sheet:uploader.import_failed_prefix', { error: payload.error }));
            if ((payload.total_parsed || 0) > 0) {
              setLlmProgress(prev => ({
                ...prev,
                message: t('exam_sheet:uploader.import_interrupted', { count: payload.total_parsed }),
              }));
            }
            break;
        }
      });
    };
    
    setupListener();
    
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // 使用统一的 OCR 进度 Hook（仅用于图片处理）
  const {
    isProcessing: isOCRProcessing,
    stage: ocrStage,
    progress: ocrProgress,
    ocrProgress: ocrPhaseProgress,
    parseProgress: parsePhaseProgress,
    error: ocrError,
    reset: resetOCRProgress,
    startProcessing: startOCRProcessing,
    setError: setOCRError,
  } = useExamSheetProgress({
    onSessionUpdate: async (detail) => {
      // 生成摘要并显示
      const summary = generateImportSummary(detail);
      setImportSummary(summary);
      setPendingDetail(detail);
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
  }, []);

  // 确认导入摘要
  const handleConfirmSummary = useCallback(() => {
    if (pendingDetail) {
      showGlobalNotification('success', t('exam_sheet:uploader.import_success_notification', { count: importSummary?.totalQuestions || 0 }));
      onUploadSuccess?.(pendingDetail);
    }
  }, [pendingDetail, importSummary, onUploadSuccess]);

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
    
    // 文档只接受一个文件
    if (validFiles[0].category === 'document') {
      setSelectedFiles([validFiles[0]]);
      setQbankName(validFiles[0].file.name.replace(/\.[^/.]+$/, ''));
    } else {
      setSelectedFiles(prev => [...prev, ...validFiles]);
    }
  }, [categorizeFile, currentCategory]);

  // 移除已选文件
  const handleRemoveFile = useCallback((index: number) => {
    setSelectedFiles(prev => {
      const file = prev[index];
      if (file.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      const newFiles = prev.filter((_, i) => i !== index);
      if (newFiles.length === 0) {
        setStep('select');
      }
      return newFiles;
    });
  }, []);

  // 清理预览 URL
  useEffect(() => {
    return () => {
      selectedFiles.forEach(f => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
    };
  }, [selectedFiles]);

  // 图片 OCR 处理
  const handleImageOCR = useCallback(async () => {
    // ★ 立即标记为处理中，消除按钮点击→SessionCreated 之间的竞态窗口
    // 防止用户快速双击导致两个并行 OCR 请求（会触发速率限制/请求阻塞）
    startOCRProcessing();
    
    try {
      const imageFiles = selectedFiles.map(f => f.file);
      debugLog.info('[ExamSheetUploader] 开始 OCR 处理:', imageFiles.length, '个图片');

      const result = await TauriAPI.processExamSheetPreview({
        examName: resolvedSessionName,
        pageImages: imageFiles,
        outputFormat: 'deepseek_ocr',
        sessionId: sessionId,
      });

      // ★ invoke 成功返回 = 后端已完成，直接触发完成流程
      // 不依赖 Completed 事件（事件可能因时序问题丢失）
      resetOCRProgress();
      if (result.session_id) {
        try {
          const detail = await TauriAPI.getExamSheetSessionDetail(result.session_id);
          const summary = generateImportSummary(detail);
          setImportSummary(summary);
          setPendingDetail(detail);
          setStep('summary');
          showGlobalNotification('success', t('exam_sheet:recognition_complete_notification', { defaultValue: 'Question set recognition completed!' }));
        } catch (detailErr) {
          debugLog.warn('[ExamSheetUploader] 获取会话详情失败，回退到通知:', detailErr);
          showGlobalNotification('info', t('exam_sheet:uploader.upload_success'));
        }
      } else {
        showGlobalNotification('info', t('exam_sheet:uploader.upload_success'));
      }
    } catch (err: unknown) {
      debugLog.error('[ExamSheetUploader] OCR 处理失败:', err);
      const errorMessage = err instanceof Error ? err.message : t('exam_sheet:error_processing', { error: '' });
      setOCRError(errorMessage);
      showGlobalNotification('error', errorMessage);
    }
  }, [selectedFiles, sessionId, sessionName, startOCRProcessing, setOCRError, resetOCRProgress, generateImportSummary]);

  // 文档直接导入（使用流式版本，支持实时进度）
  const handleDocumentImport = useCallback(async () => {
    const file = selectedFiles[0].file;
    setStep('processing');
    setIsLLMProcessing(true);
    setLlmProgress({ percent: 0, message: t('exam_sheet:uploader.reading_document'), parsedCount: 0 });
    setParsedQuestions([]); // 清空已解析题目，准备接收新的流式数据
    setError(null);

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

      setLlmProgress({ percent: 5, message: t('exam_sheet:uploader.parsing_document'), parsedCount: 0 });

      const format = file.name.split('.').pop()?.toLowerCase() || 'txt';

      const response = await invoke<ExamSheetSessionDetail>('import_question_bank_stream', {
        request: {
          content: base64Content,
          format: format,
          name: qbankName || file.name.replace(/\\.[^/.]+$/, ''),
          folder_id: undefined,
          session_id: sessionId || undefined,
          model_config_id: selectedModelId || undefined,
        },
      });

      const summary = generateImportSummary(response);
      setImportSummary(summary);
      setPendingDetail(response);
      setStep('summary');

    } catch (err: unknown) {
      const errorMessage = err instanceof Error 
        ? err.message 
        : (typeof err === 'object' && err !== null && 'message' in err)
          ? (err as { message: string }).message
          : String(err);
      setError(t('exam_sheet:uploader.import_failed_prefix', { error: errorMessage }));
      setStep('select');
    } finally {
      setIsLLMProcessing(false);
    }
  }, [selectedFiles, qbankName, sessionId, selectedModelId, generateImportSummary]);

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
  }, [selectedFiles, handleImageOCR, handleDocumentImport]);

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
    selectedFiles.forEach(f => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    setSelectedFiles([]);
    setStep('select');
    setQbankName('');
    setError(null);
    setParsedQuestions([]);
    resetOCRProgress();
  }, [selectedFiles, resetOCRProgress]);

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
              total: ocrPhaseProgress.total,
              defaultValue: 'OCR 识别中 ({{current}}/{{total}})'
            })
          : t('exam_sheet:uploader.ocr_encoding');
      case 'parsing':
        return parsePhaseProgress.total > 0
          ? t('exam_sheet:uploader.parse_phase', {
              current: parsePhaseProgress.current,
              total: parsePhaseProgress.total,
              defaultValue: '题目解析中 ({{current}}/{{total}})'
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
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto space-y-6">
          
          {/* 文件选择步骤 */}
          {step === 'select' && (
            <>
              {/* 拖放区域 - 使用统一的 UnifiedDragDropZone */}
              <UnifiedDragDropZone
                zoneId="exam-sheet-uploader"
                onFilesDropped={handleFilesDropped}
                acceptedFileTypes={[EXAM_IMAGE_TYPE, EXAM_DOCUMENT_TYPE]}
                maxFiles={currentCategory === 'document' ? 1 : 20}
                maxFileSize={50 * 1024 * 1024}
                showOverlay={true}
                enabled={!isProcessing}
                className={cn(
                  'rounded-2xl',
                  isProcessing && 'pointer-events-none opacity-60'
                )}
              >
                <div
                  onClick={!isProcessing ? handleClick : undefined}
                  className={cn(
                    'relative rounded-2xl border-2 border-dashed p-8 transition-all',
                    !isProcessing && 'cursor-pointer hover:border-primary/50 hover:bg-primary/5',
                    'border-border/60 bg-card/30'
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

                  <div className="flex flex-col items-center gap-4 text-center">
                    <div className="flex items-center gap-3">
                      <div className="w-14 h-14 rounded-2xl flex items-center justify-center transition-colors bg-muted">
                        <ImagePlus className="w-7 h-7 transition-colors text-muted-foreground" />
                      </div>
                      <div className="text-2xl text-muted-foreground/30 font-light">/</div>
                      <div className="w-14 h-14 rounded-2xl flex items-center justify-center transition-colors bg-muted">
                        <FileText className="w-7 h-7 transition-colors text-muted-foreground" />
                      </div>
                    </div>
                    
                    <div className="space-y-1">
                      <p className="text-base font-medium">
                        {t('exam_sheet:uploader.drop_or_click')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('exam_sheet:uploader.supported_formats_all')}
                      </p>
                    </div>
                  </div>
                </div>
              </UnifiedDragDropZone>

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
                  <div className="grid grid-cols-4 gap-2">
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
                        <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleRemoveFile(index); }} className="absolute top-1 right-1 !w-6 !h-6 !rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100" aria-label="remove">
                          <X className="w-3 h-3" />
                        </NotionButton>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 已选文档信息 */}
              {currentCategory === 'document' && selectedFiles.length > 0 && !isProcessing && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <File className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{selectedFiles[0].file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {(selectedFiles[0].file.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <NotionButton variant="ghost" size="sm" onClick={handleReset}>
                      <X className="w-4 h-4 mr-1" />
                      {t('exam_sheet:uploader.remove')}
                    </NotionButton>
                  </div>
                  
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30">
                    <Bot className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-muted-foreground flex-shrink-0">{t('exam_sheet:uploader.parse_model')}</span>
                    <UnifiedModelSelector
                      models={availableModels}
                      value={selectedModelId}
                      onChange={setSelectedModelId}
                      variant="compact"
                      allowEmpty
                      emptyLabel={t('settings:placeholders.use_default_model', '使用默认模型')}
                      placeholder={t('settings:placeholders.use_default_model', '使用默认模型')}
                      className="flex-1"
                    />
                  </div>
                </div>
              )}

              {/* OCR 进度 */}
              {isOCRProcessing && (
                <div className="space-y-4 p-4 rounded-xl bg-card border border-border/50">
                  <div className="flex items-center gap-3">
                    {ocrStage === 'completed' ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    ) : (
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
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
                </div>
              )}

              {/* 提取中提示已移除：后端统一处理，无需单独的前端提取步骤 */}
            </>
          )}

          {/* 文档预览步骤已移除：后端统一处理文档解析，无需前端预览 */}

          {/* LLM 处理步骤 - 实时显示已解析题目 */}
          {step === 'processing' && (
            <div className="flex flex-col flex-1 min-h-0 gap-3">
              {/* 进度头部 */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 flex-shrink-0">
                {llmProgress.percent === 100 ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                ) : (
                  <Loader2 className="w-5 h-5 text-primary animate-spin flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{llmProgress.message}</div>
                  <Progress value={llmProgress.percent} className="h-1.5 mt-1" />
                </div>
                <div className="text-sm font-bold text-primary">
                  {parsedQuestions.length}
                </div>
              </div>

              {/* 实时解析的题目列表 */}
              {parsedQuestions.length > 0 && (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="text-xs text-muted-foreground px-1 mb-2 flex-shrink-0">{t('exam_sheet:uploader.parsed_questions_label')}</div>
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
                    {parsedQuestions.map((q, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-lg bg-card border border-border/50 animate-in fade-in slide-in-from-bottom-2 duration-300"
                      >
                        <div className="flex items-start gap-2">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
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
                                <span className="text-[10px] text-emerald-600">
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
                  <Loader2 className="w-8 h-8 mx-auto mb-2 opacity-50 animate-spin" />
                  {t('exam_sheet:uploader.waiting_ai')}
                </div>
              )}
            </div>
          )}

          {/* 导入结果摘要 */}
          {step === 'summary' && importSummary && (
            <div className="space-y-4">
              <div className="text-center space-y-2">
                <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                </div>
                <h3 className="text-lg font-semibold">{t('exam_sheet:uploader.import_complete_title')}</h3>
              </div>
              
              {/* 统计数据 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 rounded-xl bg-muted/50 text-center">
                  <div className="text-2xl font-bold text-primary">{importSummary.totalQuestions}</div>
                  <div className="text-sm text-muted-foreground">{t('exam_sheet:uploader.total_questions')}</div>
                </div>
                <div className="p-4 rounded-xl bg-muted/50 text-center">
                  <div className="text-2xl font-bold">{importSummary.pageCount}</div>
                  <div className="text-sm text-muted-foreground">{t('exam_sheet:uploader.page_count')}</div>
                </div>
              </div>
              
              {/* 题型分布 */}
              {Object.keys(importSummary.questionTypes).length > 0 && (
                <div className="p-4 rounded-xl bg-muted/30 space-y-2">
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
              
              {/* 警告信息 */}
              {importSummary.warnings.length > 0 && (
                <div className="p-4 rounded-xl bg-amber-500/10 space-y-2">
                  <div className="flex items-center gap-2 text-amber-600">
                    <Info className="w-4 h-4" />
                    <span className="text-sm font-medium">{t('exam_sheet:uploader.notes_title')}</span>
                  </div>
                  <ul className="text-sm text-amber-600/80 space-y-1">
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
                <NotionButton onClick={handleConfirmSummary} className="flex-1">
                  {t('exam_sheet:uploader.view_questions')}
                </NotionButton>
              </div>
            </div>
          )}

          {/* 错误显示 */}
          {(error || ocrError) && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-destructive/10 text-destructive">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div className="text-sm">{error || ocrError}</div>
            </div>
          )}

          {/* 操作按钮 */}
          {step === 'select' && (
            <div className="flex gap-3">
              {onBack && (
                <NotionButton variant="ghost" onClick={onBack} disabled={isProcessing} className="flex-1">
                  {t('common:actions.cancel')}
                </NotionButton>
              )}
              <NotionButton
                onClick={handleStartProcess}
                disabled={selectedFiles.length === 0 || isProcessing}
                className="flex-1 gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('exam_sheet:uploader.processing')}
                  </>
                ) : currentCategory === 'image' ? (
                  <>
                    <Upload className="w-4 h-4" />
                    {t('exam_sheet:uploader.start_recognize')}
                  </>
                ) : (
                  <>
                    <FileText className="w-4 h-4" />
                    {t('exam_sheet:uploader.parse_document')}
                  </>
                )}
              </NotionButton>
            </div>
          )}

          {/* preview 步骤已移除：后端统一处理文档解析和 LLM，无需前端预览 */}

          {step === 'processing' && !isLLMProcessing && (
            <div className="flex justify-center">
              <NotionButton variant="ghost" onClick={onBack}>
                {t('exam_sheet:uploader.done')}
              </NotionButton>
            </div>
          )}

          {/* 提示信息 */}
          {step === 'select' && !isProcessing && (
            <div className="text-center text-xs text-muted-foreground space-y-1">
              <p>• {t('exam_sheet:uploader.tip_image')}</p>
              <p>• {t('exam_sheet:uploader.tip_document')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExamSheetUploader;
