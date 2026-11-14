/**
 * 共享依赖：让第三方 UI 插件的 `import 'react'` 等解析到宿主的同一份单例（FRONTEND.md §3）。
 *
 * 做法：为每个共享模块生成一个 ESM 源（从 `window.__DS_SHARED__[名字]` 导出全部具名成员与 default），
 * 用 blob URL 托管，再插入一个 `<script type="importmap">` 把裸模块名映射到这些 URL。Chromium 支持在页面运行
 * 期间追加 import map（Electron 45），只要在第一个第三方插件 `import()` 之前调用即可。
 */

export interface SharedModuleEnv {
  createObjectURL(blob: Blob): string;
  appendImportMap(json: string): void;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(['default', 'await', 'enum', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield', 'arguments', 'eval']);

/** 生成某个共享模块的 ESM 源码（导出名来自运行时对象的自有可枚举键）。 */
export function sharedModuleSource(name: string, value: object): string {
  const lines = [`const m = globalThis.__DS_SHARED__[${JSON.stringify(name)}];`, 'export default (m && m.default !== undefined ? m.default : m);'];
  for (const key of Object.keys(value).sort()) {
    if (!IDENT.test(key) || RESERVED.has(key)) continue;
    lines.push(`export const ${key} = m[${JSON.stringify(key)}];`);
  }
  return lines.join('\n');
}

const browserEnv = (): SharedModuleEnv => ({
  createObjectURL: (blob) => URL.createObjectURL(blob),
  appendImportMap: (json) => {
    const el = document.createElement('script');
    el.type = 'importmap';
    // Production Electron CSP omits 'unsafe-inline'; pair with serveDist per-response nonce when present.
    const nonce = document.querySelector('meta[name="ds-csp-nonce"]')?.getAttribute('content');
    if (nonce) el.nonce = nonce;
    el.textContent = json;
    document.head.appendChild(el);
  },
});

let installed: Record<string, string> | null = null;

/**
 * 安装共享模块映射；重复调用返回首次结果（import map 一旦生效不能修改）。
 * @returns 裸模块名 → blob URL
 */
export function installSharedModules(modules: Record<string, object>, env: SharedModuleEnv = browserEnv()): Record<string, string> {
  if (installed) return installed;
  (globalThis as unknown as { __DS_SHARED__: Record<string, object> }).__DS_SHARED__ = { ...modules };
  const imports: Record<string, string> = {};
  for (const [name, value] of Object.entries(modules)) {
    const src = sharedModuleSource(name, value);
    imports[name] = env.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  env.appendImportMap(JSON.stringify({ imports }));
  installed = imports;
  return imports;
}

/** 仅供测试重置。 */
export function __resetSharedModulesForTest(): void {
  installed = null;
}
