import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import rule from '../../eslint-rules/no-arbitrary-font-size.js';

/**
 * ds-components/no-arbitrary-font-size 的行为契约。
 * 规则本体见 eslint-rules/no-arbitrary-font-size.js。
 */
describe('ds-components/no-arbitrary-font-size', () => {
  const linter = new Linter();

  const lint = (code: string) =>
    linter.verify(code, {
      plugins: { 'ds-components': { rules: { 'no-arbitrary-font-size': rule as never } } },
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { 'ds-components/no-arbitrary-font-size': 'error' },
    });

  it.each([
    ["const a = 'text-[13px]';", 'px'],
    ["const a = 'flex items-center text-[10px] font-medium';", 'inside a class list'],
    ["const a = 'md:text-[0.8rem]';", 'responsive variant'],
    ['const a = `gap-2 ${x} text-[15px]`;', 'template literal'],
    ["const a = 'data-[state=open]:text-[11px]';", 'data variant'],
  ])('flags %s (%s)', code => {
    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('noArbitraryFontSize');
  });

  it.each([
    "const a = 'text-ui';",
    "const a = 'text-2xs text-caption';",
    "const a = 'text-[length:var(--font-size-ui)]';",
    "const a = 'h-[var(--touch-target-size)] px-[14px]';",
    "const a = 'leading-[13px]';",
    "const a = 'subtext-[13px]';",
  ])('allows %s', code => {
    expect(lint(code)).toEqual([]);
  });

  it('reports the offending class in the message', () => {
    const [message] = lint("const a = 'text-[13px]';");
    expect(message.message).toContain('text-[13px]');
    expect(message.message).toContain('--font-size-scale');
  });
});
