import React, { useState, useCallback, useEffect, useMemo, useRef, useDeferredValue } from 'react';
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
  type EssayDstuModeConfig,
} from '@/dstu/adapters/essayDstuAdapter';
import { useEssayGradingStream } from '../essay-grading/useEssayGradingStream';
import {
  applyAnchoredReplacement,
  type SuggestionChange,
} from '../essay-grading/suggestionAnchors';
import {
  essayDirtySnapshot,
  essayGradedSnapshot,
  essaySessionContextKey,
  evaluateRoundSwitch,
  fromPersistedImages,
  parseSessionContext,
  serializeSessionContext,
  type EssayContentState,
  type EssayGradingConfig,
} from '../essay-grading/essayContentState';
import { appendOcrPlaceholders, fillOcrPlaceholder } from '../essay-grading/ocrPlaceholders';
import { ocrExtractText, TauriAPI } from '../utils/tauriApi';
import { getErrorMessage } from '../utils/errorUtils';
import { fileManager } from '../utils/fileManager';
import { showGlobalNotification } from './UnifiedNotification';
import { useSaveAsNoteFlow, SaveAsNoteFolderPicker } from '@/shared/notes';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';

import { useEventRegistry } from '@/hooks/useEventRegistry';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { calculateEssayTextStats } from '@/essay-grading/textStats';

// 子组件
import { GradingMain } from './essay-grading/GradingMain';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { ESSAY_MAX_CHARS } from './essay-grading/InputPanel';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import {
  registerContentDirtyChecker,
  registerContentSaveHandler,
} from '@/features/workbench/apps/content/contentDirtyRegistry';
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

/** 批改配置上下文（内容之外影响批改结果的参数 + 题目/图片） */
interface GradingContext extends EssayGradingConfig {
  topicText: string;
  uploadedImages: UploadedImage[];
  topicImages: UploadedImage[];
}

/** "已批改内容"快照的便捷封装（内容 + 批改配置） */
function gradedSnapshotOf(inputText: string, context: GradingContext): string {
  return essayGradedSnapshot(
    {
      inputText,
      topicText: context.topicText,
      uploadedImages: context.uploadedImages,
      topicImages: context.topicImages,
    },
    context
  );
}

interface EssayGradingWorkbenchProps {
  onBack?: () => void;
  /** DSTU 模式配置（必需），由 Learning Hub 管理会话 */
  dstuMode: EssayDstuModeConfig;
  /** ★ A6-29 标签页：当前是否为活跃标签页；非活跃实例不响应全局快捷键 */
  isActive?: boolean;
  /** OS 应用宿主已提供侧边栏设置入口；设置作为完整内容页显示 */
  externalSettingsNavigation?: boolean;
  /** OS 宿主设置标签的受控选中状态 */
  externalSettingsOpen?: boolean;
}

