/**
 * 页面形态：完整前端只在 `--mode app` 构建、页面有 `#root`、且没有 `?diagnostics=1` 时挂载；其余都是诊断页。
 * 诊断构建（`--mode diagnostics`，Playwright 用）即使页面有 `#root` 也只显示诊断结果。
 */
export interface PageModeInput {
  /** `import.meta.env.MODE`。 */
  readonly mode: string;
  /** `location.search`。 */
  readonly search: string;
  readonly hasRoot: boolean;
}

export const APP_MODE = 'app';

export function shouldMountApp({ mode, search, hasRoot }: PageModeInput): boolean {
  if (mode !== APP_MODE || !hasRoot) return false;
  const diagnostics = new URLSearchParams(search).get('diagnostics');
  return diagnostics === null || diagnostics === '0' || diagnostics === 'false';
}
