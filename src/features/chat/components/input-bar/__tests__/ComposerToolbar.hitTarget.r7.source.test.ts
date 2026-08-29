/**
 * 工具栏触控命中区 source 契约补遗（0824 Wave2-C R7 · 命中补遗）
 *
 * 与 R3 契约（ComposerToolbar.hitTarget.source.test.ts）的分工：
 * - R3 刻意 mechanism-agnostic：只断言「右簇不再用 after:-inset」+「存在某种
 *   coarse 处理」，不锁具体类名——那是机制落地前的 TDD 红绿门。
 * - 机制已落地（af0be136 起）：coarse pointer 下控件本体撑成实体
 *   min-h/min-w-[var(--touch-target-size)] 盒，命中区即盒模型。
 *   本补遗把落地后的机制本身锁进契约，堵住 R3 留下的两个缺口：
 *
 * 缺口 1（contract coarse min-h 后缀存在）：
 *   R3 只断言 '[@media(pointer:coarse)]' 前缀存在，任何 coarse 规则（哪怕是
 *   无关的 text-base）都能让它通过。补遗锁定：coarse 变体必须带
 *   min-h-[var(--touch-target-size)] 后缀，样式常量语义正确（Target 版含
 *   min-h+min-w，Height 版只含 min-h 以免 min-w 干扰 truncate），常量确有
 *   引用（防止悄悄改成死代码），且 --touch-target-size 变量仍有定义
 *   （变量被删时 min-h-[var(...)] 会静默塌成 unset，类名扫描测不出来）。
 *
 * 缺口 2（工具栏无 after:-inset 默认）：
 *   R3 的 not.toContain 只切右簇切片，左簇 iconButtonClass 若回归
 *   after:-inset 不会被抓到。补遗扩到整文件——但 ComposerToolbar.tsx 与
 *   ContextUsagePopover.tsx 的注释里合法地提到「after:-inset」字样（解释
 *   为什么不用它），全文 not.toContain 必然误红。因此本补遗只扫描字符串
 *   字面量：className 只能经字符串字面量进 JSX，注释不参与扫描。
 *
 * 预期状态：在机制已落地的当前 HEAD 上全绿；任一断言变红即机制回归。
 *
 * 边界（刻意不测）：
 * - 不数 min-h 出现次数、不锁像素值——真实命中盒归 Playwright CT
 *   （ComposerToolbar.adjacentHit.test.tsx 的几何推演）与设计走查。
 * - chips 类小部件（ActiveFeatureChips / ContextRefChips 等）仍合法使用
 *   after:-inset 扩区（本体不可点、重叠无害），不在本契约范围。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readRepoSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

const readInputBarSource = (file: string) =>
  readRepoSource(`src/features/chat/components/input-bar/${file}`);

const toolbarSource = readInputBarSource('ComposerToolbar.tsx');
const popoverSource = readInputBarSource('ContextUsagePopover.tsx');

const COARSE_MIN_H_TOKEN = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';
const COARSE_MIN_W_TOKEN = '[@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';

/**
 * 提取源码中的字符串字面量内容（' / " / `）。
 * 单双引号不跨行（TS 语法保证），模板字面量允许跨行。
 * className 只能通过字符串字面量进入 JSX，因此「所有字面量都不含
 * after:-inset」⇔「渲染类名不含 after:-inset」；注释文本天然被排除。
 */
const extractStringLiterals = (source: string): string[] => {
  const literalPattern =
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;
  return (source.match(literalPattern) ?? []).map((literal) => literal.slice(1, -1));
};

/** 抓取模块级 const 的初始化式（含跨行字符串），锚点漂移时返回空串由防空断言兜底 */
const getConstInitializer = (source: string, name: string): string => {
  const match = source.match(new RegExp(`const ${name} =([\\s\\S]*?);\\n`));
  return match?.[1] ?? '';
};

