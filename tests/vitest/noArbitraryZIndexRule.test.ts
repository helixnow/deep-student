import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../eslint-rules/no-arbitrary-z-index.js';

/**
 * ds-components/no-arbitrary-z-index 的行为契约。
 * 规则本体见 eslint-rules/no-arbitrary-z-index.js。
 */
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const zClass = (value: string) => ({ messageId: 'arbitraryZClass', data: { value } });
const zStyle = (value: string) => ({ messageId: 'numericStyleZIndex', data: { value } });

ruleTester.run('ds-components/no-arbitrary-z-index', rule as never, {
  valid: [
    '<div className="z-modal z-10 z-50" />',
    '<div className="z-[var(--z-modal)]" />',
    '<div className="xz-[10] fooz-[3]" />',
    '<div style={{ zIndex: Z_INDEX.modal }} />',
    '<div style={{ zIndex: open ? 10 : 0 }} />',
    '<div style={{ zIndex: base + 1 }} />',
    '<div style={style} />',
    // 非 JSX style 对象不在本规则范围
    'const s = { zIndex: 9999 };',
    '<div data-z={10} />',
  ],
  invalid: [
    { code: '<div className="fixed z-[9999]" />', errors: [zClass('z-[9999]')] },
    { code: '<div className="md:z-[100]" />', errors: [zClass('z-[100]')] },
    { code: '<div className="-z-[1]" />', errors: [zClass('-z-[1]')] },
    { code: '<div className="z-[-1]" />', errors: [zClass('z-[-1]')] },
    { code: "const overlay = cva('absolute z-[60]');", errors: [zClass('z-[60]')] },
    { code: '<div className={`a ${b} z-[30]`} />', errors: [zClass('z-[30]')] },
    { code: '<div style={{ zIndex: 3001 }} />', errors: [zStyle('3001')] },
    { code: '<div style={{ position: "fixed", zIndex: -1 }} />', errors: [zStyle('-1')] },
    { code: "<div style={{ 'zIndex': 5 }} />", errors: [zStyle('5')] },
  ],
});
