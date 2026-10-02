/**
 * ESLint 自定义规则：Tooltip 只允许一个实现入口
 *
 * 背景（2026-10 组件统一）：Tooltip 的定位 / 延迟 / 动效 / 层级 / 无障碍
 * 收敛到唯一实现 `@/components/ui/shad/Tooltip`。CommonTooltip 已退化为
 * 只做 props 翻译的适配层（同引擎、同 DOM、同 class），不再是独立组件，
 * 因此**新代码不应再引用它**——每个新调用点都应直接写 shad 三段式 API，
 * 免得适配层长期挂着、迟迟迁不完。
 *
 * 拦截两类导入：
 *   1. CommonTooltip（别名或相对路径皆拦）
 *   2. react-tooltip 第三方库（历史上被禁，至今不得复活）
 *
 * 存量豁免（eslint-rules/common-tooltip.allowlist.json）：
 * ~130 处调用点分布在 60+ 个文件里，逐文件迁移并从本表删除对应条目即可。
 * 白名单只登记"还没迁"，不构成长期例外；新文件一律不放行。
 *
 * 与 no-restricted-imports 分工：后者是纯静态名单，改名单要动 eslint.config.js；
 * 本规则需要按文件豁免迁移存量，故自带 allowlist。
 *
 * @example
 * // ❌ 错误（新代码）
 * import { CommonTooltip } from '@/components/shared/CommonTooltip';
 * // ✅ 正确
 * import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** CommonTooltip 模块的匹配：别名导入与相对路径导入。 */
const COMMON_TOOLTIP_MODULE =
  /^(?:@\/components\/shared\/CommonTooltip|.*[\\/]CommonTooltip)$/;

/** react-tooltip 第三方库及其子路径。 */
const REACT_TOOLTIP_MODULE = /^react-tooltip(?:\/.*)?$/;

/** 规则自身的实现文件与过渡适配层本体不属于"业务调用点"。 */
const ALWAYS_ALLOWED = [
  'src/components/shared/CommonTooltip.tsx',
  'src/components/ui/shad/Tooltip.tsx',
];

/** 白名单：已登记待迁移的存量文件（posix 相对路径，理由见 JSON） */
const loadAllowlist = () => {
  try {
    const moduleUrl = new URL(import.meta.url);
    const allowlistPath =
      moduleUrl.protocol === 'file:'
        ? new URL('./common-tooltip.allowlist.json', moduleUrl)
        : path.join(
            import.meta.dirname ?? path.join(process.cwd(), 'eslint-rules'),
            'common-tooltip.allowlist.json'
          );

    return JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    console.warn(
      '[ds-components/no-legacy-tooltip] Failed to load allowlist; treating every CommonTooltip import as new code.',
      error
    );
    return { files: [] };
  }
};

const allowlist = loadAllowlist();
const ALLOWED_FILES = (allowlist.files ?? []).map((entry) => entry.path);

const normalize = (filename) => filename.replace(/\\/g, '/');

const matches = (posixFile, candidate) =>
  posixFile === candidate || posixFile.endsWith(`/${candidate}`);

const isAllowedFile = (filename) => {
  if (!filename) return false;
  const posix = normalize(filename);
  if (ALWAYS_ALLOWED.some((candidate) => matches(posix, candidate))) return true;
  return ALLOWED_FILES.some((candidate) => matches(posix, candidate));
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tooltip 统一走 @/components/ui/shad/Tooltip；禁止新增 CommonTooltip 与 react-tooltip 引用',
      recommended: true,
    },
    messages: {
      commonTooltip:
        '❌ Tooltip 唯一实现是 @/components/ui/shad/Tooltip。请改写为'
        + '<Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent …>…</TooltipContent></Tooltip>；'
        + 'CommonTooltip 只是待退役的迁移适配层，不要在新代码里新增引用。'
        + '存量文件改完请从 eslint-rules/common-tooltip.allowlist.json 删除对应条目。',
      reactTooltip:
        '❌ 禁止使用 react-tooltip 第三方库。请使用 @/components/ui/shad/Tooltip。',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (isAllowedFile(filename)) return {};

    const check = (node, source) => {
      if (typeof source !== 'string') return;
      if (REACT_TOOLTIP_MODULE.test(source)) {
        context.report({ node, messageId: 'reactTooltip' });
        return;
      }
      if (COMMON_TOOLTIP_MODULE.test(source)) {
        context.report({ node, messageId: 'commonTooltip' });
      }
    };

    return {
      // import ... from '...'（含 export ... from '...'）
      'ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration'(node) {
        check(node, node.source?.value);
      },
      // import('...') 动态导入
      ImportExpression(node) {
        check(node, node.source?.value);
      },
      // require('...')
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'Identifier' || callee.name !== 'require') return;
        check(node, node.arguments[0]?.value);
      },
    };
  },
};