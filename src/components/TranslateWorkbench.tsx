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
import { isWebUiShell } from '@/utils/platform';
import { MacTopSafeDragZone } from './layout/MacTopSafeDragZone';
import { WarningCircle, ArrowClockwise, WifiSlash, Info, Translate } from '@phosphor-icons/react';
import { DsButton } from './ui/DsButton';

import { debugLog } from '../debug-panel/debugMasterSwitch';

// 子组件
import { TranslationMain } from './translation/TranslationMain';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { DEFAULT_MAX_UPLOAD_FILE_SIZE } from '@/components/shared/UnifiedDragDropZone';
import {
  registerContentDirtyChecker,
  registerContentSaveHandler,
} from '@/features/workbench/apps/content/contentDirtyRegistry';
import {
  buildTranslationStateSignature,
  clearTranslationDraftSnapshot,
  computeTranslationSourceHash,
  detectClearSourceLanguageMismatch,
  isVerbatimUntranslatedOutput,
  resolveSessionPrefs,
  sanitizeTranslationSyncedMeta,
  saveTranslationDraftSnapshot,
  type TranslationSyncedMeta,
} from '@/translation/sessionPrefs';
import {
  DOMAIN_DEFAULT_PROMPT_KEYS,
  isPromptCustomized as isPromptCustomizedBy,
  promptAfterDomainSwitch,
  promptForSessionLoad,
} from '@/translation/promptPresets';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** Maximum characters allowed for source text input */
const TRANSLATION_MAX_CHARS = 50000;

/** localStorage key：工作台偏好（自动翻译/同步滚动/默认语向/正式度） */
const WORKBENCH_PREFS_KEY = 'translation.workbench.prefs';

/** localStorage key prefix：单会话译文版本历史与正式度恢复快照（跨刷新持久化） */
const VERSION_HISTORY_STORAGE_PREFIX = 'ds.translation.versions.v1.';
const MAX_TRANSLATION_VERSION_HISTORY = 5;

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl';

export type TranslationFormalityValue = 'formal' | 'casual' | 'auto';

export interface TranslationVersionEntry {
  id: string;
  translatedText: string;
  sourceText: string;
  sourceHash: string;
  srcLang: string;
  tgtLang: string;
  formality: TranslationFormalityValue;
  domain: string;
  glossary?: Array<[string, string]>;
  customPrompt?: string;
  savedAt: number;
}

export interface PersistedTranslationWorkbenchState {
  versionHistory: TranslationVersionEntry[];
  undoBannerDismissed: boolean;
  srcLang?: string;
  tgtLang?: string;
  langUpdatedAt?: number;
  formality?: TranslationFormalityValue;
  formalityUpdatedAt?: number;
  domain?: string;
  activeMeta?: TranslationSyncedMeta;
  updatedAt: number;
}

interface WorkbenchPrefs {
  autoTranslate?: boolean;
  syncScroll?: boolean;
  srcLang?: string;
  tgtLang?: string;
  formality?: TranslationFormalityValue;
}

export function normalizeTranslationFormality(value: unknown): TranslationFormalityValue | undefined {
  if (value === 'formal') return 'formal';
  if (value === 'casual' || value === 'informal') return 'casual';
  if (value === 'auto') return 'auto';
  return undefined;
}

function toEpochMsSafe(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function hashSourceTextForFallbackKey(sourceText: string): string {
  const normalized = sourceText.trim().slice(0, 2000);
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function sanitizeGlossaryList(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
      pairs.push([item[0], item[1]]);
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

function sanitizeVersionHistory(value: unknown): TranslationVersionEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TranslationVersionEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.translatedText !== 'string' || !rec.translatedText.trim()) continue;
    const sourceText = typeof rec.sourceText === 'string' ? rec.sourceText : '';
    const sourceHash =
      typeof rec.sourceHash === 'string' && rec.sourceHash
        ? rec.sourceHash
        : computeTranslationSourceHash(sourceText);
    const glossary = sanitizeGlossaryList(rec.glossary);
    const customPrompt =
      typeof rec.customPrompt === 'string' && rec.customPrompt.trim() ? rec.customPrompt : undefined;
    entries.push({
      id: typeof rec.id === 'string' && rec.id ? rec.id : `ver_${entries.length}`,
      translatedText: rec.translatedText,
      sourceText,
      sourceHash,
      srcLang: typeof rec.srcLang === 'string' && rec.srcLang ? rec.srcLang : 'auto',
      tgtLang: typeof rec.tgtLang === 'string' && rec.tgtLang ? rec.tgtLang : 'zh-CN',
      formality: normalizeTranslationFormality(rec.formality) ?? 'auto',
      domain: typeof rec.domain === 'string' && rec.domain ? rec.domain : 'general',
      ...(glossary ? { glossary } : {}),
      ...(customPrompt ? { customPrompt } : {}),
      savedAt: typeof rec.savedAt === 'number' && Number.isFinite(rec.savedAt) ? rec.savedAt : 0,
    });
    if (entries.length >= MAX_TRANSLATION_VERSION_HISTORY) break;
  }
  return entries;
}

export type TranslationVersionInput = Omit<TranslationVersionEntry, 'sourceHash'> & {
  sourceHash?: string;
};

export function pushTranslationVersion(
  history: TranslationVersionEntry[],
  rawEntry: TranslationVersionInput,
): TranslationVersionEntry[] {
  if (!rawEntry.translatedText.trim()) return history;
  const entry: TranslationVersionEntry = {
    ...rawEntry,
    sourceHash: rawEntry.sourceHash || computeTranslationSourceHash(rawEntry.sourceText),
  };
  const top = history[0];
  if (
    top &&
    top.translatedText === entry.translatedText &&
    top.srcLang === entry.srcLang &&
    top.tgtLang === entry.tgtLang &&
    top.formality === entry.formality &&
    top.domain === entry.domain &&
    top.sourceHash === entry.sourceHash
  ) {
    return [{ ...top, savedAt: entry.savedAt }, ...history.slice(1)].slice(
      0,
      MAX_TRANSLATION_VERSION_HISTORY,
    );
  }
  return [entry, ...history].slice(0, MAX_TRANSLATION_VERSION_HISTORY);
}

function uniqueStorageKeys(keys: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function readPersistedWorkbenchState(
  sessionKeys: Array<string | null | undefined>,
): PersistedTranslationWorkbenchState | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  let best: PersistedTranslationWorkbenchState | null = null;
  for (const key of uniqueStorageKeys(sessionKeys)) {
    try {
      const raw = window.localStorage.getItem(`${VERSION_HISTORY_STORAGE_PREFIX}${key}`);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') continue;
      const activeMeta = sanitizeTranslationSyncedMeta(parsed.activeMeta);
      const candidate: PersistedTranslationWorkbenchState = {
        versionHistory: sanitizeVersionHistory(parsed.versionHistory),
        undoBannerDismissed: parsed.undoBannerDismissed === true,
        srcLang: typeof parsed.srcLang === 'string' && parsed.srcLang ? parsed.srcLang : undefined,
        tgtLang: typeof parsed.tgtLang === 'string' && parsed.tgtLang ? parsed.tgtLang : undefined,
        langUpdatedAt:
          typeof parsed.langUpdatedAt === 'number' && Number.isFinite(parsed.langUpdatedAt)
            ? parsed.langUpdatedAt
            : undefined,
        formality: normalizeTranslationFormality(parsed.formality),
        formalityUpdatedAt:
          typeof parsed.formalityUpdatedAt === 'number' && Number.isFinite(parsed.formalityUpdatedAt)
            ? parsed.formalityUpdatedAt
            : undefined,
        domain: typeof parsed.domain === 'string' && parsed.domain ? parsed.domain : undefined,
        ...(activeMeta ? { activeMeta } : {}),
        updatedAt:
          typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : 0,
      };
      if (!best || candidate.updatedAt >= best.updatedAt) {
        best = candidate;
      }
    } catch {
      // Ignore malformed storage entries
    }
  }
  return best;
}

export function writePersistedWorkbenchState(
  sessionKeys: Array<string | null | undefined>,
  state: PersistedTranslationWorkbenchState,
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const keys = uniqueStorageKeys(sessionKeys);
  if (keys.length === 0) return;
  const payload = JSON.stringify({
    versionHistory: state.versionHistory.slice(0, MAX_TRANSLATION_VERSION_HISTORY),
    undoBannerDismissed: state.undoBannerDismissed,
    srcLang: state.srcLang,
    tgtLang: state.tgtLang,
    langUpdatedAt: state.langUpdatedAt,
    formality: state.formality,
    formalityUpdatedAt: state.formalityUpdatedAt,
    domain: state.domain,
    activeMeta: state.activeMeta,
    updatedAt: state.updatedAt,
  });
  for (const key of keys) {
    try {
      window.localStorage.setItem(`${VERSION_HISTORY_STORAGE_PREFIX}${key}`, payload);
    } catch {
      // localStorage 不可用或配额不足时静默降级
    }
  }
}

function resolveEffectiveActiveMeta(params: {
  session: TranslationSession | null;
  persisted: PersistedTranslationWorkbenchState | null;
  sourceText: string;
  translatedText: string;
  srcLang: string;
  tgtLang: string;
  formality: TranslationFormalityValue;
  domain: string;
  glossary: Array<[string, string]>;
  customPrompt?: string;
}): TranslationSyncedMeta | null {
  if (!params.translatedText.trim()) return null;
  const sessionUpdatedAt = toEpochMsSafe(params.session?.updatedAt);
  const persistedUpdatedAt = params.persisted?.updatedAt ?? 0;
  const sessionMeta = params.session?.lastTranslatedMeta;
  const persistedMeta = params.persisted?.activeMeta;

  if (persistedMeta && (!sessionMeta || persistedUpdatedAt >= sessionUpdatedAt)) {
    return persistedMeta;
  }
  if (sessionMeta) {
    return sessionMeta;
  }
  return {
    sourceText: params.sourceText,
    sourceHash: computeTranslationSourceHash(params.sourceText),
    srcLang: params.srcLang,
    tgtLang: params.tgtLang,
    formality: params.formality,
    domain: params.domain,
    ...(params.glossary.length > 0 ? { glossary: params.glossary } : {}),
    ...(params.customPrompt ? { customPrompt: params.customPrompt } : {}),
    translatedAt: sessionUpdatedAt || Date.now(),
  };
}

function signatureFromSyncedMeta(meta: TranslationSyncedMeta | null): string | null {
  if (!meta) return null;
  return buildTranslationStateSignature({
    sourceHash: meta.sourceHash || computeTranslationSourceHash(meta.sourceText),
    srcLang: meta.srcLang,
    tgtLang: meta.tgtLang,
    formality: meta.formality,
    domain: meta.domain,
    glossary: meta.glossary ?? [],
    customPrompt: meta.customPrompt ?? '',
  });
}

export function clearPersistedWorkbenchState(
  sessionKeys: Array<string | null | undefined>,
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  for (const key of uniqueStorageKeys(sessionKeys)) {
    try {
      window.localStorage.removeItem(`${VERSION_HISTORY_STORAGE_PREFIX}${key}`);
    } catch {
      // Ignore storage errors
    }
  }
}

