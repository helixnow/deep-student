/**
 * Wave2-B r7 — 桌面窄窗不再换壳：workbenchActive 源码契约
 *
 * 0824 评审建议 2 的裁决：窄窗（<768px）是布局问题而非生命周期问题，
 * 此前的 shellStableSmallScreen（250ms 宽度稳定迟滞）到期后会绕过逐窗
 * canClose / windowCloseGuard 整壳硬切、静默丢失未保存草稿。本契约钉死
 * App.tsx 中 workbenchActive 的护栏表达式只含 workbenchMode 与移动平台
 * 拦截，不得回潮任何窄窗换壳条件。历史注释可以提及该标识符（留档），
 * 但不得再有声明、状态或逻辑引用。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workbenchActive small-screen shell-swap contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

  it('workbenchActive 护栏表达式恒为 workbenchMode && !isMobilePlatform()', () => {
    const declarations = appSource.match(/const workbenchActive =[^;]*;/g) ?? [];
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toBe(
      'const workbenchActive = workbenchMode && !isMobilePlatform();',
    );
  });

  it('workbenchActive 声明不含 shellStableSmallScreen / isSmallScreen 窄窗条件', () => {
    const declaration = appSource.match(/const workbenchActive =[^;]*;/)?.[0] ?? '';
    expect(declaration).not.toContain('shellStableSmallScreen');
    expect(declaration).not.toContain('isSmallScreen');
  });

  it('shellStableSmallScreen 不再以声明 / 状态 / 逻辑形式存在于 App.tsx', () => {
    // 声明与 setter / hook 命名一律禁止
    expect(appSource).not.toMatch(/(?:const|let|var)\s+\[?\s*shellStableSmallScreen\b/);
    expect(appSource).not.toMatch(/\buseShellStableSmallScreen\b/);
    expect(appSource).not.toMatch(/\bsetShellStableSmallScreen\b/);
    // 逻辑引用（条件运算 / JSX 门控）禁止；注释里的历史留档不受影响
    expect(appSource).not.toMatch(/\bshellStableSmallScreen\s*(?:&&|\|\||\?|===|!==)/);
    expect(appSource).not.toMatch(/(?:&&|\|\||!)\s*shellStableSmallScreen\b/);
  });
});
