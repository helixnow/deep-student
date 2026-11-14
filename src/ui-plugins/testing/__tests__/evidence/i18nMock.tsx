/**
 * react-i18next stand-in for the evidence suite. Same behaviour as the shared CT mock
 * (`tests/ct/mocks/react-i18next.tsx`, same namespaces) with one correction, so evidence shows the labels
 * users see: `t(key, 'fallback')` looks the key up first and only falls back on a miss. The shared mock
 * returns the fallback directly, so e.g. `t(def.nameKey, def.typeId)` rendered the app typeId.
 * Loading every zh-CN namespace (import.meta.glob) makes a cold boot exceed the 10 s hook timeout.
 *
 * Use in a test file: `vi.mock('react-i18next', () => import('./i18nMock'));`
 */
import React from 'react';
import zhSidebar from '@/locales/zh-CN/sidebar.json';
import zhCommon from '@/locales/zh-CN/common.json';
import zhChatV2 from '@/locales/zh-CN/chatV2.json';
import zhNotes from '@/locales/zh-CN/notes.json';
import zhData from '@/locales/zh-CN/data.json';
import zhWorkbench from '@/locales/zh-CN/workbench.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import zhExamSheet from '@/locales/zh-CN/exam_sheet.json';
import zhPractice from '@/locales/zh-CN/practice.json';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import zhReview from '@/locales/zh-CN/review.json';

type Dict = Record<string, unknown>;

const BUNDLES: Record<string, Dict> = {
  sidebar: zhSidebar, common: zhCommon, chatV2: zhChatV2, notes: zhNotes, data: zhData, workbench: zhWorkbench,
  settings: zhSettings, exam_sheet: zhExamSheet, practice: zhPractice, learningHub: zhLearningHub, review: zhReview,
};

function lookupPath(root: Dict, path: string): string | undefined {
  if (typeof root[path] === 'string') return root[path] as string;
  let cur: unknown = root;
  for (const part of path.split('.')) {
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

export const t = (key: string, options?: any): any => {
  const opts = typeof options === 'string' ? { defaultValue: options } : options;
  let resolvedKey = key;
  let ns: string | undefined = typeof opts?.ns === 'string' ? opts.ns : undefined;
  if (key.includes(':')) {
    const [prefix, rest] = key.split(':', 2);
    ns = prefix;
    resolvedKey = rest;
  }
  const bundle = ns ? BUNDLES[ns] : undefined;
  const fromBundle = bundle ? lookupPath(bundle, resolvedKey) : undefined;
  if (fromBundle != null) return interpolate(fromBundle, opts);
  const value = opts?.defaultValue ?? key;
  if (typeof value !== 'string' || !opts) return value;
  return interpolate(value, opts);
};

export function Trans({ i18nKey, values, children }: { i18nKey?: string; values?: Record<string, unknown>; children?: React.ReactNode; components?: Record<string, React.ReactElement> }) {
  return <>{i18nKey ? t(i18nKey, values) : children}</>;
}

export const i18n = { changeLanguage: () => Promise.resolve(), language: 'zh-CN', t };

// Stable per-namespace `t`, like real react-i18next (components put `t` in effect deps).
const cache = new Map<string, { t: (key: string, options?: any) => any; i18n: typeof i18n }>();

export const useTranslation = (ns?: string | string[]) => {
  const cacheKey = Array.isArray(ns) ? ns.join('|') : (ns ?? '');
  let cached = cache.get(cacheKey);
  if (!cached) {
    const defaultNs = Array.isArray(ns) ? ns[0] : ns;
    cached = {
      t: (key: string, options?: any) => {
        const opts = typeof options === 'string' ? { defaultValue: options } : options;
        return t(key, defaultNs ? { ...opts, ns: opts?.ns ?? defaultNs } : opts);
      },
      i18n,
    };
    cache.set(cacheKey, cached);
  }
  return cached;
};

export const initReactI18next = { type: '3rdParty' as const, init: () => {} };

export default { useTranslation, initReactI18next };
