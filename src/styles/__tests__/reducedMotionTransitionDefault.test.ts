import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const UNIVERSAL = ['*', '*::before', '*::after'];
const REDUCE_QUERY = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/;

function parse(file: string) {
  return postcss.parse(readFileSync(resolve(process.cwd(), file), 'utf-8'), { from: file });
}

function selectorsOf(rule: Rule): string[] {
  return rule.selectors.map((selector) => selector.replace(/\s+/g, ' ').trim());
}

function enclosingAtRules(rule: Rule): AtRule[] {
  const chain: AtRule[] = [];
  for (let node = rule.parent; node && node.type !== 'root'; node = node.parent) {
    if (node.type === 'atrule') chain.push(node as AtRule);
  }
  return chain;
}

function isReduceOnly(rule: Rule): boolean {
  return enclosingAtRules(rule).some((at) => at.name === 'media' && REDUCE_QUERY.test(at.params));
}

function isLayered(rule: Rule): boolean {
  return enclosingAtRules(rule).some((at) => at.name === 'layer');
}

function universalReduceRules(file: string): Rule[] {
  const rules: Rule[] = [];
  parse(file).walkRules((rule) => {
    if (!isReduceOnly(rule)) return;
    if (UNIVERSAL.every((selector) => selectorsOf(rule).includes(selector))) rules.push(rule);
  });
  return rules;
}

function decl(rule: Rule, prop: string): Declaration | undefined {
  return rule.nodes.find((node): node is Declaration => node.type === 'decl' && node.prop === prop);
}

describe('reduced-motion transition default', () => {
  it('keeps the global reduce reset shortening transitions instead of removing them', () => {
    const [reset] = universalReduceRules('src/shared/styles/deep-student.css');
    expect(reset).toBeDefined();
    const duration = decl(reset, 'transition-duration');
    expect(duration?.value).toBe('0.01ms');
    expect(duration?.important).toBe(true);
  });

  it('defaults elements without an authored transition to transition-property: none under reduce', () => {
    const defaults = universalReduceRules('src/styles/ui-motion.css').filter((rule) => decl(rule, 'transition-property'));
    expect(defaults).toHaveLength(1);
    const [rule] = defaults;
    const property = decl(rule, 'transition-property');
    expect(property?.value).toBe('none');
    // 必须低于一切未分层的作者样式：一旦脱离级联层或加 !important，就会吞掉组件自己声明的过渡
    //（及其 transitionend）；去掉这条则 reduce 下每个元素都变成 `all 0.01ms`，样式重算成倍变慢。
    expect(property?.important ?? false).toBe(false);
    expect(isLayered(rule)).toBe(true);
  });

  it('does not reintroduce an unlayered universal transition-property under reduce', () => {
    const files = [
      'src/shared/styles/deep-student.css',
      'src/shared/styles/app.css',
      'src/styles/ui-motion.css',
      'src/styles/transitions-dev.css',
      'src/styles/native-feel/interaction.css',
      'src/styles/native-feel/scrollbars.css',
    ];
    const offenders = files.flatMap((file) => universalReduceRules(file)
      .filter((rule) => !isLayered(rule) && (decl(rule, 'transition-property') || decl(rule, 'transition')))
      .map((rule) => `${file}:${rule.source?.start?.line}`));
    expect(offenders).toEqual([]);
  });
});
