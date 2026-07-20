import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ocrExtractText, TauriAPI } from '../utils/tauriApi';
import {
  type TranslationSession,
  generateTranslationId,
} from '@/dstu/adapters/translationDstuAdapter';
import { getErrorMessage } from '../utils/errorUtils';
import { showGlobalNotification } from './UnifiedNotification';
// 独立翻译流式管线
import {
  useTranslationStream,
  TRANSLATION_STREAM_UNMOUNTED_ERROR,
} from '../translation/useTranslationStream';
import * as TTS from '../utils/tts';
import { fileManager } from '../utils/fileManager';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';
import { WarningCircle, ArrowClockwise, WifiSlash, Info, Translate } from '@phosphor-icons/react';
import { DsButton } from './ui/DsButton';

import { debugLog } from '../debug-panel/debugMasterSwitch';

// 子组件
import { TranslationMain } from './translation/TranslationMain';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** Maximum characters allowed for source text input */
const TRANSLATION_MAX_CHARS = 50000;

/** localStorage key：工作台偏好（自动翻译/同步滚动/默认语向/正式度） */
const WORKBENCH_PREFS_KEY = 'translation.workbench.prefs';

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl';

interface WorkbenchPrefs {
  autoTranslate?: boolean;
  syncScroll?: boolean;
  srcLang?: string;
  tgtLang?: string;
  formality?: 'formal' | 'casual' | 'auto';
}

function loadWorkbenchPrefs(): WorkbenchPrefs {
  try {
    const raw = localStorage.getItem(WORKBENCH_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as WorkbenchPrefs) : {};
  } catch {
    return {};
  }
}

function saveWorkbenchPrefs(patch: Partial<WorkbenchPrefs>) {
  try {
    localStorage.setItem(WORKBENCH_PREFS_KEY, JSON.stringify({ ...loadWorkbenchPrefs(), ...patch }));
  } catch {
    // localStorage 不可用时静默降级（偏好不持久化，不影响功能）
  }
}

function translationDirtySnapshot(session: {
  sourceText?: string;
  translatedText?: string;
  srcLang?: string;
  tgtLang?: string;
  formality?: string;
  domain?: string;
  glossary?: Array<[string, string]>;
}): string {
  return JSON.stringify([
    session.sourceText ?? '',
    session.translatedText ?? '',
    session.srcLang ?? 'auto',
    session.tgtLang ?? 'zh-CN',
    session.formality ?? 'auto',
    session.domain ?? 'general',
    session.glossary ?? [],
  ]);
}

/** Clean up common OCR artifacts before filling source text */
function cleanOcrText(text: string): string {
  const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;
  return text
    .replace(/(\S)-\n(\S)/g, '$1$2')       // merge hyphenated line breaks
    .replace(/([^\n])\n([^\n])/g, (_m, before: string, after: string) => {
      // CJK↔CJK: join directly; otherwise insert a space (Latin text needs word separator)
      if (CJK.test(before) && CJK.test(after)) return `${before}${after}`;
      return `${before} ${after}`;
    })
    .replace(/[ \t]+/g, ' ')               // collapse multiple spaces/tabs
    .replace(/\n{3,}/g, '\n\n')            // limit consecutive blank lines
    .trim();
}

/**
 * 轻量语言检测启发式（auto 模式的检测回显）。
 *
 * 后端事件协议已预留 detected_lang 扩展字段（useTranslationStream 会优先采用），
 * 本函数仅作前端回显兜底：按字符 script 判断主导语言，拉丁文本只有在命中
 * 常见英文功能词时才回显英语，无法可靠判断时返回 null（不显示提示）。
 */
function detectLanguageHeuristic(text: string): string | null {
  const sample = text.slice(0, 400);
  if (!sample.trim()) return null;
  let han = 0, kana = 0, hangul = 0, cyrillic = 0, arabic = 0, thai = 0, devanagari = 0, greek = 0, latin = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) han++;
    else if (code >= 0x3040 && code <= 0x30ff) kana++;
    else if (code >= 0xac00 && code <= 0xd7af) hangul++;
    else if (code >= 0x0400 && code <= 0x04ff) cyrillic++;
    else if (code >= 0x0600 && code <= 0x06ff) arabic++;
    else if (code >= 0x0e00 && code <= 0x0e7f) thai++;
    else if (code >= 0x0900 && code <= 0x097f) devanagari++;
    else if (code >= 0x0370 && code <= 0x03ff) greek++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) latin++;
  }
  const total = han + kana + hangul + cyrillic + arabic + thai + devanagari + greek + latin;
  if (total < 4) return null;
  if (kana >= 2) return 'ja';
  if (hangul >= 2) return 'ko';
  if (han >= Math.max(2, total * 0.3)) return 'zh-CN';
  if (cyrillic > total * 0.5) return 'ru';
  if (arabic > total * 0.5) return 'ar';
  if (thai > total * 0.5) return 'th';
  if (devanagari > total * 0.5) return 'hi';
  if (greek > total * 0.5) return 'el';
  if (latin > total * 0.6) {
    const lower = ` ${sample.toLowerCase()} `;
    const hits = [' the ', ' and ', ' is ', ' of ', ' to ', ' in ', ' that ', ' it ']
      .filter((w) => lower.includes(w)).length;
    if (hits >= 2) return 'en';
  }
  return null;
}

