import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wave2-C R4「inert + clamp」源码契约：
 * 1. 收起态（closing/closed）内容容器 inert + aria-hidden——grid-rows 0fr
 *    仍挂载 children，overflow-hidden 只裁视觉，必须显式移除可聚焦性。
 * 2. 面板高度下限二段式：可用空间充足才保 160px，短横屏 + 键盘时退化为
 *    可用空间本身（≥0px）并内部滚动；禁止无条件 clamp(160px, ...)。
 * 3. 桌面 ComposerPanelOverlay 不参与本轮改动。
 */
describe('ComposerInlinePanel inert + clamp source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerInlinePanel.tsx'),
    'utf-8'
  );

  describe('collapsed content is inert and hidden from the a11y tree', () => {
    it('derives expanded strictly from open/opening motion states', () => {
      expect(source).toContain("const expanded = motionState === 'open' || motionState === 'opening';");
    });

    it('syncs the DOM inert property from the collapsed state via effect', () => {
      // React 18 JSX 属性表不识别 inert（inert={false} 会序列化成 truthy 的
      // inert="false"），必须走 DOM property——与 InlineReveal 同一模式。
      expect(source).toContain('const contentRef = React.useRef<HTMLDivElement>(null);');
      expect(source).toContain('el.inert = !expanded;');
      expect(source).toMatch(/React\.useEffect\(\(\) => \{[\s\S]*?el\.inert = !expanded;[\s\S]*?\}, \[expanded\]\);/);
    });

    it('applies ref + aria-hidden on the shared content container covering both height modes', () => {
      // inert/aria-hidden 挂在 min-h-0 overflow-hidden 容器上：
      // heightMode content/available 两个分支的 children 都经过它。
      expect(source).toMatch(
        /<div\s+ref=\{contentRef\}\s+aria-hidden=\{!expanded \|\| undefined\}\s+className="min-h-0 overflow-hidden"/
      );
    });
  });

  describe('height floor degrades on short viewports instead of overflowing', () => {
    it('no longer uses an unconditional 160px clamp floor', () => {
      expect(source).not.toContain('clamp(160px,');
    });

    it('keeps the keyboard-aware available-space calc as the single source', () => {
      expect(source).toContain(
        'const availableSpace = `calc(85vh - var(--keyboard-inset, 0px) - 180px)`;'
      );
    });

    it('guards the 160px floor behind available space with a 0px hard bottom', () => {
      // 二段式：min(160px, 可用空间) 使空间不足时下限跟随可用空间；
      // max(0px, ...) 防止 calc 结果为负。
      expect(source).toContain('const minHeightFloor = `max(0px, min(160px, ${availableSpace}))`;');
      expect(source).toContain(
        'const heightValue = `clamp(${minHeightFloor}, ${availableSpace}, ${maxHeight}px)`;'
      );
    });

    it('feeds the same heightValue to both height modes', () => {
      // available 模式定高，content 模式限高 + 内部滚动。
      expect(source).toContain('style={{ height: heightValue }}');
      expect(source).toContain("viewportProps={{ style: { maxHeight: heightValue } }}");
      expect(source).toContain('style={{ maxHeight: heightValue }}');
    });
  });

  describe('desktop overlay is untouched by this round', () => {
    it('ComposerPanelOverlay gains no inert wiring or 160px floor', () => {
      const overlay = readFileSync(
        resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerPanelOverlay.tsx'),
        'utf-8'
      );
      expect(overlay).not.toContain('inert');
      expect(overlay).not.toContain('160px');
    });
  });
});
