/**
 * 单应用演示的文案：包声明了命名空间就只下这几个（每个命名空间一个小块），
 * 没声明就下整包（与对话演示同一个块）。
 */
import type { i18n as I18n } from 'i18next';
import { demoLang } from '../lang';

const zhModules = import.meta.glob<Record<string, unknown>>('../../locales/zh-CN/**/*.json', { import: 'default' });
const enModules = import.meta.glob<Record<string, unknown>>('../../locales/en-US/**/*.json', { import: 'default' });

/** 所有入口都用到的命名空间 */
const ALWAYS = ['common'];

export async function loadDemoAppLocale(i18n: I18n, namespaces?: string[]): Promise<void> {
  let bundles: Record<string, Record<string, unknown>>;
  if (namespaces?.length) {
    const modules = demoLang === 'en-US' ? enModules : zhModules;
    const wanted = new Set([...ALWAYS, ...namespaces]);
    const entries = await Promise.all(
      Object.entries(modules)
        .map(([path, loader]) => [path.replace(/^.*\/locales\/[^/]+\//, '').replace(/\.json$/, ''), loader] as const)
        .filter(([ns]) => wanted.has(ns))
        .map(async ([ns, loader]) => [ns, await loader()] as const),
    );
    bundles = Object.fromEntries(entries);
  } else {
    const mod = demoLang === 'en-US' ? await import('../locales/en-US') : await import('../locales/zh-CN');
    bundles = mod.default;
  }
  for (const [ns, resources] of Object.entries(bundles)) {
    i18n.addResourceBundle(demoLang, ns, resources, true, true);
  }

  // MCP 内置服务器名在模块初始化时就被求值（几乎所有窗口都会间接引到），为它下载整个 settings（150KB）不值得
  if (!i18n.exists('settings:mcp_server_list.builtinServerName')) {
    i18n.addResource(demoLang, 'settings', 'mcp_server_list.builtinServerName', demoLang === 'en-US' ? 'Built-in Tools' : '内置工具');
  }

  // 漏声明的命名空间会露出原始键名：记下来给烟测看
  const missing = new Set<string>();
  window.__DEMO_MISSING_I18N__ = [];
  i18n.options.saveMissing = true;
  i18n.options.missingKeyHandler = (_lngs, ns, key) => {
    const id = `${ns}:${key}`;
    if (missing.has(id)) return;
    missing.add(id);
    window.__DEMO_MISSING_I18N__ = [...missing];
  };
  await i18n.changeLanguage(demoLang);
  document.documentElement.lang = demoLang;
}
