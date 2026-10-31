import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../eslint-rules/no-hardcoded-color.js';

/**
 * ds-components/no-hardcoded-color 的行为契约。
 * 规则本体见 eslint-rules/no-hardcoded-color.js。
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

const hard = (value: string) => ({ messageId: 'hardcodedColor', data: { value } });
const cls = (value: string) => ({ messageId: 'arbitraryColorClass', data: { value } });

ruleTester.run('ds-components/no-hardcoded-color', rule as never, {
  valid: [
    '<div className="bg-muted text-foreground border-border" />',
    "<div style={{ color: 'hsl(var(--foreground))' }} />",
    "<div style={{ background: 'hsl( var(--muted) / 0.5)' }} />",
    "<div style={{ boxShadow: 'rgb(var(--shadow) / 0.2) 0 1px 2px' }} />",
    '<div className="bg-[hsl(var(--primary))] text-[color:var(--x)]" />',
    // 非 className/style 属性：SVG 绘制、锚点、实体
    '<path fill="#fff" stroke="rgba(0,0,0,.5)" />',
    '<a href="#abc" className="underline" />',
    '<div className="p-2">&#123;</div>',
    "<div style={{ mask: 'url(#fade)' }} />",
    // 非 JSX 上下文的颜色常量（图表配色表等）不在本规则范围
    "const PALETTE = ['#ff0000', 'rgba(0,0,0,0.5)'];",
    "const c = { color: '#333' };",
    // 锚点 / id 样式字符串
    '<div className="#section-title" />',
    '<div className="decoration-[2px] border-[1px] bg-[url(/a.png)]" />',
    // 插值本身不是字面量
    '<div className={`bg-${tone}`} />',
  ],
  invalid: [
    { code: '<div className="bg-[#1e1e1e] p-2" />', errors: [cls('bg-[#1e1e1e]')] },
    { code: '<div className="hover:text-[#333]" />', errors: [cls('text-[#333]')] },
    { code: '<div className="border-t-[rgba(0,0,0,.1)]" />', errors: [cls('border-t-[rgba(0,0,0,.1)]')] },
    { code: '<div className={cn("a", ok && "ring-[#fff]")} />', errors: [cls('ring-[#fff]')] },
    // 任意值颜色类在任意字符串里都拦（cva 配方、常量表）
    { code: "const variants = { dark: 'bg-[#000] text-white' };", errors: [cls('bg-[#000]')] },
    { code: "<div style={{ color: '#333' }} />", errors: [hard('#333')] },
    { code: "<div style={{ background: 'rgba(0, 0, 0, 0.5)' }} />", errors: [hard('rgba(0, 0, 0, 0.5)')] },
    { code: "<div style={{ color: active ? '#ff0000aa' : undefined }} />", errors: [hard('#ff0000aa')] },
    { code: "<div style={{ ['--accent']: 'hsl(210 40% 50%)' }} />", errors: [hard('hsl(210 40% 50%)')] },
    { code: '<div className="shadow-[0_0_0_1px_#fff]" />', errors: [hard('#fff')] },
    { code: '<div style={{ border: `1px solid #abcdef` }} />', errors: [hard('#abcdef')] },
    {
      code: "<div className={clsx('x', { 'bg-[#fafafa]': on })} style={{ color: '#fff', fill: 'rgb(1,2,3)' }} />",
      errors: [cls('bg-[#fafafa]'), hard('#fff'), hard('rgb(1,2,3)')],
    },
  ],
});
