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
import { showGlobalNotification } from './UnifiedNotification';
import { CustomScrollArea } from './custom-scroll-area';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/shad/AlertDialog';

import { debugLog } from '../debug-panel/debugMasterSwitch';

// 子组件
import { GradingMain } from './essay-grading/GradingMain';
// GradingHistory 已移除 - 历史由 Learning Hub 管理

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const OCR_MAX_FILES = 5;

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

  // 监听全局顶栏的设置按钮点击事件（移动端）- 切换模式
  // TODO: Migrate 'essay:openSettings' to a centralised event hook/registry
  //       (e.g. useAppEvent or EventBus) so that the event source and consumer are
  //       co-located in a single registry rather than scattered across files.
  useEffect(() => {
    const handleToggleSettings = () => {
      setShowPromptEditor(prev => !prev);
    };
    window.addEventListener('essay:openSettings', handleToggleSettings);
    return () => {
      window.removeEventListener('essay:openSettings', handleToggleSettings);
    };
  }, []);

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

  // 文件拖拽处理（OCR）- 支持多图自动拼接
  const handleFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    // 筛选出图片文件
    const imageFiles = files.filter(file => 
      file.name.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)
    );

    const limitedFiles = imageFiles.slice(0, OCR_MAX_FILES);

    if (limitedFiles.length === 0) return;

    try {
      showGlobalNotification('info', t('essay_grading:toast.ocr_processing'));
      
      // 并行处理所有图片
      const ocrPromises = limitedFiles.map(file => {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async (e) => {
            try {
              const dataUrl = e.target?.result as string;
              const base64Content = dataUrl.split(',')[1];
              const extracted = await ocrExtractText({ imageBase64: base64Content });
              resolve(extracted);
            } catch (error: unknown) {
              reject(error);
            }
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });
      });

      const results = await Promise.all(ocrPromises);
      
      // 拼接所有 OCR 结果（用双换行分隔不同图片的内容）
      const combinedText = results
        .filter(text => text.trim())
        .join('\n\n');
      
      if (combinedText) {
        // 如果已有内容，追加到末尾
        setInputText(prev => prev ? `${prev}\n\n${combinedText}` : combinedText);
        showGlobalNotification('success', 
          limitedFiles.length > 1 
            ? t('essay_grading:toast.ocr_success_multi', { count: limitedFiles.length }) 
            : t('essay_grading:toast.ocr_success')
        );
      } else {
        showGlobalNotification('warning', t('essay_grading:toast.ocr_empty'));
      }
    } catch (error: unknown) {
      showGlobalNotification('error', t('essay_grading:toast.ocr_failed', { error: getErrorMessage(error) }));
    }
  }, [t]);

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

      const outcome = await gradingStream.startGrading({
        session_id: sessionId,
        stream_session_id: streamSessionId,
        round_number: nextRoundNumber,
        input_text: safeInputText,
        topic: undefined, // TODO: 添加题干输入
        mode_id: modeId || undefined,
        model_config_id: modelId || undefined, // 空字符串会使用默认模型
        essay_type: essayType,
        grade_level: gradeLevel,
        custom_prompt: customPrompt || undefined,
        previous_result: previousResult,
        previous_input: previousInput,
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
  }, [inputText, modeId, modelId, essayType, gradeLevel, customPrompt, currentSession, initialSession?.id, rounds, isGrading, t, gradingStream, loadSessionRounds, dstuMode]);

  // P1-19: 监听命令面板 LEARNING_GRADE_ESSAY 事件
  // 'LEARNING_GRADE_ESSAY' — dispatched by CommandPalette to trigger essay grading.
  // TODO: Migrate to a centralised event hook/registry (e.g. useAppEvent or EventBus).
  useEffect(() => {
    const handleGradeEvent = () => {
      handleGrade();
    };
    window.addEventListener('LEARNING_GRADE_ESSAY', handleGradeEvent);
    return () => {
      window.removeEventListener('LEARNING_GRADE_ESSAY', handleGradeEvent);
    };
  }, [handleGrade]);

  // P1-19: 监听命令面板 LEARNING_ESSAY_SUGGESTIONS 事件
  // 当用户请求改进建议时，如果已有批改结果则显示提示，否则触发批改
  // 'LEARNING_ESSAY_SUGGESTIONS' — dispatched by CommandPalette to request improvement suggestions.
  // TODO: Migrate to a centralised event hook/registry (e.g. useAppEvent or EventBus).
  useEffect(() => {
    const handleSuggestionsEvent = () => {
      const currentText = inputText ?? '';
      const hasResultForInput = Boolean(gradingResult) && lastGradedInputRef.current === currentText;
      if (hasResultForInput) {
        showGlobalNotification('info', t('essay_grading:toast.suggestions_in_result'));
      } else {
        // 如果没有批改结果，先进行批改
        handleGrade();
      }
    };
    window.addEventListener('LEARNING_ESSAY_SUGGESTIONS', handleSuggestionsEvent);
    return () => {
      window.removeEventListener('LEARNING_ESSAY_SUGGESTIONS', handleSuggestionsEvent);
    };
  }, [gradingResult, handleGrade, inputText, t]);

  const handleNextRoundSubmit = useCallback(() => {
    setShowNextRoundConfirm(true);
  }, []);

  const handleConfirmNextRound = useCallback(() => {
    setShowNextRoundConfirm(false);
    setInputText('');
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
    navigator.clipboard.writeText(gradingResult);
    showGlobalNotification('success', t('essay_grading:result_section.copied'));
  }, [gradingResult, t]);

  // 导出结果
  const handleExportResult = useCallback(() => {
    const safeInput = inputText ?? '';
    const safeResult = gradingResult ?? '';
    const now = new Date();
    const dateStr = now.toLocaleString();
    const pad = (n: number) => String(n).padStart(2, '0');

    let content = `# ${t('essay_grading:page_title')}\n\n`;
    content += `> ${t('essay_grading:round.label', { number: currentRoundNumber })} | ${dateStr}\n\n`;
    content += `## ${t('essay_grading:input_section.title')}\n\n${safeInput}\n\n`;
    content += `## ${t('essay_grading:result_section.title')}\n\n${safeResult}\n`;

    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `essay_grading_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showGlobalNotification('success', t('essay_grading:result_section.exported'));
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
    gradingStream.resetState();
  }, [gradingStream]);

  // 新建会话
  const handleNewSession = useCallback(() => {
    setCurrentSession(null);
    setRounds([]);
    setCurrentRoundIndex(0);
    setInputText('');
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
          onModesChange={loadModes}
          roundNavigation={totalRounds > 0 ? {
            currentIndex: currentRoundIndex,
            total: totalRounds,
            onPrev: handlePrevRound,
            onNext: handleNextRound,
          } : undefined}
        />
      </div>

      <AlertDialog open={showNextRoundConfirm} onOpenChange={setShowNextRoundConfirm}>
        <AlertDialogContent className="border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-medium">{t('essay_grading:next_round_confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              {t('essay_grading:next_round_confirm.message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="border-border/50 hover:bg-muted/50">{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmNextRound}
              className="bg-primary hover:bg-primary/90"
            >
              {t('essay_grading:next_round_confirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent className="border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-medium">{t('essay_grading:clear_confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              {t('essay_grading:clear_confirm.message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="border-border/50 hover:bg-muted/50">{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmClear}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {t('essay_grading:clear_confirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default EssayGradingWorkbench;
