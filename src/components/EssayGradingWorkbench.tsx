import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EssayGradingAPI,
  canonicalizeEssayModeId,
  type GradingSession,
  type GradingRound,
  type GradingMode,
  type ModelInfo,
} from '../essay-grading/essayGradingApi';
import {
  essayDstuAdapter,
  type EssayGradingSession,
  type DstuGradingRound,
  type EssayDstuModeConfig,
} from '@/dstu/adapters/essayDstuAdapter';
import { useEssayGradingStream } from '../essay-grading/useEssayGradingStream';
import { ocrExtractText, TauriAPI } from '../utils/tauriApi';
import { getErrorMessage } from '../utils/errorUtils';
import { fileManager } from '../utils/fileManager';
import { showGlobalNotification } from './UnifiedNotification';
import { CustomScrollArea } from './custom-scroll-area';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';
import { NotionAlertDialog } from './ui/NotionDialog';

import { debugLog } from '../debug-panel/debugMasterSwitch';

// 子组件
import { GradingMain } from './essay-grading/GradingMain';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
// GradingHistory 已移除 - 历史由 Learning Hub 管理

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const OCR_MAX_FILES = 5;

/** OCR 处理状态 */
export type OcrStatus = 'pending' | 'processing' | 'retrying' | 'done' | 'error' | 'timeout';

/** 上传的图片数据（保存原图 base64 + OCR 文本） */
export interface UploadedImage {
  id: string;
  fileName: string;
  base64: string;
  ocrText: string;
  /** data URL 用于缩略图预览 */
  dataUrl: string;
  /** OCR 处理状态（默认 pending） */
  ocrStatus?: OcrStatus;
  /** OCR 错误信息 */
  ocrError?: string;
  /** 请求版本号，用于时序控制 */
  ocrVersion?: number;
  /** 已重试次数（默认 0） */
  ocrRetryCount?: number;
}

interface EssayGradingWorkbenchProps {
  onBack?: () => void;
  /** DSTU 模式配置（必需），由 Learning Hub 管理会话 */
  dstuMode: EssayDstuModeConfig;
}

