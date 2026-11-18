/**
 * 演示的界面文案：一种语言的全部命名空间打进同一个块，演示入口只按 ?lang= 取其中一个，
 * 运行时不再按命名空间一个个下语言包（src/i18n.ts 在演示构建里也不会去下）。
 */
export function toBundles(modules: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(modules).map(([path, data]) => [path.replace(/^.*\/locales\/[^/]+\//, '').replace(/\.json$/, ''), data]),
  );
}