function loadWorkbenchPrefs(): WorkbenchPrefs {
  try {
    const raw = localStorage.getItem(WORKBENCH_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    const formality = normalizeTranslationFormality(record.formality);
    return {
      ...(record as WorkbenchPrefs),
      ...(formality ? { formality } : { formality: undefined }),
    };
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
  /** OS 应用宿主已提供侧边栏设置入口；设置作为完整内容页显示 */
  externalSettingsNavigation?: boolean;
  /** OS 宿主设置标签的受控选中状态 */
  externalSettingsOpen?: boolean;
}

export const TranslateWorkbench: React.FC<TranslateWorkbenchProps> = ({
  onBack,
  dstuMode,
  isActive,
  externalSettingsNavigation = false,
  externalSettingsOpen,
}) => {
  const { t } = useTranslation(['translation', 'common']);

  // DSTU 会话数据
  const initialSession = dstuMode.session;
  // 保存当前会话ID（用于更新而非新建）；优先 session.id，其次宿主传入的 resourceId
  const currentSessionIdRef = useRef<string | null>(
    initialSession?.id || dstuMode.resourceId || null,
  );

  // 同步 session ID（当 TranslationContentView 更新 session 后）
  useEffect(() => {
    const resolvedId = initialSession?.id || dstuMode.resourceId || null;
    if (resolvedId && resolvedId !== currentSessionIdRef.current) {
      currentSessionIdRef.current = resolvedId;
    }
  }, [initialSession?.id, dstuMode.resourceId]);

  // 独立翻译流式管线（发布快照供 ContentView 简报实时订阅）
  const translationStream = useTranslationStream({ publishKey: dstuMode.resourceId });

  // 持久化偏好（首次渲染读取，用户修改偏好时同步更新 prefsRef 避免陈旧）
  const prefsRef = useRef<WorkbenchPrefs | null>(null);
  if (prefsRef.current === null) {
    prefsRef.current = loadWorkbenchPrefs();
  }
  const prefs = prefsRef.current;

  const updateWorkbenchPrefs = useCallback((patch: Partial<WorkbenchPrefs>) => {
    prefsRef.current = { ...(prefsRef.current ?? loadWorkbenchPrefs()), ...patch };
    saveWorkbenchPrefs(patch);
  }, []);

  // 读取当前会话跨刷新持久化的版本历史与正式度恢复记录（只在首次渲染同步读取一次）
  const initialPersistedStateRef = useRef<PersistedTranslationWorkbenchState | null | undefined>(
    undefined,
  );
  if (initialPersistedStateRef.current === undefined) {
    const initKeys: Array<string | null | undefined> = [
      dstuMode.resourceId,
      initialSession?.id,
    ];
    if (!initKeys[0] && !initKeys[1] && initialSession?.sourceText?.trim()) {
      initKeys.push(`src:${hashSourceTextForFallbackKey(initialSession.sourceText)}`);
    }
    initialPersistedStateRef.current = readPersistedWorkbenchState(initKeys);
  }
  const initialPersistedState = initialPersistedStateRef.current;

  // 会话语向/正式度初值：会话值 → 偏好 → 默认（三处签名/状态共用同一解析结果）
  const initialResolvedPrefs = useMemo(
    () => resolveSessionPrefs(initialSession, prefs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialSession?.id]
  );

  const initialSessionUpdatedAt = toEpochMsSafe(initialSession?.updatedAt);
  const initialPersistedLangFresh = Boolean(
    initialPersistedState &&
      (initialPersistedState.srcLang || initialPersistedState.tgtLang) &&
      (initialPersistedState.langUpdatedAt ?? initialPersistedState.updatedAt) >= initialSessionUpdatedAt,
  );
  const initialEffectiveSrcLang =
    initialPersistedState?.srcLang && (initialPersistedLangFresh || !initialSession?.srcLang)
      ? initialPersistedState.srcLang
      : initialResolvedPrefs.srcLang;
  const initialEffectiveTgtLang =
    initialPersistedState?.tgtLang && (initialPersistedLangFresh || !initialSession?.tgtLang)
      ? initialPersistedState.tgtLang
      : initialResolvedPrefs.tgtLang;

  const initialEffectiveFormality: TranslationFormalityValue = useMemo(() => {
    const persistedFormality = initialPersistedState?.formality;
    if (
      persistedFormality &&
      (!initialSession?.formality ||
        (initialPersistedState?.formalityUpdatedAt ?? initialPersistedState?.updatedAt ?? 0) >=
          initialSessionUpdatedAt)
    ) {
      return persistedFormality;
    }
    return initialResolvedPrefs.formality;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession?.id]);

  const initialEffectiveDomain =
    initialPersistedState?.domain &&
    (!initialSession?.domain || initialPersistedState.updatedAt >= initialSessionUpdatedAt)
      ? initialPersistedState.domain
      : initialSession?.domain || 'general';

  // 左栏状态（session 优先，其次本地恢复快照/持久化偏好）
  const [sourceText, setSourceText] = useState(initialSession?.sourceText || '');
  const [srcLang, setSrcLang] = useState(initialEffectiveSrcLang);
  const [tgtLang, setTgtLang] = useState(initialEffectiveTgtLang);
  const [customPrompt, setCustomPrompt] = useState('');
  // 外部设置标签可能早于懒加载工作台被点击；直接以宿主状态初始化，
  // 避免挂载后再双向 effect 同步造成 settingsVisibility 真假振荡。
  const [showPromptEditor, setShowPromptEditor] = useState(
    () => externalSettingsNavigation && externalSettingsOpen === true,
  );
  const isExternalSettingsPageOpen = externalSettingsNavigation && showPromptEditor;
  const [formality, setFormality] = useState<TranslationFormalityValue>(
    initialEffectiveFormality
  );
  const [domain, setDomain] = useState<string>(initialEffectiveDomain);
  const domainRef = useRef(domain);
  domainRef.current = domain;
  const [glossary, setGlossary] = useState<Array<[string, string]>>(initialSession?.glossary || []);

  // 已知默认/模板文案集合：当前提示词命中即视为「未显式修改」
  const knownDefaultPrompts = useMemo(
    () => new Set(Object.values(DOMAIN_DEFAULT_PROMPT_KEYS).map((key) => t(key).trim())),
    [t]
  );
  const defaultPromptForDomain = useCallback(
    (d: string) => t(DOMAIN_DEFAULT_PROMPT_KEYS[d] ?? DOMAIN_DEFAULT_PROMPT_KEYS.general),
    [t]
  );
  // 仅用户显式改过提示词才发送 prompt_override / 持久化 customPrompt
  const isPromptCustomized = isPromptCustomizedBy(customPrompt, knownDefaultPrompts);

  const persistTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
      void saveCurrentSessionRef.current().catch((err) => {
        console.warn('[Translation] Failed to flush pending session save on unmount:', err);
      });
    }
  }, []);

  const scheduleSessionPersist = useCallback(() => {
    if (!dstuMode.onSessionSave || !currentSessionIdRef.current) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void saveCurrentSessionRef.current().catch((err) => {
        console.warn('[Translation] Failed to persist session settings:', err);
      });
    }, 150);
  }, [dstuMode.onSessionSave]);

  // 右栏状态
  const [isEditingTranslation, setIsEditingTranslation] = useState(false);
  const [editedTranslation, setEditedTranslation] = useState('');
  const [hasManualEdits, setHasManualEdits] = useState(false);
  const [pendingOverwriteConfirm, setPendingOverwriteConfirm] = useState(false);
  const [versionHistory, setVersionHistory] = useState<TranslationVersionEntry[]>(
    () => initialPersistedState?.versionHistory ?? [],
  );
  const versionHistoryRef = useRef<TranslationVersionEntry[]>(versionHistory);
  versionHistoryRef.current = versionHistory;
  const previousTranslation = versionHistory[0]?.translatedText ?? null;
  const [undoBannerDismissed, setUndoBannerDismissed] = useState<boolean>(
    () => initialPersistedState?.undoBannerDismissed ?? false,
  );
  const undoBannerDismissedRef = useRef<boolean>(undoBannerDismissed);
  undoBannerDismissedRef.current = undoBannerDismissed;
  const [preSwapSnapshot, setPreSwapSnapshot] = useState<{
    sourceText: string;
    translatedText: string;
    srcLang: string;
    tgtLang: string;
    langOnly: boolean;
    lastTranslatedMeta: TranslationSyncedMeta | null;
    lastTranslatedSig: string | null;
  } | null>(null);
  const [swapUndoBannerDismissed, setSwapUndoBannerDismissed] = useState(false);
  const [dismissedOutdatedSig, setDismissedOutdatedSig] = useState<string | null>(null);
  const [translationQuality, setTranslationQuality] = useState<number | null>(initialSession?.quality || null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isSpeakingRef = useRef(false);
  const speakIdRef = useRef(0);

  const [isSyncScroll, setIsSyncScrollState] = useState(prefs.syncScroll ?? true);
  const [isAutoTranslate, setIsAutoTranslateState] = useState(prefs.autoTranslate ?? false);

  // 错误状态管理
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [verbatimOutputWarning, setVerbatimOutputWarning] = useState(false);
  const [mismatchBannerDismissed, setMismatchBannerDismissed] = useState(false);

  const draftResourceKey = dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id;

  const latestStateForPersistRef = useRef({
    srcLang,
    tgtLang,
    sourceText,
    formality,
  });
  latestStateForPersistRef.current = {
    srcLang,
    tgtLang,
    sourceText,
    formality,
  };
  const latestTranslatedForPersistRef = useRef<string | undefined>(undefined);

  // 跟踪用户在本会话中显式点选或回滚的正式度，防止异步 VFS 刷新/自动重命名把 'formal' 回滚回 'auto'
  const localFormalityOverrideRef = useRef<{
    sessionId: string | null;
    formality: TranslationFormalityValue;
    updatedAt: number;
  } | null>(
    initialPersistedState?.formality &&
    (!initialSession?.formality ||
      (initialPersistedState.formalityUpdatedAt ?? initialPersistedState.updatedAt) >=
        initialSessionUpdatedAt)
      ? {
          sessionId: dstuMode.resourceId ?? initialSession?.id ?? null,
          formality: initialPersistedState.formality,
          updatedAt: initialPersistedState.formalityUpdatedAt ?? initialPersistedState.updatedAt ?? Date.now(),
        }
      : null,
  );

  // 跟踪用户在本会话中显式点选或回滚的语向，防止旧 VFS 列元数据把恢复后的语向覆盖回陈旧语向
  const localLangOverrideRef = useRef<{
    sessionId: string | null;
    srcLang: string;
    tgtLang: string;
    updatedAt: number;
  } | null>(
    initialPersistedLangFresh
      ? {
          sessionId: dstuMode.resourceId ?? initialSession?.id ?? null,
          srcLang: initialEffectiveSrcLang,
          tgtLang: initialEffectiveTgtLang,
          updatedAt: initialPersistedState?.langUpdatedAt ?? initialPersistedState?.updatedAt ?? Date.now(),
        }
      : null,
  );

  // 记录最近一次已产出译文的完整生成元数据（供版本快照、回滚与跨刷新精准过期检测）
  const initialActiveMeta = resolveEffectiveActiveMeta({
    session: initialSession,
    persisted: initialPersistedState,
    sourceText: initialSession?.sourceText || '',
    translatedText: initialSession?.translatedText || '',
    srcLang: initialEffectiveSrcLang,
    tgtLang: initialEffectiveTgtLang,
    formality: initialEffectiveFormality,
    domain: initialEffectiveDomain,
    glossary: initialSession?.glossary || [],
    customPrompt: initialSession?.customPrompt,
  });
  const lastTranslatedMetaRef = useRef<TranslationSyncedMeta | null>(initialActiveMeta);

  const getVersionStorageKeys = useCallback(
    (explicitSessionId?: string | null, explicitSourceText?: string): string[] => {
      const keys = uniqueStorageKeys([
        dstuMode.resourceId,
        explicitSessionId,
        currentSessionIdRef.current,
        initialSession?.id,
      ]);
      if (keys.length === 0) {
        const src = (
          explicitSourceText ??
          latestStateForPersistRef.current.sourceText ??
          initialSession?.sourceText ??
          ''
        ).trim();
        if (src) {
          keys.push(`src:${hashSourceTextForFallbackKey(src)}`);
        }
      }
      return keys;
    },
    [dstuMode.resourceId, initialSession?.id, initialSession?.sourceText],
  );

  const persistLocalDraft = useCallback(
    (
      patch?: Partial<{
        srcLang: string;
        tgtLang: string;
        formality: TranslationFormalityValue;
        domain: string;
        sourceText: string;
        translatedText: string;
        lastTranslatedMeta: TranslationSyncedMeta | null;
      }>,
    ) => {
      const key = dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id;
      if (!key) return;
      const resolvedMeta =
        patch && 'lastTranslatedMeta' in patch
          ? (patch.lastTranslatedMeta ?? undefined)
          : (lastTranslatedMetaRef.current ?? undefined);
      saveTranslationDraftSnapshot({
        id: key,
        srcLang: patch?.srcLang ?? latestStateForPersistRef.current.srcLang,
        tgtLang: patch?.tgtLang ?? latestStateForPersistRef.current.tgtLang,
        formality: patch?.formality ?? latestStateForPersistRef.current.formality,
        domain: patch?.domain ?? domainRef.current,
        sourceText: patch?.sourceText ?? latestStateForPersistRef.current.sourceText,
        translatedText: patch?.translatedText ?? latestTranslatedForPersistRef.current ?? '',
        ...(resolvedMeta ? { lastTranslatedMeta: resolvedMeta } : {}),
        updatedAt: Date.now(),
      });
    },
    [dstuMode.resourceId, initialSession?.id],
  );

  const flushSessionPersist = useCallback(() => {
    if (!dstuMode.onSessionSave || !currentSessionIdRef.current) return;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    void saveCurrentSessionRef.current().catch((err) => {
      console.warn('[Translation] Failed to persist session settings:', err);
    });
  }, [dstuMode.onSessionSave]);

  // 偏好持久化：一律走包装 setter（仅用户操作时回写）。
  // 语向/正式度不再用 effect 持久化——effect 无法区分「用户修改」与
  // 「加载历史会话的程序性赋值」，后者会用会话残留污染新建翻译的偏好。
  const setIsSyncScroll = useCallback((value: boolean) => {
    setIsSyncScrollState(value);
    updateWorkbenchPrefs({ syncScroll: value });
  }, [updateWorkbenchPrefs]);
  const setIsAutoTranslate = useCallback((value: boolean) => {
    setIsAutoTranslateState(value);
    updateWorkbenchPrefs({ autoTranslate: value });
  }, [updateWorkbenchPrefs]);
  const handleSetSrcLang = useCallback((value: string) => {
    const now = Date.now();
    latestStateForPersistRef.current.srcLang = value;
    localLangOverrideRef.current = {
      sessionId: dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id ?? null,
      srcLang: value,
      tgtLang: latestStateForPersistRef.current.tgtLang,
      updatedAt: now,
    };
    setSrcLang(value);
    setVerbatimOutputWarning(false);
    setMismatchBannerDismissed(false);
    updateWorkbenchPrefs({ srcLang: value });
    persistLocalDraft({ srcLang: value });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: undoBannerDismissedRef.current,
      srcLang: value,
      tgtLang: latestStateForPersistRef.current.tgtLang,
      langUpdatedAt: now,
      formality: latestStateForPersistRef.current.formality,
      formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt,
      domain: domainRef.current,
      activeMeta: lastTranslatedMetaRef.current ?? undefined,
      updatedAt: now,
    });
    flushSessionPersist();
  }, [
    dstuMode.resourceId,
    initialSession?.id,
    flushSessionPersist,
    persistLocalDraft,
    updateWorkbenchPrefs,
    getVersionStorageKeys,
  ]);
  const handleSetTgtLang = useCallback((value: string) => {
    const now = Date.now();
    latestStateForPersistRef.current.tgtLang = value;
    localLangOverrideRef.current = {
      sessionId: dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id ?? null,
      srcLang: latestStateForPersistRef.current.srcLang,
      tgtLang: value,
      updatedAt: now,
    };
    setTgtLang(value);
    setVerbatimOutputWarning(false);
    updateWorkbenchPrefs({ tgtLang: value });
    persistLocalDraft({ tgtLang: value });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: undoBannerDismissedRef.current,
      srcLang: latestStateForPersistRef.current.srcLang,
      tgtLang: value,
      langUpdatedAt: now,
      formality: latestStateForPersistRef.current.formality,
      formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt,
      domain: domainRef.current,
      activeMeta: lastTranslatedMetaRef.current ?? undefined,
      updatedAt: now,
    });
    flushSessionPersist();
  }, [
    dstuMode.resourceId,
    initialSession?.id,
    flushSessionPersist,
    persistLocalDraft,
    updateWorkbenchPrefs,
    getVersionStorageKeys,
  ]);
  const handleSetFormality = useCallback((rawValue: TranslationFormalityValue) => {
    const value = normalizeTranslationFormality(rawValue) ?? 'auto';
    const now = Date.now();
    latestStateForPersistRef.current.formality = value;
    localFormalityOverrideRef.current = {
      sessionId: dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id ?? null,
      formality: value,
      updatedAt: now,
    };
    setFormality(value);
    updateWorkbenchPrefs({ formality: value });
    currentDirtySnapshotRef.current = translationDirtySnapshot({
      sourceText: latestStateForPersistRef.current.sourceText,
      translatedText: latestTranslatedForPersistRef.current ?? '',
      srcLang: latestStateForPersistRef.current.srcLang,
      tgtLang: latestStateForPersistRef.current.tgtLang,
      formality: value,
      domain: domainRef.current,
      glossary,
    });
    persistLocalDraft({ formality: value });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: undoBannerDismissedRef.current,
      srcLang: latestStateForPersistRef.current.srcLang,
      tgtLang: latestStateForPersistRef.current.tgtLang,
      langUpdatedAt: localLangOverrideRef.current?.updatedAt,
      formality: value,
      formalityUpdatedAt: now,
      domain: domainRef.current,
      activeMeta: lastTranslatedMetaRef.current ?? undefined,
      updatedAt: now,
    });
    flushSessionPersist();
  }, [
    dstuMode.resourceId,
    initialSession?.id,
    glossary,
    updateWorkbenchPrefs,
    persistLocalDraft,
    getVersionStorageKeys,
    flushSessionPersist,
  ]);

  // 切换领域时默认文案跟随：提示词仍为默认/模板文案（或为空）才替换，显式修改过则保留
  const handleSetDomain = useCallback((nextDomain: string) => {
    const now = Date.now();
    domainRef.current = nextDomain;
    setDomain(nextDomain);
    setCustomPrompt((prev) =>
      promptAfterDomainSwitch(prev, defaultPromptForDomain(nextDomain), knownDefaultPrompts)
    );
    persistLocalDraft({ domain: nextDomain });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: undoBannerDismissedRef.current,
      srcLang: latestStateForPersistRef.current.srcLang,
      tgtLang: latestStateForPersistRef.current.tgtLang,
      langUpdatedAt: localLangOverrideRef.current?.updatedAt,
      formality: latestStateForPersistRef.current.formality,
      formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt,
      domain: nextDomain,
      activeMeta: lastTranslatedMetaRef.current ?? undefined,
      updatedAt: now,
    });
    scheduleSessionPersist();
  }, [knownDefaultPrompts, defaultPromptForDomain, persistLocalDraft, getVersionStorageKeys, scheduleSessionPersist]);

  const handleSetGlossary = useCallback((nextGlossary: Array<[string, string]>) => {
    setGlossary(nextGlossary);
    scheduleSessionPersist();
  }, [scheduleSessionPersist]);

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
      const detail = (evt as CustomEvent<{ targetResourceId?: string; open?: boolean }>).detail;
      if (detail?.targetResourceId && dstuMode.resourceId && detail.targetResourceId !== dstuMode.resourceId) {
        return;
      }
      setShowPromptEditor(prev => typeof detail?.open === 'boolean' ? detail.open : !prev);
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

  // 持久化侧快照同样走 resolveSessionPrefs：新建空翻译按偏好回填语向后，
  // 状态与持久化快照仍一致，不会一打开就误报 dirty
  const persistedSnapshotOf = useCallback(
    (session: TranslationSession | null) =>
      translationDirtySnapshot({
        ...(session ?? {}),
        ...resolveSessionPrefs(session, prefsRef.current ?? loadWorkbenchPrefs()),
      }),
    []
  );
  const persistedDirtySnapshotRef = useRef(
    translationDirtySnapshot({
      ...(initialSession ?? {}),
      srcLang: initialEffectiveSrcLang,
      tgtLang: initialEffectiveTgtLang,
      formality: initialEffectiveFormality,
      domain: initialEffectiveDomain,
    }),
  );
  const syncedInitialTranslatedRef = useRef(initialSession?.translatedText || '');
  const currentDirtySnapshotRef = useRef(persistedDirtySnapshotRef.current);
  const translatedTextForDirty = isEditingTranslation
    ? editedTranslation
    : translatedText || syncedInitialTranslatedRef.current;
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
    const resourceId = dstuMode.resourceId ?? initialSession?.id;
    if (!resourceId) return;
    return registerContentDirtyChecker('translation', resourceId, () =>
      isTranslating || currentDirtySnapshotRef.current !== persistedDirtySnapshotRef.current
    );
  }, [dstuMode.resourceId, initialSession?.id, isTranslating]);

  const markTranslationPersisted = useCallback((session: TranslationSession) => {
    persistedDirtySnapshotRef.current = translationDirtySnapshot(session);
  }, []);

  latestTranslatedForPersistRef.current = translatedTextForDirty;

  // 「保存并关闭」：把当前工作台状态整体落盘（与 dirty 快照同源，
  // 保存成功后 dirty 消除、关窗放行）。闭包经 ref 每帧更新，注册保持稳定。
  const saveCurrentSessionRef = useRef<() => Promise<void>>(async () => undefined);
  saveCurrentSessionRef.current = async () => {
    if (!dstuMode.onSessionSave) return;
    const now = Date.now();
    const {
      srcLang: latestSrcLang,
      tgtLang: latestTgtLang,
      sourceText: latestSourceText,
      formality: latestFormality,
    } = latestStateForPersistRef.current;
    const latestTranslatedText = latestTranslatedForPersistRef.current ?? translatedTextForDirty;
    const sessionToSave: TranslationSession = {
      id: currentSessionIdRef.current || generateTranslationId(),
      sourceText: latestSourceText,
      translatedText: latestTranslatedText,
      srcLang: latestSrcLang,
      tgtLang: latestTgtLang,
      formality: latestFormality,
      customPrompt: isPromptCustomized ? customPrompt : undefined,
      domain: domainRef.current,
      glossary,
      quality: translationQuality ?? undefined,
      lastTranslatedMeta: lastTranslatedMetaRef.current ?? undefined,
      createdAt: initialSession?.createdAt || now,
      updatedAt: now,
    };
    currentSessionIdRef.current = sessionToSave.id;
    await dstuMode.onSessionSave(sessionToSave);
    markTranslationPersisted(sessionToSave);
    persistLocalDraft({
      srcLang: latestSrcLang,
      tgtLang: latestTgtLang,
      formality: latestFormality,
      domain: domainRef.current,
      sourceText: latestSourceText,
      translatedText: latestTranslatedText,
      lastTranslatedMeta: lastTranslatedMetaRef.current,
    });
  };

  useEffect(() => {
    const resourceId = dstuMode.resourceId ?? initialSession?.id;
    if (!resourceId || !dstuMode.onSessionSave) return;
    return registerContentSaveHandler('translation', resourceId, () =>
      saveCurrentSessionRef.current()
    );
  }, [dstuMode.resourceId, initialSession?.id, dstuMode.onSessionSave]);

  // 同步流式管线的错误状态到本地
  useEffect(() => {
    if (streamError) {
      setTranslationError(streamError);
    }
  }, [streamError]);

  // ★ A6-06：最近一次已执行翻译的参数签名；恢复历史会话时基于 syncedMeta 生成精确签名
  const initialTranslatedSig = signatureFromSyncedMeta(initialActiveMeta);
  const lastTranslatedSigRef = useRef<string | null>(initialTranslatedSig);
  const [lastTranslatedSig, setLastTranslatedSig] = useState<string | null>(initialTranslatedSig);
  // 恢复会话且存在用户自定义提示词时，待异步加载出真实 customPrompt 后补齐签名
  const restoredSigPendingPromptRef = useRef<boolean>(
    Boolean(initialActiveMeta && !initialActiveMeta.customPrompt),
  );

  const syncedSessionIdRef = useRef<string | undefined>(initialSession?.id);
  // 初始化会话数据（编辑已有记录时）
  // 无条件赋值（含空字符串），确保父级会话被清空/刷新时本地状态一致；
  // 同一节点后台拉取完整语向元数据时，仅在工作台尚无未保存本地改动时同步，防止覆盖用户输入
  useEffect(() => {
    const incomingId = initialSession?.id;
    const prevId = syncedSessionIdRef.current;
    const isInitialHydrationForSameResource =
      prevId === undefined && Boolean(incomingId) && (!dstuMode.resourceId || incomingId === dstuMode.resourceId);
    const isSameSession = prevId === incomingId || isInitialHydrationForSameResource;
    syncedSessionIdRef.current = incomingId;
    const prevPersisted = persistedDirtySnapshotRef.current;
    const hasUnsavedEdits =
      isSameSession && currentDirtySnapshotRef.current !== prevPersisted;
    persistedDirtySnapshotRef.current = persistedSnapshotOf(initialSession);
    if (hasUnsavedEdits) {
      return;
    }
    // 语向/正式度统一解析链：会话缺失的字段（新建空翻译 / 旧版无 meta 文档）
    // 回落到用户持久化偏好，不被幽灵默认值挡住，也不残留上一个会话的设置
    const restored = resolveSessionPrefs(initialSession, loadWorkbenchPrefs());
    const activeSessionKey = dstuMode.resourceId ?? incomingId ?? null;
    const persistedForSession = readPersistedWorkbenchState(
      activeSessionKey ? [activeSessionKey] : [],
    );

    const incomingUpdatedAt = toEpochMsSafe(initialSession?.updatedAt);
    let nextFormality: TranslationFormalityValue = restored.formality;
    const localOverride = localFormalityOverrideRef.current;
    if (
      isSameSession &&
      localOverride &&
      (localOverride.sessionId === null || localOverride.sessionId === activeSessionKey)
    ) {
      if (initialSession?.formality === localOverride.formality) {
        nextFormality = localOverride.formality;
      } else if (!initialSession?.formality || incomingUpdatedAt <= localOverride.updatedAt + 5000) {
        // 防止后台 VFS 刷新/自动重命名把用户刚点的正式度（如「正式」）回滚回「自动」
        nextFormality = localOverride.formality;
      }
    } else if (
      persistedForSession?.formality &&
      (!initialSession?.formality ||
        (persistedForSession.formalityUpdatedAt ?? persistedForSession.updatedAt) >= incomingUpdatedAt)
    ) {
      nextFormality = persistedForSession.formality;
    }

    let nextSrcLang = restored.srcLang;
    let nextTgtLang = restored.tgtLang;
    const localLangOverride = localLangOverrideRef.current;
    if (
      isSameSession &&
      localLangOverride &&
      (localLangOverride.sessionId === null || localLangOverride.sessionId === activeSessionKey)
    ) {
      if (
        initialSession?.srcLang === localLangOverride.srcLang &&
        initialSession?.tgtLang === localLangOverride.tgtLang
      ) {
        nextSrcLang = localLangOverride.srcLang;
        nextTgtLang = localLangOverride.tgtLang;
      } else if (
        (!initialSession?.srcLang && !initialSession?.tgtLang) ||
        incomingUpdatedAt <= localLangOverride.updatedAt + 5000
      ) {
        // 防止后台 VFS 列表元数据刷新把刚切换/回滚的语向覆盖回旧 SQL 列值
        nextSrcLang = localLangOverride.srcLang;
        nextTgtLang = localLangOverride.tgtLang;
      }
    } else if (
      persistedForSession &&
      (persistedForSession.srcLang || persistedForSession.tgtLang)
    ) {
      const persistedLangFresh =
        (persistedForSession.langUpdatedAt ?? persistedForSession.updatedAt) >= incomingUpdatedAt;
      if (persistedForSession.srcLang && (persistedLangFresh || !initialSession?.srcLang)) {
        nextSrcLang = persistedForSession.srcLang;
      }
      if (persistedForSession.tgtLang && (persistedLangFresh || !initialSession?.tgtLang)) {
        nextTgtLang = persistedForSession.tgtLang;
      }
    }

    const nextDomain =
      persistedForSession?.domain &&
      (!initialSession?.domain || persistedForSession.updatedAt >= incomingUpdatedAt)
        ? persistedForSession.domain
        : initialSession?.domain || 'general';

    setSrcLang(nextSrcLang);
    setTgtLang(nextTgtLang);
    latestStateForPersistRef.current.srcLang = nextSrcLang;
    latestStateForPersistRef.current.tgtLang = nextTgtLang;
    latestStateForPersistRef.current.formality = nextFormality;
    domainRef.current = nextDomain;
    setFormality(nextFormality);
    persistedDirtySnapshotRef.current = translationDirtySnapshot({
      ...(initialSession ?? {}),
      srcLang: nextSrcLang,
      tgtLang: nextTgtLang,
      formality: nextFormality,
      domain: nextDomain,
    });

    if (!isSameSession) {
      setPreSwapSnapshot(null);
      setSwapUndoBannerDismissed(false);
      setDismissedOutdatedSig(null);
      const nextHistory = persistedForSession?.versionHistory ?? [];
      const nextDismissed = persistedForSession?.undoBannerDismissed ?? false;
      versionHistoryRef.current = nextHistory;
      undoBannerDismissedRef.current = nextDismissed;
      setVersionHistory(nextHistory);
      setUndoBannerDismissed(nextDismissed);
      localFormalityOverrideRef.current =
        persistedForSession?.formality &&
        (!initialSession?.formality ||
          (persistedForSession.formalityUpdatedAt ?? persistedForSession.updatedAt) >=
            incomingUpdatedAt)
          ? {
              sessionId: activeSessionKey,
              formality: persistedForSession.formality,
              updatedAt:
                persistedForSession.formalityUpdatedAt ??
                persistedForSession.updatedAt ??
                Date.now(),
            }
          : null;
      localLangOverrideRef.current =
        persistedForSession &&
        (persistedForSession.srcLang || persistedForSession.tgtLang) &&
        (persistedForSession.langUpdatedAt ?? persistedForSession.updatedAt) >= incomingUpdatedAt
          ? {
              sessionId: activeSessionKey,
              srcLang: nextSrcLang,
              tgtLang: nextTgtLang,
              updatedAt:
                persistedForSession.langUpdatedAt ?? persistedForSession.updatedAt ?? Date.now(),
            }
          : null;
    }
    if (!initialSession?.id) {
      return;
    }
    const nextSource = initialSession.sourceText ?? '';
    const nextTranslated = initialSession.translatedText ?? '';
    const nextGlossary = initialSession.glossary || [];
    syncedInitialTranslatedRef.current = nextTranslated;
    latestStateForPersistRef.current.sourceText = nextSource;
    latestTranslatedForPersistRef.current = nextTranslated;
    setSourceText(nextSource);
    setTranslatedText(nextTranslated);
    setDomain(nextDomain);
    setGlossary(nextGlossary);
    setTranslationQuality(initialSession.quality ?? null);
    const nextActiveMeta = resolveEffectiveActiveMeta({
      session: initialSession,
      persisted: persistedForSession,
      sourceText: nextSource,
      translatedText: nextTranslated,
      srcLang: nextSrcLang,
      tgtLang: nextTgtLang,
      formality: nextFormality,
      domain: nextDomain,
      glossary: nextGlossary,
      customPrompt: initialSession.customPrompt,
    });
    lastTranslatedMetaRef.current = nextActiveMeta;
    const nextSig = signatureFromSyncedMeta(nextActiveMeta);
    lastTranslatedSigRef.current = nextSig;
    setLastTranslatedSig(nextSig);
    restoredSigPendingPromptRef.current = Boolean(nextActiveMeta && !nextActiveMeta.customPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initialSession?.id,
    initialSession?.srcLang,
    initialSession?.tgtLang,
    initialSession?.formality,
    initialSession?.domain,
    initialSession?.sourceText,
    initialSession?.translatedText,
    initialSession?.updatedAt,
    initialSession?.lastTranslatedMeta?.sourceHash,
    initialSession?.lastTranslatedMeta?.tgtLang,
    initialSession?.lastTranslatedMeta?.formality,
  ]);

  const syncRestoredSigWithPrompt = useCallback(
    (prompt: string) => {
      if (!restoredSigPendingPromptRef.current) return;
      restoredSigPendingPromptRef.current = false;
      const meta = lastTranslatedMetaRef.current;
      if (!meta) return;
      // 仅用户显式自定义提示词才会进入签名（默认/模板文案统一归一化为 ''，不会引发误过期）
      if (!isPromptCustomizedBy(prompt, knownDefaultPrompts)) return;
      const updatedMeta: TranslationSyncedMeta = {
        ...meta,
        customPrompt: prompt,
      };
      lastTranslatedMetaRef.current = updatedMeta;
      const synced = signatureFromSyncedMeta(updatedMeta);
      lastTranslatedSigRef.current = synced;
      setLastTranslatedSig(synced);
    },
    [knownDefaultPrompts],
  );

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
        const value = promptForSessionLoad(
          saved,
          defaultPromptForDomain(domainRef.current),
          knownDefaultPrompts,
        );
        setCustomPrompt(value);
        syncRestoredSigWithPrompt(value);
      } catch (error: unknown) {
        if (cancelled) return;
        console.error('[Translation] Failed to load prompt:', error);
        const fallback = defaultPromptForDomain(domainRef.current);
        setCustomPrompt(fallback);
        syncRestoredSigWithPrompt(fallback);
      }
    };
    loadPrompt();
    return () => {
      cancelled = true;
    };
  }, [
    initialSession?.customPrompt,
    syncRestoredSigWithPrompt,
    defaultPromptForDomain,
    knownDefaultPrompts,
  ]);

  // 字符统计
  const sourceCharCount = sourceText.length;
  const isSourceOverLimit = sourceCharCount > TRANSLATION_MAX_CHARS;

  // Guarded setter: warn & truncate when source text exceeds limit
  // 编辑原文同时清除旧错误（恢复自动翻译）
  const handleSetSourceText = useCallback((text: string) => {
    setTranslationError(null);
    setVerbatimOutputWarning(false);
    setMismatchBannerDismissed(false);
    if (text.length > TRANSLATION_MAX_CHARS) {
      showGlobalNotification('warning', t('translation:errors.text_too_long', {
        max: TRANSLATION_MAX_CHARS.toLocaleString(),
      }));
      const sliced = text.slice(0, TRANSLATION_MAX_CHARS);
      latestStateForPersistRef.current.sourceText = sliced;
      setSourceText(sliced);
      persistLocalDraft({ sourceText: sliced });
      scheduleSessionPersist();
      return;
    }
    latestStateForPersistRef.current.sourceText = text;
    setSourceText(text);
    persistLocalDraft({ sourceText: text });
    scheduleSessionPersist();
  }, [t, scheduleSessionPersist, persistLocalDraft]);

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
    // #62/ATT-09：引用统一常量（用户手册"文档阅读与翻译"的 50MB 说明与此对应）
    const MAX_UPLOAD_FILE_SIZE = DEFAULT_MAX_UPLOAD_FILE_SIZE;
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

  // ★ A6-06：当前翻译参数的签名（原文哈希+语向+风格参数），用于自动翻译去重与精准过期检测
  const buildTranslationSig = useCallback(
    () =>
      buildTranslationStateSignature({
        sourceHash: computeTranslationSourceHash(sourceText),
        srcLang,
        tgtLang,
        formality,
        domain,
        glossary,
        customPrompt: isPromptCustomized ? customPrompt : '',
      }),
    [sourceText, srcLang, tgtLang, customPrompt, isPromptCustomized, formality, domain, glossary],
  );

  // 翻译（使用流式管线）
  const forceOverwriteTranslateRef = useRef(false);
  const saveAsNewVersionIntentRef = useRef(false);
  const handleTranslate = useCallback(async () => {
    const forceOverwrite = forceOverwriteTranslateRef.current;
    const isSaveAsNewVersion = saveAsNewVersionIntentRef.current;
    forceOverwriteTranslateRef.current = false;
    saveAsNewVersionIntentRef.current = false;

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

    const activeFormality = latestStateForPersistRef.current.formality;
    const currentEffectiveTranslation = translatedText || syncedInitialTranslatedRef.current;

    // 手工精修保护：已手动编辑过译文时，直接覆盖重译前先请求确认；
    // 「另存新版本」显式归档当前手工稿至版本历史，无需阻塞。
    if (!forceOverwrite && !isSaveAsNewVersion && hasManualEdits && currentEffectiveTranslation.trim()) {
      setPendingOverwriteConfirm(true);
      return;
    }

    setPendingOverwriteConfirm(false);
    setDismissedOutdatedSig(null);
    // 保留上一版完整译文快照（正文+语向+正式度+原文哈希+领域+术语表+自定义提示词）并持久化
    const snapshotBeforeRetranslate = currentEffectiveTranslation.trim()
      ? currentEffectiveTranslation
      : null;
    if (snapshotBeforeRetranslate) {
      const prevMeta = lastTranslatedMetaRef.current;
      const snapshotSourceText = prevMeta?.sourceText ?? sourceText;
      const snapshotSourceHash =
        prevMeta?.sourceHash ?? computeTranslationSourceHash(snapshotSourceText);
      const snapshotGlossary = prevMeta?.glossary
        ? prevMeta.glossary.map(([s, tItem]): [string, string] => [s, tItem])
        : glossary.length > 0
          ? glossary.map(([s, tItem]): [string, string] => [s, tItem])
          : undefined;
      const snapshotCustomPrompt =
        prevMeta?.customPrompt ?? (isPromptCustomized ? customPrompt : undefined);
      const nowSnap = Date.now();
      const versionEntry: TranslationVersionEntry = {
        id: `ver_${nowSnap}_${Math.random().toString(36).slice(2, 8)}`,
        translatedText: snapshotBeforeRetranslate,
        sourceText: snapshotSourceText,
        sourceHash: snapshotSourceHash,
        srcLang: prevMeta?.srcLang ?? srcLang,
        tgtLang: prevMeta?.tgtLang ?? tgtLang,
        formality: prevMeta?.formality ?? activeFormality,
        domain: prevMeta?.domain ?? domain,
        ...(snapshotGlossary ? { glossary: snapshotGlossary } : {}),
        ...(snapshotCustomPrompt ? { customPrompt: snapshotCustomPrompt } : {}),
        savedAt: nowSnap,
      };
      const nextHistory = pushTranslationVersion(versionHistoryRef.current, versionEntry);
      versionHistoryRef.current = nextHistory;
      undoBannerDismissedRef.current = false;
      setVersionHistory(nextHistory);
      setUndoBannerDismissed(false);
      writePersistedWorkbenchState(getVersionStorageKeys(undefined, sourceText), {
        versionHistory: nextHistory,
        undoBannerDismissed: false,
        srcLang,
        tgtLang,
        langUpdatedAt: localLangOverrideRef.current?.updatedAt ?? nowSnap,
        formality: activeFormality,
        formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt ?? nowSnap,
        domain,
        activeMeta: prevMeta ?? undefined,
        updatedAt: nowSnap,
      });
      if (isSaveAsNewVersion) {
        showGlobalNotification(
          'info',
          t('translation:workbench_ui.saved_as_new_version_translating', {
            defaultValue: '已将当前译文存为历史版本，正在生成新版本',
          }),
        );
      }
    }

    // 清除之前的错误状态
    setTranslationError(null);
    setTranslationQuality(null);
    setVerbatimOutputWarning(false);
    syncedInitialTranslatedRef.current = '';

    const preMismatch = detectClearSourceLanguageMismatch(sourceText, srcLang);
    if (preMismatch.mismatch) {
      setMismatchBannerDismissed(false);
      showGlobalNotification(
        'warning',
        t('translation:workbench_ui.source_lang_mismatch_toast', {
          defaultValue: '检测到原文语言与所选源语言不一致',
        }),
      );
    }

    // ★ A6-06：登记本次翻译的参数签名（手动/自动触发都登记），自动翻译据此避免对同一内容重复触发
    const sourceHash = computeTranslationSourceHash(sourceText);
    const activeSig = buildTranslationStateSignature({
      sourceHash,
      srcLang,
      tgtLang,
      formality: activeFormality,
      domain,
      glossary,
      customPrompt: isPromptCustomized ? customPrompt : '',
    });
    lastTranslatedSigRef.current = activeSig;
    setLastTranslatedSig(activeSig);
    restoredSigPendingPromptRef.current = false;

    try {
      const result = await translationStream.startTranslation({
        text: sourceText,
        src_lang: srcLang,
        tgt_lang: tgtLang,
        // 仅用户显式改过提示词才覆盖（默认/模板文案交由后端按参数组装）
        prompt_override: isPromptCustomized ? customPrompt : undefined,
        formality: activeFormality,
        glossary: glossary.length > 0 ? glossary : undefined,
        domain: domain !== 'general' ? domain : undefined,
      });

      if (result.outcome === 'completed') {
        const completedAt = Date.now();
        // 翻译成功，清除错误状态
        setTranslationError(null);
        setHasManualEdits(false);
        setDismissedOutdatedSig(null);
        syncedInitialTranslatedRef.current = result.translatedText;
        latestTranslatedForPersistRef.current = result.translatedText;
        setTranslatedText(result.translatedText);

        const completedGlossary =
          glossary.length > 0 ? glossary.map(([s, tItem]): [string, string] => [s, tItem]) : undefined;
        const completedMeta: TranslationSyncedMeta = {
          sourceText,
          sourceHash,
          srcLang,
          tgtLang,
          formality: activeFormality,
          domain,
          ...(completedGlossary ? { glossary: completedGlossary } : {}),
          ...(isPromptCustomized ? { customPrompt } : {}),
          translatedAt: completedAt,
        };
        lastTranslatedMetaRef.current = completedMeta;
        const completedSig = signatureFromSyncedMeta(completedMeta);
        lastTranslatedSigRef.current = completedSig;
        setLastTranslatedSig(completedSig);

        const isVerbatim = isVerbatimUntranslatedOutput(
          sourceText,
          result.translatedText,
          srcLang,
          tgtLang,
        );
        if (isVerbatim) {
          setVerbatimOutputWarning(true);
          showGlobalNotification(
            'warning',
            t('translation:workbench_ui.verbatim_output_warning', {
              defaultValue: '译文与原文相同，请确认源语言设置',
            }),
          );
        } else {
          setVerbatimOutputWarning(false);
        }

        persistLocalDraft({
          srcLang,
          tgtLang,
          formality: activeFormality,
          domain,
          sourceText,
          translatedText: result.translatedText,
          lastTranslatedMeta: completedMeta,
        });

        const persistedFormality = latestStateForPersistRef.current.formality;
        let finalSessionId = currentSessionIdRef.current;

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
              formality: persistedFormality,
              customPrompt: isPromptCustomized ? customPrompt : undefined,
              // domain / glossary 完整传入（含默认值），确保 DSTU metadata 落盘与清空生效
              domain,
              glossary,
              lastTranslatedMeta: completedMeta,
              createdAt: initialSession?.createdAt || now,
              updatedAt: now,
            };
            // 保存后更新当前会话 ID
            currentSessionIdRef.current = sessionToSave.id;
            finalSessionId = sessionToSave.id;
            await dstuMode.onSessionSave(sessionToSave);
            markTranslationPersisted(sessionToSave);
          } catch (saveError: unknown) {
            console.error('[Translation] Save failed:', saveError);
            showGlobalNotification('error', t('translation:toast.save_failed'));
          }
        }

        // 最终会话 ID 落定后再同步写入版本历史、语向、正式度与当前完成稿元数据
        const finalNow = Date.now();
        writePersistedWorkbenchState(getVersionStorageKeys(finalSessionId, sourceText), {
          versionHistory: versionHistoryRef.current,
          undoBannerDismissed: undoBannerDismissedRef.current,
          srcLang,
          tgtLang,
          langUpdatedAt: localLangOverrideRef.current?.updatedAt ?? finalNow,
          formality: persistedFormality,
          formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt ?? finalNow,
          domain,
          activeMeta: completedMeta,
          updatedAt: finalNow,
        });
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
  }, [
    sourceText,
    srcLang,
    tgtLang,
    customPrompt,
    isPromptCustomized,
    domain,
    glossary,
    t,
    translationStream.startTranslation,
    setTranslatedText,
    isTranslating,
    dstuMode,
    initialSession,
    isOnline,
    markTranslationPersisted,
    hasManualEdits,
    translatedText,
    persistLocalDraft,
    getVersionStorageKeys,
  ]);

  const handleConfirmOverwriteTranslate = useCallback(() => {
    forceOverwriteTranslateRef.current = true;
    void handleTranslate();
  }, [handleTranslate]);

  const handleSaveAsNewVersionAndTranslate = useCallback(() => {
    saveAsNewVersionIntentRef.current = true;
    forceOverwriteTranslateRef.current = true;
    void handleTranslate();
  }, [handleTranslate]);

  const handleKeepCurrentTranslation = useCallback(() => {
    setDismissedOutdatedSig(buildTranslationSig());
  }, [buildTranslationSig]);

  const handleRestorePreviousTranslation = useCallback(async () => {
    const currentHistory = versionHistoryRef.current;
    const targetVersion = currentHistory[0];
    if (!targetVersion) return;

    const now = Date.now();
    const restoredText = targetVersion.translatedText;
    const restoredSrcLang = targetVersion.srcLang || latestStateForPersistRef.current.srcLang;
    const restoredTgtLang = targetVersion.tgtLang || latestStateForPersistRef.current.tgtLang;
    const restoredFormality = normalizeTranslationFormality(targetVersion.formality) ?? 'auto';
    const restoredDomain = targetVersion.domain || 'general';
    const restoredGlossary = targetVersion.glossary
      ? targetVersion.glossary.map(([s, tItem]): [string, string] => [s, tItem])
      : glossary;
    const restoredCustomPromptOverride =
      targetVersion.customPrompt && isPromptCustomizedBy(targetVersion.customPrompt, knownDefaultPrompts)
        ? targetVersion.customPrompt
        : undefined;
    const restoredCustomPromptUi =
      restoredCustomPromptOverride ?? defaultPromptForDomain(restoredDomain);
    const currentSource = latestStateForPersistRef.current.sourceText;
    const restoredSourceText = targetVersion.sourceText || currentSource;
    const restoredSourceHash =
      targetVersion.sourceHash || computeTranslationSourceHash(restoredSourceText);

    const remaining = currentHistory.slice(1);
    const activeSessionKey =
      dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id ?? null;

    const restoredMeta: TranslationSyncedMeta = {
      sourceText: restoredSourceText,
      sourceHash: restoredSourceHash,
      srcLang: restoredSrcLang,
      tgtLang: restoredTgtLang,
      formality: restoredFormality,
      domain: restoredDomain,
      ...(restoredGlossary.length > 0 ? { glossary: restoredGlossary } : {}),
      ...(restoredCustomPromptOverride ? { customPrompt: restoredCustomPromptOverride } : {}),
      translatedAt: targetVersion.savedAt || now,
    };
    const restoredSig = signatureFromSyncedMeta(restoredMeta);

    // 原子更新所有同步 ref，确保后续保存、重渲染与后台水合均见到完整回滚态
    versionHistoryRef.current = remaining;
    undoBannerDismissedRef.current = false;
    syncedInitialTranslatedRef.current = restoredText;
    latestTranslatedForPersistRef.current = restoredText;
    latestStateForPersistRef.current = {
      srcLang: restoredSrcLang,
      tgtLang: restoredTgtLang,
      sourceText: currentSource,
      formality: restoredFormality,
    };
    domainRef.current = restoredDomain;
    localFormalityOverrideRef.current = {
      sessionId: activeSessionKey,
      formality: restoredFormality,
      updatedAt: now,
    };
    localLangOverrideRef.current = {
      sessionId: activeSessionKey,
      srcLang: restoredSrcLang,
      tgtLang: restoredTgtLang,
      updatedAt: now,
    };
    lastTranslatedMetaRef.current = restoredMeta;
    lastTranslatedSigRef.current = restoredSig;
    restoredSigPendingPromptRef.current = false;
    currentDirtySnapshotRef.current = translationDirtySnapshot({
      sourceText: currentSource,
      translatedText: restoredText,
      srcLang: restoredSrcLang,
      tgtLang: restoredTgtLang,
      formality: restoredFormality,
      domain: restoredDomain,
      glossary: restoredGlossary,
    });

    // 原子更新 UI 状态（正文 + 源/目标语向 + 正式度 + 领域 + 术语表 + 提示词 + 同步签名）
    setSrcLang(restoredSrcLang);
    setTgtLang(restoredTgtLang);
    setFormality(restoredFormality);
    setDomain(restoredDomain);
    setGlossary(restoredGlossary);
    setCustomPrompt(restoredCustomPromptUi);
    setTranslatedText(restoredText);
    setLastTranslatedSig(restoredSig);
    setVersionHistory(remaining);
    setUndoBannerDismissed(false);
    setPendingOverwriteConfirm(false);
    setHasManualEdits(false);
    setDismissedOutdatedSig(null);
    setVerbatimOutputWarning(false);
    setMismatchBannerDismissed(false);

    persistLocalDraft({
      srcLang: restoredSrcLang,
      tgtLang: restoredTgtLang,
      formality: restoredFormality,
      domain: restoredDomain,
      sourceText: currentSource,
      translatedText: restoredText,
      lastTranslatedMeta: restoredMeta,
    });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: remaining,
      undoBannerDismissed: false,
      srcLang: restoredSrcLang,
      tgtLang: restoredTgtLang,
      langUpdatedAt: now,
      formality: restoredFormality,
      formalityUpdatedAt: now,
      domain: restoredDomain,
      activeMeta: restoredMeta,
      updatedAt: now,
    });
    if (dstuMode.onSessionSave && currentSessionIdRef.current) {
      try {
        const sessionToSave: TranslationSession = {
          id: currentSessionIdRef.current,
          sourceText: currentSource,
          translatedText: restoredText,
          srcLang: restoredSrcLang,
          tgtLang: restoredTgtLang,
          formality: restoredFormality,
          customPrompt: restoredCustomPromptOverride,
          domain: restoredDomain,
          glossary: restoredGlossary,
          quality: translationQuality ?? undefined,
          lastTranslatedMeta: restoredMeta,
          createdAt: initialSession?.createdAt || now,
          updatedAt: now,
        };
        await dstuMode.onSessionSave(sessionToSave);
        markTranslationPersisted(sessionToSave);
      } catch (error: unknown) {
        showGlobalNotification('error', t('translation:toast.update_failed', { error: getErrorMessage(error) }));
      }
    }
    showGlobalNotification('success', t('translation:workbench_ui.restored_previous'));
  }, [
    setTranslatedText,
    persistLocalDraft,
    getVersionStorageKeys,
    dstuMode,
    glossary,
    knownDefaultPrompts,
    defaultPromptForDomain,
    translationQuality,
    initialSession,
    markTranslationPersisted,
    t,
  ]);

  const handleDismissUndoBanner = useCallback(() => {
    undoBannerDismissedRef.current = true;
    setUndoBannerDismissed(true);
    const now = Date.now();
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: true,
      srcLang: latestStateForPersistRef.current.srcLang,
      tgtLang: latestStateForPersistRef.current.tgtLang,
      langUpdatedAt: localLangOverrideRef.current?.updatedAt,
      formality: latestStateForPersistRef.current.formality,
      formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt,
      domain: domainRef.current,
      activeMeta: lastTranslatedMetaRef.current ?? undefined,
      updatedAt: now,
    });
  }, [getVersionStorageKeys]);

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

  // 保存Prompt及当前翻译设置到会话
  const handleSavePrompt = useCallback(async () => {
    try {
      // 默认/领域模板由后端按 domain 组装，不写入全局 override 设置；
      // 否则下次打开不同领域时会显示旧领域模板，且跨语言后可能被误判为自定义覆盖。
      await TauriAPI.saveSetting(
        'translation.prompt',
        isPromptCustomized ? customPrompt : '',
      );
      if (
        dstuMode.onSessionSave &&
        (currentSessionIdRef.current || sourceText.trim() || glossary.length > 0 || domain !== 'general' || isPromptCustomized)
      ) {
        await saveCurrentSessionRef.current();
      }
      showGlobalNotification('success', t('translation:prompt_editor.saved'));
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [customPrompt, isPromptCustomized, dstuMode.onSessionSave, sourceText, glossary.length, domain, t]);

  // 恢复默认 Prompt：跟随当前领域的默认/模板文案（命中已知默认集合，
  // 因此恢复后 isPromptCustomized=false，不会发送 prompt_override 覆盖领域预设）
  const handleRestoreDefaultPrompt = useCallback(() => {
    setCustomPrompt(defaultPromptForDomain(domain));
  }, [defaultPromptForDomain, domain]);

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
    const langOnly = Boolean(sourceText.trim() && !translatedText.trim());
    const now = Date.now();
    setPreSwapSnapshot({
      sourceText,
      translatedText,
      srcLang,
      tgtLang,
      langOnly,
      lastTranslatedMeta: lastTranslatedMetaRef.current,
      lastTranslatedSig: lastTranslatedSigRef.current,
    });
    setSwapUndoBannerDismissed(false);

    latestStateForPersistRef.current.srcLang = tgtLang;
    latestStateForPersistRef.current.tgtLang = effectiveSrcLang;
    localLangOverrideRef.current = {
      sessionId: dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id ?? null,
      srcLang: tgtLang,
      tgtLang: effectiveSrcLang,
      updatedAt: now,
    };
    setSrcLang(tgtLang);
    setTgtLang(effectiveSrcLang);
    updateWorkbenchPrefs({ srcLang: tgtLang, tgtLang: effectiveSrcLang });

    // 仅当有译文（或双方都为空）时才对调文本；原文非空而译文为空时只交换语向，不清空原文
    if (!langOnly) {
      latestStateForPersistRef.current.sourceText = translatedText;
      latestTranslatedForPersistRef.current = sourceText;
      syncedInitialTranslatedRef.current = sourceText;
      setSourceText(translatedText);
      setTranslatedText(sourceText);
    }
    setVerbatimOutputWarning(false);
    setMismatchBannerDismissed(false);
    setTranslationError(null);
    persistLocalDraft({
      srcLang: tgtLang,
      tgtLang: effectiveSrcLang,
      sourceText: langOnly ? sourceText : translatedText,
      translatedText: langOnly ? translatedText : sourceText,
    });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: undoBannerDismissedRef.current,
      srcLang: tgtLang,
      tgtLang: effectiveSrcLang,
      langUpdatedAt: now,
      formality: latestStateForPersistRef.current.formality,
      formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt,
      domain: domainRef.current,
      activeMeta: lastTranslatedMetaRef.current ?? undefined,
      updatedAt: now,
    });
    flushSessionPersist();
  }, [srcLang, tgtLang, sourceText, translatedText, detectedLang, t, setTranslatedText, isTranslating, isEditingTranslation, flushSessionPersist, persistLocalDraft, updateWorkbenchPrefs, dstuMode.resourceId, initialSession?.id, getVersionStorageKeys]);

  const handleUndoSwap = useCallback(() => {
    if (!preSwapSnapshot) return;
    const now = Date.now();
    latestStateForPersistRef.current.srcLang = preSwapSnapshot.srcLang;
    latestStateForPersistRef.current.tgtLang = preSwapSnapshot.tgtLang;
    latestStateForPersistRef.current.sourceText = preSwapSnapshot.sourceText;
    latestTranslatedForPersistRef.current = preSwapSnapshot.translatedText;
    syncedInitialTranslatedRef.current = preSwapSnapshot.translatedText;
    localLangOverrideRef.current = {
      sessionId: dstuMode.resourceId ?? currentSessionIdRef.current ?? initialSession?.id ?? null,
      srcLang: preSwapSnapshot.srcLang,
      tgtLang: preSwapSnapshot.tgtLang,
      updatedAt: now,
    };
    lastTranslatedMetaRef.current = preSwapSnapshot.lastTranslatedMeta;
    lastTranslatedSigRef.current = preSwapSnapshot.lastTranslatedSig;

    setSrcLang(preSwapSnapshot.srcLang);
    setTgtLang(preSwapSnapshot.tgtLang);
    updateWorkbenchPrefs({ srcLang: preSwapSnapshot.srcLang, tgtLang: preSwapSnapshot.tgtLang });
    setSourceText(preSwapSnapshot.sourceText);
    setTranslatedText(preSwapSnapshot.translatedText);
    setLastTranslatedSig(preSwapSnapshot.lastTranslatedSig);
    setVerbatimOutputWarning(false);
    setTranslationError(null);
    setPreSwapSnapshot(null);
    setSwapUndoBannerDismissed(true);
    persistLocalDraft({
      srcLang: preSwapSnapshot.srcLang,
      tgtLang: preSwapSnapshot.tgtLang,
      sourceText: preSwapSnapshot.sourceText,
      translatedText: preSwapSnapshot.translatedText,
      lastTranslatedMeta: preSwapSnapshot.lastTranslatedMeta,
    });
    writePersistedWorkbenchState(getVersionStorageKeys(), {
      versionHistory: versionHistoryRef.current,
      undoBannerDismissed: undoBannerDismissedRef.current,
      srcLang: preSwapSnapshot.srcLang,
      tgtLang: preSwapSnapshot.tgtLang,
      langUpdatedAt: now,
      formality: latestStateForPersistRef.current.formality,
      formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt,
      domain: domainRef.current,
      activeMeta: preSwapSnapshot.lastTranslatedMeta ?? undefined,
      updatedAt: now,
    });
    flushSessionPersist();
  }, [preSwapSnapshot, setTranslatedText, flushSessionPersist, persistLocalDraft, updateWorkbenchPrefs, dstuMode.resourceId, initialSession?.id, getVersionStorageKeys]);

  // 自动翻译逻辑（智能 debounce：短文本快速触发，长文本延迟触发）
  // deps 包含所有影响翻译结果的参数，修改设置时也会重新触发
  useEffect(() => {
    // ★ A6-28 标签页保活：非活跃实例不发起自动翻译。此前仅依赖「状态不变 →
    // 签名不变」间接不触发，但恢复历史会话时 prompt 异步补签名存在时序窗口
    // （prompt 加载晚于其它参数变化时签名失配），非活跃保活页也会发起流式翻译。
    // 守卫必须显式（对齐下方快捷键 effect 的 isActive 守卫），重新激活后
    // effect 因 isActive 变化重跑，签名失配的待译内容照常触发。
    if (isActive === false) return;
    if (isAutoTranslate && sourceText.trim() && !isTranslating && !translationError) {
      // ★ A6-06：内容与参数均未变化时不再触发——否则翻译完成 → isTranslating 翻转 →
      // effect 重跑 → 同一文本被无限次重译（持续消耗 API 配额）
      if (buildTranslationSig() === lastTranslatedSigRef.current) {
        return;
      }
      const len = sourceText.length;
      const delay = len < 200 ? 1500 : len < 1000 ? 2500 : 4000;
      const timer = setTimeout(() => {
        void handleTranslate();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [sourceText, srcLang, tgtLang, formality, domain, glossary, isAutoTranslate, isTranslating, translationError, handleTranslate, buildTranslationSig, isActive]);

  // 编辑译文
  const handleEditTranslation = useCallback(() => {
    setIsEditingTranslation(true);
    setEditedTranslation(translatedText || syncedInitialTranslatedRef.current);
  }, [translatedText]);

  // 保存编辑后的译文：本地 DSTU 写入不依赖网络，不做 navigator.onLine 拦截
  const handleSaveEditedTranslation = useCallback(async () => {
    try {
      const now = Date.now();
      const activeFormality = latestStateForPersistRef.current.formality;
      const editedMeta: TranslationSyncedMeta | null = editedTranslation.trim()
        ? {
            sourceText,
            sourceHash: computeTranslationSourceHash(sourceText),
            srcLang,
            tgtLang,
            formality: activeFormality,
            domain,
            ...(glossary.length > 0 ? { glossary: glossary.map(([s, tItem]): [string, string] => [s, tItem]) } : {}),
            ...(isPromptCustomized ? { customPrompt } : {}),
            translatedAt: now,
          }
        : null;
      const editedSig = signatureFromSyncedMeta(editedMeta);

      // 更新前端状态
      syncedInitialTranslatedRef.current = editedTranslation;
      latestTranslatedForPersistRef.current = editedTranslation;
      lastTranslatedMetaRef.current = editedMeta;
      lastTranslatedSigRef.current = editedSig;
      setTranslatedText(editedTranslation);
      setLastTranslatedSig(editedSig);
      setDismissedOutdatedSig(null);
      setIsEditingTranslation(false);
      setHasManualEdits(true);
      setPendingOverwriteConfirm(false);
      persistLocalDraft({
        srcLang,
        tgtLang,
        formality: activeFormality,
        domain,
        sourceText,
        translatedText: editedTranslation,
        lastTranslatedMeta: editedMeta,
      });
      writePersistedWorkbenchState(getVersionStorageKeys(), {
        versionHistory: versionHistoryRef.current,
        undoBannerDismissed: undoBannerDismissedRef.current,
        srcLang,
        tgtLang,
        langUpdatedAt: localLangOverrideRef.current?.updatedAt ?? now,
        formality: activeFormality,
        formalityUpdatedAt: localFormalityOverrideRef.current?.updatedAt ?? now,
        domain,
        activeMeta: editedMeta ?? undefined,
        updatedAt: now,
      });
      
      // 通过回调保存到 DSTU
      if (dstuMode.onSessionSave && currentSessionIdRef.current) {
        const sessionToSave: TranslationSession = {
          id: currentSessionIdRef.current,
          sourceText,
          translatedText: editedTranslation,
          srcLang,
          tgtLang,
          formality: activeFormality,
          customPrompt: isPromptCustomized ? customPrompt : undefined,
          domain,
          glossary,
          quality: translationQuality ?? undefined,
          lastTranslatedMeta: editedMeta ?? undefined,
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
  }, [editedTranslation, t, setTranslatedText, dstuMode, sourceText, srcLang, tgtLang, domain, glossary, customPrompt, isPromptCustomized, translationQuality, initialSession, markTranslationPersisted, persistLocalDraft, getVersionStorageKeys]);

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
        translatedTextForDirty, ``,
      );

      const content = lines.join('\n');
      const fileName = `translation_${new Date().getTime()}.md`;
      const useBrowserDownload =
        typeof window === 'undefined' ||
        !('__TAURI_INTERNALS__' in window) ||
        isWebUiShell();

      if (useBrowserDownload && typeof document !== 'undefined') {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        showGlobalNotification('success', t('translation:target_section.exported'));
        return;
      }

      const result = await fileManager.saveTextFile({
        title: t('translation:target_section.export_title'),
        defaultFileName: fileName,
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
  }, [sourceText, translatedTextForDirty, srcLang, tgtLang, domain, glossary, t]);

  // 朗读译文
  const handleSpeak = useCallback(async () => {
    // 使用 ref 避免 stale closure，防止多次点击重复播放
    if (isSpeakingRef.current) {
      ++speakIdRef.current;
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
      if (speakIdRef.current === myId) {
        showGlobalNotification('error', t('translation:errors.tts_failed', { error: getErrorMessage(error) }));
      }
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

  // 翻译质量评分：本地 DSTU 写入不依赖网络，不做 navigator.onLine 拦截
  const handleRateTranslation = useCallback(async (rating: number) => {
    setTranslationQuality(rating);
    
    // 通过回调保存评分到 DSTU
    if (dstuMode.onSessionSave && currentSessionIdRef.current) {
      try {
        const now = Date.now();
        const sessionToSave: TranslationSession = {
          id: currentSessionIdRef.current,
          sourceText,
          translatedText: translatedText || syncedInitialTranslatedRef.current,
          srcLang,
          tgtLang,
          formality: latestStateForPersistRef.current.formality,
          customPrompt: isPromptCustomized ? customPrompt : undefined,
          domain,
          glossary,
          quality: rating,
          lastTranslatedMeta: lastTranslatedMetaRef.current ?? undefined,
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
  }, [t, dstuMode, sourceText, translatedText, srcLang, tgtLang, domain, glossary, customPrompt, isPromptCustomized, initialSession, markTranslationPersisted]);

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
          void handleTranslate();
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
    const keysToClear = getVersionStorageKeys();
    latestStateForPersistRef.current.sourceText = '';
    latestTranslatedForPersistRef.current = '';
    syncedInitialTranslatedRef.current = '';
    versionHistoryRef.current = [];
    undoBannerDismissedRef.current = false;
    lastTranslatedMetaRef.current = null;
    localLangOverrideRef.current = null;
    setSourceText('');
    setTranslatedText('');
    setTranslationQuality(null);
    setTranslationError(null);
    setVerbatimOutputWarning(false);
    setMismatchBannerDismissed(false);
    setIsEditingTranslation(false);
    setEditedTranslation('');
    setHasManualEdits(false);
    setPendingOverwriteConfirm(false);
    setVersionHistory([]);
    setUndoBannerDismissed(false);
    setDismissedOutdatedSig(null);
    lastTranslatedSigRef.current = null;
    setLastTranslatedSig(null);
    restoredSigPendingPromptRef.current = false;
    clearTranslationDraftSnapshot(draftResourceKey);
    clearPersistedWorkbenchState(keysToClear);
  }, [setTranslatedText, draftResourceKey, getVersionStorageKeys]);

  // 取消残留的部分译文：清除文本（保留原文），或仅关闭提示
  const handleDiscardPartial = useCallback(() => {
    syncedInitialTranslatedRef.current = '';
    latestTranslatedForPersistRef.current = '';
    setTranslatedText('');
  }, [setTranslatedText]);

  const sourceLanguageMismatch = useMemo(
    () => detectClearSourceLanguageMismatch(sourceText, srcLang),
    [sourceText, srcLang],
  );
  const mismatchDetectedLangName = sourceLanguageMismatch.detectedLang
    ? t(`translation:languages.${sourceLanguageMismatch.detectedLang}`, {
        defaultValue: sourceLanguageMismatch.detectedLang,
      })
    : null;
  const selectedSrcLangName = t(`translation:languages.${srcLang}`, { defaultValue: srcLang });

  const detectedLangName = detectedLang
    ? t(`translation:languages.${detectedLang}`, { defaultValue: detectedLang })
    : null;
  const effectiveTranslatedText = translatedText || syncedInitialTranslatedRef.current;
  const currentTranslationSig = buildTranslationSig();
  const isOutdated = Boolean(
    effectiveTranslatedText.trim() &&
    !isTranslating &&
    !translationError &&
    lastTranslatedSig &&
    currentTranslationSig !== lastTranslatedSig &&
    dismissedOutdatedSig !== currentTranslationSig
  );
  const previousVersionEntry = versionHistory[0] ?? null;
  const previousVersionMetaLabel = previousVersionEntry
    ? `${t(`translation:languages.${previousVersionEntry.tgtLang}`, {
        defaultValue: previousVersionEntry.tgtLang,
      })} · ${t(`translation:prompt_editor.formality_${previousVersionEntry.formality}`, {
        defaultValue: previousVersionEntry.formality,
      })}`
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
        {!isExternalSettingsPageOpen && !isOnline && (
          <div className="flex items-center gap-2 px-4 py-2 bg-warning/10 border-b border-warning/20 text-warning ui-drop-in">
            <WifiSlash size={16} className="shrink-0" />
            <span className="text-sm">{t('translation:errors.offline')}</span>
          </div>
        )}

        {/* 翻译错误提示（内联错误条 + 重试） */}
        {!isExternalSettingsPageOpen && translationError && !isTranslating && (
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
              className="shrink-0 text-destructive hover:bg-destructive/10 [@media(pointer:coarse)]:!min-h-11"
            >
              <ArrowClockwise className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} />
              {t('common:retry')}
            </DsButton>
          </div>
        )}

        {/* 源语言与原文不匹配提示条（S3-11） */}
        {!isExternalSettingsPageOpen &&
          sourceLanguageMismatch.mismatch &&
          !mismatchBannerDismissed &&
          !translationError && (
            <div
              data-testid="translation-mismatch-warning-banner"
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-warning/10 border-b border-warning/25 ui-drop-in"
            >
              <div className="flex items-center gap-2 text-warning min-w-0">
                <WarningCircle size={16} className="shrink-0" />
                <span className="text-sm">
                  {t('translation:workbench_ui.source_lang_mismatch_banner', {
                    detected: mismatchDetectedLangName ?? sourceLanguageMismatch.detectedLang ?? '',
                    selected: selectedSrcLangName,
                    defaultValue: '检测到原文语言与所选源语言不一致',
                  })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {sourceLanguageMismatch.detectedLang && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    data-testid="translation-mismatch-switch-detected"
                    onClick={() => handleSetSrcLang(sourceLanguageMismatch.detectedLang!)}
                    className="text-warning hover:bg-warning/15 font-medium [@media(pointer:coarse)]:!min-h-11"
                  >
                    {t('translation:workbench_ui.switch_to_detected', {
                      language: mismatchDetectedLangName ?? sourceLanguageMismatch.detectedLang,
                      defaultValue: `切换为 ${mismatchDetectedLangName ?? sourceLanguageMismatch.detectedLang}`,
                    })}
                  </DsButton>
                )}
                <DsButton
                  variant="ghost"
                  size="sm"
                  data-testid="translation-mismatch-switch-auto"
                  onClick={() => handleSetSrcLang('auto')}
                  className="text-warning hover:bg-warning/15 [@media(pointer:coarse)]:!min-h-11"
                >
                  {t('translation:workbench_ui.switch_to_auto', { defaultValue: '改为自动检测' })}
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setMismatchBannerDismissed(true)}
                  className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
                >
                  {t('translation:workbench_ui.dismiss')}
                </DsButton>
              </div>
            </div>
          )}

        {/* 译文与原文完全相同警示条（S3-11） */}
        {!isExternalSettingsPageOpen &&
          verbatimOutputWarning &&
          !isTranslating &&
          !translationError && (
            <div
              data-testid="translation-verbatim-warning-banner"
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-warning/10 border-b border-warning/25 ui-drop-in"
            >
              <div className="flex items-center gap-2 text-warning min-w-0">
                <WarningCircle size={16} className="shrink-0" />
                <span className="text-sm">
                  {t('translation:workbench_ui.verbatim_output_warning', {
                    defaultValue: '译文与原文相同，请确认源语言设置',
                  })}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {srcLang !== 'auto' && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSetSrcLang('auto')}
                    className="text-warning hover:bg-warning/15 font-medium [@media(pointer:coarse)]:!min-h-11"
                  >
                    {t('translation:workbench_ui.switch_to_auto', { defaultValue: '改为自动检测' })}
                  </DsButton>
                )}
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setVerbatimOutputWarning(false)}
                  className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
                >
                  {t('translation:workbench_ui.dismiss')}
                </DsButton>
              </div>
            </div>
          )}

        {/* 重译覆盖手工编辑确认条 */}
        {!isExternalSettingsPageOpen && pendingOverwriteConfirm && !isTranslating && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 px-4 py-2 bg-warning/10 border-b border-warning/25 ui-drop-in"
          >
            <div className="flex items-center gap-2 text-warning min-w-0">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm truncate">{t('translation:workbench_ui.overwrite_manual_confirm')}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setPendingOverwriteConfirm(false)}
                className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
              >
                {t('common:cancel')}
              </DsButton>
              <DsButton
                variant="default"
                size="sm"
                onClick={handleConfirmOverwriteTranslate}
                className="[@media(pointer:coarse)]:!min-h-11"
              >
                {t('translation:workbench_ui.confirm_retranslate')}
              </DsButton>
            </div>
          </div>
        )}

        {/* 交换语言/文本后一键撤销提示条 */}
        {!isExternalSettingsPageOpen && preSwapSnapshot !== null && !swapUndoBannerDismissed && !isTranslating && (
          <div
            data-testid="translation-swap-undo-banner"
            className="flex items-center justify-between gap-2 px-4 py-2 bg-info/10 border-b border-info/20 ui-drop-in"
          >
            <div className="flex items-center gap-2 text-info min-w-0">
              <Info size={16} className="shrink-0" />
              <span className="text-sm truncate">
                {preSwapSnapshot.langOnly
                  ? t('translation:workbench_ui.swapped_lang_only_hint')
                  : t('translation:workbench_ui.swapped_undo_hint')}
              </span>
              <span aria-hidden="true" className="text-info/60">·</span>
              <DsButton
                variant="ghost"
                size="sm"
                data-testid="translation-swap-undo-button"
                onClick={handleUndoSwap}
                className="text-info hover:bg-info/10 font-medium [@media(pointer:coarse)]:!min-h-11"
              >
                {t('translation:workbench_ui.undo_swap')}
              </DsButton>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => setSwapUndoBannerDismissed(true)}
                className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
              >
                {t('translation:workbench_ui.dismiss')}
              </DsButton>
            </div>
          </div>
        )}

        {/* 重译后一键撤销/恢复上一版译文提示条 */}
        {!isExternalSettingsPageOpen && previousTranslation !== null && !undoBannerDismissed && !isTranslating && !pendingOverwriteConfirm && !translationError && (
          <div
            data-testid="translation-previous-version-banner"
            className="flex items-center justify-between gap-2 px-4 py-2 bg-info/10 border-b border-info/20 ui-drop-in"
          >
            <div className="flex items-center gap-2 text-info min-w-0">
              <Info size={16} className="shrink-0" />
              <span className="text-sm truncate">{t('translation:workbench_ui.retranslated_undo_hint')}</span>
              {previousVersionMetaLabel && (
                <span
                  data-testid="translation-previous-version-meta"
                  className="shrink-0 rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium"
                >
                  {previousVersionMetaLabel}
                </span>
              )}
              {versionHistory.length > 1 && (
                <span
                  data-testid="translation-version-history-count"
                  className="shrink-0 rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium tabular-nums"
                >
                  {t('translation:workbench_ui.version_history_count', { count: versionHistory.length })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <DsButton
                variant="ghost"
                size="sm"
                data-testid="translation-restore-previous-banner-button"
                onClick={() => void handleRestorePreviousTranslation()}
                className="text-info hover:bg-info/10 [@media(pointer:coarse)]:!min-h-11"
              >
                {t('translation:workbench_ui.restore_previous')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleDismissUndoBanner}
                className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
              >
                {t('translation:workbench_ui.dismiss')}
              </DsButton>
            </div>
          </div>
        )}

        {/* 取消翻译后的部分结果提示（内联信息条） */}
        {!isExternalSettingsPageOpen && isPartialResult && !isTranslating && !translationError && (
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
                className="text-info hover:bg-info/10 [@media(pointer:coarse)]:!min-h-11"
              >
                {t('translation:workbench_ui.discard_partial')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={translationStream.acknowledgePartialResult}
                className="text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
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
              setSrcLang={handleSetSrcLang}
              tgtLang={tgtLang}
              setTgtLang={handleSetTgtLang}
              sourceText={sourceText}
              setSourceText={handleSetSourceText}
              sourceMaxChars={TRANSLATION_MAX_CHARS}
              isSourceOverLimit={isSourceOverLimit}
              translatedText={translatedText || syncedInitialTranslatedRef.current}
              isTranslating={isTranslating}
              customPrompt={customPrompt}
              setCustomPrompt={setCustomPrompt}
              showPromptEditor={showPromptEditor}
              setShowPromptEditor={setShowPromptEditor}
              formality={formality}
              setFormality={handleSetFormality}
              domain={domain}
              setDomain={handleSetDomain}
              glossary={glossary}
              setGlossary={handleSetGlossary}
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
              settingsAsPage={externalSettingsNavigation}
              isActive={isActive}
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
              canRestorePrevious={previousTranslation !== null}
              onRestorePrevious={() => void handleRestorePreviousTranslation()}
              isOutdated={isOutdated}
              onSaveAsNewVersion={handleSaveAsNewVersionAndTranslate}
              onKeepCurrentTranslation={handleKeepCurrentTranslation}
/>
        </div>

        {/* 底部状态条：检测语言回显 + 快捷键提示（桌面） */}
        {!isExternalSettingsPageOpen && (
          <div className="hidden md:flex items-center justify-between gap-3 px-4 py-1.5 border-t border-border/35 text-xs text-muted-foreground/75 select-none shrink-0">
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
                  <kbd className="rounded border border-border/35 bg-foreground/[0.03] px-1.5 py-0.5 text-[11px] leading-tight font-mono">
                    {hint.combo}
                  </kbd>
                  {hint.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
  );
};

export default TranslateWorkbench;