export const EssayGradingWorkbench: React.FC<EssayGradingWorkbenchProps> = ({ onBack, dstuMode }) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  // 流式批改管线
  const gradingStream = useEssayGradingStream();

  // DSTU 模式：从会话初始化状态
  const initialSession = dstuMode.session;

  // Tab 状态（始终为 grading，历史由 Learning Hub 管理）
  const activeTab = 'grading' as const;

  // 会话状态
  const [currentSession, setCurrentSession] = useState<GradingSession | null>(null);
  const [rounds, setRounds] = useState<GradingRound[]>([]);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0); // 当前显示的轮次索引

  // 输入状态（从 DSTU 初始化，确保默认值防止 undefined）
  const [inputText, setInputText] = useState(initialSession?.inputText ?? '');
  const [essayType, setEssayType] = useState(initialSession?.essayType ?? 'other');
  const [gradeLevel, setGradeLevel] = useState(initialSession?.gradeLevel ?? 'high_school');
  const [customPrompt, setCustomPrompt] = useState(initialSession?.customPrompt ?? '');
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [showNextRoundConfirm, setShowNextRoundConfirm] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const lastGradedInputRef = useRef<string>('');
  const draftRestoredRef = useRef(false);

  // ★ 图片存储状态（保存原图用于预览和多模态批改）
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  // ★ 题目元数据状态（作文题目/要求/参考材料）
  const [topicText, setTopicText] = useState('');
  const [topicImages, setTopicImages] = useState<UploadedImage[]>([]);

  // 监听全局顶栏的设置按钮点击事件（移动端）- 切换模式
  // TODO: Migrate 'essay:openSettings' to a centralised event hook/registry
  //       (e.g. useAppEvent or EventBus) so that the event source and consumer are
  //       co-located in a single registry rather than scattered across files.
  useEffect(() => {
    const handleToggleSettings = (evt: Event) => {
      // ★ 标签页：检查 targetResourceId 是否匹配（无 targetResourceId 时兼容旧调用）
      const detail = (evt as CustomEvent<{ targetResourceId?: string }>).detail;
      if (detail?.targetResourceId && dstuMode.resourceId && detail.targetResourceId !== dstuMode.resourceId) {
        return;
      }
      setShowPromptEditor(prev => !prev);
    };
    window.addEventListener('essay:openSettings', handleToggleSettings);
    return () => {
      window.removeEventListener('essay:openSettings', handleToggleSettings);
    };
  }, [dstuMode.resourceId]);

  // 批阅模式状态
  const [modes, setModes] = useState<GradingMode[]>([]);
  const [modeId, setModeId] = useState(
    initialSession?.modeId ? canonicalizeEssayModeId(initialSession.modeId) : 'practice'
  ); // 默认使用日常练习模式

  // 模型选择状态
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState(''); // 空字符串表示使用默认模型

  // 历史状态已移除 - 由 Learning Hub 管理

  const gradingResult = gradingStream.gradingResult ?? '';
  const isGrading = gradingStream.isGrading ?? false;
  const isPartialResult = gradingStream.isPartialResult ?? false;

  // 当前轮次
  const currentRound = rounds[currentRoundIndex];
  const currentRoundNumber = currentRound?.round_number ?? (rounds.length + 1);
  const totalRounds = rounds.length;

  // 加载模型列表
  const loadModels = useCallback(async () => {
    try {
      const loadedModels = await EssayGradingAPI.getModels();
      setModels(loadedModels);
      setModelId(prev => {
        if (prev) return prev;
        const defaultModel = loadedModels.find(m => m.is_default);
        if (defaultModel) return defaultModel.id;
        if (loadedModels.length > 0) return loadedModels[0].id;
        return '';
      });
    } catch (error: unknown) {
      console.error('[EssayGrading] Failed to load models:', error);
      showGlobalNotification('error', t('essay_grading:errors.load_models_failed'));
    }
  }, []);

  // 加载批阅模式（提取为 useCallback 以便在保存后重新调用）
  const loadModes = useCallback(async () => {
    try {
      const loadedModes = await EssayGradingAPI.getGradingModes();
      setModes(loadedModes);
      if (loadedModes.length > 0 && !loadedModes.find(m => m.id === modeId)) {
        const practiceMode = loadedModes.find(m => m.id === 'practice');
        setModeId(practiceMode?.id || loadedModes[0].id);
      }
    } catch (error: unknown) {
      console.error('[EssayGrading] Failed to load modes:', error);
      showGlobalNotification('error', t('essay_grading:errors.load_modes_failed'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始加载批阅模式和模型列表
  useEffect(() => {
    loadModes();
    loadModels();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听配置变更，及时刷新模型列表
  // 'api_configurations_changed' — fired by SettingsPanel when API keys are saved.
  // 'model_assignments_changed' — fired by ModelAssignmentPanel when model assignments update.
  // TODO: Migrate to a centralised event hook/registry (e.g. useAppEvent or EventBus).
  useEffect(() => {
    const reload = () => { void loadModels(); };
    try {
      window.addEventListener('api_configurations_changed', reload as EventListener);
      window.addEventListener('model_assignments_changed', reload as EventListener);
    } catch {}
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', reload as EventListener);
        window.removeEventListener('model_assignments_changed', reload as EventListener);
      } catch {}
    };
  }, [loadModels]);

  // 加载自定义 Prompt
  useEffect(() => {
    if (initialSession?.customPrompt) return;
    const loadPrompt = async () => {
      try {
        const saved = await TauriAPI.getSetting('essay_grading.prompt');
        setCustomPrompt(saved || t('essay_grading:prompt_editor.default_prompt'));
      } catch (error: unknown) {
        console.error('[EssayGrading] Failed to load prompt:', error);
        setCustomPrompt(t('essay_grading:prompt_editor.default_prompt'));
      }
    };
    loadPrompt();
  }, [initialSession?.customPrompt, t]);

  // 从 DSTU 会话恢复状态
  useEffect(() => {
    if (initialSession) {
      // 从 DSTU 会话加载轮次数据
      const restoreFromDstu = async () => {
        try {
          // 获取会话基础信息
          const session = await EssayGradingAPI.getSession(initialSession.id);
          if (session) {
            setCurrentSession(session);
            await loadSessionRounds(session.id);
          }
        } catch (error: unknown) {
          console.error('[EssayGrading] Failed to restore from DSTU:', error);
        }
      };
      restoreFromDstu();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession?.id]);

  // ★ S-012: 草稿自动保存 ─ 防止关闭/刷新时丢失用户输入
  const effectiveSessionId = currentSession?.id || initialSession?.id;
  const draftKey = effectiveSessionId ? `essay_draft_${effectiveSessionId}` : 'essay_draft_new';

  // ★ S-012: debounce 保存草稿到 localStorage（1s）
  useEffect(() => {
    if (!inputText) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, inputText);
      } catch (e: unknown) {
        console.warn('[EssayGrading] S-012: Failed to save draft', e);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [inputText, draftKey]);

  // ★ S-012: 组件初始化时恢复草稿（仅在输入为空时）
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    const draft = localStorage.getItem(draftKey);
    if (draft && !inputText) {
      setInputText(draft);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // ★ S-012: 会话创建后迁移草稿 key（从 'new' 到真实 sessionId）
  useEffect(() => {
    if (currentSession?.id && !initialSession?.id) {
      const oldDraft = localStorage.getItem('essay_draft_new');
      if (oldDraft) {
        try {
          localStorage.setItem(`essay_draft_${currentSession.id}`, oldDraft);
          localStorage.removeItem('essay_draft_new');
        } catch (e: unknown) {
          console.warn('[EssayGrading] S-012: Failed to migrate draft key', e);
        }
      }
    }
  }, [currentSession?.id, initialSession?.id]);

  // 加载会话轮次
  const loadSessionRounds = useCallback(async (sessionId: string) => {
    try {
      const sessionRounds = await EssayGradingAPI.getRounds(sessionId);
      setRounds(sessionRounds);
      if (sessionRounds.length > 0) {
        // 显示最新轮次
        setCurrentRoundIndex(sessionRounds.length - 1);
        const latestRound = sessionRounds[sessionRounds.length - 1];
        setInputText(latestRound.input_text);
        gradingStream.setGradingResult(latestRound.grading_result);
        lastGradedInputRef.current = latestRound.input_text;
      }
    } catch (error: unknown) {
      console.error('[EssayGrading] Failed to load rounds:', error);
    }
  }, [gradingStream]);

  // 切换轮次
  const handlePrevRound = useCallback(() => {
    if (currentRoundIndex > 0) {
      const newIndex = currentRoundIndex - 1;
      setCurrentRoundIndex(newIndex);
      const round = rounds[newIndex];
      setInputText(round.input_text);
      gradingStream.setGradingResult(round.grading_result);
      lastGradedInputRef.current = round.input_text;
    }
  }, [currentRoundIndex, rounds, gradingStream]);

  const handleNextRound = useCallback(() => {
    if (currentRoundIndex < rounds.length - 1) {
      const newIndex = currentRoundIndex + 1;
      setCurrentRoundIndex(newIndex);
      const round = rounds[newIndex];
      setInputText(round.input_text);
      gradingStream.setGradingResult(round.grading_result);
      lastGradedInputRef.current = round.input_text;
    }
  }, [currentRoundIndex, rounds, gradingStream]);

  // ★ OCR 版本计数器（用于时序控制，防止旧请求覆盖新结果）
  const ocrVersionRef = useRef(0);
  // ★ 活跃图片 ID 集合（同步可读，用于 async 回调中判断图片是否已被删除）
  const activeImageIdsRef = useRef(new Set<string>());

  // ★ 文件拖拽处理（两阶段：即时显示缩略图 + 异步 OCR）
  const handleFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    // 筛选出图片文件
    const imageFiles = files.filter(file => 
      file.name.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)
    );

    // 限制总图片数（已有 + 新上传）
    const remainingSlots = OCR_MAX_FILES - uploadedImages.length;
    if (remainingSlots <= 0) {
      showGlobalNotification('warning', t('essay_grading:toast.max_images_reached', { max: OCR_MAX_FILES }));
      return;
    }
    const limitedFiles = imageFiles.slice(0, remainingSlots);
    if (limitedFiles.length === 0) return;

    // ── 阶段 1：立即读取 base64 并显示缩略图（ocrStatus=pending） ──
    const readPromises = limitedFiles.map(file =>
      new Promise<UploadedImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          const base64Content = dataUrl.split(',')[1];
          const version = ++ocrVersionRef.current;
          resolve({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            fileName: file.name,
            base64: base64Content,
            ocrText: '',
            dataUrl,
            ocrStatus: 'pending',
            ocrVersion: version,
          });
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      })
    );

    let pendingImages: UploadedImage[];
    try {
      pendingImages = await Promise.all(readPromises);
    } catch {
      showGlobalNotification('error', t('essay_grading:toast.ocr_failed', { error: 'File read error' }));
      return;
    }

    // 立即添加到状态 → 缩略图即时可见
    pendingImages.forEach(img => activeImageIdsRef.current.add(img.id));
    setUploadedImages(prev => [...prev, ...pendingImages]);
    showGlobalNotification('info', t('essay_grading:toast.ocr_processing'));

    // ── 阶段 2：异步 OCR（并发限制 = 2，逐张完成立即回填，超时/失败自动重试 1 次） ──
    const OCR_CONCURRENCY = 2;
    const OCR_MAX_RETRIES = 1;
    const OCR_RETRY_DELAY_MS = 3000;
    let running = 0;
    let idx = 0;
    const queue = [...pendingImages];

    /** 对单张图片执行 OCR（含自动重试） */
    const executeOcrForImage = (img: UploadedImage, retryCount: number): void => {
      // 标记状态
      const statusLabel: OcrStatus = retryCount > 0 ? 'retrying' : 'processing';
      setUploadedImages(prev =>
        prev.map(p => p.id === img.id ? { ...p, ocrStatus: statusLabel, ocrRetryCount: retryCount } : p)
      );

      const capturedVersion = img.ocrVersion!;
      // ★ JS finally 总会执行，用 flag 区分"重试接管"和"真正结束"
      let scheduledRetry = false;

      ocrExtractText({ imageBase64: img.base64 })
        .then(text => {
          // ★ 时序控制：通过 ref 同步检查图片是否仍活跃（未被用户删除）
          if (!activeImageIdsRef.current.has(img.id)) return;
          setUploadedImages(prev => {
            const existing = prev.find(p => p.id === img.id);
            if (!existing || existing.ocrVersion !== capturedVersion) return prev; // stale
            return prev.map(p =>
              p.id === img.id ? { ...p, ocrText: text, ocrStatus: 'done' as OcrStatus } : p
            );
          });
          if (text.trim()) {
            setInputText(prev => prev ? `${prev}\n\n${text}` : text);
          }
        })
        .catch((err: unknown) => {
          if (!activeImageIdsRef.current.has(img.id)) return;
          const msg = getErrorMessage(err);
          const isTimeout = msg === 'OCR_TIMEOUT';

          // ★ 超时或失败且未达重试上限 → 延迟自动重试
          if (retryCount < OCR_MAX_RETRIES) {
            scheduledRetry = true;
            setUploadedImages(prev =>
              prev.map(p => p.id === img.id
                ? { ...p, ocrStatus: 'retrying' as OcrStatus, ocrError: msg, ocrRetryCount: retryCount + 1 }
                : p
              )
            );
            setTimeout(() => {
              if (!activeImageIdsRef.current.has(img.id)) {
                running--;
                processNext();
                return;
              }
              executeOcrForImage(img, retryCount + 1);
            }, OCR_RETRY_DELAY_MS);
            return;
          }

          // 重试耗尽，标记最终失败
          setUploadedImages(prev => {
            const existing = prev.find(p => p.id === img.id);
            if (!existing || existing.ocrVersion !== capturedVersion) return prev;
            return prev.map(p =>
              p.id === img.id
                ? { ...p, ocrStatus: (isTimeout ? 'timeout' : 'error') as OcrStatus, ocrError: msg }
                : p
            );
          });
          if (isTimeout) {
            showGlobalNotification('warning', t('essay_grading:toast.ocr_timeout', { fileName: img.fileName }));
          } else {
            showGlobalNotification('error', t('essay_grading:toast.ocr_failed', { error: msg }));
          }
        })
        .finally(() => {
          if (scheduledRetry) return; // 重试接管，不释放并发槽位
          running--;
          processNext();
        });
    };

    const processNext = (): void => {
      while (running < OCR_CONCURRENCY && idx < queue.length) {
        const img = queue[idx++];
        running++;
        executeOcrForImage(img, 0);
      }
    };

    processNext();
  }, [t, uploadedImages.length]);

  // 删除单张上传图片
  const handleRemoveImage = useCallback((imageId: string) => {
    activeImageIdsRef.current.delete(imageId); // ★ 同步标记删除，OCR 回调可立即感知
    setUploadedImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // ★ 题目参考材料图片上传处理
  const handleTopicFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const imageFiles = files.filter(file =>
      file.name.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)
    );
    const remainingSlots = OCR_MAX_FILES - topicImages.length;
    if (remainingSlots <= 0) {
      showGlobalNotification('warning', t('essay_grading:toast.max_images_reached', { max: OCR_MAX_FILES }));
      return;
    }
    const limitedFiles = imageFiles.slice(0, remainingSlots);
    if (limitedFiles.length === 0) return;

    try {
      const processPromises = limitedFiles.map(file => {
        return new Promise<UploadedImage>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async (e) => {
            try {
              const dataUrl = e.target?.result as string;
              const base64Content = dataUrl.split(',')[1];
              resolve({
                id: `topic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                fileName: file.name,
                base64: base64Content,
                ocrText: '',
                dataUrl,
              });
            } catch (error: unknown) {
              reject(error);
            }
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });
      });
      const newImages = await Promise.all(processPromises);
      setTopicImages(prev => [...prev, ...newImages]);
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [t, topicImages.length]);

  // 删除题目参考图片
  const handleRemoveTopicImage = useCallback((imageId: string) => {
    setTopicImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // 开始批改
  const handleGrade = useCallback(async () => {
    // ★ M-052: 离线时阻止批改并提示用户
    if (!navigator.onLine) {
      showGlobalNotification('warning', t('essay_grading:errors.offline'));
      return;
    }

    if (isGrading) {
      console.warn('[EssayGrading] Grading in progress');
      return;
    }

    const safeInputText = inputText ?? '';
    if (!safeInputText.trim()) {
      showGlobalNotification('warning', t('essay_grading:errors.empty_text'));
      return;
    }

    try {
      // 如果没有会话 ID，先创建（仅用于非 DSTU 场景）
      let session = currentSession;
      let sessionId = session?.id ?? initialSession?.id;
      if (!sessionId) {
        // 智能生成标题：从作文内容提取前缀 + 日期时间
        const now = new Date();
        const dateStr = now.toLocaleDateString();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // 从作文内容提取前 20 个字符作为标题前缀（去除换行和多余空格）
        const contentPreview = safeInputText
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 20);
        
        const title = contentPreview
          ? `${contentPreview}${contentPreview.length >= 20 ? '...' : ''} (${dateStr} ${timeStr})`
          : t('essay_grading:session.default_title', { date: `${dateStr} ${timeStr}` });
        
        session = await EssayGradingAPI.createSession({
          title,
          essay_type: essayType,
          grade_level: gradeLevel,
          custom_prompt: customPrompt || undefined,
        });
        setCurrentSession(session);
        sessionId = session.id;
        showGlobalNotification('success', t('essay_grading:toast.session_created'));

        // ★ M-047 修复：新建 session 后将当前 modeId 持久化到 DSTU metadata
        essayDstuAdapter.updateSessionMeta(sessionId, { modeId }).catch(() => {
          console.warn('[EssayGrading] M-047: Failed to persist modeId after session creation');
        });
      }
      if (!sessionId) {
        throw new Error(t('essay_grading:errors.missing_session_id'));
      }

      // 获取上一轮的批改结果（如果有）
      const previousResult = rounds.length > 0 ? rounds[rounds.length - 1].grading_result : undefined;
      const previousInput = rounds.length > 0 ? rounds[rounds.length - 1].input_text : undefined;

      // 生成流式会话 ID
      const streamSessionId = `grading_${Date.now()}`;
      const nextRoundNumber = rounds.length + 1;

      // ★ 修复：立即更新 currentRoundIndex 指向新轮次，
      // 使流式期间 UI 显示正确的轮次号（rounds[rounds.length] 越界 → undefined → fallback 到 rounds.length + 1）
      setCurrentRoundIndex(rounds.length);

      // ★ 收集图片 base64 列表
      const imageBase64List = uploadedImages.length > 0
        ? uploadedImages.map(img => img.base64)
        : undefined;
      const topicImageBase64List = topicImages.length > 0
        ? topicImages.map(img => img.base64)
        : undefined;

      const outcome = await gradingStream.startGrading({
        session_id: sessionId,
        stream_session_id: streamSessionId,
        round_number: nextRoundNumber,
        input_text: safeInputText,
        topic: topicText.trim() || undefined,
        mode_id: modeId || undefined,
        model_config_id: modelId || undefined, // 空字符串会使用默认模型
        essay_type: essayType,
        grade_level: gradeLevel,
        custom_prompt: customPrompt || undefined,
        previous_result: previousResult,
        previous_input: previousInput,
        image_base64_list: imageBase64List,
        topic_image_base64_list: topicImageBase64List,
      });

      if (outcome === 'completed') {
        showGlobalNotification('success', t('essay_grading:toast.grading_success'));
        lastGradedInputRef.current = safeInputText;
        // ★ S-012: 批改完成后清除草稿
        try {
          localStorage.removeItem(`essay_draft_${sessionId}`);
          localStorage.removeItem('essay_draft_new');
        } catch {}
        // 刷新轮次
        await loadSessionRounds(sessionId);
        
        // DSTU 模式：通知 Learning Hub 新轮次已添加
        if (dstuMode.onRoundAdd) {
          const latestRounds = await EssayGradingAPI.getRounds(sessionId);
          const latestRound = latestRounds[latestRounds.length - 1];
          if (latestRound) {
            await dstuMode.onRoundAdd({
              id: latestRound.id,
              round_number: latestRound.round_number,
              input_text: latestRound.input_text,
              grading_result: latestRound.grading_result,
              overall_score: latestRound.overall_score,
              dimension_scores_json: latestRound.dimension_scores_json,
              created_at: new Date(latestRound.created_at).getTime(),
            });
          }
        }
        
        // DSTU 模式：保存会话状态
        if (dstuMode.onSessionSave) {
          const fullSessionResult = await essayDstuAdapter.getFullSession(sessionId);
          if (fullSessionResult.ok && fullSessionResult.value) {
            // ★ M-047 修复：使用当前本地 modeId，而非依赖 getFullSession 可能过期的值
            await dstuMode.onSessionSave({
              ...fullSessionResult.value,
              modeId,
            });
          }
        }
      } else if (outcome === 'cancelled') {
        showGlobalNotification('info', t('essay_grading:toast.grading_cancelled'));
      }
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      if (!errorMsg.includes(t('essay_grading:toast.grading_already'))) {
        showGlobalNotification('error', t('essay_grading:toast.grading_failed', { error: errorMsg }));
      }
    }
  }, [inputText, modeId, modelId, essayType, gradeLevel, customPrompt, currentSession, initialSession?.id, rounds, isGrading, t, gradingStream, loadSessionRounds, dstuMode, uploadedImages, topicImages, topicText]);

  // P1-19: 监听命令面板 LEARNING_GRADE_ESSAY 事件
  // 'LEARNING_GRADE_ESSAY' — dispatched by CommandPalette to trigger essay grading.
  // TODO: Migrate to a centralised event hook/registry (e.g. useAppEvent or EventBus).
  useEffect(() => {
    const handleGradeEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<{ targetResourceId?: string }>).detail;
      if (detail?.targetResourceId && dstuMode.resourceId && detail.targetResourceId !== dstuMode.resourceId) return;
      handleGrade();
    };
    window.addEventListener('LEARNING_GRADE_ESSAY', handleGradeEvent);
    return () => {
      window.removeEventListener('LEARNING_GRADE_ESSAY', handleGradeEvent);
    };
  }, [handleGrade, dstuMode.resourceId]);

  // P1-19: 监听命令面板 LEARNING_ESSAY_SUGGESTIONS 事件
  // 当用户请求改进建议时，如果已有批改结果则显示提示，否则触发批改
  // 'LEARNING_ESSAY_SUGGESTIONS' — dispatched by CommandPalette to request improvement suggestions.
  // TODO: Migrate to a centralised event hook/registry (e.g. useAppEvent or EventBus).
  useEffect(() => {
    const handleSuggestionsEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<{ targetResourceId?: string }>).detail;
      if (detail?.targetResourceId && dstuMode.resourceId && detail.targetResourceId !== dstuMode.resourceId) return;
      const currentText = inputText ?? '';
      const hasResultForInput = Boolean(gradingResult) && lastGradedInputRef.current === currentText;
      if (hasResultForInput) {
        showGlobalNotification('info', t('essay_grading:toast.suggestions_in_result'));
      } else {
        handleGrade();
      }
    };
    window.addEventListener('LEARNING_ESSAY_SUGGESTIONS', handleSuggestionsEvent);
    return () => {
      window.removeEventListener('LEARNING_ESSAY_SUGGESTIONS', handleSuggestionsEvent);
    };
  }, [gradingResult, handleGrade, inputText, t, dstuMode.resourceId]);

  const handleNextRoundSubmit = useCallback(() => {
    setShowNextRoundConfirm(true);
  }, []);

  const handleConfirmNextRound = useCallback(() => {
    setShowNextRoundConfirm(false);
    setInputText('');
    setUploadedImages([]);
    gradingStream.setGradingResult('');
    setCurrentRoundIndex(rounds.length);
  }, [rounds.length, gradingStream]);

  // 保存 Prompt
  const handleSavePrompt = useCallback(async () => {
    try {
      await TauriAPI.saveSetting('essay_grading.prompt', customPrompt);
      const targetSessionId = currentSession?.id ?? initialSession?.id;
      if (targetSessionId) {
        const updateResult = await essayDstuAdapter.updateSessionMeta(targetSessionId, {
          customPrompt,
        });
        if (!updateResult.ok) {
          showGlobalNotification('error', updateResult.error.toUserMessage());
        }
      }
      showGlobalNotification('success', t('essay_grading:prompt_editor.saved'));
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [customPrompt, currentSession?.id, initialSession?.id, t]);

  // 恢复默认 Prompt
  const handleRestoreDefaultPrompt = useCallback(() => {
    setCustomPrompt(t('essay_grading:prompt_editor.default_prompt'));
  }, [t]);

  // 历史管理函数已移除 - 由 Learning Hub 管理

  // 复制结果
  const handleCopyResult = useCallback(() => {
    copyTextToClipboard(gradingResult);
    showGlobalNotification('success', t('essay_grading:result_section.copied'));
  }, [gradingResult, t]);

  // 导出结果
  const handleExportResult = useCallback(async () => {
    const safeInput = inputText ?? '';
    const safeResult = gradingResult ?? '';
    const now = new Date();
    const dateStr = now.toLocaleString();
    const pad = (n: number) => String(n).padStart(2, '0');

    let content = `# ${t('essay_grading:page_title')}\n\n`;
    content += `> ${t('essay_grading:round.label', { number: currentRoundNumber })} | ${dateStr}\n\n`;
    
    // 动态导入 exportFormatter 以减小初始包体积
    try {
      const { formatGradingResultForExport } = await import('../essay-grading/exportFormatter');
      
      // 格式化原始内容
      content += `## ${t('essay_grading:input_section.title')}\n\n${safeInput}\n\n`;
      content += `## ${t('essay_grading:result_section.title')}\n\n`;
      content += formatGradingResultForExport(safeResult, safeInput);
      
      const defaultName = `essay_grading_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.md`;
      
      const result = await fileManager.saveTextFile({
        title: defaultName,
        defaultFileName: defaultName,
        content,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!result.canceled) {
        showGlobalNotification('success', t('essay_grading:result_section.exported'));
      }
    } catch (e) {
      console.error('[EssayGradingWorkbench] Export failed:', e);
      showGlobalNotification('error', t('essay_grading:errors.export_failed'));
    }
  }, [inputText, gradingResult, currentRoundNumber, t]);

  // 清空（有内容时弹出确认）
  const handleClear = useCallback(() => {
    const hasContent = (inputText ?? '').trim().length > 0 || (gradingResult ?? '').length > 0;
    if (!hasContent) return; // 没有内容，无需清空
    setShowClearConfirm(true);
  }, [inputText, gradingResult]);

  const handleConfirmClear = useCallback(() => {
    setShowClearConfirm(false);
    setInputText('');
    setUploadedImages([]);
    gradingStream.resetState();
  }, [gradingStream]);

  // 新建会话
  const handleNewSession = useCallback(() => {
    setCurrentSession(null);
    setRounds([]);
    setCurrentRoundIndex(0);
    setInputText('');
    setUploadedImages([]);
    setTopicText('');
    setTopicImages([]);
    gradingStream.resetState();
  }, [gradingStream]);

  // 字符统计（确保防护 undefined）
  const inputCharCount = (inputText ?? '').length;
  const resultCharCount = (gradingResult ?? '').length;

  return (
    <div className="w-full h-full flex-1 min-h-0 bg-[hsl(var(--background))] flex flex-col overflow-hidden">
      <MacTopSafeDragZone className="essay-grading-top-safe-drag-zone" />

      {/* Main Content - 始终显示批改界面 */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        <GradingMain
          inputText={inputText}
          setInputText={setInputText}
          modeId={modeId}
          setModeId={setModeId}
          modes={modes}
          modelId={modelId}
          setModelId={setModelId}
          models={models}
          essayType={essayType}
          setEssayType={setEssayType}
          gradeLevel={gradeLevel}
          setGradeLevel={setGradeLevel}
          isGrading={isGrading}
          onFilesDropped={handleFilesDropped}
            ocrMaxFiles={OCR_MAX_FILES}
          customPrompt={customPrompt}
          setCustomPrompt={setCustomPrompt}
          showPromptEditor={showPromptEditor}
          setShowPromptEditor={setShowPromptEditor}
          onSavePrompt={handleSavePrompt}
          onRestoreDefaultPrompt={handleRestoreDefaultPrompt}
          onClear={handleClear}
          onGrade={handleGrade}
          onCancelGrading={() => gradingStream.cancelGrading()}
          inputCharCount={inputCharCount}
          gradingResult={gradingResult}
          resultCharCount={resultCharCount}
          onCopyResult={handleCopyResult}
          onExportResult={handleExportResult}
          error={gradingStream.error}
          canRetry={gradingStream.canRetry}
          onRetry={() => gradingStream.retryGrading().catch(console.error)}
          isPartialResult={isPartialResult}
          currentRound={currentRoundNumber}
          hasResult={gradingResult.length > 0}
          onNextRound={handleNextRoundSubmit}
          uploadedImages={uploadedImages}
          onRemoveImage={handleRemoveImage}
          topicText={topicText}
          setTopicText={setTopicText}
          topicImages={topicImages}
          onTopicFilesDropped={handleTopicFilesDropped}
          onRemoveTopicImage={handleRemoveTopicImage}
          onModesChange={loadModes}
          roundNavigation={totalRounds > 0 ? {
            currentIndex: currentRoundIndex,
            total: totalRounds,
            onPrev: handlePrevRound,
            onNext: handleNextRound,
          } : undefined}
        />
      </div>

      <NotionAlertDialog
        open={showNextRoundConfirm}
        onOpenChange={setShowNextRoundConfirm}
        title={t('essay_grading:next_round_confirm.title')}
        description={t('essay_grading:next_round_confirm.message')}
        confirmText={t('essay_grading:next_round_confirm.confirm')}
        cancelText={t('common:cancel')}
        confirmVariant="primary"
        onConfirm={handleConfirmNextRound}
      />

      <NotionAlertDialog
        open={showClearConfirm}
        onOpenChange={setShowClearConfirm}
        title={t('essay_grading:clear_confirm.title')}
        description={t('essay_grading:clear_confirm.message')}
        confirmText={t('essay_grading:clear_confirm.confirm')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        onConfirm={handleConfirmClear}
      />
    </div>
  );
};

export default EssayGradingWorkbench;
