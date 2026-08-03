import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { normalizeSupportedLanguage, type SupportedLanguage } from './types/i18n';

// ============================================================================
// 🚀 性能优化：只同步导入首屏必需的核心翻译（common + sidebar）
// 其余 ~1MB+ 命名空间在 i18n 初始化后通过 import.meta.glob 异步加载
// 大幅减少初始 bundle 体积，缩短白屏时间
// ============================================================================

// 首屏核心翻译 — 两种语言都需要（fallbackLng: 'en-US' 要求 en-US 始终可用）
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNSidebar from './locales/zh-CN/sidebar.json';
import enUSCommon from './locales/en-US/common.json';
import enUSSidebar from './locales/en-US/sidebar.json';

// 完整命名空间列表（保持与组件 useTranslation 引用一致）
// 注：knowledge_graph 在 common.json 内；graph 无独立文件，已移除
const ALL_NS = [
  'common', 'sidebar', 'settings', 'analysis', 'enhanced_rag', 'anki',
  'template', 'data', 'chat_host', 'chat_module', 'chatV2', 'notes',
  'exam_sheet', 'card_manager', 'dev', 'drag_drop',
  'pdf', 'textbook', 'graph_conflict', 'translation',
  'essay_grading', 'app_menu', 'learningHub', 'dstu', 'migration',
  'skills', 'command_palette', 'backend_errors', 'mcp', 'workspace',
  'stats', 'llm_usage', 'review', 'practice', 'sync', 'mindmap', 'vfs',
  'forms', 'console', 'cloudStorage', 'todo', 'workbench', 'flashcards',
  'quickAssistant',
];

const FALLBACK_NS = ALL_NS.filter((namespace) => namespace !== 'common');

type DeferredLocaleState = {
  loadedNamespaces: Set<string>;
  inFlight: Promise<void> | null;
};

const DEFERRED_LOCALE_STATES = new Map<SupportedLanguage, DeferredLocaleState>();

function getDeferredLocaleState(lang: SupportedLanguage): DeferredLocaleState {
  const existing = DEFERRED_LOCALE_STATES.get(lang);
  if (existing) return existing;

  const created: DeferredLocaleState = {
    loadedNamespaces: new Set(),
    inFlight: null,
  };
  DEFERRED_LOCALE_STATES.set(lang, created);
  return created;
}

// 已同步加载的核心命名空间（延迟加载时跳过）
const CORE_NS = new Set(['common', 'sidebar']);

// Vite glob 延迟导入：匹配所有 locale JSON 文件
// 每个条目是 () => Promise<module>，在调用时才加载对应 chunk
const localeModules = import.meta.glob('./locales/**/*.json');

// 初始资源：仅含核心命名空间
const resources = {
  'zh-CN': {
    common: zhCNCommon,
    sidebar: zhCNSidebar,
  },
  'en-US': {
    common: enUSCommon,
    sidebar: enUSSidebar,
  },
};

if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      defaultNS: 'common',
      ns: ALL_NS,
      supportedLngs: ['en-US', 'zh-CN'],
      fallbackLng: {
        'en': ['en-US'],
        'zh': ['zh-CN'],
        default: ['en-US'],
      },
      fallbackNS: FALLBACK_NS,

      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        caches: ['localStorage'],
        lookupLocalStorage: 'i18nextLng',
      },

      interpolation: {
        escapeValue: false,
      },

      react: {
        useSuspense: false,
        bindI18nStore: 'added',
      },

      returnObjects: true,
      debug: false,
    });
}

/**
 * 🚀 异步加载指定语言的所有延迟命名空间
 * 使用 import.meta.glob 生成的懒加载器，并行请求 JSON chunk
 * addResourceBundle 会触发 react-i18next 的 'added' 事件，自动刷新使用对应 ns 的组件
 */
async function loadDeferredNamespaces(lang: string): Promise<void> {
  const resolvedLang = normalizeSupportedLanguage(lang);
  const state = getDeferredLocaleState(resolvedLang);

  // 同一语言只保留一个并发加载批次；批次结束后，失败的 namespace 可由下次请求重试。
  if (state.inFlight) return state.inFlight;

  const prefix = `./locales/${resolvedLang}/`;
  const tasks: Promise<void>[] = [];

  for (const [path, loader] of Object.entries(localeModules)) {
    if (!path.startsWith(prefix)) continue;
    // ./locales/zh-CN/settings.json -> settings
    const ns = path.slice(prefix.length).replace(/\.json$/, '');
    if (CORE_NS.has(ns)) continue;
    if (state.loadedNamespaces.has(ns)) continue;

    tasks.push(
      (async () => {
        const mod = await (loader() as Promise<{ default?: Record<string, unknown> }>);
        i18n.addResourceBundle(resolvedLang, ns, mod.default ?? mod, true, true);
        // 仅在资源真正写入 store 后置为成功；失败项保持未加载，允许后续重试。
        state.loadedNamespaces.add(ns);
      })()
    );
  }

  const batch = Promise.allSettled(tasks).then(() => undefined);
  state.inFlight = batch;

  try {
    await batch;
  } finally {
    if (state.inFlight === batch) {
      state.inFlight = null;
    }
  }
}

function requestDeferredNamespaces(lang: string): void {
  void loadDeferredNamespaces(lang).catch(() => {
    // 批次级异常也不阻塞 UI；状态已在 finally 中释放，后续语言事件仍可重试。
  });
}

// 必须在首个异步加载开始前监听，避免用户在启动加载期间切换语言时漏掉事件。
i18n.on('languageChanged', (newLang) => {
  const normalized = normalizeSupportedLanguage(newLang);
  requestDeferredNamespaces(normalized);

  if (newLang !== normalized) {
    void i18n.changeLanguage(normalized).catch(() => {});
  }
});

// 立即开始加载延迟命名空间（不阻塞 i18n 导出和首帧渲染）
void (async () => {
  // 优先加载启动时的当前语言，让 UI 文案尽快就位。
  const initialLang = normalizeSupportedLanguage(i18n.language);
  await loadDeferredNamespaces(initialLang);

  // 加载期间语言可能已切换；等待当前活动语言就绪，并复用 languageChanged 启动的批次。
  const activeLang = normalizeSupportedLanguage(i18n.language);
  await loadDeferredNamespaces(activeLang);

  // 后台加载另一种语言（供 fallback 和后续语言切换使用）。
  const otherLang = activeLang === 'zh-CN' ? 'en-US' : 'zh-CN';
  requestDeferredNamespaces(otherLang);
})().catch(() => {
  // 保持首帧非阻塞；后续 languageChanged 仍会发起可重试加载。
});

export default i18n;
