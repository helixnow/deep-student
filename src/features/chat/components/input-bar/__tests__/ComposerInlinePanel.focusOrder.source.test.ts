/**
 * 0824 Wave2-C R4「读屏顺序」静态断言：移动端内联面板的焦点/读屏契约。
 *
 * 契约（对源码断言，运行时补充断言见 ComposerInlinePanel.focusOrder.test.tsx）：
 * 1. 面板 open（expanded）时是一个带 aria-label 的 role="region" 地标，
 *    且不允许无条件 inert / aria-hidden——否则读屏用户展开面板后什么都读不到。
 * 2. closing/closed（非 expanded）时面板必须 inert：0 高度收起的残留 DOM
 *    不允许再接收 Tab 焦点或被读屏枚举。
 *    ⚠️ 该用例在「卡 3（内联面板 inert 治理）」落地前为红，落地后转绿。
 * 3. Tab 顺序以源码 DOM 顺序为准。实际顺序（InputBarUI 输入壳内自上而下）是：
 *       打开的内联面板（{inlineComposerPanelNode}）
 *     → 输入区（<ComposerTextarea>）
 *     → 底部工具栏（<ComposerToolbar>）
 *    即面板在输入区上方"长出"，Tab 先进面板、再回输入区、最后到工具栏；
 *    这与视觉从上到下一致，禁止用正 tabindex 重排。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readInputBarSource = (file: string) => readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/input-bar', file),
  'utf-8'
);

/**
 * 收集源码中标识符 `inert` 的出现位置（跳过注释行），并返回每处出现
 * 前后 ±160 字符的上下文窗口，供“是否按展开态条件化”判定。
 * 同时兼容多种落地形态：JSX 条件 prop（inert={!expanded}）、
 * React 18 空串 hack（inert={expanded ? undefined : ''}）、
 * ref 命令式赋值（node.inert = !expanded）。
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
    // 注释里提到 inert 不算实现（本仓注释大量讨论 a11y 方案）
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    contexts.push(source.slice(Math.max(0, match.index - 160), match.index + 160));
  }
  return contexts;
}

describe('ComposerInlinePanel focus order & screen reader contract (source)', () => {
  const panelSource = readInputBarSource('ComposerInlinePanel.tsx');
  const inputBarSource = readInputBarSource('InputBarUI.tsx');

  describe('open 面板 = 可命名的 region 地标', () => {
    it('renders BOTH height-mode branches as role="region" with an aria-label', () => {
      // heightMode: 'available'（普通 div）与 'content'（CustomScrollArea）
      // 两条渲染分支都必须是可命名地标，缺一条就有一半面板读屏不可发现
      expect(panelSource.match(/role="region"/g)?.length).toBeGreaterThanOrEqual(2);
      expect(
        panelSource.match(/aria-label=\{ariaLabel \?\? panelKey\}/g)?.length
      ).toBeGreaterThanOrEqual(2);
    });

    it('InputBarUI supplies a human-readable ariaLabel for every inline panel case', () => {
      expect(inputBarSource).toContain('ariaLabel={inlineAriaLabel}');
      // attachment / model / mcp / advanced / skill 五个 case 都必须赋非空标签
      const caseAssignments = inputBarSource.match(/inlineAriaLabel = (?!'';)\S/g) ?? [];
      expect(caseAssignments.length).toBeGreaterThanOrEqual(5);
    });

    it('never hides the OPEN panel: no unconditional aria-hidden or inert', () => {
      // aria-hidden 只允许按展开态条件化（如 aria-hidden={!expanded}），
      // 字面 true 会把展开中的面板从读屏树里整个抠掉
      expect(panelSource).not.toMatch(/aria-hidden=(?:"true"|\{true\})/);
      // 每一处 inert 实现都必须引用 expanded / motionState（即条件化），
      // 裸 inert / inert=""（React 18 恒真 hack）都会锁死打开中的面板
      for (const context of collectInertContexts(panelSource)) {
        expect(context).toMatch(/expanded|motionState|closing|closed/);
      }
    });
  });

  describe('closing/closed 面板对焦点与读屏不可达', () => {
    // ⚠️ 卡 3（内联面板 inert 治理）落地后转绿：
    // 收起后的面板 DOM 仍挂在树上（0fr + overflow-hidden 只是视觉裁切），
    // 里面的按钮/输入依旧是 Tab 停靠点、依旧被读屏枚举，必须 inert 掉。
    it('applies inert to the collapsed panel (gated on expanded/motionState)', () => {
      // 允许落地在 ComposerInlinePanel 自身，或 InputBarUI 的内联面板包装层
      const contexts = [
        ...collectInertContexts(panelSource),
        ...collectInertContexts(
          inputBarSource.slice(
            inputBarSource.indexOf('inlineComposerPanelNode'),
            inputBarSource.indexOf('{inlineComposerPanelNode}')
          )
        ),
      ];
      const gated = contexts.filter((context) =>
        /!expanded|expanded\s*\?|motionState|closing|closed|inlineMotion/.test(context)
      );
      expect(gated.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Tab 顺序 = 源码 DOM 顺序：内联面板 → 输入区 → 工具栏', () => {
    it('keeps the inline panel slot, textarea and toolbar in visual/DOM order inside the composer shell', () => {
      const anchorIdx = inputBarSource.indexOf('data-composer-panel-anchor');
      const panelSlotIdx = inputBarSource.indexOf('{inlineComposerPanelNode}');
      const textareaIdx = inputBarSource.indexOf('<ComposerTextarea');
      const toolbarIdx = inputBarSource.indexOf('<ComposerToolbar');

      // 四个锚点都必须存在（拆分/改名时本用例应显式更新，而不是悄悄失效）
      expect(anchorIdx).toBeGreaterThan(-1);
      expect(panelSlotIdx).toBeGreaterThan(-1);
      expect(textareaIdx).toBeGreaterThan(-1);
      expect(toolbarIdx).toBeGreaterThan(-1);

      // 内联面板渲染槽必须在输入壳（anchor）内部
      expect(panelSlotIdx).toBeGreaterThan(anchorIdx);
      // 实际顺序：面板在输入区上方长出 → Tab 先面板、再输入区、最后工具栏
      expect(panelSlotIdx).toBeLessThan(textareaIdx);
      expect(textareaIdx).toBeLessThan(toolbarIdx);
    });

    it('JSX 里禁止正 tabindex 重排（Tab 顺序必须跟随 DOM 顺序）', () => {
      // 正 tabindex 会把控件提到所有 DOM 顺序焦点之前，直接破坏上面的顺序契约
      expect(inputBarSource).not.toMatch(/tabIndex=\{?[1-9]/);
      expect(panelSource).not.toMatch(/tabIndex=\{?[1-9]/);
    });
  });
});
