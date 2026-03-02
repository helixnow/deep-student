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
  'forms', 'console', 'cloudStorage',
];

const FALLBACK_NS = ALL_NS.filter((namespace) => namespace !== 'common');
const LOADED_LOCALES: Set<SupportedLanguage> = new Set();

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
async function loadDeferredNamespaces(lang: string) {
  const resolvedLang = normalizeSupportedLanguage(lang);
  const prefix = `./locales/${resolvedLang}/`;
  if (LOADED_LOCALES.has(resolvedLang)) return;
  LOADED_LOCALES.add(resolvedLang);

  const tasks: Promise<void>[] = [];

  for (const [path, loader] of Object.entries(localeModules)) {
    if (!path.startsWith(prefix)) continue;
    // ./locales/zh-CN/settings.json -> settings
    const ns = path.slice(prefix.length).replace(/\.json$/, '');
    if (CORE_NS.has(ns)) continue;

    tasks.push(
      (loader() as Promise<{ default?: Record<string, unknown> }>)
        .then((mod) => {
          i18n.addResourceBundle(resolvedLang, ns, mod.default ?? mod, true, true);
        })
        .catch(() => {
          // 单个命名空间加载失败不影响其他（如 graph.json 可能不存在）
        })
    );
  }

  await Promise.allSettled(tasks);
}

// 立即开始加载延迟命名空间（不阻塞 i18n 导出和首帧渲染）
(async () => {
  // 优先加载当前语言，让 UI 文案尽快就位
  const currentLang = normalizeSupportedLanguage(i18n.language);
  const otherLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';

  await loadDeferredNamespaces(currentLang);
  // 后台加载另一种语言（供 fallback 和语言切换使用）
  loadDeferredNamespaces(otherLang).catch(() => {});

  i18n.on('languageChanged', (newLang) => {
    const normalized = normalizeSupportedLanguage(newLang);
    if (newLang !== normalized) {
      i18n.changeLanguage(normalized);
      return;
    }
    void loadDeferredNamespaces(normalized);
  });
})();

export default i18n;