export const EssayGradingWorkbench: React.FC<EssayGradingWorkbenchProps> = ({
  dstuMode,
  isActive,
  externalSettingsNavigation = false,
  externalSettingsOpen,
}) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  // 流式批改管线
  const gradingStream = useEssayGradingStream();
  // ★ 解构出稳定的函数引用（hook 内部均为 useCallback），
  // 避免下游 useCallback 依赖整个 gradingStream 对象（每次渲染都是新对象）导致回调频繁重建
  const {
    startGrading,
    cancelGrading,
    retryGrading,
    resetState: resetGradingState,
    setGradingResult,
  } = gradingStream;

  // DSTU 模式：从会话初始化状态
  const initialSession = dstuMode.session;

  // 会话状态
  const [currentSession, setCurrentSession] = useState<GradingSession | null>(null);
  const [rounds, setRounds] = useState<GradingRound[]>([]);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0); // 当前显示的轮次索引

  // 输入状态（从 DSTU 初始化，确保默认值防止 undefined）
  const [inputText, setInputText] = useState(initialSession?.inputText ?? '');
  const [essayType, setEssayTypeRaw] = useState(initialSession?.essayType || 'other');
  const [gradeLevel, setGradeLevelRaw] = useState(initialSession?.gradeLevel || 'high_school');
  const [customPrompt, setCustomPrompt] = useState(initialSession?.customPrompt ?? '');
  // 设置面板显隐的单一来源（所有断点共用；essay:openSettings 事件 toggle 它）
  // 外部设置标签可能早于懒加载工作台被点击；直接以宿主状态初始化，
  // 避免挂载后再双向 effect 同步造成 settingsVisibility 真假振荡。
  const [showPromptEditor, setShowPromptEditor] = useState(
    () => externalSettingsNavigation && externalSettingsOpen === true,
  );
  const lastGradedInputRef = useRef<string>('');
  // ★ 上一轮已批改内容的完整快照（正文 + 题目 + 图片），用于"未修改不允许新轮次"判定
  const lastGradedSnapshotRef = useRef<string>('');
  const draftRestoredRef = useRef(false);
  // ★ 挂载时从 localStorage 恢复的草稿内容；DSTU 会话异步恢复完成后据此让草稿（更新的未保存编辑）优先于轮次正文
  const restoredDraftRef = useRef<{ inputText: string; topicText: string } | null>(null);

  // 包装 setEssayType / setGradeLevel：用户修改时持久化到全局设置（启动时恢复）
  const setEssayType = useCallback((type: string) => {
    setEssayTypeRaw(type);
    TauriAPI.saveSetting('essay_grading.essay_type', type).catch(() => {
      console.warn('[EssayGrading] Failed to persist essayType');
    });
  }, []);
  const setGradeLevel = useCallback((level: string) => {
    setGradeLevelRaw(level);
    TauriAPI.saveSetting('essay_grading.grade_level', level).catch(() => {
      console.warn('[EssayGrading] Failed to persist gradeLevel');
    });
  }, []);

  // 启动时恢复持久化的 essayType / gradeLevel（仅在会话未提供时）
  useEffect(() => {
    if (initialSession?.essayType) return;
    let cancelled = false;
    TauriAPI.getSetting('essay_grading.essay_type')
      .then(saved => {
        if (!cancelled && saved) setEssayTypeRaw(saved);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [initialSession?.essayType]);
  useEffect(() => {
    if (initialSession?.gradeLevel) return;
    let cancelled = false;
    TauriAPI.getSetting('essay_grading.grade_level')
      .then(saved => {
        if (!cancelled && saved) setGradeLevelRaw(saved);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [initialSession?.gradeLevel]);

  // ★ 图片存储状态（保存原图用于预览和多模态批改）
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  // 同步镜像：供稳定引用的回调（如单图 OCR 重试）读取最新图片列表
  const uploadedImagesRef = useRef(uploadedImages);
  uploadedImagesRef.current = uploadedImages;
  // ★ 题目元数据状态（作文题目/要求/参考材料）
  const [topicText, setTopicText] = useState('');
  const [topicImages, setTopicImages] = useState<UploadedImage[]>([]);

  // ★ 已持久化内容基准（正文 + 题目 + 图片）。保存为结构化对象而非快照字符串，
  // 使回看轮次时可以只修正正文基准，而不吞掉题目/图片的未保存修改。
  const persistedBaselineRef = useRef<EssayContentState>({
    inputText: initialSession?.inputText ?? '',
    topicText: '',
    uploadedImages: [],
    topicImages: [],
  });
  const persistedDirtySnapshotRef = useRef(essayDirtySnapshot(persistedBaselineRef.current));
  const patchPersistedBaseline = useCallback((patch: Partial<EssayContentState>) => {
    persistedBaselineRef.current = { ...persistedBaselineRef.current, ...patch };
    persistedDirtySnapshotRef.current = essayDirtySnapshot(persistedBaselineRef.current);
  }, []);

  const currentDirtySnapshotRef = useRef(persistedDirtySnapshotRef.current);
  currentDirtySnapshotRef.current = essayDirtySnapshot({
    inputText,
    topicText,
    uploadedImages,
    topicImages,
  });

  // ★ 仅在会话 id 变化（真正换会话）时重置脏基准。父级刷新 initialSession 对象
  // （如保存回写后）身份变化不应把基准重置回空题目/空图片，否则已批改落盘的
  // 题目/图片会被误判为未保存修改（restoreFromDstu 会按恢复结果再修正基准）。
  useEffect(() => {
    patchPersistedBaseline({
      inputText: initialSession?.inputText ?? '',
      topicText: '',
      uploadedImages: [],
      topicImages: [],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession?.id, patchPersistedBaseline]);

  useEffect(() => {
    const resourceId = dstuMode.resourceId ?? initialSession?.id;
    if (!resourceId) return;
    return registerContentDirtyChecker('essay', resourceId, () =>
      currentDirtySnapshotRef.current !== persistedDirtySnapshotRef.current
    );
  }, [dstuMode.resourceId, initialSession?.id]);

  // 监听全局顶栏的设置按钮点击事件（移动端）- 切换模式
  // TODO: Migrate 'essay:openSettings' to a centralised event hook/registry
  //       (e.g. useAppEvent or EventBus) so that the event source and consumer are
  //       co-located in a single registry rather than scattered across files.
  useEffect(() => {
    const handleToggleSettings = (evt: Event) => {
      // ★ 标签页：检查 targetResourceId 是否匹配（无 targetResourceId 时兼容旧调用）
      const detail = (evt as CustomEvent<{ targetResourceId?: string; open?: boolean }>).detail;
      if (detail?.targetResourceId && dstuMode.resourceId && detail.targetResourceId !== dstuMode.resourceId) {
        return;
      }
      setShowPromptEditor(prev => typeof detail?.open === 'boolean' ? detail.open : !prev);
    };
    window.addEventListener('essay:openSettings', handleToggleSettings);
    return () => {
      window.removeEventListener('essay:openSettings', handleToggleSettings);
    };
  }, [dstuMode.resourceId]);

  // 向宿主（资源工作区侧边栏的"批改设置"标签）回报设置页开合状态，
  // 使侧边栏入口能正确渲染选中态
  useEffect(() => {
    const resourceId = dstuMode.resourceId;
    if (!resourceId) return;
    window.dispatchEvent(new CustomEvent('essay:settingsVisibility', {
      detail: { resourceId, open: showPromptEditor },
    }));
  }, [showPromptEditor, dstuMode.resourceId]);

  // 批阅模式状态
  const [modes, setModes] = useState<GradingMode[]>([]);
  const [modeId, setModeIdRaw] = useState(
    initialSession?.modeId ? canonicalizeEssayModeId(initialSession.modeId) : 'practice'
  ); // 默认使用日常练习模式

  // 包装 setModeId：每次切换模式时持久化到全局设置
  const setModeId = useCallback((id: string) => {
    setModeIdRaw(id);
    TauriAPI.saveSetting('essay_grading.mode_id', id).catch(() => {
      console.warn('[EssayGrading] Failed to persist modeId');
    });
  }, []);

  // 模型选择状态
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelIdRaw] = useState(''); // 空字符串表示使用默认模型

  // 包装 setModelId：用户切换模型时持久化到全局设置（启动时经 loadModels 校验恢复）
  const setModelId = useCallback((id: string) => {
    setModelIdRaw(id);
    TauriAPI.saveSetting('essay_grading.model_id', id).catch(() => {
      console.warn('[EssayGrading] Failed to persist modelId');
    });
  }, []);

  // 历史状态已移除 - 由 Learning Hub 管理

  const gradingResult = gradingStream.gradingResult ?? '';
  const isGrading = gradingStream.isGrading ?? false;
  const isPartialResult = gradingStream.isPartialResult ?? false;

  // ★ 当前批改配置上下文的实时镜像（每次渲染同步），供异步回调同步读取，
  // 避免恢复/轮次加载/批改收尾直接依赖大量状态导致回调不稳定
  const gradingContextRef = useRef<GradingContext>({
    topicText,
    uploadedImages,
    topicImages,
    modeId,
    modelId,
    essayType,
    gradeLevel,
    customPrompt,
  });
  gradingContextRef.current = {
    topicText,
    uploadedImages,
    topicImages,
    modeId,
    modelId,
    essayType,
    gradeLevel,
    customPrompt,
  };

  // ★ 最新状态的同步镜像：供全局事件监听器/异步回调读取，
  // 避免监听器闭包依赖 inputText/gradingResult/isGrading 导致每次击键都重建并重挂监听
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;
  const gradingResultRef = useRef(gradingResult);
  gradingResultRef.current = gradingResult;
  const isGradingRef = useRef(isGrading);
  isGradingRef.current = isGrading;

  // 当前轮次
  const currentRound = rounds[currentRoundIndex];
  const currentRoundNumber = currentRound?.round_number ?? (rounds.length + 1);
  const totalRounds = rounds.length;

  // 加载模型列表（并恢复持久化的模型选择；已被删除的模型回落到默认模型）
  const loadModels = useCallback(async () => {
    try {
      const loadedModels = await EssayGradingAPI.getModels();
      setModels(loadedModels);
      let savedModelId: string | null = null;
      try {
        savedModelId = await TauriAPI.getSetting('essay_grading.model_id');
      } catch {}
      setModelIdRaw(prev => {
        // 当前选择仍有效则保持；否则依次尝试持久化值 → 默认模型 → 第一个模型
        if (prev && loadedModels.some(m => m.id === prev)) return prev;
        if (savedModelId && loadedModels.some(m => m.id === savedModelId)) return savedModelId;
        const defaultModel = loadedModels.find(m => m.is_default);
        if (defaultModel) return defaultModel.id;
        if (loadedModels.length > 0) return loadedModels[0].id;
        return '';
      });
    } catch (error: unknown) {
      console.error('[EssayGrading] Failed to load models:', error);
      showGlobalNotification('error', t('essay_grading:errors.load_models_failed'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载批阅模式（提取为 useCallback 以便在保存后重新调用）
  const loadModes = useCallback(async () => {
    try {
      const loadedModes = await EssayGradingAPI.getGradingModes();
      setModes(loadedModes);

      // 确定最佳 modeId：initialSession > 持久化设置 > practice > 第一个
      setModeIdRaw(prev => {
        if (loadedModes.find(m => m.id === prev)) return prev;
        const practiceMode = loadedModes.find(m => m.id === 'practice');
        return practiceMode?.id || (loadedModes.length > 0 ? loadedModes[0].id : prev);
      });
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

  // 加载持久化的批阅模式（仅在无 initialSession.modeId 时）
  // ★ 修复：持久化值同样需要经 canonicalizeEssayModeId 归一（旧版本可能存过别名 ID）
  useEffect(() => {
    if (initialSession?.modeId) return;
    const loadMode = async () => {
      try {
        const saved = await TauriAPI.getSetting('essay_grading.mode_id');
        if (saved) setModeIdRaw(canonicalizeEssayModeId(saved));
      } catch {}
    };
    loadMode();
  }, [initialSession?.modeId]);

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
            const restoredText = await loadSessionRounds(session.id);

            // ★ 恢复题目与图片（批改完成时随会话持久化到 settings KV，重开可恢复）
            let restoredContext: ReturnType<typeof parseSessionContext> = null;
            try {
              restoredContext = parseSessionContext(
                await TauriAPI.getSetting(essaySessionContextKey(session.id))
              );
            } catch {
              // 读取失败按无持久化上下文处理
            }
            const restoredTopic = restoredContext?.topicText ?? '';
            const restoredUploaded = fromPersistedImages(restoredContext?.uploadedImages);
            const restoredTopicImages = fromPersistedImages(restoredContext?.topicImages);
            if (restoredTopic) {
              // 草稿里的题目是更新的未保存编辑，优先于会话持久化值
              setTopicText(prev => prev || restoredTopic);
            }
            if (restoredUploaded.length > 0 && uploadedImagesRef.current.length === 0) {
              // 恢复的图片登记为活跃：数量上限判定与删除/重试回调依赖该集合
              restoredUploaded.forEach(img => activeImageIdsRef.current.add(img.id));
              setUploadedImages(restoredUploaded);
            }
            if (restoredTopicImages.length > 0) {
              setTopicImages(prev => (prev.length > 0 ? prev : restoredTopicImages));
            }

            // ★ 修正脏检查基准：恢复后的持久化状态 = 最新轮次正文 + 已保存的题目/图片，
            // 否则从会话恢复后会被误判为"有未保存修改"
            patchPersistedBaseline({
              inputText: restoredText ?? (initialSession.inputText ?? ''),
              topicText: restoredTopic,
              uploadedImages: restoredUploaded,
              topicImages: restoredTopicImages,
            });
            // loadSessionRounds 先于会话上下文恢复完成；此处用已恢复的题目/图片
            // 重建“上一轮已批改”快照，避免重开后未改内容也能误提交重复轮次。
            if (restoredText !== null) {
              lastGradedInputRef.current = restoredText;
              lastGradedSnapshotRef.current = gradedSnapshotOf(restoredText, {
                ...gradingContextRef.current,
                topicText: restoredTopic,
                uploadedImages: restoredUploaded,
                topicImages: restoredTopicImages,
              });
            }
            // ★ 草稿优先：挂载时恢复的草稿是比最后一轮更新的未保存编辑，
            // 不应被 loadSessionRounds 回填的轮次正文覆盖
            const draft = restoredDraftRef.current;
            if (draft?.inputText && draft.inputText !== restoredText) {
              setInputText(draft.inputText);
            }
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
  // 草稿为 JSON 结构 {inputText, topicText}（图片 base64 体积过大，不进草稿）
  // 恢复完成前不写入/删除，避免挂载初期把待恢复的草稿冲掉
  // ★ 回看轮次时正文等于已批改轮次文本，不属于未保存编辑：不把旧轮次正文写进
  // 草稿（否则下次打开会被当作「未保存修改」覆盖最新轮次正文）
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    const timer = setTimeout(() => {
      const draftInputText = inputText === lastGradedInputRef.current ? '' : inputText;
      try {
        if (!draftInputText && !topicText) {
          // 无未保存内容（用户主动清空 / 正文与轮次一致）时移除草稿，
          // 防止下次进入被"恢复"回已删除或已批改的内容
          localStorage.removeItem(draftKey);
        } else {
          localStorage.setItem(draftKey, JSON.stringify({ inputText: draftInputText, topicText }));
        }
      } catch (e: unknown) {
        console.warn('[EssayGrading] S-012: Failed to save draft', e);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [inputText, topicText, draftKey]);

  // ★ S-012: 组件初始化时恢复草稿（仅在对应输入为空时；兼容旧版纯文本草稿）
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    const raw = localStorage.getItem(draftKey);
    if (!raw) return;
    let draftText = raw;
    let draftTopic = '';
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as { inputText?: unknown; topicText?: unknown };
        draftText = typeof record.inputText === 'string' ? record.inputText : '';
        draftTopic = typeof record.topicText === 'string' ? record.topicText : '';
      }
    } catch {
      // 旧格式：整个值即正文文本
    }
    const applyText = Boolean(draftText && !inputText);
    if (applyText) setInputText(draftText);
    if (draftTopic) setTopicText(prev => prev || draftTopic);
    if (applyText || draftTopic) {
      restoredDraftRef.current = { inputText: applyText ? draftText : '', topicText: draftTopic };
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

  // 「保存并关闭」挂点（照抄翻译 saveCurrentSessionRef 范式：闭包经 ref 每帧更新，
  // 注册保持稳定）。作文正文没有轮次之外的落盘 API（正文只随批改轮次持久化，
  // dstuMode.onSessionSave 也只写元数据，不自造第二套 DSTU 写入），故复用两条
  // 现有等价落盘路径：
  //  1) 题目/图片 → 会话上下文 KV（与批改收尾同一路径，restoreFromDstu 可恢复）
  //  2) 正文/题目 → S-012 草稿同步写入（跳过 debounce；重开时草稿优先于轮次正文恢复）
  // 正文仅有草稿级持久化，基准只回写已真正落盘的题目/图片；正文继续如实呈 dirty。
  const saveCurrentContentRef = useRef<() => Promise<void>>(async () => undefined);
  saveCurrentContentRef.current = async () => {
    const sessionId = currentSession?.id || initialSession?.id;
    if (sessionId) {
      await TauriAPI.saveSetting(
        essaySessionContextKey(sessionId),
        serializeSessionContext({ topicText, uploadedImages, topicImages })
      );
      patchPersistedBaseline({ topicText, uploadedImages, topicImages });
    } else if (uploadedImages.length > 0 || topicImages.length > 0) {
      // 无会话 id 时图片没有任何落盘路径：抛错让 saveContentNow 报失败、窗口保持打开
      throw new Error('[EssayGrading] cannot persist images without a session id');
    }
    // 与 S-012 debounce 写入同一格式/同一键；回看已批改轮次的正文不算未保存编辑。
    // localStorage 写入失败（配额等）向上抛出：保存失败不放行关闭。
    const draftInputText = inputText === lastGradedInputRef.current ? '' : inputText;
    if (!draftInputText && !topicText) {
      localStorage.removeItem(draftKey);
    } else {
      localStorage.setItem(draftKey, JSON.stringify({ inputText: draftInputText, topicText }));
    }
  };

  useEffect(() => {
    const resourceId = dstuMode.resourceId ?? initialSession?.id;
    if (!resourceId) return;
    return registerContentSaveHandler('essay', resourceId, () =>
      saveCurrentContentRef.current()
    );
  }, [dstuMode.resourceId, initialSession?.id]);

  // 标记"某段正文已被批改过"：同时更新文本基准与完整快照（内容 + 批改配置）
  const markInputAsGraded = useCallback((text: string) => {
    lastGradedInputRef.current = text;
    lastGradedSnapshotRef.current = gradedSnapshotOf(text, gradingContextRef.current);
  }, []);

  // ★ 已采纳建议的稳定 key 集合（轮次内 marker 下标 + 内容）；
  // 换轮次 / 加载新轮次 / 清空时重置
  const [appliedSuggestionKeys, setAppliedSuggestionKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // 加载会话轮次；返回恢复到输入框的最新轮次正文（无轮次时返回 null）
  const loadSessionRounds = useCallback(async (sessionId: string): Promise<string | null> => {
    try {
      const sessionRounds = await EssayGradingAPI.getRounds(sessionId);
      setRounds(sessionRounds);
      setAppliedSuggestionKeys(new Set());
      if (sessionRounds.length > 0) {
        // 显示最新轮次
        setCurrentRoundIndex(sessionRounds.length - 1);
        const latestRound = sessionRounds[sessionRounds.length - 1];
        setInputText(latestRound.input_text);
        setGradingResult(latestRound.grading_result);
        markInputAsGraded(latestRound.input_text);
        return latestRound.input_text;
      }
      return null;
    } catch (error: unknown) {
      console.error('[EssayGrading] Failed to load rounds:', error);
      return null;
    }
  }, [setGradingResult, markInputAsGraded]);

  // ★ 待确认的轮次切换目标（null = 无待确认）：脏正文时经对话框确认后再切换
  const [pendingRoundIndex, setPendingRoundIndex] = useState<number | null>(null);

  // 真正执行轮次切换（handleSelectRound 已完成边界/脏检查）
  const applyRoundSelection = useCallback((index: number) => {
    setCurrentRoundIndex(index);
    const round = rounds[index];
    setInputText(round.input_text);
    setGradingResult(round.grading_result);
    markInputAsGraded(round.input_text);
    // ★ 回看轮次不误报脏：正文基准跟随所选轮次的正文（题目/图片基准不动，
    // 它们不会被轮次切换覆盖，若有未保存修改应跨轮次保持脏态）。
    // markInputAsGraded 同步了 lastGradedInputRef，因此草稿自动保存 effect
    // 会把「正文 == 当前轮次正文」视为无未保存编辑，不把旧轮次正文写入草稿。
    patchPersistedBaseline({ inputText: round.input_text });
    // 展示的批改结果换了轮次，已采纳状态随之重置
    setAppliedSuggestionKeys(new Set());
  }, [rounds, setGradingResult, markInputAsGraded, patchPersistedBaseline]);

  // 切换轮次（批改中禁止切换，避免覆盖流式结果）
  // ★ 正文相对当前展示轮次有未保存编辑时先确认——切换会用目标轮次正文覆盖输入区。
  // 用 DsAlertDialog 而非 window.confirm（Tauri WebView 可能不弹窗直接返回 false）
  const handleSelectRound = useCallback((index: number) => {
    const decision = evaluateRoundSwitch({
      targetIndex: index,
      currentIndex: currentRoundIndex,
      roundCount: rounds.length,
      isGrading,
      hasUnsavedBody: inputText !== lastGradedInputRef.current,
    });
    if (decision === 'needs-confirm') {
      setPendingRoundIndex(index);
      return;
    }
    if (decision === 'apply') {
      applyRoundSelection(index);
    }
  }, [isGrading, currentRoundIndex, rounds.length, inputText, applyRoundSelection]);

  const handlePrevRound = useCallback(() => {
    handleSelectRound(currentRoundIndex - 1);
  }, [handleSelectRound, currentRoundIndex]);

  const handleNextRound = useCallback(() => {
    handleSelectRound(currentRoundIndex + 1);
  }, [handleSelectRound, currentRoundIndex]);

  // ★ OCR 版本计数器（用于时序控制，防止旧请求覆盖新结果）
  const ocrVersionRef = useRef(0);
  // ★ 活跃图片 ID 集合（同步可读，用于 async 回调中判断图片是否已被删除）
  const activeImageIdsRef = useRef(new Set<string>());
  // ★ 正在读取（尚未入列）的图片名额预约数：与 activeImageIdsRef 联合做同步上限判定，
  // 修复连续快速拖拽两批图片时双双读到旧 uploadedImages.length 导致超限的竞态
  const pendingImageReadsRef = useRef(0);
  // ★ 图片批次代数：清空时自增，使清空前拖入、清空后才读完的批次被丢弃而非"复活"
  const imageBatchGenerationRef = useRef(0);
  // ★ OCR 重试 setTimeout 句柄集合：卸载时统一清理，防止卸载后 setState 泄漏
  const ocrRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  // ★ 图片 id → 正文中的 OCR 占位符文本。上传时按顺序插入「第 x/y 张」占位符，
  // 识别完成后原位回填，保证最终文本顺序 = 上传顺序（并发 OCR 会乱序完成）
  const ocrPlaceholdersRef = useRef(new Map<string, string>());

  useEffect(() => {
    const retryTimers = ocrRetryTimersRef.current;
    const activeImageIds = activeImageIdsRef.current;
    return () => {
      retryTimers.forEach(timer => clearTimeout(timer));
      retryTimers.clear();
      // 清空活跃集合：在途 OCR Promise 回调据此跳过 setState
      activeImageIds.clear();
    };
  }, []);

  // ★ 文件拖拽处理（两阶段：即时显示缩略图 + 异步 OCR）
  const handleFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    // 筛选出图片文件
    const imageFiles = files.filter(file => 
      file.name.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)
    );
    // ★ 全部被过滤（如 HEIC）时明确提示，不再静默丢弃
    if (imageFiles.length === 0) {
      showGlobalNotification('warning', t('essay_grading:toast.unsupported_image_format'));
      return;
    }

    // 限制总图片数（已入列 + 读取中 + 新上传），基于同步可读的 ref 判定以避免并发拖拽竞态
    const remainingSlots = OCR_MAX_FILES - activeImageIdsRef.current.size - pendingImageReadsRef.current;
    if (remainingSlots <= 0) {
      showGlobalNotification('warning', t('essay_grading:toast.max_images_reached', { max: OCR_MAX_FILES }));
      return;
    }
    const limitedFiles = imageFiles.slice(0, remainingSlots);
    if (limitedFiles.length === 0) return;
    pendingImageReadsRef.current += limitedFiles.length;
    const batchGeneration = imageBatchGenerationRef.current;

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
      pendingImageReadsRef.current -= limitedFiles.length;
      showGlobalNotification('error', t('essay_grading:toast.ocr_failed', { error: 'File read error' }));
      return;
    }
    // 读取期间发生清空 → 丢弃本批次，避免已清空的图片"复活"
    if (batchGeneration !== imageBatchGenerationRef.current) {
      pendingImageReadsRef.current -= limitedFiles.length;
      return;
    }

    // 立即添加到状态 → 缩略图即时可见（预约名额同步转正）
    pendingImages.forEach(img => activeImageIdsRef.current.add(img.id));
    pendingImageReadsRef.current -= limitedFiles.length;
    setUploadedImages(prev => [...prev, ...pendingImages]);

    // ★ 按上传顺序把「第 x/y 张」占位符插入正文，识别完成后原位回填
    const batchTotal = pendingImages.length;
    const batchPlaceholders = pendingImages.map((img, i) => {
      const placeholder = t('essay_grading:toast.ocr_placeholder', {
        current: i + 1,
        total: batchTotal,
        fileName: img.fileName,
      });
      ocrPlaceholdersRef.current.set(img.id, placeholder);
      return placeholder;
    });
    setInputText(prev => appendOcrPlaceholders(prev, batchPlaceholders));
    showGlobalNotification(
      'info',
      batchTotal > 1
        ? t('essay_grading:toast.ocr_processing_multi', { count: batchTotal })
        : t('essay_grading:toast.ocr_processing')
    );

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

      ocrExtractText({ imageBase64: img.dataUrl })
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
          // ★ 原位回填占位符（占位符缺失时退回末尾追加），维持上传顺序
          const placeholder = ocrPlaceholdersRef.current.get(img.id) ?? '';
          ocrPlaceholdersRef.current.delete(img.id);
          const recognized = text.trim();
          if (recognized || placeholder) {
            // ★ OCR 回填同样受作文字符上限约束（此前仅手动输入路径限流）
            const merged = fillOcrPlaceholder(inputTextRef.current ?? '', placeholder, recognized);
            if (Array.from(merged).length > ESSAY_MAX_CHARS) {
              showGlobalNotification('warning', t('essay_grading:char_limit.truncated', { max: ESSAY_MAX_CHARS.toLocaleString() }));
            }
            setInputText(prev => {
              const next = fillOcrPlaceholder(prev, placeholder, recognized);
              const chars = Array.from(next);
              return chars.length > ESSAY_MAX_CHARS ? chars.slice(0, ESSAY_MAX_CHARS).join('') : next;
            });
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
            const retryTimer = setTimeout(() => {
              ocrRetryTimersRef.current.delete(retryTimer);
              if (!activeImageIdsRef.current.has(img.id)) {
                running--;
                processNext();
                return;
              }
              executeOcrForImage(img, retryCount + 1);
            }, OCR_RETRY_DELAY_MS);
            ocrRetryTimersRef.current.add(retryTimer);
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
          // ★ 识别失败：移除正文中的占位符，避免残留「识别中」文案被提交批改
          const failedPlaceholder = ocrPlaceholdersRef.current.get(img.id);
          ocrPlaceholdersRef.current.delete(img.id);
          if (failedPlaceholder) {
            setInputText(prev => fillOcrPlaceholder(prev, failedPlaceholder, ''));
          }
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
  }, [t]);

  // 删除单张上传图片
  const handleRemoveImage = useCallback((imageId: string) => {
    activeImageIdsRef.current.delete(imageId); // ★ 同步标记删除，OCR 回调可立即感知
    // 识别尚未完成的图片：连同正文中的占位符一起移除
    const placeholder = ocrPlaceholdersRef.current.get(imageId);
    if (placeholder) {
      ocrPlaceholdersRef.current.delete(imageId);
      setInputText(prev => fillOcrPlaceholder(prev, placeholder, ''));
    }
    setUploadedImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // ★ OCR 失败图片的单图手动重试（点按失败缩略图触发；只针对 error/timeout 终态）
  const handleRetryImageOcr = useCallback((imageId: string) => {
    const img = uploadedImagesRef.current.find(i => i.id === imageId);
    if (!img || (img.ocrStatus !== 'error' && img.ocrStatus !== 'timeout')) return;
    if (!activeImageIdsRef.current.has(imageId)) return;

    const version = ++ocrVersionRef.current;
    setUploadedImages(prev =>
      prev.map(p => p.id === imageId
        ? { ...p, ocrStatus: 'processing' as OcrStatus, ocrError: undefined, ocrVersion: version }
        : p
      )
    );
    showGlobalNotification('info', t('essay_grading:toast.ocr_retrying_image', { fileName: img.fileName }));

    ocrExtractText({ imageBase64: img.dataUrl })
      .then(text => {
        if (!activeImageIdsRef.current.has(imageId)) return;
        setUploadedImages(prev => {
          const existing = prev.find(p => p.id === imageId);
          if (!existing || existing.ocrVersion !== version) return prev; // stale
          return prev.map(p =>
            p.id === imageId ? { ...p, ocrText: text, ocrStatus: 'done' as OcrStatus } : p
          );
        });
        if (text.trim()) {
          // 与批量 OCR 回填同口径：受作文字符上限约束
          const prevChars = Array.from(inputTextRef.current ?? '').length;
          if (prevChars + Array.from(text).length + 2 > ESSAY_MAX_CHARS) {
            showGlobalNotification('warning', t('essay_grading:char_limit.truncated', { max: ESSAY_MAX_CHARS.toLocaleString() }));
          }
          setInputText(prev => {
            const merged = prev ? `${prev}\n\n${text}` : text;
            const chars = Array.from(merged);
            return chars.length > ESSAY_MAX_CHARS ? chars.slice(0, ESSAY_MAX_CHARS).join('') : merged;
          });
        }
      })
      .catch((err: unknown) => {
        if (!activeImageIdsRef.current.has(imageId)) return;
        const msg = getErrorMessage(err);
        const isTimeout = msg === 'OCR_TIMEOUT';
        setUploadedImages(prev => {
          const existing = prev.find(p => p.id === imageId);
          if (!existing || existing.ocrVersion !== version) return prev;
          return prev.map(p =>
            p.id === imageId
              ? { ...p, ocrStatus: (isTimeout ? 'timeout' : 'error') as OcrStatus, ocrError: msg }
              : p
          );
        });
        if (isTimeout) {
          showGlobalNotification('warning', t('essay_grading:toast.ocr_timeout', { fileName: img.fileName }));
        } else {
          showGlobalNotification('error', t('essay_grading:toast.ocr_failed', { error: msg }));
        }
      });
  }, [t]);

  // ★ 题目参考材料图片上传处理
  const handleTopicFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const imageFiles = files.filter(file =>
      file.name.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)
    );
    // ★ 全部被过滤（如 HEIC）时明确提示，不再静默丢弃
    if (imageFiles.length === 0) {
      showGlobalNotification('warning', t('essay_grading:toast.unsupported_image_format'));
      return;
    }
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

  // 批改完成后的统一收尾：成功反馈、清草稿、刷新轮次、DSTU 回写、脏检查基准更新
  // ★ 抽取为独立回调：首次批改与"重试成功"共用（此前重试成功不会触发任何持久化收尾）
  const finalizeCompletedGrading = useCallback(async (sessionId: string) => {
    showGlobalNotification('success', t('essay_grading:toast.grading_success'));
    // ★ 题目与图片随会话持久化（settings KV），重开会话可恢复；
    // 轮次表只落正文与批改结果，题目/原图属于会话级上下文
    const gradedContext = gradingContextRef.current;
    let contextPersisted = false;
    try {
      await TauriAPI.saveSetting(
        essaySessionContextKey(sessionId),
        serializeSessionContext({
          topicText: gradedContext.topicText,
          uploadedImages: gradedContext.uploadedImages,
          topicImages: gradedContext.topicImages,
        })
      );
      contextPersisted = true;
    } catch (error: unknown) {
      console.warn('[EssayGrading] Failed to persist session topic/images context');
      showGlobalNotification(
        'error',
        t('essay_grading:toast.save_failed', { error: getErrorMessage(error) })
      );
    }
    // ★ S-012: 仅在会话上下文也落盘后清除草稿。保存失败时保留正文/题目草稿，
    // 与 dirty 基准一起防止“批改轮次成功、上下文失败”后静默丢题目。
    if (contextPersisted) {
      try {
        localStorage.removeItem(`essay_draft_${sessionId}`);
        localStorage.removeItem('essay_draft_new');
      } catch {}
    }
    // 刷新轮次
    const latestText = await loadSessionRounds(sessionId);

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
          modeId: gradingContextRef.current.modeId,
        });
      }
    }
    // ★ 基准更新为本轮已持久化的内容（最新轮次正文 + 已保存的题目/图片）
    patchPersistedBaseline({
      inputText: latestText ?? (inputTextRef.current ?? ''),
      // 上下文保存失败时保留旧基准，使题目/图片继续呈 dirty；
      // 不能把未落盘内容误标为已保存后允许无提示关窗。
      ...(contextPersisted ? {
        topicText: gradedContext.topicText,
        uploadedImages: gradedContext.uploadedImages,
        topicImages: gradedContext.topicImages,
      } : {}),
    });
  }, [t, loadSessionRounds, dstuMode, patchPersistedBaseline]);

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
    // A6-13: 纯图批改 —— 有正文文字或有作文原图（多模态读图）任一即可放行
    const hasText = safeInputText.trim().length > 0;
    const hasEssayImages = uploadedImages.length > 0;
    if (!hasText && !hasEssayImages) {
      showGlobalNotification('warning', t('essay_grading:errors.empty_text'));
      return;
    }

    // 内容或批改配置未修改时阻止重复提交
    // （正文 / 题目 / 作文图 / 题目图 / 模式 / 模型 / 文体 / 学段 / Prompt 任一变化即放行）
    const submitSnapshot = gradedSnapshotOf(safeInputText, {
      topicText,
      uploadedImages,
      topicImages,
      modeId,
      modelId,
      essayType,
      gradeLevel,
      customPrompt,
    });
    if (rounds.length > 0 && submitSnapshot === lastGradedSnapshotRef.current) {
      showGlobalNotification('warning', t('essay_grading:errors.unchanged_text'));
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

      const outcome = await startGrading({
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
        lastGradedInputRef.current = safeInputText;
        lastGradedSnapshotRef.current = submitSnapshot;
        await finalizeCompletedGrading(sessionId);
      } else if (outcome === 'cancelled') {
        // ★ 取消后回退轮次索引：批改开始时已乐观指向"新轮次"，但该轮次并未产生
        setCurrentRoundIndex(rounds.length > 0 ? rounds.length - 1 : 0);
        showGlobalNotification('info', t('essay_grading:toast.grading_cancelled'));
      }
    } catch (error: unknown) {
      // ★ 失败后同样回退轮次索引，避免指向不存在的轮次
      setCurrentRoundIndex(rounds.length > 0 ? rounds.length - 1 : 0);
      const errorMsg = getErrorMessage(error);
      if (!errorMsg.includes(t('essay_grading:toast.grading_already'))) {
        showGlobalNotification('error', t('essay_grading:toast.grading_failed', { error: errorMsg }));
      }
    }
  }, [inputText, modeId, modelId, essayType, gradeLevel, customPrompt, currentSession, initialSession?.id, rounds, isGrading, t, startGrading, finalizeCompletedGrading, uploadedImages, topicImages, topicText]);

  // 重试批改（错误后由 ResultPanel 触发）
  // ★ 修复：此前重试成功后不会执行任何收尾（无成功反馈、轮次不刷新、DSTU 不回写），现与正常批改共用收尾逻辑
  const handleRetry = useCallback(() => {
    void (async () => {
      try {
        const outcome = await retryGrading();
        if (outcome === 'completed') {
          const sessionId = currentSession?.id ?? initialSession?.id;
          if (sessionId) {
            await finalizeCompletedGrading(sessionId);
          } else {
            showGlobalNotification('success', t('essay_grading:toast.grading_success'));
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
    })();
  }, [retryGrading, currentSession?.id, initialSession?.id, finalizeCompletedGrading, t]);

  // ★ handleGrade 的同步镜像：全局事件监听器经由 ref 调用最新实现，
  // 监听器自身保持稳定引用，不随 inputText 等依赖每次击键重挂
  const handleGradeRef = useRef(handleGrade);
  handleGradeRef.current = handleGrade;

  // A6-29: Ctrl/Cmd+Enter 提交批改快捷键（对齐翻译工作台）
  // ★ 标签页保活：非活跃实例不注册，避免多个作文标签页同时响应同一按键
  const handleGradeShortcut = useCallback((e: Event) => {
    const ke = e as KeyboardEvent;
    if ((ke.ctrlKey || ke.metaKey) && ke.key === 'Enter') {
      ke.preventDefault();
      ke.stopPropagation();
      if (!isGradingRef.current) {
        handleGradeRef.current();
      }
    }
  }, []);

  useEventRegistry(
    isActive === false
      ? []
      : [{ target: 'document', type: 'keydown', listener: handleGradeShortcut }],
    [isActive, handleGradeShortcut],
  );

  // P1-19: 监听命令面板 LEARNING_GRADE_ESSAY 事件
  // ★ isActive 过滤：显式指定 targetResourceId 时按资源匹配；广播（无 target）时仅活跃标签页响应
  const handleGradeEvent = useCallback((evt: Event) => {
    const detail = (evt as CustomEvent<{ targetResourceId?: string }>).detail;
    if (detail?.targetResourceId && dstuMode.resourceId) {
      if (detail.targetResourceId !== dstuMode.resourceId) return;
    } else if (isActive === false) {
      return;
    }
    handleGradeRef.current();
  }, [dstuMode.resourceId, isActive]);

  useEventRegistry(
    [{ target: 'window', type: 'LEARNING_GRADE_ESSAY', listener: handleGradeEvent }],
    [handleGradeEvent],
  );

  // P1-19: 监听命令面板 LEARNING_ESSAY_SUGGESTIONS 事件
  // 当用户请求改进建议时，如果已有批改结果则显示提示，否则触发批改
  // 'LEARNING_ESSAY_SUGGESTIONS' — dispatched by CommandPalette to request improvement suggestions.
  // TODO: Migrate to a centralised event hook/registry (e.g. useAppEvent or EventBus).
  // ★ 修复：改经 ref 读取最新正文/结果，监听器不再依赖 inputText/gradingResult，
  // 避免每次击键都卸载并重挂全局监听
  useEffect(() => {
    const handleSuggestionsEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<{ targetResourceId?: string }>).detail;
      if (detail?.targetResourceId && dstuMode.resourceId) {
        if (detail.targetResourceId !== dstuMode.resourceId) return;
      } else if (isActive === false) {
        // ★ 广播事件仅活跃标签页响应，避免非活跃实例触发批改
        return;
      }
      const currentText = inputTextRef.current ?? '';
      const hasResultForInput = Boolean(gradingResultRef.current) && lastGradedInputRef.current === currentText;
      if (hasResultForInput) {
        showGlobalNotification('info', t('essay_grading:toast.suggestions_in_result'));
      } else {
        handleGradeRef.current();
      }
    };
    window.addEventListener('LEARNING_ESSAY_SUGGESTIONS', handleSuggestionsEvent);
    return () => {
      window.removeEventListener('LEARNING_ESSAY_SUGGESTIONS', handleSuggestionsEvent);
    };
  }, [t, dstuMode.resourceId, isActive]);


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

  // 清空输入与结果
  // ★ 语义为"直接执行清空"：两步确认（点击后变红色"确认清空？"态、3 秒自动还原）由 InputPanel 内联实现
  const handleClear = useCallback(() => {
    if (isGrading) {
      // 批改中清空会中断流式监听且状态不一致，直接阻止
      showGlobalNotification('warning', t('essay_grading:toast.clear_blocked_grading'));
      return;
    }
    const hasContent =
      (inputText ?? '').trim().length > 0 ||
      (gradingResult ?? '').length > 0 ||
      topicText.trim().length > 0 ||
      uploadedImages.length > 0 ||
      topicImages.length > 0;
    if (!hasContent) return; // 没有内容，无需清空

    // 同步失活所有图片，在途 OCR 回调据此丢弃结果；代数自增使读取中的批次一并作废
    activeImageIdsRef.current.clear();
    imageBatchGenerationRef.current++;
    ocrPlaceholdersRef.current.clear();
    setAppliedSuggestionKeys(new Set());
    setInputText('');
    setUploadedImages([]);
    setTopicText('');
    setTopicImages([]);
    resetGradingState();
    // 清空后草稿一并移除，避免下次进入被"恢复"回来
    try {
      localStorage.removeItem(draftKey);
    } catch {}
    showGlobalNotification('success', t('essay_grading:toast.cleared'));
  }, [isGrading, inputText, gradingResult, topicText, uploadedImages.length, topicImages.length, resetGradingState, draftKey, t]);

  // ★ 应用批改建议：前后文锚定定位（同一片段多次出现时选上下文匹配度最高的一处），
  // 替代此前的全局 indexOf；成功后记录已采纳 key，支持撤销
  const handleApplySuggestion = useCallback((change: SuggestionChange) => {
    if (isGrading) {
      showGlobalNotification('warning', t('essay_grading:toast.suggestion_blocked_grading'));
      return;
    }
    const applied = applyAnchoredReplacement(
      inputText ?? '',
      change.original ?? '',
      change.replacement ?? '',
      change.before,
      change.after
    );
    if (!applied) {
      showGlobalNotification('warning', t('essay_grading:toast.suggestion_not_found'));
      return;
    }
    setInputText(applied.text);
    if (change.key) {
      setAppliedSuggestionKeys(prev => new Set(prev).add(change.key!));
    }
    showGlobalNotification('success', t('essay_grading:toast.suggestion_applied'));
  }, [isGrading, inputText, t]);

  // ★ 撤销已采纳的建议：反向锚定替换（replacement → original）；
  // del 类建议撤销时 replacement 为空，按前后文接缝重插被删除的原文
  const handleUndoSuggestion = useCallback((change: SuggestionChange) => {
    if (isGrading) {
      showGlobalNotification('warning', t('essay_grading:toast.suggestion_blocked_grading'));
      return;
    }
    const undone = applyAnchoredReplacement(
      inputText ?? '',
      change.replacement ?? '',
      change.original ?? '',
      change.before,
      change.after
    );
    if (!undone) {
      showGlobalNotification('warning', t('essay_grading:toast.suggestion_undo_failed'));
      return;
    }
    setInputText(undone.text);
    if (change.key) {
      setAppliedSuggestionKeys(prev => {
        const next = new Set(prev);
        next.delete(change.key!);
        return next;
      });
    }
    showGlobalNotification('success', t('essay_grading:toast.suggestion_undone'));
  }, [isGrading, inputText, t]);

  // ★ 批改结果「存为笔记」：整理题目/正文/批改结果为 Markdown，改走共享
  // saveTextAsNote 流程（先选目录，成功 toast 带「打开笔记」动作），与聊天消息 /
  // PDF 划词的落点行为一致，不再 createNote 直落资源库根目录
  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'essay-grading' });
  const startSaveAsNote = saveAsNoteFlow.start;
  const handleSaveAsNote = useCallback(async () => {
    const safeResult = gradingResult ?? '';
    if (!safeResult) return;
    try {
      // 动态导入：导出格式化器不在批改主路径上
      const { formatGradingResultForExport } = await import('../essay-grading/exportFormatter');
      const safeInput = inputText ?? '';
      const baseTitle =
        currentSession?.title?.trim() ||
        safeInput.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20) ||
        t('essay_grading:page_title');
      const title = t('essay_grading:notes.note_title', {
        title: baseTitle,
        round: currentRoundNumber,
      });
      let content = '';
      if (topicText.trim()) {
        content += `## ${t('essay_grading:topic.toggle_label')}\n\n${topicText.trim()}\n\n`;
      }
      content += `## ${t('essay_grading:input_section.title')}\n\n${safeInput}\n\n`;
      content += `## ${t('essay_grading:result_section.title')}\n\n`;
      content += formatGradingResultForExport(safeResult, safeInput);
      // 打开目录选择器；确认后由共享流程写入并弹出结果 toast
      startSaveAsNote({ content, title });
    } catch (error: unknown) {
      console.error('[EssayGrading] Save as note failed:', error);
      showGlobalNotification('error', t('essay_grading:errors.save_note_failed'));
    }
  }, [gradingResult, inputText, topicText, currentSession?.title, currentRoundNumber, startSaveAsNote, t]);

  // ★ 生成卡片：把「原文 + 批改结果」交给既有制卡链路（CardForge 批次任务）
  const [isGeneratingCards, setIsGeneratingCards] = useState(false);
  const handleGenerateCards = useCallback(async () => {
    if (isGrading || !gradingResult || isGeneratingCards) return;
    setIsGeneratingCards(true);
    try {
      const { generateCardsFromText } = await import('@/features/anki/generateCardsFromText');
      const sections = [
        `## ${t('essay_grading:input_section.title')}\n${inputText ?? ''}`.trim(),
        `## ${t('essay_grading:result_section.title')}\n${gradingResult}`.trim(),
      ];
      await generateCardsFromText({
        content: sections.join('\n\n'),
        deckName: t('essay_grading:make_cards.deck_name'),
        requirements: t('essay_grading:make_cards.requirements'),
        messages: {
          tooShort: t('essay_grading:make_cards.too_short'),
          started: t('essay_grading:make_cards.started'),
          failed: t('essay_grading:make_cards.failed'),
          openTaskDashboard: t('essay_grading:make_cards.open_task_dashboard'),
        },
      });
    } finally {
      setIsGeneratingCards(false);
    }
  }, [isGrading, gradingResult, isGeneratingCards, inputText, t]);

  // 字符统计（统一使用 Unicode 字符口径，避免 UTF-16 length 偏差）
  // ★ 性能：统计基于 deferred 值计算——超长文本快速键入时统计滞后渲染，不阻塞输入本身
  const deferredInputText = useDeferredValue(inputText);
  const inputTextStats = useMemo(() => calculateEssayTextStats(deferredInputText ?? ''), [deferredInputText]);
  const inputCharCount = inputTextStats.totalChars;
  const resultCharCount = Array.from(gradingResult ?? '').length;

  return (
    <div className="w-full h-full flex-1 min-h-0 bg-[hsl(var(--background))] flex flex-col overflow-hidden">
      <MacTopSafeDragZone className="essay-grading-top-safe-drag-zone" />

      {/* Main Content - 始终显示批改界面 */}
      <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
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
          onCancelGrading={() => { void cancelGrading(); }}
          inputCharCount={inputCharCount}
          inputTextStats={inputTextStats}
          gradingResult={gradingResult}
          resultCharCount={resultCharCount}
          onCopyResult={handleCopyResult}
          onExportResult={handleExportResult}
          error={gradingStream.error}
          canRetry={gradingStream.canRetry}
          onRetry={handleRetry}
          isPartialResult={isPartialResult}
          currentRound={currentRoundNumber}
          uploadedImages={uploadedImages}
          onRemoveImage={handleRemoveImage}
          onRetryImageOcr={handleRetryImageOcr}
          topicText={topicText}
          setTopicText={setTopicText}
          topicImages={topicImages}
          onTopicFilesDropped={handleTopicFilesDropped}
          onRemoveTopicImage={handleRemoveTopicImage}
          onModesChange={loadModes}
          onApplySuggestion={handleApplySuggestion}
          onUndoSuggestion={handleUndoSuggestion}
          appliedSuggestionKeys={appliedSuggestionKeys}
          onSaveAsNote={handleSaveAsNote}
          onGenerateCards={() => { void handleGenerateCards(); }}
          isGeneratingCards={isGeneratingCards}
          settingsAsPage={externalSettingsNavigation}
          isActive={isActive}
          roundNavigation={totalRounds > 0 ? {
            currentIndex: currentRoundIndex,
            total: totalRounds,
            onPrev: handlePrevRound,
            onNext: handleNextRound,
            onSelect: handleSelectRound,
          } : undefined}
        />
      </div>

      {/* 切换轮次前的未保存修改确认（脏正文会被目标轮次正文覆盖） */}
      <DsAlertDialog
        open={pendingRoundIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRoundIndex(null);
        }}
        title={t('essay_grading:round.switch_confirm_title')}
        description={t('essay_grading:round.switch_unsaved_confirm')}
        onConfirm={() => {
          if (pendingRoundIndex === null) return;
          const index = pendingRoundIndex;
          setPendingRoundIndex(null);
          applyRoundSelection(index);
        }}
      />

      {/* 「存为笔记」目录选择器（窄屏走全屏子屏，见 useSaveAsNoteFlow） */}
      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </div>
  );
};

export default EssayGradingWorkbench;
