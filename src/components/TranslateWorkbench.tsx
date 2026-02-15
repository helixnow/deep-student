import React, { useState, useCallback, useEffect, useRef } from 'react';
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
import { useTranslationStream } from '../translation/useTranslationStream';
import * as TTS from '../utils/tts';
import { fileManager } from '../utils/fileManager';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';
import { AlertCircle, RefreshCw, WifiOff } from 'lucide-react';
import { NotionButton } from './ui/NotionButton';

import { debugLog } from '../debug-panel/debugMasterSwitch';

// 子组件
import { TranslationMain } from './translation/TranslationMain';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** Maximum characters allowed for source text input */
const TRANSLATION_MAX_CHARS = 50000;

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
 * 翻译工作台 Props
 *
 * 仅支持 DSTU 模式，由 Learning Hub 管理历史记录
 */
export interface TranslateWorkbenchDstuMode {
  /** 当前翻译会话（null 表示新建） */
  session: TranslationSession | null;
  /** 会话保存回调 */
  onSessionSave?: (session: TranslationSession) => Promise<void>;
}

interface TranslateWorkbenchProps {
  onBack?: () => void;
  /** DSTU 模式配置（必需） */
  dstuMode: TranslateWorkbenchDstuMode;
}

export const TranslateWorkbench: React.FC<TranslateWorkbenchProps> = ({ onBack, dstuMode }) => {
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

  // 布局状态
  const [isMaximized, setIsMaximized] = useState(false);
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false);

  // 左栏状态（从 session 初始化）
  const [sourceText, setSourceText] = useState(initialSession?.sourceText || '');
  const [srcLang, setSrcLang] = useState(initialSession?.srcLang || 'auto');
  const [tgtLang, setTgtLang] = useState(initialSession?.tgtLang || 'zh-CN');
  const [customPrompt, setCustomPrompt] = useState('');
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [formality, setFormality] = useState<'formal' | 'casual' | 'auto'>(initialSession?.formality || 'auto');
  const [domain, setDomain] = useState<string>(initialSession?.domain || 'general');
  const [glossary, setGlossary] = useState<Array<[string, string]>>(initialSession?.glossary || []);

  // 右栏状态
  const [isEditingTranslation, setIsEditingTranslation] = useState(false);
  const [editedTranslation, setEditedTranslation] = useState('');
  const [translationQuality, setTranslationQuality] = useState<number | null>(initialSession?.quality || null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isSpeakingRef = useRef(false);
  const speakIdRef = useRef(0);

  const [isSyncScroll, setIsSyncScroll] = useState(true);
  const [isAutoTranslate, setIsAutoTranslate] = useState(false);

  // 错误状态管理
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

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
    const handleToggleSettings = () => {
      setShowPromptEditor(prev => !prev);
    };
    window.addEventListener('translation:openSettings', handleToggleSettings);
    return () => {
      window.removeEventListener('translation:openSettings', handleToggleSettings);
    };
  }, []);

  // 使用流式状态
  const translatedText = translationStream.translatedText;
  const isTranslating = translationStream.isTranslating;
  const setTranslatedText = translationStream.setTranslatedText;
  const streamError = translationStream.error;

  // 使用 ref 跟踪最新的翻译文本，避免 stale closure 问题
  const translatedTextRef = useRef(translatedText);
  useEffect(() => {
    translatedTextRef.current = translatedText;
  }, [translatedText]);

  // 同步流式管线的错误状态到本地
  useEffect(() => {
    if (streamError) {
      setTranslationError(streamError);
    }
  }, [streamError]);

  // 初始化会话数据（编辑已有记录时）
  useEffect(() => {
    if (initialSession?.id) {
      // 同步原文
      if (initialSession.sourceText) {
        setSourceText(initialSession.sourceText);
      }
      // 同步译文
      if (initialSession.translatedText) {
        setTranslatedText(initialSession.translatedText);
      }
      // 同步语言设置
      if (initialSession.srcLang) {
        setSrcLang(initialSession.srcLang);
      }
      if (initialSession.tgtLang) {
        setTgtLang(initialSession.tgtLang);
      }
      // 同步正式度
      if (initialSession.formality) {
        setFormality(initialSession.formality);
      }
      // 同步领域
      setDomain(initialSession.domain || 'general');
      // 同步术语表
      setGlossary(initialSession.glossary || []);
      // 同步质量评分
      if (initialSession.quality !== undefined) {
        setTranslationQuality(initialSession.quality);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession?.id]);

  // 加载自定义 Prompt
  useEffect(() => {
    const loadPrompt = async () => {
      // 优先使用 session 中的自定义提示词
      if (initialSession?.customPrompt) {
        setCustomPrompt(initialSession.customPrompt);
        return;
      }
      try {
        const saved = await TauriAPI.getSetting('translation.prompt');
        setCustomPrompt(saved || t('translation:prompt_editor.default_prompt'));
      } catch (error: unknown) {
        console.error('[Translation] Failed to load prompt:', error);
        setCustomPrompt(t('translation:prompt_editor.default_prompt'));
      }
    };
    loadPrompt();
  }, [t, initialSession?.customPrompt]);

  // 字符统计
  const sourceCharCount = sourceText.length;
  const sourceWordCount = sourceText.trim() ? sourceText.trim().split(/\s+/).length : 0;
  const isSourceOverLimit = sourceCharCount > TRANSLATION_MAX_CHARS;

  // Guarded setter: warn & truncate when source text exceeds limit
  const handleSetSourceText = useCallback((text: string) => {
    if (text.length > TRANSLATION_MAX_CHARS) {
      showGlobalNotification('warning', t('translation:errors.text_too_long', {
        max: TRANSLATION_MAX_CHARS.toLocaleString(),
        defaultValue: `Text exceeds maximum of ${TRANSLATION_MAX_CHARS.toLocaleString()} characters and will be truncated.`,
      }));
      setSourceText(text.slice(0, TRANSLATION_MAX_CHARS));
      return;
    }
    setSourceText(text);
  }, [t]);

  // 拖拽文件处理
  const handleFilesDropped = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    const file = files[0]; // 只处理第一个文件
    const fileName = file.name.toLowerCase();

    try {
      if (fileName.match(/\.(png|jpg|jpeg|webp)$/)) {
        // 图片：OCR识别
        showGlobalNotification('info', t('translation:toast.ocr_processing'));
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const dataUrl = e.target?.result as string;
            const base64Content = dataUrl.split(',')[1];
            const extracted = await ocrExtractText({ imageBase64: base64Content });
            handleSetSourceText(cleanOcrText(extracted));
            showGlobalNotification('success', t('translation:toast.ocr_success'));
          } catch (error: unknown) {
            showGlobalNotification('error', t('translation:toast.ocr_failed', { error: getErrorMessage(error) }));
          }
        };
        reader.readAsDataURL(file);
      } else if (fileName.match(/\.(pdf|docx|txt|md)$/)) {
        // 文档：解析文本
        showGlobalNotification('info', t('translation:toast.parse_processing'));
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const dataUrl = e.target?.result as string;
            const base64Content = dataUrl.split(',')[1];
            const extracted = await invoke<string>('parse_document_from_base64', {
              file_name: file.name,
              base64_content: base64Content,
            });
            handleSetSourceText(extracted);
            showGlobalNotification('success', t('translation:toast.parse_success'));
          } catch (error: unknown) {
            showGlobalNotification('error', t('translation:toast.parse_failed', { error: getErrorMessage(error) }));
          }
        };
        reader.readAsDataURL(file);
      } else {
        showGlobalNotification('error', t('translation:errors.unsupported_format'));
      }
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [t, handleSetSourceText]);

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

    try {
      const outcome = await translationStream.startTranslation({
        text: sourceText,
        src_lang: srcLang,
        tgt_lang: tgtLang,
        prompt_override: customPrompt || undefined,
        formality: formality,
        glossary: glossary.length > 0 ? glossary : undefined,
        domain: domain !== 'general' ? domain : undefined,
      });

      if (outcome === 'completed') {
        // 翻译成功，清除错误状态
        setTranslationError(null);
        // 翻译完成后保存会话到 DSTU
        if (dstuMode.onSessionSave) {
          try {
            const now = Date.now();
            // 使用 ref 获取最新的翻译文本，避免 stale closure 问题
            const latestTranslatedText = translatedTextRef.current;
            const sessionToSave: TranslationSession = {
              id: currentSessionIdRef.current || generateTranslationId(),
              sourceText,
              translatedText: latestTranslatedText,
              srcLang,
              tgtLang,
              formality,
              customPrompt: customPrompt || undefined,
              domain: domain !== 'general' ? domain : undefined,
              glossary: glossary.length > 0 ? glossary : undefined,
              createdAt: initialSession?.createdAt || now,
              updatedAt: now,
            };
            // 保存后更新当前会话 ID
            currentSessionIdRef.current = sessionToSave.id;
            await dstuMode.onSessionSave(sessionToSave);
          } catch (saveError: unknown) {
            console.error('[Translation] Save failed:', saveError);
            showGlobalNotification('error', t('translation:toast.save_failed', '翻译结果保存失败，请重试'));
          }
        }
      } else if (outcome === 'cancelled') {
        showGlobalNotification('info', t('translation:toast.translate_cancelled'));
      }
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
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
  }, [sourceText, srcLang, tgtLang, customPrompt, formality, domain, glossary, t, translationStream.startTranslation, isTranslating, dstuMode, initialSession, isOnline]);

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
      await navigator.clipboard.writeText(translatedText);
      showGlobalNotification('success', t('translation:target_section.copied'));
    } catch (error: unknown) {
      console.error('[Translation] Failed to copy:', error);
      showGlobalNotification('error', t('translation:errors.copy_failed', { error: getErrorMessage(error) }));
    }
  }, [translatedText, t]);

  // 交换源语言和目标语言
  const handleSwapLanguages = useCallback(() => {
    if (srcLang === 'auto') {
      showGlobalNotification('warning', t('translation:errors.cannot_swap_auto'));
      return;
    }
    const tempLang = srcLang;
    setSrcLang(tgtLang);
    setTgtLang(tempLang);
    // 同时交换文本
    const tempText = sourceText;
    setSourceText(translatedText);
    setTranslatedText(tempText);
  }, [srcLang, tgtLang, sourceText, translatedText, t, setTranslatedText]);

  // 自动翻译逻辑（智能 debounce：短文本快速触发，长文本延迟触发）
  // deps 包含所有影响翻译结果的参数，修改设置时也会重新触发
  useEffect(() => {
    if (isAutoTranslate && sourceText.trim() && !isTranslating && !translationError) {
      const len = sourceText.length;
      const delay = len < 200 ? 1500 : len < 1000 ? 2500 : 4000;
      const timer = setTimeout(() => {
        handleTranslate();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [sourceText, srcLang, tgtLang, formality, domain, glossary, isAutoTranslate, isTranslating, translationError, handleTranslate]);

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
        await dstuMode.onSessionSave({
          id: currentSessionIdRef.current,
          sourceText,
          translatedText: editedTranslation,
          srcLang,
          tgtLang,
          formality,
          customPrompt: customPrompt || undefined,
          domain: domain !== 'general' ? domain : undefined,
          glossary: glossary.length > 0 ? glossary : undefined,
          quality: translationQuality ?? undefined,
          createdAt: initialSession?.createdAt || now,
          updatedAt: now,
        });
      }
      showGlobalNotification('success', t('translation:target_section.edit_saved'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('translation:toast.update_failed', { error: getErrorMessage(error) }));
    }
  }, [editedTranslation, t, setTranslatedText, dstuMode, sourceText, srcLang, tgtLang, formality, domain, glossary, customPrompt, translationQuality, initialSession]);

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
        `# Translation`,
        ``,
        `| | |`,
        `|---|---|`,
        `| **${t('translation:languages.source_lang')}** | ${srcName} |`,
        `| **${t('translation:languages.target_lang')}** | ${tgtName} |`,
      ];
      if (domainName) lines.push(`| **${t('translation:prompt_editor.domain')}** | ${domainName} |`);
      lines.push(`| **Date** | ${date} |`, ``);

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
        title: t('translation:target_section.export_title', { defaultValue: 'Export Translation' }),
        defaultFileName: `translation_${new Date().getTime()}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
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
        await dstuMode.onSessionSave({
          id: currentSessionIdRef.current,
          sourceText,
          translatedText,
          srcLang,
          tgtLang,
          formality,
          customPrompt: customPrompt || undefined,
          domain: domain !== 'general' ? domain : undefined,
          glossary: glossary.length > 0 ? glossary : undefined,
          quality: rating,
          createdAt: initialSession?.createdAt || now,
          updatedAt: now,
        });
        showGlobalNotification('success', t('translation:quality.rated'));
      } catch (error: unknown) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    }
  }, [t, dstuMode, sourceText, translatedText, srcLang, tgtLang, formality, domain, glossary, customPrompt, initialSession]);

  // 快捷键支持（注册在 document 上，处理后 stopPropagation 阻止冒泡到命令系统）
  useEffect(() => {
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
      // Ctrl/Cmd + Shift + S: 交换语言
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        e.stopPropagation();
        if (srcLang !== 'auto') {
          handleSwapLanguages();
        }
        return;
      }
      // Esc: 取消编辑
      if (e.key === 'Escape' && isEditingTranslation) {
        e.preventDefault();
        e.stopPropagation();
        handleCancelEdit();
        return;
      }
      // 注：已移除 Cmd+K 清空快捷键（与命令面板冲突）
      // 清空功能通过 UI 按钮提供
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sourceText, isTranslating, srcLang, isEditingTranslation, handleTranslate, handleSwapLanguages, handleCancelEdit]);

  return (
      <div className="w-full h-full flex-1 min-h-0 bg-[hsl(var(--background))] flex flex-col overflow-hidden">
        <MacTopSafeDragZone className="translate-top-safe-drag-zone" />

        {/* 离线状态提示 */}
        {!isOnline && (
          <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-600 dark:text-yellow-400">
            <WifiOff className="h-4 w-4 shrink-0" />
            <span className="text-sm">{t('translation:errors.offline')}</span>
          </div>
        )}

        {/* 翻译错误提示 */}
        {translationError && !isTranslating && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 min-w-0">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="text-sm truncate">{translationError}</span>
            </div>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={handleRetryTranslation}
              disabled={isRetrying || !isOnline}
              className="shrink-0 text-red-600 dark:text-red-400 hover:bg-red-500/10"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} />
              {t('common:retry')}
            </NotionButton>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 min-h-0 flex flex-col relative">
          <TranslationMain
              isMaximized={isMaximized}
              setIsMaximized={setIsMaximized}
              isSourceCollapsed={isSourceCollapsed}
              setIsSourceCollapsed={setIsSourceCollapsed}
              srcLang={srcLang}
              setSrcLang={setSrcLang}
              tgtLang={tgtLang}
              setTgtLang={setTgtLang}
              sourceText={sourceText}
              setSourceText={handleSetSourceText}
              sourceMaxChars={TRANSLATION_MAX_CHARS}
              isSourceOverLimit={isSourceOverLimit}
              translatedText={translatedText}
              setTranslatedText={setTranslatedText}
              isTranslating={isTranslating}
              translationProgress={0}
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
              charCount={sourceCharCount}
              wordCount={sourceWordCount}
              isAutoTranslate={isAutoTranslate}
              setIsAutoTranslate={setIsAutoTranslate}
              isSyncScroll={isSyncScroll}
              setIsSyncScroll={setIsSyncScroll}
              onSwapLanguages={handleSwapLanguages}
              onFilesDropped={handleFilesDropped}
              onSavePrompt={handleSavePrompt}
              onRestoreDefaultPrompt={handleRestoreDefaultPrompt}
              onTranslate={handleTranslate}
              onCancelTranslation={() => translationStream.cancelTranslation()}
              onClear={() => {
                if (sourceText && !window.confirm(t('translation:confirm.clear', '确定清空所有内容？'))) return;
                setSourceText(''); setTranslatedText(''); setTranslationQuality(null);
              }}
              onEditTranslation={handleEditTranslation}
              onSaveEditedTranslation={handleSaveEditedTranslation}
              onCancelEdit={handleCancelEdit}
              onSpeak={handleSpeak}
              onCopyResult={handleCopyResult}
              onExportTranslation={handleExportTranslation}
              onRateTranslation={handleRateTranslation}
            />
        </div>
      </div>
  );
};

export default TranslateWorkbench;
