import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wave2-C R7「键盘 inset」源码契约：
 * 1. Android adjustResize vs iOS overlay 的分支语义不可漂移——
 *    inset 的定义是「布局视口被键盘遮挡的高度」，adjustResize 下布局视口
 *    随键盘收缩 → inset ≈ 0；iOS overlay 下布局视口不变 → inset ≈ 键盘高度。
 *    调用方（docked 输入栏）无需区分平台，全靠这一个公式兜底。
 * 2. 键盘判定阈值 150px + 严格大于比较——阈值变动会直接改变
 *    「地址栏收缩 / 小窗调整是否被误判为键盘」的边界。
 * 3. CSS 变量写入协议：变量名 --keyboard-inset、值带 px 单位、写在
 *    document.documentElement 上、启动时无条件先写一次 0px；
 *    transitions-dev.css 只消费不声明（var 回退 0px）。
 *
 * 仅做源码字符串断言，不执行 hook（visualViewport 单例带模块级状态，
 * 行为测试另行覆盖）。
 */
describe('useKeyboardHeight source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/hooks/useKeyboardHeight.ts'),
    'utf-8'
  );

  describe('keyboard detection threshold', () => {
    it('pins the threshold constant to 150px', () => {
      expect(source).toContain('const KEYBOARD_THRESHOLD = 150;');
    });

    it('uses strict greater-than against the height diff and rounds the result', () => {
      // diff === 150 时不判为键盘：阈值语义是「超过」而非「达到」。
      expect(source).toContain(
        'const nextHeight = diff > KEYBOARD_THRESHOLD ? Math.round(diff) : 0;'
      );
    });

    it('derives the diff from the per-width baseline, not window.innerHeight', () => {
      expect(source).toContain('const diff = baselineHeight - vv.height;');
      expect(source).not.toContain('window.innerHeight');
    });
  });

  describe('Android adjustResize vs iOS overlay branch semantics', () => {
    it('gates the inset behind keyboard detection to reject address-bar noise', () => {
      // 键盘未判定弹出时 inset 归零：iOS 地址栏收缩等 visualViewport 噪声
      // 不得泄漏成 docked 输入栏的抬升量。
      expect(source).toContain(
        'const nextInset = nextHeight > 0 ? computeLayoutViewportObscuredHeight(vv) : 0;'
      );
    });

    it('computes the inset as layout viewport minus visual viewport minus offsetTop', () => {
      // 这一个公式同时覆盖两个平台分支：
      // Android adjustResize → clientHeight 已随键盘收缩 → 差值 ≈ 0；
      // iOS overlay → clientHeight 不变 → 差值 ≈ 键盘高度。
      // offsetTop 参与是 iOS 键盘把 visualViewport 顶下去时的必要修正。
      expect(source).toContain(
        'const layoutHeight = document.documentElement.clientHeight;'
      );
      expect(source).toContain(
        'return Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));'
      );
    });

    it('documents both platform branches on the public inset hook', () => {
      expect(source).toContain(
        'Android adjustResize：布局视口已随键盘收缩 → 返回 0（避免双重抬升）；'
      );
      expect(source).toContain(
        'iOS overlay 键盘：布局视口不变 → 返回被遮挡高度（≈ 键盘高度）。'
      );
    });

    it('enables tracking only on Android or iOS-like platforms', () => {
      // 桌面端窗口高度变化不得被判定为键盘。
      expect(source).toContain('if (!vv || (!isAndroid() && !isIOSLike())) return;');
      expect(source).toContain("import { isAndroid } from '@/utils/platform';");
    });

    it('detects iPadOS desktop-UA via MacIntel + multi-touch', () => {
      expect(source).toContain("(navigator.platform || '') === 'MacIntel'");
      expect(source).toContain('navigator.maxTouchPoints > 1');
    });

    it('listens to visualViewport scroll for the iOS-only offsetTop path', () => {
      expect(source).toContain("vv.addEventListener('resize', handleViewportChange);");
      expect(source).toContain("vv.addEventListener('scroll', handleViewportChange);");
    });

    it('keeps the navigation guard Android-only', () => {
      // iOS 无 adjustResize 引发的焦点/落点错位问题，不参与导航拦截。
      expect(source).toMatch(
        /export function shouldBlockMobileNavigation\(\): boolean \{\s*\n\s*if \(!isAndroid\(\)\) return false;/
      );
    });

    it('resets both height and inset on width change instead of treating it as keyboard', () => {
      // 旋转/分屏改变宽度 → 重置基线并归零，且同步 CSS 变量。
      expect(source).toMatch(
        /if \(vv\.width !== baselineWidth\) \{[\s\S]*?keyboardHeight = 0;\s*\n\s*keyboardInset = 0;\s*\n\s*writeInsetCssVar\(\);[\s\S]*?return;\s*\n\s*\}/
      );
    });
  });

  describe('CSS variable write protocol', () => {
    it('exports the pinned variable name --keyboard-inset', () => {
      expect(source).toContain(
        "export const KEYBOARD_INSET_CSS_VAR = '--keyboard-inset';"
      );
    });

    it('writes the value with a px unit onto document.documentElement', () => {
      expect(source).toContain(
        'document.documentElement.style.setProperty(KEYBOARD_INSET_CSS_VAR, `${keyboardInset}px`);'
      );
    });

    it('guards the write against non-DOM environments', () => {
      expect(source).toMatch(
        /function writeInsetCssVar\(\): void \{\s*\n\s*if \(typeof document === 'undefined'\) return;/
      );
    });

    it('writes an initial 0px on every platform before the mobile-only gate', () => {
      // 桌面端也要先写一次，保证 CSS 消费方的 var() 始终有定义。
      expect(source).toMatch(
        /trackingStarted = true;[\s\S]*?writeInsetCssVar\(\);[\s\S]*?if \(!vv \|\| \(!isAndroid\(\) && !isIOSLike\(\)\)\) return;/
      );
    });

    it('syncs the variable whenever the inset value changes', () => {
      expect(source).toMatch(
        /if \(nextInset !== keyboardInset\) \{\s*\n\s*keyboardInset = nextInset;\s*\n\s*writeInsetCssVar\(\);/
      );
    });
  });

  describe('transitions-dev.css consumes but never declares the variable', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/styles/transitions-dev.css'),
      'utf-8'
    );

    it('documents the runtime-write contract pointing back to the hook', () => {
      expect(css).toContain('src/hooks/useKeyboardHeight.ts');
    });

    it('contains no static --keyboard-inset declaration', () => {
      // 静态声明会遮蔽运行时写入的实时值；消费方必须 var(--keyboard-inset, 0px)。
      expect(css).not.toMatch(/--keyboard-inset\s*:/);
    });
  });
});
