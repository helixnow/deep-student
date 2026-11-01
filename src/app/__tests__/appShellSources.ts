import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * App 壳层源码契约的统一读取入口。
 *
 * App.tsx 拆分后，原先写在 App.tsx 内的逻辑分布在 config/app-shell-sources.json
 * 列出的文件中（App.tsx 在前，其余按搬出顺序）。源码契约——尤其 not.toContain /
 * not.toMatch 等负向断言——必须覆盖全部这些文件，否则把代码搬出 App.tsx 会让
 * 负向断言空转通过。
 */
export const APP_SHELL_SOURCE_FILES: readonly string[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/app-shell-sources.json'), 'utf-8'),
).files;

/** App.tsx 与所有搬出模块的源码，按登记顺序以换行拼接。 */
export function readAppShellSource(): string {
  return APP_SHELL_SOURCE_FILES
    .map((file) => readFileSync(resolve(process.cwd(), file), 'utf-8'))
    .join('\n');
}
