/**
 * 0824 Wave2-C R7「读屏顺序」source 契约：移动端内联面板的读屏序列。
 *
 * 视角：读屏用户从上往下线性消费输入壳（SwipeBrowse 之外唯一的组合入口）。
 * 期望序列是：
 *
 *   [打开的内联面板 = 有名字的 region 地标] → 输入区 → 底部工具栏（含水位环触发器）
 *
 * 三条互锁契约（对源码断言；运行时行为由
 * src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.focusOrder.test.tsx 覆盖）：
 *
 * 1. inert 门控：closing/closed 的面板 DOM 仍挂载（grid-rows 0fr 只裁视觉），
 *    必须经 inert + aria-hidden 从读屏树里整体摘除，且两者都要按展开态条件化——
 *    无条件 inert/aria-hidden 会把「打开中」的面板也一起抠掉，读屏用户展开后
 *    什么都读不到。region 地标必须位于该门控容器内部：收起后序列里不允许残留
 *    一个空壳地标（“ghost landmark”）。
 * 2. region 名：两条 heightMode 渲染分支（普通 div / CustomScrollArea）都必须是
 *    role="region" + aria-label；InputBarUI 的五个内联面板 case（attachment /
 *    model / mcp / advanced / skill）都必须赋非空的人类可读标签——地标没有名字
 *    等于没有地标（读屏 rotor 里只会念 "region"）。
 * 3. 无 role=img 水位环：上下文水位环已改为「真按钮 + aria-label」语义
 *    （ContextUsagePopover 的 AppMenuTrigger asChild button），环形 SVG 与其
 *    容器 span 是纯装饰、必须 aria-hidden；禁止回退到旧版 role="img" + tabIndex
 *    的“可聚焦图片”形态——那会在读屏序列里插入一个念不出用途、按不动的停靠点。
 *
 * 与既有用例的分工：
 * - ComposerInlinePanel.focusOrder.source.test.ts 锁 Tab 顺序与正 tabindex 禁令；
 * - ComposerInlinePanel.inertClamp.source.test.ts 锁 inert 实现细节与高度 clamp；
 * - 本文件从 tests/vitest/mobile-uiux 视角锁「读屏序列」三件套：
 *   门控完整性（含 ghost landmark）、地标命名、水位环语义。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const INPUT_BAR_DIR = 'src/features/chat/components/input-bar';

const readInputBarSource = (file: string): string =>
  readFileSync(resolve(process.cwd(), INPUT_BAR_DIR, file), 'utf-8');

/**
 * 收集源码中标识符 `inert` 的出现位置（跳过注释行），返回每处出现前后
 * ±160 字符的上下文窗口，供「是否按展开态条件化」判定。兼容多种落地形态：
 * JSX 条件 prop、ref 命令式赋值（node.inert = !expanded）等。
 */
function collectInertContexts(source: string): string[] {
  const contexts: string[] = [];
  const pattern = /\binert\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const lineEnd = source.indexOf('\n', match.index);
    const lineText = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    const trimmed = lineText.trimStart();
    // 注释里讨论 inert 不算实现（本仓注释大量讨论 a11y 方案）
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    contexts.push(source.slice(Math.max(0, match.index - 160), match.index + 160));
  }
  return contexts;
}

