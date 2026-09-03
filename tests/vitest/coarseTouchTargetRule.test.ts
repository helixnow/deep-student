import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import path from 'node:path';
import rule from '../../eslint-rules/coarse-touch-target.js';

/**
 * ds-components/coarse-touch-target 的行为契约。
 * 规则本体见 eslint-rules/coarse-touch-target.js，
 * 白名单见 eslint-rules/coarse-touch-target.allowlist.json。
 */
describe('ds-components/coarse-touch-target', () => {
  // Flat config rejects filenames outside its cwd before applying any config.
  // Use the filesystem root because the allowlist contract includes an absolute
  // checkout path as well as paths relative to the repository.
  const linter = new Linter({ cwd: path.parse(process.cwd()).root });

  const lint = (code: string, filename = 'src/features/example/components/Widget.tsx') =>
    linter.verify(
      code,
      {
        files: ['**/*.tsx'],
        plugins: { 'ds-components': { rules: { 'coarse-touch-target': rule as never } } },
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'ds-components/coarse-touch-target': 'error' },
      },
      filename
    );

  // ============================================================
  // coarseMinOverride：coarse 下硬编码 44px 级强制尺寸
  // ============================================================
  it.each([
    ["const c = '[@media(pointer:coarse)]:!min-h-11';", 'coarse !min-h-11'],
    ["const c = '[@media(pointer:coarse)]:!min-w-11';", 'coarse !min-w-11'],
    ["const c = '[@media(pointer:coarse)]:!h-11';", 'coarse !h-11'],
    ["const c = '[@media(pointer:coarse)]:!min-h-[44px]';", 'coarse !min-h-[44px]'],
    ["const c = '[@media(pointer:coarse)]:!min-w-[2.75rem]';", 'coarse !min-w-[2.75rem]'],
    ["const c = '!px-2 text-sm [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!px-3';", 'inside a class list'],
    ['const c = `gap-2 ${x} [@media(pointer:coarse)]:!min-h-11`;', 'template literal'],
    ["const c = '!min-h-[44px] w-full';", 'bare !min-h-[44px]（写死触控常量）'],
    ["const c = '!min-w-[2.75rem]';", 'bare !min-w-[2.75rem]'],
  ])('flags %s (%s)', code => {
    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('coarseMinOverride');
  });

  // ============================================================
  // bareHitInset：裸 after/before 负 inset 伪元素扩区
  // ============================================================
  it.each([
    ["const c = 'relative after:absolute after:-inset-1.5 after:content-[\\'\\']';", 'bare after:-inset'],
    ["const c = '[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2';", 'coarse-scoped after:-inset'],
    ["const c = 'before:-inset-y-[13px]';", 'before axis + arbitrary value'],
    ["const c = '[@media(pointer:coarse)]:after:-inset-[16px]';", 'arbitrary px value'],
  ])('flags %s (%s)', code => {
    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('bareHitInset');
  });

  it('reports both patterns when a string mixes them', () => {
    const messages = lint(
      "const c = '[@media(pointer:coarse)]:!min-h-11 relative after:-inset-2';"
    );
    expect(messages.map(m => m.messageId).sort()).toEqual(['bareHitInset', 'coarseMinOverride']);
  });

  // ============================================================
  // 放行：token 形、体系写法、边界值
  // ============================================================
  it.each([
    // token 形：coarse 下走 var(--touch-target-size)
    "const c = '[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';",
    "const c = 'min-h-[var(--touch-target-size)] lg:min-h-[var(--button-height)]';",
    // DsButton contract（buttonPrimitiveContract.ts）coarse 保底后缀：token 形、非 important
    "const c = 'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-ui lg:h-[var(--button-height)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';",
    "const c = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';",
    // nav variant 的裸 min-h-[2.75rem]（无 important，不是散点覆盖）
    "const c = 'flex min-h-[2.75rem] w-full lg:min-h-9';",
    // 非 !important 的 coarse min（存量惯用形，本轮边界外，见 03-lint.md）
    "const c = '[@media(pointer:coarse)]:min-h-11';",
    "const c = '[@media(pointer:coarse)]:min-h-[2.75rem]';",
    // 44 级以外的 coarse 尺寸微调（COARSE_HIT 里配套的视觉尺寸）
    "const c = '[@media(pointer:coarse)]:!h-9 [@media(pointer:coarse)]:!w-9';",
    // 裸 !min-h-11 不带 coarse：可能是正常桌面布局尺寸
    "const c = '!min-h-11';",
    // 11 是前缀但不是 44px：!h-110 / !h-11.5 不应误报
    "const c = '[@media(pointer:coarse)]:!h-11.5';",
    // 正值 inset / 1px 装饰描边不是命中区扩张
    "const c = 'after:inset-x-0 after:top-full';",
    "const c = 'after:-inset-px';",
    // 与 inset 无关的负值类
    "const c = '[@media(pointer:coarse)]:!-m-2';",
  ])('allows %s', code => {
    expect(lint(code)).toEqual([]);
  });

  // ============================================================
  // 白名单：WRAP-UP/ROUND 登记的有意折衷文件整体豁免
  // ============================================================
  it.each([
    'src/components/translation/TranslationMain.tsx',
    'src/features/learning-hub/components/finder/FinderToolbar.tsx',
    'src/features/learning-hub/components/TabBar.tsx',
    '/abs/checkout/src/components/essay-grading/InputPanel.tsx',
  ])('allowlists %s', filename => {
    const code =
      "const c = '[@media(pointer:coarse)]:!min-h-11 relative after:-inset-1.5';";
    expect(lint(code, filename)).toEqual([]);
    // 同一段代码在未登记文件中必须照常报
    expect(lint(code).length).toBeGreaterThan(0);
  });

  // R3 摘除的条目必须回到正常拦截面：
  // ComposerToolbar 已改实体盒（去掉 after:-inset），不再是折衷；
  // MiniCalendar 的折衷（coarse h-9/w-9 非 important）本就不在拦截面内，僵尸条目已删。
  it.each([
    'src/features/chat/components/input-bar/ComposerToolbar.tsx',
    'src/features/todo/components/main/detail/MiniCalendar.tsx',
  ])('no longer allowlists %s', filename => {
    const code = "const c = '[@media(pointer:coarse)]:!min-h-11';";
    expect(lint(code, filename)).toHaveLength(1);
  });

  it('reports the offending class and the escape hatches in the message', () => {
    const [minOverride] = lint("const c = '[@media(pointer:coarse)]:!min-h-11';");
    expect(minOverride.message).toContain('[@media(pointer:coarse)]:!min-h-11');
    expect(minOverride.message).toContain('--touch-target-size');
    expect(minOverride.message).toContain('coarse-touch-target.allowlist.json');

    const [hitInset] = lint("const c = 'after:-inset-2';");
    expect(hitInset.message).toContain('after:-inset-2');
    expect(hitInset.message).toContain('@/components/ui/coarseHit');
    expect(hitInset.message).toContain('coarseHitClassFor');
  });
});
