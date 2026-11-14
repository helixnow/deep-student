import zh from '../../../locales/zh-CN/plugin_manager.json';

type Dict = Record<string, unknown>;

function lookup(root: Dict, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Dict)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(template: string, options?: Record<string, unknown>): string {
  if (!options) return template;
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (placeholder, name: string) => {
    const replacement = options[name];
    return replacement == null ? placeholder : String(replacement);
  });
}

/**
 * 测试用翻译：读真实的 zh-CN 文案，保持断言的文案与产品一致（同时验证 key 存在）。
 * 未命中的 key 原样返回，测试会直接看到漏键。
 */
export const t = (key: string, options?: Record<string, unknown> | string): string => {
  if (typeof options === 'string') return options;
  const path = key.startsWith('plugin_manager:') ? key.slice('plugin_manager:'.length) : key;
  return interpolate(lookup(zh as Dict, path) ?? key, options);
};

/** `vi.mock('react-i18next', ...)` 的工厂体；useTranslation 返回上面的 t。 */
export const i18nMock = () => ({ useTranslation: () => ({ t }) });
