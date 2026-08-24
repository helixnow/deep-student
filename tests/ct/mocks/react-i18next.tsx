import zhSidebar from '../../../src/locales/zh-CN/sidebar.json';
import zhCommon from '../../../src/locales/zh-CN/common.json';
import zhChatV2 from '../../../src/locales/zh-CN/chatV2.json';
import zhNotes from '../../../src/locales/zh-CN/notes.json';
import zhData from '../../../src/locales/zh-CN/data.json';
import zhWorkbench from '../../../src/locales/zh-CN/workbench.json';
import zhSettings from '../../../src/locales/zh-CN/settings.json';
import zhExamSheet from '../../../src/locales/zh-CN/exam_sheet.json';
import zhPractice from '../../../src/locales/zh-CN/practice.json';
import zhLearningHub from '../../../src/locales/zh-CN/learningHub.json';
import zhReview from '../../../src/locales/zh-CN/review.json';

type Dict = Record<string, unknown>;

const NS_BUNDLES: Record<string, Dict> = {
  sidebar: zhSidebar as Dict,
  common: zhCommon as Dict,
  chatV2: zhChatV2 as Dict,
  notes: zhNotes as Dict,
  data: zhData as Dict,
  workbench: zhWorkbench as Dict,
  settings: zhSettings as Dict,
  exam_sheet: zhExamSheet as Dict,
  practice: zhPractice as Dict,
  learningHub: zhLearningHub as Dict,
  review: zhReview as Dict,
};

function lookupPath(root: Dict, path: string): string | undefined {
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Dict)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, options?: Record<string, unknown>): string {
  if (!options) return template;
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (placeholder, name) => {
    const replacement = options[name];
    return replacement == null ? placeholder : String(replacement);
  });
}

export const t = (key: string, options?: any) => {
  // Support both i18next signatures:
  // - t(key, { defaultValue })
  // - t(key, defaultValueString)
  if (typeof options === 'string') return options;

  let resolvedKey = key;
  let ns: string | undefined = typeof options?.ns === 'string' ? options.ns : undefined;
  if (key.includes(':')) {
    const [prefix, rest] = key.split(':', 2);
    ns = prefix;
    resolvedKey = rest;
  }

  const bundle = ns ? NS_BUNDLES[ns] : undefined;
  const fromBundle = bundle ? lookupPath(bundle, resolvedKey) : undefined;
  if (fromBundle != null) {
    return interpolate(fromBundle, options);
  }

  const value = options?.defaultValue ?? key;
  if (typeof value !== 'string' || !options) return value;
  return interpolate(value, options);
};

export const i18n = {
  changeLanguage: () => Promise.resolve(),
  language: 'zh-CN',
  t,
};

// 真实 react-i18next 在语言不变时返回身份稳定的 `t`。这里按 namespace 缓存
// 返回值，避免每次渲染生成新的 `t` 闭包：否则依赖 `t` 的 useEffect 会在
// 每次渲染后重跑并 setState，形成微任务自激死循环（测试挂起 + 堆增长）。
const useTranslationCache = new Map<string, { t: typeof t; i18n: typeof i18n }>();

export const useTranslation = (ns?: string | string[]) => {
  const cacheKey = Array.isArray(ns) ? ns.join('\u0000') : ns ?? '';
  let cached = useTranslationCache.get(cacheKey);
  if (!cached) {
    const defaultNs = Array.isArray(ns) ? ns[0] : ns;
    cached = {
      t: (key: string, options?: any) => {
        // Preserve i18next string-default signature: t(key, 'fallback')
        if (typeof options === 'string') return t(key, options);
        return t(key, defaultNs ? { ...options, ns: options?.ns ?? defaultNs } : options);
      },
      i18n,
    };
    useTranslationCache.set(cacheKey, cached);
  }
  return cached;
};

export const initReactI18next = {
  type: '3rdParty' as const,
  init: () => {},
};

export default {
  useTranslation,
  initReactI18next,
};