describe('inline panel screen reader sequence (source contract)', () => {
  const panelSource = readInputBarSource('ComposerInlinePanel.tsx');
  const inputBarSource = readInputBarSource('InputBarUI.tsx');
  const toolbarSource = readInputBarSource('ComposerToolbar.tsx');
  const popoverSource = readInputBarSource('ContextUsagePopover.tsx');

  describe('1. inert 门控：收起的面板从读屏序列里整体消失', () => {
    it('every inert usage is gated on the expanded/motion state (none unconditional)', () => {
      const contexts = collectInertContexts(panelSource);
      // 至少一处真实实现（当前形态：effect 里 el.inert = !expanded）
      expect(contexts.length).toBeGreaterThanOrEqual(1);
      for (const context of contexts) {
        expect(context).toMatch(/expanded|motionState|closing|closed/);
      }
    });

    it('aria-hidden mirrors the same gate and is never a literal true', () => {
      // 收起态 aria-hidden、展开态必须显式撤掉（undefined，而不是 "false"）
      expect(panelSource).toContain('aria-hidden={!expanded || undefined}');
      expect(panelSource).not.toMatch(/aria-hidden=(?:"true"|\{true\})/);
    });

    it('the gate derives from open/opening motion states only', () => {
      // closing 也算收起：收起动画一开始就要从读屏树摘除，而不是等 closed
      expect(panelSource).toContain(
        "const expanded = motionState === 'open' || motionState === 'opening';"
      );
    });

    it('the region landmark lives INSIDE the gated container (no ghost landmark when collapsed)', () => {
      // 门控容器（ref={contentRef} + aria-hidden）必须出现在所有 region 之前：
      // region 是它的后代，收起时随容器一起从读屏树消失，序列里不残留空壳地标
      const gateIdx = panelSource.indexOf('ref={contentRef}');
      const firstRegionIdx = panelSource.indexOf('role="region"');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(firstRegionIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(firstRegionIdx);
    });
  });

  describe('2. region 名：打开的面板是有名字的地标', () => {
    it('both height-mode branches expose role="region" with an aria-label fallback chain', () => {
      // heightMode 'available'（普通 div）与 'content'（CustomScrollArea）
      // 两条分支缺一条，就有一半面板在读屏 rotor 里不可发现
      expect(panelSource.match(/role="region"/g)?.length).toBeGreaterThanOrEqual(2);
      expect(
        panelSource.match(/aria-label=\{ariaLabel \?\? panelKey\}/g)?.length
      ).toBeGreaterThanOrEqual(2);
    });

    it('InputBarUI assigns a non-empty human-readable label for every inline panel case', () => {
      const switchStart = inputBarSource.indexOf('switch (inlineRenderPanel)');
      expect(switchStart).toBeGreaterThan(-1);
      const switchBlock = inputBarSource.slice(
        switchStart,
        inputBarSource.indexOf('default:', switchStart)
      );

      const cases = [...switchBlock.matchAll(/case '([a-z]+)':([\s\S]*?)break;/g)];
      // 面板家族变化时本用例应显式更新（新面板必须同步登记标签，而不是悄悄漏掉）
      expect(cases.map((entry) => entry[1])).toEqual([
        'attachment',
        'model',
        'mcp',
        'advanced',
        'skill',
      ]);
      for (const [, panelKey, caseBody] of cases) {
        // 初始化的 inlineAriaLabel = ''; 在 switch 之外，这里只允许非空赋值
        expect(
          caseBody,
          `inline panel case '${panelKey}' must assign a non-empty inlineAriaLabel`
        ).toMatch(/inlineAriaLabel = (?!'')\S/);
      }
    });

    it('the label is actually wired into the region (ariaLabel prop)', () => {
      expect(inputBarSource).toContain('ariaLabel={inlineAriaLabel}');
    });

    it('reading order follows DOM: inline panel region → textarea → toolbar', () => {
      const anchorIdx = inputBarSource.indexOf('data-composer-panel-anchor');
      const panelSlotIdx = inputBarSource.indexOf('{inlineComposerPanelNode}');
      const textareaIdx = inputBarSource.indexOf('<ComposerTextarea');
      const toolbarIdx = inputBarSource.indexOf('<ComposerToolbar');
      expect(anchorIdx).toBeGreaterThan(-1);
      expect(panelSlotIdx).toBeGreaterThan(anchorIdx);
      expect(panelSlotIdx).toBeLessThan(textareaIdx);
      expect(textareaIdx).toBeLessThan(toolbarIdx);
    });
  });

  describe('3. 水位环：真按钮语义，禁止 role=img 回潮', () => {
    it('no role="img" anywhere in the toolbar or the usage popover', () => {
      // 旧版水位环是 role="img" + tabIndex 的“可聚焦图片”：读屏序列里
      // 多一个念不出用途、Enter 按不动的停靠点。已由真按钮替代，禁止回退。
      const roleImgPattern = /\brole=\{?["']img["']\}?/;
      expect(toolbarSource).not.toMatch(roleImgPattern);
      expect(popoverSource).not.toMatch(roleImgPattern);
      // 面板与输入壳侧同样不允许出现（水位环相关 JSX 曾在 InputBarUI 内）
      expect(inputBarSource).not.toMatch(roleImgPattern);
      expect(panelSource).not.toMatch(roleImgPattern);
    });

    it('ring visuals (wrapper span + svg) are decorative: aria-hidden, no tabIndex', () => {
      const ringSource = toolbarSource.slice(
        toolbarSource.indexOf('function ContextWindowUsageRing'),
        toolbarSource.indexOf('export interface ComposerToolbarProps')
      );
      expect(ringSource.length).toBeGreaterThan(0);

      // 容器 span：纯视觉内层，焦点与语义统一由外层 popover 触发器承担
      const controlIdx = ringSource.indexOf('data-testid="context-window-usage-control"');
      expect(controlIdx).toBeGreaterThan(-1);
      const controlAttrs = ringSource.slice(controlIdx, ringSource.indexOf('>', controlIdx));
      expect(controlAttrs).toContain('aria-hidden="true"');

      // SVG 本体同样从读屏树摘除
      const svgIdx = ringSource.indexOf('<svg');
      expect(svgIdx).toBeGreaterThan(-1);
      const svgAttrs = ringSource.slice(svgIdx, ringSource.indexOf('>', svgIdx));
      expect(svgAttrs).toContain('data-testid="context-window-usage-ring"');
      expect(svgAttrs).toContain('aria-hidden="true"');

      // 环子树不得自带 tabIndex（语义单一所有者 = popover 触发器按钮）
      expect(ringSource).not.toMatch(/tabIndex=/);
    });

    it('accessible semantics live on a real <button> trigger with an aria-label', () => {
      // AppMenuTrigger(asChild) 把 aria-haspopup/aria-expanded 与键盘处理
      // 合并到这个 button 上：读屏序列里水位环 = 一个有名字、可操作的按钮
      expect(popoverSource).toContain('<AppMenuTrigger asChild>');
      const buttonIdx = popoverSource.indexOf('<button');
      expect(buttonIdx).toBeGreaterThan(-1);
      const buttonAttrs = popoverSource.slice(buttonIdx, popoverSource.indexOf('>', buttonIdx));
      expect(buttonAttrs).toContain('type="button"');
      expect(buttonAttrs).toContain("aria-label={t('chatV2:tokenUsage.contextWindow')}");
      expect(buttonAttrs).toContain('data-testid="context-usage-popover-trigger"');
      // 触发器不额外设 tabIndex：原生 button 自带焦点语义
      expect(popoverSource).not.toMatch(/tabIndex=/);
    });
  });
});
