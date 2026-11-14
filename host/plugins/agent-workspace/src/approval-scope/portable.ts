/**
 * approval-scope 的可移植子集：核心类型/常量、工具分类、作用域标识、shell 分析与 guard 的纯判定。
 *
 * 与 `../approval-scope.ts`（桌面 barrel）的差异只有两处：
 * - `env.ts` 的 macOS developer dir 探测与 `fs::canonicalize` 由桌面 barrel 注入（`env.node.ts`），
 *   未注入时按“没有 developer dir / 词法规整”降级；
 * - `path-operands.ts`（`validateShellPathOperandsWithinRoot`）依赖 `node:fs`，只由桌面 barrel 发布。
 */
export * from './core.ts';
export * from './classification.ts';
export * from './env.ts';
export * from './scope.ts';
export * from './shell-analysis.ts';
export * from './shell-guard.ts';
export * from './keys.ts';