/**
 * 翻译工作台 Props
 *
 * 仅支持 DSTU 模式，由 Learning Hub 管理历史记录
 */
export interface TranslateWorkbenchDstuMode {
  /** 当前翻译会话（null 表示新建） */
  session: TranslationSession | null;
  /** 会话保存回调 */
  onSessionSave?: (session: TranslationSession) => Promise<void>;
  /** ★ 标签页：资源 ID，用于事件定向过滤 */
  resourceId?: string;
}

interface TranslateWorkbenchProps {
  onBack?: () => void;
  /** DSTU 模式配置（必需） */
  dstuMode: TranslateWorkbenchDstuMode;
  /** ★ A6-28 标签页：当前是否为活跃标签页；非活跃实例不响应全局快捷键 */
  isActive?: boolean;
}

export const TranslateWorkbench: React.FC<TranslateWorkbenchProps> = ({ onBack, dstuMode, isActive }) => {
  const { t } = useTranslation(['translation', 'common']);

  // DSTU 会话数据
  const initialSession = dstuMode.session;
  // 保存当前会话ID（用于更新而非新建）
  const currentSessionIdRef = useRef<string | null>(initialSession?.id || null);

  // 同步 session ID（当 TranslationContentView 更新 session 后）
  useEffect(() => {
    if (initialSession?.id && initialSession.id !== currentSessionIdRef.current) {
      currentSessionIdRef.current = initialSession.id;
    }
  }, [initialSession?.id]);

  // 独立翻译流式管线
  const translationStream = useTranslationStream();

  // 持久化偏好（只在首次渲染读取一次）
  const prefsRef = useRef<WorkbenchPrefs | null>(null);
  if (prefsRef.current === null) {
    prefsRef.current = loadWorkbenchPrefs();
  }
  const prefs = prefsRef.current;

  // 左栏状态（session 优先，其次持久化偏好）
  const [sourceText, setSourceText] = useState(initialSession?.sourceText || '');
  const [srcLang, setSrcLang] = useState(initialSession?.srcLang || prefs.srcLang || 'auto');
  const [tgtLang, setTgtLang] = useState(initialSession?.tgtLang || prefs.tgtLang || 'zh-CN');
  const [customPrompt, setCustomPrompt] = useState('');
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [formality, setFormality] = useState<'formal' | 'casual' | 'auto'>(
    initialSession?.formality || prefs.formality || 'auto'
  );
  const [domain, setDomain] = useState<string>(initialSession?.domain || 'general');
  const [glossary, setGlossary] = useState<Array<[string, string]>>(initialSession?.glossary || []);

  // 右栏状态
  const [isEditingTranslation, setIsEditingTranslation] = useState(false);
  const [editedTranslation, setEditedTranslation] = useState('');
  const [translationQuality, setTranslationQuality] = useState<number | null>(initialSession?.quality || null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isSpeakingRef = useRef(false);
  const speakIdRef = useRef(0);

  const [isSyncScroll, setIsSyncScrollState] = useState(prefs.syncScroll ?? true);
  const [isAutoTranslate, setIsAutoTranslateState] = useState(prefs.autoTranslate ?? false);

  // 错误状态管理
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  // 偏好持久化：开关走包装 setter，语向/正式度统一走 effect
  const setIsSyncScroll = useCallback((value: boolean) => {
    setIsSyncScrollState(value);
    saveWorkbenchPrefs({ syncScroll: value });
  }, []);
  const setIsAutoTranslate = useCallback((value: boolean) => {
    setIsAutoTranslateState(value);
    saveWorkbenchPrefs({ autoTranslate: value });
  }, []);
  useEffect(() => {
    saveWorkbenchPrefs({ srcLang, tgtLang, formality });
  }, [srcLang, tgtLang, formality]);

  // 网络状态监听
  // NOTE: 'online'/'offline' are standard browser events on window — not a custom event violation.
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 监听全局顶栏的设置按钮点击事件（移动端）- 切换模式
  // TODO: Migrate 'translation:openSettings' to a centralised event hook/registry
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
    window.addEventListener('translation:openSettings', handleToggleSettings);
    return () => {
      window.removeEventListener('translation:openSettings', handleToggleSettings);
    };
  }, [dstuMode.resourceId]);

  // 向宿主（资源工作区侧边栏的"翻译设置"标签）回报设置页开合状态，
  // 使侧边栏入口能正确渲染选中态
  useEffect(() => {
    const resourceId = dstuMode.resourceId;
    if (!resourceId) return;
    window.dispatchEvent(new CustomEvent('translation:settingsVisibility', {
      detail: { resourceId, open: showPromptEditor },
    }));
  }, [showPromptEditor, dstuMode.resourceId]);

  // 使用流式状态
  const translatedText = translationStream.translatedText;
  const isTranslating = translationStream.isTranslating;
  const setTranslatedText = translationStream.setTranslatedText;
  const streamError = translationStream.error;
  const isPartialResult = translationStream.isPartialResult;

  // 检测语言回显：优先后端事件（协议扩展点），否则前端启发式。
  // 原文清空后一律视为「未检测」，避免残留上一轮流式检测结果误导交换语向
  const heuristicDetectedLang = useMemo(
    () => (srcLang === 'auto' ? detectLanguageHeuristic(sourceText) : null),
    [srcLang, sourceText]
  );
  const detectedLang = sourceText.trim()
    ? (translationStream.detectedLang ?? heuristicDetectedLang)
    : null;

  const persistedDirtySnapshotRef = useRef(translationDirtySnapshot(initialSession ?? {}));
  const currentDirtySnapshotRef = useRef(persistedDirtySnapshotRef.current);
  const translatedTextForDirty = isEditingTranslation
    ? editedTranslation
    : translatedText || initialSession?.translatedText || '';
  currentDirtySnapshotRef.current = translationDirtySnapshot({
    sourceText,
    translatedText: translatedTextForDirty,
    srcLang,
    tgtLang,
    formality,
    domain,
    glossary,
  });

  useEffect(() => {
    persistedDirtySnapshotRef.current = translationDirtySnapshot(initialSession ?? {});
  }, [initialSession]);

  useEffect(() => {
    const resourceId = dstuMode.resourceId ?? initialSession?.id;
    if (!resourceId) return;
    return registerContentDirtyChecker('translation', resourceId, () =>
      isTranslating || currentDirtySnapshotRef.current !== persistedDirtySnapshotRef.current
    );
  }, [dstuMode.resourceId, initialSession?.id, isTranslating]);

  const markTranslationPersisted = useCallback((session: TranslationSession) => {
    persistedDirtySnapshotRef.current = translationDirtySnapshot(session);
  }, []);

  // 同步流式管线的错误状态到本地
  useEffect(() => {
    if (streamError) {
      setTranslationError(streamError);
    }
  }, [streamError]);

  // 初始化会话数据（编辑已有记录时）
  // 无条件赋值（含空字符串），确保父级会话被清空/刷新时本地状态一致
  useEffect(() => {
    if (!initialSession?.id) return;
    setSourceText(initialSession.sourceText ?? '');
    setTranslatedText(initialSession.translatedText ?? '');
    setSrcLang(initialSession.srcLang || 'auto');
    setTgtLang(initialSession.tgtLang || 'zh-CN');
    setFormality(initialSession.formality || 'auto');
    setDomain(initialSession.domain || 'general');
    setGlossary(initialSession.glossary || []);
    setTranslationQuality(initialSession.quality ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession?.id]);

  // ★ A6-06：最近一次已执行翻译的参数签名；恢复历史会话时已有译文视为"已翻译过"
  // 签名结构与 buildTranslationSig 对齐：[source, src, tgt, customPrompt, formality, domain, glossary]
  const lastTranslatedSigRef = useRef<string | null>(
    initialSession?.translatedText
      ? JSON.stringify([
          initialSession.sourceText || '',
          initialSession.srcLang || 'auto',
          initialSession.tgtLang || 'zh-CN',
          '',
          initialSession.formality || 'auto',
          initialSession.domain || 'general',
          initialSession.glossary || [],
        ])
      : null
  );
  // 恢复会话时签名中的 customPrompt 占位为 ''，待异步加载出真实 prompt 后补齐，
  // 避免「打开历史 → prompt 加载完成 → 签名失配 → 自动翻译误触发」
  const restoredSigPendingPromptRef = useRef<boolean>(Boolean(initialSession?.translatedText));

  const syncRestoredSigWithPrompt = useCallback((prompt: string) => {
    if (!restoredSigPendingPromptRef.current) return;
    if (!initialSession?.translatedText) return;
    lastTranslatedSigRef.current = JSON.stringify([
      initialSession.sourceText || '',
      initialSession.srcLang || 'auto',
      initialSession.tgtLang || 'zh-CN',
      prompt,
      initialSession.formality || 'auto',
      initialSession.domain || 'general',
      initialSession.glossary || [],
    ]);
  }, [initialSession]);

  // 加载自定义 Prompt（带 stale 守卫，防止旧请求覆盖新 session 的 prompt）
  useEffect(() => {
    let cancelled = false;
    const loadPrompt = async () => {
      // 优先使用 session 中的自定义提示词
      if (initialSession?.customPrompt) {
        setCustomPrompt(initialSession.customPrompt);
        syncRestoredSigWithPrompt(initialSession.customPrompt);
        return;
      }
      try {
        const saved = await TauriAPI.getSetting('translation.prompt');
        if (cancelled) return;
        const value = saved || t('translation:prompt_editor.default_prompt');
        setCustomPrompt(value);
        syncRestoredSigWithPrompt(value);
      } catch (error: unknown) {
        if (cancelled) return;
        console.error('[Translation] Failed to load prompt:', error);
        const fallback = t('translation:prompt_editor.default_prompt');
        setCustomPrompt(fallback);
        syncRestoredSigWithPrompt(fallback);
      }
    };
    loadPrompt();
    return () => {
      cancelled = true;
    };
  }, [t, initialSession?.customPrompt, syncRestoredSigWithPrompt]);

  // 字符统计
  const sourceCharCount = sourceText.length;
  const isSourceOverLimit = sourceCharCount > TRANSLATION_MAX_CHARS;

  // Guarded setter: warn & truncate when source text exceeds limit
  // 编辑原文同时清除旧错误（恢复自动翻译）
  const handleSetSourceText = useCallback((text: string) => {
    setTranslationError(null);
    if (text.length > TRANSLATION_MAX_CHARS) {
      showGlobalNotification('warning', t('translation:errors.text_too_long', {
        max: TRANSLATION_MAX_CHARS.toLocaleString(),
      }));
      setSourceText(text.slice(0, TRANSLATION_MAX_CHARS));
      return;
    }
    setSourceText(text);
  }, [t]);

  // 拖拽文件读取的序号守卫：快速连续拖入多个文件时只保留最后一次结果
  const fileReadSeqRef = useRef(0);

  // 拖拽文件处理
  const handleFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    const file = files[0]; // 只处理第一个文件
    const fileName = file.name.toLowerCase();
    const seq = ++fileReadSeqRef.current;

    // ★ 大小校验兜底：浏览器拖拽/点击选择路径不经过原生路径校验，
    // 避免超大文件被 FileReader 整体读入内存
    const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_FILE_SIZE) {
      const sizeMB = (MAX_UPLOAD_FILE_SIZE / (1024 * 1024)).toFixed(0);
      showGlobalNotification('error', t('translation:errors.file_too_large_dynamic', { size: sizeMB }));
      return;
    }

    try {
      if (fileName.match(/\.(png|jpg|jpeg|webp)$/)) {
        // 图片：OCR识别
        showGlobalNotification('info', t('translation:toast.ocr_processing'));
        const reader = new FileReader();
        reader.onload = async (e) => {
          if (seq !== fileReadSeqRef.current) return; // 已被更新的拖拽覆盖
          try {
            const dataUrl = e.target?.result as string;
            const extracted = await ocrExtractText({ imageBase64: dataUrl });
            if (seq !== fileReadSeqRef.current) return;
            handleSetSourceText(cleanOcrText(extracted));
            showGlobalNotification('success', t('translation:toast.ocr_success'));
          } catch (error: unknown) {
            if (seq !== fileReadSeqRef.current) return;
            const msg = getErrorMessage(error);
            if (msg === 'OCR_TIMEOUT') {
              showGlobalNotification('warning', t('translation:toast.ocr_failed', { error: t('translation:errors.ocr_timeout_retry') }));
            } else {
              showGlobalNotification('error', t('translation:toast.ocr_failed', { error: msg }));
            }
          }
        };
        reader.onerror = () => {
          if (seq !== fileReadSeqRef.current) return;
          showGlobalNotification('error', t('translation:errors.ocr_failed'));
        };
        reader.readAsDataURL(file);
      } else if (fileName.match(/\.(pdf|docx|txt|md)$/)) {
        // 文档：解析文本
        showGlobalNotification('info', t('translation:toast.parse_processing'));
        const reader = new FileReader();
        reader.onload = async (e) => {
          if (seq !== fileReadSeqRef.current) return;
          try {
            const dataUrl = e.target?.result as string;
            const base64Content = dataUrl.split(',')[1];
            // Tauri v2 默认要求 JS 侧以 camelCase 传参（后端未声明 rename_all = "snake_case"）
            const extracted = await invoke<string>('parse_document_from_base64', {
              fileName: file.name,
              base64Content,
            });
            if (seq !== fileReadSeqRef.current) return;
            handleSetSourceText(extracted);
            showGlobalNotification('success', t('translation:toast.parse_success'));
          } catch (error: unknown) {
            if (seq !== fileReadSeqRef.current) return;
            showGlobalNotification('error', t('translation:toast.parse_failed', { error: getErrorMessage(error) }));
          }
        };
        reader.onerror = () => {
          if (seq !== fileReadSeqRef.current) return;
          showGlobalNotification('error', t('translation:errors.parse_failed'));
        };
        reader.readAsDataURL(file);
      } else {
        showGlobalNotification('error', t('translation:errors.unsupported_format'));
      }
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [t, handleSetSourceText]);

  // ★ A6-06：当前翻译参数的签名（内容+语向+风格参数），用于自动翻译去重
  const buildTranslationSig = useCallback(
    () => JSON.stringify([sourceText, srcLang, tgtLang, customPrompt, formality, domain, glossary]),
    [sourceText, srcLang, tgtLang, customPrompt, formality, domain, glossary]
  );

  // 翻译（使用流式管线）
  const handleTranslate = useCallback(async () => {
    // 防止重复调用
    if (isTranslating) {
      console.warn('[Translation] Translation in progress, ignoring duplicate call');
      return;
    }

    if (!sourceText.trim()) {
      showGlobalNotification('warning', t('translation:errors.empty_text'));
      return;
    }

    // 网络状态检查
    if (!isOnline) {
      setTranslationError(t('translation:errors.offline'));
      showGlobalNotification('warning', t('translation:errors.offline'));
      return;
    }

    // 清除之前的错误状态
    setTranslationError(null);
    setTranslationQuality(null);

    // ★ A6-06：登记本次翻译的参数签名（手动/自动触发都登记），自动翻译据此避免对同一内容重复触发
    lastTranslatedSigRef.current = buildTranslationSig();
    restoredSigPendingPromptRef.current = false;

    try {
      const result = await translationStream.startTranslation({
        text: sourceText,
        src_lang: srcLang,
        tgt_lang: tgtLang,
        prompt_override: customPrompt || undefined,
        formality: formality,
        glossary: glossary.length > 0 ? glossary : undefined,
        domain: domain !== 'general' ? domain : undefined,
      });

      if (result.outcome === 'completed') {
        // 翻译成功，清除错误状态
        setTranslationError(null);
        // 翻译完成后保存会话到 DSTU
        if (dstuMode.onSessionSave) {
          try {
            const now = Date.now();
            // 直接使用 settle 结果携带的权威最终文本，规避 state→ref 晚一帧的竞态
            const sessionToSave: TranslationSession = {
              id: currentSessionIdRef.current || generateTranslationId(),
              sourceText,
              translatedText: result.translatedText,
              srcLang,
              tgtLang,
              formality,
              customPrompt: customPrompt || undefined,
              // domain / glossary 完整传入（含默认值），确保 DSTU metadata 落盘与清空生效
              domain,
              glossary,
              createdAt: initialSession?.createdAt || now,
              updatedAt: now,
            };
            // 保存后更新当前会话 ID
            currentSessionIdRef.current = sessionToSave.id;
            await dstuMode.onSessionSave(sessionToSave);
            markTranslationPersisted(sessionToSave);
          } catch (saveError: unknown) {
            console.error('[Translation] Save failed:', saveError);
            showGlobalNotification('error', t('translation:toast.save_failed'));
          }
        }
      } else if (result.outcome === 'cancelled') {
        showGlobalNotification('info', t('translation:toast.translate_cancelled'));
      }
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      // 组件卸载导致的终止：静默忽略
      if (errorMsg.includes(TRANSLATION_STREAM_UNMOUNTED_ERROR)) {
        return;
      }
      console.error('[Translation] Failed:', error);
      // 设置错误状态以便 UI 显示
      setTranslationError(errorMsg);
      // 忽略重复调用的错误提示
      if (!errorMsg.includes(t('translation:toast.translating_already'))) {
        showGlobalNotification('error', t('translation:toast.translate_failed', { error: errorMsg }));
      }
    } finally {
      setIsRetrying(false);
    }
  }, [sourceText, srcLang, tgtLang, customPrompt, formality, domain, glossary, t, translationStream.startTranslation, isTranslating, dstuMode, initialSession, isOnline, buildTranslationSig, markTranslationPersisted]);

  // 取消流式翻译（按钮 / Esc 快捷键共用；hook 内先本地 settle，反馈即时）
  const handleCancelTranslation = useCallback(() => {
    void translationStream.cancelTranslation();
  }, [translationStream.cancelTranslation]);

  // 重试翻译
  const handleRetryTranslation = useCallback(() => {
    setIsRetrying(true);
    setTranslationError(null);
    handleTranslate();
  }, [handleTranslate]);

  // 保存Prompt
  const handleSavePrompt = useCallback(async () => {
    try {
      await TauriAPI.saveSetting('translation.prompt', customPrompt);
      showGlobalNotification('success', t('translation:prompt_editor.saved'));
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [customPrompt, t]);

  // 恢复默认Prompt
  const handleRestoreDefaultPrompt = useCallback(() => {
    setCustomPrompt(t('translation:prompt_editor.default_prompt'));
  }, [t]);

  // 复制翻译结果
  const handleCopyResult = useCallback(async () => {
    try {
      await copyTextToClipboard(translatedText);
      showGlobalNotification('success', t('translation:target_section.copied'));
    } catch (error: unknown) {
      console.error('[Translation] Failed to copy:', error);
      showGlobalNotification('error', t('translation:errors.copy_failed', { error: getErrorMessage(error) }));
    }
  }, [translatedText, t]);

  // 交换源语言和目标语言（auto 模式下若已有检测结果，用检测语言交换 —— 对齐 DeepL）
  // 流式进行中 / 编辑译文时禁止交换：交换会改写 translatedText，
  // 与流式累计缓冲或未保存的编辑内容互相踩踏
  const handleSwapLanguages = useCallback(() => {
    if (isTranslating || isEditingTranslation) return;
    const effectiveSrcLang = srcLang === 'auto' ? detectedLang : srcLang;
    if (!effectiveSrcLang) {
      showGlobalNotification('warning', t('translation:errors.cannot_swap_auto'));
      return;
    }
    setSrcLang(tgtLang);
    setTgtLang(effectiveSrcLang);
    // 同时交换文本（清除旧错误，让自动翻译对交换后的内容重新生效）
    const tempText = sourceText;
    setSourceText(translatedText);
    setTranslatedText(tempText);
    setTranslationError(null);
  }, [srcLang, tgtLang, sourceText, translatedText, detectedLang, t, setTranslatedText, isTranslating, isEditingTranslation]);

  // 自动翻译逻辑（智能 debounce：短文本快速触发，长文本延迟触发）
  // deps 包含所有影响翻译结果的参数，修改设置时也会重新触发
  useEffect(() => {
    if (isAutoTranslate && sourceText.trim() && !isTranslating && !translationError) {
      // ★ A6-06：内容与参数均未变化时不再触发——否则翻译完成 → isTranslating 翻转 →
      // effect 重跑 → 同一文本被无限次重译（持续消耗 API 配额）
      if (buildTranslationSig() === lastTranslatedSigRef.current) {
        return;
      }
      const len = sourceText.length;
      const delay = len < 200 ? 1500 : len < 1000 ? 2500 : 4000;
      const timer = setTimeout(() => {
        handleTranslate();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [sourceText, srcLang, tgtLang, formality, domain, glossary, isAutoTranslate, isTranslating, translationError, handleTranslate, buildTranslationSig]);

  // 编辑译文
  const handleEditTranslation = useCallback(() => {
    setIsEditingTranslation(true);
    setEditedTranslation(translatedText);
  }, [translatedText]);

  const handleSaveEditedTranslation = useCallback(async () => {
    if (!navigator.onLine) {
      showGlobalNotification('warning', t('translation:errors.offline_save'));
      return;
    }
    try {
      // 更新前端状态
      setTranslatedText(editedTranslation);
      setIsEditingTranslation(false);
      
      // 通过回调保存到 DSTU
      if (dstuMode.onSessionSave && currentSessionIdRef.current) {
        const now = Date.now();
        const sessionToSave: TranslationSession = {
          id: currentSessionIdRef.current,
          sourceText,
          translatedText: editedTranslation,
          srcLang,
          tgtLang,
          formality,
          customPrompt: customPrompt || undefined,
          domain,
          glossary,
          quality: translationQuality ?? undefined,
          createdAt: initialSession?.createdAt || now,
          updatedAt: now,
        };
        await dstuMode.onSessionSave(sessionToSave);
        markTranslationPersisted(sessionToSave);
      }
      showGlobalNotification('success', t('translation:target_section.edit_saved'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('translation:toast.update_failed', { error: getErrorMessage(error) }));
    }
  }, [editedTranslation, t, setTranslatedText, dstuMode, sourceText, srcLang, tgtLang, formality, domain, glossary, customPrompt, translationQuality, initialSession, markTranslationPersisted]);

  const handleCancelEdit = useCallback(() => {
    setIsEditingTranslation(false);
    setEditedTranslation('');
  }, []);

  const handleExportTranslation = useCallback(async () => {
    try {
      const date = new Date().toLocaleString();
      const srcName = t(`translation:languages.${srcLang}`, { defaultValue: srcLang });
      const tgtName = t(`translation:languages.${tgtLang}`, { defaultValue: tgtLang });
      const domainName = domain !== 'general' ? t(`translation:prompt_editor.domain_${domain}`, { defaultValue: domain }) : '';

      // Markdown bilingual format
      const lines: string[] = [
        `# ${t('translation:export.markdown_title')}`,
        ``,
        `| | |`,
        `|---|---|`,
        `| **${t('translation:languages.source_lang')}** | ${srcName} |`,
        `| **${t('translation:languages.target_lang')}** | ${tgtName} |`,
      ];
      if (domainName) lines.push(`| **${t('translation:prompt_editor.domain')}** | ${domainName} |`);
      lines.push(`| **${t('translation:export.date_label')}** | ${date} |`, ``);

      if (glossary.length > 0) {
        lines.push(`## ${t('translation:prompt_editor.glossary_title')}`, ``);
        lines.push(`| ${t('translation:prompt_editor.glossary_source')} | ${t('translation:prompt_editor.glossary_target')} |`);
        lines.push(`|---|---|`);
        for (const [src, tgt] of glossary) {
          lines.push(`| ${src.replace(/\|/g, '\\|')} | ${tgt.replace(/\|/g, '\\|')} |`);
        }
        lines.push(``);
      }

      lines.push(
        `## ${srcName}`, ``,
        sourceText, ``,
        `## ${tgtName}`, ``,
        translatedText, ``,
      );

      const content = lines.join('\n');

      const result = await fileManager.saveTextFile({
        title: t('translation:target_section.export_title'),
        defaultFileName: `translation_${new Date().getTime()}.md`,
        filters: [
          { name: t('translation:export.file_filters.markdown'), extensions: ['md'] },
          { name: t('translation:export.file_filters.text'), extensions: ['txt'] },
        ],
        content,
      });
      if (result.canceled) return;
      showGlobalNotification('success', t('translation:target_section.exported'));
    } catch (error: unknown) {
      console.error('[Translation] Failed to export:', error);
      showGlobalNotification('error', t('translation:errors.export_failed', { error: getErrorMessage(error) }));
    }
  }, [sourceText, translatedText, srcLang, tgtLang, domain, glossary, t]);

  // 朗读译文
  const handleSpeak = useCallback(async () => {
    if (!TTS.isTTSSupported()) {
      showGlobalNotification('error', t('translation:errors.tts_not_supported'));
      return;
    }

    // 使用 ref 避免 stale closure，防止多次点击重复播放
    if (isSpeakingRef.current) {
      TTS.stop();
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    if (!translatedText.trim()) {
      showGlobalNotification('warning', t('translation:errors.no_text_to_speak'));
      return;
    }

    const myId = ++speakIdRef.current;
    try {
      isSpeakingRef.current = true;
      setIsSpeaking(true);
      const langCode = TTS.getFullLanguageCode(tgtLang);
      await TTS.speak(translatedText, { lang: langCode });
    } catch (error: unknown) {
      showGlobalNotification('error', t('translation:errors.tts_failed', { error: getErrorMessage(error) }));
    } finally {
      // 只有当前活跃的播放会话才更新状态，防止旧 promise 覆盖新会话
      if (speakIdRef.current === myId) {
        isSpeakingRef.current = false;
        setIsSpeaking(false);
      }
    }
  }, [translatedText, tgtLang, t]);

  // 停止朗读
  useEffect(() => {
    return () => {
      // 组件卸载时停止朗读
      (async () => {
        try {
          await TTS.stop();
        } catch (error: unknown) {
          console.warn('[Translation] Failed to stop TTS:', error);
        }
      })();
    };
  }, []);

  // 翻译质量评分
  const handleRateTranslation = useCallback(async (rating: number) => {
    if (!navigator.onLine) {
      showGlobalNotification('warning', t('translation:errors.offline_rate'));
      return;
    }
    setTranslationQuality(rating);
    
    // 通过回调保存评分到 DSTU
    if (dstuMode.onSessionSave && currentSessionIdRef.current) {
      try {
        const now = Date.now();
        const sessionToSave: TranslationSession = {
          id: currentSessionIdRef.current,
          sourceText,
          translatedText,
          srcLang,
          tgtLang,
          formality,
          customPrompt: customPrompt || undefined,
          domain,
          glossary,
          quality: rating,
          createdAt: initialSession?.createdAt || now,
          updatedAt: now,
        };
        await dstuMode.onSessionSave(sessionToSave);
        markTranslationPersisted(sessionToSave);
        showGlobalNotification('success', t('translation:quality.rated'));
      } catch (error: unknown) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    }
  }, [t, dstuMode, sourceText, translatedText, srcLang, tgtLang, formality, domain, glossary, customPrompt, initialSession, markTranslationPersisted]);

  // 快捷键支持（注册在 document 上，处理后 stopPropagation 阻止冒泡到命令系统）
  // ★ A6-28 标签页保活：非活跃实例不注册，防止多个翻译标签页同时响应同一按键
  //   （对齐 MindMapContentView/MindMapCanvas 的 isActive 守卫；isActive 未传时视为活跃）
  useEffect(() => {
    if (isActive === false) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Enter: 翻译
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (sourceText.trim() && !isTranslating) {
          handleTranslate();
        }
        return;
      }
      // Ctrl/Cmd + Shift + S: 交换语言（auto 模式下用检测结果交换，handleSwapLanguages 自守卫）
      // key 大小写随 CapsLock / 输入法状态浮动，统一小写比较
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        handleSwapLanguages();
        return;
      }
      // Esc: 依次处理 —— 取消流式翻译 → 取消编辑
      if (e.key === 'Escape') {
        if (isTranslating) {
          e.preventDefault();
          e.stopPropagation();
          handleCancelTranslation();
          return;
        }
        if (isEditingTranslation) {
          e.preventDefault();
          e.stopPropagation();
          handleCancelEdit();
          return;
        }
        return;
      }
      // 注：已移除 Cmd+K 清空快捷键（与命令面板冲突）
      // 清空功能通过 UI 按钮提供
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sourceText, isTranslating, isEditingTranslation, handleTranslate, handleSwapLanguages, handleCancelEdit, handleCancelTranslation, isActive]);

  // 清空逻辑：内联确认由 SourcePanel 承载（单次确认），此处执行真正的清空
  // 清空同时重置错误/编辑/评分/自动翻译签名，避免「清空后粘贴相同文本不再自动翻译」
  const doClear = useCallback(() => {
    setSourceText('');
    setTranslatedText('');
    setTranslationQuality(null);
    setTranslationError(null);
    setIsEditingTranslation(false);
    setEditedTranslation('');
    lastTranslatedSigRef.current = null;
    restoredSigPendingPromptRef.current = false;
  }, [setTranslatedText]);

  // 取消残留的部分译文：清除文本（保留原文），或仅关闭提示
  const handleDiscardPartial = useCallback(() => {
    setTranslatedText('');
  }, [setTranslatedText]);

  const detectedLangName = detectedLang
    ? t(`translation:languages.${detectedLang}`, { defaultValue: detectedLang })
    : null;

  const shortcutHints: Array<{ combo: string; label: string; visible: boolean }> = [
    { combo: `${MOD_KEY_LABEL}+Enter`, label: t('translation:workbench_ui.shortcut_translate'), visible: true },
    { combo: `${MOD_KEY_LABEL}+Shift+S`, label: t('translation:workbench_ui.shortcut_swap'), visible: true },
    { combo: 'Esc', label: t('translation:workbench_ui.shortcut_cancel'), visible: isTranslating },
  ];

  return (
      <div className="w-full h-full flex-1 min-h-0 bg-background flex flex-col overflow-hidden">
        <MacTopSafeDragZone className="translate-top-safe-drag-zone" />

        {/* 离线状态提示 */}
        {!isOnline && (
          <div className="flex items-center gap-2 px-4 py-2 bg-warning/10 border-b border-warning/20 text-warning ui-drop-in">
            <WifiSlash size={16} className="shrink-0" />
            <span className="text-sm">{t('translation:errors.offline')}</span>
          </div>
        )}

        {/* 翻译错误提示（内联错误条 + 重试） */}
        {translationError && !isTranslating && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20 ui-drop-in">
            <div className="flex items-center gap-2 text-destructive min-w-0">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm truncate">{translationError}</span>
            </div>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleRetryTranslation}
              disabled={isRetrying || !isOnline}
              className="shrink-0 text-destructive hover:bg-destructive/10"
            >
              <ArrowClockwise className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} />
              {t('common:retry')}
            </DsButton>
          </div>
        )}

        {/* 取消翻译后的部分结果提示（内联信息条） */}
        {isPartialResult && !isTranslating && !translationError && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-info/10 border-b border-info/20 ui-drop-in">
            <div className="flex items-center gap-2 text-info min-w-0">
              <Info size={16} className="shrink-0" />
              <span className="text-sm truncate">{t('translation:workbench_ui.cancelled_partial')}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleDiscardPartial}
                className="text-info hover:bg-info/10"
              >
                {t('translation:workbench_ui.discard_partial')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={translationStream.acknowledgePartialResult}
                className="text-muted-foreground"
              >
                {t('translation:workbench_ui.dismiss')}
              </DsButton>
            </div>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 min-h-0 flex flex-col relative">
          <TranslationMain
              srcLang={srcLang}
              setSrcLang={setSrcLang}
              tgtLang={tgtLang}
              setTgtLang={setTgtLang}
              sourceText={sourceText}
              setSourceText={handleSetSourceText}
              sourceMaxChars={TRANSLATION_MAX_CHARS}
              isSourceOverLimit={isSourceOverLimit}
              translatedText={translatedText}
              isTranslating={isTranslating}
              customPrompt={customPrompt}
              setCustomPrompt={setCustomPrompt}
              showPromptEditor={showPromptEditor}
              setShowPromptEditor={setShowPromptEditor}
              formality={formality}
              setFormality={setFormality}
              domain={domain}
              setDomain={setDomain}
              glossary={glossary}
              setGlossary={setGlossary}
              isEditingTranslation={isEditingTranslation}
              editedTranslation={editedTranslation}
              setEditedTranslation={setEditedTranslation}
              translationQuality={translationQuality}
              isSpeaking={isSpeaking}
              detectedLang={detectedLang}
              autoFocusSource={isActive !== false}
              isAutoTranslate={isAutoTranslate}
              setIsAutoTranslate={setIsAutoTranslate}
              isSyncScroll={isSyncScroll}
              setIsSyncScroll={setIsSyncScroll}
              onSwapLanguages={handleSwapLanguages}
              onFilesDropped={handleFilesDropped}
              onSavePrompt={handleSavePrompt}
              onRestoreDefaultPrompt={handleRestoreDefaultPrompt}
              onTranslate={handleTranslate}
              onCancelTranslation={handleCancelTranslation}
              onClear={doClear}
              onEditTranslation={handleEditTranslation}
              onSaveEditedTranslation={handleSaveEditedTranslation}
              onCancelEdit={handleCancelEdit}
              onSpeak={handleSpeak}
              onCopyResult={handleCopyResult}
              onExportTranslation={handleExportTranslation}
              onRateTranslation={handleRateTranslation}
/>
        </div>

        {/* 底部状态条：检测语言回显 + 快捷键提示（桌面） */}
        <div className="hidden md:flex items-center justify-between gap-3 px-4 py-1 border-t border-border/50 text-xs text-muted-foreground select-none shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {srcLang === 'auto' && detectedLangName && (
              <span className="flex items-center gap-1.5 truncate">
                <Translate size={12} className="shrink-0" />
                {t('translation:workbench_ui.detected_language', { language: detectedLangName })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {shortcutHints.filter((hint) => hint.visible).map((hint) => (
              <span key={hint.combo} className="flex items-center gap-1">
                <kbd className="rounded-sm border border-border/60 bg-muted/40 px-1 leading-tight font-sans">
                  {hint.combo}
                </kbd>
                {hint.label}
              </span>
            ))}
          </div>
        </div>
      </div>
  );
};

export default TranslateWorkbench;
