import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => {
  const absolutePath = resolve(process.cwd(), file);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

/**
 * className 只能经字符串字面量进 JSX。注释里会合法提到 after:-inset
 * （解释为什么不用它），全文 not.toMatch 会误伤注释。
 */
const extractStringLiterals = (source: string): string[] => {
  const literalPattern =
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;
  return (source.match(literalPattern) ?? []).map((literal) => literal.slice(1, -1));
};

describe('TouchTarget coarse touch-target contract', () => {
  const touchTargetSource = readSource('src/components/ui/TouchTarget.tsx');
  const coarseHitSource = readSource('src/components/ui/coarseHit.ts');
  const touchTargetClassLiterals = extractStringLiterals(touchTargetSource).join('\n');

  it('guarantees a >=44px real box under coarse pointers via min-h/min-w on the touch token', () => {
    expect(touchTargetSource).toContain(
      '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]'
    );
    expect(touchTargetSource).toContain(
      '[@media(pointer:coarse)]:min-w-[var(--touch-target-size)]'
    );
  });

  it('provides a flex centering box so children keep their own visual size (24/28/36 icons)', () => {
    expect(touchTargetSource).toContain('inline-flex');
    expect(touchTargetSource).toContain('items-center');
    expect(touchTargetSource).toContain('justify-center');
    expect(touchTargetSource).toContain('shrink-0');
  });

  it('supports asChild via Radix Slot and defaults to a span wrapper', () => {
    expect(touchTargetSource).toContain("import { Slot } from '@radix-ui/react-slot';");
    expect(touchTargetSource).toContain('asChild?: boolean');
    expect(touchTargetSource).toContain("asChild ? Slot : 'span'");
  });

  it('never uses pseudo-element inset expansion or hard-coded !min-h-11 escapes', () => {
    expect(touchTargetClassLiterals).not.toMatch(/(?:after|before):-inset/u);
    expect(touchTargetClassLiterals).not.toContain('!min-h-11');
    expect(touchTargetClassLiterals).not.toContain('!min-w-11');
    expect(touchTargetClassLiterals).not.toMatch(/min-[hw]-\[44px\]/u);
    expect(touchTargetSource).toContain('after:-inset');
  });

  it('keeps the pseudo-element escape hatch centralized in coarseHit.ts with coarse gating', () => {
    expect(coarseHitSource).toContain('coarseHitClassFor36');
    expect(coarseHitSource).toContain('coarseHitClassFor32');
    expect(coarseHitSource).toContain('coarseHitClassFor28');
    expect(coarseHitSource).toContain('coarseHitClassFor24');
    // 每一处 -inset 都必须挂在 pointer:coarse 门控后，禁止裸扩区
    const insetMatches = coarseHitSource.match(/after:-inset-[\d.]+/gu) ?? [];
    expect(insetMatches.length).toBeGreaterThanOrEqual(5);
    const gatedInsetMatches =
      coarseHitSource.match(/\[@media\(pointer:coarse\)\]:after:-inset-[\d.]+/gu) ?? [];
    expect(gatedInsetMatches.length).toBe(insetMatches.length);
  });

  it('keeps coarseHit class strings as static literals so Tailwind JIT can extract them', () => {
    // 模板串拼 -inset 档位会让 Tailwind 静态提取失效
    expect(coarseHitSource).not.toMatch(/after:\$\{/u);
    expect(coarseHitSource).not.toMatch(/`[^`]*after:-inset/u);
  });
});
