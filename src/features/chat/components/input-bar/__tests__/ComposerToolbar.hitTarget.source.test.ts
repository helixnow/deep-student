/**
 * 右簇触控命中区 source 契约（0824 Wave2-C R3 · TDD 先行）
 *
 * ⚠️ 预期状态：本文件描述「右簇命中机制」落地后的目标形态，机制落地后应全部转绿。
 * 在基线 e90fb360 上，以下断言预期为红（这是刻意的，不是测试写错了）：
 * - 右簇（水位环 / 推理触发器）仍用 after:-inset 透明伪元素做默认命中扩区。
 *   右簇 gap-2 只有 8px，而 -inset-2 每侧外扩 8px：相邻控件的伪元素命中区互相
 *   压进对方视觉盒，DOM 靠后的伪元素叠在上面偷走邻居的点击（adjacency 偷点）。
 * - 水位环存在双重扩区：ComposerToolbar 内环 span 与 ContextUsagePopover 的
 *   AppMenuTrigger 包装 span 各挂了一个 [@media(pointer:coarse)]:after:-inset-2。
 *
 * 契约（机制落地后）：
 * 1. 右簇 JSX 不再引用任何 after:-inset 扩区（含通过样式常量间接引用）；
 * 2. 水位环命中区单一所有者：环 span + popover 触发器合计 after:-inset ≤ 1；
 * 3. 所有权断言保留：控件与 testid 仍在、右簇顺序不变。
 *    刻意不做「数有多少处 min-h-11」之类的尺寸计数断言——真实像素命中
 *    属 Playwright CT / 设计走查，不在 source 扫描里假装量到。
 *
 * ⚠️ 机制落地时需同步修订 InputBarUI.mobileSplitContract.source.test.ts：
 *    其中 `expect(toolbarSource).toContain('[@media(pointer:coarse)]:after:-inset-2')`
 *    与本契约方向相反，落地后必须改写/删除，否则两个测试互斥。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readInputBarSource = (file: string) =>
  readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar', file),
    'utf-8'
  );

const toolbarSource = readInputBarSource('ComposerToolbar.tsx');
const popoverSource = readInputBarSource('ContextUsagePopover.tsx');

/**
 * 提取源码中的字符串字面量内容（' / " / `），与 R7 补遗
 * （ComposerToolbar.hitTarget.r7.source.test.ts）同款扫描：
 * className 只能经字符串字面量进 JSX，注释文本天然被排除——
 * 机制落地后源码注释里合法地提到「after:-inset」（解释为什么不用它），
 * 原始子串计数会把注释算进所有者数，必然误红。
 */
const extractStringLiterals = (source: string): string[] => {
  const literalPattern =
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;
  return (source.match(literalPattern) ?? []).map((literal) => literal.slice(1, -1));
};

/** 只统计出现在字符串字面量里的 needle（每个含 needle 的字面量计 1） */
const countLiteralOccurrences = (haystack: string, needle: string): number =>
  extractStringLiterals(haystack).filter((literal) => literal.includes(needle)).length;

/**
 * 收集「初始化式（直接或传递地）包含 after:-inset」的模块级样式常量名。
 * 传递闭包：iconButtonClass = cn(..., coarseHitAreaClass) 这类二级引用也算污染，
 * 这样即使实现改成「常量套常量」也逃不过右簇引用检查；
 * 而如果机制把常量改写为 padding/尺寸方案（不再含 after:-inset），则自然解除污染。
 */
