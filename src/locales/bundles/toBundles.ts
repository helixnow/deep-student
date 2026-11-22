/**
 * 将 Vite `import.meta.glob('../../locales/<lang>/**\/*.json')` 返回的路径键归一化为 i18next 命名空间名。
 *
 * 不同构建配置（根 Vite / `mobile/vite.app.ts` / `vite.demo.config.ts`）产出的相对路径前缀不同，
 * 例如 `../../locales/zh-CN/settings.json` 或 `../zh-CN/settings.json`（不含 `/locales/` 段）；
 * 统一剥离语言目录之前的全部前缀与 `.json` 后缀，避免命名空间错挂成路径导致界面退化为原始翻译键。
 */
export function normalizeBundleNamespace(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(?:locales\/)?[a-z]{2}(?:-[A-Za-z]{2,4})?\/(.+?)\.json$/);
  if (match?.[1]) return match[1];
  const basename = normalized.split('/').pop() ?? normalized;
  return basename.replace(/\.json$/, '');
}

/**
 * 演示与移动端的界面文案：一种语言的全部命名空间打进同一个块，运行时按语言整包加载，
 * 不再按命名空间一个个发本地/网络请求。
 */
export function toBundles(modules: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(modules).map(([path, data]) => [
      normalizeBundleNamespace(path),
      data,
    ]),
  );
}
