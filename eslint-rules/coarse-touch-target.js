/**
 * ESLint 自定义规则：coarse 触控目标必须走体系组件，禁止散点硬编码
 *
 * 背景：mobile-uiux-unify 收尾后，触控（pointer:coarse）≥44px 命中目标的
 * 正统实现集中在体系层：
 *   - DsButton / shad 原语（Button/Select/Input/Sheet/SegmentedControl…）
 *     已内建 [@media(pointer:coarse)] 44px 命中（见 buttonPrimitiveContract.ts）；
 *   - 尺寸 token：min-h-[var(--touch-target-size)]；
 *   - 小图标钮伪元素扩区逃生舱：src/components/ui/coarseHit.ts 的
 *     coarseHitClassFor36/32/28/24/Badge16 共享出口（after:-inset，
 *     仅硬布局约束撑不出实体盒时使用）。
 * 业务组件里每出现一处 `[@media(pointer:coarse)]:!min-h-11` 之类的散点覆盖，
 * 都是绕过体系层的一次退化——本规则拦截"新增散点"，存量按 warn 逐步清理。
 *
 * 两类命中：
 *   1. coarseMinOverride —— coarse 下硬编码 44px 级强制尺寸：
 *      [@media(pointer:coarse)]:!min-h-11 / !min-w-11 / !h-11 / !min-h-[44px]
 *      / !min-w-[2.75rem]，以及裸 !min-h-[44px] / !min-h-[2.75rem]。
 *      放过 token 形：…:!min-h-[var(--touch-target-size)]。
 *   2. bareHitInset —— 裸 after/before:-inset 伪元素命中区扩张
 *      （after:-inset-1.5、before:-inset-y-[13px] 等）。放过 -inset-px
 *      （1px 装饰描边）与正值 inset。
 *
 * 白名单（eslint-rules/coarse-touch-target.allowlist.json）：
 * WRAP-UP / ROUND-81~90 记录的有意折衷（TabBar、FinderToolbar、
 * 翻译 COARSE_HIT 等），按文件路径整体豁免，理由随文件登记。
 * 体系层目录（src/components/ui/**）在 eslint.config.js 里整目录关闭——
 * 那里"就是"这些模式的集中实现处。
 *
 * 本轮 warn；第 8 轮清完存量后升 error。
 *
 * @example
 * // ❌ 错误（业务组件散点覆盖）
 * <DsButton className="[@media(pointer:coarse)]:!min-h-11" />
 * <span className="relative after:absolute after:-inset-2 after:content-['']" />
 * // ✅ 正确
 * <DsButton size="sm" />                                  // 体系组件已内建
 * <div className="min-h-[var(--touch-target-size)]" />    // 尺寸 token
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** coarse 变体下的 44px 级强制尺寸覆盖：
 *  !min-h-11 / !min-w-11 / !h-11 / !w-11 / !min-h-[44px] / !min-w-[2.75rem]。
 *  `11(?![\d.])` 防止误吞 !h-110 / !h-11.5；
 *  [var(--touch-target-size)] 不在备选集里，天然放过。 */
const COARSE_MIN_OVERRIDE =
  /\[@media\(pointer:coarse\)\]:!(?:min-)?[hw]-(?:11(?![\d.])|\[44px\]|\[2\.75rem\])/;

/** 不带 coarse 前缀、但把触控目标常量写死的强制 min 尺寸：
 *  !min-h-[44px] / !min-w-[2.75rem]。lookbehind 排除任何 `xxx:` 变体前缀
 *  （coarse 形已由上一条报，避免重复；hover: 等变体形极罕见，先放过）。
 *  裸 !min-h-11 不拦——不带 coarse 时 44px 可能是正常桌面布局尺寸。 */
const BARE_IMPORTANT_44 =
  /(?<![\w:\]-])!min-[hw]-(?:\[44px\]|\[2\.75rem\])/;

/** 裸 after/before 负 inset 伪元素扩区：after:-inset-1.5 / before:-inset-y-[13px]，
 *  含 [@media(pointer:coarse)]: 前缀形（子串同样命中）。
 *  `(?:\d|\[)` 要求数字或任意值括号，放过 -inset-px（1px 装饰描边）；
 *  正值 after:inset-x-0 因缺 `-` 不命中。 */
const BARE_HIT_INSET =
  /(?<![\w-])(?:after|before):-inset(?:-[xy])?-(?:\d|\[)/;

/** 白名单：WRAP-UP / ROUND 文档登记的有意折衷文件（posix 相对路径，理由见 JSON） */
const loadAllowlist = () => {
  try {
    const moduleUrl = new URL(import.meta.url);
    const allowlistPath =
      moduleUrl.protocol === 'file:'
        ? new URL('./coarse-touch-target.allowlist.json', moduleUrl)
        : path.join(
            import.meta.dirname ?? path.join(process.cwd(), 'eslint-rules'),
            'coarse-touch-target.allowlist.json'
          );

    return JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    console.warn(
      '[ds-components/coarse-touch-target] Failed to load allowlist; continuing with an empty allowlist.',
      error
    );
    return { files: [] };
  }
};

const allowlist = loadAllowlist();
const ALLOWED_FILES = (allowlist.files ?? []).map((entry) => entry.path);

const isAllowedFile = (filename) => {
  if (!filename) return false;
  const posix = filename.replace(/\\/g, '/');
  return ALLOWED_FILES.some((path) => posix === path || posix.endsWith(`/${path}`));
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'coarse 触控目标必须走体系组件（DsButton/shad 原语/min-h-[var(--touch-target-size)]），禁止散点硬编码 [@media(pointer:coarse)]:!min-h-11 与裸 after:-inset 扩区',
      recommended: true,
    },
    messages: {
      coarseMinOverride:
        '❌ 散点硬编码 coarse 触控尺寸 "{{value}}"。触控 ≥44px 命中已由体系组件内建'
        + '（DsButton / shad 原语，见 buttonPrimitiveContract.ts），请直接使用体系组件；'
        + '确需自定义容器时用 min-h-[var(--touch-target-size)]。'
        + '有意折衷请连同理由登记 eslint-rules/coarse-touch-target.allowlist.json。',
      bareHitInset:
        '⚠️ 裸伪元素命中区扩张 "{{value}}"。请优先改用体系组件（DsButton iconOnly 等已内建'
        + ' coarse 命中），确因硬布局约束撑不出实体盒时用 @/components/ui/coarseHit 的'
        + ' coarseHitClassFor* 共享出口，并连同理由登记'
        + ' eslint-rules/coarse-touch-target.allowlist.json。',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (isAllowedFile(filename)) return {};

    const report = (node, value) => {
      const coarse = value.match(COARSE_MIN_OVERRIDE) ?? value.match(BARE_IMPORTANT_44);
      if (coarse) {
        context.report({
          node,
          messageId: 'coarseMinOverride',
          data: { value: coarse[0].trim() },
        });
      }
      const inset = value.match(BARE_HIT_INSET);
      if (inset) {
        context.report({
          node,
          messageId: 'bareHitInset',
          data: { value: inset[0].trim() },
        });
      }
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') report(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        if (raw) report(node, raw);
      },
    };
  },
};