const countWordOccurrences = (haystack: string, word: string): number =>
  (haystack.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length;

describe('ComposerToolbar hit-target R7 addendum (coarse min-h contract)', () => {
  const targetClassInit = getConstInitializer(toolbarSource, 'coarseSolidTouchTargetClass');
  const heightClassInit = getConstInitializer(toolbarSource, 'coarseSolidTouchHeightClass');

  it('keeps both solid touch-target style constants declared', () => {
    // 防空断言：常量改名/删除时这里先红，后续初始化式断言不至于空转
    expect(targetClassInit).not.toBe('');
    expect(heightClassInit).not.toBe('');
  });

  it('ships the coarse min-h-[var(--touch-target-size)] suffix as the touch-target contract', () => {
    // 缺口 1 主断言：不是任意 coarse 规则，而是带 min-h + CSS 变量后缀的实体盒契约
    expect(toolbarSource).toContain(COARSE_MIN_H_TOKEN);
    expect(targetClassInit).toContain(COARSE_MIN_H_TOKEN);
    expect(targetClassInit).toContain(COARSE_MIN_W_TOKEN);
  });

  it('keeps the height-only variant free of min-w (label truncation contract)', () => {
    // 带文字标签的触发器只抬高度：min-w 会把 truncate 撑破（源码注释里的既定语义）
    expect(heightClassInit).toContain(COARSE_MIN_H_TOKEN);
    expect(heightClassInit).not.toContain(COARSE_MIN_W_TOKEN);
  });

  it('references both constants beyond their declarations (no dead-code regression)', () => {
    // 声明本身占 1 次：≥2 意味着至少有一处真实引用（JSX 或派生常量）
    expect(countWordOccurrences(toolbarSource, 'coarseSolidTouchTargetClass')).toBeGreaterThanOrEqual(2);
    expect(countWordOccurrences(toolbarSource, 'coarseSolidTouchHeightClass')).toBeGreaterThanOrEqual(2);
  });

  it('keeps --touch-target-size defined so the min-h suffix resolves', () => {
    // 变量被删时 min-h-[var(--touch-target-size)] 静默塌成 unset，类名仍在但命中区消失
    const variablesCss = readRepoSource('src/styles/shadcn-variables.css');
    expect(variablesCss).toContain('--touch-target-size:');
  });

  it('keeps the popover trigger as the solid 44x44 owner of the usage ring hit area', () => {
    const triggerStart = popoverSource.indexOf('<AppMenuTrigger');
    const triggerEnd = popoverSource.indexOf('</AppMenuTrigger>', triggerStart);
    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);

    const triggerSlice = popoverSource.slice(triggerStart, triggerEnd);
    expect(triggerSlice).toContain(COARSE_MIN_H_TOKEN);
    expect(triggerSlice).toContain(COARSE_MIN_W_TOKEN);
  });

  it('keeps the inner usage ring purely visual (single hit-area owner)', () => {
    const ringFnStart = toolbarSource.indexOf('function ContextWindowUsageRing');
    const ringFnEnd = toolbarSource.indexOf('export interface ComposerToolbarProps', ringFnStart);
    expect(ringFnStart).toBeGreaterThan(-1);
    expect(ringFnEnd).toBeGreaterThan(ringFnStart);

    const ringFnSlice = toolbarSource.slice(ringFnStart, ringFnEnd);
    // 内环 aria-hidden 且不带任何 coarse 命中处理：命中区唯一所有者是外层触发器
    expect(ringFnSlice).toContain('aria-hidden="true"');
    expect(ringFnSlice).not.toContain('[@media(pointer:coarse)]');
  });
});

describe('ComposerToolbar hit-target R7 addendum (no after:-inset default, toolbar-wide)', () => {
  it('renders no after:-inset expansion anywhere in ComposerToolbar (string literals only)', () => {
    // 缺口 2 主断言：R3 只切右簇，这里扩到整文件（左簇 iconButtonClass 回归也抓）。
    // 只扫字符串字面量——注释里合法提及 after:-inset，全文扫描会误红。
    const offenders = extractStringLiterals(toolbarSource).filter((literal) =>
      literal.includes('after:-inset')
    );
    expect(offenders).toEqual([]);
  });

  it('renders no after:-inset expansion anywhere in ContextUsagePopover (string literals only)', () => {
    const offenders = extractStringLiterals(popoverSource).filter((literal) =>
      literal.includes('after:-inset')
    );
    expect(offenders).toEqual([]);
  });

  it('still mentions after:-inset only as prose, proving the literal scan is load-bearing', () => {
    // 自证扫描方式必要性：全文含该字样（注释解释「为什么不用」），
    // 若哪天注释也删了，本断言提醒维护者可将上两条降级为全文 not.toContain
    expect(toolbarSource).toContain('after:-inset');
    expect(popoverSource).toContain('after:-inset');
  });
});