const collectHitInsetTaintedConstNames = (source: string): string[] => {
  const constPattern = /const\s+(\w+)\s*=([\s\S]*?);\s*\n/g;
  const initializers = new Map<string, string>();
  for (const match of source.matchAll(constPattern)) {
    initializers.set(match[1], match[2]);
  }

  const tainted = new Set<string>();
  for (const [name, init] of initializers) {
    if (init.includes('after:-inset')) tainted.add(name);
  }
  // 固定点迭代：引用了受污染常量的常量同样受污染
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, init] of initializers) {
      if (tainted.has(name)) continue;
      for (const taintedName of tainted) {
        if (new RegExp(`\\b${taintedName}\\b`).test(init)) {
          tainted.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  return [...tainted];
};

describe('ComposerToolbar right-cluster hit-target source contract', () => {
  const rightClusterStart = toolbarSource.indexOf('{/* 右侧按钮');
  const rightClusterSlice = toolbarSource.slice(rightClusterStart);

  const ringFnStart = toolbarSource.indexOf('function ContextWindowUsageRing');
  const ringFnEnd = toolbarSource.indexOf('export interface ComposerToolbarProps', ringFnStart);
  const ringFnSlice = toolbarSource.slice(ringFnStart, ringFnEnd);

  const popoverTriggerStart = popoverSource.indexOf('<AppMenuTrigger');
  const popoverTriggerEnd = popoverSource.indexOf('</AppMenuTrigger>', popoverTriggerStart);
  const popoverTriggerSlice = popoverSource.slice(popoverTriggerStart, popoverTriggerEnd);

  it('keeps the structural anchors this contract slices on', () => {
    // 防空断言：锚点漂移时直接红，而不是让切片断言空转通过
    expect(rightClusterStart).toBeGreaterThan(-1);
    expect(ringFnStart).toBeGreaterThan(-1);
    expect(ringFnEnd).toBeGreaterThan(ringFnStart);
    expect(popoverTriggerStart).toBeGreaterThan(-1);
    expect(popoverTriggerEnd).toBeGreaterThan(popoverTriggerStart);
  });

  it('no longer uses after:-inset pseudo expansion as the default right-cluster hit area', () => {
    // 直接内联的 after:-inset（如水位环 span、旧 coarseHitArea* 字面量）一律不允许
    expect(rightClusterSlice).not.toContain('after:-inset');
  });

  it('does not reference after:-inset style constants from the right cluster', () => {
    const taintedNames = collectHitInsetTaintedConstNames(toolbarSource);
    // 常量本身可以留给左簇（iconButtonClass → ComposerPlusMenu），但右簇不得引用
    const referencedFromRightCluster = taintedNames.filter((name) =>
      new RegExp(`\\b${name}\\b`).test(rightClusterSlice)
    );
    expect(referencedFromRightCluster).toEqual([]);
  });

  it('keeps a single hit-area owner for the context usage ring (no double after:-inset)', () => {
    // 基线上环 span 与 popover 触发器各挂一个 -inset-2（合计 2 = 双重扩区）。
    // 目标态：至多一处扩区（允许唯一所有者保留，也允许两处都改为实尺寸方案）。
    // R9 修订：只数字符串字面量里的 after:-inset——机制落地提交在两处切片
    // 内留下了「不再用 after:-inset」的说明注释，原始子串计数误伤注释。
    const ringCount = countLiteralOccurrences(ringFnSlice, 'after:-inset');
    const popoverTriggerCount = countLiteralOccurrences(popoverTriggerSlice, 'after:-inset');
    expect(ringCount + popoverTriggerCount).toBeLessThanOrEqual(1);
  });

  it('keeps ownership of every right-cluster control and its testid', () => {
    // 所有权断言：机制只换命中区实现，不得移除控件或改 testid
    for (const testId of [
      'context-window-usage-control',
      'context-window-usage-ring',
      'thinking-runtime-control',
      'thinking-runtime-menu-trigger',
      'thinking-runtime-minimal-control',
      'btn-toggle-thinking',
      'btn-send',
      'btn-stop',
      'btn-send-disabled-hint',
    ]) {
      expect(toolbarSource).toContain(`data-testid="${testId}"`);
    }
    expect(popoverSource).toContain('data-testid="context-usage-popover-trigger"');
    expect(popoverSource).toContain('data-testid="context-usage-compact-action"');
  });

  it('keeps the right-cluster order: usage ring, thinking runtime, send', () => {
    const ringMount = rightClusterSlice.indexOf('<ContextWindowUsageRing');
    const thinkingControl = rightClusterSlice.indexOf('data-testid="thinking-runtime-control"');
    const sendButton = rightClusterSlice.indexOf('data-testid="btn-send"');

    expect(ringMount).toBeGreaterThan(-1);
    expect(thinkingControl).toBeGreaterThan(ringMount);
    expect(sendButton).toBeGreaterThan(thinkingControl);
  });

  it('still ships some coarse-pointer touch-target treatment (mechanism-agnostic)', () => {
    // 只断言机制存在（padding / 实尺寸 / min-* 均可），不数出现次数、不锁具体类名
    expect(toolbarSource).toContain('[@media(pointer:coarse)]');
  });
});
